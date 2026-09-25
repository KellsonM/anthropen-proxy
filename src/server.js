// Fastify server exposing the Anthropic Messages API on the front and
// calling an OpenAI-compatible backend on the back.

import Fastify from 'fastify'
import {
  anthropicToOpenAI,
  openaiToAnthropic,
  estimateTokens,
  badRequest,
} from './mappers.js'
import { AnthropicStreamTranslator } from './stream.js'

// Anthropic-shaped error body.
export function anthropicError(status, type, message) {
  return { type: 'error', error: { type, message } }
}

export function buildServer(config) {
  const app = Fastify({
    logger: config.debug
      ? { level: 'info' }
      : false,
    bodyLimit: 64 * 1024 * 1024, // base64 images can be large
  })

  // Upstream inactivity timeout: the timer is reset whenever bytes arrive,
  // so a hung backend (no response, or stalled mid-stream) aborts after
  // `timeout` of silence while long healthy generations run freely.
  const timeoutMs = config.timeout ?? 600_000

  // Debug logging follows config.debug (CLI --debug or DEBUG=1), not the
  // ambient process.env, so `--debug` alone actually logs.
  const dbg = (log, ...args) => {
    if (!config.debug) return
    if (log?.info) log.info(...args)
    else console.log(...args)
  }

  const timeoutMessage = () =>
    `Backend did not respond within ${Math.round(timeoutMs / 1000)}s of inactivity`

  app.get('/health', async () => ({ status: 'ok' }))

  app.post('/v1/messages', async (request, reply) => {
    const payload = request.body
    let openaiPayload
    try {
      openaiPayload = anthropicToOpenAI(payload, {
        models: config.models,
        filterToolNames: config.filterTools,
        includeStreamUsage: config.streamUsage,
        bypassAppDetailMessage: config.bypassAppDetailMessage,
        includeTopK: config.topK ?? true,
      })
    } catch (err) {
      const status = err.status ?? 400
      return reply.code(status).send(
        anthropicError(status, err.errorType ?? 'invalid_request_error', err.message),
      )
    }

    dbg(request.log, 'OpenAI payload:', openaiPayload)

    const headers = { 'Content-Type': 'application/json' }
    if (config.apiKey) headers['Authorization'] = `Bearer ${config.apiKey}`

    const controller = new AbortController()
    let timer = setTimeout(() => controller.abort(), timeoutMs)
    const resetTimer = () => {
      clearTimeout(timer)
      timer = setTimeout(() => controller.abort(), timeoutMs)
    }
    const clearTimer = () => clearTimeout(timer)

    let upstream
    try {
      upstream = await fetch(`${config.baseUrl}/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(openaiPayload),
        signal: controller.signal,
      })
    } catch (err) {
      clearTimer()
      if (err.name === 'AbortError') {
        return reply.code(504).send(anthropicError(504, 'api_error', timeoutMessage()))
      }
      return reply
        .code(502)
        .send(anthropicError(502, 'api_error', `Cannot reach backend at ${config.baseUrl}: ${err.message}`))
    }

    if (!upstream.ok) {
      clearTimer()
      let detail
      try {
        const body = await upstream.json()
        detail = body?.error?.message ?? JSON.stringify(body)
      } catch {
        try {
          detail = await upstream.text()
        } catch {
          detail = `upstream ${upstream.status} with unreadable body`
        }
      }
      const status = upstream.status >= 400 ? upstream.status : 502
      const type = status === 401 || status === 403 ? 'authentication_error'
        : status === 404 ? 'not_found_error'
        : status === 429 ? 'rate_limit_error'
        : 'api_error'
      return reply.code(status).send(anthropicError(status, type, detail))
    }

    // ----- non-streaming -----
    if (!openaiPayload.stream) {
      let data
      try {
        data = await upstream.json()
        clearTimer()
      } catch (err) {
        clearTimer()
        if (err.name === 'AbortError') {
          return reply.code(504).send(anthropicError(504, 'api_error', timeoutMessage()))
        }
        return reply
          .code(502)
          .send(anthropicError(502, 'api_error', `Invalid JSON from backend: ${err.message}`))
      }
      if (data.error) {
        return reply
          .code(500)
          .send(anthropicError(500, 'api_error', data.error.message ?? 'Upstream error'))
      }
      let anthropicResponse
      try {
        anthropicResponse = openaiToAnthropic(
          data,
          openaiPayload.model,
          // Serialize the request only when the backend actually omitted
          // usage; the fallback estimate is the sole consumer.
          data.usage ? '' : JSON.stringify(openaiPayload.messages),
          { warn: (msg) => dbg(request.log, msg) },
        )
      } catch (err) {
        const status = err.status ?? 502
        return reply
          .code(status)
          .send(anthropicError(status, err.errorType ?? 'api_error', err.message))
      }
      dbg(request.log, 'Anthropic response:', anthropicResponse)
      return anthropicResponse
    }

    // ----- streaming -----
    // Take over the raw socket: we write Anthropic SSE frames ourselves.
    reply.hijack()
    const raw = reply.raw
    // Writes after a client disconnect surface as 'error' events on the
    // socket; swallow them so a dead client can never crash the proxy.
    raw.on('error', () => {})
    raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    })

    const translator = new AnthropicStreamTranslator({
      model: openaiPayload.model,
      write: (event, data) => {
        // Backpressure from a slow client is intentionally ignored: for a
        // local proxy the frames buffer in memory until drained.
        raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        if (typeof raw.flush === 'function') raw.flush()
      },
    })
    translator.start()

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let clientGone = false
    const onClientClose = () => {
      clientGone = true
      // Stop paying for generation the nobody is listening for.
      controller.abort()
    }
    request.raw.on('close', onClientClose)

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        resetTimer()
        translator.push(decoder.decode(value, { stream: true }))
        if (translator.ended) {
          // Release the upstream connection promptly instead of leaving
          // the rest of the body unconsumed.
          reader.cancel().catch(() => {})
          break
        }
      }
      // Flush any trailing partial multibyte sequence before finalizing.
      translator.push(decoder.decode())
      translator.finish()
    } catch (err) {
      if (!clientGone) {
        const message =
          err.name === 'AbortError' ? timeoutMessage() : `Stream error: ${err.message}`
        translator.fail(message)
      }
    } finally {
      clearTimer()
      request.raw.removeListener('close', onClientClose)
      raw.end()
    }
  })

  // Token counting: clients only need a rough number for budgeting.
  app.post('/v1/messages/count_tokens', async (request) => {
    const payload = request.body ?? {}
    const text = JSON.stringify({
      system: payload.system ?? '',
      messages: payload.messages ?? [],
      tools: payload.tools ?? [],
    })
    return { input_tokens: estimateTokens(text) }
  })

  return app
}

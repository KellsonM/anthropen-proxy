// Fastify server exposing the Anthropic Messages API on the front and
// calling an OpenAI-compatible backend on the back.

import Fastify from 'fastify'
import { timingSafeEqual } from 'node:crypto'
import { anthropicToOpenAI, openaiToAnthropic, estimateRequestTokens } from './mappers.js'
import { AnthropicStreamTranslator } from './stream.js'

// Anthropic-shaped error body.
export function anthropicError(status, type, message) {
  return { type: 'error', error: { type, message } }
}

// Map an HTTP status to the closest Anthropic error type.
function errorTypeForStatus(status) {
  if (status === 401 || status === 403) return 'authentication_error'
  if (status === 404) return 'not_found_error'
  if (status === 413) return 'request_too_large'
  if (status === 429) return 'rate_limit_error'
  if (status >= 500) return 'api_error'
  return 'invalid_request_error'
}

// Constant-time string comparison so a wrong inbound key cannot be
// brute-forced byte by byte through timing differences.
function safeEqual(a, b) {
  const ba = Buffer.from(String(a))
  const bb = Buffer.from(String(b))
  if (ba.length !== bb.length) return false
  return timingSafeEqual(ba, bb)
}

export function buildServer(config) {
  const app = Fastify({
    logger: config.debug
      ? { level: 'info' }
      : false,
    bodyLimit: 64 * 1024 * 1024, // base64 images can be large
  })

  // Every error the proxy emits — ours or Fastify's own (malformed JSON
  // body, 413, 404, ...) — must be Anthropic-shaped, or strict clients
  // (Claude Code) mis-handle it: a raw `FST_ERR_*` body can crash their
  // parser or trigger blind retries.
  app.setErrorHandler((err, request, reply) => {
    const status =
      Number.isInteger(err.statusCode) && err.statusCode >= 400 && err.statusCode <= 599
        ? err.statusCode
        : 500
    const type = err.errorType ?? errorTypeForStatus(status)
    reply.code(status).send(anthropicError(status, type, err.message || 'Internal error'))
  })

  app.setNotFoundHandler((request, reply) => {
    reply
      .code(404)
      .send(anthropicError(404, 'not_found_error', `Not found: ${request.method} ${request.url}`))
  })

  // Optional inbound authentication: when `inboundKey` is configured,
  // every request must present it via `x-api-key` or
  // `Authorization: Bearer <key>`. Health and the Claude Code preflight
  // probe stay open.
  if (config.inboundKey) {
    app.addHook('preHandler', async (request, reply) => {
      const path = request.url.split('?')[0]
      if (path === '/health' || path === '/api/hello') return
      const auth = request.headers.authorization
      const presented =
        request.headers['x-api-key'] ??
        (typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : null)
      if (!presented || !safeEqual(presented, config.inboundKey)) {
        return reply
          .code(401)
          .send(anthropicError(401, 'authentication_error', 'Invalid API key'))
      }
    })
  }

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

  // Claude Code CLI probes the base URL with `HEAD /api/hello` before its
  // first real request; the real api.anthropic.com answers 200. A 404 here
  // makes the CLI treat the proxy as unreachable/unauthenticated.
  // Fastify auto-exposes HEAD for GET routes (exposeHeadRoutes defaults to
  // true since v4), so registering GET covers both.
  app.get('/api/hello', async () => ({ message: 'Hello, World!' }))

  // Claude Code probes `GET /v1/models?limit=1000` for model discovery;
  // the real Anthropic API answers 200 with the model list. Return a single
  // entry in Anthropic's list format.
  app.get('/v1/models', async () => {
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    const data = [{
      type: 'model',
      id: 'anthropic-proxy',
      display_name: config.models.completion,
      created_at: midnight.toISOString(),
    }]
    return {
      data,
      has_more: false,
      first_id: 'anthropic-proxy',
      last_id: 'anthropic-proxy',
    }
  })

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
        warn: (msg) => dbg(request.log, msg),
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

    // A 204 (or any body-less success) has `body === null`; calling
    // getReader() on it throws after the streaming path has already
    // hijacked the reply, leaving the client hanging on an empty SSE
    // stream forever. Reject before hijacking instead.
    if (!upstream.body) {
      clearTimer()
      return reply
        .code(502)
        .send(
          anthropicError(
            502,
            'api_error',
            `Backend returned HTTP ${upstream.status} with no response body`,
          ),
        )
    }

    // ----- non-streaming -----
    if (!openaiPayload.stream) {
      let data
      try {
        // Read the body in chunks so the inactivity timer resets on every
        // arriving byte: a slow-but-active download survives, only a
        // stalled one aborts (same semantics as the streaming path).
        const reader = upstream.body.getReader()
        const decoder = new TextDecoder('utf-8')
        let text = ''
        while (true) {
          const { value, done } = await reader.read()
          if (done) break
          resetTimer()
          text += decoder.decode(value, { stream: true })
        }
        text += decoder.decode()
        clearTimer()
        data = JSON.parse(text)
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
        // Some OpenAI-compat backends signal errors inside a 200 body.
        // Preserve any HTTP status they carry (numeric `status`, or a
        // numeric `code`) so 4xx semantics survive; otherwise 500.
        const rawStatus = Number.isInteger(data.error.status)
          ? data.error.status
          : Number.isInteger(data.error.code) && data.error.code >= 400 && data.error.code <= 599
            ? data.error.code
            : 500
        const status = Math.min(599, Math.max(400, rawStatus))
        return reply
          .code(status)
          .send(
            anthropicError(
              status,
              data.error.type ?? errorTypeForStatus(status),
              data.error.message ?? 'Upstream error',
            ),
          )
      }
      let anthropicResponse
      try {
        anthropicResponse = openaiToAnthropic(data, openaiPayload.model, {
          // Estimate the request only when the backend actually omitted
          // usage; the fallback estimate is the sole consumer.
          inputTokens: data.usage ? 0 : estimateRequestTokens(payload),
          stopSequences: openaiPayload.stop ?? [],
          warn: (msg) => dbg(request.log, msg),
        })
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

    let clientGone = false
    // Resolved when the socket drains (or dies) after a write returned
    // false; the read loop awaits it so a slow client throttles upstream
    // reads instead of letting frames buffer in memory without bound.
    let drainWait = null
    const waitForDrain = () => {
      if (drainWait) return drainWait
      drainWait = new Promise((resolve) => {
        const done = () => {
          drainWait = null
          resolve()
        }
        raw.once('drain', done)
        raw.once('close', done)
      })
      return drainWait
    }

    const translator = new AnthropicStreamTranslator({
      model: openaiPayload.model,
      inputTokens: estimateRequestTokens(payload),
      stopSequences: openaiPayload.stop ?? [],
      write: (event, data) => {
        if (clientGone) return
        // Node's ServerResponse writes to the socket immediately after
        // writeHead; there is no flush() on http.ServerResponse (only
        // flushHeaders()), so no explicit flush is needed here.
        const ok = raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        if (!ok) waitForDrain()
      },
    })
    translator.start()

    const reader = upstream.body.getReader()
    const decoder = new TextDecoder('utf-8')
    // Listen on the *response* stream, not the request stream:
    // IncomingMessage 'close' fires as soon as the request body has been
    // consumed (before this handler registers), so it can never observe a
    // mid-stream disconnect. ServerResponse 'close' fires when the socket
    // actually terminates, including a client hanging up mid-response.
    const onClientClose = () => {
      clientGone = true
      // Stop paying for generation nobody is listening for.
      controller.abort()
    }
    reply.raw.on('close', onClientClose)

    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        resetTimer()
        translator.push(decoder.decode(value, { stream: true }))
        if (drainWait) await drainWait
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
      reply.raw.removeListener('close', onClientClose)
      raw.end()
    }
  })

  // Token counting: clients only need a rough number for budgeting.
  // Base64 payloads are stripped and images charged a fixed per-image
  // cost, so a screenshot does not inflate the estimate by orders of
  // magnitude and trigger premature auto-compaction.
  app.post('/v1/messages/count_tokens', async (request) => {
    const payload = request.body ?? {}
    return { input_tokens: estimateRequestTokens(payload) }
  })

  return app
}

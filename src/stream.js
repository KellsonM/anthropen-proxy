// Streaming translation: OpenAI chat-completions SSE stream ->
// Anthropic Messages SSE event stream.
//
// Anthropic's streaming protocol is a sequence of typed events:
//   message_start -> [content_block_start, content_block_delta*, content_block_stop]* -> message_delta -> message_stop
// Each content block has a sequential index starting at 0. A block holds
// exactly one kind of content (text / thinking / tool_use), so whenever
// the OpenAI stream switches between content kinds we must close the
// current block and open a new one.

import { mapStopReason, randomId, estimateTokens } from './mappers.js'

// ---------------------------------------------------------------------------
// Incremental SSE parser (handles chunks split at arbitrary byte offsets)
// ---------------------------------------------------------------------------

export class SSEParser {
  constructor() {
    this.buffer = ''
  }

  // Feed a raw text chunk; returns an array of {event, data} records for
  // every complete SSE event found so far.
  feed(text) {
    const events = []
    this.buffer += text
    let newlineIdx
    while ((newlineIdx = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, newlineIdx).replace(/\r$/, '')
      this.buffer = this.buffer.slice(newlineIdx + 1)

      if (line === '') {
        // Blank line terminates the current event.
        if (this._dataLines && this._dataLines.length > 0) {
          events.push({
            event: this._eventName || 'message',
            data: this._dataLines.join('\n'),
          })
        }
        this._eventName = null
        this._dataLines = null
        continue
      }
      if (line.startsWith(':')) continue // SSE comment / keep-alive (e.g. OpenRouter)
      const colon = line.indexOf(':')
      const field = colon === -1 ? line : line.slice(0, colon)
      let value = colon === -1 ? '' : line.slice(colon + 1)
      if (value.startsWith(' ')) value = value.slice(1)
      if (field === 'event') {
        this._eventName = value
      } else if (field === 'data') {
        if (!this._dataLines) this._dataLines = []
        this._dataLines.push(value)
      }
      // `id:` / `retry:` fields are irrelevant here.
    }
    return events
  }
}

// ---------------------------------------------------------------------------
// Anthropic stream translator
// ---------------------------------------------------------------------------

export class AnthropicStreamTranslator {
  // write(event, dataObject) is called once per Anthropic SSE event.
  // model is the upstream model name reported back to the client.
  constructor({ write, model, messageId = `msg_${randomId()}` }) {
    this.write = write
    this.model = model
    this.messageId = messageId
    this.parser = new SSEParser()

    this.nextIndex = 0 // next fresh content-block index
    this.current = null // { type, index } of the currently open block
    this.toolBlocks = new Map() // OpenAI tool-call index -> Anthropic block index
    this.finishReason = null
    this.usage = null
    this.sawToolCall = false
    this.accumulatedText = ''
    this.started = false
    this.ended = false
  }

  // Emit message_start + ping. Call once the upstream stream is confirmed OK.
  start() {
    if (this.started) return
    this.started = true
    this.write('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        model: this.model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    })
    this.write('ping', { type: 'ping' })
  }

  // Feed a raw upstream chunk (may contain any number of SSE events,
  // possibly split mid-line).
  push(rawText) {
    if (this.ended) return
    for (const evt of this.parser.feed(rawText)) {
      if (evt.data === '[DONE]') {
        this.finish()
        return
      }
      let parsed
      try {
        parsed = JSON.parse(evt.data)
      } catch {
        continue // tolerate malformed lines rather than killing the stream
      }
      if (parsed.error) {
        this.fail(parsed.error.message ?? 'Upstream error', parsed.error.type)
        return
      }
      this.handleChunk(parsed)
    }
  }

  handleChunk(obj) {
    if (obj.usage) this.usage = obj.usage

    const choice = obj.choices && obj.choices[0]
    if (!choice) return // usage-only chunk
    if (choice.finish_reason) this.finishReason = choice.finish_reason

    const delta = choice.delta ?? {}

    // Reasoning tokens: OpenRouter uses `reasoning`, vLLM/Ollama use
    // `reasoning_content`. Surface them as Anthropic thinking blocks.
    const reasoning = delta.reasoning ?? delta.reasoning_content
    if (typeof reasoning === 'string' && reasoning.length > 0) {
      this._ensureBlock('thinking')
      this.write('content_block_delta', {
        type: 'content_block_delta',
        index: this.current.index,
        delta: { type: 'thinking_delta', thinking: reasoning },
      })
    }

    if (typeof delta.content === 'string' && delta.content.length > 0) {
      this._ensureBlock('text')
      this.accumulatedText += delta.content
      this.write('content_block_delta', {
        type: 'content_block_delta',
        index: this.current.index,
        delta: { type: 'text_delta', text: delta.content },
      })
    }

    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        this._handleToolCallDelta(tc)
      }
    }
  }

  _handleToolCallDelta(tc) {
    this.sawToolCall = true
    const oi = tc.index ?? 0
    const args = tc.function?.arguments ?? ''

    if (this.toolBlocks.has(oi)) {
      const blockIndex = this.toolBlocks.get(oi)
      // If another block is currently open (interleaved content), close it
      // and point back at this tool's existing block without re-emitting a
      // start event.
      if (!this.current || this.current.index !== blockIndex) {
        this._closeBlock()
        this.current = { type: 'tool_use', index: blockIndex }
      }
    } else {
      this._openBlock('tool_use', {
        type: 'tool_use',
        id: tc.id ?? `toolu_${randomId()}`,
        name: tc.function?.name ?? '',
        input: {},
      })
      this.toolBlocks.set(oi, this.current.index)
    }

    if (args.length > 0) {
      this.write('content_block_delta', {
        type: 'content_block_delta',
        index: this.current.index,
        delta: { type: 'input_json_delta', partial_json: args },
      })
    }
  }

  _ensureBlock(type) {
    if (this.current && this.current.type === type) return
    if (type === 'text') {
      this._openBlock('text', { type: 'text', text: '' })
    } else if (type === 'thinking') {
      this._openBlock('thinking', { type: 'thinking', thinking: '' })
    }
  }

  _openBlock(type, contentBlock) {
    this._closeBlock()
    const index = this.nextIndex++
    this.current = { type, index }
    this.write('content_block_start', {
      type: 'content_block_start',
      index,
      content_block: contentBlock,
    })
  }

  _closeBlock() {
    if (!this.current) return
    // Thinking blocks carry a signature in the real API; local models have
    // none, so emit an empty one before closing for protocol completeness.
    if (this.current.type === 'thinking') {
      this.write('content_block_delta', {
        type: 'content_block_delta',
        index: this.current.index,
        delta: { type: 'signature_delta', signature: '' },
      })
    }
    this.write('content_block_stop', {
      type: 'content_block_stop',
      index: this.current.index,
    })
    this.current = null
  }

  // Finalize the stream: close any open block, emit message_delta +
  // message_stop.
  finish() {
    if (this.ended) return
    this.start() // guarantee message_start even if no chunks arrived
    this._closeBlock()
    if (this.nextIndex === 0) {
      // Empty response: still emit one empty text block so the client
      // sees a well-formed message.
      this._openBlock('text', { type: 'text', text: '' })
      this._closeBlock()
    }
    this.write('message_delta', {
      type: 'message_delta',
      delta: {
        stop_reason: mapStopReason(this.finishReason, this.sawToolCall),
        stop_sequence: null,
      },
      usage: this.usage
        ? {
            input_tokens: this.usage.prompt_tokens ?? 0,
            output_tokens: this.usage.completion_tokens ?? 0,
          }
        : { output_tokens: estimateTokens(this.accumulatedText) },
    })
    this.write('message_stop', { type: 'message_stop' })
    this.ended = true
  }

  // Mid-stream failure: emit an Anthropic `error` event and end.
  fail(message, type = 'api_error') {
    if (this.ended) return
    this._closeBlock()
    this.write('error', {
      type: 'error',
      error: { type, message: String(message) },
    })
    this.ended = true
  }
}

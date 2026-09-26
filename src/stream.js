// Streaming translation: OpenAI chat-completions SSE stream ->
// Anthropic Messages SSE event stream.
//
// Anthropic's streaming protocol is a sequence of typed events:
//   message_start -> [content_block_start, content_block_delta*, content_block_stop]* -> message_delta -> message_stop
// Each content block has a sequential index starting at 0. A block holds
// exactly one kind of content (text / thinking / tool_use), so whenever
// the OpenAI stream switches between content kinds we must close the
// current block and open a new one.
//
// Tool-call arguments are BUFFERED until the stream finishes instead of
// being streamed live. A content block is immutable once stopped: if a
// tool-call delta resumed after interleaved text, continuing it would
// mean emitting deltas (and a second stop) for an already-stopped index,
// which strict clients reject or turn into corrupted tool arguments.
// Buffering removes the whole interleaving problem; text/thinking still
// stream in real time.

import { mapStopReason, randomId, textTokenCounts } from './mappers.js'

// ---------------------------------------------------------------------------
// Incremental SSE parser (handles chunks split at arbitrary byte offsets)
// ---------------------------------------------------------------------------

export class SSEParser {
  constructor() {
    this.buffer = ''
    this._eventName = null
    this._dataLines = null
  }

  // Feed a raw text chunk; returns an array of {event, data} records for
  // every complete SSE event found so far.
  // Scans with an index pointer and only re-slices the leftover tail once,
  // so a batch of k lines in an n-byte buffer costs O(n) instead of O(k·n).
  // Line terminators follow the SSE spec: \n, \r\n, or a bare \r.
  feed(text) {
    const events = []
    this.buffer += text
    let start = 0
    while (true) {
      const lf = this.buffer.indexOf('\n', start)
      const cr = this.buffer.indexOf('\r', start)
      let end
      let termLen
      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A trailing lone \r must wait for the next chunk: it may be the
        // first half of a \r\n pair, and treating it as a terminator now
        // would split the following line incorrectly.
        if (cr === this.buffer.length - 1) break
        end = cr
        termLen = this.buffer[cr + 1] === '\n' ? 2 : 1
      } else if (lf !== -1) {
        end = lf
        termLen = 1
      } else {
        break
      }
      const line = this.buffer.slice(start, end)
      start = end + termLen

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
    if (start > 0) this.buffer = this.buffer.slice(start)
    return events
  }

  // End-of-stream: a trailing lone \r (held by feed() because it could
  // have been the start of a \r\n pair) is now known to be a terminator.
  // Process it and emit any pending event. Call once when the upstream
  // stream ends so a bare-CR backend's final event is not lost.
  flush() {
    if (this.buffer === '\r') {
      this.buffer = ''
      if (this._dataLines && this._dataLines.length > 0) {
        const ev = { event: this._eventName || 'message', data: this._dataLines.join('\n') }
        this._eventName = null
        this._dataLines = null
        return [ev]
      }
    }
    return []
  }
}

// ---------------------------------------------------------------------------
// Anthropic stream translator
// ---------------------------------------------------------------------------

export class AnthropicStreamTranslator {
  // write(event, dataObject) is called once per Anthropic SSE event.
  // model is the upstream model name reported back to the client.
  // inputTokens is a request-side estimate reported in message_start and
  // used as the usage fallback (the real API reports input tokens up front;
  // we only know the real number if the backend sends a usage chunk).
  // stopSequences are the client's requested stop sequences, used to
  // backfill `stop_sequence` in message_delta when one is matched.
  constructor({
    write,
    model,
    messageId = `msg_${randomId()}`,
    inputTokens = 0,
    stopSequences = [],
  }) {
    this.write = write
    this.model = model
    this.messageId = messageId
    this.inputTokens = inputTokens
    this.parser = new SSEParser()

    this.nextIndex = 0 // next fresh content-block index
    this.current = null // { type, index } of the currently open block
    this.pendingTools = new Map() // OpenAI tool-call index -> { id, name, args }
    this.finishReason = null
    this.usage = null
    this.sawToolCall = false
    // Incremental output-text statistics instead of storing the full
    // response text: the fallback token estimate only needs counts, and
    // the stop-sequence check only needs the tail of the text.
    this.outCJK = 0
    this.outTotal = 0
    this.stopSequences = (Array.isArray(stopSequences) ? stopSequences : []).filter(
      (s) => typeof s === 'string' && s.length > 0,
    )
    this.maxStopLen = this.stopSequences.reduce((n, s) => Math.max(n, s.length), 0)
    this.textTail = ''
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
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
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
      this._trackText(delta.content)
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

  // Buffer tool-call argument fragments; the block is emitted whole in
  // finish(). Streaming args live is not protocol-safe once interleaving
  // with other content kinds is possible (see header comment).
  _handleToolCallDelta(tc) {
    this.sawToolCall = true
    const oi = tc.index ?? 0
    const entry = this.pendingTools.get(oi) ?? { id: null, name: '', args: '' }
    if (tc.id) entry.id = tc.id
    if (tc.function?.name) entry.name = tc.function.name
    entry.args += tc.function?.arguments ?? ''
    this.pendingTools.set(oi, entry)
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

  // Track output-text statistics incrementally so we never store the full
  // response: counts feed the fallback token estimate, and only the tail
  // is needed for the stop-sequence check.
  _trackText(s) {
    const { cjk, total } = textTokenCounts(s)
    this.outCJK += cjk
    this.outTotal += total
    if (this.maxStopLen > 0) {
      this.textTail = (this.textTail + s).slice(-this.maxStopLen)
    }
  }

  _matchedStopSequence() {
    if (this.finishReason !== 'stop' || this.stopSequences.length === 0) return null
    for (const seq of this.stopSequences) {
      if (this.textTail.endsWith(seq)) return seq
    }
    return null
  }

  _estimateOutputTokens() {
    if (this.outTotal === 0) return 0
    return Math.max(1, this.outCJK + Math.ceil((this.outTotal - this.outCJK) / 4))
  }

  // Finalize the stream: close any open block, flush buffered tool calls,
  // emit message_delta + message_stop.
  finish() {
    if (this.ended) return
    this.start() // guarantee message_start even if no chunks arrived
    // Drain any event the parser held on a trailing lone \r at end of
    // stream (bare-CR backends). [DONE] and errors are ignored here —
    // we are finalizing regardless.
    for (const evt of this.parser.flush()) {
      if (evt.data === '[DONE]') continue
      let parsed
      try {
        parsed = JSON.parse(evt.data)
      } catch {
        continue
      }
      if (parsed.error) continue
      this.handleChunk(parsed)
    }
    this._closeBlock()
    for (const entry of this.pendingTools.values()) {
      this._openBlock('tool_use', {
        type: 'tool_use',
        id: entry.id ?? `toolu_${randomId()}`,
        name: entry.name,
        input: {},
      })
      if (entry.args.length > 0) {
        this.write('content_block_delta', {
          type: 'content_block_delta',
          index: this.current.index,
          delta: { type: 'input_json_delta', partial_json: entry.args },
        })
      }
      this._closeBlock()
    }
    this.pendingTools.clear()
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
        stop_sequence: this._matchedStopSequence(),
      },
      usage: this.usage
        ? {
            input_tokens: this.usage.prompt_tokens ?? 0,
            output_tokens: this.usage.completion_tokens ?? 0,
          }
        : {
            input_tokens: this.inputTokens,
            output_tokens: this._estimateOutputTokens(),
          },
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

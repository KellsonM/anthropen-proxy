import { test } from 'node:test'
import assert from 'node:assert/strict'
import { SSEParser, AnthropicStreamTranslator } from '../src/stream.js'

// ---------------------------------------------------------------------------
// SSEParser
// ---------------------------------------------------------------------------

test('SSEParser: parses complete events', () => {
  const p = new SSEParser()
  const events = p.feed('event: foo\ndata: {"a":1}\n\nevent: bar\ndata: [1,2]\n\n')
  assert.equal(events.length, 2)
  assert.equal(events[0].event, 'foo')
  assert.deepEqual(JSON.parse(events[0].data), { a: 1 })
  assert.equal(events[1].event, 'bar')
})

test('SSEParser: handles events split across chunks mid-line', () => {
  const p = new SSEParser()
  assert.deepEqual(p.feed('event: fo'), [])
  const e1 = p.feed('o\ndata: {"x":')
  assert.deepEqual(e1, [])
  const e2 = p.feed('10}\n\n')
  assert.equal(e2.length, 1)
  assert.equal(e2[0].event, 'foo')
  assert.deepEqual(JSON.parse(e2[0].data), { x: 10 })
})

test('SSEParser: ignores comment lines (keep-alive)', () => {
  const p = new SSEParser()
  const events = p.feed(': OPENROUTER PROCESSING\ndata: {"ok":true}\n\n')
  assert.equal(events.length, 1)
  assert.deepEqual(JSON.parse(events[0].data), { ok: true })
})

test('SSEParser: default event name is message', () => {
  const p = new SSEParser()
  const events = p.feed('data: hello\n\n')
  assert.equal(events[0].event, 'message')
  assert.equal(events[0].data, 'hello')
})

test('SSEParser: multi-line data joined with newline', () => {
  const p = new SSEParser()
  const events = p.feed('data: line1\ndata: line2\n\n')
  assert.equal(events[0].data, 'line1\nline2')
})

test('SSEParser: CRLF line endings', () => {
  const p = new SSEParser()
  const events = p.feed('event: x\r\ndata: 1\r\n\r\n')
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'x')
  assert.equal(events[0].data, '1')
})

test('SSEParser: bare CR line endings (SSE spec allows \\r)', () => {
  const p = new SSEParser()
  // A trailing lone \r is held by feed() (it could start a \r\n pair);
  // flush() at end of stream resolves it as a terminator.
  const held = p.feed('event: ping\rdata: {"a":1}\r\r')
  assert.equal(held.length, 0)
  const events = p.flush()
  assert.equal(events.length, 1)
  assert.equal(events[0].event, 'ping')
  assert.deepEqual(JSON.parse(events[0].data), { a: 1 })
})

test('SSEParser: bare CR events resolve as more bytes arrive', () => {
  const p = new SSEParser()
  // The first event's blank line (\r\r) is followed by more bytes, so it
  // emits immediately; only the trailing \r of the next line is held.
  const e1 = p.feed('event: a\rdata: 1\r\revent: b\r')
  assert.equal(e1.length, 1)
  assert.equal(e1[0].event, 'a')
  assert.equal(e1[0].data, '1')
})

test('SSEParser: trailing lone CR waits for next chunk before terminating', () => {
  const p = new SSEParser()
  // A trailing \r may be the first half of \r\n; it must not split the
  // following line until the next byte arrives.
  assert.deepEqual(p.feed('data: x\r'), [])
  const events = p.feed('\n\r\n')
  assert.equal(events.length, 1)
  assert.equal(events[0].data, 'x')
})

// ---------------------------------------------------------------------------
// AnthropicStreamTranslator helpers
// ---------------------------------------------------------------------------

function makeTranslator() {
  const events = []
  const t = new AnthropicStreamTranslator({
    model: 'test/model',
    messageId: 'msg_test',
    write: (event, data) => events.push({ event, data }),
  })
  return { t, events }
}

const chunk = (delta, finish = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`

const eventNames = (events) => events.map((e) => e.event)

// Anthropic protocol invariant: a content block is immutable once stopped.
// Every index must be stopped exactly once, and no delta may arrive for an
// index after its stop. This is the check the old tests lacked, which let
// the double-stop / delta-after-stop bug slip through.
function assertBlockProtocol(events) {
  const stopped = new Set()
  for (const e of events) {
    if (e.event === 'content_block_delta') {
      assert.ok(
        !stopped.has(e.data.index),
        `delta emitted after stop on index ${e.data.index}`,
      )
    }
    if (e.event === 'content_block_stop') {
      assert.ok(!stopped.has(e.data.index), `index ${e.data.index} stopped twice`)
      stopped.add(e.data.index)
    }
  }
}

// ---------------------------------------------------------------------------
// translator: text stream
// ---------------------------------------------------------------------------

test('text stream produces well-formed Anthropic event sequence', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ role: 'assistant', content: 'Hello' }))
  t.push(chunk({ content: ' world' }))
  t.push(chunk({}, 'stop'))
  t.push('data: [DONE]\n\n')

  assert.deepEqual(eventNames(events), [
    'message_start',
    'ping',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  const start = events[2]
  assert.equal(start.data.index, 0)
  assert.deepEqual(start.data.content_block, { type: 'text', text: '' })
  assert.deepEqual(events[3].data.delta, { type: 'text_delta', text: 'Hello' })
  assert.deepEqual(events[4].data.delta, { type: 'text_delta', text: ' world' })
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_reason, 'end_turn')
})

test('message_start carries id/role/model', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push('data: [DONE]\n\n')
  const m = events[0].data.message
  assert.equal(m.id, 'msg_test')
  assert.equal(m.role, 'assistant')
  assert.equal(m.model, 'test/model')
})

// ---------------------------------------------------------------------------
// translator: tool call stream
// ---------------------------------------------------------------------------

test('tool call stream: start block + incremental input_json_delta', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ tool_calls: [{ index: 0, id: 'call_1', function: { name: 'Bash', arguments: '' } }] }))
  t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '{"comm' } }] }))
  t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: 'and":"ls"}' } }] }))
  t.push(chunk({}, 'tool_calls'))
  t.push('data: [DONE]\n\n')

  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0].data.content_block, {
    type: 'tool_use',
    id: 'call_1',
    name: 'Bash',
    input: {},
  })
  const deltas = events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => e.data.delta.partial_json)
  assert.equal(deltas.join(''), '{"command":"ls"}')
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_reason, 'tool_use')
})

test('two parallel tool calls get sequential block indices', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'f1', arguments: '{}' } }] }))
  t.push(chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'f2', arguments: '{}' } }] }))
  t.push(chunk({}, 'tool_calls'))
  t.push('data: [DONE]\n\n')

  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.deepEqual(starts.map((s) => s.data.index), [0, 1])
  assert.deepEqual(starts.map((s) => s.data.content_block.name), ['f1', 'f2'])
  const stops = events.filter((e) => e.event === 'content_block_stop').map((s) => s.data.index)
  assert.deepEqual(stops, [0, 1])
  assertBlockProtocol(events)
})

// ---------------------------------------------------------------------------
// translator: interleaved content kinds
// ---------------------------------------------------------------------------

test('text -> tool -> text: text streams live, tool flushes as a whole block at the end', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ content: 'before' }))
  t.push(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] }))
  t.push(chunk({ content: 'after' }))
  t.push(chunk({}, 'stop'))
  t.push('data: [DONE]\n\n')

  // 'before' and 'after' continue the same live text block (index 0);
  // the buffered tool call flushes as block 1 at finish.
  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.deepEqual(starts.map((s) => [s.data.index, s.data.content_block.type]), [
    [0, 'text'],
    [1, 'tool_use'],
  ])
  const textDeltas = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'text_delta')
    .map((e) => e.data.delta.text)
  assert.deepEqual(textDeltas, ['before', 'after'])
  const stops = events.filter((e) => e.event === 'content_block_stop').map((s) => s.data.index)
  assert.deepEqual(stops, [0, 1])
  assertBlockProtocol(events)
})

test('tool call resuming after other content: protocol-safe (args buffered, one stop per index)', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a' } }] }))
  t.push(chunk({ content: 'interjection' }))
  t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '":1}' } }] }))
  t.push('data: [DONE]\n\n')

  // The interleaved text becomes the live block 0; the tool call flushes
  // as block 1 with its full arguments — never as a delta into a
  // previously-stopped index.
  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.deepEqual(starts.map((s) => s.data.content_block.type), ['text', 'tool_use'])
  const toolDeltas = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta')
    .map((e) => e.data.delta.partial_json)
  assert.equal(toolDeltas.join(''), '{"a":1}')
  // The tool block is stopped exactly once, after all its deltas.
  const stops = events.filter((e) => e.event === 'content_block_stop').map((s) => s.data.index)
  assert.deepEqual(stops, [0, 1])
  assertBlockProtocol(events)
})

// ---------------------------------------------------------------------------
// translator: reasoning stream
// ---------------------------------------------------------------------------

test('reasoning_content becomes thinking block with signature on close', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ reasoning_content: 'let me think' }))
  t.push(chunk({ content: 'answer' }))
  t.push(chunk({}, 'stop'))
  t.push('data: [DONE]\n\n')

  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.deepEqual(starts.map((s) => [s.data.index, s.data.content_block.type]), [
    [0, 'thinking'],
    [1, 'text'],
  ])
  const thinkingDeltas = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'thinking_delta')
    .map((e) => e.data.delta.thinking)
  assert.deepEqual(thinkingDeltas, ['let me think'])
  const sig = events.find((e) => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta')
  assert.ok(sig, 'signature_delta emitted before thinking block stop')
  // signature must come before the thinking block's stop event
  const stopIdx = events.findIndex((e) => e.event === 'content_block_stop' && e.data.index === 0)
  const sigIdx = events.findIndex((e) => e.event === 'content_block_delta' && e.data.delta.type === 'signature_delta')
  assert.ok(sigIdx < stopIdx)
})

test('OpenRouter-style delta.reasoning also maps to thinking', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(`data: ${JSON.stringify({ choices: [{ delta: { reasoning: 'hmm' } }] })}\n\n`)
  t.push('data: [DONE]\n\n')
  const thinking = events.filter((e) => e.data?.delta?.type === 'thinking_delta')
  assert.equal(thinking.length, 1)
})

// ---------------------------------------------------------------------------
// translator: usage, errors, edge cases
// ---------------------------------------------------------------------------

test('usage captured from final chunk lands in message_delta', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ content: 'hi' }))
  t.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 9 } })}\n\n`)
  t.push('data: [DONE]\n\n')
  const md = events.find((e) => e.event === 'message_delta')
  assert.deepEqual(md.data.usage, { input_tokens: 5, output_tokens: 9 })
})

test('usage-only chunk with empty choices does not crash', () => {
  const { t } = makeTranslator()
  t.start()
  t.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`)
  t.push('data: [DONE]\n\n')
  assert.ok(t.ended)
})

test('empty stream still emits empty text block and end_turn', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push('data: [DONE]\n\n')
  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.equal(starts.length, 1)
  assert.deepEqual(starts[0].data.content_block, { type: 'text', text: '' })
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_reason, 'end_turn')
})

test('upstream error event mid-stream emits anthropic error', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ content: 'partial' }))
  t.push(`data: ${JSON.stringify({ error: { type: 'server_error', message: 'boom' } })}\n\n`)
  const err = events.find((e) => e.event === 'error')
  assert.ok(err)
  assert.equal(err.data.error.message, 'boom')
  assert.equal(err.data.error.type, 'server_error')
  assert.ok(t.ended)
})

test('finish() is idempotent', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push('data: [DONE]\n\n')
  const before = events.length
  t.finish()
  t.finish()
  assert.equal(events.length, before)
})

test('push after end is ignored', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push('data: [DONE]\n\n')
  const before = events.length
  t.push(chunk({ content: 'late' }))
  assert.equal(events.length, before)
})

test('malformed JSON lines are tolerated', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push('data: {not json}\n\n')
  t.push(chunk({ content: 'ok' }))
  t.push('data: [DONE]\n\n')
  const deltas = events.filter((e) => e.data?.delta?.type === 'text_delta')
  assert.equal(deltas.length, 1)
})

test('length finish_reason maps to max_tokens in stream', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ content: 'truncated' }, 'length'))
  t.push('data: [DONE]\n\n')
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_reason, 'max_tokens')
})

// ---------------------------------------------------------------------------
// translator: input token estimate
// ---------------------------------------------------------------------------

test('message_start carries the input token estimate', () => {
  const events = []
  const t = new AnthropicStreamTranslator({
    model: 'test/model',
    messageId: 'msg_test',
    inputTokens: 123,
    write: (event, data) => events.push({ event, data }),
  })
  t.start()
  assert.equal(events[0].data.message.usage.input_tokens, 123)
})

test('message_delta usage fallback includes input_tokens', () => {
  const events = []
  const t = new AnthropicStreamTranslator({
    model: 'test/model',
    messageId: 'msg_test',
    inputTokens: 77,
    write: (event, data) => events.push({ event, data }),
  })
  t.start()
  t.push(chunk({ content: 'some output' }))
  t.push('data: [DONE]\n\n')
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.usage.input_tokens, 77)
  assert.ok(md.data.usage.output_tokens > 0)
})

test('real usage chunk overrides the input estimate in message_delta', () => {
  const events = []
  const t = new AnthropicStreamTranslator({
    model: 'test/model',
    messageId: 'msg_test',
    inputTokens: 999,
    write: (event, data) => events.push({ event, data }),
  })
  t.start()
  t.push(chunk({ content: 'hi' }))
  t.push(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 5, completion_tokens: 2 } })}\n\n`)
  t.push('data: [DONE]\n\n')
  const md = events.find((e) => e.event === 'message_delta')
  assert.deepEqual(md.data.usage, { input_tokens: 5, output_tokens: 2 })
})

// ---------------------------------------------------------------------------
// translator: stop_sequence backfill
// ---------------------------------------------------------------------------

test('stop_sequence backfilled when streamed text ends with a requested stop', () => {
  const events = []
  const t = new AnthropicStreamTranslator({
    model: 'test/model',
    messageId: 'msg_test',
    stopSequences: ['END', 'STOP'],
    write: (event, data) => events.push({ event, data }),
  })
  t.start()
  t.push(chunk({ content: 'hello wor' }))
  t.push(chunk({ content: 'ldEND' }))
  t.push(chunk({}, 'stop'))
  t.push('data: [DONE]\n\n')
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_sequence, 'END')
})

test('stop_sequence stays null when no requested stop is matched', () => {
  const events = []
  const t = new AnthropicStreamTranslator({
    model: 'test/model',
    messageId: 'msg_test',
    stopSequences: ['ZZZ'],
    write: (event, data) => events.push({ event, data }),
  })
  t.start()
  t.push(chunk({ content: 'plain ending' }))
  t.push(chunk({}, 'stop'))
  t.push('data: [DONE]\n\n')
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_sequence, null)
})

test('stop_sequence not reported for non-stop finish reasons', () => {
  const events = []
  const t = new AnthropicStreamTranslator({
    model: 'test/model',
    messageId: 'msg_test',
    stopSequences: ['END'],
    write: (event, data) => events.push({ event, data }),
  })
  t.start()
  t.push(chunk({ content: 'truncatedEND' }, 'length'))
  t.push('data: [DONE]\n\n')
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_sequence, null)
})

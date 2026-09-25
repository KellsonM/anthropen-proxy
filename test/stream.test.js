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
})

// ---------------------------------------------------------------------------
// translator: interleaved content kinds
// ---------------------------------------------------------------------------

test('text -> tool -> text opens three sequential blocks', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ content: 'before' }))
  t.push(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{}' } }] }))
  t.push(chunk({ content: 'after' }))
  t.push(chunk({}, 'stop'))
  t.push('data: [DONE]\n\n')

  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.deepEqual(starts.map((s) => [s.data.index, s.data.content_block.type]), [
    [0, 'text'],
    [1, 'tool_use'],
    [2, 'text'],
  ])
  // The tool block must not be closed twice and the final stop closes block 2.
  const stops = events.filter((e) => e.event === 'content_block_stop').map((s) => s.data.index)
  assert.deepEqual(stops, [0, 1, 2])
})

test('tool call resuming after other content reuses its block without new start', () => {
  const { t, events } = makeTranslator()
  t.start()
  t.push(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'f', arguments: '{"a' } }] }))
  t.push(chunk({ content: 'interjection' }))
  t.push(chunk({ tool_calls: [{ index: 0, function: { arguments: '":1}' } }] }))
  t.push('data: [DONE]\n\n')

  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.deepEqual(starts.map((s) => s.data.content_block.type), ['tool_use', 'text'])
  const toolDeltas = events
    .filter((e) => e.event === 'content_block_delta' && e.data.delta.type === 'input_json_delta')
    .map((e) => e.data.delta.partial_json)
  assert.equal(toolDeltas.join(''), '{"a":1}')
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

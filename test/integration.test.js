import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { buildServer } from '../src/server.js'
import { SSEParser } from '../src/stream.js'

// ---------------------------------------------------------------------------
// Fake OpenAI-compatible upstream
// ---------------------------------------------------------------------------

function startFakeUpstream(handler) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        const captured = { path: req.url, headers: req.headers, body: body ? JSON.parse(body) : null }
        handler(captured, res)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      resolve({
        base: `http://127.0.0.1:${server.address().port}/v1`,
        close: () =>
          new Promise((r) => {
            server.close(r)
            // Destroy lingering keep-alive/aborted sockets so close() resolves
            // even when a test left a connection open (e.g. never-responding).
            if (server.closeAllConnections) server.closeAllConnections()
          }),
      })
    })
  })
}

async function startProxy(configOverrides = {}) {
  const app = buildServer({
    models: { completion: 'test/completion', reasoning: 'test/reasoning' },
    filterTools: ['BatchTool'],
    streamUsage: true,
    ...configOverrides,
  })
  await app.listen({ port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${app.server.address().port}`
  return { app, base, close: () => app.close() }
}

function sse(res) {
  return res.text().then((text) => {
    const p = new SSEParser()
    return p.feed(text + '\n\n').map((e) => ({ event: e.event, data: JSON.parse(e.data) }))
  })
}

const anthropicBody = (extra = {}) => ({
  model: 'claude-sonnet-4-5-20250901',
  max_tokens: 256,
  messages: [{ role: 'user', content: 'hello' }],
  ...extra,
})

const cleanups = []
after(async () => {
  for (const c of cleanups) await c()
})

// ---------------------------------------------------------------------------
// non-streaming
// ---------------------------------------------------------------------------

test('e2e: non-streaming text response', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-xyz',
        choices: [{ index: 0, message: { role: 'assistant', content: 'Hi there!' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 11, completion_tokens: 4 },
      }),
    )
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody()),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.type, 'message')
  assert.equal(body.role, 'assistant')
  assert.ok(body.id.startsWith('msg_'))
  assert.deepEqual(body.content, [{ type: 'text', text: 'Hi there!', citations: null }])
  assert.equal(body.stop_reason, 'end_turn')
  assert.deepEqual(body.usage, { input_tokens: 11, output_tokens: 4 })
})

test('e2e: forwarded payload merges system, maps tools, drops BatchTool', async () => {
  let captured = null
  const upstream = await startFakeUpstream((req, res) => {
    captured = req
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    )
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base, apiKey: 'sk-test' })
  cleanups.push(() => proxy.close())

  await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      anthropicBody({
        system: [{ type: 'text', text: 'You are Claude Code.' }],
        tools: [
          { name: 'Read', description: 'read', input_schema: { type: 'object', properties: { p: { type: 'string', format: 'uri' } } } },
          { name: 'BatchTool', description: 'drop me', input_schema: { type: 'object' } },
        ],
        messages: [
          { role: 'user', content: 'read a.txt' },
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { p: 'a.txt' } }],
          },
          { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'contents' }] },
          { role: 'user', content: 'now summarize' },
        ],
      }),
    ),
  })

  const payload = captured.body
  assert.equal(payload.model, 'test/completion')
  assert.equal(payload.messages[0].role, 'system')
  assert.equal(payload.messages[0].content, 'You are Claude Code.')
  assert.deepEqual(payload.messages.map((m) => m.role), [
    'system', 'user', 'assistant', 'tool', 'user',
  ])
  assert.equal(payload.messages[3].tool_call_id, 'tu_1')
  assert.equal(payload.messages[3].content, 'contents')
  assert.equal(payload.tools.length, 1)
  assert.equal(payload.tools[0].function.name, 'Read')
  assert.deepEqual(payload.tools[0].function.parameters.properties.p, { type: 'string' })
  assert.equal(captured.headers.authorization, 'Bearer sk-test')
})

test('e2e: thinking request routes to reasoning model', async () => {
  let captured = null
  const upstream = await startFakeUpstream((req, res) => {
    captured = req.body
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'deep' }, finish_reason: 'stop' }] }))
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody({ thinking: { type: 'enabled', budget_tokens: 4096 } })),
  })
  assert.equal(captured.model, 'test/reasoning')
})

test('e2e: non-streaming tool call response', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [
          {
            message: {
              role: 'assistant',
              content: null,
              tool_calls: [
                { id: 'call_7', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls -la"}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    )
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody()),
  })
  const body = await res.json()
  assert.equal(body.stop_reason, 'tool_use')
  assert.deepEqual(body.content, [
    { type: 'tool_use', id: 'call_7', name: 'Bash', input: { command: 'ls -la' } },
  ])
})

// ---------------------------------------------------------------------------
// streaming
// ---------------------------------------------------------------------------

test('e2e: streaming text response', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    assert.equal(req.body.stream, true)
    assert.deepEqual(req.body.stream_options, { include_usage: true })
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"index":0,"delta":{"role":"assistant","content":"Hel"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{"content":"lo!"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: {"choices":[],"usage":{"prompt_tokens":8,"completion_tokens":3}}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody({ stream: true })),
  })
  assert.equal(res.status, 200)
  assert.match(res.headers.get('content-type'), /text\/event-stream/)

  const events = await sse(res)
  const names = events.map((e) => e.event)
  assert.deepEqual(names, [
    'message_start',
    'ping',
    'content_block_start',
    'content_block_delta',
    'content_block_delta',
    'content_block_stop',
    'message_delta',
    'message_stop',
  ])
  assert.equal(events[2].data.content_block.type, 'text')
  assert.equal(events[3].data.delta.text, 'Hel')
  assert.equal(events[4].data.delta.text, 'lo!')
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_reason, 'end_turn')
  assert.deepEqual(md.data.usage, { input_tokens: 8, output_tokens: 3 })
})

test('e2e: streaming tool call response', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"Read","arguments":""}}]},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"file_path\\":"}}]},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"x.txt\\"}"}}]},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody({ stream: true })),
  })
  const events = await sse(res)
  const start = events.find((e) => e.event === 'content_block_start')
  assert.equal(start.data.content_block.type, 'tool_use')
  assert.equal(start.data.content_block.name, 'Read')
  const json = events
    .filter((e) => e.event === 'content_block_delta')
    .map((e) => e.data.delta.partial_json)
    .join('')
  assert.deepEqual(JSON.parse(json), { file_path: 'x.txt' })
  const md = events.find((e) => e.event === 'message_delta')
  assert.equal(md.data.delta.stop_reason, 'tool_use')
})

test('e2e: streaming reasoning becomes thinking block', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write('data: {"choices":[{"index":0,"delta":{"reasoning_content":"thinking hard"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{"content":"done thinking"},"finish_reason":null}]}\n\n')
    res.write('data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\n')
    res.write('data: [DONE]\n\n')
    res.end()
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody({ stream: true, thinking: { type: 'enabled', budget_tokens: 1024 } })),
  })
  const events = await sse(res)
  const starts = events.filter((e) => e.event === 'content_block_start')
  assert.deepEqual(starts.map((s) => [s.data.index, s.data.content_block.type]), [
    [0, 'thinking'],
    [1, 'text'],
  ])
})

// ---------------------------------------------------------------------------
// errors
// ---------------------------------------------------------------------------

test('e2e: upstream 400 is translated to anthropic error shape', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ error: { message: 'model not found' } }))
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody()),
  })
  assert.equal(res.status, 400)
  const body = await res.json()
  assert.equal(body.type, 'error')
  assert.equal(body.error.message, 'model not found')
})

test('e2e: unreachable upstream returns 502', async () => {
  const proxy = await startProxy({ baseUrl: 'http://127.0.0.1:1/v1' })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody()),
  })
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.equal(body.type, 'error')
  assert.match(body.error.message, /Cannot reach backend/)
})

test('e2e: invalid request (missing max_tokens) rejected before upstream call', async () => {
  let called = false
  const upstream = await startFakeUpstream((req, res) => {
    called = true
    res.end('{}')
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }),
  })
  assert.equal(res.status, 400)
  assert.equal(called, false)
  const body = await res.json()
  assert.equal(body.error.type, 'invalid_request_error')
})

// ---------------------------------------------------------------------------
// auxiliary endpoints
// ---------------------------------------------------------------------------

test('e2e: count_tokens returns positive estimate', async () => {
  const proxy = await startProxy({ baseUrl: 'http://127.0.0.1:1/v1' })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages/count_tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody({ system: 'long system prompt here' })),
  })
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.ok(body.input_tokens > 0)
})

test('e2e: health endpoint', async () => {
  const proxy = await startProxy({ baseUrl: 'http://127.0.0.1:1/v1' })
  cleanups.push(() => proxy.close())
  const res = await fetch(`${proxy.base}/health`)
  assert.equal(res.status, 200)
})

// ---------------------------------------------------------------------------
// robustness: timeout, error shapes, top_k gate, reasoning passthrough
// ---------------------------------------------------------------------------

test('e2e: unresponsive upstream times out with 504', async () => {
  const upstream = await startFakeUpstream(() => {
    // deliberately never respond
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base, timeout: 200 })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody()),
  })
  assert.equal(res.status, 504)
  const body = await res.json()
  assert.equal(body.type, 'error')
  assert.equal(body.error.type, 'api_error')
  assert.match(body.error.message, /inactivity/)
})

test('e2e: non-streaming invalid JSON from upstream -> 502 anthropic error', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end('this is not json')
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody()),
  })
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.equal(body.type, 'error')
  assert.match(body.error.message, /Invalid JSON/)
})

test('e2e: upstream 200 with no choices -> 502 api_error in anthropic shape', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ id: 'chatcmpl-empty' }))
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody()),
  })
  assert.equal(res.status, 502)
  const body = await res.json()
  assert.equal(body.type, 'error')
  assert.equal(body.error.type, 'api_error')
})

test('e2e: non-streaming reasoning_content surfaces as thinking block', async () => {
  const upstream = await startFakeUpstream((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        choices: [
          {
            message: { role: 'assistant', reasoning_content: 'pondering...', content: 'answer' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 2 },
      }),
    )
  })
  cleanups.push(() => upstream.close())
  const proxy = await startProxy({ baseUrl: upstream.base })
  cleanups.push(() => proxy.close())

  const res = await fetch(`${proxy.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody()),
  })
  const body = await res.json()
  assert.equal(body.content[0].type, 'thinking')
  assert.equal(body.content[0].thinking, 'pondering...')
  assert.equal(body.content[1].type, 'text')
})

test('e2e: top_k forwarded by default, omitted when topK=false', async () => {
  let captured = null
  const upstream = await startFakeUpstream((req, res) => {
    captured = req.body
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }))
  })
  cleanups.push(() => upstream.close())

  const p1 = await startProxy({ baseUrl: upstream.base })
  await fetch(`${p1.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody({ top_k: 40 })),
  })
  assert.equal(captured.top_k, 40)
  await p1.close()

  const p2 = await startProxy({ baseUrl: upstream.base, topK: false })
  await fetch(`${p2.base}/v1/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(anthropicBody({ top_k: 40 })),
  })
  assert.equal(captured.top_k, undefined)
  await p2.close()
})

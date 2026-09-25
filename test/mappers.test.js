import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  anthropicToOpenAI,
  openaiToAnthropic,
  normalizeSystem,
  normalizeToolResultContent,
  removeUriFormat,
  mapToolChoice,
  mapStopReason,
  convertMessage,
  estimateTokens,
} from '../src/mappers.js'

const MODELS = { completion: 'test/completion', reasoning: 'test/reasoning' }
const base = (extra = {}) => ({
  model: 'claude-sonnet-4-5',
  max_tokens: 128,
  messages: [{ role: 'user', content: 'hi' }],
  ...extra,
})

// ---------------------------------------------------------------------------
// system handling
// ---------------------------------------------------------------------------

test('system: plain string passes through', () => {
  assert.equal(normalizeSystem('you are helpful'), 'you are helpful')
})

test('system: array of text blocks merges with blank line', () => {
  const out = normalizeSystem([
    { type: 'text', text: 'A', cache_control: { type: 'ephemeral' } },
    { type: 'text', text: 'B' },
  ])
  assert.equal(out, 'A\n\nB')
})

test('system: becomes leading OpenAI system message', () => {
  const p = anthropicToOpenAI(base({ system: 'sys prompt' }), { models: MODELS })
  assert.deepEqual(p.messages[0], { role: 'system', content: 'sys prompt' })
})

test('system-role messages inside conversation are hoisted after leading system', () => {
  const p = anthropicToOpenAI(
    base({
      system: 'top',
      messages: [
        { role: 'user', content: 'q1' },
        { role: 'system', content: 'mid instruction' },
        { role: 'assistant', content: 'a1' },
        { role: 'user', content: 'q2' },
      ],
    }),
    { models: MODELS },
  )
  assert.deepEqual(p.messages.map((m) => m.role), ['system', 'system', 'user', 'assistant', 'user'])
  assert.equal(p.messages[1].content, 'mid instruction')
})

// ---------------------------------------------------------------------------
// user content blocks
// ---------------------------------------------------------------------------

test('user string content stays a string', () => {
  const p = anthropicToOpenAI(base(), { models: MODELS })
  assert.deepEqual(p.messages[0], { role: 'user', content: 'hi' })
})

test('user text-only block array collapses to string', () => {
  const [m] = convertMessage({
    role: 'user',
    content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }],
  })
  assert.deepEqual(m, { role: 'user', content: 'ab' })
})

test('user image block becomes data-URL image_url part', () => {
  const [m] = convertMessage({
    role: 'user',
    content: [
      { type: 'text', text: 'look' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    ],
  })
  assert.equal(m.role, 'user')
  assert.deepEqual(m.content[1], {
    type: 'image_url',
    image_url: { url: 'data:image/png;base64,AAAA' },
  })
})

test('user url image block maps to url part', () => {
  const [m] = convertMessage({
    role: 'user',
    content: [{ type: 'image', source: { type: 'url', url: 'https://x/y.png' } }],
  })
  assert.deepEqual(m.content[0].image_url, { url: 'https://x/y.png' })
})

test('document block becomes text placeholder', () => {
  const [m] = convertMessage({
    role: 'user',
    content: [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: '...' } }],
  })
  assert.equal(m.content, '[document: application/pdf]')
})

// ---------------------------------------------------------------------------
// tool results
// ---------------------------------------------------------------------------

test('tool_result string content becomes tool message', () => {
  const msgs = convertMessage({
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'file contents' }],
  })
  assert.deepEqual(msgs, [{ role: 'tool', tool_call_id: 'tu_1', content: 'file contents' }])
})

test('tool_result array content flattens text, placeholders for images', () => {
  const out = normalizeToolResultContent([
    { type: 'text', text: 'line1' },
    { type: 'image', source: { media_type: 'image/jpeg' } },
    { type: 'text', text: 'line2' },
  ])
  assert.equal(out, 'line1\n[image: image/jpeg]\nline2')
})

test('tool_result blocks precede user text in same message', () => {
  const msgs = convertMessage({
    role: 'user',
    content: [
      { type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' },
      { type: 'text', text: 'thanks' },
    ],
  })
  assert.deepEqual(msgs.map((m) => m.role), ['tool', 'user'])
})

// ---------------------------------------------------------------------------
// assistant content
// ---------------------------------------------------------------------------

test('assistant tool_use becomes OpenAI tool_calls with JSON string args', () => {
  const [m] = convertMessage({
    role: 'assistant',
    content: [
      { type: 'text', text: 'reading' },
      { type: 'tool_use', id: 'tu_9', name: 'Read', input: { file_path: '/tmp/a' } },
    ],
  })
  assert.equal(m.content, 'reading')
  assert.deepEqual(m.tool_calls, [
    { id: 'tu_9', type: 'function', function: { name: 'Read', arguments: '{"file_path":"/tmp/a"}' } },
  ])
})

test('assistant thinking blocks are dropped', () => {
  const msgs = convertMessage({
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'hmm' }],
  })
  assert.deepEqual(msgs, [])
})

test('assistant thinking + text keeps only text', () => {
  const [m] = convertMessage({
    role: 'assistant',
    content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }],
  })
  assert.deepEqual(m, { role: 'assistant', content: 'answer' })
})

// ---------------------------------------------------------------------------
// tools / tool_choice
// ---------------------------------------------------------------------------

test('tools map name/description/input_schema and drop filtered names', () => {
  const p = anthropicToOpenAI(
    base({
      tools: [
        { name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } },
        { name: 'BatchTool', description: 'x', input_schema: { type: 'object' } },
      ],
    }),
    { models: MODELS, filterToolNames: ['BatchTool'] },
  )
  assert.equal(p.tools.length, 1)
  assert.deepEqual(p.tools[0], {
    type: 'function',
    function: { name: 'Read', description: 'read a file', parameters: { type: 'object', properties: {} } },
  })
})

test('removeUriFormat strips format:uri recursively', () => {
  const out = removeUriFormat({
    type: 'object',
    properties: {
      path: { type: 'string', format: 'uri' },
      nested: { type: 'object', properties: { u: { type: 'string', format: 'uri' } } },
      list: { type: 'array', items: { type: 'string', format: 'uri' } },
      keep: { type: 'string', format: 'date' },
    },
  })
  assert.deepEqual(out.properties.path, { type: 'string' })
  assert.deepEqual(out.properties.nested.properties.u, { type: 'string' })
  assert.deepEqual(out.properties.list.items, { type: 'string' })
  assert.deepEqual(out.properties.keep, { type: 'string', format: 'date' })
})

test('tool_choice mapping', () => {
  assert.equal(mapToolChoice({ type: 'auto' }), 'auto')
  assert.equal(mapToolChoice({ type: 'none' }), 'none')
  assert.equal(mapToolChoice({ type: 'any' }), 'required')
  assert.deepEqual(mapToolChoice({ type: 'tool', name: 'X' }), {
    type: 'function',
    function: { name: 'X' },
  })
  assert.equal(mapToolChoice(undefined), undefined)
})

test('tool_choice only emitted when tools exist', () => {
  const p = anthropicToOpenAI(base({ tool_choice: { type: 'any' } }), { models: MODELS })
  assert.equal(p.tool_choice, undefined)
  assert.equal(p.tools, undefined)
})

// ---------------------------------------------------------------------------
// sampling params / model selection
// ---------------------------------------------------------------------------

test('thinking enabled selects reasoning model', () => {
  const p = anthropicToOpenAI(base({ thinking: { type: 'enabled', budget_tokens: 2048 } }), {
    models: MODELS,
  })
  assert.equal(p.model, 'test/reasoning')
})

test('thinking disabled selects completion model', () => {
  const p = anthropicToOpenAI(base({ thinking: { type: 'disabled' } }), { models: MODELS })
  assert.equal(p.model, 'test/completion')
})

test('temperature/top_p/top_k/stop_sequences map through', () => {
  const p = anthropicToOpenAI(
    base({ temperature: 0.3, top_p: 0.9, top_k: 40, stop_sequences: ['END', 'STOP'] }),
    { models: MODELS },
  )
  assert.equal(p.temperature, 0.3)
  assert.equal(p.top_p, 0.9)
  assert.equal(p.top_k, 40)
  assert.deepEqual(p.stop, ['END', 'STOP'])
})

test('empty stop_sequences is omitted', () => {
  const p = anthropicToOpenAI(base({ stop_sequences: [] }), { models: MODELS })
  assert.equal(p.stop, undefined)
})

test('stream flag and stream_options', () => {
  const s = anthropicToOpenAI(base({ stream: true }), { models: MODELS })
  assert.equal(s.stream, true)
  assert.deepEqual(s.stream_options, { include_usage: true })
  const ns = anthropicToOpenAI(base(), { models: MODELS })
  assert.equal(ns.stream, false)
  assert.equal(ns.stream_options, undefined)
})

test('stream_options omitted when includeStreamUsage=false', () => {
  const p = anthropicToOpenAI(base({ stream: true }), { models: MODELS, includeStreamUsage: false })
  assert.equal(p.stream_options, undefined)
})

// ---------------------------------------------------------------------------
// validation
// ---------------------------------------------------------------------------

test('missing messages rejected', () => {
  assert.throws(
    () => anthropicToOpenAI({ model: 'x', max_tokens: 1 }, { models: MODELS }),
    /messages/,
  )
})

test('missing max_tokens rejected', () => {
  assert.throws(
    () => anthropicToOpenAI({ model: 'x', messages: [{ role: 'user', content: 'hi' }] }, { models: MODELS }),
    /max_tokens/,
  )
})

test('unsupported role rejected', () => {
  assert.throws(
    () =>
      anthropicToOpenAI(
        { model: 'x', max_tokens: 1, messages: [{ role: 'wizard', content: 'hi' }] },
        { models: MODELS },
      ),
    /Unsupported message role/,
  )
})

// ---------------------------------------------------------------------------
// response mapping
// ---------------------------------------------------------------------------

test('openai text response -> anthropic message', () => {
  const out = openaiToAnthropic(
    {
      id: 'chatcmpl-abc123',
      choices: [{ message: { role: 'assistant', content: 'Hello!' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 12, completion_tokens: 7 },
    },
    'test/completion',
  )
  assert.equal(out.type, 'message')
  assert.equal(out.role, 'assistant')
  assert.ok(out.id.startsWith('msg_'))
  assert.deepEqual(out.content, [{ type: 'text', text: 'Hello!', citations: null }])
  assert.equal(out.stop_reason, 'end_turn')
  assert.deepEqual(out.usage, { input_tokens: 12, output_tokens: 7 })
})

test('openai tool_calls response -> anthropic tool_use blocks', () => {
  const out = openaiToAnthropic(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              { id: 'call_1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'm',
  )
  assert.equal(out.stop_reason, 'tool_use')
  assert.deepEqual(out.content, [
    { type: 'tool_use', id: 'call_1', name: 'Bash', input: { command: 'ls' } },
  ])
})

test('malformed tool arguments parse to empty object', () => {
  const out = openaiToAnthropic(
    {
      choices: [
        {
          message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: 'not-json' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'm',
  )
  assert.deepEqual(out.content[0].input, {})
})

test('length finish maps to max_tokens', () => {
  assert.equal(mapStopReason('length'), 'max_tokens')
  assert.equal(mapStopReason('tool_calls'), 'tool_use')
  assert.equal(mapStopReason('stop'), 'end_turn')
  assert.equal(mapStopReason(undefined, true), 'tool_use')
  assert.equal(mapStopReason(undefined, false), 'end_turn')
})

test('usage falls back to estimate when absent', () => {
  const out = openaiToAnthropic(
    { choices: [{ message: { content: 'hello world' }, finish_reason: 'stop' }] },
    'm',
    'some input text here',
  )
  assert.ok(out.usage.input_tokens > 0)
  assert.ok(out.usage.output_tokens > 0)
  assert.equal(estimateTokens(''), 0)
})

test('response with no choices throws', () => {
  assert.throws(() => openaiToAnthropic({}, 'm'), /no choices/)
})

// ---------------------------------------------------------------------------
// bypass_app_detail_message
// ---------------------------------------------------------------------------

const APP_DETAIL = '<application_details>Claude Code app context</application_details>'

test('bypass off (default): system message with <application_details> is kept', () => {
  const p = anthropicToOpenAI(
    base({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: APP_DETAIL },
        { role: 'assistant', content: 'hello' },
      ],
    }),
    { models: MODELS },
  )
  const sys = p.messages.filter((m) => m.role === 'system')
  assert.equal(sys.length, 1)
  assert.ok(sys[0].content.includes('<application_details>'))
})

test('bypass on: drops the matching system message, leaves others untouched', () => {
  const messages = [
    { role: 'user', content: 'hi' },
    { role: 'system', content: APP_DETAIL },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ]
  const p = anthropicToOpenAI(base({ messages }), {
    models: MODELS,
    bypassAppDetailMessage: true,
  })
  assert.deepEqual(p.messages, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'user', content: 'again' },
  ])
})

test('bypass on: system message without the tag is kept', () => {
  const p = anthropicToOpenAI(
    base({ messages: [{ role: 'system', content: 'plain system' }, { role: 'user', content: 'hi' }] }),
    { models: MODELS, bypassAppDetailMessage: true },
  )
  assert.deepEqual(p.messages, [
    { role: 'system', content: 'plain system' },
    { role: 'user', content: 'hi' },
  ])
})

test('bypass on: works with array-of-blocks content', () => {
  const p = anthropicToOpenAI(
    base({
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'system',
          content: [
            { type: 'text', text: 'prefix ' },
            { type: 'text', text: APP_DETAIL },
          ],
        },
        { role: 'user', content: 'bye' },
      ],
    }),
    { models: MODELS, bypassAppDetailMessage: true },
  )
  assert.deepEqual(p.messages, [
    { role: 'user', content: 'hi' },
    { role: 'user', content: 'bye' },
  ])
})

test('bypass on: only affects system role, not user/assistant', () => {
  const p = anthropicToOpenAI(
    base({
      messages: [
        { role: 'user', content: `user says ${APP_DETAIL}` },
        { role: 'assistant', content: `assistant says ${APP_DETAIL}` },
      ],
    }),
    { models: MODELS, bypassAppDetailMessage: true },
  )
  assert.equal(p.messages.length, 2)
  assert.ok(p.messages[0].content.includes('<application_details>'))
  assert.ok(p.messages[1].content.includes('<application_details>'))
})

test('bypass on: top-level system field is not affected', () => {
  const p = anthropicToOpenAI(
    base({ system: APP_DETAIL, messages: [{ role: 'user', content: 'hi' }] }),
    { models: MODELS, bypassAppDetailMessage: true },
  )
  assert.equal(p.messages.length, 2)
  assert.equal(p.messages[0].role, 'system')
  assert.ok(p.messages[0].content.includes('<application_details>'))
})

// ---------------------------------------------------------------------------
// non-streaming reasoning / error semantics / CJK estimate / top_k gate
// ---------------------------------------------------------------------------

test('openai reasoning_content becomes leading thinking block', () => {
  const out = openaiToAnthropic(
    {
      choices: [
        {
          message: {
            role: 'assistant',
            reasoning_content: 'step by step...',
            content: 'final answer',
          },
          finish_reason: 'stop',
        },
      ],
    },
    'm',
  )
  assert.deepEqual(out.content[0], { type: 'thinking', thinking: 'step by step...', signature: '' })
  assert.equal(out.content[1].type, 'text')
  assert.equal(out.content[1].text, 'final answer')
})

test('openrouter-style reasoning field also becomes thinking', () => {
  const out = openaiToAnthropic(
    { choices: [{ message: { reasoning: 'hmm', content: 'ok' }, finish_reason: 'stop' }] },
    'm',
  )
  assert.equal(out.content[0].type, 'thinking')
  assert.equal(out.content[0].thinking, 'hmm')
})

test('no-choices error carries 502 api_error', () => {
  try {
    openaiToAnthropic({}, 'm')
    assert.fail('should have thrown')
  } catch (err) {
    assert.match(err.message, /no choices/)
    assert.equal(err.status, 502)
    assert.equal(err.errorType, 'api_error')
  }
})

test('tool_choice of type tool without name is rejected', () => {
  assert.throws(() => mapToolChoice({ type: 'tool' }), /requires a `name`/)
})

test('estimateTokens counts CJK as ~1 token per char', () => {
  assert.equal(estimateTokens('你好世界'), 4)
  assert.equal(estimateTokens('hello'), 2)
  assert.equal(estimateTokens('你好, world'), 4)
  assert.equal(estimateTokens(''), 0)
})

test('includeTopK=false omits top_k from forwarded payload', () => {
  const p = anthropicToOpenAI(base({ top_k: 40 }), { models: MODELS, includeTopK: false })
  assert.equal(p.top_k, undefined)
})

test('malformed tool args trigger the warn callback', () => {
  const warnings = []
  const out = openaiToAnthropic(
    {
      choices: [
        {
          message: { tool_calls: [{ id: 'c', function: { name: 'f', arguments: 'bad' } }] },
          finish_reason: 'tool_calls',
        },
      ],
    },
    'm',
    '',
    { warn: (m) => warnings.push(m) },
  )
  assert.equal(warnings.length, 1)
  assert.deepEqual(out.content[0].input, {})
})

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveConfig } from '../src/config.js'

test('defaults', () => {
  const c = resolveConfig([], {})
  assert.equal(c.host, '127.0.0.1')
  assert.equal(c.port, 3000)
  assert.equal(c.baseUrl, 'http://localhost:11434/v1')
  assert.equal(c.apiKey, null)
  assert.equal(c.models.completion, 'qwen2.5-coder:7b')
  assert.equal(c.models.reasoning, 'qwen2.5-coder:7b')
  assert.deepEqual(c.filterTools, ['BatchTool'])
  assert.equal(c.streamUsage, true)
  assert.equal(c.debug, false)
})

test('env vars are honored', () => {
  const c = resolveConfig([], {
    HOST: '0.0.0.0',
    PORT: '8080',
    ANTHROPIC_PROXY_BASE_URL: 'http://vllm:8000/v1/',
    OPENROUTER_API_KEY: 'sk-or',
    COMPLETION_MODEL: 'a/b',
    REASONING_MODEL: 'c/d',
    FILTER_TOOLS: 'X, Y ,Z',
    DISABLE_STREAM_USAGE: '1',
    DEBUG: 'true',
  })
  assert.equal(c.host, '0.0.0.0')
  assert.equal(c.port, 8080)
  assert.equal(c.baseUrl, 'http://vllm:8000/v1') // trailing slash stripped
  assert.equal(c.apiKey, 'sk-or')
  assert.equal(c.models.completion, 'a/b')
  assert.equal(c.models.reasoning, 'c/d')
  assert.deepEqual(c.filterTools, ['X', 'Y', 'Z'])
  assert.equal(c.streamUsage, false)
  assert.equal(c.debug, true)
})

test('CLI flags override env vars', () => {
  const c = resolveConfig(
    ['--port', '9999', '--base-url', 'http://cli/v1', '--model', 'cli/model', '--reasoning-model', 'cli/reason', '--api-key', 'sk-cli', '--filter-tools', 'Q'],
    { PORT: '1', ANTHROPIC_PROXY_BASE_URL: 'http://env/v1', COMPLETION_MODEL: 'env/model', OPENROUTER_API_KEY: 'sk-env', FILTER_TOOLS: 'P' },
  )
  assert.equal(c.port, 9999)
  assert.equal(c.baseUrl, 'http://cli/v1')
  assert.equal(c.models.completion, 'cli/model')
  assert.equal(c.models.reasoning, 'cli/reason')
  assert.equal(c.apiKey, 'sk-cli')
  assert.deepEqual(c.filterTools, ['Q'])
})

test('MODEL env sets completion, reasoning falls back to it', () => {
  const c = resolveConfig([], { MODEL: 'single/model' })
  assert.equal(c.models.completion, 'single/model')
  assert.equal(c.models.reasoning, 'single/model')
})

test('--no-stream-usage disables usage option', () => {
  const c = resolveConfig(['--no-stream-usage'], {})
  assert.equal(c.streamUsage, false)
})

test('--help flag', () => {
  const c = resolveConfig(['--help'], {})
  assert.equal(c.help, true)
})

test('unknown option errors with exit code 2', () => {
  assert.throws(() => resolveConfig(['--wat'], {}), (err) => err.exitCode === 2)
})

test('bypass_app_detail_message defaults to false', () => {
  const c = resolveConfig([], {})
  assert.equal(c.bypassAppDetailMessage, false)
})

test('--bypass-app-detail-message enables the flag', () => {
  const c = resolveConfig(['--bypass-app-detail-message'], {})
  assert.equal(c.bypassAppDetailMessage, true)
})

test('BYPASS_APP_DETAIL_MESSAGE env enables the flag', () => {
  assert.equal(resolveConfig([], { BYPASS_APP_DETAIL_MESSAGE: '1' }).bypassAppDetailMessage, true)
  assert.equal(resolveConfig([], { BYPASS_APP_DETAIL_MESSAGE: 'true' }).bypassAppDetailMessage, true)
  assert.equal(resolveConfig([], { BYPASS_APP_DETAIL_MESSAGE: '0' }).bypassAppDetailMessage, false)
})

// ---------------------------------------------------------------------------
// timeout / top_k / validation
// ---------------------------------------------------------------------------

test('timeout defaults to 600s, stored as ms', () => {
  assert.equal(resolveConfig([], {}).timeout, 600_000)
})

test('--timeout and UPSTREAM_TIMEOUT override (CLI wins)', () => {
  assert.equal(resolveConfig(['--timeout', '30'], {}).timeout, 30_000)
  assert.equal(resolveConfig([], { UPSTREAM_TIMEOUT: '45' }).timeout, 45_000)
  assert.equal(resolveConfig(['--timeout', '10'], { UPSTREAM_TIMEOUT: '45' }).timeout, 10_000)
})

test('invalid timeout rejected with exit code 2', () => {
  assert.throws(() => resolveConfig(['--timeout', 'abc'], {}), (err) => err.exitCode === 2)
  assert.throws(() => resolveConfig(['--timeout', '0'], {}), (err) => err.exitCode === 2)
})

test('invalid port rejected with exit code 2', () => {
  assert.throws(() => resolveConfig(['--port', 'abc'], {}), (err) => err.exitCode === 2)
  assert.throws(() => resolveConfig([], { PORT: '99999' }), (err) => err.exitCode === 2)
  assert.equal(resolveConfig(['--port', '0'], {}).port, 0) // ephemeral is valid
})

test('topK defaults to true', () => {
  assert.equal(resolveConfig([], {}).topK, true)
})

test('--no-top-k and DISABLE_TOP_K disable top_k forwarding', () => {
  assert.equal(resolveConfig(['--no-top-k'], {}).topK, false)
  assert.equal(resolveConfig([], { DISABLE_TOP_K: '1' }).topK, false)
  assert.equal(resolveConfig([], { DISABLE_TOP_K: 'true' }).topK, false)
  assert.equal(resolveConfig([], { DISABLE_TOP_K: '0' }).topK, true)
})

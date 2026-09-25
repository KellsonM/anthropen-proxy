// Configuration resolution: CLI flags override environment variables,
// which override built-in defaults.

// Boolean env vars accept "1" or "true"; anything else is off.
const truthy = (v) => v === '1' || v === 'true'

export const HELP = `anthropen-proxy — Anthropic Messages API -> OpenAI Chat Completions proxy

Usage:
  anthropen-proxy [options]
  ANTHROPIC_PROXY_BASE_URL=http://localhost:11434/v1 node index.js

Options (env var in parentheses):
  --host <host>               Bind host (HOST, default 127.0.0.1)
  --port <port>               Bind port (PORT, default 3000)
  --base-url <url>            OpenAI-compatible backend base URL
                              (ANTHROPIC_PROXY_BASE_URL, default http://localhost:11434/v1)
  --api-key <key>             Backend API key, sent as Bearer token
                              (OPENROUTER_API_KEY / ANTHROPIC_PROXY_API_KEY, optional)
  --model <name>              Default model for normal requests
  --completion-model <name>   Alias for --model
                              (COMPLETION_MODEL / MODEL, default qwen2.5-coder:7b)
  --reasoning-model <name>    Model used when the request enables thinking
                              (REASONING_MODEL, defaults to --model)
  --filter-tools <a,b,c>      Tool names to drop before forwarding
                              (FILTER_TOOLS, default "BatchTool")
  --no-stream-usage           Do not send stream_options.include_usage
                              (DISABLE_STREAM_USAGE=1)
  --bypass-app-detail-message Drop system messages inside the messages array
                              whose content contains <application_details>
                              (BYPASS_APP_DETAIL_MESSAGE=1)
  --timeout <seconds>         Upstream inactivity timeout: abort when no bytes
                              arrive from the backend for this long
                              (UPSTREAM_TIMEOUT, default 600)
  --no-top-k                Do not forward top_k to the backend (strict
                              OpenAI servers reject it) (DISABLE_TOP_K=1)
  --debug                     Verbose request/response logging (DEBUG=1)
  --help                      Show this help

Claude Code example:
  ANTHROPIC_BASE_URL=http://127.0.0.1:3000 ANTHROPIC_API_KEY=any node index.js
`

export function resolveConfig(argv = [], env = process.env) {
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    const take = () => argv[++i]
    switch (arg) {
      case '--host': flags.host = take(); break
      case '--port': flags.port = Number(take()); break
      case '--base-url': flags.baseUrl = take(); break
      case '--api-key': flags.apiKey = take(); break
      case '--model': flags.completionModel = take(); break
      case '--completion-model': flags.completionModel = take(); break
      case '--reasoning-model': flags.reasoningModel = take(); break
      case '--filter-tools': flags.filterTools = take(); break
      case '--no-stream-usage': flags.streamUsage = false; break
      case '--bypass-app-detail-message': flags.bypassAppDetailMessage = true; break
      case '--timeout': flags.timeout = Number(take()); break
      case '--no-top-k': flags.topK = false; break
      case '--debug': flags.debug = true; break
      case '--help': case '-h': flags.help = true; break
      default:
        if (arg.startsWith('--')) {
          const err = new Error(`Unknown option: ${arg}`)
          err.exitCode = 2
          throw err
        }
    }
  }

  const completionModel =
    flags.completionModel ?? env.COMPLETION_MODEL ?? env.MODEL ?? 'qwen2.5-coder:7b'
  const reasoningModel =
    flags.reasoningModel ?? env.REASONING_MODEL ?? completionModel

  const filterRaw = flags.filterTools ?? env.FILTER_TOOLS ?? 'BatchTool'
  const filterTools = String(filterRaw)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const streamUsage =
    flags.streamUsage !== undefined ? flags.streamUsage : !truthy(env.DISABLE_STREAM_USAGE)

  const port = flags.port ?? Number(env.PORT ?? 3000)
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    const err = new Error(`Invalid port: ${flags.port ?? env.PORT}`)
    err.exitCode = 2
    throw err
  }

  const timeoutSec = flags.timeout ?? Number(env.UPSTREAM_TIMEOUT ?? 600)
  if (!Number.isInteger(timeoutSec) || timeoutSec <= 0) {
    const err = new Error(`Invalid --timeout (seconds): ${flags.timeout ?? env.UPSTREAM_TIMEOUT}`)
    err.exitCode = 2
    throw err
  }

  return {
    host: flags.host ?? env.HOST ?? '127.0.0.1',
    port,
    timeout: timeoutSec * 1000,
    topK: flags.topK ?? !truthy(env.DISABLE_TOP_K),
    baseUrl: (flags.baseUrl ?? env.ANTHROPIC_PROXY_BASE_URL ?? 'http://localhost:11434/v1')
      .replace(/\/+$/, ''),
    apiKey: flags.apiKey ?? env.ANTHROPIC_PROXY_API_KEY ?? env.OPENROUTER_API_KEY ?? null,
    models: { completion: completionModel, reasoning: reasoningModel },
    filterTools,
    streamUsage,
    bypassAppDetailMessage: flags.bypassAppDetailMessage ?? truthy(env.BYPASS_APP_DETAIL_MESSAGE),
    debug: flags.debug ?? truthy(env.DEBUG),
    help: flags.help === true,
  }
}

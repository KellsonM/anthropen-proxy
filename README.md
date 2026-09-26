# anthropen-proxy

A translation layer that converts the **Anthropic Messages API** (the front-end protocol used by clients such as Claude Code) into the **OpenAI Chat Completions API** (a local LLM backend).

No changes are needed on the front end: Claude Code / the Anthropic SDK keeps calling `POST /v1/messages` as usual; the backend can be any OpenAI-compatible service (Ollama, vLLM, llama.cpp server, LM Studio, or a cloud API such as OpenRouter).

## Features

- **Full protocol conversion**: system messages, multimodal content (text/images), tool calls (tool_use / tool_result), stop_sequences, sampling parameters, and more
- **Streaming SSE conversion**: OpenAI chunk stream → Anthropic event stream (`message_start` / `content_block_*` / `message_delta` / `message_stop`). Text and thinking stream live; tool-call arguments are buffered and emitted as whole blocks at the end, so a tool call interleaved with other content never produces an illegal "delta after block stop" sequence
- **Thinking-model routing**: requests carrying `thinking` are automatically switched to the reasoning model; `reasoning` / `reasoning_content` deltas are mapped to Anthropic `thinking_delta`
- **Error conversion**: every error — upstream errors *and* Fastify's own (malformed JSON body, 404, 413, …) — is mapped to the standard Anthropic error format (`invalid_request_error` / `authentication_error` / `rate_limit_error` / `api_error`, etc.)
- **Optional inbound authentication**: set `--inbound-key` / `INBOUND_API_KEY` to require clients to present the key via `x-api-key` or `Authorization: Bearer`; requests without it get a 401 (constant-time comparison)
- **Auxiliary endpoints**: `/v1/messages/count_tokens` (token estimation; base64 images are charged a fixed ~1600 tokens each instead of their encoded size), `/health`
- **Robust streaming**: true inactivity timeout on both streaming and non-streaming paths, drain-based backpressure for slow clients, immediate upstream cancellation when the client disconnects mid-stream, and graceful shutdown on SIGINT/SIGTERM
- **133 automated tests**: unit tests + end-to-end integration tests (`npm test`)

## Installation

```bash
npm install
```

Requires Node.js ≥ 20 (Fastify 5 and its dependencies require 20+).

## Quick Start

### 1. Start a local model (pick one)

```bash
# Ollama (connects to http://localhost:11434/v1 by default)
ollama serve

# vLLM
vllm serve Qwen/Qwen2.5-Coder-7B-Instruct --port 8000

# llama.cpp server
llama-server -m model.gguf --port 8080
```

### 2. Start the proxy

```bash
# Default: Ollama + qwen2.5-coder:7b
node index.js

# Specify backend and model
node index.js --base-url http://localhost:8000/v1 --model Qwen/Qwen2.5-Coder-7B-Instruct

# With an API key (e.g. when connecting to OpenRouter)
OPENROUTER_API_KEY=sk-or-xxx node index.js --base-url https://openrouter.ai/api/v1
```

### 3. Point Claude Code at the proxy

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3000 \
ANTHROPIC_API_KEY=any-non-empty-string \
claude
```

> Claude Code requires a non-empty API key, but whether the proxy validates it depends on the backend; with a local backend any value usually works.

## Configuration

Command-line arguments take precedence over environment variables, which take precedence over defaults.

| Argument | Environment variable | Default | Description |
|---|---|---|---|
| `--host` | `HOST` | `127.0.0.1` | Listen address |
| `--port` | `PORT` | `3000` | Listen port |
| `--base-url` | `ANTHROPIC_PROXY_BASE_URL` | `http://localhost:11434/v1` | OpenAI-compatible backend base URL (without `/chat/completions`) |
| `--api-key` | `OPENROUTER_API_KEY` / `ANTHROPIC_PROXY_API_KEY` | none | Backend Bearer key; no Authorization header is sent if unset |
| `--inbound-key` | `INBOUND_API_KEY` | none | When set, every request must present this key via `x-api-key` or `Authorization: Bearer` or get a 401 (`/health` and the `/api/hello` probe stay open). Recommended when binding to a non-loopback address |
| `--model` (alias `--completion-model`) | `COMPLETION_MODEL` / `MODEL` | `qwen2.5-coder:7b` | Model used for regular requests |
| `--reasoning-model` | `REASONING_MODEL` | same as `--model` | Model used when the request carries `thinking` |
| `--filter-tools` | `FILTER_TOOLS` | `BatchTool` | Comma-separated tool names to drop before forwarding |
| — | `DISABLE_STREAM_USAGE=1` | off | Do not send `stream_options.include_usage` (for strict backends) |
| `--bypass-app-detail-message` | `BYPASS_APP_DETAIL_MESSAGE=1` | off | During conversion, drop the single message in the `messages` array whose `role: "system"` content contains `<application_details>`; all other messages are unaffected |
| `--timeout <seconds>` | `UPSTREAM_TIMEOUT` | `600` | Upstream inactivity timeout: abort with 504 when the backend sends no bytes for this long. The timer resets on every received byte in both streaming and non-streaming paths, so a slow-but-active response is never killed |
| `--no-top-k` | `DISABLE_TOP_K=1` | off | Do not forward `top_k` (strict OpenAI-compatible backends reject unknown fields with 400) |
| `--debug` | `DEBUG=1` | off | Print the converted payload / logs |
| `--help` | — | — | Help |

## Verification

```bash
# Health check
curl http://127.0.0.1:3000/health

# Non-streaming
curl -s http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"Hello"}]}'

# Streaming
curl -N http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"Hello"}]}'

# Token counting
curl -s http://127.0.0.1:3000/v1/messages/count_tokens \
  -H 'content-type: application/json' \
  -d '{"max_tokens":64,"messages":[{"role":"user","content":"hello world"}]}'
```

## Running Tests

```bash
npm test
```

Coverage: request mapping (system merging, message role conversion, tools/tool results including `is_error` surfacing, sampling parameters, model routing, validation), SSE parsing (chunked line breaks, comments, CRLF and bare-CR), streaming block-index management and the block-immutability invariant (every index stopped exactly once, no delta after stop), error conversion (including Fastify-layer errors), request-side token estimation (base64 stripping, fixed per-image cost, regex fast path verified equal to the reference algorithm), inbound authentication, and end-to-end integration (real HTTP + fake upstream, including client-disconnect cancellation, empty-body handling, and inactivity-timeout semantics).

## Known Limitations

- The quality of Anthropic-level tool calling with local models depends on the model itself; strong function-calling models such as Qwen2.5-Coder or DeepSeek-Coder are recommended
- `document` (PDF) content blocks are replaced with a placeholder `[document: ...]` (the OpenAI protocol has no equivalent capability)
- The `signature` of thinking blocks is an empty string (local models cannot sign; this does not affect Claude Code display)
- Token counts are estimates (~1 char/token for CJK, ~4 chars/token otherwise; images charged a fixed 1600 tokens each), not exact tokenization
- **Tool calls do not stream incrementally.** Tool-call argument fragments are buffered and emitted as a complete `tool_use` block when the stream finishes. This is deliberate: a content block is immutable once stopped, so resuming a tool call after interleaved text would otherwise require illegal "delta after block stop" events. Text and thinking still stream in real time (see TECHNICAL.md §2.3)
- `stop_sequence` is backfilled on a best-effort basis: OpenAI-compatible backends usually strip the matched stop string from the returned text, so it is only reported when the backend keeps it
- Some Anthropic fields are ignored because local OpenAI-compatible backends have no equivalent: `metadata`, `service_tier`, and `tool_choice.disable_parallel_tool_use`
- **Do not enable `--debug` / `DEBUG=1` in production.** Debug logging writes full request/response payloads (i.e. all conversation content) to the logs

For detailed protocol mapping rules, see [TECHNICAL.md](./TECHNICAL.md).

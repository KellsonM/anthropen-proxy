# anthropic-proxy

A translation layer that converts the **Anthropic Messages API** (the front-end protocol used by clients such as Claude Code) into the **OpenAI Chat Completions API** (a local LLM backend).

No changes are needed on the front end: Claude Code / the Anthropic SDK keeps calling `POST /v1/messages` as usual; the backend can be any OpenAI-compatible service (Ollama, vLLM, llama.cpp server, LM Studio, or a cloud API such as OpenRouter).

## Features

- **Full protocol conversion**: system messages, multimodal content (text/images), tool calls (tool_use / tool_result), stop_sequences, sampling parameters, and more
- **Streaming SSE conversion**: OpenAI chunk stream → Anthropic event stream (`message_start` / `content_block_*` / `message_delta` / `message_stop`), correctly handling block-index switching and interleaving of text, thinking, and tool calls
- **Thinking-model routing**: requests carrying `thinking` are automatically switched to the reasoning model; `reasoning` / `reasoning_content` deltas are mapped to Anthropic `thinking_delta`
- **Error conversion**: upstream errors are mapped to the standard Anthropic error format (`authentication_error` / `rate_limit_error` / `api_error`, etc.)
- **Auxiliary endpoints**: `/v1/messages/count_tokens` (token estimation), `/health`
- **75 automated tests**: unit tests + end-to-end integration tests (`npm test`)

## Installation

```bash
npm install
```

Requires Node.js ≥ 18 (20+ recommended).

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
| `--model` | `COMPLETION_MODEL` / `MODEL` | `qwen2.5-coder:7b` | Model used for regular requests |
| `--reasoning-model` | `REASONING_MODEL` | same as `--model` | Model used when the request carries `thinking` |
| `--filter-tools` | `FILTER_TOOLS` | `BatchTool` | Comma-separated tool names to drop before forwarding |
| — | `DISABLE_STREAM_USAGE=1` | off | Do not send `stream_options.include_usage` (for strict backends) |
| `--bypass-app-detail-message` | `BYPASS_APP_DETAIL_MESSAGE=1` | off | During conversion, drop the single message in the `messages` array whose `role: "system"` content contains `<application_details>`; all other messages are unaffected |
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

Coverage: request mapping (system merging, message role conversion, tools/tool results, sampling parameters, model routing, validation), SSE parsing (chunked line breaks, comments, CRLF), streaming block-index management (text/thinking/tool interleaving), error conversion, end-to-end integration (real HTTP + fake upstream).

## Known Limitations

- The quality of Anthropic-level tool calling with local models depends on the model itself; strong function-calling models such as Qwen2.5-Coder or DeepSeek-Coder are recommended
- `document` (PDF) content blocks are replaced with a placeholder `[document: ...]` (the OpenAI protocol has no equivalent capability)
- The `signature` of thinking blocks is an empty string (local models cannot sign; this does not affect Claude Code display)
- Token counts are estimates (~4 characters/token), not exact tokenization

For detailed protocol mapping rules, see [TECHNICAL.md](./TECHNICAL.md).

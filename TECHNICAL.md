# Technical Documentation: Anthropic ↔ OpenAI Protocol Translation Layer

This document describes the architectural differences between the two protocols and this project's translation implementation.

## 1. Protocol Architecture Comparison

### 1.1 Anthropic Messages API (front end)

```
POST /v1/messages
{
  "model": "claude-sonnet-4-5",
  "system": "string | [{type:'text', text, cache_control}]",
  "messages": [
    { "role": "user"|"assistant",
      "content": "string" | [ContentBlock...] }
  ],
  "tools": [{ "name", "description", "input_schema" }],
  "tool_choice": {type:'auto'|'any'|'tool'|'none'},
  "max_tokens": 1024,          // required
  "temperature", "top_p", "top_k", "stop_sequences",
  "thinking": {type:'enabled'|'disabled', budget_tokens},
  "stream": true|false
}
```

ContentBlock types: `text`, `image` (base64/url), `tool_use` (id/name/input), `tool_result` (tool_use_id/content), `document`, `thinking`, `redacted_thinking`.

Key characteristics:
- **A single message can contain multiple heterogeneous content blocks**: e.g. an assistant message = thinking + text + multiple tool_use; a user message = multiple tool_result + text
- **Streaming is a typed event stream**: `message_start → content_block_start/delta/stop (in index order) → message_delta → message_stop`, plus `ping` and `error`
- **Content block indexes increase globally**, and each block carries only one content type

### 1.2 OpenAI Chat Completions API (backend)

```
POST /v1/chat/completions
{
  "model": "...",
  "messages": [
    { "role": "system"|"user"|"assistant"|"tool", ... }
  ],
  "tools": [{ "type":"function", "function": {name, description, parameters} }],
  "tool_choice": "auto"|"none"|"required"|{type:'function',function:{name}},
  "max_tokens", "temperature", "top_p", "stop": [...],
  "stream": true, "stream_options": {"include_usage": true}
}
```

Key characteristics:
- **Flat role model**: tool results must be separate `role:"tool"` messages (with `tool_call_id`); an assistant's tool calls go in the `tool_calls` array
- **Streaming is a uniform chunk stream**: each chunk carries `choices[].delta` (content / tool_calls / reasoning_content), ending with `data: [DONE]`
- No concept of thinking (some backends provide it via the `delta.reasoning` / `delta.reasoning_content` extension)

### 1.3 Core Differences Summary

| Dimension | Anthropic | OpenAI |
|---|---|---|
| System message | Top-level `system` field, may be an array | `role:"system"` inside messages |
| Tool results | `tool_result` blocks inside a user message | Separate `role:"tool"` messages |
| Tool calls | `tool_use` blocks inside an assistant message | `tool_calls` array on the assistant message |
| Stop reason | `end_turn` / `tool_use` / `max_tokens` | `stop` / `tool_calls` / `length` |
| Streaming structure | Typed events + block indexes | Delta chunks + `[DONE]` |
| Thinking | `thinking` blocks + `thinking_delta` | No standard (`reasoning_content` extension) |
| Images | `source: {type:'base64', media_type, data}` | `image_url: {url: 'data:...'}` |

## 2. Translation Implementation

### 2.1 Request Mapping (`src/mappers.js` → `anthropicToOpenAI`)

**System handling**: the top-level `system` (a string or an array of blocks) is merged into a single OpenAI system message placed first. `role:"system"` messages appearing mid-conversation are hoisted ahead of all user/assistant messages — because most local backends only recognize a system message in the first position.

**bypass_app_detail_message**: when `--bypass-app-detail-message` (or `BYPASS_APP_DETAIL_MESSAGE=1`) is enabled, the single message in the `messages` array whose `role:"system"` text content contains `<application_details>` is dropped entirely during conversion (neither hoisted nor forwarded); the content and structure of all other messages in the array, as well as the top-level `system` field, are unaffected.

**Message expansion** (`convertMessage`, one Anthropic message → 0..n OpenAI messages):

| Anthropic | OpenAI |
|---|---|
| user string | `{role:'user', content:'...'}` |
| user array of plain-text blocks | merged into a string (maximum compatibility) |
| user with images | content parts: `{type:'image_url', image_url:{url:'data:<mime>;base64,...'}}` |
| user `tool_result` blocks | each expanded to `{role:'tool', tool_call_id, content}`, **before** any subsequent user text in the same message |
| assistant `text` | the `content` field |
| assistant `tool_use` | `tool_calls: [{id, type:'function', function:{name, arguments: JSON.stringify(input)}}]` |
| assistant `thinking` | dropped (OpenAI cannot replay thinking content) |
| `document` block | text placeholder `[document: <mime>]` |

**Tool mapping**: `input_schema → parameters`, recursively stripping `format:"uri"` (a common source of errors with local models). Unavailable tools such as `BatchTool` are dropped according to `filterTools`.

**tool_choice**: `auto→auto`, `none→none`, `any→required`, `{type:'tool',name}→{type:'function',function:{name}}`. A forced tool that is not in the forwarded tool list (e.g. dropped by `filterTools`) is discarded with a `warn` diagnostic instead of being forwarded, so the backend never receives a dangling reference and the client's tool loop gets a clear log line instead of a silent deadlock.

**Model routing**: `thinking.type === 'enabled'` → `models.reasoning`, otherwise `models.completion`.

**Streaming usage**: when streaming, `stream_options:{include_usage:true}` is attached so the backend returns real token counts in the final chunk (can be disabled with `DISABLE_STREAM_USAGE=1` for strict backends).

### 2.2 Non-Streaming Response Mapping (`openaiToAnthropic`)

- `choices[0].message.content` → `{type:'text', text, citations:null}` block
- `reasoning` / `reasoning_content` → a leading `{type:'thinking', thinking, signature:''}` block (keeps the non-streaming path consistent with the streaming one)
- `tool_calls[]` → `{type:'tool_use', id, name, input}` blocks (if arguments fail JSON parsing, degrade to `{}` without interrupting the response; the failure is surfaced through a `warn` callback for debug logging)
- `finish_reason` → `stop_reason`: `stop→end_turn`, `length→max_tokens`, `tool_calls→tool_use`, `content_filter→end_turn`
- `id`: `chatcmpl-xxx → msg_xxx`; randomly generated when missing
- `usage`: `prompt_tokens→input_tokens`, `completion_tokens→output_tokens`; when missing, the input side uses the request-side estimate (`estimateRequestTokens`: base64 payloads stripped, images charged a fixed 1600 tokens each) and the output side is estimated from the response text (~1 char/token for CJK, ~4 chars/token otherwise)
- Missing `choices` → throws a **502 `api_error`** (an upstream problem, not a client error)

### 2.3 Streaming Translation (`src/stream.js`)

**SSEParser**: incrementally parses the upstream SSE. Handles line breaks at arbitrary byte offsets, multi-line `data:`, `:` comment lines (OpenRouter keep-alive), and CRLF. Events are framed by blank lines. Scans with an index pointer and re-slices the leftover tail only once per `feed()`, so a batch of k lines in an n-byte buffer costs O(n) rather than O(k·n).

**AnthropicStreamTranslator**: reassembles the OpenAI delta stream into an Anthropic event sequence. The core is a **block-index state machine**:

```
State: current = {type, index} | null
       nextIndex (next available block index, incrementing from 0)
       toolBlocks: Map<openai_tool_index, anthropic_block_index>

Rules:
- reasoning/reasoning_content → if current block is not thinking: close old block, open thinking block; emit thinking_delta
- content → if current block is not text: close old block, open text block; emit text_delta
- tool_calls[i]:
    · first time seeing index i → close old block, open tool_use block (id/name), record mapping
    · see index i again but current block has switched away → close current block, point back to i's original block (do not re-send start)
    · emit input_json_delta (arguments increment)
- when closing a thinking block, emit a supplementary signature_delta (empty signature, for protocol integrity)
- [DONE] / finish_reason → close all blocks → message_delta(stop_reason, usage) → message_stop
- upstream error → close blocks → error event
```

This state machine correctly handles three classes of interleaving scenarios:
1. **Text → tool → text**: blocks 0(text), 1(tool_use), 2(text) increment in order
2. **Parallel tool calls**: OpenAI's tool_calls[0]/[1] map to Anthropic blocks 0/1
3. **Tool arguments interrupted by other content then resumed**: reuse the original block index, producing no duplicate start

> **Known edge case (scenario 3)**: when the interruption closes the tool block, resuming sends `input_json_delta` against an already-stopped index without re-emitting `content_block_start`. Strictly speaking this violates the Anthropic rule that a stopped block cannot be reopened; most real-world clients tolerate it, but a strictly spec-compliant client may reject the stream. The proper fix would be to defer closing unfinished tool blocks until the message ends.

**Usage**: `message_start` carries the request-side input estimate (mirroring the real API, which reports input tokens up front). `message_delta` reports the real usage when the backend sends a usage chunk; otherwise it falls back to the input estimate plus an output estimate from the accumulated text.

### 2.4 Server Layer (`src/server.js`)

- Fastify 5, `bodyLimit` 64MB (to accommodate base64 images)
- The streaming path uses `reply.hijack()` to take over the raw socket and write SSE frames directly (`event:` + `data:` + blank line), flushing whenever a `flush` is available, ensuring low-latency token-by-token output
- Upstream unreachable → 502 `api_error`; upstream 4xx/5xx → mapped by status to Anthropic error types (401/403→`authentication_error`, 404→`not_found_error`, 429→`rate_limit_error`)
- Request validation failures (missing `max_tokens`, empty `messages`, invalid role) return 400 **before** calling the upstream
- **Upstream inactivity timeout** (`--timeout`, default 600s): an `AbortController` timer is reset on every byte received from upstream — in **both** the streaming and the non-streaming path (the latter reads the response body in chunks for exactly this reason). A slow-but-active response survives; only a stalled one aborts with 504 `api_error`
- **Client disconnect (streaming)**: detected via the **response** stream's `close` event (`reply.raw`), which fires when the socket actually terminates. The request stream's `close` deliberately is *not* used: `IncomingMessage` fires it as soon as the request body has been consumed — before the handler registers a listener — so it can never observe a mid-stream disconnect. On a real disconnect the proxy aborts the upstream request, stopping generation nobody is listening for; socket `error` events are swallowed so a dead client can never crash the proxy
- **Backpressure**: when a write to a slow client returns `false`, the read loop pauses until the socket `drain`s, so frames throttle the upstream instead of buffering in memory without bound. If the client stalls forever, upstream bytes stop arriving and the inactivity timer aborts the request — the two mechanisms compose self-consistently
- **Error-shape guarantee**: every non-streaming mapping/parsing exception (invalid JSON body → 502, missing choices → 502 `api_error`, mapping errors) is caught and returned in the Anthropic error shape — Fastify's default error format never leaks to the client
- The request-side token estimate is computed only when actually needed (backend omitted `usage`, or a streaming response starts), and strips base64 payloads so images don't distort it

### 2.5 Configuration (`src/config.js`)

Three-level precedence: CLI arguments > environment variables > defaults. See the configuration table in the README. Port and timeout values are validated at startup; invalid values exit with code 2 instead of crashing later with a confusing error.

## 3. Testing Strategy

| File | Coverage |
|---|---|
| `test/mappers.test.js` | All request-mapping paths: system merging/hoisting, text/image/document blocks, tool_result expansion/ordering and `is_error` surfacing, assistant tool_use, thinking dropping, tool filtering, uri format stripping, all four tool_choice forms plus dangling-reference drop-with-warning, model routing, sampling parameters, input validation, response mapping, `estimateRequestTokens` (base64 stripping, fixed per-image cost) |
| `test/stream.test.js` | SSEParser chunked line breaks/comments/CRLF/multi-line data; translator: text-stream event sequence, tool-stream increments, parallel tool indexes, the three interleaving classes, thinking blocks and signatures, usage capture, input-token estimate in `message_start`/`message_delta`, empty streams, mid-stream errors, idempotency, malformed-JSON tolerance |
| `test/integration.test.js` | Real HTTP end-to-end: fake OpenAI upstream + real proxy, verifying forwarded payload structure, Authorization header, streaming/non-streaming responses, error conversion, count_tokens (incl. base64 image not counted as text), health, **client-disconnect cancellation** (upstream connection closes right after the client hangs up), and **inactivity-timeout semantics** (slow-but-active download survives past the total timeout) |
| `test/config.test.js` | Three-level configuration precedence, defaults, argument parsing |

Run: `npm test` (Node ≥ 18 built-in test runner, no extra dependencies). 116 tests total.

## 4. Extension Guide

- **Adding a new Anthropic block type**: handle the request side in `convertMessage`; handle the streaming side in `AnthropicStreamTranslator.handleChunk` (remember to register the new type in the block-switching state machine)
- **Integrating a new backend**: as long as it exposes an OpenAI-compatible `/chat/completions`, it can be plugged in directly via `--base-url`; if the backend is strict about unknown fields, set `DISABLE_STREAM_USAGE=1` and `DISABLE_TOP_K=1`
- **Accurate token counting**: `count_tokens` is currently an estimate (`estimateRequestTokens` in `mappers.js`, with the per-image constant `IMAGE_TOKEN_ESTIMATE = 1600`) and can be replaced with a tiktoken/wasm tokenizer

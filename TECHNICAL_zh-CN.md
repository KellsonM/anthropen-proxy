# 技术文档：Anthropic ↔ OpenAI 协议转换层

本文档描述两个协议的架构差异与本项目的转换实现。

## 1. 协议架构对比

### 1.1 Anthropic Messages API（前端）

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
  "max_tokens": 1024,          // 必填
  "temperature", "top_p", "top_k", "stop_sequences",
  "thinking": {type:'enabled'|'disabled', budget_tokens},
  "stream": true|false
}
```

ContentBlock 类型：`text`、`image`（base64/url）、`tool_use`（id/name/input）、`tool_result`（tool_use_id/content）、`document`、`thinking`、`redacted_thinking`。

关键特征：
- **一条消息可包含多个异构内容块**：例如 assistant 消息 = thinking + 文本 + 多个 tool_use；user 消息 = 多个 tool_result + 文本
- **流式为类型化事件流**：`message_start → content_block_start/delta/stop（按 index 顺序）→ message_delta → message_stop`，外加 `ping` 和 `error`
- **内容块 index 全局递增**，每个块只承载一种内容类型

### 1.2 OpenAI Chat Completions API（后端）

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

关键特征：
- **扁平角色模型**：工具结果必须是独立的 `role:"tool"` 消息（带 `tool_call_id`）；assistant 的工具调用放在 `tool_calls` 数组
- **流式为统一 chunk 流**：每个 chunk 携带 `choices[].delta`（content / tool_calls / reasoning_content），以 `data: [DONE]` 结束
- 无 thinking 概念（部分后端以 `delta.reasoning` / `delta.reasoning_content` 扩展提供）

### 1.3 核心差异总结

| 维度 | Anthropic | OpenAI |
|---|---|---|
| system 消息 | 顶层 `system` 字段，可数组 | messages 内 `role:"system"` |
| 工具结果 | user 消息内的 `tool_result` 块 | 独立 `role:"tool"` 消息 |
| 工具调用 | assistant 消息内 `tool_use` 块 | assistant 消息的 `tool_calls` 数组 |
| 停止原因 | `end_turn` / `tool_use` / `max_tokens` | `stop` / `tool_calls` / `length` |
| 流式结构 | 类型化事件 + 块索引 | delta chunk + `[DONE]` |
| 思考 | `thinking` 块 + `thinking_delta` | 无标准（`reasoning_content` 扩展） |
| 图片 | `source: {type:'base64', media_type, data}` | `image_url: {url: 'data:...'}` |

## 2. 转换实现

### 2.1 请求映射（`src/mappers.js` → `anthropicToOpenAI`）

**System 处理**：顶层 `system`（字符串或块数组）合并为单条 OpenAI system 消息置于首位。会话中途出现的 `role:"system"` 消息被提升（hoist）到所有 user/assistant 消息之前——因为多数本地后端只认首位 system 消息。

**bypass_app_detail_message**：启用 `--bypass-app-detail-message`（或 `BYPASS_APP_DETAIL_MESSAGE=1`）后，`messages` 数组中 `role:"system"` 且文本内容包含 `<application_details>` 的单条消息在转换时被整条丢弃（不提升、不转发）；数组中其他消息的内容与结构不受影响，顶层 `system` 字段也不受影响。

**消息展开**（`convertMessage`，一条 Anthropic 消息 → 0..n 条 OpenAI 消息）：

| Anthropic | OpenAI |
|---|---|
| user 字符串 | `{role:'user', content:'...'}` |
| user 纯文本块数组 | 合并为字符串（最大兼容） |
| user 含图片 | content parts：`{type:'image_url', image_url:{url:'data:<mime>;base64,...'}}` |
| user `tool_result` 块 | 每条展开为 `{role:'tool', tool_call_id, content}`，**先于**同消息内后续 user 文本 |
| assistant `text` | `content` 字段 |
| assistant `tool_use` | `tool_calls: [{id, type:'function', function:{name, arguments: JSON.stringify(input)}}]` |
| assistant `thinking` | 丢弃（OpenAI 无法回放思考内容） |
| `document` 块 | 文本占位符 `[document: <mime>]` |

**工具映射**：`input_schema → parameters`，并递归剥离 `format:"uri"`（本地模型常见报错源）。`BatchTool` 等不可用工具按 `filterTools` 丢弃。

**tool_choice**：`auto→auto`、`none→none`、`any→required`、`{type:'tool',name}→{type:'function',function:{name}}`。

**模型路由**：`thinking.type === 'enabled'` → `models.reasoning`，否则 `models.completion`。

**流式 usage**：stream 时附加 `stream_options:{include_usage:true}`，让后端在末尾 chunk 返回真实 token 数（可用 `DISABLE_STREAM_USAGE=1` 关闭以兼容严格后端）。

### 2.2 非流式响应映射（`openaiToAnthropic`）

- `choices[0].message.content` → `{type:'text', text, citations:null}` 块
- `reasoning` / `reasoning_content` → 前置的 `{type:'thinking', thinking, signature:''}` 块（保持非流式路径与流式路径一致）
- `tool_calls[]` → `{type:'tool_use', id, name, input}` 块（arguments JSON 解析失败时降级为 `{}`，不中断响应；失败会通过 `warn` 回调上报，供 debug 日志记录）
- `finish_reason` → `stop_reason`：`stop→end_turn`、`length→max_tokens`、`tool_calls→tool_use`、`content_filter→end_turn`
- `id`：`chatcmpl-xxx → msg_xxx`；缺失时随机生成
- `usage`：`prompt_tokens→input_tokens`、`completion_tokens→output_tokens`；缺失时估算（CJK 约 1 字/token、其余约 4 字符/token）
- 缺失 `choices` → 抛出 **502 `api_error`**（上游问题，而非客户端错误）

### 2.3 流式转换（`src/stream.js`）

**SSEParser**：增量解析上游 SSE。处理任意字节偏移的断行、多行 `data:`、`:` 注释行（OpenRouter keep-alive）、CRLF。事件以空行分帧。

**AnthropicStreamTranslator**：把 OpenAI delta 流重组为 Anthropic 事件序列。核心是**块索引状态机**：

```
状态: current = {type, index} | null
      nextIndex（下一个可用块索引，从 0 递增）
      toolBlocks: Map<openai_tool_index, anthropic_block_index>

规则:
- reasoning/reasoning_content → 若当前非 thinking 块：关旧块、开 thinking 块；发 thinking_delta
- content → 若当前非 text 块：关旧块、开 text 块；发 text_delta
- tool_calls[i]：
    · 首次见 index i → 关旧块、开 tool_use 块（id/name），记录映射
    · 再次见 index i 但当前块已切走 → 关当前块，指回 i 的原块（不重发 start）
    · 发 input_json_delta（arguments 增量）
- 关闭 thinking 块时补发 signature_delta（空签名，协议完整性）
- [DONE] / finish_reason → 关所有块 → message_delta(stop_reason, usage) → message_stop
- 上游 error → 关块 → error 事件
```

该状态机正确处理三类交错场景：
1. **文本 → 工具 → 文本**：块 0(text)、1(tool_use)、2(text) 顺序递增
2. **并行工具调用**：OpenAI 的 tool_calls[0]/[1] 映射为 Anthropic 块 0/1
3. **工具参数被其他内容打断后恢复**：复用原块索引，不产生重复 start

> **已知边界情况（场景 3）**：打断发生时工具块已被关闭，恢复时会对着已 stop 的索引继续发 `input_json_delta` 且不重发 `content_block_start`。严格来说这违反 Anthropic「块 stop 后不可重开」的规则；多数实际客户端可容忍，但严格遵循规范的客户端可能拒绝该流。正确的修复方向是把未完成的 tool 块延迟到消息结束再关闭。

**usage 兜底**：上游未给 usage 时按已累积文本估算 output_tokens。

### 2.4 服务器层（`src/server.js`）

- Fastify 5，`bodyLimit` 64MB（容纳 base64 图片）
- 流式路径使用 `reply.hijack()` 接管原始 socket，直接写 SSE 帧（`event:` + `data:` + 空行），有 `flush` 即刷新，保证低延迟逐 token 输出
- 上游不可达 → 502 `api_error`；上游 4xx/5xx → 按状态映射 Anthropic 错误类型（401/403→`authentication_error`、404→`not_found_error`、429→`rate_limit_error`）
- 请求校验失败（缺 `max_tokens`、空 `messages`、非法 role）在调用上游**之前**返回 400
- **上游不活动超时**（`--timeout`，默认 600s）：`AbortController` 计时器在每收到上游字节时重置；后端无响应或流停滞超过阈值即中止请求并返回 504 `api_error`
- **客户端断连（流式）**：请求的 `close` 事件触发 `controller.abort()` 加 `reader.cancel()`，立即停止无人监听的上游生成并释放连接；socket `error` 事件被吞掉，死客户端永远不会拖垮进程
- **错误形状保证**：所有非流式的映射/解析异常（非法 JSON body → 502、缺 choices → 502 `api_error`、映射错误）都被捕获并以 Anthropic 错误格式返回——Fastify 默认错误格式永远不会泄漏给客户端
- 仅当后端确实省略 `usage` 时，才序列化请求消息用于兜底估算（避免每次响应都全量重序列化）

### 2.5 配置（`src/config.js`）

三级优先：CLI 参数 > 环境变量 > 默认值。详见 README 配置表。端口与超时值在启动时校验；非法值以 exit code 2 退出，而不是稍后以令人困惑的错误崩溃。

## 3. 测试策略

| 文件 | 覆盖 |
|---|---|
| `test/mappers.test.js` | 请求映射全路径：system 合并/提升、文本/图片/文档块、tool_result 展开与顺序、assistant tool_use、thinking 丢弃、工具过滤、uri format 剥离、tool_choice 四种形态、模型路由、采样参数、输入校验、响应映射与 usage 兜底 |
| `test/stream.test.js` | SSEParser 分块断行/注释/CRLF/多行 data；翻译器：文本流事件序列、工具流增量、并行工具索引、三类交错、thinking 块与签名、usage 捕获、空流、中途 error、幂等性、畸形 JSON 容错 |
| `test/integration.test.js` | 真实 HTTP 端到端：假 OpenAI 上游 + 真代理，验证转发 payload 结构、Authorization 头、流式/非流式响应、错误转换、count_tokens、health |
| `test/config.test.js` | 三级配置优先级、默认值、参数解析 |

运行：`npm test`（Node ≥ 18 内置 test runner，无额外依赖）。

## 4. 扩展指南

- **新增 Anthropic 块类型**：在 `convertMessage` 中处理请求侧；在 `AnthropicStreamTranslator.handleChunk` 中处理流式侧（记得在块切换状态机中登记新类型）
- **对接新后端**：只要暴露 OpenAI 兼容 `/chat/completions` 即可直接 `--base-url` 接入；若后端对未知字段严格，设 `DISABLE_STREAM_USAGE=1` 与 `DISABLE_TOP_K=1`
- **精确 token 计数**：`count_tokens` 当前为估算，可替换为 tiktoken/wasm 分词器

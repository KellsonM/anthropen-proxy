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

**tool_choice**：`auto→auto`、`none→none`、`any→required`、`{type:'tool',name}→{type:'function',function:{name}}`。若强制指定的工具不在转发的工具列表中（例如被 `filterTools` 丢弃），该 `tool_choice` 会被丢弃并通过 `warn` 诊断上报，而不是原样转发——后端不会收到悬空引用，客户端的工具循环也能从日志中得到明确原因而非静默死锁。

**模型路由**：`thinking.type === 'enabled'` → `models.reasoning`，否则 `models.completion`。

**流式 usage**：stream 时附加 `stream_options:{include_usage:true}`，让后端在末尾 chunk 返回真实 token 数（可用 `DISABLE_STREAM_USAGE=1` 关闭以兼容严格后端）。

### 2.2 非流式响应映射（`openaiToAnthropic`）

- `choices[0].message.content` → `{type:'text', text, citations:null}` 块
- `reasoning` / `reasoning_content` → 前置的 `{type:'thinking', thinking, signature:''}` 块（保持非流式路径与流式路径一致）
- `tool_calls[]` → `{type:'tool_use', id, name, input}` 块（arguments JSON 解析失败时降级为 `{}`，不中断响应；失败会通过 `warn` 回调上报，供 debug 日志记录）
- `finish_reason` → `stop_reason`：`stop→end_turn`、`length→max_tokens`、`tool_calls→tool_use`、`content_filter→end_turn`
- `stop_sequence`：尽力回填——当 `finish_reason === 'stop'` 且返回文本以请求的某个 `stop_sequences` 结尾时，上报该串。OpenAI 兼容后端通常会把命中的停止串从文本中剥离，因此仅在后端保留它时才触发；绝不会上报错误值
- `id`：`chatcmpl-xxx → msg_xxx`；缺失时随机生成
- `usage`：`prompt_tokens→input_tokens`、`completion_tokens→output_tokens`；缺失时输入侧使用请求侧估算值（`estimateRequestTokens`：剔除 base64 数据、图片按每张固定 1600 token 计），输出侧按响应文本估算（CJK 约 1 字/token、其余约 4 字符/token）
- 缺失 `choices` → 抛出 **502 `api_error`**（上游问题，而非客户端错误）

### 2.3 流式转换（`src/stream.js`）

**SSEParser**：增量解析上游 SSE。处理任意字节偏移的断行、多行 `data:`、`:` 注释行（OpenRouter keep-alive），以及 SSE 规范允许的全部三种行终止符（`\n`、`\r\n`、裸 `\r`）。事件以空行分帧。采用索引指针扫描，每次 `feed()` 只对残留尾部做一次切片，k 行 / n 字节缓冲的代价为 O(n) 而非 O(k·n)。末尾的孤立 `\r` 会被挂起等待下一个字节（它可能是 `\r\n` 的前半）；`flush()` 在流结束时把它解析为终止符，使裸 `\r` 后端的最后一个事件不会丢失。

**AnthropicStreamTranslator**：把 OpenAI delta 流重组为 Anthropic 事件序列。核心是**块索引状态机**。文本与思考实时流式；**工具调用参数被缓冲**，在流末作为完整块发出：

```
状态: current = {type, index} | null
      nextIndex（下一个可用块索引，从 0 递增）
      pendingTools: Map<openai_tool_index, {id, name, args}>

规则:
- reasoning/reasoning_content → 若当前非 thinking 块：关旧块、开 thinking 块；发 thinking_delta
- content → 若当前非 text 块：关旧块、开 text 块；发 text_delta（并更新输出 token 增量计数与文本尾部）
- tool_calls[i]：
    · 把 id/name/arguments 片段累加进 pendingTools[i]；此刻不发出任何事件
- 关闭 thinking 块时补发 signature_delta（空签名，协议完整性）
- [DONE] / finish_reason → 关闭实时块 → flush pendingTools（每个作为完整 tool_use 块：start + 一条 input_json_delta + stop）→ message_delta(stop_reason, stop_sequence, usage) → message_stop
- 上游 error → 关块 → error 事件
```

为何缓冲：内容块一旦 stop 即**不可变**。若工具调用实时流式后被文本打断，则必须先关闭工具块才能开文本块——之后再恢复工具调用，就意味着对已 stop 的索引发 `input_json_delta`（以及第二次 `content_block_stop`），违反 Anthropic 协议，并可能在严格客户端中损坏参数。缓冲彻底消除了交错问题。代价是工具调用在流末才出现而非逐字增量；由于多数后端本就在文本之后才发工具调用，实际影响很小。

该状态机在所有交错场景下都保持**块不可变不变量**（每个索引恰好 stop 一次，且 stop 之后不再有 delta）：
1. **文本 → 工具 → 文本**：文本作为块 0 实时流式；缓冲的工具在末尾 flush 为块 1
2. **并行工具调用**：OpenAI 的 tool_calls[0]/[1] 按顺序 flush 为 Anthropic 块
3. **工具参数被其他内容打断后恢复**：片段在 `pendingTools` 中合并，恢复的参数绝不会指向已 stop 的索引

**usage**：`message_start` 携带请求侧的输入 token 估算值（对齐真实 API 提前报告输入 token 的行为）。`message_delta` 在后端发送 usage chunk 时报告真实用量；否则回退为输入估算值加上按流式文本增量计算的输出值（全程不存储完整响应文本——只保留 CJK/总数增量计数，以及用于停止串检查的一小段文本尾部）。

### 2.4 服务器层（`src/server.js`）

- Fastify 5，`bodyLimit` 64MB（容纳 base64 图片）
- 流式路径使用 `reply.hijack()` 接管原始 socket，直接写 SSE 帧（`event:` + `data:` + 空行）。Node 的 `ServerResponse` 在 `writeHead` 后即把写入送到 socket，无需显式 flush（`http.ServerResponse` 上根本没有 `flush()`，只有 `flushHeaders()`）
- 上游不可达 → 502 `api_error`；上游 4xx/5xx → 按状态映射 Anthropic 错误类型（401/403→`authentication_error`、404→`not_found_error`、429→`rate_limit_error`）
- **上游空响应体**：204（或任何无 body 的成功响应）的 `body === null`；对流式路径而言在 hijack 之后调用 `getReader()` 会抛异常，使客户端在空 SSE 流上永久挂起。代理在 hijack **之前**检查 `upstream.body`，不存在则返回 502 `api_error`
- **200 body 内的上游错误**：部分 OpenAI 兼容后端会在 200 响应体中报错。代理保留后端携带的数值 `status`/`code`（钳制到 4xx/5xx）并映射为对应的 Anthropic 错误类型，而不是一律压平成 500
- 请求校验失败（缺 `max_tokens`、空 `messages`、非法 role）在调用上游**之前**返回 400
- **上游不活动超时**（`--timeout`，默认 600s）：`AbortController` 计时器在每收到上游字节时重置——**流式与非流式路径皆然**（后者正是为此才分块读取响应体）。慢速但持续的响应不会被误杀，只有真正停滞的请求才以 504 `api_error` 中止。每条提前返回路径都会清除计时器，使其永远不会拖住进程退出
- **客户端断连（流式）**：通过**响应流**（`reply.raw`）的 `close` 事件检测，它在 socket 真正终止时触发。刻意不使用请求流的 `close`：`IncomingMessage` 在请求体被读完时即触发该事件（早于 handler 注册监听器），因此永远观察不到流中途断开。真实断连发生时代理立即 abort 上游请求，停止无人监听的上游生成；socket `error` 事件被吞掉，死客户端永远不会拖垮进程
- **背压**：向慢客户端写入返回 `false` 时，读取循环暂停直到 socket `drain`，帧因此节流上游而不是在内存中无界缓冲。若客户端永久卡死，上游字节停止到达，不活动计时器随之中止请求——两种机制自洽地组合在一起
- **错误形状保证**：`setErrorHandler` + `setNotFoundHandler` 把**所有**错误——Fastify 自身的（请求体 JSON 畸形 `FST_ERR_CTP_INVALID_JSON_BODY` → 400 `invalid_request_error`、404、413 `request_too_large`）以及代理的映射/解析异常——都包装为 Anthropic 错误格式。Fastify 默认的 `FST_ERR_*` 格式永远不会泄漏给客户端（严格客户端如 Claude Code 否则会处理失当）
- **可选入站认证**：配置 `inboundKey` 后，`preHandler` 钩子要求每个请求通过 `x-api-key` 或 `Authorization: Bearer` 携带该 key（经 `crypto.timingSafeEqual` 常量时间比较），否则返回 401 `authentication_error`。`/health` 与 `/api/hello` 探测保持开放
- 请求侧 token 估算只在真正需要时计算（后端省略 `usage`，或流式响应开始），且剔除 base64 数据以免图片扭曲估算

### 2.5 配置（`src/config.js`）

三级优先：CLI 参数 > 环境变量 > 默认值。详见 README 配置表。端口与超时值在启动时校验；非法值以 exit code 2 退出，而不是稍后以令人困惑的错误崩溃。需要取值的参数若缺失其值（例如 `--base-url` 后面没跟值），同样以 exit code 2 退出，而不是静默回退到默认值。

### 2.6 优雅停机（`index.js`）

`SIGINT`/`SIGTERM` 触发 `app.close()`：停止接受新连接并让进行中的请求收尾。由于被 hijack 的流式响应不被 Fastify 的空闲计数跟踪，若仍有长流滞留，5 秒上限会强制退出，因此 Ctrl-C 永远不会卡死。

## 3. 测试策略

| 文件 | 覆盖 |
|---|---|
| `test/mappers.test.js` | 请求映射全路径：system 合并/提升、文本/图片/文档块、tool_result 展开/顺序与 `is_error` 上报、assistant tool_use、thinking 丢弃、工具过滤、uri format 剥离、tool_choice 四种形态及悬空引用「丢弃 + warn」、模型路由、采样参数、输入校验、响应映射、`estimateRequestTokens`（base64 剔除、图片固定计费，以及一个等价性测试：断言正则快速路径在混合 CJK/base64/图片/tools 的 payload 上与原深拷贝参考算法逐字节相等） |
| `test/stream.test.js` | SSEParser 分块断行/注释/CRLF/裸 `\r`/多行 data 及流末 `flush()`；翻译器：文本流事件序列、工具流缓冲、并行工具索引、**块不可变不变量**下的各类交错（共享 `assertBlockProtocol` 辅助函数校验每个索引恰好 stop 一次、stop 之后无 delta）、thinking 块与签名、`stop_sequence` 回填、usage 捕获、`message_start`/`message_delta` 的输入 token 估算、空流、中途 error、幂等性、畸形 JSON 容错 |
| `test/integration.test.js` | 真实 HTTP 端到端：假 OpenAI 上游 + 真代理，验证转发 payload 结构、Authorization 头、流式/非流式响应、错误转换、count_tokens（含 base64 图片不按文本计数）、health、**空响应体（204）处理**（两条路径均 502、绝不挂起）、**Fastify 层错误形状**（请求体 JSON 畸形、未知路由 → Anthropic 错误格式）、**入站认证**（无 key 返回 401、带 `x-api-key`/Bearer 返回 200）、`stop_sequence` 回填、**客户端断连取消**（客户端挂断后上游连接立即关闭）、**不活动超时语义**（慢速但持续的下载熬过总超时时长） |
| `test/config.test.js` | 三级配置优先级、默认值、参数解析、`--inbound-key`、缺失值参数拒绝（exit code 2） |

运行：`npm test`（Node ≥ 20 内置 test runner，无额外依赖）。共 133 个测试。

## 4. 扩展指南

- **新增 Anthropic 块类型**：在 `convertMessage` 中处理请求侧；在 `AnthropicStreamTranslator.handleChunk` 中处理流式侧（记得在块切换状态机中登记新类型）
- **对接新后端**：只要暴露 OpenAI 兼容 `/chat/completions` 即可直接 `--base-url` 接入；若后端对未知字段严格，设 `DISABLE_STREAM_USAGE=1` 与 `DISABLE_TOP_K=1`
- **精确 token 计数**：`count_tokens` 当前为估算（`mappers.js` 中的 `estimateRequestTokens`，图片单价常量 `IMAGE_TOKEN_ESTIMATE = 1600`），可替换为 tiktoken/wasm 分词器

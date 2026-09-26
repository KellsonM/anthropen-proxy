# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

## [1.1.0] - 2026-09-26

### Added

- **Optional inbound authentication**: `--inbound-key` / `INBOUND_API_KEY` requires every request to present the key via `x-api-key` or `Authorization: Bearer` (constant-time comparison); `/health` and the `/api/hello` probe stay open.
- **Graceful shutdown** on SIGINT/SIGTERM: stop accepting new connections and let in-flight requests finish, with a 5 s cap so Ctrl-C never hangs.
- **`stop_sequence` backfill** in streaming and non-streaming responses (best-effort: reported when the returned text ends with a requested stop sequence).

### Fixed

- **Streaming protocol violation on interleaved tool calls (critical)**: tool-call argument fragments are now buffered and flushed as complete `tool_use` blocks at stream end. Previously, a tool call interrupted by text and then resumed emitted `input_json_delta` (and a second `content_block_stop`) against an already-stopped block index — illegal per the Anthropic protocol, potentially corrupting tool arguments in strict clients.
- **HEAD /api/hello route 404**: registered the `GET /api/hello` probe route (Fastify auto-derives HEAD). Claude Code sends `HEAD /api/hello` as a preflight before its first real request; the 404 made the CLI treat the proxy as unreachable/unauthenticated.
- **Missing `/v1/models` route (404)**: added the model-discovery endpoint returning a single Anthropic-format model entry (`display_name` = configured completion model), so Claude Code's `/model` listing works instead of getting a 404.
- **Upstream 204 / empty body no longer hangs streaming requests**: `upstream.body` is checked before hijacking the reply; a body-less success now returns a 502 `api_error` instead of leaving the client waiting forever on an empty SSE stream.
- **Fastify-layer errors now use the Anthropic error shape**: `setErrorHandler` + `setNotFoundHandler` wrap malformed JSON bodies, 404s, and 413s — the raw `FST_ERR_*` format no longer leaks to clients.
- **Upstream errors inside a 200 body** now preserve the backend's numeric `status`/`code` (mapped to the matching Anthropic error type) instead of flattening everything to 500.
- **SSEParser bare-`\r` support**: the SSE spec's third line terminator is now handled, with an end-of-stream `flush()` so a bare-CR backend's final event is not lost.
- **CLI missing-value flags** (e.g. `--base-url` with no value) now exit with code 2 instead of silently falling back to defaults.
- Removed the dead `raw.flush()` call (no such method exists on `http.ServerResponse`).

### Changed

- `engines` bumped to Node **>= 20** (Fastify 5 and its dependencies require it; `>= 18` was broken on install).
- Streaming no longer stores the full response text — incremental CJK/total counters plus a short tail for the stop-sequence check.

### Performance

Token estimation now uses a hybrid path: a Latin1 probe skips the scan entirely for pure-ASCII payloads (O(1)), while two-byte strings use a manual UTF-16 code-unit loop — replacing the earlier `u`-flag regex, which regressed on CJK-dense text. Results stay byte-identical to the reference algorithm (guarded by an equivalence test). Benchmarked HEAD vs current on Node v22 (Linux), same mock upstream + real proxy processes:

| Metric | HEAD | Current | Δ |
|---|---|---|---|
| estimateTokens — EN 1MB | 10.5 ms | ~0 ms (O(1) skip) | ~∞ |
| estimateTokens — CJK 1MB | 2.11 ms | 0.83 ms | **2.5× faster** |
| estimateTokens — Mixed 1MB | 4.71 ms | 2.59 ms | **1.8× faster** |
| estimateRequestTokens — CJK-heavy 2.8 MB | 9.8 ms | 7.1 ms | **1.4× faster** |
| estimateRequestTokens — ASCII 2.8 MB | 22.6 ms | 9.3 ms | **2.4× faster** |
| Stream translate — 8k×60c | 13.4 ms | 10.4 ms | **1.3× faster** |
| Stream memory (per stream) | O(n) retained | O(1) | **constant** |
| E2E JSON throughput (conc 20) | 368 req/s | 373 req/s | +1% |
| E2E JSON p99 | 117 ms | 97 ms | **−17%** |
| E2E Stream TTFB p99 | 101 ms | 84 ms | **−17%** |

Tests: 116 → **133**, all passing.

## [1.0.0] - 2026-09-26

### Fixed

- **Client disconnect detection (critical)**: mid-stream disconnects are now detected via the response stream's `close` event. The previous request-stream listener never fired (`IncomingMessage` closes as soon as the body is consumed), so cancelled requests kept burning backend compute until completion.
- **Non-streaming timeout semantics**: the response body is now read in chunks with the inactivity timer reset per byte; a slow-but-active download is no longer killed by the total-timeout behavior.
- **`count_tokens` image overcounting**: base64 payloads are stripped and images are charged a fixed 1600 tokens each, instead of counting encoded bytes as text (~340k tokens per 1 MB screenshot, causing premature auto-compaction).
- **`tool_choice` dangling reference**: a forced tool that was filtered out is now dropped with a warning instead of being forwarded.

### Added

- Drain-based backpressure: slow clients now throttle upstream reads instead of buffering frames in memory without bound.
- `tool_result` `is_error` is surfaced as an `[error] ` prefix so models can distinguish failures from normal output.
- Streaming `message_start` carries the request-side input-token estimate; the `message_delta` usage fallback now includes `input_tokens`.
- Startup warning when binding to a non-loopback address (the proxy has no authentication).

### Changed

- `openaiToAnthropic` third parameter is now an options object (`{ inputTokens, warn }`).
- SSEParser scans with an index pointer (O(n) per feed instead of O(k·n)).
- Project renamed `anthropic-proxy` → `anthropen-proxy` (bin command, logs, help, docs). Env vars `ANTHROPIC_PROXY_*` intentionally unchanged.
- Tests: 102 → 116 (client-disconnect cancellation, inactivity-timeout semantics, image token estimation, `is_error` surfacing, tool_choice warnings). All passing.

### Performance

Benchmarked before/after on Node v22 (Linux), same mock upstream + real proxy processes.

| # | Test | Before | After | Verdict |
|---|------|--------|-------|---------|
| A | Streaming throughput (20 concurrent × 300 chunks) | 11.7 MB/s, TTFB p50 124 ms | 13.1 MB/s, TTFB p50 111 ms | Slightly better |
| B | Slow-client memory, 12 MB stream @ 640 KB/s | +100 MB RSS (whole stream buffered) | +54 MB RSS (bounded, GC sawtooth) | Bounded |
| B+ | Slow-client memory, 24 MB stream | +168 MB (scales with stream size) | +57 MB (independent of stream size) | Bounded |
| C | Client-disconnect cancellation (20 s stream) | 20,268 ms — never cancelled, full generation wasted | 6 ms — upstream aborted immediately | Major fix |
| D | Slow non-stream 4 MB / 12.8 s, 3 s timeout | 504 — killed at 3 s despite active transfer | 200 — completed in 12.9 s | Fixed |
| E | Non-stream baseline (50 sequential small requests) | avg 3.92 ms | avg 3.88 ms | No regression |
| F | `count_tokens` with 1.5 MB image | 12.6 ms, estimate 387,569 tokens | 0.24 ms, estimate 14,169 tokens | 52× faster, ~27× more accurate |
| G | SSEParser rewrite (3.2 MB / 20k events) | 2.71 ms | 2.59 ms | Neutral on V8 |

**Overall**: No regressions. Disconnect cancellation, backpressure bounding, and image token estimation are the big wins; the SSE parser rewrite is performance-neutral on V8 (SlicedString already made the old slicing cheap).

---

# 更新日志

## [1.1.0] - 2026-09-26

### 新增

- **可选入站认证**:`--inbound-key` / `INBOUND_API_KEY` 要求每个请求通过 `x-api-key` 或 `Authorization: Bearer` 携带该 key(常量时间比较);`/health` 与 `/api/hello` 探测保持开放。
- **优雅停机**:SIGINT/SIGTERM 触发后停止接受新连接并让进行中的请求收尾,5 秒上限兜底,Ctrl-C 永不卡死。
- **`stop_sequence` 回填**:流式与非流式响应均尽力回填(返回文本以请求的停止串结尾时上报该串)。

### 修复

- **交错工具调用的流式协议违规(严重)**:tool 调用参数片段改为缓冲,在流末作为完整 `tool_use` 块发出。此前工具调用被文本打断后恢复时,会对已 stop 的块索引继续发 `input_json_delta`(并二次 `content_block_stop`),违反 Anthropic 协议,可能使严格客户端的工具参数损坏。
- **HEAD /api/hello 路由 404**:注册 `GET /api/hello` 探测路由(Fastify 自动派生 HEAD)。Claude Code 在首个真实请求前会先发 `HEAD /api/hello` 预检,404 会让 CLI 把代理判定为不可达/未认证。
- **`/v1/models` 路由缺失 404**:新增模型发现端点,返回单条 Anthropic 格式的模型记录(`display_name` 为配置的 completion 模型),Claude Code 的 `/model` 列表不再 404。
- **上游 204 / 空响应体不再挂起流式请求**:在 hijack 响应之前检查 `upstream.body`,无 body 的成功响应现返回 502 `api_error`,不再让客户端在空 SSE 流上无限等待。
- **Fastify 层错误改用 Anthropic 错误格式**:`setErrorHandler` + `setNotFoundHandler` 把畸形 JSON 请求体、404、413 全部包装,原始 `FST_ERR_*` 格式不再泄漏给客户端。
- **200 响应体内的上游错误**现保留后端携带的数值 `status`/`code`(映射为对应 Anthropic 错误类型),不再一律压平成 500。
- **SSEParser 支持裸 `\r`**:实现 SSE 规范的第三种行终止符,并新增流末 `flush()`,裸 `\r` 后端的最后一个事件不再丢失。
- **CLI 缺值参数**(如 `--base-url` 后未跟值)现以 exit code 2 报错退出,不再静默回退默认值。
- 删除 `raw.flush()` 死代码(`http.ServerResponse` 上不存在该方法)。

### 变更

- `engines` 提升至 Node **>= 20**(Fastify 5 及其依赖要求;`>= 18` 安装即坏)。
- 流式不再存储完整响应文本——改为 CJK/总数增量计数 + 一小段用于停止串检查的文本尾部。

### 性能

Token 估算改为混合路径:Latin1 探测让纯 ASCII 负载直接跳过扫描(O(1)),双字节串走手写 UTF-16 码元循环——替换了此前在 CJK 密集文本上出现回归的 `u` flag 正则。结果与参考算法逐字节一致(有等价性测试守护)。在 Node v22(Linux)上对 HEAD 与当前版做基准测试,同一 mock 上游 + 真实代理进程:

| 指标 | HEAD | 当前版 | 变化 |
|---|---|---|---|
| estimateTokens — 英文 1MB | 10.5 ms | ~0 ms(O(1) 跳过) | ~∞ |
| estimateTokens — 中文 1MB | 2.11 ms | 0.83 ms | **提速 2.5×** |
| estimateTokens — 混合 1MB | 4.71 ms | 2.59 ms | **提速 1.8×** |
| estimateRequestTokens — 中文重 2.8MB | 9.8 ms | 7.1 ms | **提速 1.4×** |
| estimateRequestTokens — 纯 ASCII 2.8MB | 22.6 ms | 9.3 ms | **提速 2.4×** |
| 流式翻译 — 8k×60c | 13.4 ms | 10.4 ms | **提速 1.3×** |
| 流式内存(每流) | O(n) 驻留 | O(1) | **恒定** |
| 端到端 JSON 吞吐(并发 20) | 368 req/s | 373 req/s | +1% |
| 端到端 JSON p99 | 117 ms | 97 ms | **−17%** |
| 端到端流式 TTFB p99 | 101 ms | 84 ms | **−17%** |

测试:116 → **133**,全部通过。

## [1.0.0] - 2026-09-26

### 修复

- **客户端断连检测(严重)**:改用响应流的 `close` 事件检测流中途断连。原请求流监听器因 `IncomingMessage` 在请求体读完时即关闭而永远不触发,导致用户取消后后端仍在空烧算力。
- **非流式超时语义**:响应体改为分块读取、每收到字节重置不活动计时器,慢速但持续的下载不再被总超时误杀。
- **`count_tokens` 图片虚高**:剔除 base64 数据、图片按每张固定 1600 token 计,不再把编码字节当文本(1MB 截图曾虚高约 34 万 token,触发过早上下文压缩)。
- **`tool_choice` 悬空引用**:强制指定的工具若已被过滤,现丢弃并告警,不再原样转发。

### 新增

- drain 背压:慢客户端现在节流上游读取,而非在内存中无界缓冲帧。
- `tool_result` 的 `is_error` 以 `[error] ` 前缀上报,模型可区分报错与正常输出。
- 流式 `message_start` 携带请求侧输入 token 估算;`message_delta` 用量兜底补上 `input_tokens`。
- 绑定非回环地址启动时输出无鉴权警告。

### 变更

- `openaiToAnthropic` 第三参数改为选项对象(`{ inputTokens, warn }`)。
- SSEParser 改索引指针扫描(每次 feed 从 O(k·n) 降为 O(n))。
- 项目更名 `anthropic-proxy` → `anthropen-proxy`(bin 命令、日志、帮助、文档);环境变量 `ANTHROPIC_PROXY_*` 有意保持不变。
- 测试 102 → 116(断连取消、不活动超时语义、图片 token 估算、`is_error` 上报、tool_choice 告警),全部通过。

### 性能

在 Node v22(Linux)上对修改前后做基准测试,同一 mock 上游 + 真实代理进程。

| # | 测试项 | 修改前 | 修改后 | 结论 |
|---|--------|--------|--------|------|
| A | 流式吞吐(20 并发 × 300 chunk) | 11.7 MB/s,TTFB p50 124 ms | 13.1 MB/s,TTFB p50 111 ms | 略有提升 |
| B | 慢客户端内存,12 MB 流 @ 640 KB/s | +100 MB RSS(整条流缓冲) | +54 MB RSS(有界,GC 锯齿) | 内存有界 |
| B+ | 慢客户端内存,24 MB 流 | +168 MB(随流大小线性膨胀) | +57 MB(与流大小无关) | 内存有界 |
| C | 客户端断连取消(20 秒流) | 20,268 ms——从未取消,白跑完整生成 | 6 ms——立即中止上游 | 关键修复 |
| D | 非流式慢响应 4 MB / 12.8 s,3 秒超时 | 504——传输活跃仍被 3 秒误杀 | 200——12.9 秒正常完成 | 已修复 |
| E | 非流式基线(50 次串行小请求) | 平均 3.92 ms | 平均 3.88 ms | 无回归 |
| F | `count_tokens` 含 1.5 MB 图片 | 12.6 ms,估算 387,569 tokens | 0.24 ms,估算 14,169 tokens | 快 52×,准确 ~27× |
| G | SSEParser 重写(3.2 MB / 2 万事件) | 2.71 ms | 2.59 ms | V8 上中性 |

**总体**:无任何回归。断连取消、背压内存控制、带图 token 估算是三大核心收益;SSEParser 重写因 V8 的 SlicedString 机制本就让旧写法开销很低,实测为中性改动。

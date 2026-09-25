# Changelog

All notable changes to this project are documented in this file.
Format follows [Keep a Changelog](https://keepachangelog.com/).

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

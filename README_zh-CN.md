# anthropic-proxy

把 **Anthropic Messages API**（Claude Code 等客户端使用的前端协议）转换为 **OpenAI Chat Completions API**（本地大模型后端）的中间转换层。

前端无需任何改动：Claude Code / Anthropic SDK 照常调用 `POST /v1/messages`；后端可以是任何 OpenAI 兼容服务（Ollama、vLLM、llama.cpp server、LM Studio，或 OpenRouter 等云端 API）。

## 功能特性

- **完整协议转换**：system 消息、多模态内容（文本/图片）、工具调用（tool_use / tool_result）、stop_sequences、采样参数等
- **流式 SSE 转换**：OpenAI chunk 流 → Anthropic 事件流（`message_start` / `content_block_*` / `message_delta` / `message_stop`），正确处理文本、思考（thinking）、工具调用的块索引切换与交错
- **思考模型路由**：请求带 `thinking` 时自动切换到 reasoning 模型，`reasoning` / `reasoning_content` 增量映射为 Anthropic `thinking_delta`
- **错误转换**：上游错误映射为 Anthropic 标准错误格式（`authentication_error` / `rate_limit_error` / `api_error` 等）
- **辅助端点**：`/v1/messages/count_tokens`（估算 token）、`/health`
- **102 个自动化测试**：单元测试 + 端到端集成测试（`npm test`）

## 安装

```bash
npm install
```

要求 Node.js ≥ 18（推荐 20+）。

## 快速开始

### 1. 启动本地模型（任选其一）

```bash
# Ollama（默认对接 http://localhost:11434/v1）
ollama serve

# vLLM
vllm serve Qwen/Qwen2.5-Coder-7B-Instruct --port 8000

# llama.cpp server
llama-server -m model.gguf --port 8080
```

### 2. 启动代理

```bash
# 默认：Ollama + qwen2.5-coder:7b
node index.js

# 指定后端与模型
node index.js --base-url http://localhost:8000/v1 --model Qwen/Qwen2.5-Coder-7B-Instruct

# 带 API key（如对接 OpenRouter）
OPENROUTER_API_KEY=sk-or-xxx node index.js --base-url https://openrouter.ai/api/v1
```

### 3. 让 Claude Code 走代理

```bash
ANTHROPIC_BASE_URL=http://127.0.0.1:3000 \
ANTHROPIC_API_KEY=any-non-empty-string \
claude
```

> Claude Code 要求 API key 非空，但代理是否校验取决于后端；本地后端通常可填任意值。

## 配置项

命令行参数优先于环境变量，环境变量优先于默认值。

| 参数 | 环境变量 | 默认值 | 说明 |
|---|---|---|---|
| `--host` | `HOST` | `127.0.0.1` | 监听地址 |
| `--port` | `PORT` | `3000` | 监听端口 |
| `--base-url` | `ANTHROPIC_PROXY_BASE_URL` | `http://localhost:11434/v1` | OpenAI 兼容后端 base URL（不含 `/chat/completions`） |
| `--api-key` | `OPENROUTER_API_KEY` / `ANTHROPIC_PROXY_API_KEY` | 无 | 后端 Bearer key，不设置则不发送 Authorization 头 |
| `--model` | `COMPLETION_MODEL` / `MODEL` | `qwen2.5-coder:7b` | 普通请求使用的模型 |
| `--reasoning-model` | `REASONING_MODEL` | 同 `--model` | 请求带 `thinking` 时使用的模型 |
| `--filter-tools` | `FILTER_TOOLS` | `BatchTool` | 逗号分隔，转发前丢弃的工具名 |
| — | `DISABLE_STREAM_USAGE=1` | 关 | 不发送 `stream_options.include_usage`（兼容严格后端） |
| `--bypass-app-detail-message` | `BYPASS_APP_DETAIL_MESSAGE=1` | 关 | 转换时丢弃 `messages` 数组中 `role: "system"` 且 content 包含 `<application_details>` 的单条消息，其余消息不受影响 |
| `--timeout <秒>` | `UPSTREAM_TIMEOUT` | `600` | 上游不活动超时：后端超过该秒数无任何字节返回（未响应或流停滞）即中止并返回 504 |
| `--no-top-k` | `DISABLE_TOP_K=1` | 关 | 不转发 `top_k`（严格 OpenAI 兼容后端会对未知字段返回 400） |
| `--debug` | `DEBUG=1` | 关 | 打印转换后的 payload / 日志 |
| `--help` | — | — | 帮助 |

## 验证

```bash
# 健康检查
curl http://127.0.0.1:3000/health

# 非流式
curl -s http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N http://127.0.0.1:3000/v1/messages \
  -H 'content-type: application/json' \
  -d '{"model":"claude-sonnet-4-5","max_tokens":64,"stream":true,"messages":[{"role":"user","content":"你好"}]}'

# token 计数
curl -s http://127.0.0.1:3000/v1/messages/count_tokens \
  -H 'content-type: application/json' \
  -d '{"max_tokens":64,"messages":[{"role":"user","content":"hello world"}]}'
```

## 运行测试

```bash
npm test
```

覆盖：请求映射（system 合并、消息角色转换、工具/工具结果、采样参数、模型路由、校验）、SSE 解析（分块断行、注释、CRLF）、流式块索引管理（文本/思考/工具交错）、错误转换、端到端集成（真实 HTTP + 假上游）。

## 已知限制

- 本地模型对 Anthropic 级工具调用质量取决于模型本身；建议用 Qwen2.5-Coder、DeepSeek-Coder 等强函数调用模型
- `document`（PDF）内容块以占位符 `[document: ...]` 代替（OpenAI 协议无对应能力）
- 思考块的 `signature` 为空字符串（本地模型无签名能力，不影响 Claude Code 显示）
- token 计数为估算值（CJK 约 1 字/token、其余约 4 字符/token），非精确分词
- 流式下 tool 调用参数被其他内容（如 reasoning）打断后恢复时，会复用原块索引继续发 delta；严格遵循「块 stop 后不可重开」的客户端可能报错，多数实际客户端可容忍（详见 TECHNICAL_zh-CN.md §2.3）

详细协议映射规则见 [TECHNICAL_zh-CN.md](./TECHNICAL_zh-CN.md)。

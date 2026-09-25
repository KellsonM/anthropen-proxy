// Pure mapping functions between the Anthropic Messages API and the
// OpenAI Chat Completions API. No I/O here so everything is unit-testable.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Anthropic allows `content` to be a plain string or an array of content
// blocks. Return the concatenated text of a string / text blocks, or null.
export function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
    return parts.length > 0 ? parts.join('') : null
  }
  return null
}

// Anthropic `system` may be a string or an array of text blocks (with
// optional cache_control, which we ignore). OpenAI accepts a single system
// message, so everything is merged into one.
export function normalizeSystem(system) {
  if (!system) return null
  if (typeof system === 'string') return system.length > 0 ? system : null
  if (Array.isArray(system)) {
    const merged = system
      .map((b) => (typeof b === 'string' ? b : b?.text ?? ''))
      .filter((s) => s.length > 0)
      .join('\n\n')
    return merged.length > 0 ? merged : null
  }
  return null
}

// Some OpenAI-compatible backends reject JSON-schema string fields with
// `format: "uri"` (a common source of tool-call failures with local
// models). Strip them recursively from tool parameter schemas.
export function removeUriFormat(schema) {
  if (!schema || typeof schema !== 'object') return schema
  if (Array.isArray(schema)) return schema.map((item) => removeUriFormat(item))
  if (schema.type === 'string' && schema.format === 'uri') {
    const { format, ...rest } = schema
    return rest
  }
  const result = {}
  for (const [key, value] of Object.entries(schema)) {
    result[key] = removeUriFormat(value)
  }
  return result
}

// Anthropic tool_result content can be a string or an array of blocks.
// OpenAI `tool` messages only take a string, so flatten text blocks and
// replace images/documents with a placeholder (local chat models cannot
// consume images inside tool results).
export function normalizeToolResultContent(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = []
    for (const block of content) {
      if (!block) continue
      if (block.type === 'text') parts.push(block.text ?? '')
      else if (block.type === 'image') parts.push(`[image: ${block.source?.media_type ?? 'unknown'}]`)
      else if (block.type === 'document') parts.push(`[document: ${block.source?.media_type ?? 'unknown'}]`)
      else if (typeof block.text === 'string') parts.push(block.text)
    }
    return parts.join('\n')
  }
  return String(content)
}

// Anthropic image block -> OpenAI image_url part (data URL).
export function imageBlockToOpenAI(block) {
  const src = block.source ?? {}
  if (src.type === 'base64' && src.data) {
    return {
      type: 'image_url',
      image_url: { url: `data:${src.media_type ?? 'image/png'};base64,${src.data}` },
    }
  }
  if (src.type === 'url' && src.url) {
    return { type: 'image_url', image_url: { url: src.url } }
  }
  return null
}

function parseToolArguments(raw, warn) {
  if (raw == null || raw === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    warn?.('tool_call has malformed JSON arguments; degrading to empty input')
    return {}
  }
}

// ---------------------------------------------------------------------------
// Request mapping: Anthropic /v1/messages -> OpenAI /v1/chat/completions
// ---------------------------------------------------------------------------

export function mapToolChoice(toolChoice) {
  if (!toolChoice) return undefined
  if (typeof toolChoice === 'string') {
    // Legacy form: "auto" | "any" | "none"
    if (toolChoice === 'any') return 'required'
    return toolChoice
  }
  switch (toolChoice.type) {
    case 'auto':
      return 'auto'
    case 'none':
      return 'none'
    case 'any':
      return 'required'
    case 'tool':
      if (!toolChoice.name) {
        throw badRequest('tool_choice of type "tool" requires a `name`')
      }
      return { type: 'function', function: { name: toolChoice.name } }
    default:
      return undefined
  }
}

// Convert one Anthropic conversation message into zero or more OpenAI
// messages. A user message containing tool_result blocks expands into
// `tool` messages (which must precede any following user text), plus an
// optional user message for the remaining text/image blocks.
export function convertMessage(msg) {
  const out = []

  if (msg.role === 'system') {
    const text = extractText(msg.content)
    if (text) out.push({ role: 'system', content: text })
    return out
  }

  if (msg.role === 'assistant') {
    const openaiMsg = { role: 'assistant' }
    const text = extractText(msg.content)
    const toolUses = Array.isArray(msg.content)
      ? msg.content.filter((b) => b && b.type === 'tool_use')
      : []

    // thinking / redacted_thinking blocks are dropped: OpenAI has no place
    // for them in a replayed assistant message.
    if (text) openaiMsg.content = text
    if (toolUses.length > 0) {
      openaiMsg.tool_calls = toolUses.map((t) => ({
        id: t.id,
        type: 'function',
        function: {
          name: t.name,
          arguments: JSON.stringify(t.input ?? {}),
        },
      }))
    }
    if (openaiMsg.content || openaiMsg.tool_calls) out.push(openaiMsg)
    return out
  }

  // role === 'user'
  if (typeof msg.content === 'string') {
    out.push({ role: 'user', content: msg.content })
    return out
  }

  if (Array.isArray(msg.content)) {
    const toolResults = msg.content.filter((b) => b && b.type === 'tool_result')
    const parts = []
    for (const block of msg.content) {
      if (!block) continue
      if (block.type === 'text') {
        if (block.text) parts.push({ type: 'text', text: block.text })
      } else if (block.type === 'image') {
        const img = imageBlockToOpenAI(block)
        if (img) parts.push(img)
      } else if (block.type === 'document') {
        // Local chat models cannot ingest PDFs through the OpenAI schema;
        // surface a placeholder so the model knows a document was present.
        const text = extractText(block.source?.text)
        parts.push({ type: 'text', text: text ?? `[document: ${block.source?.media_type ?? 'unknown'}]` })
      }
    }
    // tool_result blocks become `tool` messages first, preserving order.
    for (const tr of toolResults) {
      let content = normalizeToolResultContent(tr.content)
      // Anthropic marks failed tools with `is_error`; OpenAI's `tool` role has
      // no equivalent flag, so surface it in the text or the model cannot
      // tell a traceback from a normal result.
      if (tr.is_error) content = `[error] ${content}`
      out.push({
        role: 'tool',
        tool_call_id: tr.tool_use_id,
        content,
      })
    }
    if (parts.length > 0) {
      // Plain-text-only messages collapse to a string for maximum backend
      // compatibility; anything richer (images) stays as content parts.
      const onlyText = parts.every((p) => p.type === 'text')
      out.push({
        role: 'user',
        content: onlyText ? parts.map((p) => p.text).join('') : parts,
      })
    }
  }
  return out
}

export function convertTools(tools, { filterToolNames = [] } = {}) {
  if (!Array.isArray(tools)) return []
  // Set lookup keeps filtering O(1) per tool instead of O(k) with includes().
  const filtered = new Set(filterToolNames)
  return tools
    .filter((t) => t && !filtered.has(t.name))
    .map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description ?? '',
        parameters: removeUriFormat(t.input_schema ?? { type: 'object', properties: {} }),
      },
    }))
}

// Main entry: build the OpenAI chat-completions payload.
// `models` = { completion, reasoning } — the reasoning model is selected
// when the Anthropic request enables extended thinking.
export function anthropicToOpenAI(payload, { models, filterToolNames = [], includeStreamUsage = true, bypassAppDetailMessage = false, includeTopK = true, warn } = {}) {
  if (!payload || typeof payload !== 'object') {
    throw badRequest('Request body must be a JSON object')
  }
  if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
    throw badRequest('`messages` is required and must be a non-empty array')
  }
  if (!Number.isInteger(payload.max_tokens)) {
    throw badRequest('`max_tokens` is required and must be an integer')
  }

  const messages = []
  const systemText = normalizeSystem(payload.system)
  if (systemText) messages.push({ role: 'system', content: systemText })

  // System-role messages found inside the conversation are hoisted so that
  // every system message precedes the user/assistant turns (OpenAI
  // requirement for backends that only honor a leading system message).
  const hoistedSystem = []
  for (const msg of payload.messages) {
    if (!msg || (msg.role !== 'user' && msg.role !== 'assistant' && msg.role !== 'system')) {
      throw badRequest(`Unsupported message role: ${msg?.role}`)
    }
    // When bypass is enabled, a system message inside `messages` whose text
    // contains <application_details> is dropped entirely; every other
    // message is converted untouched.
    if (
      bypassAppDetailMessage &&
      msg.role === 'system' &&
      (extractText(msg.content) ?? '').includes('<application_details>')
    ) {
      continue
    }
    const converted = convertMessage(msg)
    for (const m of converted) {
      if (m.role === 'system') hoistedSystem.push(m)
      else messages.push(m)
    }
  }
  if (hoistedSystem.length > 0) {
    let insertAt = 0
    while (insertAt < messages.length && messages[insertAt].role === 'system') insertAt++
    messages.splice(insertAt, 0, ...hoistedSystem)
  }

  const useReasoning =
    payload.thinking && (payload.thinking.type === 'enabled' || payload.thinking.type === 'auto')
  const model = useReasoning ? models.reasoning : models.completion

  const openaiPayload = {
    model,
    messages,
    max_tokens: payload.max_tokens,
    stream: payload.stream === true,
  }
  if (payload.temperature !== undefined) openaiPayload.temperature = payload.temperature
  if (payload.top_p !== undefined) openaiPayload.top_p = payload.top_p
  // top_k is not part of the OpenAI spec but is supported by llama.cpp /
  // vLLM / Ollama servers. Strict OpenAI-compatible servers reject unknown
  // fields with 400, so forwarding is gated by `includeTopK`
  // (--no-top-k / DISABLE_TOP_K=1).
  if (includeTopK && payload.top_k !== undefined) openaiPayload.top_k = payload.top_k
  if (Array.isArray(payload.stop_sequences) && payload.stop_sequences.length > 0) {
    openaiPayload.stop = payload.stop_sequences
  }

  const tools = convertTools(payload.tools, { filterToolNames })
  if (tools.length > 0) openaiPayload.tools = tools
  const toolChoice = mapToolChoice(payload.tool_choice)
  if (toolChoice !== undefined) {
    // A forced tool that was filtered out would make the backend reject the
    // request (or deadlock the client's tool loop); drop the choice and
    // surface why instead of failing silently. Checked even when no tools
    // survive filtering, since that is the worst case.
    if (
      toolChoice.type === 'function' &&
      !tools.some((t) => t.function.name === toolChoice.function.name)
    ) {
      warn?.(
        `tool_choice references "${toolChoice.function.name}" which is not in the forwarded tool list (filtered out?); dropping tool_choice`,
      )
    } else if (tools.length > 0) {
      openaiPayload.tool_choice = toolChoice
    }
  }

  if (openaiPayload.stream && includeStreamUsage) {
    // Ask the backend to emit a final usage-only chunk (supported by
    // OpenAI, vLLM, Ollama >= 0.4, llama.cpp; disable via env for
    // strict servers that reject unknown fields).
    openaiPayload.stream_options = { include_usage: true }
  }

  return openaiPayload
}

// ---------------------------------------------------------------------------
// Response mapping: OpenAI chat completion -> Anthropic message
// ---------------------------------------------------------------------------

export function mapStopReason(finishReason, sawToolCall = false) {
  switch (finishReason) {
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    case 'stop':
    case 'content_filter':
      return 'end_turn'
    default:
      return sawToolCall ? 'tool_use' : 'end_turn'
  }
}

// `inputTokens` is used only for the token estimate when the backend omits
// usage info (the server passes the request-side estimate lazily).
// `options.warn` receives non-fatal diagnostics (e.g. malformed tool args).
export function openaiToAnthropic(data, model, { inputTokens = 0, warn } = {}) {
  const choice = data?.choices?.[0]
  if (!choice) {
    throw httpError('Upstream response contains no choices', 502, 'api_error')
  }
  const openaiMessage = choice.message ?? {}
  const content = []

  // Reasoning extensions (vLLM/Ollama `reasoning_content`, OpenRouter
  // `reasoning`) become a thinking block, mirroring the streaming path.
  const reasoning = openaiMessage.reasoning ?? openaiMessage.reasoning_content
  if (typeof reasoning === 'string' && reasoning.length > 0) {
    content.push({ type: 'thinking', thinking: reasoning, signature: '' })
  }

  if (typeof openaiMessage.content === 'string' && openaiMessage.content.length > 0) {
    content.push({ type: 'text', text: openaiMessage.content, citations: null })
  }
  for (const tc of openaiMessage.tool_calls ?? []) {
    content.push({
      type: 'tool_use',
      id: tc.id ?? `toolu_${randomId()}`,
      name: tc.function?.name,
      input: parseToolArguments(tc.function?.arguments, warn),
    })
  }

  const rawId = data.id ? String(data.id) : null
  const id = rawId
    ? rawId.startsWith('msg_')
      ? rawId
      : `msg_${rawId.replace(/^chatcmpl-?/, '')}`
    : `msg_${randomId()}`

  const usage = data.usage
    ? {
        input_tokens: data.usage.prompt_tokens ?? 0,
        output_tokens: data.usage.completion_tokens ?? 0,
      }
    : {
        input_tokens: inputTokens,
        output_tokens: estimateTokens(openaiMessage.content ?? ''),
      }

  return {
    id,
    type: 'message',
    role: 'assistant',
    model,
    content,
    stop_reason: mapStopReason(choice.finish_reason, (openaiMessage.tool_calls ?? []).length > 0),
    stop_sequence: null,
    usage,
  }
}

// Rough token estimate used when the backend omits usage and for
// count_tokens. CJK text tokenizes near 1 char/token, so counting it at
// ~4 chars/token would underestimate Chinese input 3-4x and let clients
// overflow the backend context window. CJK code points count as 1 token;
// everything else at ~4 chars/token.
export function estimateTokens(text) {
  if (!text) return 0
  const s = String(text)
  let total = 0
  let cjk = 0
  for (const ch of s) {
    total++
    if (isCJKCodePoint(ch.codePointAt(0))) cjk++
  }
  return Math.max(1, cjk + Math.ceil((total - cjk) / 4))
}

// Anthropic's own published estimate for one image in the context window.
// Used by count_tokens so a base64 screenshot is not counted as ~340k
// tokens of base64 text (which would trigger premature auto-compaction).
export const IMAGE_TOKEN_ESTIMATE = 1600

// Estimate the input tokens of a full Anthropic request: text is estimated
// as usual, but base64 payloads are stripped and images are charged a
// fixed per-image cost instead of their encoded size.
export function estimateRequestTokens(payload) {
  const stripBase64 = (v) => {
    if (Array.isArray(v)) return v.map(stripBase64)
    if (v && typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) {
        if (k === 'data' && typeof val === 'string' && val.length > 64) out[k] = ''
        else out[k] = stripBase64(val)
      }
      return out
    }
    return v
  }
  const countImages = (v) => {
    if (Array.isArray(v)) return v.reduce((n, x) => n + countImages(x), 0)
    if (v && typeof v === 'object') {
      let n = v.type === 'image' ? 1 : 0
      for (const val of Object.values(v)) n += countImages(val)
      return n
    }
    return 0
  }
  const images = countImages(payload?.messages) + countImages(payload?.system)
  const text = JSON.stringify(
    stripBase64({
      system: payload?.system ?? '',
      messages: payload?.messages ?? [],
      tools: payload?.tools ?? [],
    }),
  )
  return estimateTokens(text) + images * IMAGE_TOKEN_ESTIMATE
}

function isCJKCodePoint(c) {
  return (
    (c >= 0x3000 && c <= 0x303f) || // CJK punctuation
    (c >= 0x3040 && c <= 0x30ff) || // hiragana + katakana
    (c >= 0x3400 && c <= 0x4dbf) || // CJK extension A
    (c >= 0x4e00 && c <= 0x9fff) || // CJK unified ideographs
    (c >= 0xac00 && c <= 0xd7af) || // hangul syllables
    (c >= 0xf900 && c <= 0xfaff) || // CJK compatibility ideographs
    (c >= 0x20000 && c <= 0x2fa1f) // CJK extensions B–F
  )
}

export function randomId(len = 24) {
  let s = ''
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  while (s.length < len) s += chars[Math.floor(Math.random() * chars.length)]
  return s
}

// Error helper: an object carrying an HTTP status so the server layer can
// translate it into a proper Anthropic-shaped error response.
export function httpError(message, status = 400, type = 'invalid_request_error') {
  const err = new Error(message)
  err.status = status
  err.errorType = type
  return err
}

export function badRequest(message, status = 400, type = 'invalid_request_error') {
  return httpError(message, status, type)
}

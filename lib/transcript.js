const MAX_TEXT_CHARS = 200_000
const MAX_TITLE_CHARS = 80

export function cleanTitle(value) {
  if (typeof value !== "string") return ""
  const title = value.replace(/[\r\n\t]+/g, " ").trim()
  return title.length > MAX_TITLE_CHARS ? title.slice(0, MAX_TITLE_CHARS) : title
}

function appendCapped(current, extra) {
  if (typeof extra !== "string" || !extra) return current
  if (current.length >= MAX_TEXT_CHARS) return current
  const room = MAX_TEXT_CHARS - current.length
  return current + (extra.length > room ? extra.slice(0, room) : extra)
}

function partsFromBlocks(blocks) {
  const reasoning = []
  const text = []
  if (typeof blocks === "string") return { reasoning: "", text: blocks }
  if (!Array.isArray(blocks)) return { reasoning: "", text: "" }
  for (const block of blocks) {
    if (!block || typeof block !== "object" || typeof block.text !== "string") continue
    if (block.type === "reasoning") reasoning.push(block.text)
    else if (block.type === "text") text.push(block.text)
  }
  return { reasoning: reasoning.join(""), text: text.join("") }
}

function partsFromStream(stream) {
  const reasoning = []
  const text = []
  if (!Array.isArray(stream)) return { reasoning: "", text: "" }
  for (const record of stream) {
    if (!record || typeof record !== "object") continue
    if (record.type === "text-chunks" && Array.isArray(record.texts)) {
      text.push(record.texts.join(""))
    } else if (record.type === "reasoning-chunks" && Array.isArray(record.texts)) {
      reasoning.push(record.texts.join(""))
    } else if (record.type === "chunk" && record.chunk && typeof record.chunk === "object") {
      const chunk = record.chunk
      if (chunk.type === "text-delta" && typeof chunk.text === "string") text.push(chunk.text)
      else if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") reasoning.push(chunk.text)
    }
  }
  return { reasoning: reasoning.join(""), text: text.join("") }
}

export function formatAssistant(reasoning, text, tool) {
  const thought = typeof reasoning === "string" ? reasoning.trim() : ""
  const answer = typeof text === "string" ? text.trim() : ""
  const toolName = typeof tool === "string" ? tool.trim() : ""
  const parts = []
  if (thought) parts.push(`分析过程：\n${thought}`)
  if (answer) parts.push(answer)
  else if (!thought && toolName) parts.push(`正在调用工具：${toolName}`)
  const joined = parts.join("\n\n")
  return joined.length > MAX_TEXT_CHARS ? joined.slice(0, MAX_TEXT_CHARS) : joined
}

function assistantParts(data) {
  const content = data?.message?.content ?? data?.content
  let parts = partsFromBlocks(content)
  if (!parts.text.trim() || !parts.reasoning.trim()) {
    const fromStream = partsFromStream(data?.stream)
    if (!parts.reasoning.trim()) parts = { ...parts, reasoning: fromStream.reasoning }
    if (!parts.text.trim()) parts = { ...parts, text: fromStream.text }
  }
  return parts
}

function messageFromRecord(record) {
  const event = record?.type === "event" ? record.event : record
  if (!event || typeof event !== "object") return null
  if (event.type !== "user/message" && event.type !== "assistant/message") return null
  const seq = typeof event.seq === "number" ? event.seq : 0
  if (event.type === "user/message") {
    const text = partsFromBlocks(event.data?.message?.content ?? event.data?.content).text.trim()
    if (!text) return null
    return { role: "user", text, seq }
  }
  const parts = assistantParts(event.data)
  const text = formatAssistant(parts.reasoning, parts.text, "")
  if (!text) return null
  return { role: "assistant", text, seq }
}

export function messagesFromHistory(page) {
  if (Array.isArray(page?.messages) && page.messages.every((item) => item && typeof item.text === "string")) {
    return page.messages.map((item) => ({ ...item }))
  }
  const records = Array.isArray(page?.records) ? page.records : Array.isArray(page?.events) ? page.events : []
  const messages = []
  for (const record of records) {
    const message = messageFromRecord(record)
    if (message) messages.push(message)
  }
  messages.sort((a, b) => a.seq - b.seq)
  return messages
}

export function isRunning(state, messages) {
  if (state && typeof state === "object") {
    if (state.running === true) return true
    if (Array.isArray(state.queue) && state.queue.some((item) => item && item.placement !== "context")) {
      return true
    }
    if (state.running === false) return false
  }
  const last = messages[messages.length - 1]
  return !last || last.role === "user"
}

function emptyLive() {
  return { reasoning: "", text: "", tool: "" }
}

function absorbChunk(live, chunk) {
  if (!chunk || typeof chunk !== "object") return
  if (chunk.type === "reasoning-delta" && typeof chunk.text === "string") {
    live.reasoning = appendCapped(live.reasoning, chunk.text)
  } else if (chunk.type === "text-delta" && typeof chunk.text === "string") {
    live.text = appendCapped(live.text, chunk.text)
  } else if (chunk.type === "tool-call-delta" && typeof chunk.name === "string" && chunk.name) {
    live.tool = chunk.name
  }
}

function sessionIdOfAgent(payload) {
  const agent = payload?.agent
  const id = agent?.session?.id ?? agent?.id
  return typeof id === "string" ? id : ""
}

export function createLiveStore() {
  const liveBySession = new Map()

  function absorbFrame(sessionId, frame) {
    if (!sessionId || !frame || typeof frame !== "object") return
    if (frame.type === "start") {
      liveBySession.set(sessionId, emptyLive())
      return
    }
    if (frame.type === "end") {
      liveBySession.delete(sessionId)
      return
    }
    if (frame.type !== "chunk") return
    let live = liveBySession.get(sessionId)
    if (!live) {
      live = emptyLive()
      liveBySession.set(sessionId, live)
    }
    absorbChunk(live, frame.chunk)
  }

  return {
    absorbAgent(payload) {
      absorbFrame(sessionIdOfAgent(payload), payload?.frame)
    },
    absorbMux(frame) {
      if (!frame || typeof frame !== "object") return
      const sessionId = typeof frame.sessionId === "string" ? frame.sessionId : ""
      const inner = frame.frame && typeof frame.frame === "object" ? frame.frame : frame
      absorbFrame(sessionId, inner)
    },
    text(sessionId) {
      const live = liveBySession.get(sessionId)
      if (!live) return ""
      return formatAssistant(live.reasoning, live.text, live.tool)
    },
    has(sessionId) {
      return liveBySession.has(sessionId)
    }
  }
}

export async function followMux(api, live, signal) {
  if (typeof api?.events?.mux !== "function") return
  while (!signal.aborted) {
    try {
      const stream = api.events.mux({ payload: {} }, signal)
      if (!stream || typeof stream[Symbol.asyncIterator] !== "function") return
      for await (const frame of stream) {
        live.absorbMux(frame?.payload ?? frame)
      }
    } catch (error) {
      if (signal.aborted) return
      console.warn("[dsh-api] mux follow:", error)
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

export function attachLiveMessage(messages, running, liveText) {
  if (!running || !liveText) return messages
  const last = messages[messages.length - 1]
  if (last && last.role === "assistant" && last.text === liveText) return messages
  const seq = messages.reduce((max, message) => Math.max(max, message.seq || 0), 0) + 1
  messages.push({ role: "assistant", text: liveText, seq, streaming: true })
  return messages
}

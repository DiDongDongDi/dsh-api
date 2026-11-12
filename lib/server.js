import { createServer } from "node:http"
import { randomUUID } from "node:crypto"
import { createRequire } from "node:module"
import { nodeToRequest, writeFetchResponse } from "./http-adapter.js"

const require = createRequire(import.meta.url)

function rpcId(value) {
  try {
    const branded = require("@deepseek-ai/dsh-host-apiproxy").RpcId
    if (typeof branded === "function") return branded(value)
  } catch {
    // DSH 0.2 不再带这个包。旧的 rpc 回退用普通字符串即可。
  }
  return value
}

function useDirect(sessionController, method) {
  return typeof sessionController?.[method] === "function"
}
import {
  attachLiveMessage,
  cleanTitle,
  createLiveStore,
  isRunning,
  messagesFromHistory
} from "./transcript.js"

const BASE = "http://127.0.0.1"

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" })
  res.end(JSON.stringify(body))
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let data = ""
    req.on("data", (chunk) => { data += chunk })
    req.on("end", () => { try { resolve(JSON.parse(data || "{}")) } catch (e) { reject(e) } })
    req.on("error", reject)
  })
}

function authorize(req, token) {
  const header = req.headers.authorization ?? ""
  return header === `Bearer ${token}`
}

function sendRpc(res, response) {
  if (!response || !response.result) {
    return json(res, 200, { ok: false, error: { code: "internal", message: "missing rpc result" } })
  }
  if (!response.result.ok) {
    return json(res, 200, { ok: false, error: response.result.error })
  }
  if (response.result.value === undefined) {
    return json(res, 200, { ok: false, error: { code: "internal", message: "missing rpc result" } })
  }
  return json(res, 200, response.result.value)
}

async function renameSession(api, sessionController, sessionId, title) {
  const request = { rpcId: rpcId(randomUUID()), payload: { sessionId, title } }
  if (typeof api.sessions?.rename === "function") {
    await api.sessions.rename(request)
    return
  }
  if (typeof api.session?.rename === "function") {
    await api.session.rename(request)
    return
  }
  if (typeof sessionController?.rename === "function") {
    await sessionController.rename({ sessionId, title })
  }
}

export function createDshApiServer({ api, fetch, token, port, live, sessionController }) {
  const store = live ?? createLiveStore()
  return createServer(async (req, res) => {
    const url = new URL(req.url, BASE)
    try {
      if (url.pathname === "/health") {
        json(res, 200, { ok: true, dshApi: true })
        return
      }
      if (!authorize(req, token)) {
        json(res, 401, { ok: false, error: { code: "unauthorized", message: "missing or invalid bearer token" } })
        return
      }
      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/(history|prompt|cancel|stream|transcript)$/)
      if (url.pathname === "/api/sessions" && req.method === "GET") {
        if (useDirect(sessionController, "list")) {
          return json(res, 200, await sessionController.list({}, AbortSignal.timeout(20_000)))
        }
        const response = await api.sessions.list({ rpcId: rpcId(randomUUID()), payload: {} })
        return sendRpc(res, response)
      }
      if (url.pathname === "/api/sessions" && req.method === "POST") {
        const body = await readJson(req)
        const title = cleanTitle(body?.title)
        const payload = { ...body }
        delete payload.title
        if (useDirect(sessionController, "create")) {
          const created = await sessionController.create(payload)
          const sessionId = typeof created?.sessionId === "string" ? created.sessionId : ""
          if (title && sessionId && useDirect(sessionController, "rename")) {
            try {
              await sessionController.rename({ sessionId, title })
            } catch (error) {
              console.warn("[dsh-api] rename failed:", error)
            }
          }
          if (!created || typeof created !== "object") {
            return json(res, 200, { ok: false, error: { code: "internal", message: "missing session" } })
          }
          return json(res, 200, created)
        }
        const response = await api.sessions.create({ rpcId: rpcId(randomUUID()), payload })
        const sessionId = response?.result?.ok ? response.result.value?.sessionId : ""
        if (title && typeof sessionId === "string" && sessionId) {
          try {
            await renameSession(api, sessionController, sessionId, title)
          } catch (error) {
            console.warn("[dsh-api] rename failed:", error)
          }
        }
        return sendRpc(res, response)
      }
      if (sessionMatch && req.method === "GET" && sessionMatch[2] === "transcript") {
        const sessionId = sessionMatch[1]
        let page = null
        if (useDirect(sessionController, "events")) {
          page = await sessionController.events({
            address: { kind: "session", sessionId },
            maxMessages: 80
          }, AbortSignal.timeout(20_000))
        } else if (typeof api?.sessions?.history === "function") {
          const response = await api.sessions.history({
            rpcId: rpcId(randomUUID()),
            payload: { sessionId, maxMessages: 80 }
          })
          if (!response?.result?.ok) return sendRpc(res, response)
          page = response.result.value
        }
        let messages = messagesFromHistory(page)
        if (messages.length === 0 && typeof sessionController?.events === "function") {
          const eventsPage = await sessionController.events({
            address: { kind: "session", sessionId },
            maxMessages: 80
          }, AbortSignal.timeout(20_000))
          messages = messagesFromHistory(eventsPage)
        }
        let state = null
        if (typeof sessionController?.state === "function") {
          try {
            state = await sessionController.state({ sessionId }, AbortSignal.timeout(10_000))
          } catch {
            state = null
          }
        }
        const running = isRunning(state, messages) || store.has(sessionId)
        attachLiveMessage(messages, running, store.text(sessionId))
        return json(res, 200, { ok: true, sessionId, running, messages })
      }
      if (sessionMatch && req.method === "GET" && sessionMatch[2] === "history") {
        const response = await api.sessions.history({ rpcId: rpcId(randomUUID()), payload: { ...Object.fromEntries(url.searchParams), sessionId: sessionMatch[1] } })
        return sendRpc(res, response)
      }
      if (sessionMatch && req.method === "POST" && sessionMatch[2] === "prompt") {
        const body = await readJson(req)
        if (useDirect(sessionController, "prompt")) {
          const value = await sessionController.prompt({
            requestId: randomUUID(),
            sessionId: sessionMatch[1],
            mode: body.mode ?? "queue",
            content: Array.isArray(body.content) ? body.content : []
          }, AbortSignal.timeout(30_000))
          return json(res, 200, value ?? { accepted: true })
        }
        const response = await api.sessions.prompt({ rpcId: rpcId(randomUUID()), payload: { sessionId: sessionMatch[1], mode: body.mode ?? "queue", content: body.content } })
        return sendRpc(res, response)
      }
      if (sessionMatch && req.method === "POST" && sessionMatch[2] === "cancel") {
        if (useDirect(sessionController, "cancel")) {
          return json(res, 200, await sessionController.cancel({ sessionId: sessionMatch[1] }))
        }
        const response = await api.sessions.cancel({ rpcId: rpcId(randomUUID()), payload: { sessionId: sessionMatch[1] } })
        return sendRpc(res, response)
      }
      if (sessionMatch && req.method === "GET" && sessionMatch[2] === "stream") {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" })
        const controller = new AbortController()
        req.on("close", () => controller.abort())
        try {
          for await (const frame of api.events.mux({ rpcId: rpcId(randomUUID()), payload: {} }, controller.signal)) {
            if (frame.payload && frame.payload.sessionId === sessionMatch[1]) {
              res.write(`data: ${JSON.stringify(frame.payload)}\n\n`)
            }
          }
        } catch (error) {
          res.write(`data: ${JSON.stringify({ type: "stream/error", error: { code: "internal", message: String(error) } })}\n\n`)
        }
        res.end()
        return
      }
      if (typeof fetch === "function" && (url.pathname.startsWith("/api/") || url.pathname === "/api/events.mux")) {
        await writeFetchResponse(res, await fetch(nodeToRequest(req, BASE)))
        return
      }
      json(res, 404, { ok: false, error: { code: "not-found", message: `unknown route ${url.pathname}` } })
    } catch (error) {
      json(res, 500, { ok: false, error: { code: "internal", message: String(error) } })
    }
  })
}

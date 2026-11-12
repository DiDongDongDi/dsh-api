import { createRequire } from "node:module"
import { mkdirSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { DshApiSettingsSchema, SETTINGS_NAMESPACE_RAW, resolveSettings } from "./config.js"
import { createDshApiServer } from "./server.js"
import { createLiveStore, followMux } from "./transcript.js"

const require = createRequire(import.meta.url)
const PROFILE_DIR = join(homedir(), ".dsh", "profiles", "web")
const TOKEN_FILE = join(PROFILE_DIR, "dsh-api.token")
const SETTINGS_FILE = join(PROFILE_DIR, "settings.yaml")

function optionalRequire(name) {
  try {
    return require(name)
  } catch {
    return null
  }
}

function publishToken(token) {
  if (typeof token !== "string" || token.trim().length < 8) return
  const clean = token.trim()
  try {
    mkdirSync(PROFILE_DIR, { recursive: true })
    writeFileSync(TOKEN_FILE, `${clean}\n`, { encoding: "utf8", mode: 0o600 })
    // 正在跑的 klab 还读这份 yaml。home 级 settings.yaml 会被新版 DSH 迁走，profile 这份不会。
    writeFileSync(SETTINGS_FILE, `dsh-api:\n  token: ${JSON.stringify(clean)}\n`, { encoding: "utf8", mode: 0o600 })
  } catch (error) {
    console.warn("[dsh-api] token file:", error)
  }
}

function loadFetch(api) {
  const proxy = optionalRequire("@deepseek-ai/dsh-host-apiproxy")
  if (typeof proxy?.toFetchHandler !== "function") return null
  try {
    const handler = proxy.toFetchHandler(api)
    return typeof handler?.fetch === "function" ? handler.fetch : null
  } catch (error) {
    console.warn("[dsh-api] fetch proxy:", error)
    return null
  }
}

function attachSettings(ctx, entry, hooks) {
  const settingsApi = optionalRequire("@deepseek-ai/dsh-settings")
  const install = settingsApi?.installSettingsSection
  const namespace = settingsApi?.settingsNamespace
  if (typeof ctx.inject !== "function" || typeof install !== "function" || typeof namespace !== "function") return
  try {
    ctx.inject(["settings"], (sctx) => {
      if (typeof sctx.settings?.register !== "function") return
      install(ctx, namespace(SETTINGS_NAMESPACE_RAW), DshApiSettingsSchema, entry, hooks)
    })
  } catch (error) {
    console.warn("[dsh-api] settings:", error)
  }
}

export const name = "dsh-api"
export const inject = ["apiProxy", "sessionController"]

function optionalService(ctx, serviceName) {
  if (typeof ctx.get !== "function") return null
  try {
    return ctx.get(serviceName)
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const entry = { enabled: config.enabled ?? true, port: config.port ?? 4777, token: config.token }
  const sessionController = optionalService(ctx, "sessionController")
  const live = createLiveStore()
  if (typeof ctx.on === "function") {
    ctx.on("agent/assistant-stream", (payload) => live.absorbAgent(payload), { global: true })
  }

  let server = null
  let muxAbort = null
  let current = () => resolveSettings(entry)

  function stopMux() {
    if (muxAbort) muxAbort.abort()
    muxAbort = null
  }

  function restart() {
    const previous = server
    server = null
    const settings = current()
    if (!settings.enabled) {
      stopMux()
      if (previous) previous.close()
      return
    }

    const start = () => {
      stopMux()
      muxAbort = new AbortController()
      void followMux(ctx.apiProxy, live, muxAbort.signal)
      publishToken(settings.token)
      const next = createDshApiServer({
        api: ctx.apiProxy,
        fetch: loadFetch(ctx.apiProxy),
        token: settings.token,
        port: settings.port,
        live,
        sessionController
      })
      next.on("error", (error) => {
        console.error("[dsh-api] server error:", error)
        if (server === next) server = null
      })
      server = next
      next.listen(settings.port, "127.0.0.1")
    }

    if (previous) {
      previous.close(() => start())
    } else {
      start()
    }
  }

  attachSettings(ctx, entry, {
    setSource: (source) => { current = () => resolveSettings(source()) },
    onChange: restart
  })

  ctx.effect(() => {
    restart()
    return () => {
      stopMux()
      if (server) server.close()
    }
  }, "dsh-api: local http server")
}

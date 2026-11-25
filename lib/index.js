import { createRequire } from "node:module"
import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import {
  DshApiSettingsSchema,
  SETTINGS_NAMESPACE_RAW,
  mergeApiEntry,
  readStoredApiSettings,
  resolveSettings
} from "./config.js"
import { createDshApiServer } from "./server.js"
import { createLiveStore, followMux } from "./transcript.js"

const require = createRequire(import.meta.url)

function profilePaths() {
  const home = (process.env.DSH_HOME || "").trim() || join(homedir(), ".dsh")
  const dir = join(home, "profiles", "web")
  return {
    dir,
    tokenFile: join(dir, "dsh-api.token"),
    settingsFile: join(dir, "settings.yaml")
  }
}

function storedSettings() {
  try {
    return readStoredApiSettings(readFileSync(profilePaths().settingsFile, "utf8"))
  } catch {
    return {}
  }
}

function optionalRequire(name) {
  try {
    return require(name)
  } catch {
    return null
  }
}

function publishToken(token, port) {
  if (typeof token !== "string" || token.trim().length < 8) return
  const clean = token.trim()
  const { dir, tokenFile, settingsFile } = profilePaths()
  const lines = ["dsh-api:", `  token: ${JSON.stringify(clean)}`]
  if (Number.isInteger(port) && port >= 1 && port <= 65535) lines.push(`  port: ${port}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(tokenFile, `${clean}\n`, { encoding: "utf8", mode: 0o600 })
    // klab 读这份 yaml 拿 token，agent 的端口也写在这里。必须写回当前 DSH_HOME，不能写进日常 ~/.dsh。
    writeFileSync(settingsFile, `${lines.join("\n")}\n`, { encoding: "utf8", mode: 0o600 })
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
export const inject = ["sessionController"]

function optionalService(ctx, serviceName) {
  if (typeof ctx.get !== "function") return null
  try {
    return ctx.get(serviceName)
  } catch {
    return null
  }
}

export function apply(ctx, config = {}) {
  const sessionController = ctx.sessionController || optionalService(ctx, "sessionController")
  const live = createLiveStore()
  if (typeof ctx.on === "function") {
    ctx.on("agent/assistant-stream", (payload) => live.absorbAgent(payload), { global: true })
  }

  let server = null
  let muxAbort = null
  let source = () => config
  const current = () => resolveSettings(mergeApiEntry(source(), storedSettings()))

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
      const apiProxy = optionalService(ctx, "apiProxy")
      if (apiProxy) void followMux(apiProxy, live, muxAbort.signal)
      publishToken(settings.token, settings.port)
      const workspaceRegistry =
        optionalService(ctx, "workspaceRegistry") || ctx.workspaceRegistry || null
      const next = createDshApiServer({
        api: apiProxy,
        fetch: apiProxy ? loadFetch(apiProxy) : null,
        token: settings.token,
        port: settings.port,
        live,
        sessionController,
        workspaceRegistry
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

  attachSettings(ctx, mergeApiEntry(config, storedSettings()), {
    setSource: (next) => { source = () => next() },
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

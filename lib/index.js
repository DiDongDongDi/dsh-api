import { installSettingsSection, settingsNamespace } from "@deepseek-ai/dsh-settings"
import { toFetchHandler } from "@deepseek-ai/dsh-host-apiproxy"
import { DshApiSettingsSchema, SETTINGS_NAMESPACE_RAW, resolveSettings } from "./config.js"
import { createDshApiServer } from "./server.js"
import { createLiveStore, followMux } from "./transcript.js"

export const name = "dsh-api"
export const inject = ["apiProxy", "sessionController"]

const SETTINGS_NAMESPACE = settingsNamespace(SETTINGS_NAMESPACE_RAW)

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
      const next = createDshApiServer({
        api: ctx.apiProxy,
        fetch: toFetchHandler(ctx.apiProxy).fetch,
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

  installSettingsSection(ctx, SETTINGS_NAMESPACE, DshApiSettingsSchema, entry, {
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

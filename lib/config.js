import z from "@deepseek-ai/schemastery"
import { randomUUID } from "node:crypto"

export const DEFAULT_PORT = 4777
export const SETTINGS_NAMESPACE_RAW = "dsh-api"

export const DshApiSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  port: z.number().step(1).min(1).max(65535).default(DEFAULT_PORT),
  token: z.string().min(8).role("secret")
})

const generatedToken = randomUUID().replaceAll("-", "")

export function resolveSettings(entry = {}) {
  return {
    enabled: entry.enabled ?? true,
    port: entry.port ?? DEFAULT_PORT,
    token: entry.token && entry.token.length >= 8 ? entry.token : generatedToken
  }
}

function parseTokenScalar(raw) {
  if (!raw) return ""
  if (raw.startsWith('"')) {
    try {
      const parsed = JSON.parse(raw)
      return typeof parsed === "string" ? parsed : ""
    } catch {
      return ""
    }
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) {
    return raw.slice(1, -1).replace(/''/g, "'")
  }
  return raw
}

/** 读 klab 写在 profile settings.yaml 里的 dsh-api 段。Cordis 没给端口时靠它。 */
export function readStoredApiSettings(text) {
  if (typeof text !== "string") return {}
  const block = text.match(/^dsh-api:[ \t]*\r?\n((?:[ \t].*(?:\r?\n|$))*)/m)
  const body = block ? block[1] : ""
  const result = {}
  const portLine = body.match(/^[ \t]*port:[ \t]*([0-9]+)[ \t]*$/m)
  if (portLine) {
    const port = Number(portLine[1])
    if (port >= 1 && port <= 65535) result.port = port
  }
  const tokenLine = body.match(/^[ \t]*token:[ \t]*(.*?)[ \t]*$/m)
  if (tokenLine) {
    const token = parseTokenScalar(tokenLine[1].trim())
    if (token.length >= 8) result.token = token
  }
  return result
}

/** Cordis 显式配置优先，缺的字段用 settings.yaml。端口缺省留给 resolveSettings。 */
export function mergeApiEntry(config = {}, stored = {}) {
  const configuredToken = typeof config.token === "string" && config.token.length >= 8 ? config.token : ""
  return {
    enabled: config.enabled ?? stored.enabled,
    port: config.port ?? stored.port,
    token: configuredToken || stored.token
  }
}

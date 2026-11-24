import assert from "node:assert/strict"
import test from "node:test"
import {
  DshApiSettingsSchema,
  DEFAULT_PORT,
  mergeApiEntry,
  readStoredApiSettings,
  resolveSettings,
  SETTINGS_NAMESPACE_RAW
} from "../lib/config.js"

test("defaults port to 4777 and enabled to true", () => {
  const resolved = resolveSettings({})
  assert.equal(resolved.enabled, true)
  assert.equal(resolved.port, DEFAULT_PORT)
  assert.equal(typeof resolved.token, "string")
  assert.ok(resolved.token.length >= 16)
})

test("schema accepts a valid section and rejects a bad port", () => {
  assert.equal(SETTINGS_NAMESPACE_RAW, "dsh-api")
  const value = DshApiSettingsSchema({ enabled: false, port: 5000, token: "0123456789abcdef" })
  assert.equal(value.port, 5000)
  assert.throws(() => DshApiSettingsSchema({ port: 0 }))
  assert.throws(() => DshApiSettingsSchema({ port: 65536 }))
})

test("entry token wins over the generated fallback", () => {
  const resolved = resolveSettings({ enabled: true, port: 4777, token: "entry-token-123" })
  assert.equal(resolved.token, "entry-token-123")
})

test("settings file supplies the port and token when cordis omits them", () => {
  const stored = readStoredApiSettings('dsh-api:\n  token: "agent-token-4781"\n  port: 4781\n')
  assert.deepEqual(stored, { token: "agent-token-4781", port: 4781 })
  const merged = resolveSettings(mergeApiEntry({}, stored))
  assert.equal(merged.port, 4781)
  assert.equal(merged.token, "agent-token-4781")
})

test("single quoted token and an explicit cordis port both parse", () => {
  const stored = readStoredApiSettings("dsh-api:\n  token: 'agent-token-1234'\n  port: 4781\n")
  assert.equal(stored.token, "agent-token-1234")
  const merged = mergeApiEntry({ port: 4900 }, stored)
  assert.equal(merged.port, 4900)
  assert.equal(merged.token, "agent-token-1234")
})

test("a bad settings port is ignored", () => {
  assert.deepEqual(readStoredApiSettings("dsh-api:\n  port: 0\n  token: short\n"), {})
})

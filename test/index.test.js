import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { connect, createServer as createNetServer } from "node:net"
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { apply, name, inject } from "../lib/index.js"

function makeCtx(apiProxy) {
  const effects = []
  return {
    ctx: {
      apiProxy,
      inject(services, callback) {
        if (services.includes("settings")) return
      },
      effect(run) {
        effects.push(run)
        return () => {}
      }
    },
    effects
  }
}

test("host plugin declares the official name and sessionController injection", () => {
  assert.equal(name, "dsh-api")
  assert.deepEqual(inject, ["sessionController"])
})

function digest(path) {
  if (!existsSync(path)) return null
  return createHash("sha256").update(readFileSync(path)).digest("hex")
}

function withHome(home, run) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const finish = () => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
  return Promise.resolve()
    .then(run)
    .finally(finish)
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = createNetServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

function waitForPort(port) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const attempt = () => {
      const client = connect(port, "127.0.0.1")
      client.once("connect", () => {
        client.end()
        resolve()
      })
      client.once("error", () => {
        client.destroy()
        if (Date.now() - started > 2000) reject(new Error(`port ${port} did not open`))
        else setTimeout(attempt, 20)
      })
    }
    attempt()
  })
}

test("apply with enabled=false installs the lifecycle effect and starts no server", async () => {
  const { ctx, effects } = makeCtx({ sessions: {}, events: {} })
  apply(ctx, { enabled: false, port: 0, token: "test-token-123456" })
  assert.equal(effects.length, 1)
  const dispose = await effects[0]()
  assert.equal(typeof dispose, "function")
})

test("apply with enabled=true runs the effect, returns a disposer, and disposing does not throw", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-api-home-"))
  try {
    await withHome(home, async () => {
      const { ctx, effects } = makeCtx({ sessions: {}, events: {} })
      apply(ctx, { enabled: true, port: 0, token: "test-token-123456" })
      assert.equal(effects.length, 1)
      const dispose = await effects[0]()
      await new Promise((resolve) => setTimeout(resolve, 150))
      assert.equal(typeof dispose, "function")
      assert.doesNotThrow(() => dispose())
    })
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
})

test("an agent home listens on the port written in its settings file", async () => {
  const home = mkdtempSync(join(tmpdir(), "dsh-api-agent-"))
  const profile = join(home, "profiles", "web")
  mkdirSync(profile, { recursive: true })
  const port = await freePort()
  const token = "agent-token-4781"
  writeFileSync(join(profile, "settings.yaml"), `dsh-api:\n  token: ${JSON.stringify(token)}\n  port: ${port}\n`)
  const dailySettings = join(homedir(), ".dsh", "profiles", "web", "settings.yaml")
  const dailyToken = join(homedir(), ".dsh", "profiles", "web", "dsh-api.token")
  const beforeSettings = digest(dailySettings)
  const beforeToken = digest(dailyToken)
  let dispose = () => {}
  try {
    await withHome(home, async () => {
      const { ctx, effects } = makeCtx(null)
      apply(ctx, {})
      dispose = await effects[0]()
      await waitForPort(port)
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      assert.equal(response.status, 200)
      const saved = readFileSync(join(profile, "settings.yaml"), "utf8")
      assert.match(saved, new RegExp(`port: ${port}\\b`))
      assert.match(saved, new RegExp(token))
    })
    assert.equal(digest(dailySettings), beforeSettings)
    assert.equal(digest(dailyToken), beforeToken)
  } finally {
    dispose()
    rmSync(home, { recursive: true, force: true })
  }
})

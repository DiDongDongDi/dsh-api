import assert from "node:assert/strict"
import test from "node:test"
import { createLiveStore, formatAssistant, messagesFromHistory } from "../lib/transcript.js"

test("formats reasoning, answer, and the current tool", () => {
  assert.equal(formatAssistant("先看日志", "是下游超时", ""), "分析过程：\n先看日志\n\n是下游超时")
  assert.equal(formatAssistant("", "", "read"), "正在调用工具：read")
})

test("reads user and assistant events from a history page", () => {
  const messages = messagesFromHistory({
    records: [
      {
        type: "event",
        event: {
          type: "assistant/message",
          seq: 2,
          data: { message: { content: [{ type: "text", text: "答完了" }] } }
        }
      },
      {
        type: "event",
        event: {
          type: "user/message",
          seq: 1,
          data: { message: { content: [{ type: "text", text: "问题" }] } }
        }
      }
    ]
  })
  assert.deepEqual(messages.map((item) => item.text), ["问题", "答完了"])
})

test("live store keeps partial text until the turn ends", () => {
  const live = createLiveStore()
  live.absorbAgent({
    agent: { session: { id: "s1" } },
    frame: { type: "chunk", chunk: { type: "reasoning-delta", text: "思考" } }
  })
  assert.match(live.text("s1"), /思考/)
  live.absorbMux({ sessionId: "s1", type: "end" })
  assert.equal(live.has("s1"), false)
})

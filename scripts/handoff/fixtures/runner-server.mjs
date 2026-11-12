// Deterministic integration fixture; it never calls a model or external service.
import { createInterface } from "node:readline"
import { appendFileSync, writeFileSync } from "node:fs"
import { spawnSync } from "node:child_process"

let threadNumber = 0
let turnNumber = 0
let pendingCheckpoint
const notify = (method, params) =>
  process.stdout.write(JSON.stringify({ method, params }) + "\n")
const reply = (id, result) =>
  process.stdout.write(JSON.stringify({ id, result }) + "\n")

for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line)
  const { id, method, params } = request
  appendFileSync("protocol.jsonl", JSON.stringify({ method, params }) + "\n")
  if (method === "initialized") continue
  if (method === "initialize") {
    reply(id, {})
    continue
  }
  if (method === "model/list") {
    reply(id, {
      data: [
        {
          model: "fixture-model",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
      ],
      nextCursor: null,
    })
    continue
  }
  if (method === "account/rateLimits/read") {
    reply(id, { rateLimits: { primary: { usedPercent: 20 } } })
    continue
  }
  if (method === "thread/start") {
    reply(id, { thread: { id: `thread-${++threadNumber}` } })
    continue
  }
  if (method === "thread/unsubscribe") {
    reply(id, { status: "unsubscribed" })
    continue
  }
  if (method === "thread/read") {
    reply(id, { thread: { status: { type: "idle" }, turns: [] } })
    continue
  }
  if (method === "thread/backgroundTerminals/list") {
    reply(id, { data: [] })
    continue
  }
  if (method === "turn/steer") {
    reply(id, {})
    pendingCheckpoint()
    pendingCheckpoint = undefined
    continue
  }
  if (method === "command/exec") {
    const result = spawnSync(params.command[0], params.command.slice(1), {
      cwd: params.cwd,
      encoding: "utf8",
      timeout: params.timeoutMs,
    })
    reply(id, {
      exitCode: result.status ?? 1,
      stdout: result.stdout,
      stderr: result.stderr,
    })
    continue
  }
  if (method === "turn/start") {
    const turnId = `turn-${++turnNumber}`
    const threadId = params.threadId
    const text = params.input[0].text
    const context = JSON.parse(text.slice(text.indexOf('{\n  "goal"')))
    const taskId = context.task.id
    const checkpoint = turnNumber === 1
    const finish = () => {
      if (!checkpoint)
        writeFileSync(
          `${taskId}.txt`,
          taskId === "first" ? "first done\n" : "second done\n"
        )
      const decision = {
        taskId,
        decision: checkpoint ? "continue" : "task-complete",
        summary: "Fixture phase complete",
        blocker: "",
        memory: {
          goalUnderstanding: context.goal,
          constraints: context.constraints,
          decisions: ["Keep the exact newline"],
          verified: [],
          failedApproaches: [],
          openQuestions: [],
          nextAction: "Complete this task",
        },
      }
      notify("item/completed", {
        threadId,
        turnId,
        item: {
          type: "agentMessage",
          phase: "final_answer",
          text: JSON.stringify(decision),
        },
      })
      notify("turn/completed", {
        threadId,
        turn: { id: turnId, status: "completed", items: [] },
      })
    }
    reply(id, { turn: { id: turnId } })
    notify("turn/started", { threadId, turn: { id: turnId } })
    if (checkpoint) pendingCheckpoint = finish
    notify("thread/tokenUsage/updated", {
      threadId,
      turnId,
      tokenUsage: {
        last: { totalTokens: checkpoint ? 205_000 : 20 },
        total: { totalTokens: 900000 },
        modelContextWindow: 256_000,
      },
    })
    if (!checkpoint) finish()
    continue
  }
  if (method === "turn/interrupt") {
    reply(id, {})
    continue
  }
  process.stdout.write(
    JSON.stringify({
      id,
      error: { code: -32601, message: "Unknown fixture method" },
    }) + "\n"
  )
}

import test from "node:test"
import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { validatePlan, initialState, planHash } from "./contract.mjs"
import { contextUsage, quotaStatus, runPlan, runTurn } from "./runner.mjs"
import { openStore } from "./store.mjs"

const memory = {
  goalUnderstanding: "Preserve the owner goal",
  constraints: ["Local only"],
  decisions: ["Retain the correction"],
  verified: [],
  failedApproaches: [],
  openQuestions: [],
  nextAction: "Continue the current task",
}
const decision = (taskId, kind = "task-complete") => ({
  taskId,
  decision: kind,
  summary: "Bounded progress",
  blocker: "",
  memory,
})
function plan(tasks = ["first"]) {
  return validatePlan({
    version: 1,
    workspace: "/tmp/handoff-unit-workspace",
    goal: "Finish two local files",
    constraints: ["Local only"],
    model: "test-model",
    effort: "high",
    tasks: tasks.map((id) => ({
      id,
      instructions: `Finish ${id}`,
      acceptance: ["Content is correct"],
      verify: [["node", "verify.mjs", id]],
    })),
  })
}
function storeFor(p) {
  let state = initialState(p)
  const snapshots = []
  return {
    get state() {
      return state
    },
    snapshots,
    async save(next) {
      state = structuredClone(next)
    },
    async writeHandoff(text) {
      snapshots.push(text)
      return `/tmp/handoff-${snapshots.length}.md`
    },
  }
}
function fakeClient(
  turns,
  {
    verifyCodes = [],
    quota,
    dieAtTurn,
    activeChild = false,
    background = false,
    releaseFailure = false,
  } = {}
) {
  const events = new EventEmitter()
  const calls = []
  let threadCount = 0
  let turnCount = 0
  let waiting
  let closed = false
  const emit = (method, params) =>
    events.emit("notification", { method, params })
  return {
    calls,
    get closed() {
      return closed
    },
    subscribe(fn) {
      events.on("notification", fn)
      return () => events.off("notification", fn)
    },
    async close() {
      closed = true
      emit("runner/error", { message: "closed" })
    },
    async request(method, params) {
      calls.push({ method, params })
      if (method === "model/list")
        return {
          data: [
            {
              model: "test-model",
              supportedReasoningEfforts: [{ reasoningEffort: "high" }],
            },
          ],
        }
      if (method === "account/rateLimits/read")
        return quota ?? { rateLimits: { primary: { usedPercent: 12 } } }
      if (method === "thread/start")
        return { thread: { id: `thread-${++threadCount}` } }
      if (method === "thread/unsubscribe") {
        if (releaseFailure) throw new Error("Unsubscribe failed")
        return { status: "unsubscribed" }
      }
      if (
        method === "turn/interrupt" ||
        method === "thread/backgroundTerminals/clean"
      )
        return {}
      if (method === "thread/backgroundTerminals/list")
        return { data: background && turnCount ? [{}] : [] }
      if (method === "thread/read")
        return {
          thread: {
            status: { type: params.threadId === "child" ? "active" : "idle" },
            turns: [
              {
                id: "background-turn",
                status:
                  params.threadId === "child" ? "inProgress" : "completed",
                items:
                  activeChild && params.threadId !== "child"
                    ? [
                        {
                          type: "collabAgentToolCall",
                          tool: "spawnAgent",
                          receiverThreadIds: ["child"],
                        },
                      ]
                    : [],
              },
            ],
          },
        }
      if (method === "command/exec")
        return { exitCode: verifyCodes.shift() ?? 0, stdout: "", stderr: "" }
      if (method === "turn/steer") {
        waiting?.()
        return {}
      }
      if (method === "turn/start") {
        const index = ++turnCount
        if (dieAtTurn === index) throw new Error("transport disconnected")
        const spec = turns.shift()
        assert.ok(spec, "Unexpected model turn")
        const threadId = params.threadId
        const id = `turn-${index}`
        const finish = () => {
          emit("item/completed", {
            threadId,
            turnId: id,
            item: {
              type: "agentMessage",
              phase: "final_answer",
              text: JSON.stringify(spec.decision),
            },
          })
          emit("turn/completed", {
            threadId,
            turn: { id, status: "completed", items: [] },
          })
        }
        setImmediate(() => {
          emit("turn/started", { threadId, turn: { id } })
          if (spec.waitForSteer)
            waiting = spec.ignoreSteer || spec.compacted ? () => {} : finish
          if (spec.usage !== false)
            emit("thread/tokenUsage/updated", {
              threadId,
              turnId: id,
              tokenUsage: {
                last: { totalTokens: spec.usage ?? 10 },
                total: { totalTokens: 9_900_000 },
                modelContextWindow: Object.hasOwn(spec, "capacity")
                  ? spec.capacity
                  : 256_000,
              },
            })
          if (spec.compacted) {
            emit("item/completed", {
              threadId,
              turnId: id,
              item: { id: "compaction-1", type: "contextCompaction" },
            })
            emit("thread/tokenUsage/updated", {
              threadId,
              turnId: id,
              tokenUsage: {
                last: { totalTokens: 12 },
                modelContextWindow: 256_000,
              },
            })
          }
          if (!spec.waitForSteer || spec.compacted) finish()
        })
        return { turn: { id } }
      }
      throw new Error(`Unexpected method: ${method}`)
    },
  }
}

test("context usage uses latest request and preserves counts when window size is unknown", () => {
  assert.deepEqual(
    contextUsage({
      tokenUsage: {
        last: { totalTokens: 40, cachedInputTokens: 30 },
        total: { totalTokens: 10000 },
        modelContextWindow: 100,
      },
    }),
    { used: 40, capacity: 100, fraction: 0.4 }
  )
  assert.deepEqual(
    contextUsage({
      tokenUsage: { last: { totalTokens: 40 }, modelContextWindow: null },
    }),
    { used: 40, capacity: null, fraction: null }
  )
  assert.equal(
    contextUsage({ tokenUsage: { last: { totalTokens: null } } }),
    null
  )
})

test("quota waits for all exposed limiting windows and does not assume missing data is safe", () => {
  assert.equal(
    quotaStatus({
      rateLimits: {
        primary: { usedPercent: 95, resetsAt: 100 },
        secondary: { usedPercent: 99, resetsAt: 200 },
      },
    }).resetAt,
    200000
  )
  assert.equal(
    quotaStatus({ rateLimits: { primary: { usedPercent: 95 } } }).resetAt,
    null
  )
  assert.throws(() => quotaStatus({ rateLimits: {} }), /unavailable/)
})

test("omitted model and effort inherit Codex context without catalog lookup or overrides", async () => {
  const p = plan()
  delete p.model
  delete p.effort
  const store = storeFor(p)
  const client = fakeClient([{ decision: decision("first") }])
  const result = await runPlan(p, store, {
    createClient: async () => client,
  })
  assert.equal(result.status, "complete")
  assert.equal(
    client.calls.some((call) => call.method === "model/list"),
    false
  )
  for (const method of ["thread/start", "turn/start"]) {
    const params = client.calls.find((call) => call.method === method).params
    assert.equal(Object.hasOwn(params, "model"), false)
    assert.equal(Object.hasOwn(params, "effort"), false)
  }
  assert.match(store.snapshots.at(-1), /inherited from active Codex context/)
})

test("50% and 69% are not renewal boundaries below 205K", async () => {
  for (const [used, capacity] of [
    [128_001, 256_000],
    [176_641, 256_000],
    [204_999, 256_000],
    [204_999, 1_000_000],
  ]) {
    const p = plan()
    const store = storeFor(p)
    const client = fakeClient([
      { decision: decision("first", "continue"), usage: used, capacity },
      { decision: decision("first"), capacity },
    ])
    const result = await runPlan(p, store, { createClient: async () => client })
    assert.equal(result.status, "complete")
    const starts = client.calls.filter((c) => c.method === "turn/start")
    assert.equal(starts[0].params.threadId, starts[1].params.threadId)
    assert.equal(
      client.calls.filter((c) => c.method === "turn/steer").length,
      0
    )
    assert.equal(
      client.calls.filter((c) => c.method === "turn/interrupt").length,
      0
    )
  }
})

test("threshold crossing steers a checkpoint and resumes the same task in a fresh thread before advancing", async () => {
  const p = plan(["first", "second"])
  const store = storeFor(p)
  const client = fakeClient([
    {
      decision: decision("first", "continue"),
      usage: 205_000,
      waitForSteer: true,
    },
    { decision: decision("first") },
    { decision: decision("second") },
  ])
  const result = await runPlan(p, store, { createClient: async () => client })
  assert.equal(result.status, "complete")
  assert.deepEqual(
    result.completed.map((t) => t.id),
    ["first", "second"]
  )
  assert.equal(client.calls.filter((c) => c.method === "turn/steer").length, 1)
  assert.equal(
    client.calls.filter((c) => c.method === "thread/start").length,
    3
  )
  const starts = client.calls.filter((c) => c.method === "turn/start")
  assert.match(starts[1].params.input[0].text, /SAME task/)
  assert.match(starts[1].params.input[0].text, /Retain the correction/)
  assert.notEqual(starts[0].params.threadId, starts[1].params.threadId)
  assert.equal(
    client.calls.some(
      (c) => c.method === "thread/fork" || c.method === "thread/resume"
    ),
    false
  )
  assert.equal(client.closed, true)
  assert.match(store.snapshots[0], /Recursive context-window rule/)
  assert.match(store.snapshots[0], /205,000 tokens/)
  assert.match(store.snapshots[0], /Exact resume prompt/)
  assert.match(starts[1].params.input[0].text, /205,000 tokens/)
  assert.doesNotMatch(
    store.snapshots[0],
    /50%-window|69%|configured .*%-window/
  )
  assert.doesNotMatch(starts[1].params.input[0].text, /50%-window|69%/)
  assert.match(store.snapshots.at(-1), /Supervisor status: complete/)
  assert.match(store.snapshots.at(-1), /authorized queue is complete/)
})

test("205K handoff boundary is inclusive and independent of model window", async () => {
  for (const capacity of [128_000, 256_000, 1_000_000, null]) {
    for (const used of [204_999, 205_000, 240_001]) {
      const shouldRenew = used >= 205_000
      const p = plan()
      const store = storeFor(p)
      const client = fakeClient([
        {
          decision: decision("first", "continue"),
          usage: used,
          capacity,
          waitForSteer: shouldRenew,
        },
        { decision: decision("first"), capacity },
      ])
      const result = await runPlan(p, store, {
        createClient: async () => client,
      })
      assert.equal(result.status, "complete")
      const starts = client.calls.filter((c) => c.method === "turn/start")
      assert.equal(starts.length, 2)
      assert.equal(
        starts[0].params.threadId !== starts[1].params.threadId,
        shouldRenew
      )
      assert.equal(
        client.calls.filter((c) => c.method === "turn/steer").length,
        shouldRenew ? 1 : 0
      )
      assert.equal(
        client.calls.filter((c) => c.method === "turn/interrupt").length,
        0
      )
      assert.equal(result.completed.length, 1)
    }
  }
})

test("independent verification failure holds the task and feeds the failure into a bounded repair turn", async () => {
  const p = plan()
  const store = storeFor(p)
  const client = fakeClient(
    [{ decision: decision("first") }, { decision: decision("first") }],
    { verifyCodes: [1, 0] }
  )
  const result = await runPlan(p, store, { createClient: async () => client })
  assert.equal(result.status, "complete")
  assert.equal(result.completed.length, 1)
  assert.equal(result.totalTurns, 2)
  assert.equal(
    client.calls.filter((c) => c.method === "thread/start").length,
    1
  )
  assert.match(
    client.calls.filter((c) => c.method === "turn/start")[1].params.input[0]
      .text,
    /Independent verification failed/
  )
  const checks = client.calls.filter((c) => c.method === "command/exec")
  assert.equal(checks[0].params.sandboxPolicy.type, "workspaceWrite")
  assert.equal(checks[0].params.sandboxPolicy.networkAccess, false)
})

test("completion and advancement are atomic and a restart skips only verified tasks", async () => {
  const p = plan(["first", "second"])
  const store = storeFor(p)
  const originalSave = store.save
  store.save = async (next) => {
    assert.equal(next.completed.length, next.taskIndex)
    await originalSave(next)
  }
  const first = fakeClient([{ decision: decision("first") }], { dieAtTurn: 2 })
  const interrupted = await runPlan(p, store, {
    createClient: async () => first,
  })
  assert.equal(interrupted.status, "blocked")
  assert.equal(interrupted.taskIndex, 1)
  const resumed = fakeClient([{ decision: decision("second") }])
  const done = await runPlan(p, store, { createClient: async () => resumed })
  assert.equal(done.status, "complete")
  assert.deepEqual(
    done.completed.map((t) => t.id),
    ["first", "second"]
  )
  assert.equal(resumed.calls.filter((c) => c.method === "turn/start").length, 1)
})

test("missing telemetry does not invent a threshold or force a new session", async () => {
  const p = plan()
  const client = fakeClient([
    { decision: decision("first", "continue"), usage: false },
    { decision: decision("first") },
  ])
  const result = await runPlan(p, storeFor(p), {
    createClient: async () => client,
  })
  assert.equal(result.status, "complete")
  const turns = client.calls.filter((c) => c.method === "turn/start")
  assert.equal(turns[0].params.threadId, turns[1].params.threadId)
  assert.equal(client.calls.filter((c) => c.method === "turn/steer").length, 0)
})

test("a 205K completion claim saves the handoff before verification", async () => {
  const p = plan()
  const store = storeFor(p)
  const client = fakeClient([
    { decision: decision("first"), usage: 205_000, waitForSteer: true },
    { decision: decision("first") },
  ])
  const result = await runPlan(p, store, { createClient: async () => client })
  assert.equal(result.status, "complete")
  assert.match(store.snapshots[0], /205,000 tokens/)
  const checkedAt = client.calls.findIndex((c) => c.method === "command/exec")
  assert.equal(
    client.calls.slice(0, checkedAt).filter((c) => c.method === "turn/start")
      .length,
    2
  )
  assert.equal(
    client.calls.filter((c) => c.method === "command/exec").length,
    1
  )
})

test("compaction clears the old checkpoint request and continues the same session", async () => {
  const p = plan()
  const client = fakeClient([
    {
      decision: decision("first", "renew-context"),
      usage: 205_000,
      waitForSteer: true,
      compacted: true,
    },
    { decision: decision("first") },
  ])
  const result = await runPlan(p, storeFor(p), {
    createClient: async () => client,
  })
  assert.equal(result.status, "complete")
  assert.equal(
    client.calls.filter((c) => c.method === "thread/start").length,
    1
  )
  const turns = client.calls.filter((c) => c.method === "turn/start")
  assert.equal(turns[0].params.threadId, turns[1].params.threadId)
  assert.equal(
    client.calls.filter((c) => c.method === "turn/interrupt").length,
    0
  )
})

test("background work and release failures still block without changing context thresholds", async () => {
  for (const options of [
    { activeChild: true },
    { background: true },
    { releaseFailure: true },
  ]) {
    const p = plan(["first", "second"])
    const store = storeFor(p)
    const client = fakeClient(
      [{ decision: decision("first"), usage: 176_641, capacity: null }],
      options
    )
    const result = await runPlan(p, store, { createClient: async () => client })
    assert.equal(result.status, "blocked")
    assert.deepEqual(result.memory, memory)
    assert.equal(result.taskIndex, 0)
    assert.equal(result.completed.length, 0)
    assert.equal(result.taskRenewals, 0)
    assert.equal(
      client.calls.filter((c) => c.method === "thread/start").length,
      1
    )
    assert.equal(
      client.calls.some((c) => c.method === "command/exec"),
      Boolean(options.releaseFailure)
    )
    if (!options.releaseFailure)
      assert.equal(
        client.calls.some(
          (c) => c.method === "thread/backgroundTerminals/clean"
        ),
        true
      )
    assert.match(
      store.snapshots.at(-1),
      /Latest request usage: 176641 tokens; model window is unknown/
    )
    assert.match(store.snapshots.at(-1), /Supervisor status: blocked/)
    assert.equal(client.closed, true)
  }
})

test("ignored 205K checkpoint retains last memory and known usage without renewal", async () => {
  const p = plan(["first", "second"])
  const store = storeFor(p)
  p.limits.checkpointTimeoutMs = 30
  await store.save({ ...store.state, memory })
  const client = fakeClient([
    {
      decision: decision("first"),
      usage: 205_000,
      capacity: null,
      waitForSteer: true,
      ignoreSteer: true,
    },
  ])
  const result = await runPlan(p, store, { createClient: async () => client })
  assert.equal(result.status, "blocked")
  assert.match(result.message, /Checkpoint deadline/)
  assert.deepEqual(result.memory, memory)
  assert.equal(result.taskIndex, 0)
  assert.equal(result.completed.length, 0)
  assert.equal(result.taskRenewals, 0)
  assert.equal(
    client.calls.filter((c) => c.method === "thread/start").length,
    1
  )
  assert.equal(
    client.calls.filter((c) => c.method === "turn/interrupt").length,
    1
  )
  assert.equal(
    client.calls.some((c) => c.method === "command/exec"),
    false
  )
  assert.match(
    store.snapshots[0],
    /Latest request usage: 205000 tokens; model window is unknown/
  )
  assert.equal(client.closed, true)
})

test("wrong-task output and quota blocks cannot advance or execute verification", async () => {
  for (const [client, expected] of [
    [fakeClient([{ decision: decision("different") }]), /task/i],
    [
      fakeClient([], {
        quota: { rateLimits: { primary: { usedPercent: 97 } } },
      }),
      /reset/,
    ],
  ]) {
    const p = plan()
    const result = await runPlan(p, storeFor(p), {
      createClient: async () => client,
    })
    assert.equal(result.status, "blocked")
    assert.equal(result.taskIndex, 0)
    assert.match(result.message, expected)
    assert.equal(
      client.calls.some((c) => c.method === "command/exec"),
      false
    )
  }
})

test("ignored checkpoint request is interrupted and cannot become task completion", async () => {
  const p = plan()
  const store = storeFor(p)
  p.limits.checkpointTimeoutMs = 30
  const client = fakeClient([
    {
      decision: decision("first"),
      usage: 205_000,
      waitForSteer: true,
      ignoreSteer: true,
    },
  ])
  const result = await runPlan(p, store, { createClient: async () => client })
  assert.equal(result.status, "blocked")
  assert.match(result.message, /Checkpoint deadline/)
  assert.equal(result.taskIndex, 0)
  assert.equal(
    client.calls.some((c) => c.method === "turn/interrupt"),
    true
  )
})

test("turn counter bounds repeated continue decisions", async () => {
  const p = plan()
  p.limits.maxTurnsPerTask = 2
  const client = fakeClient([
    { decision: decision("first", "continue") },
    { decision: decision("first", "continue") },
  ])
  const result = await runPlan(p, storeFor(p), {
    createClient: async () => client,
  })
  assert.equal(result.status, "blocked")
  assert.equal(result.totalTurns, 2)
  assert.match(result.message, /turn limit/)
})

test("abort during deferred startup saves recovery memory and closes a late client without generation", async () => {
  const p = plan()
  const store = storeFor(p)
  const controller = new AbortController()
  let ready
  let connected
  const connecting = new Promise((resolve) => {
    connected = resolve
  })
  const client = fakeClient([])
  const running = runPlan(p, store, {
    signal: controller.signal,
    createClient: () =>
      new Promise((resolve) => {
        ready = resolve
        connected()
      }),
  })
  await connecting
  controller.abort()
  const result = await running
  assert.equal(result.status, "paused")
  assert.match(store.snapshots[0], /only the last saved memory/)
  ready(client)
  await new Promise(setImmediate)
  assert.equal(client.closed, true)
  assert.equal(client.calls.length, 0)
})

test("events arriving before start response are replayed only for the returned turn id", async () => {
  let notify
  const client = {
    subscribe(fn) {
      notify = fn
      return () => {}
    },
    async request(method) {
      assert.equal(method, "turn/start")
      for (const id of ["old", "current", "old"]) {
        notify({
          method: "turn/started",
          params: { threadId: "thread", turn: { id } },
        })
        notify({
          method: "item/completed",
          params: {
            threadId: "thread",
            turnId: id,
            item: { type: "agentMessage", text: JSON.stringify(decision(id)) },
          },
        })
        notify({
          method: "turn/completed",
          params: {
            threadId: "thread",
            turn: { id, status: "completed", items: [] },
          },
        })
      }
      return { turn: { id: "current" } }
    },
  }
  const result = await runTurn(client, {
    threadId: "thread",
    prompt: "test",
    plan: plan(),
  })
  assert.equal(result.decision.taskId, "current")
})

test("unfinished background work and failed worker release prevent advancement", async () => {
  for (const options of [
    { activeChild: true },
    { background: true },
    { releaseFailure: true },
  ]) {
    const p = plan(["first", "second"])
    const store = storeFor(p)
    const client = fakeClient([{ decision: decision("first") }], options)
    const result = await runPlan(p, store, { createClient: async () => client })
    assert.equal(result.status, "blocked")
    assert.equal(result.taskIndex, 0)
    assert.equal(
      client.calls.filter((c) => c.method === "thread/start").length,
      1
    )
    if (!options.releaseFailure)
      assert.equal(
        client.calls.some((c) => c.method === "command/exec"),
        false
      )
    assert.match(store.snapshots.at(-1), /Supervisor status: blocked/)
  }
})

test("agent blocker is recorded truthfully in the handoff", async () => {
  const p = plan()
  const store = storeFor(p)
  const d = {
    ...decision("first", "blocked"),
    blocker: "Required owner decision is missing.",
  }
  const result = await runPlan(p, store, {
    createClient: async () => fakeClient([{ decision: d }]),
  })
  assert.equal(result.status, "blocked")
  assert.match(store.snapshots[0], /Supervisor status: blocked/)
  assert.match(store.snapshots[0], /Required owner decision is missing/)
})

test("failed completion persistence cannot advance the in-memory or recovered queue", async () => {
  const p = plan()
  const store = storeFor(p)
  const save = store.save
  let failOnce = true
  store.save = async (next) => {
    if (next.completed.length && failOnce) {
      failOnce = false
      throw new Error("Simulated atomic save failure")
    }
    await save(next)
  }
  const result = await runPlan(p, store, {
    createClient: async () => fakeClient([{ decision: decision("first") }]),
  })
  assert.equal(result.status, "blocked")
  assert.equal(result.taskIndex, 0)
  assert.equal(store.state.completed.length, 0)
  assert.match(store.snapshots.at(-1), /Supervisor status: blocked/)
  const resumed = fakeClient([{ decision: decision("first") }])
  const completed = await runPlan(p, store, {
    createClient: async () => resumed,
  })
  assert.equal(completed.status, "complete")
  assert.equal(
    resumed.calls.filter((call) => call.method === "command/exec").length,
    1
  )
})

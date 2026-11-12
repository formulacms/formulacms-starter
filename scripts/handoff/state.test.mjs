import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import test from "node:test"

import {
  DECISION_SCHEMA,
  initialState,
  loadPlan,
  planHash,
  validateDecision,
  validatePlan,
} from "./contract.mjs"
import { openStore } from "./store.mjs"

function planFixture(workspace, overrides = {}) {
  return {
    version: 1,
    workspace,
    goal: "Finish the bounded handoff task",
    constraints: ["Do not access the network"],
    model: "host/catalog-model",
    effort: "medium",
    tasks: [
      {
        id: "implement-state",
        instructions: "Implement persisted runner state.",
        acceptance: ["State survives restart"],
        verify: [["node", "--test", "scripts/handoff/state.test.mjs"]],
      },
    ],
    ...overrides,
  }
}

function decisionFixture(overrides = {}) {
  return {
    taskId: "implement-state",
    decision: "continue",
    summary: "The persistence boundary is implemented.",
    blocker: "",
    memory: {
      goalUnderstanding: "Persist one supervised run safely.",
      constraints: ["No shell execution"],
      decisions: ["Use exclusive lock files"],
      verified: [],
      failedApproaches: [],
      openQuestions: [],
      nextAction: "Exercise resume behavior.",
    },
    ...overrides,
  }
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "handoff-state-test-"))
  const workspace = path.join(root, "workspace")
  const stateDir = path.join(root, "state")
  await mkdir(workspace, { mode: 0o700 })
  t.after(async () => rm(root, { recursive: true, force: true }))
  return { root, workspace: await realpath(workspace), stateDir }
}

test("validatePlan is strict and supplies only documented defaults", async (t) => {
  const { workspace } = await fixture(t)
  const source = planFixture(workspace)
  const normalized = validatePlan(source)

  assert.notEqual(normalized, source)
  assert.deepEqual(normalized.limits, {
    maxTurnsPerTask: 12,
    maxRenewalsPerTask: 6,
    turnTimeoutMs: 600_000,
    checkpointTimeoutMs: 60_000,
    maxRunMs: 3_600_000,
    verificationTimeoutMs: 120_000,
  })
  assert.equal(
    source.limits,
    undefined,
    "validation must not mutate its source"
  )

  const inherited = validatePlan(
    planFixture(workspace, { model: undefined, effort: undefined })
  )
  assert.equal(Object.hasOwn(inherited, "model"), false)
  assert.equal(Object.hasOwn(inherited, "effort"), false)
  assert.throws(
    () => validatePlan(planFixture(workspace, { model: "", effort: "" })),
    /must not be empty/
  )

  assert.throws(
    () => validatePlan({ ...source, deploy: true }),
    /unknown field: deploy/
  )
  assert.throws(
    () => validatePlan({ ...source, limits: { bypass: true } }),
    /unknown field: bypass/
  )
  assert.throws(
    () =>
      validatePlan({
        ...source,
        tasks: [{ ...source.tasks[0], id: "Bad_id" }],
      }),
    /must match/
  )
  assert.throws(
    () =>
      validatePlan({
        ...source,
        tasks: [source.tasks[0], { ...source.tasks[0] }],
      }),
    /must be unique/
  )
  for (const contextThreshold of [0.5, 0.51]) {
    assert.throws(
      () => validatePlan({ ...source, limits: { contextThreshold } }),
      /unknown field: contextThreshold/
    )
  }
  assert.throws(
    () =>
      validatePlan({
        ...source,
        tasks: [{ ...source.tasks[0], verify: [["node", ""]] }],
      }),
    /must not be empty/
  )
  assert.throws(
    () =>
      validatePlan({
        ...source,
        tasks: [{ ...source.tasks[0], verify: [] }],
      }),
    /at least one argv array/
  )
})

test("loadPlan canonicalizes the workspace and planHash is stable", async (t) => {
  const { root, workspace } = await fixture(t)
  const workspaceLink = path.join(root, "workspace-link")
  const filename = path.join(root, "plan.json")
  await symlink(workspace, workspaceLink)
  await writeFile(filename, JSON.stringify(planFixture(workspaceLink)), {
    mode: 0o600,
  })

  const loaded = await loadPlan(filename)
  assert.equal(loaded.workspace, workspace)

  const reordered = {
    tasks: loaded.tasks.map(({ verify, acceptance, instructions, id }) => ({
      verify,
      acceptance,
      instructions,
      id,
    })),
    effort: loaded.effort,
    model: loaded.model,
    constraints: loaded.constraints,
    goal: loaded.goal,
    workspace: loaded.workspace,
    version: loaded.version,
    limits: Object.fromEntries(Object.entries(loaded.limits).reverse()),
  }
  assert.equal(planHash(loaded), planHash(reordered))
  assert.match(planHash(loaded), /^[a-f0-9]{64}$/)
})

test("validateDecision rejects wrong tasks, unknown fields, and inconsistent blockers", () => {
  assert.equal(DECISION_SCHEMA.additionalProperties, false)
  assert.equal(
    validateDecision(decisionFixture(), "implement-state").decision,
    "continue"
  )
  assert.throws(
    () => validateDecision(decisionFixture(), "different-task"),
    /must match expected task different-task/
  )
  assert.throws(
    () =>
      validateDecision(
        { ...decisionFixture(), extra: true },
        "implement-state"
      ),
    /unknown field: extra/
  )
  assert.throws(
    () =>
      validateDecision(
        decisionFixture({ decision: "blocked", blocker: "" }),
        "implement-state"
      ),
    /blocker must not be empty/
  )
  assert.throws(
    () =>
      validateDecision(
        decisionFixture({ blocker: "unexpected" }),
        "implement-state"
      ),
    /blocker must be empty/
  )
  assert.throws(
    () =>
      validateDecision(
        decisionFixture({
          memory: { ...decisionFixture().memory, surprise: [] },
        }),
        "implement-state"
      ),
    /unknown field: surprise/
  )
})

test("store persists state atomically with private files and immutable handoffs", async (t) => {
  const { workspace, stateDir } = await fixture(t)
  const plan = validatePlan(planFixture(workspace))
  const hash = planHash(plan)
  const start = initialState(plan)
  const store = await openStore({
    stateDir,
    workspace,
    planHash: hash,
    initialState: start,
  })
  t.after(() => store.close())

  const next = { ...store.state, status: "running", totalTurns: 1 }
  await store.save(next)
  const persisted = JSON.parse(
    await readFile(path.join(stateDir, "state.json"), "utf8")
  )
  assert.equal(persisted.status, "running")
  assert.equal(persisted.totalTurns, 1)
  assert.equal((await stat(stateDir)).mode & 0o777, 0o700)
  assert.equal(
    (await stat(path.join(stateDir, "state.json"))).mode & 0o777,
    0o600
  )
  assert.deepEqual(
    (await readdir(stateDir)).filter((name) => name.endsWith(".tmp")),
    [],
    "atomic replacement must not leave temporary files"
  )

  const firstHandoff = await store.writeHandoff("# Snapshot\n")
  const secondHandoff = await store.writeHandoff("# Snapshot\n")
  assert.notEqual(firstHandoff, secondHandoff)
  assert.equal(path.isAbsolute(firstHandoff), true)
  assert.equal((await stat(firstHandoff)).mode & 0o777, 0o600)

  await assert.rejects(
    store.save({
      ...store.state,
      status: "complete",
      taskIndex: 1,
      completed: [{ id: "implement-state", summary: "Unverified", checks: [] }],
    }),
    /checks must be a nonempty array/
  )

  const completed = {
    ...store.state,
    status: "complete",
    taskIndex: 1,
    completed: [
      {
        id: "implement-state",
        summary: "Verified",
        checks: [
          {
            command: ["node", "--test"],
            exitCode: 0,
            verifiedAt: new Date().toISOString(),
          },
        ],
      },
    ],
  }
  await store.save(completed)
  assert.equal(store.state.completed[0].id, "implement-state")
})

test("resume rejects a planHash mismatch before changing persisted state", async (t) => {
  const { workspace, stateDir } = await fixture(t)
  const plan = validatePlan(planFixture(workspace))
  const hash = planHash(plan)
  const store = await openStore({
    stateDir,
    workspace,
    planHash: hash,
    initialState: initialState(plan),
  })
  await store.close()
  const before = await readFile(path.join(stateDir, "state.json"), "utf8")

  await assert.rejects(
    openStore({
      stateDir,
      workspace,
      planHash: "0".repeat(64),
      initialState: initialState(plan),
      resume: true,
    }),
    /planHash mismatch/
  )
  assert.equal(
    await readFile(path.join(stateDir, "state.json"), "utf8"),
    before
  )
})

test("one canonical workspace cannot have two runners across state directories", async (t) => {
  const { root, workspace, stateDir } = await fixture(t)
  const otherStateDir = path.join(root, "other-state")
  const plan = validatePlan(planFixture(workspace))
  const hash = planHash(plan)
  const store = await openStore({
    stateDir,
    workspace,
    planHash: hash,
    initialState: initialState(plan),
  })
  t.after(() => store.close())

  await assert.rejects(
    openStore({
      stateDir: otherStateDir,
      workspace,
      planHash: hash,
      initialState: initialState(plan),
    }),
    /live or unverifiable owner/
  )
})

test("one state directory cannot be reused by an unrelated workspace", async (t) => {
  const { root, workspace, stateDir } = await fixture(t)
  const otherWorkspace = path.join(root, "other-workspace")
  await mkdir(otherWorkspace, { mode: 0o700 })
  const firstPlan = validatePlan(planFixture(workspace))
  const firstStore = await openStore({
    stateDir,
    workspace,
    planHash: planHash(firstPlan),
    initialState: initialState(firstPlan),
  })
  await firstStore.close()

  const secondPlan = validatePlan(planFixture(await realpath(otherWorkspace)))
  await assert.rejects(
    openStore({
      stateDir,
      workspace: secondPlan.workspace,
      planHash: planHash(secondPlan),
      initialState: initialState(secondPlan),
      resume: true,
    }),
    /workspace identity mismatch/
  )
})

test("recoverLock cannot take a live lock", async (t) => {
  const { root, workspace, stateDir } = await fixture(t)
  const plan = validatePlan(planFixture(workspace))
  const hash = planHash(plan)
  const store = await openStore({
    stateDir,
    workspace,
    planHash: hash,
    initialState: initialState(plan),
  })
  t.after(() => store.close())

  await assert.rejects(
    openStore({
      stateDir: path.join(root, "second-state"),
      workspace,
      planHash: hash,
      initialState: initialState(plan),
      recoverLock: true,
    }),
    /live or unverifiable owner/
  )
})

test("a provably dead workspace lock requires explicit recovery", async (t) => {
  const { workspace, stateDir } = await fixture(t)
  const plan = validatePlan(planFixture(workspace))
  const hash = planHash(plan)
  const lockRoot = path.join(os.tmpdir(), "handoff-plus-locks")
  await mkdir(lockRoot, { recursive: true, mode: 0o700 })
  await chmod(lockRoot, 0o700)
  const digest = createHash("sha256").update(workspace).digest("hex")
  const lockFilename = path.join(lockRoot, `${digest}.lock`)
  const deadPid = 2_147_483_647
  await writeFile(
    lockFilename,
    `${JSON.stringify({ kind: "workspace", workspace, pid: deadPid, nonce: "dead-owner" })}\n`,
    { flag: "wx", mode: 0o600 }
  )
  t.after(() => rm(lockFilename, { force: true }))

  await assert.rejects(
    openStore({
      stateDir,
      workspace,
      planHash: hash,
      initialState: initialState(plan),
    }),
    /pass recoverLock: true/
  )

  const recovered = await openStore({
    stateDir,
    workspace,
    planHash: hash,
    initialState: initialState(plan),
    recoverLock: true,
  })
  await recovered.close()
})

test("concurrent explicit recoverers cannot both acquire a stale workspace lock", async (t) => {
  const { root, workspace } = await fixture(t)
  const plan = validatePlan(planFixture(workspace))
  const hash = planHash(plan)
  const lockRoot = path.join(os.tmpdir(), "handoff-plus-locks")
  await mkdir(lockRoot, { recursive: true, mode: 0o700 })
  await chmod(lockRoot, 0o700)
  const digest = createHash("sha256").update(workspace).digest("hex")
  const lockFilename = path.join(lockRoot, `${digest}.lock`)
  await writeFile(
    lockFilename,
    `${JSON.stringify({
      kind: "workspace",
      workspace,
      pid: 2_147_483_647,
      nonce: "dead-race-owner",
    })}\n`,
    { flag: "wx", mode: 0o600 }
  )
  t.after(() => rm(lockFilename, { force: true }))
  t.after(() => rm(`${lockFilename}.recover`, { force: true }))

  const attempts = await Promise.allSettled([
    openStore({
      stateDir: path.join(root, "race-state-a"),
      workspace,
      planHash: hash,
      initialState: initialState(plan),
      recoverLock: true,
    }),
    openStore({
      stateDir: path.join(root, "race-state-b"),
      workspace,
      planHash: hash,
      initialState: initialState(plan),
      recoverLock: true,
    }),
  ])
  const winners = attempts.filter((attempt) => attempt.status === "fulfilled")
  const losers = attempts.filter((attempt) => attempt.status === "rejected")
  assert.equal(winners.length, 1)
  assert.equal(losers.length, 1)
  assert.match(
    losers[0].reason.message,
    /recovery is already|live or unverifiable/
  )
  await winners[0].value.close()
})

test("an ambiguous recovery guard is never removed automatically", async (t) => {
  const { workspace, stateDir } = await fixture(t)
  const plan = validatePlan(planFixture(workspace))
  const lockRoot = path.join(os.tmpdir(), "handoff-plus-locks")
  await mkdir(lockRoot, { recursive: true, mode: 0o700 })
  await chmod(lockRoot, 0o700)
  const digest = createHash("sha256").update(workspace).digest("hex")
  const recoveryFilename = path.join(lockRoot, `${digest}.lock.recover`)
  const contents = `${JSON.stringify({
    kind: "recovery",
    target: path.join(lockRoot, `${digest}.lock`),
    pid: 2_147_483_647,
    nonce: "ambiguous-recovery",
  })}\n`
  await writeFile(recoveryFilename, contents, { flag: "wx", mode: 0o600 })
  t.after(() => rm(recoveryFilename, { force: true }))

  await assert.rejects(
    openStore({
      stateDir,
      workspace,
      planHash: planHash(plan),
      initialState: initialState(plan),
      recoverLock: true,
    }),
    /requires manual cleanup/
  )
  assert.equal(await readFile(recoveryFilename, "utf8"), contents)
})

import { setTimeout as delay } from "node:timers/promises"
import { readFile } from "node:fs/promises"
import path from "node:path"
import { CodexClient } from "./codex-client.mjs"
import { DECISION_SCHEMA, validateDecision } from "./contract.mjs"

const input = (text) => [{ type: "text", text }]
const CONTEXT_HANDOFF = 205_000
const recursiveContextRule =
  "Codex: when sampled used context is >= 205,000 tokens, create a handoff-plus with a successor resume prompt. If compaction happens, continue in the same session. A handoff never by itself starts or authorizes a successor session."

// Deliberately uses the latest request, never cumulative billed token usage.
export function contextUsage(notification) {
  const usage = notification?.tokenUsage
  const used = usage?.last?.totalTokens
  const capacity = usage?.modelContextWindow
  if (!Number.isSafeInteger(used) || used < 0) return null
  const window =
    Number.isSafeInteger(capacity) && capacity > 0 ? capacity : null
  return { used, capacity: window, fraction: window ? used / window : null }
}

export function quotaStatus(response) {
  const buckets = response?.rateLimitsByLimitId
  const snapshots =
    buckets && Object.keys(buckets).length
      ? Object.values(buckets)
      : [response?.rateLimits]
  const windows = snapshots
    .flatMap((s) => [s?.primary, s?.secondary])
    .filter((w) => Number.isFinite(w?.usedPercent))
  if (!windows.length)
    throw new Error(
      "Account usage windows are unavailable; no new turn started."
    )
  const high = windows.filter((w) => w.usedPercent >= 95)
  const reached = snapshots.some((s) => s?.rateLimitReachedType)
  const spendBlocked = snapshots.some(
    (s) =>
      s?.spendControlReached ||
      (s?.rateLimitReachedType &&
        s.rateLimitReachedType !== "rate_limit_reached")
  )
  const resets = high.map((w) => w.resetsAt).filter(Number.isFinite)
  return {
    blocked: high.length > 0 || reached || spendBlocked,
    // Every limiting window must clear. A missing reset is not permission to retry.
    resetAt:
      high.length && resets.length === high.length && !spendBlocked
        ? Math.max(...resets) * 1000
        : null,
    percentages: windows.map((w) => w.usedPercent),
  }
}

async function checkModel(client, plan) {
  if (plan.model === undefined) return
  const cursors = new Set()
  let cursor = null
  for (let page = 0; page < 100; page++) {
    const result = await client.request("model/list", { cursor, limit: 100 })
    if (!Array.isArray(result?.data)) throw new Error("Invalid model catalog.")
    const model = result.data.find((m) => m.model === plan.model)
    if (model) {
      if (
        plan.effort !== undefined &&
        !model.supportedReasoningEfforts?.some(
          (e) => e.reasoningEffort === plan.effort
        )
      ) {
        throw new Error(
          `The selected model does not advertise reasoning effort ${plan.effort}.`
        )
      }
      return
    }
    cursor = result.nextCursor
    if (!cursor) break
    if (cursors.has(cursor)) throw new Error("Model catalog repeated a cursor.")
    cursors.add(cursor)
  }
  throw new Error(`Model ${plan.model} is unavailable; no fallback selected.`)
}

export async function readPackageManager(workspace) {
  const filename = path.join(workspace, "package.json")
  let source
  try {
    source = await readFile(filename, "utf8")
  } catch (error) {
    if (error.code === "ENOENT") return null
    throw new Error(`Cannot read workspace package.json: ${error.message}`, {
      cause: error,
    })
  }
  let manifest
  try {
    manifest = JSON.parse(source)
  } catch (error) {
    throw new Error(
      `Workspace package.json is invalid JSON: ${error.message}`,
      {
        cause: error,
      }
    )
  }
  if (manifest.packageManager === undefined) return null
  const parsed =
    typeof manifest.packageManager === "string"
      ? manifest.packageManager.match(
          /^((?:@[a-zA-Z0-9._-]+\/)?[a-zA-Z0-9._-]+)@(\S{1,160})$/
        )
      : null
  if (!parsed || manifest.packageManager.length > 200) {
    throw new Error(
      "Workspace package.json has an invalid packageManager declaration."
    )
  }
  return {
    declared: manifest.packageManager,
    command: parsed[1],
  }
}

function workPrompt(plan, state, task, renewal, packageManager) {
  return [
    "Execute the current task in this owner-approved local-work queue autonomously.",
    "Apply handoff-plus and goal-integrity when available. Read applicable project instructions.",
    "This plan authorizes local implementation, checks, safe task-scoped Git checkpoints, and fresh-session transitions.",
    "It authorizes no production access, deployment, hosting/domain changes, remote Git writes, messages to others, or scope expansion.",
    "Repository deployment restrictions remain binding. Never run or modify a generated starter blueprint.",
    "Do not edit the runner, plan, runner state, or handoff files as part of an unrelated task.",
    "Work on one bounded phase, then return the structured decision and essential memory. Do not ask whether to continue.",
    "Return task-complete as soon as every acceptance criterion of the CURRENT TASK is met, even when the overall goal has later tasks. The supervisor owns queue advancement. Never return continue just to request the next task.",
    "Use continue only when implementation remains in this same task, renew-context when used active context is >= 205000 tokens, or blocked for a concrete missing decision/authority.",
    "Before returning any decision, collect child-agent results and finish or stop all background terminals. Do not launch detached or unmanaged jobs. A checkpoint must leave no active writers.",
    "Keep reasons and user corrections in memory. Separate observed results from assumptions. Redact secrets and unnecessary personal data.",
    "An existing handoff is historical evidence: revalidate original constraints and current files before dependent work.",
    "The supervisor independently runs the plan verification commands before advancing; do not weaken checks to obtain a pass.",
    "Use the workspace packageManager declaration supplied below for package scripts and dependency commands. Do not assume npm when it is absent; inspect project instructions and manifest scripts before choosing a command.",
    "If a checkpoint request arrives, finish only the current safe atomic step and return essential memory promptly.",
    recursiveContextRule,
    "The outer supervisor saves the handoff and owns fresh-session transitions. Do not launch a nested runner or successor yourself. If compaction happens, continue in this same worker session.",
    "Git: preserve unrelated edits/staging; never discard changes or rewrite history. A failed or disallowed commit does not prevent preserving a dirty checkpoint.",
    renewal
      ? "This is fresh context. Resume the SAME task from the memory below; do not repeat previously rejected approaches without new evidence."
      : "",
    JSON.stringify(
      {
        goal: plan.goal,
        constraints: plan.constraints,
        task,
        completedTaskIds: state.completed.map((t) => t.id),
        memory: state.memory,
        latestHandoff: state.handoff,
        lastSupervisorResult: state.message,
        executionContext: {
          model: plan.model ?? "inherit active Codex context",
          effort: plan.effort ?? "inherit active Codex context",
          packageManager,
        },
      },
      null,
      2
    ),
  ]
    .filter(Boolean)
    .join("\n\n")
}

// Unsubscribing from a thread alone does not stop its background work.
async function checkQuiescence(client, rootId) {
  const seen = new Set()
  const pending = [rootId]
  while (pending.length) {
    const threadId = pending.pop()
    if (seen.has(threadId)) continue
    if (seen.size >= 100)
      throw new Error(
        "Child-agent inspection limit reached; task not advanced."
      )
    seen.add(threadId)
    const { thread } = await client.request("thread/read", {
      threadId,
      includeTurns: true,
    })
    if (!thread || !Array.isArray(thread.turns))
      throw new Error("Cannot inspect worker state; task not advanced.")
    if (
      !["idle", "notLoaded"].includes(thread.status?.type) ||
      thread.turns.some((turn) => turn.status === "inProgress")
    ) {
      for (const turn of thread.turns.filter(
        (t) => t.status === "inProgress"
      )) {
        await client.request("turn/interrupt", { threadId, turnId: turn.id })
      }
      await client.request("thread/backgroundTerminals/clean", { threadId })
      throw new Error(
        "An agent is still active at the checkpoint; interrupted, task not advanced."
      )
    }
    const terminals = await client.request("thread/backgroundTerminals/list", {
      threadId,
      limit: 1,
    })
    if (!Array.isArray(terminals?.data))
      throw new Error("Cannot inspect background terminals; task not advanced.")
    if (terminals.data.length || terminals.nextCursor) {
      await client.request("thread/backgroundTerminals/clean", { threadId })
      throw new Error(
        "Background terminals remained at the checkpoint; stopped, task not advanced."
      )
    }
    for (const turn of thread.turns) {
      for (const item of turn.items ?? []) {
        if (item.type === "collabAgentToolCall" && item.tool === "spawnAgent") {
          pending.push(...(item.receiverThreadIds ?? []))
        }
      }
    }
  }
  return [...seen].reverse()
}

async function releaseThreads(client, ids) {
  for (const threadId of ids) {
    const result = await client.request("thread/unsubscribe", { threadId })
    if (
      !["unsubscribed", "notSubscribed", "notLoaded"].includes(result?.status)
    ) {
      throw new Error(
        "Worker release was not acknowledged; no successor started."
      )
    }
  }
}

async function connectWithSignal(createClient, options, signal) {
  let onAbort
  try {
    const cancelled = new Promise((_, reject) => {
      onAbort = () => reject(new Error("Run interrupted during startup."))
      signal.addEventListener("abort", onAbort, { once: true })
      if (signal.aborted) onAbort()
    })
    const connecting = Promise.resolve()
      .then(() => {
        if (signal.aborted) throw new Error("Run interrupted during startup.")
        return createClient({ ...options, signal })
      })
      .then(async (client) => {
        if (signal.aborted) {
          await client.close()
          throw new Error("Run interrupted during startup.")
        }
        return client
      })
    return await Promise.race([connecting, cancelled])
  } finally {
    signal.removeEventListener("abort", onAbort)
  }
}

function handoffText(
  plan,
  state,
  task,
  decision,
  usage,
  reason,
  packageManager
) {
  return (
    `# Handoff: ${task.id}\n\nCreated: ${new Date().toISOString()}\nWorkspace: ${plan.workspace}\nPlan fingerprint: ${state.planHash}\nSupersedes: ${state.handoff ?? "none"}\n\n` +
    `## Original goal and authority\n\n${plan.goal}\n\n${plan.constraints.map((c) => `- ${c}`).join("\n")}\n\nLocal work only. No production, deployment, remote Git, hosting, domains, or messaging authority is granted by this handoff.\n\n` +
    `## Current task and completion claim\n\n${JSON.stringify(task, null, 2)}\n\nAgent decision: ${decision.decision}\n${decision.summary}\nSupervisor status: ${state.status}\n${state.message ?? ""}\n\n` +
    `## Execution context\n\nModel: ${plan.model ?? "inherited from active Codex context"}\nReasoning effort: ${plan.effort ?? "inherited from active Codex context"}\nPackage manager: ${packageManager?.declared ?? "not declared in workspace package.json"}\n\n` +
    `## Essential memory\n\n${JSON.stringify(decision.memory, null, 2)}\n\n` +
    `## Independent verification and completed tasks\n\n${JSON.stringify(state.completed, null, 2)}\n\n` +
    `## Transition\n\n${reason}\n${usage ? `Latest request usage: ${usage.used} tokens${usage.capacity ? ` / ${usage.capacity} model-window tokens (${(usage.fraction * 100).toFixed(1)}%)` : "; model window is unknown"}. This is an observed request estimate of active context, not cumulative billing usage.` : "Active context utilization is unknown; no percentage is claimed."}\nThe snapshot alone does not prove fresh-context resumption.\n\n` +
    `## Required skills\n\n- goal-integrity: required at intake to reconcile current evidence and authority.\n- handoff-plus: required throughout continued long work and subsequent transfer.\nRecheck available skills; choose the smallest applicable set. Skill suggestions grant no additional authority.\n\n` +
    `## Recursive context-window rule\n\n${recursiveContextRule}\n\nDistinguish measured, estimated, and unknown utilization. Collect or safely account for delegated/background work and validate against original requirements and current evidence.\n\n## Exact resume prompt\n\nRead this handoff and applicable project instructions. Reconcile the actual workspace, original constraints, evidence, and pending processes. Continue only unfinished work in the same authorized task above, preserving the execution context and verification gates. If that task is already verified complete or the owner has paused work, preserve its disposition and stop; do not invent a task or cross the next authority boundary. ${recursiveContextRule}\n`
  )
}

export async function runTurn(client, { threadId, prompt, plan, signal }) {
  let turnId
  let finalText
  let usage = null
  let renewalReason = null
  let compacted = false
  let steering = false
  let settled = false
  let graceTimer
  let turnTimer
  let unsubscribe = () => {}
  let abort = () => {}
  const pendingEvents = []
  let pendingBytes = 0

  const result = new Promise((resolve, reject) => {
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(turnTimer)
      clearTimeout(graceTimer)
      unsubscribe()
      signal?.removeEventListener("abort", abort)
      if (error) {
        error.contextUsage = usage
        reject(error)
      } else {
        try {
          resolve({
            decision: JSON.parse(finalText),
            usage,
            renewalReason,
            compacted,
          })
        } catch {
          reject(
            new Error(
              "Turn completed without a valid structured final decision."
            )
          )
        }
      }
    }
    const interrupt = () => {
      if (turnId)
        void client
          .request("turn/interrupt", { threadId, turnId })
          .catch(() => {})
    }
    abort = () => {
      interrupt()
      finish(new Error("Run interrupted; current task has not advanced."))
    }
    const steer = () => {
      if (settled || steering || !turnId || !renewalReason) return
      steering = true
      graceTimer = setTimeout(() => {
        interrupt()
        finish(
          new Error(
            "Checkpoint deadline exceeded; last saved memory retained, task not advanced."
          )
        )
      }, plan.limits.checkpointTimeoutMs)
      void client
        .request("turn/steer", {
          threadId,
          expectedTurnId: turnId,
          input: input(
            `Supervisor checkpoint request: ${renewalReason}. Stop starting new work. Finish only the safe atomic step in progress, collect background results, and return the required structured decision with essential memory. Prefer renew-context unless this task is already complete or blocked.`
          ),
        })
        .catch((error) => {
          if (!settled) finish(error)
        })
    }
    const accept = ({ method, params }) => {
      if (settled) return
      if (method === "runner/error")
        return finish(new Error(params?.message ?? "Codex process failed."))
      if (params?.threadId !== threadId) return
      if (!turnId) {
        pendingBytes += Buffer.byteLength(JSON.stringify({ method, params }))
        if (pendingEvents.length >= 256 || pendingBytes > 4 * 1024 * 1024)
          return finish(
            new Error("Too many events before turn identity was established.")
          )
        pendingEvents.push({ method, params })
        return
      }
      const eventTurnId = params.turnId ?? params.turn?.id
      if (eventTurnId !== turnId) return
      if (method === "model/rerouted" && plan.model !== undefined)
        return finish(
          new Error(
            "Model was rerouted; automatic model fallback is not authorized."
          )
        )
      if (
        method === "item/completed" &&
        params.item?.type === "contextCompaction"
      ) {
        compacted = true
        usage = null
        renewalReason = null
        steering = false
        clearTimeout(graceTimer)
      }
      if (method === "thread/tokenUsage/updated") {
        usage = contextUsage(params)
        if (usage?.used >= CONTEXT_HANDOFF) {
          renewalReason =
            "Used active context is >= 205000 tokens; create a handoff-plus."
          steer()
        }
      }
      if (
        method === "item/completed" &&
        params.item?.type === "agentMessage" &&
        params.item.phase !== "commentary"
      )
        finalText = params.item.text
      if (method === "turn/completed") {
        if (turnId && params.turn?.id !== turnId) return
        if (params.turn?.status !== "completed")
          return finish(
            new Error(
              `Codex turn ${params.turn?.status ?? "failed"}; task not advanced.`
            )
          )
        for (const item of params.turn.items ?? []) {
          if (item.type === "agentMessage" && item.phase !== "commentary")
            finalText = item.text
        }
        finish()
      }
    }
    unsubscribe = client.subscribe(accept)
    turnTimer = setTimeout(() => {
      interrupt()
      finish(new Error("Turn deadline exceeded; task not advanced."))
    }, plan.limits.turnTimeoutMs)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) {
      abort()
      return
    }
    const turnParams = {
      threadId,
      input: input(prompt),
      outputSchema: DECISION_SCHEMA,
    }
    if (plan.model !== undefined) turnParams.model = plan.model
    if (plan.effort !== undefined) turnParams.effort = plan.effort
    void client
      .request("turn/start", turnParams)
      .then((started) => {
        if (settled) return
        if (!started?.turn?.id) {
          finish(new Error("Codex returned no turn identifier."))
          return
        }
        turnId = started.turn.id
        for (const event of pendingEvents) accept(event)
        pendingEvents.length = 0
        steer()
      })
      .catch(finish)
  })
  return result
}

export async function runPlan(
  plan,
  store,
  {
    createClient = (options) => CodexClient.connect(options),
    command = "codex",
    signal,
    log = () => {},
  } = {}
) {
  let state = store.state
  if (state.status === "complete") return state
  const controller = new AbortController()
  const abort = () => controller.abort()
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) abort()
  const deadline = setTimeout(abort, plan.limits.maxRunMs)
  let client
  let threadId
  let isFresh = true
  let packageManager = null
  let lastUsage = null
  const save = async (patch) => {
    const next = { ...state, ...patch, updatedAt: new Date().toISOString() }
    await store.save(next)
    state = next
  }
  const emit = (event, fields = {}) =>
    log({ event, taskId: plan.tasks[state.taskIndex]?.id, ...fields })
  const closeOnAbort = () => {
    if (client) void client.close()
  }
  controller.signal.addEventListener("abort", closeOnAbort, { once: true })
  try {
    if (controller.signal.aborted)
      throw new Error("Run interrupted before startup.")
    packageManager = await readPackageManager(plan.workspace)
    client = await connectWithSignal(
      createClient,
      { command, cwd: plan.workspace },
      controller.signal
    )
    await checkModel(client, plan)
    await save({ status: "running" })
    while (state.taskIndex < plan.tasks.length) {
      if (controller.signal.aborted) throw new Error("Run interrupted.")
      const task = plan.tasks[state.taskIndex]
      if (state.taskTurns >= plan.limits.maxTurnsPerTask)
        throw new Error(
          "Task turn limit reached; inspect the checkpoint before extending the plan."
        )
      if (state.taskRenewals > plan.limits.maxRenewalsPerTask)
        throw new Error(
          "Task renewal limit reached; no further session started."
        )

      // Re-read live limits after every sleep; elapsed time is never approval.
      for (;;) {
        const quota = quotaStatus(
          await client.request("account/rateLimits/read", {})
        )
        if (!quota.blocked) break
        await save({
          status: "paused",
          message: "Account usage is at its stop boundary.",
        })
        emit("quota-paused", { resetAt: quota.resetAt })
        if (!quota.resetAt)
          throw new Error(
            "Account usage is blocked without a known reset time."
          )
        await delay(
          Math.min(60_000, Math.max(1_000, quota.resetAt - Date.now())),
          undefined,
          { signal: controller.signal }
        )
      }
      if (!threadId) {
        const threadParams = {
          cwd: plan.workspace,
          approvalPolicy: "never",
          sandbox: "workspace-write",
        }
        if (plan.model !== undefined) threadParams.model = plan.model
        const started = await client.request("thread/start", threadParams)
        if (!started?.thread?.id)
          throw new Error("Codex returned no fresh thread identifier.")
        threadId = started.thread.id
        // Fail before generation if this host cannot supervise background work.
        const terminals = await client.request(
          "thread/backgroundTerminals/list",
          { threadId, limit: 1 }
        )
        if (
          !Array.isArray(terminals?.data) ||
          terminals.data.length ||
          terminals.nextCursor
        )
          throw new Error(
            "Fresh worker background state is unavailable or not empty."
          )
        emit("fresh-context-started")
        isFresh = true
      }
      await save({
        status: "running",
        taskTurns: state.taskTurns + 1,
        totalTurns: state.totalTurns + 1,
      })
      const result = await runTurn(client, {
        threadId,
        plan,
        signal: controller.signal,
        prompt: workPrompt(plan, state, task, isFresh, packageManager),
      })
      isFresh = false
      lastUsage = result.usage
      const decision = validateDecision(result.decision, task.id)
      await save({ memory: decision.memory, message: decision.summary })
      const ownedThreads = await checkQuiescence(client, threadId)
      emit("decision", { decision: decision.decision, context: result.usage })

      if (decision.decision === "task-complete" && !result.renewalReason) {
        const checks = []
        for (const argv of task.verify) {
          if (controller.signal.aborted)
            throw new Error("Run interrupted before verification.")
          const checked = await client.request(
            "command/exec",
            {
              command: argv,
              cwd: plan.workspace,
              timeoutMs: plan.limits.verificationTimeoutMs,
              sandboxPolicy: {
                type: "workspaceWrite",
                writableRoots: [plan.workspace],
                networkAccess: false,
              },
            },
            { timeoutMs: plan.limits.verificationTimeoutMs + 10_000 }
          )
          if (!Number.isInteger(checked?.exitCode))
            throw new Error("Verification returned no exit code.")
          // Persist result identity, not raw stdout/stderr that may contain secrets.
          checks.push({
            command: argv,
            exitCode: checked.exitCode,
            verifiedAt: new Date().toISOString(),
          })
          if (checked.exitCode !== 0) break
        }
        if (checks.some((c) => c.exitCode !== 0)) {
          await save({
            message: `Independent verification failed: ${JSON.stringify(checks)}. Fix the same task; its acceptance criteria are unchanged.`,
          })
          emit("verification-failed")
        } else {
          const completed = [
            ...state.completed,
            { id: task.id, summary: decision.summary, checks },
          ]
          const message =
            "Independent verification passed. Task completion accepted."
          await releaseThreads(client, ownedThreads)
          threadId = undefined
          const status =
            state.taskIndex + 1 === plan.tasks.length ? "complete" : "running"
          const handoff = await store.writeHandoff(
            handoffText(
              plan,
              { ...state, status, completed, message },
              task,
              decision,
              result.usage,
              status === "complete"
                ? "Task verified; the authorized queue is complete."
                : "Task verified; next task will start in fresh context.",
              packageManager
            )
          )
          // This atomic save is the advancement boundary. A crash before it re-verifies the same task.
          await save({
            handoff,
            completed,
            message,
            taskIndex: state.taskIndex + 1,
            taskTurns: 0,
            taskRenewals: 0,
            status,
          })
          emit("task-verified", { completedTaskId: task.id })
          continue
        }
      }
      const reason =
        decision.decision === "blocked"
          ? decision.blocker
          : (result.renewalReason ??
            (decision.decision === "renew-context"
              ? "Agent requested a clean context boundary."
              : "Bounded phase checkpoint."))
      const renew = Boolean(result.renewalReason)
      if (decision.decision === "blocked")
        await save({ status: "blocked", message: decision.blocker })
      if (decision.decision === "blocked" || renew) {
        const handoff = await store.writeHandoff(
          handoffText(
            plan,
            state,
            task,
            decision,
            result.usage,
            reason,
            packageManager
          )
        )
        await save({ handoff })
      }
      if (decision.decision === "blocked") {
        break
      }
      if (renew) {
        await save({ taskRenewals: state.taskRenewals + 1 })
        await releaseThreads(client, ownedThreads)
        threadId = undefined
        emit("context-renewal-pending")
      }
    }
    return state
  } catch (error) {
    await save({
      status: controller.signal.aborted ? "paused" : "blocked",
      message: error.message,
    })
    const task = plan.tasks[state.taskIndex]
    if (task) {
      const snapshot = {
        decision: "no-new-agent-decision",
        summary: "Supervisor stopped; only the last saved memory is available.",
        memory: state.memory,
      }
      const handoff = await store.writeHandoff(
        handoffText(
          plan,
          state,
          task,
          snapshot,
          Object.hasOwn(error, "contextUsage") ? error.contextUsage : lastUsage,
          "No successful transfer is claimed. Inspect current files for work performed after the last saved memory before resuming.",
          packageManager
        )
      )
      await save({ handoff })
    }
    emit(state.status, { message: state.message })
    return state
  } finally {
    clearTimeout(deadline)
    signal?.removeEventListener("abort", abort)
    controller.signal.removeEventListener("abort", closeOnAbort)
    if (client) await client.close()
  }
}

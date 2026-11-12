#!/usr/bin/env node
import { resolve } from "node:path"
import { loadPlan, initialState, planHash } from "./contract.mjs"
import { openStore } from "./store.mjs"
import { readPackageManager, runPlan } from "./runner.mjs"

const HELP = `Usage: node scripts/handoff/run.mjs --plan /path/plan.json --state /path/run-state [options]

Run an owner-approved local task queue with automatic verification and fresh context.
The state directory must be outside the target workspace.

  --resume         Resume the same plan from saved state; completed tasks stay completed.
  --recover-lock   Recover a lock only after its recorded owner process has exited.
  --check          Validate the plan and print its fingerprint without starting Codex.
  --codex PATH     Select the installed Codex executable (default: codex).
  --help           Show this help.

Exit codes: 0 complete/valid, 2 blocked, 3 paused/interrupted, 1 setup error.
No background service is installed. Ctrl-C saves the last verified checkpoint.
`

function options(argv) {
  const parsed = {}
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]
    if (["--resume", "--recover-lock", "--check", "--help"].includes(key))
      parsed[key.slice(2)] = true
    else if (["--plan", "--state", "--codex"].includes(key)) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--"))
        throw new Error(`Missing value for ${key}.`)
      if (parsed[key.slice(2)]) throw new Error(`Repeated option ${key}.`)
      parsed[key.slice(2)] = argv[++i]
    } else throw new Error(`Unknown option ${key}.`)
  }
  return parsed
}

let store
try {
  const opts = options(process.argv.slice(2))
  if (opts.help) console.log(HELP)
  else {
    if (!opts.plan) throw new Error("--plan is required.")
    const plan = await loadPlan(resolve(opts.plan))
    if (opts.check) {
      const packageManager = await readPackageManager(plan.workspace)
      console.log(
        JSON.stringify({
          valid: true,
          planHash: planHash(plan),
          tasks: plan.tasks.map((t) => t.id),
          workspace: plan.workspace,
          executionContext: {
            model: plan.model ?? "inherit",
            effort: plan.effort ?? "inherit",
            packageManager: packageManager?.declared ?? null,
          },
        })
      )
    } else {
      if (!opts.state) throw new Error("--state is required.")
      store = await openStore({
        stateDir: resolve(opts.state),
        workspace: plan.workspace,
        planHash: planHash(plan),
        initialState: initialState(plan),
        resume: opts.resume ?? false,
        recoverLock: opts["recover-lock"] ?? false,
      })
      if (
        store.state.taskIndex > plan.tasks.length ||
        store.state.completed.length !== store.state.taskIndex ||
        store.state.completed.some(
          (done, i) =>
            done.id !== plan.tasks[i]?.id ||
            JSON.stringify(done.checks.map((check) => check.command)) !==
              JSON.stringify(plan.tasks[i]?.verify)
        ) ||
        (store.state.status === "complete") !==
          (store.state.taskIndex === plan.tasks.length)
      ) {
        throw new Error("Saved task progression is inconsistent with the plan.")
      }
      const controller = new AbortController()
      const stop = () => controller.abort()
      process.once("SIGINT", stop)
      process.once("SIGTERM", stop)
      let result
      try {
        result = await runPlan(plan, store, {
          command: opts.codex ?? "codex",
          signal: controller.signal,
          log: (event) => console.log(JSON.stringify(event)),
        })
      } finally {
        process.removeListener("SIGINT", stop)
        process.removeListener("SIGTERM", stop)
      }
      console.log(
        JSON.stringify({
          status: result.status,
          completed: result.completed.map((t) => t.id),
          currentTask: plan.tasks[result.taskIndex]?.id ?? null,
          handoff: result.handoff,
          stateDirectory: resolve(opts.state),
          message: result.message,
        })
      )
      process.exitCode =
        result.status === "complete" ? 0 : result.status === "paused" ? 3 : 2
    }
  }
} catch (error) {
  console.error(`handoff-runner: ${error.message}`)
  process.exitCode = 1
} finally {
  if (store) await store.close()
}

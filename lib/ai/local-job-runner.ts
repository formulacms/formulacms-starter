import "server-only"

import { ConvexHttpClient } from "convex/browser"
import type { FunctionReturnType } from "convex/server"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  isGenerationErrorCategory,
  type GenerationErrorCategory,
} from "@/lib/ai/execution-contract"
import {
  generateWithLocalTool,
  LOCAL_AUDIT_ENGINES,
  type LocalToolRoute,
} from "./local-engine-run"
import { fundingForAuditEngine } from "./local-tool-funding"

// The local job runner (ADR-0057 decision 2, AI-LOCAL-2). The formulacms Next
// server on the owner's computer runs whole-page Writing and Translation jobs
// on Claude Code or Codex: it claims each waiting unit in Convex, runs the tool
// and saves the raw text. Convex builds the prompts, checks the text and
// writes the audit rows (`convex/cms/aiLocalJobs.ts`).
//
// - One runner per job, held in a registry on `globalThis`: module state is
//   lost when `next dev` recompiles, `globalThis` is not (the Prisma pattern).
//   A runner starts only from a server action call, never on import.
// - The loop is a detached promise with its own error handling. It uses no
//   Next request API (cookies, headers, after, revalidate): those belong to
//   the request that started it (vercel/next.js#72578).
// - It keeps no route in memory: each claim returns the job's frozen engine,
//   model and effort, so a restart of the dev server does not lose them.
// - It calls only the runner functions (the mutations and `localJobState`),
//   which accept the job's runner secret instead of a session. The secret
//   lives only in the registry entry: it is never logged and never sent
//   anywhere else.
// - A heartbeat every 20 s keeps the 90 s lease. When the dev server stops,
//   the lease runs out and Convex stops the job ("local app stopped"); the
//   owner resumes it later. A refused call (an old claim, a rotated secret,
//   a lease that ran out) stops this runner at once, without a retry.
// - While a tool runs, a read-only check every 3 s (`localJobState`) learns of
//   Cancel, so the tool stops within seconds, not at the next heartbeat.

const HEARTBEAT_MS = 20_000
/** How often a running tool's job is checked for Cancel. */
const POLL_MS = 3_000
const WAIT_MS = 2_000
/** Convex hands out at most two units at once (one for Writing); so do we. */
const MAX_RUNNING = 2
/** Tries per runner mutation that throws (a network failure, for example). */
const CALL_TRIES = 3

/** Each job kind runs on the task profile and phase of its Workpool twin. */
const TASKS = {
  write: { profile: "editorial-copy", phase: "page-fill" },
  translation: { profile: "brand-translation", phase: "translation" },
} as const

/** The Convex calls the runner needs; a fake in tests. */
export type RunnerConvex = Pick<ConvexHttpClient, "mutation" | "query">
type Claim = FunctionReturnType<typeof api.cms.aiLocalJobs.localClaimUnit>
type UnitClaim = Extract<Claim, { kind: "unit" }>

export type LocalJobRunnerJob = Readonly<{
  jobId: Id<"aiJobs">
  /** 32 random bytes, base64url. Never logged, never sent to the browser. */
  runnerSecret: string
}>

export type LocalJobRunnerDeps = Readonly<{
  convex?: RunnerConvex
  generate?: typeof generateWithLocalTool
  funding?: (engine: LocalToolRoute["engine"]) => Promise<"plan" | "api-key" | "unknown">
  heartbeatMs?: number
  pollMs?: number
  waitMs?: number
  now?: () => number
}>

type Entry = { readonly secret: string; readonly stop: () => void; readonly done: Promise<void> }

const REGISTRY = Symbol.for("formulacms.localJobRunners")

/** The running runners by job id; shared by every bundle in this process. */
export function localJobRunners(): Map<string, Entry> {
  const scope = globalThis as typeof globalThis & { [REGISTRY]?: Map<string, Entry> }
  return (scope[REGISTRY] ??= new Map())
}

function defaultConvex(): RunnerConvex {
  const url = process.env.NEXT_PUBLIC_CONVEX_URL
  if (!url) throw new Error("NEXT_PUBLIC_CONVEX_URL is not set.")
  // No logger: nothing about a runner call reaches the terminal.
  return new ConvexHttpClient(url, { logger: false })
}

async function defaultFunding(engine: LocalToolRoute["engine"]) {
  return (await fundingForAuditEngine(LOCAL_AUDIT_ENGINES[engine])) ?? "unknown"
}

const categoryOf = (error: unknown): GenerationErrorCategory => {
  const category =
    error && typeof error === "object" ? (error as { category?: unknown }).category : undefined
  return isGenerationErrorCategory(category) ? category : "LOCAL_PROCESS_FAILED"
}

/**
 * Starts the runner of one job, detached from the caller. A second start with
 * the same secret is a no-op. A start with a new secret (Resume) stops the old
 * runner, whose secret Convex no longer accepts, and replaces it. Resolves
 * when the runner has stopped; it never rejects.
 */
export function startLocalJobRunner(
  job: LocalJobRunnerJob,
  deps: LocalJobRunnerDeps = {}
): Promise<void> {
  const runners = localJobRunners()
  const current = runners.get(job.jobId)
  if (current?.secret === job.runnerSecret) return current.done
  current?.stop()
  const convex = deps.convex ?? defaultConvex()
  const halt = new AbortController()
  const entry: Entry = {
    secret: job.runnerSecret,
    stop: () => halt.abort(),
    done: runJob(job, convex, deps, halt)
      .catch(() => {})
      .finally(() => {
        if (runners.get(job.jobId) === entry) runners.delete(job.jobId)
      }),
  }
  runners.set(job.jobId, entry)
  return entry.done
}

async function runJob(
  { jobId, runnerSecret }: LocalJobRunnerJob,
  convex: RunnerConvex,
  deps: LocalJobRunnerDeps,
  halt: AbortController
): Promise<void> {
  const generate = deps.generate ?? generateWithLocalTool
  const funding = deps.funding ?? defaultFunding
  const now = deps.now ?? Date.now
  const waitMs = deps.waitMs ?? WAIT_MS
  const runner = { jobId, runnerSecret }
  // How the runner stops: give claimed units back (the job stopped or was
  // canceled), or make no further call (Convex refused this runner).
  let release = true
  const stopRunner = (giveBack: boolean) => {
    if (halt.signal.aborted) return
    release = giveBack
    halt.abort()
  }
  // Resolves after `ms`, or at once when the runner stops. A plain timer, so a
  // fake clock drives it in tests.
  const pause = (ms: number) =>
    new Promise<void>((resolve) => {
      if (halt.signal.aborted) return resolve()
      const done = () => {
        clearTimeout(timer)
        halt.signal.removeEventListener("abort", done)
        resolve()
      }
      const timer = setTimeout(done, ms)
      halt.signal.addEventListener("abort", done, { once: true })
    })
  async function call<T>(work: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try {
        return await work()
      } catch (error) {
        if (attempt >= CALL_TRIES || halt.signal.aborted) throw error
        await pause(waitMs)
      }
    }
  }
  const audit = async (started: number, route: LocalToolRoute) => ({
    funding: await funding(route.engine),
    durationMs: Math.max(0, Math.round(now() - started)),
  })

  async function runUnit(claim: UnitClaim): Promise<void> {
    const unit = { ...runner, unitId: claim.unitId, claimToken: claim.claimToken }
    const giveBack = async () => {
      if (release) await convex.mutation(api.cms.aiLocalJobs.localReleaseUnit, unit).catch(() => {})
    }
    if (halt.signal.aborted) return giveBack()
    // A claim can outlive its target. A failed/negative check must never
    // launch the local tool; release uses the ordinary cancellation path.
    const state = await convex.query(api.cms.aiLocalJobs.localJobState, runner)
      .catch(() => undefined)
    if (!state?.keepGoing || halt.signal.aborted) {
      stopRunner(true)
      return giveBack()
    }
    // Each unit runs on the route Convex froze for the job and returned with
    // the claim, never on a route kept in this process.
    const route = claim.localRoute
    const started = now()
    let text: string
    try {
      const generation = await generate(route, {
        instructions: claim.instructions,
        prompt: claim.prompt,
        images: [],
        ...TASKS[claim.jobKind],
        signal: halt.signal,
      })
      text = generation.text
    } catch (error) {
      if (halt.signal.aborted) return giveBack()
      const failed = await call(async () =>
        convex.mutation(api.cms.aiLocalJobs.localFailUnit, {
          ...unit,
          errorCategory: categoryOf(error),
          audit: await audit(started, route),
        })
      ).catch(() => undefined)
      if (failed?.kind !== "recorded") stopRunner(failed === undefined)
      return
    }
    if (halt.signal.aborted) return giveBack()
    const saved = await call(async () =>
      convex.mutation(api.cms.aiLocalJobs.localSaveUnit, {
        ...unit,
        text,
        audit: await audit(started, route),
      })
    ).catch(() => undefined)
    // `unit-failed`: Convex stopped the job; the next claim says so.
    if (saved === undefined || saved.kind === "refused") stopRunner(saved === undefined)
  }

  const heartbeat = (async () => {
    while (!halt.signal.aborted) {
      await pause(deps.heartbeatMs ?? HEARTBEAT_MS)
      if (halt.signal.aborted) return
      const beat = await convex
        .mutation(api.cms.aiLocalJobs.localHeartbeat, runner)
        .catch(() => undefined)
      // A failed call is retried at the next beat; the lease allows four.
      if (beat && !beat.keepGoing) stopRunner(true)
    }
  })()

  const running = new Set<Promise<void>>()
  // While a tool runs, Cancel reaches it through this read, not the heartbeat.
  // A failed read is ignored: the next one, or the heartbeat, decides.
  const poll = (async () => {
    while (!halt.signal.aborted) {
      await pause(deps.pollMs ?? POLL_MS)
      if (halt.signal.aborted || running.size === 0) continue
      const state = await convex
        .query(api.cms.aiLocalJobs.localJobState, runner)
        .catch(() => undefined)
      if (state && !state.keepGoing) stopRunner(true)
    }
  })()

  try {
    while (!halt.signal.aborted) {
      if (running.size >= MAX_RUNNING) {
        await Promise.race(running)
        continue
      }
      const claim = await call(() => convex.mutation(api.cms.aiLocalJobs.localClaimUnit, runner))
      if (claim.kind === "refused") stopRunner(false)
      else if (claim.kind === "stop") stopRunner(true)
      else if (claim.kind === "wait") {
        await (running.size > 0 ? Promise.race(running) : pause(waitMs))
      } else {
        const task: Promise<void> = runUnit(claim)
          .catch(() => {})
          .finally(() => running.delete(task))
        running.add(task)
      }
    }
  } catch {
    // Convex could not be reached: give the units back if it can be.
    stopRunner(true)
  } finally {
    await Promise.allSettled(running)
    stopRunner(release)
    await Promise.all([heartbeat, poll])
  }
}

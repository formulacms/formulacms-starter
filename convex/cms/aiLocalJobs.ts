/**
 * Whole-page Writing and Translation jobs run by the owner's local tool
 * (ADR-0057 decision 2, AI-LOCAL-2).
 *
 * The formulacms Next.js process on the owner's computer is the runner. It
 * claims each waiting unit, runs Claude Code or Codex, and saves the raw text
 * here. Convex builds the prompt, checks and assembles the text, and writes the
 * metadata-only audit row. Convex makes no model call, writes no spending
 * record and enqueues no Workpool work for these jobs. API-key jobs keep their
 * path in `aiJobs.ts`.
 *
 * The runner calls the mutations below without a session (a tool run outlives
 * the 60 second access token). Each call proves itself with the job's runner
 * secret: the SHA-256 of the secret is stored on the job. A wrong secret, a job
 * that has no local route, an expired job or a lease that ran out all get the
 * same plain refusal.
 * The runner must call in at least every `LEASE_MS`; a scheduled check turns a
 * silent runner into a stopped job, so a claimed unit always has a deadline.
 */
import { ConvexError, v, type Infer } from "convex/values"
import { internalMutation, mutation, query } from "../_generated/server"
import type { MutationCtx, QueryCtx } from "../_generated/server"
import type { Id } from "../_generated/dataModel"
import { enforceAiRateLimit } from "../lib/aiRateLimit"
import {
  equalOwnerClaimHashes,
  hashOwnerClaim,
} from "../lib/ownerClaim"
import {
  localJobRouteValidator,
  localToolFundingValidator,
} from "../lib/aiValidators"
import {
  isSafeLocalModelId,
  localAuditErrorCodeValidator,
  recordLocalJobUnitAudit,
} from "../agents/localGeneration"
import {
  assembleSlice,
  assertSliceType,
} from "../lib/agents/contentWriterContract"
import { prependAssistantInstructions } from "../../lib/ai/task-profiles"
import {
  active,
  advance,
  expire,
  expired,
  finish,
  jobGenerationInput,
  assertJobTargetTranslated,
  jobModulesAvailable,
  noOtherActive,
  ownedJobNoTaskGate,
  pageJobInputValidator,
  renewRunnerLease,
  startJobCore,
  stop,
  taskGate,
  unitsFor,
  type Job,
  type Unit,
} from "./aiJobs"

/** The most characters one unit's saved text may have (the rich text limit). */
const MAX_UNIT_TEXT = 200_000
/** Write jobs run one unit at a time (each reads the earlier ones); translation two. */
const CONCURRENCY = { write: 1, translation: 2 } as const
/** A runner secret is 32 random bytes as base64url: 43 characters. */
const RUNNER_SECRET = /^[A-Za-z0-9_-]{43}$/
/** A stored secret hash is lowercase hex SHA-256: 64 characters. */
const SECRET_HASH = /^[a-f0-9]{64}$/

const jobKindValidator = v.union(v.literal("write"), v.literal("translation"))
const refusedValidator = v.object({ kind: v.literal("refused") })
/**
 * What the runner reports about one finished tool run, for the audit row. The
 * engine, model and effort are not sent: they are the job's frozen route.
 * `durationMs` is accepted and bounded, but not stored (the audit table has no
 * duration column).
 */
const auditValidator = v.object({
  funding: localToolFundingValidator,
  durationMs: v.optional(v.number()),
})
/** `durationMs`, when sent, is a non-negative safe integer. */
const auditIsValid = (audit: Infer<typeof auditValidator>) =>
  audit.durationMs === undefined ||
  (Number.isSafeInteger(audit.durationMs) && audit.durationMs >= 0)
const runnerArgs = {
  jobId: v.id("aiJobs"),
  runnerSecret: v.string(),
}
const unitArgs = {
  ...runnerArgs,
  unitId: v.id("aiJobUnits"),
  claimToken: v.string(),
}

/**
 * The job, if the caller holds its runner secret: the secret's hash matches
 * and the job has a local route. It reads no clock, so a query can use it.
 */
async function runnerJob(
  ctx: QueryCtx,
  jobId: Id<"aiJobs">,
  runnerSecret: string
): Promise<Job | null> {
  if (!RUNNER_SECRET.test(runnerSecret)) return null
  const job = await ctx.db.get("aiJobs", jobId)
  if (!job || !job.localRoute || !job.runner) return null
  const hash = await hashOwnerClaim(runnerSecret)
  return equalOwnerClaimHashes(hash, job.runner.secretHash) ? job : null
}
/**
 * The job, if the caller holds its runner secret (`runnerJob`), the job has
 * not expired and the runner's lease has not run out. Otherwise null, with
 * nothing said about which condition failed. A late call after the lease ran
 * out is refused here, so it cannot renew the lease or cancel the scheduled
 * check: that check (`checkLocalRunner`) stops the job. Mutations only: it
 * reads the clock.
 */
async function authorizeRunner(
  ctx: MutationCtx,
  jobId: Id<"aiJobs">,
  runnerSecret: string
): Promise<Job | null> {
  const job = await runnerJob(ctx, jobId, runnerSecret)
  // `runnerJob` returns only jobs that have a runner.
  return job && !expired(job) && job.runner!.leaseExpiresAt > Date.now()
    ? job
    : null
}
/** The unit, if it is the caller's current claim: in progress under this token. */
async function claimedUnit(
  ctx: MutationCtx,
  job: Job,
  unitId: Id<"aiJobUnits">,
  claimToken: string
): Promise<Unit | null> {
  const unit = await ctx.db.get("aiJobUnits", unitId)
  if (
    !unit ||
    unit.jobId !== job._id ||
    unit.state !== "inProgress" ||
    unit.claimToken !== claimToken ||
    !active(job)
  )
    return null
  return unit
}
const reread = async (ctx: MutationCtx, job: Job): Promise<Job> =>
  (await ctx.db.get("aiJobs", job._id))!

/**
 * Starts a whole-page job on the owner's local tool. Owner session; no API
 * connection is needed. Unlike `startPageJob` this does not refuse an assistant
 * marked as running on a local tool: that is exactly the job it starts.
 * `runnerSecretHash` is the SHA-256 (64 lowercase hex) of the 32-byte secret
 * the local server keeps and sends with every runner call.
 */
export const startLocalPageJob = mutation({
  args: {
    input: pageJobInputValidator,
    localRoute: localJobRouteValidator,
    runnerSecretHash: v.string(),
  },
  returns: v.id("aiJobs"),
  handler: async (
    ctx,
    { input, localRoute, runnerSecretHash }
  ): Promise<Id<"aiJobs">> => {
    // The gate first, so a caller without access learns nothing about the input.
    await taskGate(ctx, input.kind, false)
    if (!SECRET_HASH.test(runnerSecretHash) || !isSafeLocalModelId(localRoute.model))
      throw new ConvexError("AI_JOB_INPUT_INVALID")
    return startJobCore(ctx, input, {
      kind: "local",
      localRoute,
      runnerSecretHash,
    })
  },
})

/**
 * Resumes a stopped local job with a new runner secret, which locks out the
 * old runner. Saved units are kept; the others wait again. No price, no
 * reservation. Owner session. `kind` is the job kind the local server checked
 * the assistant's local tool for; another kind is refused.
 */
export const resumeLocalPageJob = mutation({
  args: {
    jobId: v.id("aiJobs"),
    kind: jobKindValidator,
    runnerSecretHash: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { jobId, kind, runnerSecretHash }): Promise<null> => {
    const job = await ownedJobNoTaskGate(ctx, jobId)
    if (!job.localRoute) throw new ConvexError("AI_JOB_NOT_LOCAL")
    if (job.kind !== kind) throw new ConvexError("AI_JOB_NOT_RESUMABLE")
    await taskGate(ctx, job.kind, false)
    if (!SECRET_HASH.test(runnerSecretHash))
      throw new ConvexError("AI_JOB_INPUT_INVALID")
    if (
      job.reviewedAt !== undefined ||
      expired(job) ||
      !["canceled", "failed", "capped"].includes(job.state)
    )
      throw new ConvexError("AI_JOB_NOT_RESUMABLE")
    // A type switched to another language since Start is not translated into
    // the hidden language.
    await assertJobTargetTranslated(ctx, job)
    const units = await unitsFor(ctx, jobId)
    // A local unit has no spending attempt; a unit still in progress is settling.
    if (units.some((unit) => unit.state === "inProgress"))
      throw new ConvexError("AI_JOB_STILL_SETTLING")
    await noOtherActive(ctx, job.authId, jobId)
    await enforceAiRateLimit(ctx, { pageOp: true })
    for (const unit of units)
      await ctx.db.patch(
        "aiJobUnits",
        unit._id,
        unit.state === "saved"
          ? { reused: true }
          : { state: "waiting", claimToken: undefined }
      )
    await ctx.db.patch("aiJobs", jobId, {
      state: "running",
      stopReason: undefined,
      stopDetail: undefined,
    })
    await renewRunnerLease(ctx, job, runnerSecretHash)
    await advance(ctx, await reread(ctx, job))
    return null
  },
})

/**
 * The runner asks for its next unit. `unit` carries the finished prompt;
 * `wait` means the concurrency is full or only running units are left; `stop`
 * means the job is not running (canceled, failed, finished or stopped by a
 * module change); `refused` means the secret did not match or the lease ran
 * out.
 */
export const localClaimUnit = mutation({
  args: runnerArgs,
  returns: v.union(
    v.object({
      kind: v.literal("unit"),
      unitId: v.id("aiJobUnits"),
      claimToken: v.string(),
      jobKind: jobKindValidator,
      instructions: v.string(),
      prompt: v.string(),
      sliceType: v.optional(v.string()),
      // The frozen route, read here in the same transaction: the runner keeps
      // none in memory, so it survives a restart of the dev server (Resume).
      localRoute: localJobRouteValidator,
    }),
    v.object({ kind: v.literal("wait") }),
    v.object({ kind: v.literal("stop") }),
    refusedValidator
  ),
  handler: async (ctx, { jobId, runnerSecret }) => {
    const job = await authorizeRunner(ctx, jobId, runnerSecret)
    if (!job) return { kind: "refused" as const }
    if (job.state !== "running") return { kind: "stop" as const }
    // The AI module must still be on (an API connection is not needed), and
    // Multilingual for a translation. A change stops the job as for an API job.
    if (!(await jobModulesAvailable(ctx, job, false))) {
      await stop(ctx, job, "canceled")
      await advance(ctx, await reread(ctx, job))
      return { kind: "stop" as const }
    }
    // The claim reads every unit row (60 at most): it counts the units in
    // progress and finds the next waiting one. Two claims at once conflict and
    // Convex retries the later one, which then sees the first one's claim. That
    // is the point: it keeps the limit exact and the two claims on different
    // units. Throughput does not matter here; one runner makes at most two
    // claims, each followed by minutes of tool work.
    const units = await unitsFor(ctx, jobId)
    const next = units.find((unit) => unit.state === "waiting")
    const inProgress = units.filter((unit) => unit.state === "inProgress").length
    if (!next) {
      if (inProgress > 0) return { kind: "wait" as const }
      // Nothing waits and nothing runs: the job is finished or cannot go on.
      await advance(ctx, job)
      return { kind: "stop" as const }
    }
    if (inProgress >= CONCURRENCY[job.kind]) return { kind: "wait" as const }
    const claimToken = crypto.randomUUID()
    await ctx.db.patch("aiJobUnits", next._id, {
      state: "inProgress",
      claimToken,
    })
    await renewRunnerLease(ctx, job)
    // A write unit reads its earlier sections; a translation unit stands alone.
    const generation = jobGenerationInput(
      job,
      next,
      job.kind === "write" ? units : []
    )
    return {
      kind: "unit" as const,
      unitId: next._id,
      claimToken,
      jobKind: job.kind,
      instructions: prependAssistantInstructions(
        job.assistantInstructions,
        generation.instructions
      ),
      prompt: generation.prompt,
      ...(next.sliceType ? { sliceType: next.sliceType } : {}),
      // authorizeRunner returns only jobs that have a local route.
      localRoute: job.localRoute!,
    }
  },
})

/**
 * The runner's heartbeat, every 20 seconds. It moves the lease forward. When
 * `keepGoing` is false the runner must stop its tool run: the job is
 * canceling, ended or expired, its lease ran out, or the secret does not match.
 */
export const localHeartbeat = mutation({
  args: runnerArgs,
  returns: v.object({ keepGoing: v.boolean() }),
  handler: async (ctx, { jobId, runnerSecret }) => {
    const job = await authorizeRunner(ctx, jobId, runnerSecret)
    if (!job || !active(job)) return { keepGoing: false }
    await renewRunnerLease(ctx, job)
    return { keepGoing: job.state === "running" }
  },
})

/**
 * The runner's quick check while a tool runs, every 3 seconds, so Cancel stops
 * the tool within seconds instead of at the next heartbeat. The same answer as
 * `localHeartbeat`, but it writes nothing and does not move the lease. A query
 * reads no clock (Convex guidelines): a job past its expiry time but not yet
 * marked expired still answers true here; the heartbeat, a mutation, catches
 * it within 20 seconds.
 */
export const localJobState = query({
  args: runnerArgs,
  returns: v.object({ keepGoing: v.boolean() }),
  handler: async (ctx, { jobId, runnerSecret }) => {
    const job = await runnerJob(ctx, jobId, runnerSecret)
    return { keepGoing: job?.state === "running" }
  },
})

/**
 * Stops a job because one unit failed, as `onComplete` does for an API unit.
 * The unit is marked failed, one audit row is written, and the job stops
 * `failed`: units still in progress finish or are released first.
 */
async function failClaimedUnit(
  ctx: MutationCtx,
  job: Job,
  unit: Unit,
  errorCode: Infer<typeof localAuditErrorCodeValidator>,
  funding: Infer<typeof localToolFundingValidator>,
  stopDetail?: "local-tool-outdated"
): Promise<void> {
  await ctx.db.patch("aiJobUnits", unit._id, { state: "failed" })
  await recordLocalJobUnitAudit(ctx, {
    job,
    unit,
    claimToken: unit.claimToken!,
    funding,
    result: { success: false, errorCode },
  })
  await renewRunnerLease(ctx, job)
  // Only the call that stops the job records why; a later failing unit on an
  // already stopped job leaves the detail alone. Nothing below clears it.
  if (job.state === "running") {
    await stop(ctx, job, "failed")
    if (stopDetail) await ctx.db.patch("aiJobs", job._id, { stopDetail })
  }
  await advance(ctx, await reread(ctx, job))
}

/**
 * The runner saves the raw text of one claimed unit. A write unit's text is
 * assembled into a slice here; a translation unit's text is stored as is
 * (assembly in `finish` trims it and restores the source whitespace). Text
 * that does not assemble, is empty, or is over 200,000 characters fails the
 * unit and stops the job, as a Workpool worker failure does.
 */
export const localSaveUnit = mutation({
  args: { ...unitArgs, text: v.string(), audit: auditValidator },
  returns: v.union(
    v.object({ kind: v.literal("saved") }),
    v.object({ kind: v.literal("unit-failed") }),
    refusedValidator
  ),
  handler: async (ctx, args) => {
    const job = await authorizeRunner(ctx, args.jobId, args.runnerSecret)
    if (!job || !auditIsValid(args.audit)) return { kind: "refused" as const }
    const unit = await claimedUnit(ctx, job, args.unitId, args.claimToken)
    if (!unit) return { kind: "refused" as const }
    let output: Unit["output"]
    try {
      if (args.text.length > MAX_UNIT_TEXT || !args.text.trim())
        throw new Error("Unusable text.")
      output =
        job.kind === "write"
          ? assembleSlice(assertSliceType(unit.sliceType!), args.text)
          : args.text
    } catch {
      await failClaimedUnit(ctx, job, unit, "INVALID_OUTPUT", args.audit.funding)
      return { kind: "unit-failed" as const }
    }
    await ctx.db.patch("aiJobUnits", unit._id, { state: "saved", output })
    await recordLocalJobUnitAudit(ctx, {
      job,
      unit,
      claimToken: args.claimToken,
      funding: args.audit.funding,
      result: { success: true },
    })
    await renewRunnerLease(ctx, job)
    await advance(ctx, await reread(ctx, job))
    return { kind: "saved" as const }
  },
})

/** The runner reports that the tool run for a claimed unit failed. */
export const localFailUnit = mutation({
  args: {
    ...unitArgs,
    errorCategory: localAuditErrorCodeValidator,
    audit: auditValidator,
    // The installed tool is too old for the job's model: Resume after updating.
    stopDetail: v.optional(v.literal("local-tool-outdated")),
  },
  returns: v.union(v.object({ kind: v.literal("recorded") }), refusedValidator),
  handler: async (ctx, args) => {
    const job = await authorizeRunner(ctx, args.jobId, args.runnerSecret)
    if (!job || !auditIsValid(args.audit)) return { kind: "refused" as const }
    const unit = await claimedUnit(ctx, job, args.unitId, args.claimToken)
    if (!unit) return { kind: "refused" as const }
    await failClaimedUnit(
      ctx,
      job,
      unit,
      args.errorCategory,
      args.audit.funding,
      args.stopDetail
    )
    return { kind: "recorded" as const }
  },
})

/**
 * The runner gives a claimed unit back after it aborted the tool (the job is
 * canceling, or the runner is shutting down). The unit waits again, and a
 * canceling job with nothing in progress ends. No audit row: the unit's result
 * was never produced.
 */
export const localReleaseUnit = mutation({
  args: unitArgs,
  returns: v.union(v.object({ kind: v.literal("released") }), refusedValidator),
  handler: async (ctx, args) => {
    const job = await authorizeRunner(ctx, args.jobId, args.runnerSecret)
    if (!job) return { kind: "refused" as const }
    const unit = await claimedUnit(ctx, job, args.unitId, args.claimToken)
    if (!unit) return { kind: "refused" as const }
    await ctx.db.patch("aiJobUnits", unit._id, {
      state: "waiting",
      claimToken: undefined,
    })
    await renewRunnerLease(ctx, job)
    await advance(ctx, await reread(ctx, job))
    return { kind: "released" as const }
  },
})

/**
 * The scheduled lease check (one pending per job). When the runner has gone
 * silent past its lease, every unit in progress waits again and the job ends:
 * a running job as `failed` with the detail `local-app-stopped`, a canceling
 * job with its own reason. A fresh lease means a newer check is scheduled, so
 * this one does nothing.
 */
export const checkLocalRunner = internalMutation({
  args: { jobId: v.id("aiJobs") },
  returns: v.null(),
  handler: async (ctx, { jobId }): Promise<null> => {
    const job = await ctx.db.get("aiJobs", jobId)
    if (!job || !job.localRoute || !job.runner || !active(job)) return null
    if (expired(job)) {
      await expire(ctx, job)
      return null
    }
    if (job.runner.leaseExpiresAt > Date.now()) return null
    for (const unit of await unitsFor(ctx, jobId))
      if (unit.state === "inProgress")
        await ctx.db.patch("aiJobUnits", unit._id, {
          state: "waiting",
          claimToken: undefined,
        })
    // This check is the one running: do not cancel it.
    await ctx.db.patch("aiJobs", jobId, {
      runner: { ...job.runner, checkId: undefined },
    })
    const fresh = await reread(ctx, job)
    if (job.state === "running") {
      await finish(ctx, fresh, "failed")
      await ctx.db.patch("aiJobs", jobId, { stopDetail: "local-app-stopped" })
    } else await finish(ctx, fresh, job.stopReason ?? "canceled")
    return null
  },
})

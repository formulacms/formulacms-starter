// @vitest-environment node
import { getFunctionName } from "convex/server"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"

vi.mock("server-only", () => ({}))
// The funding lookup runs the tool's status command: never here.
vi.mock("./local-tool-funding", () => ({
  fundingForAuditEngine: async () => "plan",
}))

import type { EngineGenerationResult } from "@/scripts/lib/ai-engine"
import { makeSubscriptionCliError } from "@/scripts/lib/subscription-cli-contract"
import type { Id } from "@/convex/_generated/dataModel"
import {
  localJobRunners,
  startLocalJobRunner,
  type LocalJobRunnerDeps,
  type RunnerConvex,
} from "./local-job-runner"

const SECRET = "s".repeat(43)
const ROUTE = { engine: "claude", model: "claude-sonnet-5-5", effort: "medium" } as const
const JOB = "job-1" as Id<"aiJobs">

type Call = { name: string; args: Record<string, unknown> }
type Handler = (args: Record<string, unknown>) => unknown

/** A fake Convex: each runner function answers from its handler, in order. */
function fakeConvex(handlers: Record<string, Handler>) {
  const calls: Call[] = []
  const answer = async (reference: unknown, args: Record<string, unknown>) => {
    const name = getFunctionName(reference as never).replace("cms/aiLocalJobs:", "")
    calls.push({ name, args })
    const handler = handlers[name] ?? (name === "localJobState" ? () => ({ keepGoing: true }) : undefined)
    if (!handler) throw new Error(`unexpected ${name}`)
    return handler(args)
  }
  const convex = { mutation: answer, query: answer } as unknown as RunnerConvex
  return { convex, calls, names: () => calls.map((call) => call.name) }
}

const unit = (index: number, jobKind: "write" | "translation" = "write") => ({
  kind: "unit",
  unitId: `unit-${index}`,
  claimToken: `token-${index}`,
  jobKind,
  localRoute: ROUTE,
  instructions: "Write well.",
  prompt: `Section ${index}`,
})

/**
 * Claims answer from the list; then, like Convex, `wait` while a unit is in
 * progress and `stop` once none is.
 */
let inProgress = 0
const claims = (...answers: unknown[]) => () => {
  const answer = answers.shift() as { kind: string } | undefined
  if (answer?.kind === "unit") inProgress++
  return answer ?? (inProgress > 0 ? { kind: "wait" } : { kind: "stop" })
}
/** A unit result settles the claim. */
const settles = (answer: unknown) => () => {
  inProgress--
  return answer
}

const call = (fake: ReturnType<typeof fakeConvex>, name: string) =>
  fake.calls.find((entry) => entry.name === name)!.args

const generation = (text: string) =>
  ({
    text,
    selected: { lane: "local-build", engine: "claude-cli", model: ROUTE.model, effort: ROUTE.effort },
  }) as unknown as EngineGenerationResult

function start(convex: RunnerConvex, deps: Partial<LocalJobRunnerDeps> = {}, secret = SECRET) {
  return startLocalJobRunner(
    { jobId: JOB, runnerSecret: secret },
    { convex, heartbeatMs: 60_000, waitMs: 1, now: () => 1_000, ...deps }
  )
}

beforeEach(() => {
  localJobRunners().clear()
  inProgress = 0
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe("the local job runner", () => {
  test("claims a unit, runs the tool on the frozen route and saves the raw text", async () => {
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0)),
      localSaveUnit: settles({ kind: "saved" }),
    })
    const generate = vi.fn(async () => generation("TITLE: Hello"))
    await start(fake.convex, { generate })
    expect(generate).toHaveBeenCalledWith(ROUTE, expect.objectContaining({
      instructions: "Write well.",
      prompt: "Section 0",
      images: [],
      profile: "editorial-copy",
      phase: "page-fill",
    }))
    // Claim, wait while the unit runs, save, then stop.
    expect(fake.names()).toEqual(["localClaimUnit", "localJobState", "localClaimUnit", "localSaveUnit", "localClaimUnit"])
    expect(call(fake, "localSaveUnit")).toEqual({
      jobId: JOB,
      runnerSecret: SECRET,
      unitId: "unit-0",
      claimToken: "token-0",
      text: "TITLE: Hello",
      audit: { funding: "plan", durationMs: 0 },
    })
    expect(localJobRunners().has(JOB)).toBe(false)
  })

  test("after a restart of the dev server the runner uses the route Convex returns with the claim", async () => {
    // A restart loses everything in process memory: no registry entry, no route.
    localJobRunners().clear()
    const frozen = { engine: "codex", model: "gpt-6.1-sol", effort: "high" } as const
    const fake = fakeConvex({
      localClaimUnit: claims({ ...unit(0), localRoute: frozen }),
      localSaveUnit: settles({ kind: "saved" }),
      localHeartbeat: () => ({ keepGoing: true }),
    })
    const generate = vi.fn(async () => generation("TITLE: Hello"))
    // What Resume starts: the job id and the new secret, nothing else.
    await start(fake.convex, { generate })
    expect(generate).toHaveBeenCalledTimes(1)
    expect(generate).toHaveBeenCalledWith(frozen, expect.anything())
    expect(fake.names()).toContain("localSaveUnit")
  })

  test("a translation unit runs on the translation profile", async () => {
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0, "translation")),
      localSaveUnit: settles({ kind: "saved" }),
    })
    const generate = vi.fn(async () => generation("Bonjour"))
    await start(fake.convex, { generate })
    expect(generate).toHaveBeenCalledWith(ROUTE, expect.objectContaining({
      profile: "brand-translation",
      phase: "translation",
    }))
  })

  test("a failed tool run reports its category; nothing is saved", async () => {
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0)),
      localFailUnit: settles({ kind: "recorded" }),
    })
    const generate = vi.fn(async () => {
      throw Object.assign(new Error("signed out"), { category: "AUTH_REQUIRED" })
    })
    await start(fake.convex, { generate })
    expect(fake.names()).not.toContain("localSaveUnit")
    expect(call(fake, "localFailUnit")).toMatchObject({
      unitId: "unit-0",
      claimToken: "token-0",
      errorCategory: "AUTH_REQUIRED",
      audit: { funding: "plan", durationMs: 0 },
    })
    expect(call(fake, "localFailUnit")).not.toHaveProperty("stopDetail")
  })

  test("a capability refusal sends no stop detail; the category stays", async () => {
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0)),
      localFailUnit: settles({ kind: "recorded" }),
    })
    const generate = vi.fn(async () => {
      throw makeSubscriptionCliError("UNSUPPORTED_CAPABILITY", {
        selected: { lane: "local-build", engine: "claude-cli", model: "claude-opus-5-5", effort: "high" },
        attempts: 0,
        phase: "page-fill",
      })
    })
    await start(fake.convex, { generate })
    expect(call(fake, "localFailUnit").errorCategory).toBe("UNSUPPORTED_CAPABILITY")
    expect(call(fake, "localFailUnit")).not.toHaveProperty("stopDetail")
  })

  test("an error without a known category reports LOCAL_PROCESS_FAILED", async () => {
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0)),
      localFailUnit: settles({ kind: "recorded" }),
    })
    await start(fake.convex, { generate: async () => { throw new Error("boom") } })
    expect(call(fake, "localFailUnit").errorCategory).toBe("LOCAL_PROCESS_FAILED")
  })

  test("keepGoing false aborts the running tool and gives the unit back", async () => {
    let toolSignal: AbortSignal | undefined
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0), { kind: "wait" }),
      localHeartbeat: () => ({ keepGoing: false }),
      localReleaseUnit: settles({ kind: "released" }),
    })
    const generate = vi.fn(
      (_route: unknown, request: { signal?: AbortSignal }) =>
        new Promise<EngineGenerationResult>((_resolve, reject) => {
          toolSignal = request.signal
          request.signal?.addEventListener("abort", () => reject(new Error("cancelled")))
        })
    )
    await start(fake.convex, { generate, heartbeatMs: 5 })
    expect(toolSignal?.aborted).toBe(true)
    expect(fake.names()).toContain("localReleaseUnit")
    expect(fake.names()).not.toContain("localFailUnit")
    expect(fake.names()).not.toContain("localSaveUnit")
    expect(fake.calls.find((call) => call.name === "localReleaseUnit")!.args).toEqual({
      jobId: JOB,
      runnerSecret: SECRET,
      unitId: "unit-0",
      claimToken: "token-0",
    })
  })

  test("Cancel stops a running tool within 5 s, before the next heartbeat (fake clock)", async () => {
    vi.useFakeTimers()
    try {
      let canceled = false
      let abortedAt: number | undefined
      const fake = fakeConvex({
        localClaimUnit: claims(unit(0)),
        // The heartbeat never says stop: only the quick check can.
        localHeartbeat: () => ({ keepGoing: true }),
        localJobState: () => ({ keepGoing: !canceled }),
        localReleaseUnit: settles({ kind: "released" }),
        localSaveUnit: settles({ kind: "saved" }),
      })
      const generate = vi.fn(
        (_route: unknown, request: { signal?: AbortSignal }) =>
          new Promise<EngineGenerationResult>((resolve, reject) => {
            request.signal?.addEventListener("abort", () => {
              abortedAt = Date.now()
              reject(new Error("cancelled"))
            })
            // A tool that would finish long after the Cancel.
            setTimeout(() => resolve(generation("late")), 120_000)
          })
      )
      const done = start(fake.convex, { generate, heartbeatMs: 20_000, pollMs: 3_000 })
      await vi.advanceTimersByTimeAsync(10_500)
      expect(generate).toHaveBeenCalledOnce()
      expect(abortedAt).toBeUndefined()
      // The owner clicks Cancel 10.5 s into the tool run.
      canceled = true
      const canceledAt = Date.now()
      await vi.advanceTimersByTimeAsync(5_000)
      expect(abortedAt).toBeDefined()
      expect(abortedAt! - canceledAt).toBeLessThanOrEqual(5_000)
      // The heartbeat (due at 20 s) has not run yet: the quick check stopped it.
      expect(fake.names()).not.toContain("localHeartbeat")
      await vi.runAllTimersAsync()
      await done
      expect(fake.names()).toContain("localReleaseUnit")
      expect(fake.names()).not.toContain("localSaveUnit")
    } finally {
      vi.useRealTimers()
    }
  })

  test("the quick check runs only while a tool runs and writes nothing", async () => {
    vi.useFakeTimers()
    try {
      const fake = fakeConvex({
        localClaimUnit: claims({ kind: "wait" }, { kind: "wait" }, { kind: "wait" }, unit(0)),
        localHeartbeat: () => ({ keepGoing: true }),
        localJobState: () => ({ keepGoing: true }),
        localSaveUnit: settles({ kind: "saved" }),
      })
      let finish!: () => void
      const generate = vi.fn(
        () =>
          new Promise<EngineGenerationResult>((resolve) => {
            finish = () => resolve(generation("x"))
          })
      )
      const done = start(fake.convex, { generate, waitMs: 2_000, pollMs: 3_000 })
      // Three 2 s waits with no tool running: no check yet.
      await vi.advanceTimersByTimeAsync(5_900)
      expect(fake.names()).not.toContain("localJobState")
      await vi.advanceTimersByTimeAsync(7_000)
      expect(generate).toHaveBeenCalledOnce()
      expect(fake.names().filter((name) => name === "localJobState").length).toBeGreaterThan(0)
      expect(call(fake, "localJobState")).toEqual({ jobId: JOB, runnerSecret: SECRET })
      finish()
      await vi.runAllTimersAsync()
      await done
      expect(fake.names()).toContain("localSaveUnit")
    } finally {
      vi.useRealTimers()
    }
  })

  test("a refused save stops the runner without a retry or another claim", async () => {
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0)),
      localSaveUnit: () => ({ kind: "refused" }),
    })
    await start(fake.convex, { generate: async () => generation("text") })
    const names = fake.names()
    expect(names.filter((name) => name === "localSaveUnit")).toHaveLength(1)
    expect(names.at(-1)).toBe("localSaveUnit")
  })

  test("a refused claim stops the runner at once", async () => {
    const fake = fakeConvex({ localClaimUnit: () => ({ kind: "refused" }) })
    const generate = vi.fn()
    await start(fake.convex, { generate })
    expect(fake.names()).toEqual(["localClaimUnit"])
    expect(generate).not.toHaveBeenCalled()
  })

  test("never runs more than two tool processes at once", async () => {
    let running = 0
    let most = 0
    let next = 0
    const fake = fakeConvex({
      // A careless backend that always hands out work: the runner still caps.
      localClaimUnit: () =>
        next < 6
          ? (inProgress++, unit(next++, "translation"))
          : inProgress > 0
            ? { kind: "wait" }
            : { kind: "stop" },
      localSaveUnit: settles({ kind: "saved" }),
    })
    await start(fake.convex, {
      generate: async () => {
        running++
        most = Math.max(most, running)
        await new Promise((resolve) => setTimeout(resolve, 2))
        running--
        return generation("x")
      },
    })
    expect(most).toBe(2)
    expect(fake.names().filter((name) => name === "localSaveUnit")).toHaveLength(6)
  })

  test("wait with nothing running pauses, then claims again", async () => {
    const fake = fakeConvex({
      localClaimUnit: claims({ kind: "wait" }, unit(0)),
      localSaveUnit: settles({ kind: "saved" }),
    })
    await start(fake.convex, { generate: async () => generation("x") })
    expect(fake.names().slice(0, 4)).toEqual(["localClaimUnit", "localClaimUnit", "localJobState", "localClaimUnit"])
    expect(fake.names()).toContain("localSaveUnit")
  })

  test("a second start for the same job and secret is a no-op", async () => {
    let release!: () => void
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0)),
      localSaveUnit: settles({ kind: "saved" }),
    })
    const generate = vi.fn(() => new Promise<EngineGenerationResult>((resolve) => {
      release = () => resolve(generation("x"))
    }))
    const first = start(fake.convex, { generate })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    const second = start(fake.convex, { generate })
    expect(second).toBe(first)
    release()
    await first
    expect(generate).toHaveBeenCalledOnce()
  })

  test("Resume with a new secret stops the old runner and starts a new one", async () => {
    let claimed = 0
    const fake = fakeConvex({
      // The old runner gets the one unit; the new one finds the job done.
      localClaimUnit: (args) =>
        args.runnerSecret === SECRET && inProgress === 0 && !claimed++
          ? (inProgress++, unit(0))
          : args.runnerSecret === SECRET
            ? { kind: "wait" }
            : { kind: "stop" },
      localReleaseUnit: settles({ kind: "released" }),
    })
    const generate = vi.fn(
      (_route: unknown, request: { signal?: AbortSignal }) =>
        new Promise<EngineGenerationResult>((_resolve, reject) => {
          request.signal?.addEventListener("abort", () => reject(new Error("cancelled")))
        })
    )
    const old = start(fake.convex, { generate })
    await vi.waitFor(() => expect(generate).toHaveBeenCalledOnce())
    const renewed = start(fake.convex, { generate }, "n".repeat(43))
    await Promise.all([old, renewed])
    expect(fake.names()).toContain("localReleaseUnit")
  })

  test("the secret goes only to the runner mutations and is never logged", async () => {
    const logs = [
      vi.spyOn(console, "log"),
      vi.spyOn(console, "info"),
      vi.spyOn(console, "warn"),
      vi.spyOn(console, "error"),
      vi.spyOn(console, "debug"),
    ]
    const fake = fakeConvex({
      localClaimUnit: claims(unit(0), unit(1)),
      localSaveUnit: settles({ kind: "saved" }),
      localFailUnit: settles({ kind: "recorded" }),
    })
    const generate = vi.fn(async () => {
      if (generate.mock.calls.length === 2) throw new Error("boom")
      return generation("x")
    })
    await start(fake.convex, { generate })
    for (const call of fake.calls) {
      expect([
        "localClaimUnit",
        "localSaveUnit",
        "localFailUnit",
        "localHeartbeat",
        "localReleaseUnit",
        "localJobState",
      ]).toContain(call.name)
    }
    expect(JSON.stringify(generate.mock.calls)).not.toContain(SECRET)
    for (const spy of logs) expect(JSON.stringify(spy.mock.calls)).not.toContain(SECRET)
  })
})

// This is the claim-to-tool seam; background polling cannot guard dispatch.
test.each(["ineligible", "unreachable"])("pre-dispatch state %s releases the claim without launching the tool", async (reason) => {
  const fake = fakeConvex({
    localClaimUnit: claims(unit(0)),
    localJobState: () => {
      if (reason === "unreachable") throw new Error("offline")
      return { keepGoing: false }
    },
    localReleaseUnit: settles({ kind: "released" }),
  })
  const generate = vi.fn(async () => generation("unused"))
  await start(fake.convex, { generate })
  expect(generate).not.toHaveBeenCalled()
  expect(fake.names().filter((name) => name === "localReleaseUnit")).toHaveLength(1)
  expect(call(fake, "localReleaseUnit")).toMatchObject({ unitId: "unit-0", claimToken: "token-0" })
  expect(fake.names()).not.toContain("localFailUnit")
})

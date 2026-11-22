// @vitest-environment node
/// <reference types="vite/client" />
// AI-LOCAL-2 backend (ADR-0057 decision 2): whole-page jobs run by the owner's
// local tool. These tests cover formulacms code only: the start helper, the
// runner mutations and their secret, the lease check, Resume, the audit row and
// the marker that refuses API runs. They never test Convex or the scheduler.
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { randomBytes } from "node:crypto"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { hashOwnerClaim } from "./lib/ownerClaim"
import { pageJobPool, apiTupleOf, erasePageJobsForUser } from "./cms/aiJobs"
import workpoolTest from "@convex-dev/workpool/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"

const fake = vi.hoisted(() => ({ generate: vi.fn() }))
vi.mock("ai", () => ({ generateText: fake.generate }))

const modules = import.meta.glob("./**/*.ts")
const OWNER = { subject: "local-job-owner", tokenIdentifier: "local-job-owner" }
const ROUTE = { engine: "claude" as const, model: "claude-sonnet-5-5", effort: "high" as const }
const CODEX_ROUTE = { engine: "codex" as const, model: "gpt-6.1-sol", effort: "medium" as const }

const writeInput = (count = 2) => ({
  kind: "write" as const,
  brief: "Explain the service",
  locale: "en" as const,
  meta: { title: "A service", slug: "service" },
  rows: Array.from({ length: count }, (_, index) => ({
    blockType: "hero-with-image",
    purpose: `Section ${index + 1}`,
  })),
})
const GOOD_TEXT = "[title]\nA clear headline\n[/title]"

type App = ReturnType<typeof convexTest>
type Owner = ReturnType<App["withIdentity"]>

/** An owner with no API key at all: the case a local job exists for. */
async function setup(
  opts: { api?: boolean; multilingual?: boolean } = {}
) {
  const t = convexTest({ schema, modules, publicationAuthority: "missing" })
  workpoolTest.register(t, "aiPageJobs")
  rateLimiterTest.register(t)
  await seedCommunityOwner(t, OWNER)
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: [
        "ai",
        ...(opts.multilingual ? ["multilingual"] : []),
      ].map((moduleId) => ({ moduleId, configVersion: 1 })),
    })
    await ctx.db.insert("siteSettings", {
      siteName: "Jobs",
      siteUrl: "https://example.test",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      timezone: "UTC",
      updatedAt: 1,
      ...(opts.api ? { aiRuntime: { selectedProvider: "openai" as const } } : {}),
    })
  })
  return { t, owner }
}
const newSecret = () => randomBytes(32).toString("base64url")
/** A runner secret and the hash the owner's server sends at Start. */
async function runner() {
  const secret = newSecret()
  return { secret, hash: await hashOwnerClaim(secret) }
}
async function startLocal(
  owner: Owner,
  opts: { count?: number; hash?: string; route?: typeof ROUTE | typeof CODEX_ROUTE } = {}
) {
  const r = await runner()
  const id = await owner.mutation(api.cms.aiLocalJobs.startLocalPageJob, {
    input: writeInput(opts.count ?? 2),
    localRoute: opts.route ?? ROUTE,
    runnerSecretHash: opts.hash ?? r.hash,
  })
  return { id, secret: r.secret, hash: r.hash }
}
async function source(owner: Owner) {
  return owner.mutation(api.cms.pages.create, {
    pageType: "page",
    status: "draft",
    title: "Source",
    slug: "source",
    content: {
      en: {
        title: "Source",
        metaTitle: "Meta",
        metaDescription: "Description",
        blocks: [],
      },
    },
  })
}
async function startLocalTranslation(t: App, owner: Owner) {
  const r = await runner()
  const pageId = await source(owner)
  const id = await owner.mutation(api.cms.aiLocalJobs.startLocalPageJob, {
    input: { kind: "translation", pageId, sourceLocale: "en", targetLocale: "fr" },
    localRoute: CODEX_ROUTE,
    runnerSecretHash: r.hash,
  })
  void t
  return { id, secret: r.secret, hash: r.hash }
}
const job = (t: App, id: Id<"aiJobs">) => t.run((ctx) => ctx.db.get("aiJobs", id))
const units = (t: App, id: Id<"aiJobs">) =>
  t.run((ctx) =>
    ctx.db
      .query("aiJobUnits")
      .withIndex("by_jobId_and_index", (q) => q.eq("jobId", id))
      .collect()
  )
const rows = (t: App, table: "aiAuditLog" | "aiSpendingAttempts" | "aiSpendingJobReservations" | "aiSpendingMonths") =>
  t.run((ctx) => ctx.db.query(table).collect())
const scheduled = (t: App) => t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
const claim = (owner: App | Owner, id: Id<"aiJobs">, secret: string) =>
  owner.mutation(api.cms.aiLocalJobs.localClaimUnit, { jobId: id, runnerSecret: secret })
const audit = { funding: "plan" as const, durationMs: 1200 }
const save = (
  t: App | Owner,
  id: Id<"aiJobs">,
  secret: string,
  c: { unitId: Id<"aiJobUnits">; claimToken: string },
  text = GOOD_TEXT
) =>
  t.mutation(api.cms.aiLocalJobs.localSaveUnit, {
    jobId: id,
    runnerSecret: secret,
    unitId: c.unitId,
    claimToken: c.claimToken,
    text,
    audit,
  })
async function claimed(t: App, id: Id<"aiJobs">, secret: string) {
  const result = await claim(t, id, secret)
  if (result.kind !== "unit") throw new Error(`expected a unit, got ${result.kind}`)
  return result
}
const setModules = (t: App, enabled: string[]) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.query("cmsModuleState").first())!
    await ctx.db.patch("cmsModuleState", row._id, {
      enabledModules: enabled.map((moduleId) => ({ moduleId, configVersion: 1 })),
    })
  })

beforeEach(() => {
  vi.stubEnv("OPENAI_API_KEY", "")
  vi.stubEnv("OPENROUTER_API_KEY", "")
  vi.stubEnv("ANTHROPIC_API_KEY", "")
  vi.stubEnv("CMS_AI_MODEL", "")
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-16T12:00:00Z"))
  fake.generate.mockReset().mockResolvedValue({
    text: "Clear text",
    finishReason: "stop",
    usage: { raw: { reported: true }, inputTokens: 1, outputTokens: 1 },
    finalStep: { response: { modelId: "gpt-5.6-terra" } },
  })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("local job start", () => {
  test("starts with no API key, no price, no reservation and no Workpool work", async () => {
    const enqueue = vi.spyOn(pageJobPool, "enqueueAction")
    const { t, owner } = await setup()
    const { id, hash } = await startLocal(owner)
    const j = (await job(t, id))!
    expect(j.state).toBe("running")
    expect(j.tuple).toBeUndefined()
    expect(j.localRoute).toEqual(ROUTE)
    expect(j.estimateMicros).toBe(0)
    expect(j.reservationKey).toBeUndefined()
    expect(j.runner).toMatchObject({ secretHash: hash })
    expect(j.runner!.leaseExpiresAt).toBeGreaterThanOrEqual(Date.now() + 90_000)
    expect(j.runner!.leaseExpiresAt).toBeLessThan(Date.now() + 91_000)
    expect((await units(t, id)).map((u) => [u.state, u.workId])).toEqual([
      ["waiting", undefined],
      ["waiting", undefined],
    ])
    expect(await rows(t, "aiSpendingJobReservations")).toEqual([])
    expect(await rows(t, "aiSpendingMonths")).toEqual([])
    expect(enqueue).not.toHaveBeenCalled()
    const check = (await scheduled(t)).find((s) => s._id === j.runner!.checkId)!
    expect(check.name).toContain("checkLocalRunner")
    expect(check.state.kind).toBe("pending")
  })

  test("the owner's session is required", async () => {
    const { t } = await setup()
    const stranger = t.withIdentity({ subject: "other", tokenIdentifier: "other" })
    const r = await runner()
    for (const caller of [t, stranger])
      await expect(
        caller.mutation(api.cms.aiLocalJobs.startLocalPageJob, {
          input: writeInput(),
          localRoute: ROUTE,
          runnerSecretHash: r.hash,
        })
      ).rejects.toThrow()
    expect(await t.run((ctx) => ctx.db.query("aiJobs").collect())).toEqual([])
  })

  test("only one job is active, and the rate limit applies", async () => {
    const { owner } = await setup()
    await startLocal(owner)
    await expect(startLocal(owner)).rejects.toThrow("AI_JOB_ALREADY_ACTIVE")
    // The shared limit (10 calls in a burst) also covers a local start.
    const second = await setup()
    let refused: unknown
    for (let i = 0; i < 14 && !refused; i++) {
      try {
        const started = await startLocal(second.owner, { count: 1 })
        await second.owner.mutation(api.cms.aiJobs.cancelPageJob, {
          jobId: started.id,
        })
      } catch (error) {
        refused = error
      }
    }
    expect(String(JSON.stringify((refused as { data?: unknown })?.data))).toMatch(
      /rate/i
    )
  })

  test("a malformed hash or an unsafe model name is refused", async () => {
    const { owner } = await setup()
    await expect(startLocal(owner, { hash: "not-a-hash" })).rejects.toThrow(
      "AI_JOB_INPUT_INVALID"
    )
    const r = await runner()
    await expect(
      owner.mutation(api.cms.aiLocalJobs.startLocalPageJob, {
        input: writeInput(),
        localRoute: { ...ROUTE, model: "bad model; rm -rf" },
        runnerSecretHash: r.hash,
      })
    ).rejects.toThrow("AI_JOB_INPUT_INVALID")
  })

  test("apiTupleOf refuses a local job", async () => {
    const { t, owner } = await setup()
    const { id } = await startLocal(owner)
    const j = (await job(t, id))!
    expect(() => apiTupleOf(j)).toThrow("AI_JOB_IS_LOCAL")
  })
})

describe("the local tool marker", () => {
  test("setAssistantLocalTool is owner-only", async () => {
    const { t } = await setup()
    const stranger = t.withIdentity({ subject: "other", tokenIdentifier: "other" })
    await expect(
      stranger.mutation(api.cms.aiSettings.setAssistantLocalTool, {
        assistant: "writing",
        on: true,
      })
    ).rejects.toThrow()
    await expect(
      t.mutation(api.cms.aiSettings.setAssistantLocalTool, {
        assistant: "writing",
        on: true,
      })
    ).rejects.toThrow()
  })

  test("with the marker on, API estimate, start and instant actions refuse; off, they work", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-openai")
    const { t, owner } = await setup({ api: true, multilingual: true })
    const set = (assistant: "writing" | "translation", on: boolean) =>
      owner.mutation(api.cms.aiSettings.setAssistantLocalTool, { assistant, on })
    const field = {
      blockType: "hero-with-image",
      fieldLabel: "Title",
      locale: "en",
      brief: "Describe our service",
    }
    const translateField = {
      text: "Hello",
      sourceLocale: "en",
      targetLocale: "fr",
    }
    const refusal = "AI_ASSISTANT_RUNS_ON_LOCAL_TOOL"

    await set("writing", true)
    await set("translation", true)
    await expect(
      owner.query(api.cms.aiJobs.estimatePageJob, { input: writeInput() })
    ).rejects.toThrow(refusal)
    await expect(
      owner.mutation(api.cms.aiJobs.startPageJob, { input: writeInput() })
    ).rejects.toThrow(refusal)
    await expect(
      owner.action(api.agents.contentWriter.generateField, field)
    ).rejects.toThrow(refusal)
    await expect(
      owner.action(api.agents.localizer.translateField, translateField)
    ).rejects.toThrow(refusal)
    expect(fake.generate).not.toHaveBeenCalled()
    // A local job is exactly what a marked assistant does.
    await expect(startLocal(owner)).resolves.toMatchObject({ id: expect.anything() })
    expect(await rows(t, "aiSpendingAttempts")).toEqual([])

    // Off: both assistants take API runs again.
    await set("writing", false)
    await set("translation", false)
    await owner.query(api.cms.aiJobs.estimatePageJob, { input: writeInput() })
    await owner.action(api.agents.contentWriter.generateField, field)
    await owner.action(api.agents.localizer.translateField, translateField)
    expect(fake.generate).toHaveBeenCalledTimes(2)
  })

  test("the marker is per assistant, and model or Instructions saves keep it", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-openai")
    const { t, owner } = await setup({ api: true, multilingual: true })
    await owner.mutation(api.cms.aiSettings.setAssistantLocalTool, {
      assistant: "writing",
      on: true,
    })
    // Translation is not marked: its API estimate is not refused for the marker.
    const pageId = await source(owner)
    await owner.query(api.cms.aiJobs.estimatePageJob, {
      input: { kind: "translation", pageId, sourceLocale: "en", targetLocale: "fr" },
    })
    // Saving Instructions for Writing keeps the marker.
    await owner.mutation(api.cms.aiSettings.setAssistant, {
      id: "writing",
      instructions: "Be brief.",
    })
    const settings = async () =>
      (await t.run((ctx) => ctx.db.query("siteSettings").first()))!.aiRuntime!
        .assistants!
    expect((await settings()).writing).toEqual({
      instructions: "Be brief.",
      localTool: true,
    })
    // Clearing the marker keeps the Instructions.
    await owner.mutation(api.cms.aiSettings.setAssistantLocalTool, {
      assistant: "writing",
      on: false,
    })
    expect((await settings()).writing).toEqual({ instructions: "Be brief." })
  })
})

describe("the runner", () => {
  test("every runner call refuses a wrong secret and a malformed one", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const c = await claimed(t, id, secret)
    const wrong = newSecret()
    for (const bad of [wrong, "short", "", secret + "x"]) {
      expect(await claim(t, id, bad)).toEqual({ kind: "refused" })
      expect(
        await t.mutation(api.cms.aiLocalJobs.localHeartbeat, { jobId: id, runnerSecret: bad })
      ).toEqual({ keepGoing: false })
      expect(await save(t, id, bad, c)).toEqual({ kind: "refused" })
      expect(
        await t.mutation(api.cms.aiLocalJobs.localFailUnit, {
          jobId: id, runnerSecret: bad, unitId: c.unitId, claimToken: c.claimToken,
          errorCategory: "LOCAL_PROCESS_FAILED", audit,
        })
      ).toEqual({ kind: "refused" })
      expect(
        await t.mutation(api.cms.aiLocalJobs.localReleaseUnit, {
          jobId: id, runnerSecret: bad, unitId: c.unitId, claimToken: c.claimToken,
        })
      ).toEqual({ kind: "refused" })
    }
    // Nothing moved.
    expect((await units(t, id))[0]!.state).toBe("inProgress")
    expect((await job(t, id))!.state).toBe("running")
    expect(await rows(t, "aiAuditLog")).toEqual([])
  })

  test("a write job claims one unit at a time with the finished prompt", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner, { count: 2 })
    const first = await claimed(t, id, secret)
    expect(first).toMatchObject({
      jobKind: "write",
      blockType: "hero-with-image",
      localRoute: ROUTE,
    })
    expect(first.prompt).toContain("Explain the service")
    expect(first.prompt).toContain("Section 1")
    expect(first.instructions.length).toBeGreaterThan(0)
    expect(await claim(t, id, secret)).toEqual({ kind: "wait" })
    expect(await save(t, id, secret, first)).toEqual({ kind: "saved" })
    const second = await claimed(t, id, secret)
    // The second section reads the first one as context.
    expect(second.prompt).toContain("Section 2")
    expect(second.instructions).toContain("A clear headline")
  })

  test("saved text is assembled into the block; all saved finishes the job", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner, { count: 2 })
    for (let i = 0; i < 2; i++)
      expect(await save(t, id, secret, await claimed(t, id, secret))).toEqual({ kind: "saved" })
    const j = (await job(t, id))!
    expect(j.state).toBe("done")
    expect(j.brief).toBeUndefined()
    const outputs = (await units(t, id)).map((u) => u.output as { type: string })
    expect(outputs.map((o) => o.type)).toEqual(["hero-with-image", "hero-with-image"])
    expect(JSON.stringify(outputs[0])).toContain("A clear headline")
    // The job card and result work for an owner with no API key.
    const progress = await owner.query(api.cms.aiJobs.pageJobProgress, {})
    expect(progress[0]).toMatchObject({
      jobId: id, state: "done", localTool: { engine: "claude" }, costMicros: 0,
    })
    const result = await owner.query(api.cms.aiJobs.pageJobResult, { jobId: id })
    expect(result.sections).toHaveLength(2)
    // The finish cancels the lease check and drops its id, so a later Expire,
    // erasure or Resume never cancels it again.
    expect(j.runner!.checkId).toBeUndefined()
    const checks = (await scheduled(t)).filter((s) => s.name.includes("checkLocalRunner"))
    expect(checks.every((s) => s.state.kind === "canceled")).toBe(true)
    // Expire of the finished job (day 7) works.
    vi.setSystemTime(j.expiresAt + 1)
    await t.mutation(internal.cms.aiJobs.expireJob, { jobId: id })
    expect((await job(t, id))!.state).toBe("expired")
    expect((await job(t, id))!.runner).toBeUndefined()
  })

  test("guard: a local job run end to end touches no spending and no Workpool", async () => {
    const enqueue = vi.spyOn(pageJobPool, "enqueueAction")
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner, { count: 3 })
    for (let i = 0; i < 3; i++) await save(t, id, secret, await claimed(t, id, secret))
    expect((await job(t, id))!.state).toBe("done")
    expect(await rows(t, "aiSpendingAttempts")).toEqual([])
    expect(await rows(t, "aiSpendingJobReservations")).toEqual([])
    expect(await rows(t, "aiSpendingMonths")).toEqual([])
    expect(enqueue).not.toHaveBeenCalled()
    expect(fake.generate).not.toHaveBeenCalled()
  })

  test("text that cannot be saved fails the unit and the job", async () => {
    const { t, owner } = await setup()
    // Empty text, over-limit text, and a block type that does not assemble.
    for (const bad of ["", "   \n", "x".repeat(200_001), "unknown"]) {
      const { id, secret } = await startLocal(owner, { count: 2 })
      const c = await claimed(t, id, secret)
      if (bad === "unknown")
        await t.run((ctx) => ctx.db.patch("aiJobUnits", c.unitId, { blockType: "no-such-block" }))
      expect(await save(t, id, secret, c, bad === "unknown" ? GOOD_TEXT : bad)).toEqual({
        kind: "unit-failed",
      })
      const j = (await job(t, id))!
      expect(j.state).toBe("failed")
      expect((await units(t, id)).map((u) => u.state)).toEqual(["failed", "waiting"])
      expect(await rows(t, "aiAuditLog")).toHaveLength(1)
      await owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query("aiAuditLog").collect()) await ctx.db.delete("aiAuditLog", row._id)
      })
    }
  })

  test("a translation runs at most two units at once and stores the text as is", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const { id, secret } = await startLocalTranslation(t, owner)
    const all = await units(t, id)
    expect(all.length).toBeGreaterThanOrEqual(3)
    const a = await claimed(t, id, secret)
    const b = await claimed(t, id, secret)
    expect(a.unitId).not.toBe(b.unitId)
    expect(a.jobKind).toBe("translation")
    expect(await claim(t, id, secret)).toEqual({ kind: "wait" })
    expect((await units(t, id)).filter((u) => u.state === "inProgress")).toHaveLength(2)
    expect(await save(t, id, secret, a, "Titre")).toEqual({ kind: "saved" })
    // One finished: the next unit may start.
    const c = await claimed(t, id, secret)
    expect(c.unitId).not.toBe(a.unitId)
    await save(t, id, secret, b, "Méta")
    await save(t, id, secret, c, "Description FR")
    for (;;) {
      const next = await claim(t, id, secret)
      if (next.kind !== "unit") break
      await save(t, id, secret, next, "Texte")
    }
    const j = (await job(t, id))!
    expect(j.state).toBe("done")
    expect(j.suggestion?.title).toBeTruthy()
    expect(j.reservationKey).toBeUndefined()
    expect(await rows(t, "aiSpendingAttempts")).toEqual([])
  })

  test("a negative or fractional duration is refused", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const c = await claimed(t, id, secret)
    for (const durationMs of [-1, 1.5])
      expect(
        await t.mutation(api.cms.aiLocalJobs.localSaveUnit, {
          jobId: id, runnerSecret: secret, unitId: c.unitId, claimToken: c.claimToken,
          text: GOOD_TEXT, audit: { funding: "plan", durationMs },
        })
      ).toEqual({ kind: "refused" })
    expect((await units(t, id))[0]!.state).toBe("inProgress")
  })

  test("a failed unit stops the job failed; a second report is refused", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const c = await claimed(t, id, secret)
    const fail = () =>
      t.mutation(api.cms.aiLocalJobs.localFailUnit, {
        jobId: id, runnerSecret: secret, unitId: c.unitId, claimToken: c.claimToken,
        errorCategory: "LOCAL_PROCESS_FAILED", audit,
      })
    expect(await fail()).toEqual({ kind: "recorded" })
    expect(await fail()).toEqual({ kind: "refused" })
    expect((await job(t, id))!.state).toBe("failed")
    expect((await units(t, id))[0]!.state).toBe("failed")
    expect(await claim(t, id, secret)).toEqual({ kind: "stop" })
  })

  test("after Cancel the heartbeat says stop; releasing the unit ends the job canceled", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const c = await claimed(t, id, secret)
    const beat = () =>
      t.mutation(api.cms.aiLocalJobs.localHeartbeat, { jobId: id, runnerSecret: secret })
    expect(await beat()).toEqual({ keepGoing: true })
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    // The tool is still running: the job waits for the runner.
    expect((await job(t, id))!.state).toBe("canceling")
    expect(await beat()).toEqual({ keepGoing: false })
    expect(await claim(t, id, secret)).toEqual({ kind: "stop" })
    expect(
      await t.mutation(api.cms.aiLocalJobs.localReleaseUnit, {
        jobId: id, runnerSecret: secret, unitId: c.unitId, claimToken: c.claimToken,
      })
    ).toEqual({ kind: "released" })
    expect((await job(t, id))!.state).toBe("canceled")
    const [released] = await units(t, id)
    expect(released!.state).toBe("waiting")
    expect(released!.claimToken).toBeUndefined()
    expect(await beat()).toEqual({ keepGoing: false })
    // Cancel with nothing in progress ends at once.
    const again = await startLocal(owner)
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: again.id })
    expect((await job(t, again.id))!.state).toBe("canceled")
  })

  test("localJobState answers like the heartbeat, writes nothing and keeps the lease", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const c = await claimed(t, id, secret)
    const state = (runnerSecret = secret) =>
      t.query(api.cms.aiLocalJobs.localJobState, { jobId: id, runnerSecret })
    const before = (await job(t, id))!
    const beforeScheduled = (await scheduled(t)).length
    expect(await state()).toEqual({ keepGoing: true })
    for (const bad of ["w".repeat(43), "short", ""])
      expect(await state(bad)).toEqual({ keepGoing: false })
    // No lease move, no new runner check, no row change.
    expect((await job(t, id))!).toEqual(before)
    expect((await scheduled(t)).length).toBe(beforeScheduled)
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    expect((await job(t, id))!.state).toBe("canceling")
    expect(await state()).toEqual({ keepGoing: false })
    await t.mutation(api.cms.aiLocalJobs.localReleaseUnit, {
      jobId: id, runnerSecret: secret, unitId: c.unitId, claimToken: c.claimToken,
    })
    expect((await job(t, id))!.state).toBe("canceled")
    expect(await state()).toEqual({ keepGoing: false })
  })

  test("a stale claim cannot save, and a module change stops the job", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const c = await claimed(t, id, secret)
    expect(await save(t, id, secret, { ...c, claimToken: "other-claim" })).toEqual({ kind: "refused" })
    await setModules(t, [])
    expect(await claim(t, id, secret)).toEqual({ kind: "stop" })
    // The unit still in progress holds the job in canceling until released.
    expect((await job(t, id))!.state).toBe("canceling")
  })
})

describe("the lease", () => {
  test.each([false, true])(
    "an expired job finishes its scheduled check when the lease is live=%s",
    async (leaseStillLive) => {
      const { t, owner } = await setup()
      const { id } = await startLocal(owner)
      const lease = (await job(t, id))!.runner!
      await t.run(async (ctx) => {
        await ctx.db.patch("aiJobs", id, {
          expiresAt: lease.leaseExpiresAt - 1_000,
          runner: {
            ...lease,
            leaseExpiresAt: lease.leaseExpiresAt + (leaseStillLive ? 5_000 : 0),
          },
        })
      })
      vi.advanceTimersByTime(lease.leaseExpiresAt - Date.now() + 1)
      await t.finishInProgressScheduledFunctions()
      expect((await job(t, id))!).toMatchObject({ state: "expired" })
      expect((await job(t, id))!.runner).toBeUndefined()
      expect((await scheduled(t)).find((s) => s._id === lease.checkId)!.state.kind).toBe("success")
    }
  )

  test("a silent runner: units wait again, the job fails with the local-app-stopped detail", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    await claimed(t, id, secret)
    vi.setSystemTime(Date.now() + 91_000)
    await t.mutation(internal.cms.aiLocalJobs.checkLocalRunner, { jobId: id })
    const j = (await job(t, id))!
    expect(j).toMatchObject({ state: "failed", stopDetail: "local-app-stopped" })
    for (const unit of await units(t, id)) {
      expect(unit.state).toBe("waiting")
      expect(unit.claimToken).toBeUndefined()
    }
    const progress = await owner.query(api.cms.aiJobs.pageJobProgress, {})
    expect(progress[0]).toMatchObject({
      state: "failed", stopDetail: "local-app-stopped", canResume: true,
    })
    // The silent runner cannot claim any more: its lease ran out.
    expect(await claim(t, id, secret)).toEqual({ kind: "refused" })
  })

  test("guard: after the lease runs out, every runner call is refused before the check runs", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner, { count: 2 })
    const c = await claimed(t, id, secret)
    const lease = (await job(t, id))!.runner!
    // Exactly the deadline: the lease is over.
    vi.setSystemTime(lease.leaseExpiresAt)
    const snapshot = async () => ({
      job: await job(t, id),
      units: await units(t, id),
      audit: await rows(t, "aiAuditLog"),
      scheduled: await scheduled(t),
    })
    const before = await snapshot()
    const unit = { jobId: id, runnerSecret: secret, unitId: c.unitId, claimToken: c.claimToken }
    expect(await claim(t, id, secret)).toEqual({ kind: "refused" })
    expect(
      await t.mutation(api.cms.aiLocalJobs.localHeartbeat, { jobId: id, runnerSecret: secret })
    ).toEqual({ keepGoing: false })
    expect(await save(t, id, secret, c)).toEqual({ kind: "refused" })
    expect(
      await t.mutation(api.cms.aiLocalJobs.localFailUnit, {
        ...unit, errorCategory: "LOCAL_PROCESS_FAILED", audit,
      })
    ).toEqual({ kind: "refused" })
    expect(await t.mutation(api.cms.aiLocalJobs.localReleaseUnit, unit)).toEqual({ kind: "refused" })
    // Nothing moved: no lease renewal, and the scheduled check is still pending.
    expect(await snapshot()).toEqual(before)
    expect(before.scheduled.find((s) => s._id === lease.checkId)!.state.kind).toBe("pending")
    await t.mutation(internal.cms.aiLocalJobs.checkLocalRunner, { jobId: id })
    expect((await job(t, id))!).toMatchObject({ state: "failed", stopDetail: "local-app-stopped" })
  })

  test("a heartbeat in time keeps the job running and moves the check", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const before = (await job(t, id))!.runner!
    vi.setSystemTime(Date.now() + 60_000)
    await t.mutation(api.cms.aiLocalJobs.localHeartbeat, { jobId: id, runnerSecret: secret })
    const after = (await job(t, id))!.runner!
    expect(after.leaseExpiresAt - before.leaseExpiresAt).toBeGreaterThanOrEqual(59_000)
    expect(after.leaseExpiresAt - before.leaseExpiresAt).toBeLessThan(61_000)
    expect(after.checkId).not.toBe(before.checkId)
    const all = await scheduled(t)
    expect(all.find((s) => s._id === before.checkId)!.state.kind).toBe("canceled")
    expect(all.find((s) => s._id === after.checkId)!.state.kind).toBe("pending")
    // The first check would have fired here; the lease is still fresh.
    vi.setSystemTime(Date.now() + 40_000)
    await t.mutation(internal.cms.aiLocalJobs.checkLocalRunner, { jobId: id })
    expect((await job(t, id))!.state).toBe("running")
    vi.setSystemTime(Date.now() + 60_000)
    await t.mutation(internal.cms.aiLocalJobs.checkLocalRunner, { jobId: id })
    expect((await job(t, id))!.state).toBe("failed")
  })

  test("Cancel with a dead runner ends after the lease", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    await claimed(t, id, secret)
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    expect((await job(t, id))!.state).toBe("canceling")
    vi.setSystemTime(Date.now() + 91_000)
    await t.mutation(internal.cms.aiLocalJobs.checkLocalRunner, { jobId: id })
    const j = (await job(t, id))!
    expect(j.state).toBe("canceled")
    expect(j.stopDetail).toBeUndefined()
    expect((await units(t, id))[0]!.state).toBe("waiting")
  })

  test("the check does nothing for a finished job", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner, { count: 1 })
    await save(t, id, secret, await claimed(t, id, secret))
    vi.setSystemTime(Date.now() + 120_000)
    await t.mutation(internal.cms.aiLocalJobs.checkLocalRunner, { jobId: id })
    expect((await job(t, id))!.state).toBe("done")
  })
})

describe("Resume", () => {
  test("the local twin rotates the secret and keeps saved units; the API Resume refuses", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner, { count: 3 })
    await save(t, id, secret, await claimed(t, id, secret))
    await claimed(t, id, secret)
    vi.setSystemTime(Date.now() + 91_000)
    await t.mutation(internal.cms.aiLocalJobs.checkLocalRunner, { jobId: id })
    expect((await job(t, id))!.state).toBe("failed")
    await expect(
      owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
    ).rejects.toThrow("AI_JOB_RESUME_LOCAL")
    const next = await runner()
    // The job kind must be the job's own.
    await expect(
      owner.mutation(api.cms.aiLocalJobs.resumeLocalPageJob, {
        jobId: id, kind: "translation", runnerSecretHash: next.hash,
      })
    ).rejects.toThrow("AI_JOB_NOT_RESUMABLE")
    expect((await job(t, id))!.state).toBe("failed")
    await owner.mutation(api.cms.aiLocalJobs.resumeLocalPageJob, {
      jobId: id, kind: "write", runnerSecretHash: next.hash,
    })
    const j = (await job(t, id))!
    expect(j.state).toBe("running")
    expect(j.stopDetail).toBeUndefined()
    expect(j.runner!.secretHash).toBe(next.hash)
    expect((await units(t, id)).map((u) => [u.state, u.reused])).toEqual([
      ["saved", true], ["waiting", false], ["waiting", false],
    ])
    // The old runner is locked out; the new one works.
    expect(await claim(t, id, secret)).toEqual({ kind: "refused" })
    const c = await claimed(t, id, next.secret)
    // The claim carries the frozen route, so a restarted runner needs no memory.
    expect(c.localRoute).toEqual(ROUTE)
    expect(c.prompt).toContain("Section 2")
    expect(await save(t, id, next.secret, c)).toEqual({ kind: "saved" })
  })

  test("a running local job is not resumable, and an API job is not local", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-openai")
    const { t, owner } = await setup({ api: true })
    const { id } = await startLocal(owner)
    const r = await runner()
    await expect(
      owner.mutation(api.cms.aiLocalJobs.resumeLocalPageJob, { jobId: id, kind: "write", runnerSecretHash: r.hash })
    ).rejects.toThrow("AI_JOB_NOT_RESUMABLE")
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    const apiId = await owner.mutation(api.cms.aiJobs.startPageJob, { input: writeInput(1) })
    await expect(
      owner.mutation(api.cms.aiLocalJobs.resumeLocalPageJob, { jobId: apiId, kind: "write", runnerSecretHash: r.hash })
    ).rejects.toThrow("AI_JOB_NOT_LOCAL")
    void t
  })
})

describe("the audit row", () => {
  test("one metadata-only row per saved or failed unit; a second save is refused", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner, { count: 2, route: CODEX_ROUTE })
    const first = await claimed(t, id, secret)
    expect(await save(t, id, secret, first, GOOD_TEXT)).toEqual({ kind: "saved" })
    expect(await save(t, id, secret, first, GOOD_TEXT)).toEqual({ kind: "refused" })
    let log = await rows(t, "aiAuditLog")
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      kind: "page-generate-fill",
      authId: expect.any(String),
      success: true,
      funding: "plan",
      selectedLane: "local-build",
      selectedEngine: "codex-cli",
      selectedModel: "gpt-6.1-sol",
      selectedReasoning: "medium",
      phase: "page-fill",
      attempts: 1,
      attemptId: first.claimToken,
      runId: id,
      unitId: first.unitId,
      tokenUsage: {},
    })
    // No prompt and no output in the row.
    expect(JSON.stringify(log[0])).not.toContain("clear headline")
    expect(JSON.stringify(log[0])).not.toContain("Explain the service")
    const second = await claimed(t, id, secret)
    await t.mutation(api.cms.aiLocalJobs.localFailUnit, {
      jobId: id, runnerSecret: secret, unitId: second.unitId, claimToken: second.claimToken,
      errorCategory: "TIMEOUT", audit: { funding: "api-key" },
    })
    log = await rows(t, "aiAuditLog")
    expect(log).toHaveLength(2)
    expect(log[1]).toMatchObject({
      success: false, errorCode: "TIMEOUT", funding: "api-key", attemptId: second.claimToken,
    })
  })

  test("a translation unit is stored as a page translation row", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const { id, secret } = await startLocalTranslation(t, owner)
    await save(t, id, secret, await claimed(t, id, secret), "Titre")
    const log = await rows(t, "aiAuditLog")
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({
      kind: "page-translate", profile: "brand-translation", phase: "translation",
      selectedEngine: "codex-cli", success: true,
    })
  })
})

describe("API jobs and local mutations", () => {
  test("an API job never reaches the local mutations", async () => {
    vi.stubEnv("OPENAI_API_KEY", "fake-openai")
    const { t, owner } = await setup({ api: true })
    const apiId = await owner.mutation(api.cms.aiJobs.startPageJob, { input: writeInput(1) })
    const apiJob = (await job(t, apiId))!
    expect(apiJob.localRoute).toBeUndefined()
    expect(apiJob.tuple).toBeDefined()
    expect(apiJob.reservationKey).toBeDefined()
    const s = newSecret()
    expect(await claim(t, apiId, s)).toEqual({ kind: "refused" })
    expect(
      await t.mutation(api.cms.aiLocalJobs.localHeartbeat, { jobId: apiId, runnerSecret: s })
    ).toEqual({ keepGoing: false })
  })

  test("the Workpool claim and save never take a local job", async () => {
    const { t, owner } = await setup()
    const { id } = await startLocal(owner)
    const [unit] = await units(t, id)
    expect(
      await t.mutation(internal.cms.aiJobs.claimUnit, { jobId: id, unitId: unit!._id })
    ).toBeNull()
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id, unitId: unit!._id, claimToken: "x", output: "text",
      })
    ).toBe(false)
    expect((await units(t, id))[0]!.state).toBe("waiting")
  })

  test("erasing the owner's jobs removes a local job and its lease check", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const { authId, runner: lease } = (await job(t, id))!
    const checkId = lease!.checkId!
    await t.run((ctx) => erasePageJobsForUser(ctx, authId))
    expect(await job(t, id)).toBeNull()
    expect((await scheduled(t)).find((s) => s._id === checkId)!.state.kind).toBe("canceled")
    expect(await claim(t, id, secret)).toEqual({ kind: "refused" })
  })
})

describe("a tool that is too old", () => {
  const fail = (
    t: App,
    id: Id<"aiJobs">,
    secret: string,
    c: { unitId: Id<"aiJobUnits">; claimToken: string },
    stopDetail?: "local-tool-outdated"
  ) =>
    t.mutation(api.cms.aiLocalJobs.localFailUnit, {
      jobId: id, runnerSecret: secret, unitId: c.unitId, claimToken: c.claimToken,
      errorCategory: "LOCAL_PROCESS_FAILED", audit,
      ...(stopDetail ? { stopDetail } : {}),
    })

  test("the detail is recorded, the job can resume, the audit row is unchanged, and Resume clears it", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    const c = await claimed(t, id, secret)
    expect(await fail(t, id, secret, c, "local-tool-outdated")).toEqual({ kind: "recorded" })
    expect((await job(t, id))!).toMatchObject({ state: "failed", stopDetail: "local-tool-outdated" })
    expect((await owner.query(api.cms.aiJobs.pageJobProgress, {}))[0]).toMatchObject({
      state: "failed", stopDetail: "local-tool-outdated", canResume: true,
    })
    const log = await rows(t, "aiAuditLog")
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ success: false, errorCode: "LOCAL_PROCESS_FAILED" })
    const next = await runner()
    await owner.mutation(api.cms.aiLocalJobs.resumeLocalPageJob, {
      jobId: id, kind: "write", runnerSecretHash: next.hash,
    })
    expect((await job(t, id))!.stopDetail).toBeUndefined()
  })

  test("a failure without the detail leaves none", async () => {
    const { t, owner } = await setup()
    const { id, secret } = await startLocal(owner)
    await fail(t, id, secret, await claimed(t, id, secret))
    expect((await job(t, id))!.stopDetail).toBeUndefined()
  })

  test("only the unit that stops the job writes the detail (two translation units)", async () => {
    for (const order of [
      { first: "local-tool-outdated", second: undefined, expected: "local-tool-outdated" },
      { first: undefined, second: "local-tool-outdated", expected: undefined },
    ] as const) {
      const { t, owner } = await setup({ multilingual: true })
      const { id, secret } = await startLocalTranslation(t, owner)
      const a = await claimed(t, id, secret)
      const b = await claimed(t, id, secret)
      await fail(t, id, secret, a, order.first)
      // The first failure stops the job; the second unit is still in progress.
      expect((await job(t, id))!.state).toBe("canceling")
      await fail(t, id, secret, b, order.second)
      const j = (await job(t, id))!
      expect(j.state).toBe("failed")
      expect(j.stopDetail).toBe(order.expected)
    }
  })

  test("the progress list does not fail for an API job while the AI module is not ready", async () => {
    const { t, owner } = await setup()
    const { id } = await startLocal(owner)
    await t.run(async (ctx) => {
      const { _id, _creationTime, localRoute, runner, ...rest } = (await ctx.db.get("aiJobs", id))!
      void _id, _creationTime, localRoute, runner
      await ctx.db.insert("aiJobs", rest)
    })
    const list = await owner.query(api.cms.aiJobs.pageJobProgress, {})
    expect(list.map((row) => row.jobId)).toEqual([id])
  })
})

describe("a content type switched to one language after Start (ADR-0037 amendment)", () => {
  const switchOffFrench = (t: App) =>
    t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        untranslatedContentTypes: [{ pageType: "page", locale: "en" }],
      })
    })

  test("a runner claim after the switch stops the job", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const { id, secret } = await startLocalTranslation(t, owner)
    await switchOffFrench(t)
    expect(await claim(owner, id, secret)).toEqual({ kind: "stop" })
    expect((await job(t, id))!.state).toBe("canceled")
  })

  test("local Resume refuses, and the list says the job is not resumable", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const { id, secret } = await startLocalTranslation(t, owner)
    await claimed(t, id, secret)
    vi.setSystemTime(Date.now() + 91_000)
    await t.mutation(internal.cms.aiLocalJobs.checkLocalRunner, { jobId: id })
    expect((await job(t, id))!.state).toBe("failed")
    const row = async () =>
      (await owner.query(api.cms.aiJobs.pageJobProgress, {})).find(
        (entry) => entry.jobId === id
      )!
    expect((await row()).canResume).toBe(true)
    await switchOffFrench(t)
    expect((await row()).canResume).toBe(false)
    const next = await runner()
    await expect(
      owner.mutation(api.cms.aiLocalJobs.resumeLocalPageJob, {
        jobId: id,
        kind: "translation",
        runnerSecretHash: next.hash,
      })
    ).rejects.toThrow("CONTENT_TYPE_TRANSLATION_OFF")
    expect((await job(t, id))!.state).toBe("failed")
  })
})

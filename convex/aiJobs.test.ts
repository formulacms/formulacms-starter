// @vitest-environment node
/// <reference types="vite/client" />
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import { api, internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import { executeGeneration } from "../lib/ai/execute-generation"
import { resolveRuntimeSelection, resolveRuntimeTuple } from "./lib/aiConfig"
import type {
  ApiGenerationAdapter,
  GenerationRequest,
} from "../lib/ai/execution-contract"
import {
  runtimeProviderAvailability,
  type RuntimeGenerationOptions,
} from "./lib/ai"
import type {
  GenerationAccounting,
  AttemptAdmissionRequest,
} from "../lib/ai/accounting-contract"
import { hashOwnerClaim } from "./lib/ownerClaim"
import { taskProfileTuple } from "../lib/ai/task-profiles"
import { estimateMicros, quote } from "../lib/ai/price-quote"
import { translatePageContent } from "./lib/agents/translationWorkflow"
import workpoolTest from "@convex-dev/workpool/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import type { WorkId } from "@convex-dev/workpool"
import { installedSliceDefs, type Primitive } from "./lib/slices"

const fake = vi.hoisted(() => ({
  beforeAdmission: vi.fn(),
  openai: true,
  openrouter: false,
  enforceCap: false,
  text: "",
  generate: vi.fn<ApiGenerationAdapter["generate"]>(),
}))
// Retain parked enforcement tests through the pure helper's explicit test input.
vi.mock("../lib/ai/price-quote", async (original) => {
  const actual = await original<typeof import("../lib/ai/price-quote")>()
  return {
    ...actual,
    effectiveMonthlyCapMicros: (stored: number | undefined) =>
      actual.effectiveMonthlyCapMicros(stored, fake.enforceCap),
  }
})
vi.mock("./lib/ai", async (original) => {
  const actual = await original<typeof import("./lib/ai")>()
  return {
    ...actual,
    createRuntimeAccounting: (...args: Parameters<typeof actual.createRuntimeAccounting>) => {
      const accounting = actual.createRuntimeAccounting(...args)
      const admit = accounting.admit
      accounting.admit = async (request) => {
        await fake.beforeAdmission(request)
        return admit(request)
      }
      return accounting
    },
    runtimeProviderAvailability: () => ({
      openai: fake.openai,
      openrouter: fake.openrouter,
      anthropic: false,
    }),
    generateRuntimeText: async (
      legacyModelId: string | undefined,
      options: RuntimeGenerationOptions,
      accounting: GenerationAccounting
    ) => {
      const selection = resolveRuntimeSelection(
        options.selectedProvider,
        runtimeProviderAvailability()
      )
      const tuple = options.assistant
        ? actual.resolveAssistantRuntimeTuple(options.assistant, {
            ...options,
            legacyModelId,
          })
        : resolveRuntimeTuple({
            selection,
            profile: options.profile,
            legacyModelId,
            providerDefaults: options.providerDefaults,
            taskDefaults: options.taskDefaults,
            modelOverrides: options.modelOverrides,
          }).tuple
      const request = {
        target: { lane: "runtime", provider: tuple.provider },
        tuple,
        profile: options.profile,
        phase: options.phase,
        instructions:
          options.instructions === undefined
            ? undefined
            : (
                await import("../lib/ai/task-profiles")
              ).prependAssistantInstructions(
                options.assistant?.instructions,
                options.instructions
              ),
        system:
          options.system === undefined
            ? undefined
            : (
                await import("../lib/ai/task-profiles")
              ).prependAssistantInstructions(
                options.assistant?.instructions,
                options.system
              ),
        input:
          options.prompt !== undefined
            ? { prompt: options.prompt }
            : { messages: options.messages! },
        requirements: { inputModalities: ["text"], structuredOutput: false },
        output: { kind: "text" },
      } as GenerationRequest<string>
      return executeGeneration(
        request,
        { provider: tuple.provider, generate: fake.generate },
        accounting
      )
    },
  }
})
const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "page-job-owner",
  tokenIdentifier: "https://convex.test|page-job-owner",
}
const writeInput = (count = 2) => ({
  kind: "write" as const,
  brief: "Explain the service",
  locale: "en" as const,
  meta: {
    title: "A service",
    slug: "service",
    metaTitle: "Service",
    metaDescription: "About the service",
  },
  rows: Array.from({ length: count }, (_, index) => ({
    sliceType: "hero-with-image",
    purpose: `Section ${index + 1}`,
  })),
})
type App = ReturnType<typeof convexTest>
async function setup(
  opts: { legacy?: boolean; multilingual?: boolean; timezone?: string } = {}
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
      timezone: opts.timezone ?? "UTC",
      updatedAt: 1,
      ...(opts.legacy
        ? { aiDefaultModel: "google/gemini-2.5-flash" }
        : { aiRuntime: { selectedProvider: "openai" as const } }),
    })
    if (opts.legacy)
      await ctx.db.insert("openRouterCatalogModels", {
        modelId: "google/gemini-2.5-flash",
        name: "Legacy model",
        inputModalities: ["text"],
        structuredOutput: false,
        reasoningEfforts: [],
        ceilingInputPerM: 0.3,
        ceilingOutputPerM: 2.5,
        syncedAt: Date.now(),
      })
  })
  return { t, owner }
}
const job = (t: App, id: Id<"aiJobs">) =>
  t.run((ctx) => ctx.db.get("aiJobs", id))
const units = (t: App, id: Id<"aiJobs">) =>
  t.run((ctx) =>
    ctx.db
      .query("aiJobUnits")
      .withIndex("by_jobId_and_index", (q) => q.eq("jobId", id))
      .collect()
  )
const status = (t: App) =>
  t.query(internal.cms.ai.monthStatus, { now: Date.now() })
const start = (owner: ReturnType<App["withIdentity"]>, count = 2) =>
  owner.mutation(api.cms.aiJobs.startPageJob, { input: writeInput(count) })
async function callback(
  t: App,
  row: Doc<"aiJobUnits">,
  kind: "success" | "failed" | "canceled" = "success"
) {
  await t.mutation(internal.cms.aiJobs.onComplete, {
    workId: row.workId! as WorkId,
    context: { jobId: row.jobId, unitId: row._id },
    result:
      kind === "success"
        ? { kind, returnValue: null }
        : kind === "failed"
          ? { kind, error: "FAKE_FAILURE" }
          : { kind },
  })
}
async function run(
  t: App,
  id: Id<"aiJobs">,
  index = 0,
  outcome: "success" | "failed" = "success"
) {
  const row = (await units(t, id))[index]!
  await t.action(internal.agents.pageJobWorker.runUnit, {
    jobId: id,
    unitId: row._id,
  })
  await callback(t, row, outcome)
}
async function finish(t: App, id: Id<"aiJobs">) {
  for (let i = 0; i < 65; i++) {
    const rows = await units(t, id)
    const row = rows.find((row) => row.workId)
    if (!row) break
    await run(t, id, row.index)
  }
  expect((await job(t, id))?.state).toBe("done")
}
async function cancelQueued(
  t: App,
  owner: ReturnType<App["withIdentity"]>,
  id: Id<"aiJobs">
) {
  await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
  for (const row of await units(t, id))
    if (row.workId && row.state !== "inProgress")
      await callback(t, row, "canceled")
}
/** An English page. Start refuses a target that has content, so French is opt-in. */
async function source(
  t: App,
  owner: ReturnType<App["withIdentity"]>,
  title = "Source",
  opts: { withFrench?: boolean } = {}
) {
  return owner.mutation(api.cms.pages.create, {
    pageType: "page",
    status: "draft",
    title,
    slug: "source",
    content: {
      en: {
        title,
        metaTitle: "Meta",
        metaDescription: "Description",
        slices: [],
      },
      ...(opts.withFrench
        ? { fr: { title: "Original français", slices: [] } }
        : {}),
    },
  })
}
async function translate(
  owner: ReturnType<App["withIdentity"]>,
  pageId: Id<"pages">
) {
  return owner.mutation(api.cms.aiJobs.startPageJob, {
    input: {
      kind: "translation",
      pageId,
      sourceLocale: "en",
      targetLocale: "fr",
    },
  })
}
async function claim(t: App, id: Id<"aiJobs">, index = 0) {
  const row = (await units(t, id))[index]!
  return t.mutation(internal.cms.aiJobs.claimUnit, {
    jobId: id,
    unitId: row._id,
  })
}
async function admit(
  t: App,
  id: Id<"aiJobs">,
  index = 0,
  key = "manual-attempt",
  extra: Partial<AttemptAdmissionRequest> = {}
) {
  const j = (await job(t, id))!,
    row = (await units(t, id))[index]!
  return t.mutation(internal.cms.ai.admitRuntimeAttempt, {
    authId: OWNER.subject,
    request: {
      attemptKey: key,
      anchorAttemptKey: j.reservationKey!,
      runId: id,
      unitId: row._id,
      provider: "openai",
      modelId: "gpt-5.6-terra",
      lane: "runtime",
      profile: "editorial-copy",
      phase: "page-fill",
      inputTokens: 100,
      imageTokens: 0,
      maxOutputTokens: 100,
      ...extra,
    },
  })
}
const settle = (t: App, attemptKey: string) =>
  t.mutation(internal.cms.ai.settleRuntimeAttempt, {
    attemptKey,
    outcome: "completed",
    usage: {
      inputTokens: 10,
      noCacheInputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 2,
    },
  })
async function setCap(t: App, cap: number) {
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").first())!
    await ctx.db.patch("siteSettings", settings._id, {
      aiMonthlyCapMicros: cap,
    })
  })
}
beforeEach(() => {
  fake.beforeAdmission.mockReset()
  vi.stubEnv("OPENAI_API_KEY", "jobs-fake-key")
  vi.useFakeTimers()
  vi.setSystemTime(new Date("2026-11-07T12:00:00Z"))
  fake.openai = true
  fake.openrouter = false
  fake.enforceCap = false
  vi.stubEnv("OPENROUTER_API_KEY", "")
  vi.stubEnv("ANTHROPIC_API_KEY", "")
  fake.generate.mockReset()
  fake.text = "TITLE: A generated title\nDESCRIPTION: A generated description"
  fake.generate.mockImplementation(async (request) => ({
    text: fake.text,
    finishReason: "stop",
    actualModel: request.tuple.model,
    usage: {
      inputTokens: 10,
      noCacheInputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 3,
    },
  }))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe("AI1 U1b registered job path and spending", () => {
  test("test catalog vi.mock reaches glob-loaded registered functions; write runs sequentially and leaves suggestions off the Page", async () => {
    const { t, owner } = await setup()
    const estimate = await owner.query(api.cms.aiJobs.estimatePageJob, {
      input: writeInput(),
    })
    const id = await start(owner)
    expect((await status(t)).reservedMicros).toBe(estimate.estimateMicros)
    expect((await units(t, id)).filter((row) => row.workId)).toHaveLength(1)
    await finish(t, id)
    const j = (await job(t, id))!
    expect(j.brief).toBeUndefined()
    expect(j.costMicros).toBeGreaterThan(0)
    const page = await owner.query(api.cms.pages.getForEdit, { id: j.pageId })
    expect((page!.page.content!.en as { slices: unknown[] }).slices).toEqual([])
    expect(
      (await units(t, id)).every((row) => row.state === "saved" && row.output)
    ).toBe(true)
    expect((await status(t)).reservedMicros).toBe(0)
    expect(fake.generate).toHaveBeenCalledTimes(2)
    const progress = await owner.query(api.cms.aiJobs.pageJobProgress, {})
    expect(progress[0]).toMatchObject({
      jobId: id,
      state: "done",
      costMicros: j.costMicros,
    })
    expect(
      progress[0]!.units.every((row) => !("output" in row) && !("input" in row))
    ).toBe(true)
    await owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    expect(await owner.query(api.cms.aiJobs.pageJobProgress, {})).toEqual([])
  })
  test("legacy-openrouter selection starts a job and the worker uses the pinned legacy tuple", async () => {
    fake.openai = false
    fake.openrouter = true
    vi.stubEnv("OPENROUTER_API_KEY", "fake-legacy-key")
    vi.stubEnv("OPENAI_API_KEY", "")
    const { t, owner } = await setup({ legacy: true })
    const id = await start(owner, 1)
    expect((await job(t, id))!.tuple).toEqual({
      mode: "legacy",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    })
    await finish(t, id)
    expect(fake.generate.mock.calls[0]![0].tuple).toEqual(
      (await job(t, id))!.tuple
    )
    expect((await status(t)).spentMicros).toBeGreaterThan(0)
  })
  test("Start at exactly the cap admits; one micro over refuses atomically", async () => {
    fake.enforceCap = true
    const { t, owner } = await setup()
    const estimate = (
      await owner.query(api.cms.aiJobs.estimatePageJob, {
        input: writeInput(1),
      })
    ).estimateMicros
    await setCap(t, estimate - 1)
    await expect(start(owner, 1)).rejects.toThrow("cap")
    expect(await t.run((ctx) => ctx.db.query("pages").collect())).toEqual([])
    await setCap(t, estimate)
    const id = await start(owner, 1)
    expect((await status(t)).reservedMicros).toBe(estimate)
    expect((await job(t, id))!.state).toBe("running")
  })
  test("two Starts race and only one reserves and creates a shell", async () => {
    const { t, owner } = await setup()
    const results = await Promise.allSettled([start(owner), start(owner)])
    expect(
      results.filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    expect(await t.run((ctx) => ctx.db.query("aiJobs").collect())).toHaveLength(
      1
    )
    expect(await t.run((ctx) => ctx.db.query("pages").collect())).toHaveLength(
      1
    )
  })
  test("duplicate workers claim once; stale-token and unsettled-output saves refuse", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    const c = (await claim(t, id))!
    await t.action(internal.agents.pageJobWorker.runUnit, {
      jobId: id,
      unitId: c.unit._id,
    })
    expect(fake.generate).not.toHaveBeenCalled()
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c.unit._id,
        claimToken: c.claimToken,
        output: "not a typed write slice",
      })
    ).toBe(false)
    await admit(t, id)
    const sample = (await import("./lib/slices/sample")).createSampleSlice(
      "hero-with-image"
    )
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c.unit._id,
        claimToken: c.claimToken,
        output: sample,
      })
    ).toBe(false)
    await settle(t, "manual-attempt")
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c.unit._id,
        claimToken: "stale",
        output: sample,
      })
    ).toBe(false)
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c.unit._id,
        claimToken: c.claimToken,
        output: sample,
      })
    ).toBe(true)
  })
  test("failed onComplete after saved output still completes the job and releases exactly once", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    const row = (await units(t, id))[0]!
    await run(t, id, 0, "failed")
    const before = await status(t)
    await callback(t, row, "failed")
    expect((await job(t, id))!.state).toBe("done")
    expect(await status(t)).toEqual(before)
  })
  test("Cancel during last unit allows its saved output and ends done", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    const c = (await claim(t, id))!
    await admit(t, id)
    await settle(t, "manual-attempt")
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    const sample = (await import("./lib/slices/sample")).createSampleSlice(
      "hero-with-image"
    )
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c.unit._id,
        claimToken: c.claimToken,
        output: sample,
      })
    ).toBe(true)
    await callback(t, c.unit)
    expect((await job(t, id))!.state).toBe("done")
    expect((await status(t)).reservedMicros).toBe(0)
  })
})

describe("AI1 U1b recovery and counterexamples", () => {
  test.each(["write", "translation"] as const)(
    "Resume waits for open attempts before replacing failed %s work",
    async (kind) => {
      const { t, owner } = await setup({ multilingual: kind === "translation" })
      await setCap(t, 10_000_000)
      const id =
        kind === "write"
          ? await start(owner, 1)
          : await translate(
              owner,
              await owner.mutation(api.cms.pages.create, {
                pageType: "page",
                status: "draft",
                title: "Source",
                slug: "settling-source",
                content: {
                  en: {
                    title: "Source",
                    metaTitle: "",
                    metaDescription: "",
                    slices: [],
                  },
                },
              })
            )
      expect(await units(t, id)).toHaveLength(1)
      const first = (await claim(t, id))!
      const oldKey = `settling-old-${kind}`
      const admission = await admit(t, id, 0, oldKey)
      await callback(t, first.unit, "failed")
      expect((await job(t, id))!.state).toBe("failed")
      const failedUnits = await units(t, id)
      expect(failedUnits).toHaveLength(1)
      expect(failedUnits[0]).toMatchObject({
        state: "failed",
        attemptKeys: [oldKey],
      })
      expect(failedUnits[0]!.workId).toBeUndefined()
      const openAttempt = await t.run((ctx) =>
        ctx.db
          .query("aiSpendingAttempts")
          .withIndex("by_attemptKey", (q) => q.eq("attemptKey", oldKey))
          .unique()
      )
      expect(openAttempt!.state).toBe("open")
      expect(openAttempt!.chargedMicros).toBeUndefined()
      expect(
        (await owner.query(api.cms.aiJobs.pageJobProgress, {}))[0]!.canResume
      ).toBe(false)
      await expect(
        owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
      ).rejects.toThrow("AI_JOB_STILL_SETTLING")
      await t.mutation(internal.cms.ai.settleAttemptAtDeadline, {
        attemptKey: oldKey,
      })
      expect(
        (await owner.query(api.cms.aiJobs.pageJobProgress, {}))[0]!.canResume
      ).toBe(true)
      await owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
      const replacement = (await claim(t, id))!
      const newKey = `settling-new-${kind}`
      await admit(t, id, 0, newKey)
      const newCharge = (await settle(t, newKey))!.chargedMicros
      const output =
        kind === "write"
          ? (await import("./lib/slices/sample")).createSampleSlice(
              "hero-with-image"
            )
          : "Texte traduit"
      expect(
        await t.mutation(internal.cms.aiJobs.saveUnit, {
          jobId: id,
          unitId: replacement.unit._id,
          claimToken: replacement.claimToken,
          output,
        })
      ).toBe(true)
      await callback(t, replacement.unit)
      expect((await job(t, id))!.state).toBe("done")
      const total = admission.estimateMicros + newCharge
      expect((await job(t, id))!.costMicros).toBe(total)
      expect(await status(t)).toMatchObject({
        spentMicros: total,
        reservedMicros: 0,
      })
    }
  )
  test("Resume after failure reuses saved units, preserves cost and two Resumes race once", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 3)
    await run(t, id, 0)
    const row = (await units(t, id))[1]!
    await callback(t, row, "failed")
    expect((await job(t, id))!.state).toBe("failed")
    const priorCost = (await job(t, id))!.costMicros
    const estimates = await owner.query(api.cms.aiJobs.pageJobProgress, {})
    expect(estimates[0]!.canResume).toBe(true)
    const result = await Promise.allSettled([
      owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id }),
      owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id }),
    ])
    expect(result.filter((row) => row.status === "fulfilled")).toHaveLength(1)
    expect((await units(t, id))[0]!.reused).toBe(true)
    expect((await job(t, id))!.costMicros).toBe(priorCost)
    await finish(t, id)
    expect(fake.generate).toHaveBeenCalledTimes(3)
    expect(
      (await owner.query(api.cms.aiJobs.pageJobProgress, {}))[0]!.reusedCount
    ).toBe(1)
  })
  test("job attempts draw from remainder, admit a shortfall, and refuse one micro beyond the cap", async () => {
    fake.enforceCap = true
    const { t, owner } = await setup()
    const id = await start(owner, 2)
    const amount = estimateMicros(
      quote("openai", "gpt-5.6-terra", { inputTokens: 100 }),
      100,
      100
    )
    await t.run(async (ctx) => {
      const j = (await ctx.db.get("aiJobs", id))!
      const reservation = (await ctx.db
        .query("aiSpendingJobReservations")
        .withIndex("by_reservationKey", (q) =>
          q.eq("reservationKey", j.reservationKey!)
        )
        .unique())!
      await ctx.db.patch("aiSpendingJobReservations", reservation._id, {
        remainingMicros: amount - 1,
      })
      await ctx.db.patch("aiSpendingMonths", reservation.monthId, {
        reservedMicros: amount - 1,
      })
    })
    await setCap(t, amount)
    await claim(t, id, 0)
    await admit(t, id, 0, "shortfall-admitted")
    expect((await status(t)).reservedMicros).toBe(amount)
    const reservation = await t.run((ctx) =>
      ctx.db.query("aiSpendingJobReservations").first()
    )
    expect(reservation!.remainingMicros).toBe(0)
    await claim(t, id, 1)
    await expect(admit(t, id, 1, "shortfall-refused")).rejects.toThrow("cap")
    expect((await status(t)).reservedMicros).toBe(amount)
  })
  test("D4 overrun stops remaining units while an admitted in-flight result still saves", async () => {
    fake.enforceCap = true
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await source(t, owner)
    const id = await translate(owner, pageId)
    const c0 = (await claim(t, id, 0))!,
      c1 = (await claim(t, id, 1))!
    await admit(t, id, 0, "overrun-0")
    await admit(t, id, 1, "overrun-1")
    const total = (await status(t)).reservedMicros
    await setCap(t, total)
    await t.mutation(internal.cms.ai.settleRuntimeAttempt, {
      attemptKey: "overrun-0",
      outcome: "completed",
      usage: {
        inputTokens: 10,
        noCacheInputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        providerCostUsd: 1,
      },
    })
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c0.unit._id,
        claimToken: c0.claimToken,
        output: "Premier",
      })
    ).toBe(true)
    await callback(t, c0.unit)
    expect((await job(t, id))!.stopReason).toBe("capped")
    await settle(t, "overrun-1")
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c1.unit._id,
        claimToken: c1.claimToken,
        output: "Deuxième",
      })
    ).toBe(true)
    await callback(t, c1.unit)
    for (const row of await units(t, id))
      if (row.workId) await callback(t, row, "canceled")
    expect((await job(t, id))!.state).toBe("capped")
    expect(
      (await units(t, id)).filter((row) => row.state === "saved")
    ).toHaveLength(2)
    expect((await status(t)).reservedMicros).toBe(0)
  })
  test("D4 overrun stays capped when refused work completes first", async () => {
    fake.enforceCap = true
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      title: "Source",
      slug: "overrun-source",
      content: {
        en: {
          title: "Source",
          metaTitle: "Meta",
          metaDescription: "",
          slices: [],
        },
      },
    })
    const id = await translate(owner, pageId)
    expect(await units(t, id)).toHaveLength(2)
    const cap = (await status(t)).reservedMicros
    await setCap(t, cap)
    const first = (await claim(t, id, 0))!
    const refused = (await claim(t, id, 1))!
    await admit(t, id, 0, "overrun-first")
    await t.mutation(internal.cms.ai.settleRuntimeAttempt, {
      attemptKey: "overrun-first",
      outcome: "completed",
      usage: {
        inputTokens: 10,
        noCacheInputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 1,
        providerCostUsd: 1,
      },
    })
    expect((await status(t)).spentMicros).toBeGreaterThan(cap)
    await expect(admit(t, id, 1, "overrun-refused")).rejects.toThrow("cap")
    await callback(t, refused.unit, "failed")
    expect((await job(t, id))!.stopReason).toBe("capped")
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: first.unit._id,
        claimToken: first.claimToken,
        output: "Premier",
      })
    ).toBe(true)
    await callback(t, first.unit)
    expect((await job(t, id))!.state).toBe("capped")
    expect((await units(t, id))[0]).toMatchObject({
      state: "saved",
      output: "Premier",
    })
    expect((await status(t)).reservedMicros).toBe(0)
    expect((await status(t)).spentMicros).toBeGreaterThan(cap)
  })
  test("Resume refuses when another job is reserved and the display counts that reservation", async () => {
    const { t, owner } = await setup()
    const id = await start(owner)
    await cancelQueued(t, owner, id)
    const other = await start(owner)
    const before = await status(t)
    await expect(
      owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
    ).rejects.toThrow("ALREADY_ACTIVE")
    expect(
      (await owner.query(api.cms.aiJobs.pageJobProgress, {})).find(
        (row) => row.jobId === id
      )!.canResume
    ).toBe(false)
    expect(await status(t)).toEqual(before)
    expect((await job(t, other))!.state).toBe("running")
  })
  test.each(["ai", "key", "multilingual"] as const)(
    "%s readiness loss at claim cancels without a provider call; saved units remain",
    async (loss) => {
      const { t, owner } = await setup({ multilingual: true })
      const pageId = await source(t, owner)
      const id = await translate(owner, pageId)
      await run(t, id, 0)
      if (loss === "key") {
        fake.openai = false
        vi.stubEnv("OPENAI_API_KEY", "")
      } else
        await t.run(async (ctx) => {
          const state = (await ctx.db.query("cmsModuleState").first())!
          const off = loss === "ai" ? "ai" : "multilingual"
          await ctx.db.patch("cmsModuleState", state._id, {
            enabledModules: state.enabledModules.filter(
              (entry) => entry.moduleId !== off
            ),
          })
        })
      expect(await claim(t, id, 1)).toBeNull()
      for (const row of await units(t, id))
        if (row.workId) await callback(t, row, "canceled")
      expect((await job(t, id))!.state).toBe("canceled")
      expect((await units(t, id))[0]!.state).toBe("saved")
      expect(fake.generate).toHaveBeenCalledTimes(1)
      expect((await status(t)).reservedMicros).toBe(0)
    }
  )
  test("a worker dying after admit has a scheduled deadline settle at its estimate", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    await claim(t, id)
    const receipt = await admit(t, id)
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    const deadline = scheduled.find(
      (row) => row.name === "cms/ai:settleAttemptAtDeadline"
    )
    expect(deadline).toBeDefined()
    // convex-test advances its transaction timestamp by 1ms with a frozen clock.
    expect(deadline!.scheduledTime).toBeCloseTo(Date.now() + 150000, -1)
    await t.mutation(internal.cms.ai.settleAttemptAtDeadline, {
      attemptKey: "manual-attempt",
    })
    expect((await status(t)).spentMicros).toBe(receipt.estimateMicros)
    await callback(t, (await units(t, id))[0]!, "failed")
    expect((await status(t)).reservedMicros).toBe(0)
    expect((await job(t, id))!.costMicros).toBe(receipt.estimateMicros)
    expect(fake.generate).not.toHaveBeenCalled()
    expect(
      (await owner.query(api.cms.aiJobs.pageJobProgress, {}))[0]!.canResume
    ).toBe(true)
    await owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
    expect((await job(t, id))!.state).toBe("running")
  })
  test("expiry is an immediate access boundary; Resume and late saves cannot extend it", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    const c = (await claim(t, id))!
    await admit(t, id)
    await settle(t, "manual-attempt")
    const expiresAt = (await job(t, id))!.expiresAt
    vi.setSystemTime(expiresAt)
    const sample = (await import("./lib/slices/sample")).createSampleSlice(
      "hero-with-image"
    )
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c.unit._id,
        claimToken: c.claimToken,
        output: sample,
      })
    ).toBe(false)
    expect(
      (await owner.query(api.cms.aiJobs.pageJobProgress, {}))[0]
    ).toMatchObject({ state: "expired", canResume: false, units: [] })
    await expect(
      owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
    ).rejects.toThrow("NOT_RESUMABLE")
    await t.mutation(internal.cms.aiJobs.expireJob, { jobId: id })
    const j = (await job(t, id))!
    expect(j.expiresAt).toBe(expiresAt)
    expect(j.brief).toBeUndefined()
    expect((await units(t, id))[0]!.output).toBeUndefined()
    expect((await status(t)).reservedMicros).toBe(0)
  })
  test("expiry of a done unreviewed write removes temporary output and keeps the Page shell", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    await finish(t, id)
    const before = (await job(t, id))!
    vi.setSystemTime(before.expiresAt)
    await t.mutation(internal.cms.aiJobs.expireJob, { jobId: id })
    expect((await job(t, id))!.state).toBe("expired")
    expect((await units(t, id))[0]!.output).toBeUndefined()
    expect(
      await t.run((ctx) => ctx.db.get("pages", before.pageId))
    ).not.toBeNull()
    await owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    expect(await owner.query(api.cms.aiJobs.pageJobProgress, {})).toEqual([])
  })
  test("erasure settles an open attempt, releases the open reservation, cancels queued units and fences late writes while keeping Page", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 2)
    const c = (await claim(t, id))!,
      admitted = await admit(t, id)
    const before = (await job(t, id))!
    await owner.mutation(api.cms.aiAuditLog.deleteAuditLogForUser, {
      authId: OWNER.subject,
    })
    expect(await job(t, id)).toBeNull()
    expect(await units(t, id)).toEqual([])
    expect(
      await t.run((ctx) => ctx.db.query("aiSpendingJobReservations").collect())
    ).toEqual([])
    expect(
      await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())
    ).toEqual([])
    expect(await t.run((ctx) => ctx.db.query("aiAuditLog").collect())).toEqual(
      []
    )
    expect((await status(t)).spentMicros).toBe(admitted.estimateMicros)
    expect((await status(t)).reservedMicros).toBe(0)
    expect(
      await t.mutation(internal.cms.aiJobs.claimUnit, {
        jobId: id,
        unitId: c.unit._id,
      })
    ).toBeNull()
    const sample = (await import("./lib/slices/sample")).createSampleSlice(
      "hero-with-image"
    )
    expect(
      await t.mutation(internal.cms.aiJobs.saveUnit, {
        jobId: id,
        unitId: c.unit._id,
        claimToken: c.claimToken,
        output: sample,
      })
    ).toBe(false)
    await callback(t, c.unit, "failed")
    expect(await settle(t, "manual-attempt")).toBeNull()
    expect(
      await t.run((ctx) => ctx.db.get("pages", before.pageId))
    ).not.toBeNull()
    expect(fake.generate).not.toHaveBeenCalled()
  })
  test("reservation month is fixed across November 30 at 23:30 Toronto and late attempts remain in November", async () => {
    vi.setSystemTime(new Date("2026-12-01T04:30:00Z"))
    const { t, owner } = await setup({ timezone: "America/Toronto" })
    const id = await start(owner, 2)
    vi.setSystemTime(new Date("2026-12-01T05:01:00Z"))
    await finish(t, id)
    const months = await t.run((ctx) =>
      ctx.db.query("aiSpendingMonths").collect()
    )
    expect(months).toHaveLength(1)
    expect(months[0]!.monthKey).toBe("2026-11")
    expect(months[0]!.spentMicros).toBe((await job(t, id))!.costMicros)
    expect(months[0]!.reservedMicros).toBe(0)
  })
  test("legacy U1a attempts without job anchors still reserve and settle independently", async () => {
    const { t } = await setup()
    const request: AttemptAdmissionRequest = {
      attemptKey: "old-u1a",
      provider: "openai",
      modelId: "gpt-5.6-terra",
      lane: "runtime",
      phase: "content-generation",
      profile: "editorial-copy",
      inputTokens: 100,
      imageTokens: 0,
      maxOutputTokens: 100,
    }
    const admission = await t.mutation(internal.cms.ai.admitRuntimeAttempt, {
      authId: OWNER.subject,
      request,
    })
    expect((await status(t)).reservedMicros).toBe(admission.estimateMicros)
    const receipt = await settle(t, request.attemptKey)
    expect((await status(t)).reservedMicros).toBe(0)
    expect((await status(t)).spentMicros).toBe(receipt!.chargedMicros)
  })
  test("translation pins source, queues at most six, assembles exactly the instant traversal and never changes live drafts", async () => {
    fake.text = "Traduit"
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await source(t, owner, "Pinned source")
    const id = await translate(owner, pageId)
    const initial = (await job(t, id))!
    const pinned = initial.sourcePage!
    expect(
      (await units(t, id)).filter((row) => row.workId).length
    ).toBeLessThanOrEqual(6)
    // Simulate a later draft edit: the pinned unit inputs must be independent of the live source.
    await t.run(async (ctx) => {
      const draft = (await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique())!
      if (draft.pageType !== "page") throw new Error("Expected Page fixture")
      await ctx.db.patch("pageLocaleDrafts", draft._id, {
        content: { ...draft.content, title: "Changed after Start" },
      })
    })
    await finish(t, id)
    const expected = await translatePageContent(pinned, {
      translateText: async () => "Traduit",
    })
    const { draft, ...suggestion } = (await job(t, id))!.suggestion!
    expect(suggestion).toEqual(expected)
    // The stored draft is the pinned source draft with the translation applied.
    expect(draft).toMatchObject({
      pageType: "page",
      localized: { title: "Traduit" },
    })
    expect((await job(t, id))!.sourcePage).toBeUndefined()
    expect((await units(t, id)).every((row) => row.input === undefined)).toBe(
      true
    )
    const page = await owner.query(api.cms.pages.getForEdit, { id: pageId })
    expect(page!.page.content!.en!.title).toBe("Changed after Start")
    expect(page!.page.content!.fr).toBeUndefined()
  })
  test("real registered workpool and nested batchWorker deliver the identity-free action and completion", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    // Advance only the immediate queue; do not run the seven-day expiry timer.
    for (let i = 0; i < 40 && (await job(t, id))!.state !== "done"; i++) {
      await vi.advanceTimersByTimeAsync(250)
      await t.finishInProgressScheduledFunctions()
    }
    expect((await job(t, id))!.state).toBe("done")
    expect(fake.generate).toHaveBeenCalledTimes(1)
    expect((await status(t)).reservedMicros).toBe(0)
  })
})

describe("AI1 U1b boundaries and six-unit window", () => {
  test("translation keeps six work items in the window and releases one slot per completion", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await source(t, owner)
    const sample = (await import("./lib/slices/sample")).createSampleSlice(
      "hero-with-image"
    )
    const description = JSON.stringify({
      type: "doc",
      content: Array.from({ length: 10 }, (_, index) => ({
        type: "paragraph",
        content: [{ type: "text", text: `Paragraph ${index}` }],
      })),
    })
    await t.run(async (ctx) => {
      const draft = (await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique())!
      if (draft.pageType !== "page") throw new Error("Expected Page fixture")
      await ctx.db.patch("pageLocaleDrafts", draft._id, {
        content: {
          ...draft.content,
          slices: [{ ...sample, primary: { ...sample.primary, description } }],
        },
      })
    })
    const id = await translate(owner, pageId)
    const rows = await units(t, id)
    expect(rows.length).toBeGreaterThan(6)
    expect(rows.filter((row) => row.workId)).toHaveLength(6)
    await run(t, id, 0)
    const after = await units(t, id)
    expect(after.filter((row) => row.workId)).toHaveLength(6)
    expect(after[6]!.workId).toBeDefined()
    await finish(t, id)
  })
  test("owner-only inputs and supported write limits refuse before persistence", async () => {
    const { t, owner } = await setup()
    const stranger = t.withIdentity({
      subject: "stranger",
      tokenIdentifier: "https://convex.test|stranger",
    })
    await expect(start(stranger)).rejects.toThrow()
    await expect(
      owner.mutation(api.cms.aiJobs.startPageJob, { input: writeInput(9) })
    ).rejects.toThrow("INPUT_INVALID")
    await expect(
      owner.mutation(api.cms.aiJobs.startPageJob, {
        input: { ...writeInput(), brief: "b".repeat(2001) },
      })
    ).rejects.toThrow("INPUT_INVALID")
    expect(await t.run((ctx) => ctx.db.query("pages").collect())).toEqual([])
    expect(await t.run((ctx) => ctx.db.query("aiJobs").collect())).toEqual([])
    const id = await start(owner, 1)
    await expect(
      stranger.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    ).rejects.toThrow()
    expect(fake.generate).not.toHaveBeenCalled()
  })
  test("a retryable provider error buys one attempt only; Resume is the owner's explicit retry", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    const row = (await units(t, id))[0]!
    fake.generate.mockRejectedValue(
      Object.assign(new Error("Rate limited"), {
        statusCode: 429,
        retryAfterMs: 0,
      })
    )
    await expect(
      t.action(internal.agents.pageJobWorker.runUnit, {
        jobId: id,
        unitId: row._id,
      })
    ).rejects.toThrow()
    expect(fake.generate).toHaveBeenCalledTimes(1)
    expect((await units(t, id))[0]!.attemptKeys).toHaveLength(1)
    await callback(t, row, "failed")
    expect((await job(t, id))!.state).toBe("failed")
    const attempts = await t.run((ctx) =>
      ctx.db.query("aiSpendingAttempts").collect()
    )
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.chargedMicros).toBe(attempts[0]!.estimateMicros)
    expect((await status(t)).reservedMicros).toBe(0)
  })
  test("reservation conservation includes open attempts plus open job remainders", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 2)
    const check = async () => {
      const [attempts, reservations, month] = await Promise.all([
        t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect()),
        t.run((ctx) => ctx.db.query("aiSpendingJobReservations").collect()),
        status(t),
      ])
      const held =
        attempts.reduce((sum, row) => sum + row.reservedMicros, 0) +
        reservations
          .filter((row) => row.state === "open")
          .reduce((sum, row) => sum + row.remainingMicros, 0)
      expect(month.reservedMicros).toBe(held)
    }
    await check()
    await claim(t, id)
    await admit(t, id)
    await check()
    await settle(t, "manual-attempt")
    await check()
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    await callback(t, (await units(t, id))[0]!, "failed")
    await check()
    expect((await status(t)).reservedMicros).toBe(0)
  })
  test("job runtime validator admits legacy tuples while persisted-setting validators still refuse them", async () => {
    const { validate } = await import("convex-helpers/validators")
    const { runtimeModelTupleValidator, apiModelTupleValidator } =
      await import("./lib/aiValidators")
    const legacy = {
      mode: "legacy",
      provider: "openrouter",
      model: "google/gemini-2.5-flash",
    }
    expect(validate(runtimeModelTupleValidator, legacy)).toBe(true)
    expect(validate(apiModelTupleValidator, legacy)).toBe(false)
  })
})

describe("whole-job reservation retention", () => {
  test("pre-start estimate counts existing holds and the job itself has no 150-second deadline", async () => {
    fake.enforceCap = true
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    const held = (await status(t)).reservedMicros
    const next = await owner.query(api.cms.aiJobs.estimatePageJob, {
      input: writeInput(1),
    })
    await setCap(t, held + next.estimateMicros - 1)
    expect(
      (
        await owner.query(api.cms.aiJobs.estimatePageJob, {
          input: writeInput(1),
        })
      ).fits
    ).toBe(false)
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(
      scheduled.some((row) => row.name.includes("settleAttemptAtDeadline"))
    ).toBe(false)
    expect(
      scheduled.find((row) => row.name === "cms/aiJobs:expireJob")!
        .scheduledTime
    ).toBeCloseTo((await job(t, id))!.expiresAt, -1)
  })
  test("erasure drains old Resume reservation metadata past the first reservation batch", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    const reservation = (await t.run((ctx) =>
      ctx.db.query("aiSpendingJobReservations").first()
    ))!
    await t.run(async (ctx) => {
      for (let i = 0; i < 201; i++)
        await ctx.db.insert("aiSpendingJobReservations", {
          reservationKey: `old-resume-${i}`,
          authId: OWNER.subject,
          jobId: id,
          monthId: reservation.monthId,
          monthKey: reservation.monthKey,
          estimateMicros: 0,
          remainingMicros: 0,
          state: "released",
          createdAt: Date.now(),
          releasedAt: Date.now(),
        })
    })
    await owner.mutation(api.cms.aiAuditLog.deleteAuditLogForUser, {
      authId: OWNER.subject,
    })
    expect(
      await t.run((ctx) => ctx.db.query("aiSpendingJobReservations").collect())
    ).toEqual([])
    expect(await job(t, id)).toBeNull()
    expect((await status(t)).reservedMicros).toBe(0)
  })
})

test("erasure stops a translation window with both an open attempt and queued work IDs", async () => {
  const { t, owner } = await setup({ multilingual: true })
  const pageId = await source(t, owner)
  const id = await translate(owner, pageId)
  const before = await units(t, id)
  expect(before[1]!.workId).toBeDefined()
  expect(before[1]!.state).toBe("waiting")
  const c = (await claim(t, id, 0))!
  const receipt = await admit(t, id, 0, "erased-translation-attempt")
  await owner.mutation(api.cms.aiAuditLog.deleteAuditLogForUser, {
    authId: OWNER.subject,
  })
  expect(
    await t.mutation(internal.cms.aiJobs.claimUnit, {
      jobId: id,
      unitId: before[1]!._id,
    })
  ).toBeNull()
  expect(
    await t.mutation(internal.cms.aiJobs.saveUnit, {
      jobId: id,
      unitId: c.unit._id,
      claimToken: c.claimToken,
      output: "Late translated text",
    })
  ).toBe(false)
  await callback(t, before[1]!, "canceled")
  expect(await t.run((ctx) => ctx.db.query("aiJobUnits").collect())).toEqual([])
  expect((await status(t)).spentMicros).toBe(receipt.estimateMicros)
  expect((await status(t)).reservedMicros).toBe(0)
  expect(fake.generate).not.toHaveBeenCalled()
})

test("S2b jobs freeze tuple and instructions before later assistant edits", async () => {
  const { t, owner } = await setup()
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").first())!
    await ctx.db.patch("siteSettings", settings._id, {
      aiRuntime: {
        selectedProvider: "openai",
        assistants: {
          writing: {
            tuple: (await import("../lib/ai/task-profiles")).taskProfileTuple(
              "openai",
              "editorial-copy"
            ),
            instructions: "Frozen voice.",
          },
        },
      },
    })
  })
  const id = await start(owner, 1)
  const frozen = (await job(t, id))!
  expect(frozen.assistantInstructions).toBe("Frozen voice.")
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").first())!
    await ctx.db.patch("siteSettings", settings._id, {
      aiRuntime: {
        selectedProvider: "openai",
        assistants: {
          writing: {
            tuple: {
              mode: "catalog",
              provider: "openai",
              model: "gpt-5.6-sol",
              reasoning: { kind: "effort", effort: "high" },
            },
            instructions: "Later voice.",
          },
        },
      },
    })
  })
  await finish(t, id)
  const request = fake.generate.mock.calls[0]![0]
  expect(request.tuple).toEqual(frozen.tuple)
  expect(request.instructions).toMatch(/^Frozen voice\.\n\n/)
  expect(request.instructions).not.toContain("Later voice.")
})

test("S2b claim rethrows invalid module state without canceling the job", async () => {
  const { t, owner } = await setup()
  const id = await start(owner, 1)
  await t.run(async (ctx) => {
    const state = (await ctx.db.query("cmsModuleState").first())!
    await ctx.db.patch("cmsModuleState", state._id, {
      enabledModules: [{ moduleId: "unknown-module", configVersion: 1 }],
    })
  })
  await expect(claim(t, id)).rejects.toThrow("CMS_MODULE_STATE_INVALID")
  expect((await job(t, id))!.state).toBe("running")
  expect(fake.generate).not.toHaveBeenCalled()
})

async function repairJob(kind: "write" | "translation") {
  const f = await setup({ multilingual: kind === "translation" })
  await f.t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").first())!
    await ctx.db.patch("siteSettings", settings._id, { aiRuntime: {
      selectedProvider: "openai",
      assistants: { [kind === "write" ? "writing" : "translation"]: {
        tuple: taskProfileTuple("openai", kind === "write" ? "editorial-copy" : "brand-translation"),
        instructions: "Frozen repair voice.",
      } },
    } })
  })
  const id = kind === "write" ? await start(f.owner, 1) : await translate(f.owner, await source(f.t, f.owner))
  return { ...f, id }
}
async function moveRepairSettings(t: App) {
  // Aggregate readiness remains healthy; the job keeps its frozen OpenAI tuple.
  vi.stubEnv("ANTHROPIC_API_KEY", "repair-healthy-anthropic")
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").first())!
    await ctx.db.patch("siteSettings", settings._id, { aiRuntime: {
      selectedProvider: "anthropic", assistants: {
        writing: { tuple: taskProfileTuple("anthropic", "editorial-copy"), instructions: "New voice." },
        help: { tuple: taskProfileTuple("anthropic", "grounded-help") },
        translation: { tuple: taskProfileTuple("anthropic", "brand-translation"), instructions: "New voice." },
      },
    } })
  })
}
async function repairHealth(t: App, state: "refused" | "unreachable") {
  await t.run(async (ctx) => ctx.db.insert("aiProviderHealth", {
    provider: "openai", keyFingerprint: await hashOwnerClaim("jobs-fake-key"),
    state, observedAt: Date.now(), sourceAttemptKey: "repair-after-claim",
  }))
}
async function drainRepairCallbacks(t: App, id: Id<"aiJobs">) {
  for (const row of await units(t, id))
    if (row.workId) await callback(t, row, "canceled")
}
for (const kind of ["write", "translation"] as const) {
  test.each(["refused", "unreachable"] as const)(
    `R2 page worker ${kind}: %s after claim checks frozen provider at admission`,
    async (state) => {
      const { t, owner, id } = await repairJob(kind)
      await moveRepairSettings(t)
      let healthBefore: unknown
      fake.beforeAdmission.mockImplementationOnce(async (request) => {
        expect((await units(t, id))[0]!.state).toBe("inProgress")
        expect(request.provider).toBe("openai")
        expect(request.modelId).toBe((await job(t, id))!.tuple.model)
        expect(request.phase).toBe(kind === "write" ? "page-fill" : "translation")
        await repairHealth(t, state)
        healthBefore = await t.run((ctx) => ctx.db.query("aiProviderHealth").collect())
      })
      const requestReservationKey = (await job(t, id))!.reservationKey!
      const row = (await units(t, id))[0]!
      const work = t.action(internal.agents.pageJobWorker.runUnit, { jobId: id, unitId: row._id })
      if (state === "refused") {
        await expect(work).rejects.toMatchObject({ data: expect.objectContaining({
          category: "AUTH_REQUIRED", attempts: 0, retryable: false, nextAction: "authenticate-provider",
          selected: expect.objectContaining({ lane: "runtime", provider: "openai", model: (await job(t, id))!.tuple.model }),
        }) })
        expect(fake.generate).not.toHaveBeenCalled()
        expect(await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())).toEqual([])
        expect(await t.run((ctx) => ctx.db.query("aiProviderHealth").collect())).toEqual(healthBefore)
        await callback(t, row, "failed")
        await drainRepairCallbacks(t, id)
        expect((await job(t, id))!.state).toBe("failed")
        expect((await status(t)).reservedMicros).toBe(0)
        const reservation = await t.run((ctx) => ctx.db.query("aiSpendingJobReservations")
          .withIndex("by_reservationKey", (q) => q.eq("reservationKey", (requestReservationKey))).unique())
        expect(reservation).toMatchObject({ state: "released", remainingMicros: 0 })
        expect((await job(t, id))!.assistantInstructions).toBe("Frozen repair voice.")
        expect((await units(t, id)).every((unit) => !unit.workId)).toBe(true)
        await t.run(async (ctx) => ctx.db.delete("aiProviderHealth", (await ctx.db.query("aiProviderHealth").first())!._id))
        await owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
        expect((await job(t, id))!.assistantInstructions).toBe("Frozen repair voice.")
      } else {
        await work
        expect(fake.generate).toHaveBeenCalledTimes(1)
        expect(await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())).toHaveLength(1)
      }
    }
  )
  test(`R2 control: ${kind} refusal before claim cancels without provider work`, async () => {
    const { t, id } = await repairJob(kind)
    await moveRepairSettings(t)
    await repairHealth(t, "refused")
    expect(await claim(t, id)).toBeNull()
    await drainRepairCallbacks(t, id)
    expect((await job(t, id))!.state).toBe("canceled")
    expect((await job(t, id))!.assistantInstructions).toBe("Frozen repair voice.")
    expect(fake.generate).not.toHaveBeenCalled()
  })
  test.each(["done", "expired", "erased"] as const)(
    `R2 ${kind}: frozen instructions removed when %s`, async (state) => {
      const { t, owner, id } = await repairJob(kind)
      await moveRepairSettings(t)
      expect((await job(t, id))!.assistantInstructions).toBe("Frozen repair voice.")
      if (state === "done") {
        await finish(t, id)
        expect(fake.generate.mock.calls[0]![0].instructions).toMatch(/^Frozen repair voice\.\n\n/)
      } else if (state === "expired") {
        vi.setSystemTime((await job(t, id))!.expiresAt + 1)
        await t.mutation(internal.cms.aiJobs.expireJob, { jobId: id })
      } else {
        await owner.mutation(api.cms.aiAuditLog.deleteAuditLogForUser, { authId: OWNER.subject })
        expect(await job(t, id)).toBeNull()
        return
      }
      expect((await job(t, id))!.state).toBe(state)
      expect((await job(t, id))!.assistantInstructions).toBeUndefined()
    }
  )
  test.each(["canceled", "failed", "capped"] as const)(
    `R2 control: ${kind} instructions survive %s and actual Resume`, async (state) => {
      const { t, owner, id } = await repairJob(kind)
      await moveRepairSettings(t)
      expect((await job(t, id))!.assistantInstructions).toBe("Frozen repair voice.")
      if (state === "canceled") {
        await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
        expect((await job(t, id))!.state).toBe("canceling")
      } else if (state === "failed") {
        const claimed = (await claim(t, id))!
        await callback(t, claimed.unit, "failed")
      } else {
        fake.enforceCap = true
        await setCap(t, 0)
        expect(await claim(t, id)).toBeNull()
      }
      expect((await job(t, id))!.assistantInstructions).toBe("Frozen repair voice.")
      await drainRepairCallbacks(t, id)
      expect((await job(t, id))!.state).toBe(state)
      expect((await job(t, id))!.assistantInstructions).toBe("Frozen repair voice.")
      fake.enforceCap = false
      await owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
      expect((await job(t, id))!.state).toBe("running")
      expect((await job(t, id))!.assistantInstructions).toBe("Frozen repair voice.")
      await run(t, id)
      expect(fake.generate.mock.calls[0]![0].instructions).toMatch(/^Frozen repair voice\.\n\n/)
    }
  )
  test.each(["refused", "missing", "unreachable"] as const)(
    `R2 Resume projection ${kind}: %s matches frozen-provider enforcement`, async (state) => {
      const { t, owner, id } = await repairJob(kind)
      await cancelQueued(t, owner, id)
      await moveRepairSettings(t)
      if (state === "missing") {
        vi.stubEnv("OPENAI_API_KEY", "")
        fake.openai = false
      } else await repairHealth(t, state)
      const progress = (await owner.query(api.cms.aiJobs.pageJobProgress, {})).find((entry) => entry.jobId === id)!
      expect(progress.canResume).toBe(state === "unreachable")
      const resume = owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
      if (state === "unreachable") {
        await resume
        expect((await job(t, id))!.state).toBe("running")
      } else await expect(resume).rejects.toThrow("AI_JOB_PROVIDER_UNAVAILABLE")
    }
  )
}

test.each(["anthropic", "openrouter", "openai"] as const)(
  "S3 seam a page translation %s freezes the assistant primary default",
  async (provider) => {
    const { t, owner } = await setup({ multilingual: true })
    vi.stubEnv("ANTHROPIC_API_KEY", provider === "anthropic" ? "fake-anthropic" : "")
    vi.stubEnv("OPENROUTER_API_KEY", provider === "openrouter" ? "fake-openrouter" : "")
    vi.stubEnv("OPENAI_API_KEY", provider === "openai" ? "fake-openai" : "")
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, { aiRuntime: { selectedProvider: provider } })
    })
    if (provider === "openrouter") {
      // Real jobs require the existing synchronized pricing seam, unlike instant prepare.
      const { OPENROUTER_API_CATALOG } = await import("../lib/ai/capabilities/openrouter-api")
      await t.run(async (ctx) => {
        for (const profile of ["mechanical-translation", "editorial-copy"] as const) {
          const modelId = taskProfileTuple(provider, profile).model
          const capability = OPENROUTER_API_CATALOG[modelId]!
          await ctx.db.insert("openRouterCatalogModels", {
            modelId, name: capability.name, inputModalities: [...capability.inputModalities],
            structuredOutput: capability.structuredOutput,
            reasoningEfforts: capability.reasoning.kind === "effort" ? [...capability.reasoning.supportedEfforts] : [],
            ceilingInputPerM: 1, ceilingOutputPerM: 5, syncedAt: Date.now(),
          })
        }
      })
    }
    const id = await translate(owner, await source(t, owner))
    const frozen = (await job(t, id))!
    // This assertion must fail on the old brand-translation catalog fallback.
    expect(frozen.tuple).toEqual(taskProfileTuple(provider, "mechanical-translation"))
    const settings = await owner.query(api.cms.aiSettings.status, {})
    expect(frozen.tuple).toEqual(settings.assistants.find((a) => a.id === "translation")!.effective)
    await cancelQueued(t, owner, id)
    const writeId = await start(owner, 1)
    expect((await job(t, writeId))!.tuple).toEqual(
      settings.assistants.find((a) => a.id === "writing")!.effective
    )
    expect(fake.generate).not.toHaveBeenCalled()
  }
)

// ---- Write page with AI: review, accept and dismiss (server half) ----------
type Owner = ReturnType<App["withIdentity"]>
const SLUG_ONE = "service"
async function pageRows(t: App, pageId: Id<"pages">, locale = "en") {
  return t.run(async (ctx) => ({
    life: (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!,
    shared: (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!,
    states: await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .collect(),
    draft: await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique(),
  }))
}
const draftSlices = async (t: App, pageId: Id<"pages">, locale = "en") =>
  ((
    (await pageRows(t, pageId, locale)).draft?.content as
      { slices?: { id: string }[] } | undefined
  )?.slices ?? []) as { id: string }[]
/** The owner saves through the real editor mutation, like a second tab would. */
async function ownerSave(
  t: App,
  owner: Owner,
  pageId: Id<"pages">,
  edit: { locale?: string; slices?: unknown[]; title?: string } = {}
) {
  const locale = edit.locale ?? "en"
  const rows = await pageRows(t, pageId, locale)
  const { slices: current = [], ...fields } = (rows.draft?.content ?? {
    title: edit.title ?? "Titre",
  }) as { slices?: unknown[]; [key: string]: unknown }
  return owner.mutation(api.cms.publication.saveEditorDraft, {
    pageId,
    expectedLifecycleGeneration: rows.life.lifecycleGeneration,
    localized: {
      locale,
      slug: rows.draft?.slug ?? "a-propos",
      addressIntent: "typed",
      draft: {
        pageType: "page",
        localized: { ...fields, ...(edit.title ? { title: edit.title } : {}) },
        slices: edit.slices ?? current,
      } as never,
      expectedGeneration:
        rows.states.find((state) => state.locale === locale)?.draftGeneration ??
        0,
    },
  })
}
async function doneWrite(count = 2, opts: Parameters<typeof setup>[0] = {}) {
  const { t, owner } = await setup(opts)
  const id = await start(owner, count)
  await finish(t, id)
  return { t, owner, id, j: (await job(t, id))! }
}
const unitOutputs = async (t: App, id: Id<"aiJobs">) =>
  (await units(t, id)).map((row) => row.output as { id: string })
const progress = (owner: Owner) =>
  owner.query(api.cms.aiJobs.pageJobProgress, {})
const setModules = (t: App, enabled: string[]) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.query("cmsModuleState").first())!
    await ctx.db.patch("cmsModuleState", row._id, {
      enabledModules: enabled.map((moduleId) => ({
        moduleId,
        configVersion: 1,
      })),
    })
  })
/** A unit fails (as the worker's completion callback reports it): job `failed`. */
async function failJob(t: App, id: Id<"aiJobs">) {
  const claimed = (await claim(t, id))!
  await callback(t, claimed.unit, "failed")
  expect((await job(t, id))!.state).toBe("failed")
}
const trash = async (t: App, owner: Owner, pageId: Id<"pages">) =>
  owner.mutation(api.cms.publication.softDeletePage, {
    pageId,
    expectedLifecycleGeneration: (await pageRows(t, pageId)).life
      .lifecycleGeneration,
  })

describe("Write page with AI: job list gap", () => {
  test("a translation job whose Multilingual gate is not ready is omitted from the list; the other jobs stay; refusals still fail", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const writeId = await start(owner, 1)
    await finish(t, writeId)
    const translationId = await translate(owner, await source(t, owner))
    await setModules(t, ["ai"])
    const list = await progress(owner)
    expect(list.map((row) => row.jobId)).toEqual([writeId])
    // The cancel and dismiss paths call no provider: no Multilingual gate.
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: translationId })
    for (const row of await units(t, translationId))
      if (row.workId && row.state !== "inProgress")
        await callback(t, row, "canceled")
    expect((await job(t, translationId))!.state).toBe("canceled")
    await expect(
      owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: translationId })
    ).rejects.toThrow("CMS_MODULE_NOT_READY")
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: translationId })
    ).resolves.toEqual({ pageMovedToTrash: false })
    expect((await job(t, translationId))!.reviewedAt).toBeDefined()
    await setModules(t, [])
    await expect(progress(owner)).rejects.toThrow("CMS_MODULE_DISABLED")
    await setModules(t, ["ai"])
    await expect(
      t
        .withIdentity({
          subject: "someone-else",
          tokenIdentifier: "https://convex.test|someone-else",
        })
        .query(api.cms.aiJobs.pageJobProgress, {})
    ).rejects.toThrow()
  })
})

describe("Write page with AI: the review view shows only readable text", () => {
  const sentinels = { text: [] as string[], other: [] as string[], words: [] as string[] }
  const pmDoc = (...texts: string[]) =>
    JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: texts[0] }] },
        // Text deeper than the first level must be read as well.
        {
          type: "bulletList",
          content: texts.slice(1).map((text) => ({
            type: "listItem",
            content: [
              { type: "paragraph", content: [{ type: "text", text }] },
            ],
          })),
        },
      ],
    })
  /** A valid value for a primitive with a distinctive sentinel in every leaf. */
  function build(def: Primitive, path: string): unknown {
    const n = () => sentinels.text.length + sentinels.other.length
    switch (def.kind) {
      case "text": {
        const editorial =
          (def.config as { editorial?: boolean }).editorial !== false
        const value = `${editorial ? "readable" : "internalid"}-${n()}-${path}`
        ;(editorial ? sentinels.text : sentinels.other).push(value)
        return value
      }
      case "richText": {
        const a = `readable-${n()}-${path}`
        sentinels.text.push(a)
        const b = `readable-${n()}-nested`
        sentinels.text.push(b)
        return pmDoc(a, b)
      }
      case "group": {
        const fields = def.config.fields as Record<string, Primitive>
        return Object.fromEntries(
          Object.entries(fields).map(([key, child]) => [
            key,
            build(child, `${path}.${key}`),
          ])
        )
      }
      case "list": {
        const max = (def.config as { max?: number }).max ?? 2
        return Array.from({ length: Math.min(2, max) }, (_, i) =>
          build(def.config.item as Primitive, `${path}[${i}]`)
        )
      }
      case "image": {
        const url = `/sentinel/image-${n()}.png`
        sentinels.other.push(url)
        const alt = `internalalt-${n()}`
        sentinels.other.push(alt)
        return { url, alt, width: 10, height: 10 }
      }
      case "link": {
        const url = `https://sentinel.example/link-${n()}`
        sentinels.other.push(url)
        return { type: "external", url }
      }
      case "select": {
        const options = def.config.options as string[]
        const value = options[options.length - 1]!
        sentinels.words.push(value)
        return value
      }
      default:
        return def.default
    }
  }
  const hasNonText = (def: Primitive): boolean =>
    def.kind === "group"
      ? Object.values(def.config.fields as Record<string, Primitive>).some(
          hasNonText
        )
      : def.kind === "list"
        ? true
        : def.kind !== "text" && def.kind !== "richText"
  const types = Object.entries(installedSliceDefs).filter(
    ([, def]) =>
      hasNonText(def.primary) ||
      ("items" in def && def.items !== undefined && hasNonText(def.items))
  )
  test("the guard covers every installed slice type that has a list or a non-text field", () => {
    expect(types.map(([type]) => type).sort()).toEqual(
      Object.keys(installedSliceDefs)
        .filter((type) => type !== "rich-text-body")
        .sort()
    )
  })
  test.each(types.map(([type]) => type))(
    "%s: every text value is shown and no id, variant, image path or link target",
    async (type) => {
      sentinels.text = []
      sentinels.other = []
      sentinels.words = []
      const def = installedSliceDefs[type as keyof typeof installedSliceDefs]
      const slice = {
        id: `slice-${type}`,
        type,
        enabled: true,
        primary: build(def.primary, "primary"),
        ...("items" in def && def.items !== undefined
          ? { items: build(def.items, "items") }
          : {}),
      }
      const { t, owner, id } = await doneWrite(1)
      const row = (await units(t, id))[0]!
      await t.run((ctx) =>
        ctx.db.patch("aiJobUnits", row._id, {
          sliceType: type,
          output: slice,
        } as never)
      )
      const result = await owner.query(api.cms.aiJobs.pageJobResult, {
        jobId: id,
      })
      const shown = result.sections[0]!.fields.map((field) => field.text)
      const all = shown.join("\n")
      for (const text of sentinels.text) expect(all).toContain(text)
      for (const other of sentinels.other) expect(all).not.toContain(other)
      for (const word of sentinels.words)
        expect(all).not.toMatch(new RegExp(`\\b${word}\\b`))
      expect(all).not.toContain("sentinel")
      expect(all).not.toContain('"type"')
      expect(all).not.toContain("/slice-placeholders/")
    }
  )
  test("hero-agency: the buttons show their labels, not ids, variants, link kinds or image paths", async () => {
    const { t, owner, id } = await doneWrite(1)
    const row = (await units(t, id))[0]!
    const button = (label: string, uuid: string, variant: string) => ({
      id: uuid,
      label,
      link: { type: "none" },
      variant,
      withIcon: false,
      icon: { url: "/slice-placeholders/placeholder.png", width: 1, height: 1 },
      enabled: true,
    })
    await t.run((ctx) =>
      ctx.db.patch("aiJobUnits", row._id, {
        sliceType: "hero-agency",
        output: {
          id: "hero-agency-1",
          type: "hero-agency",
          enabled: true,
          primary: {
            eyebrow: "MONTRÉAL",
            title: pmDoc("We craft digital experiences."),
            description: pmDoc("Web design and development."),
          },
          items: [
            button("Let's Talk", "42ad13b8-e18d-404d-bfaf-8ab892caeec8", "primary"),
            button("View Work", "80b515d9-1111-4222-8333-944444444444", "outline"),
          ],
        },
      } as never)
    )
    const result = await owner.query(api.cms.aiJobs.pageJobResult, {
      jobId: id,
    })
    const items = result.sections[0]!.fields.find((f) => f.label === "Items")!
    expect(items.text).toBe("Let's Talk\nView Work")
    const all = result.sections[0]!.fields.map((f) => f.text).join("\n")
    expect(all).not.toMatch(/42ad13b8|80b515d9|outline|placeholder\.png|none/)
  })
})

describe("Write page with AI: pageJobResult", () => {
  test("returns every saved section in order with its full text, uncut", async () => {
    const { t, owner, id, j } = await doneWrite(2)
    const long = "word ".repeat(80).trim()
    const rows = await units(t, id)
    await t.run(async (ctx) => {
      const output = rows[0]!.output as { primary: Record<string, unknown> }
      await ctx.db.patch("aiJobUnits", rows[0]!._id, {
        output: { ...output, primary: { ...output.primary, eyebrow: long } },
      } as never)
    })
    const result = await owner.query(api.cms.aiJobs.pageJobResult, {
      jobId: id,
    })
    expect(result).toMatchObject({
      jobId: id,
      pageId: j.pageId,
      title: "A service",
      locale: "en",
      pageAvailable: true,
    })
    expect(result.sections.map((s) => s.index)).toEqual([0, 1])
    expect(result.sections[0]).toMatchObject({
      sliceType: "hero-with-image",
      purpose: "Section 1",
    })
    const eyebrow = result.sections[0]!.fields.find((f) => f.text === long)
    expect(eyebrow).toBeDefined()
    expect(long.length).toBeGreaterThan(240)
    expect(
      result.sections.every((s) =>
        s.fields.every((f) => f.label && f.text.length > 0)
      )
    ).toBe(true)
    expect(JSON.stringify(result)).not.toMatch(/costMicros|estimateMicros/)
  })
  test("refuses a translation with no suggestion, running, failed, expired and reviewed jobs", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const running = await start(owner, 1)
    await expect(
      owner.query(api.cms.aiJobs.pageJobResult, { jobId: running })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    await failJob(t, running)
    await expect(
      owner.query(api.cms.aiJobs.pageJobResult, { jobId: running })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    await owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: running })
    const translation = await translate(owner, await source(t, owner))
    await t.run((ctx) => ctx.db.patch("aiJobs", translation, { state: "done" }))
    await expect(
      owner.query(api.cms.aiJobs.pageJobResult, { jobId: translation })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    await owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: translation })

    const done = await doneWrite(1)
    vi.setSystemTime((await job(done.t, done.id))!.expiresAt)
    await expect(
      done.owner.query(api.cms.aiJobs.pageJobResult, { jobId: done.id })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    const reviewed = await doneWrite(1)
    await reviewed.owner.mutation(api.cms.aiJobs.acceptPageJob, {
      jobId: reviewed.id,
      chosen: [0],
    })
    await expect(
      reviewed.owner.query(api.cms.aiJobs.pageJobResult, { jobId: reviewed.id })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
  })
  test("pageAvailable is false once the page is in Trash", async () => {
    const { t, owner, id, j } = await doneWrite(1)
    await trash(t, owner, j.pageId)
    const result = await owner.query(api.cms.aiJobs.pageJobResult, {
      jobId: id,
    })
    expect(result.pageAvailable).toBe(false)
    expect(result.sections).toHaveLength(1)
  })
})

describe("Write page with AI: acceptPageJob", () => {
  test("all chosen: the draft holds exactly those sections in outline order, title and meta unchanged, nothing published, job reviewed", async () => {
    const { t, owner, id, j } = await doneWrite(2)
    const before = (await pageRows(t, j.pageId)).draft!
    const outputs = await unitOutputs(t, id)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, {
        jobId: id,
        chosen: [1, 0],
      })
    ).resolves.toMatchObject({ pageId: j.pageId, saved: 2 })
    const after = await pageRows(t, j.pageId)
    const content = after.draft!.content as Record<string, unknown>
    const beforeContent = before.content as Record<string, unknown>
    expect((content.slices as { id: string }[]).map((s) => s.id)).toEqual(
      outputs.map((o) => o.id)
    )
    expect(content.title).toBe(beforeContent.title)
    expect(content.metaTitle).toBe(beforeContent.metaTitle)
    expect(content.metaDescription).toBe(beforeContent.metaDescription)
    expect(after.draft!.slug).toBe(before.slug)
    expect(after.states).toHaveLength(1)
    expect(after.states[0]).toMatchObject({
      draftGeneration: j.draftGeneration + 1,
      publicGeneration: 0,
      hasCurrentSnapshot: false,
    })
    expect((await job(t, id))!.reviewedAt).toBeDefined()
    expect(await progress(owner)).toEqual([])
  })
  test("a subset keeps only the chosen sections", async () => {
    const { t, owner, id, j } = await doneWrite(3)
    const outputs = await unitOutputs(t, id)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, {
        jobId: id,
        chosen: [2, 0],
      })
    ).resolves.toMatchObject({ saved: 2 })
    expect((await draftSlices(t, j.pageId)).map((s) => s.id)).toEqual([
      outputs[0]!.id,
      outputs[2]!.id,
    ])
  })
  test("sections the owner saved while the job ran stay first; the chosen ones are appended", async () => {
    const { t, owner, id, j } = await doneWrite(2)
    const outputs = await unitOutputs(t, id)
    const own = { ...outputs[0]!, id: "owner-written-section" }
    await ownerSave(t, owner, j.pageId, { slices: [own] })
    await owner.mutation(api.cms.aiJobs.acceptPageJob, {
      jobId: id,
      chosen: [0, 1],
    })
    expect((await draftSlices(t, j.pageId)).map((s) => s.id)).toEqual([
      "owner-written-section",
      outputs[0]!.id,
      outputs[1]!.id,
    ])
  })
  test("a second call returns saved 0 and changes nothing", async () => {
    const { t, owner, id, j } = await doneWrite(2)
    await owner.mutation(api.cms.aiJobs.acceptPageJob, {
      jobId: id,
      chosen: [0],
    })
    const once = await pageRows(t, j.pageId)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [1] })
    ).resolves.toEqual({ pageId: j.pageId, saved: 0 })
    expect(await pageRows(t, j.pageId)).toEqual(once)
  })
  test("an expired job is refused with AI_JOB_EXPIRED and writes no section", async () => {
    const { t, owner, id, j } = await doneWrite(1)
    vi.setSystemTime(j.expiresAt)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [0] })
    ).rejects.toThrow("AI_JOB_EXPIRED")
    expect(await draftSlices(t, j.pageId)).toEqual([])
  })
  test("a running or failed job is not reviewable", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [0] })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    await failJob(t, id)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [0] })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
  })
  test("a trashed or archived page refuses through the save and the job stays reviewable", async () => {
    for (const how of ["trash", "archive"] as const) {
      const { t, owner, id, j } = await doneWrite(1)
      const generation = (await pageRows(t, j.pageId)).life.lifecycleGeneration
      if (how === "trash") await trash(t, owner, j.pageId)
      else
        await owner.mutation(api.cms.publication.archivePage, {
          pageId: j.pageId,
          expectedLifecycleGeneration: generation,
        })
      await expect(
        owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [0] })
      ).rejects.toThrow("PAGE_PUBLICATION_LIFECYCLE_STALE")
      expect((await job(t, id))!.reviewedAt).toBeUndefined()
      expect(await draftSlices(t, j.pageId)).toEqual([])
    }
  })
  test("empty, duplicate and unknown choices are refused", async () => {
    const { t, owner, id, j } = await doneWrite(2)
    for (const chosen of [[], [0, 0], [5], [-1], [0, 1, 2, 3, 4, 5, 6, 7, 8]])
      await expect(
        owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen })
      ).rejects.toThrow("AI_JOB_INPUT_INVALID")
    expect((await job(t, id))!.reviewedAt).toBeUndefined()
    expect(await draftSlices(t, j.pageId)).toEqual([])
  })
  test("an archived slice type refuses through the save; nothing is written and the job stays reviewable", async () => {
    const { t, owner, id, j } = await doneWrite(1)
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        archivedSliceTypes: ["hero-with-image"],
      })
    })
    const before = await pageRows(t, j.pageId)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [0] })
    ).rejects.toThrow("Archived Block Type")
    expect(await pageRows(t, j.pageId)).toEqual(before)
    expect((await job(t, id))!.reviewedAt).toBeUndefined()
  })
  test("another language's draft and state are unchanged; load, accept, load round trip validates", async () => {
    const { t, owner, id, j } = await doneWrite(2)
    await ownerSave(t, owner, j.pageId, { locale: "fr", title: "Titre fr" })
    const fr = (await pageRows(t, j.pageId, "fr")).draft
    const frState = (await pageRows(t, j.pageId)).states.find(
      (state) => state.locale === "fr"
    )
    const loaded = await owner.query(api.cms.pages.getForEdit, { id: j.pageId })
    expect((loaded!.page.content!.en as { slices: unknown[] }).slices).toEqual(
      []
    )
    await owner.mutation(api.cms.aiJobs.acceptPageJob, {
      jobId: id,
      chosen: [0, 1],
    })
    expect((await pageRows(t, j.pageId, "fr")).draft).toEqual(fr)
    expect(
      (await pageRows(t, j.pageId)).states.find((s) => s.locale === "fr")
    ).toEqual(frState)
    const reloaded = await owner.query(api.cms.pages.getForEdit, {
      id: j.pageId,
    })
    expect(
      (reloaded!.page.content!.en as { slices: unknown[] }).slices
    ).toHaveLength(2)
    // The editor can save what it loaded: the accepted draft validates.
    await ownerSave(t, owner, j.pageId, { title: "Edited after accept" })
  })
})

/** Publish the job's page in English (it is made the home page first). */
async function publishJobPage(t: App, owner: Owner, pageId: Id<"pages">) {
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").first())!
    await ctx.db.patch("siteSettings", settings._id, { homePageId: pageId })
  })
  const rows = await pageRows(t, pageId)
  await owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: rows.states[0]!.draftGeneration,
    expectedSharedDraftGeneration: rows.shared.generation,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: rows.life.lifecycleGeneration,
    expectedReleaseGeneration: 0,
  })
}
describe("Write page with AI: accept works whether or not the working draft row exists", () => {
  const cases: [
    string,
    (c: { t: App; owner: Owner; pageId: Id<"pages"> }) => Promise<void>,
  ][] = [
    ["owner save, then publish", async (c) => publishJobPage(c.t, c.owner, c.pageId)],
    [
      "publish, then a shared-only save",
      async (c) => {
        await publishJobPage(c.t, c.owner, c.pageId)
        const rows = await pageRows(c.t, c.pageId)
        expect(rows.draft).toBeNull()
        await c.owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId: c.pageId,
          expectedLifecycleGeneration: rows.life.lifecycleGeneration,
          shared: {
            expectedGeneration: rows.shared.generation,
            seo: { noIndex: true } as never,
          },
        })
      },
    ],
    [
      "publish, then withdraw",
      async (c) => {
        await publishJobPage(c.t, c.owner, c.pageId)
        const rows = await pageRows(c.t, c.pageId)
        await c.owner.mutation(api.cms.publication.withdrawLocale, {
          pageId: c.pageId,
          locale: "en",
          expectedSnapshotId: rows.states[0]!.currentSnapshotId!,
          expectedPublicGeneration: rows.states[0]!.publicGeneration,
          expectedLifecycleGeneration: rows.life.lifecycleGeneration,
        })
      },
    ],
    ["no publication: the draft row is there (control)", async () => {}],
  ]
  test.each(cases)("%s", async (name, between) => {
    const { t, owner, id, j } = await doneWrite(2)
    const outputs = await unitOutputs(t, id)
    const own = { ...outputs[0]!, id: "owner-written-section" }
    await ownerSave(t, owner, j.pageId, { slices: [own], title: "Owner title" })
    const pre = (await pageRows(t, j.pageId)).draft!
    await between({ t, owner, pageId: j.pageId })
    const hasRow = (await pageRows(t, j.pageId)).draft !== null
    expect(hasRow).toBe(name.startsWith("no publication"))
    const before = (await pageRows(t, j.pageId)).states[0]!
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, {
        jobId: id,
        chosen: [1, 0],
      })
    ).resolves.toMatchObject({ pageId: j.pageId, saved: 2 })
    const after = await pageRows(t, j.pageId)
    const content = after.draft!.content as Record<string, unknown>
    const preContent = pre.content as Record<string, unknown>
    expect((content.slices as { id: string }[]).map((s) => s.id)).toEqual([
      "owner-written-section",
      outputs[0]!.id,
      outputs[1]!.id,
    ])
    expect((content.slices as unknown[])[0]).toEqual(
      (preContent.slices as unknown[])[0]
    )
    expect(content.title).toBe("Owner title")
    expect(content.metaTitle).toBe(preContent.metaTitle)
    expect(content.metaDescription).toBe(preContent.metaDescription)
    // Address untouched; Accept never publishes.
    expect(after.draft!.slug).toBe(pre.slug)
    expect(after.draft!.addressAllocation).toEqual(pre.addressAllocation)
    const publication = (state: typeof before) => ({
      publicGeneration: state.publicGeneration,
      currentSnapshotId: state.currentSnapshotId,
      hasCurrentSnapshot: state.hasCurrentSnapshot,
      currentPath: state.currentPath,
    })
    expect(publication(after.states[0]!)).toEqual(publication(before))
    expect((await job(t, id))!.reviewedAt).toBeDefined()
  })
  test("neither a draft row nor a base: refused, nothing written, the job stays reviewable", async () => {
    const { t, owner, id, j } = await doneWrite(1)
    const rows = await pageRows(t, j.pageId)
    await owner.mutation(api.cms.publication.discardLocaleDraft, {
      pageId: j.pageId,
      locale: "en",
      expectedDraftGeneration: rows.states[0]!.draftGeneration,
      expectedLifecycleGeneration: rows.life.lifecycleGeneration,
    })
    const before = await pageRows(t, j.pageId)
    expect(before.draft).toBeNull()
    expect(before.states[0]!.draftBaseSnapshotId).toBeUndefined()
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [0] })
    ).rejects.toThrow("AI_JOB_SOURCE_UNAVAILABLE")
    expect(await pageRows(t, j.pageId)).toEqual(before)
    expect((await job(t, id))!.reviewedAt).toBeUndefined()
  })
})

describe("Write page with AI: the Dismiss preview equals what Dismiss does", () => {
  type Ctx = { t: App; owner: Owner; pageId: Id<"pages"> }
  const jobStates: [
    string,
    () => Promise<{ t: App; owner: Owner; id: Id<"aiJobs"> }>,
  ][] = [
    [
      "done",
      async () => {
        const { t, owner, id } = await doneWrite(1)
        return { t, owner, id }
      },
    ],
    [
      "canceled",
      async () => {
        const { t, owner } = await setup()
        const id = await start(owner, 2)
        await cancelQueued(t, owner, id)
        expect((await job(t, id))!.state).toBe("canceled")
        return { t, owner, id }
      },
    ],
    [
      "failed",
      async () => {
        const { t, owner } = await setup()
        const id = await start(owner, 1)
        await failJob(t, id)
        return { t, owner, id }
      },
    ],
    [
      "expired",
      async () => {
        const { t, owner, id } = await doneWrite(1)
        return { t, owner, id }
      },
    ],
  ]
  const menuNav = (pageId: Id<"pages">) => [
    {
      id: "job-page-link",
      label: { en: "Job page" },
      target: { type: "internal" as const, pageId },
    },
  ]
  // [name, apply, Trash expected]
  const situations: [string, (c: Ctx) => Promise<void>, boolean][] = [
    ["untouched", async () => {}, true],
    [
      "linked in a live menu",
      async (c) => {
        await c.owner.mutation(api.cms.menus.saveCanonical, {
          slug: "primary",
          locale: "en",
          nav: menuNav(c.pageId) as never,
        })
      },
      false,
    ],
    [
      "linked only in a menu that was deleted",
      async (c) => {
        const saved = await c.owner.mutation(api.cms.menus.saveCanonical, {
          slug: "primary",
          locale: "en",
          nav: menuNav(c.pageId) as never,
        })
        await c.owner.mutation(api.cms.menus.softDelete, { id: saved.id })
      },
      true,
    ],
    [
      "set as the home page",
      async (c) => {
        // No public mutation names an arbitrary page as home; set the raw setting.
        await c.t.run(async (ctx) => {
          const settings = (await ctx.db.query("siteSettings").first())!
          await ctx.db.patch("siteSettings", settings._id, {
            homePageId: c.pageId,
          })
        })
      },
      false,
    ],
    [
      "named as the parent of another page",
      async (c) => {
        await c.owner.mutation(api.cms.pages.create, {
          pageType: "page",
          status: "draft",
          slug: "child",
          title: "Child",
          parentId: c.pageId,
          content: { en: { title: "Child", slices: [] } },
        })
      },
      true,
    ],
    [
      "the target of a redirect",
      async (c) => {
        await setModules(c.t, ["ai", "redirects"])
        await c.owner.mutation(api.cms.redirects.create, {
          fromPath: "/old-address",
          toPageId: c.pageId,
          statusCode: 301,
        })
      },
      true,
    ],
    [
      "the owner saved a draft",
      async (c) => {
        await ownerSave(c.t, c.owner, c.pageId, { title: "Owner changed" })
      },
      false,
    ],
    [
      "published",
      async (c) => {
        await publishJobPage(c.t, c.owner, c.pageId)
      },
      false,
    ],
  ]
  describe.each(jobStates)("%s job", (state, make) => {
    test.each(situations)(
      "%s",
      async (_name, apply, expectTrash) => {
        const { t, owner, id } = await make()
        const pageId = (await job(t, id))!.pageId
        await apply({ t, owner, pageId })
        // The deadline passes after the page situation was set up.
        if (state === "expired")
          vi.setSystemTime((await job(t, id))!.expiresAt)
        // The job list never fails, whatever the page situation.
        const row = (await progress(owner)).find((r) => r.jobId === id)!
        const result = await owner.mutation(api.cms.aiJobs.dismissPageJob, {
          jobId: id,
        })
        expect(row.dismissMovesPageToTrash).toBe(result.pageMovedToTrash)
        expect(result.pageMovedToTrash).toBe(expectTrash)
        expect((await pageRows(t, pageId)).life.lifecycleState).toBe(
          result.pageMovedToTrash ? "trashed" : "active"
        )
        expect((await job(t, id))!.reviewedAt).toBeDefined()
        expect(await progress(owner)).toEqual([])
      }
    )
  })
  test("running and canceling jobs report false and Dismiss refuses", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 2)
    expect((await progress(owner))[0]!.dismissMovesPageToTrash).toBe(false)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    await claim(t, id)
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    expect((await job(t, id))!.state).toBe("canceling")
    expect((await progress(owner))[0]!.dismissMovesPageToTrash).toBe(false)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
  })
})

describe("Write page with AI: dismissPageJob", () => {
  test("an untouched page goes to Trash, the job is cleared", async () => {
    const { t, owner, id, j } = await doneWrite(1)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: true })
    expect((await pageRows(t, j.pageId)).life.lifecycleState).toBe("trashed")
    expect(await progress(owner)).toEqual([])
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: false })
  })
  const touches: [
    string,
    (c: Awaited<ReturnType<typeof doneWrite>>) => Promise<void>,
  ][] = [
    [
      "the owner's draft save",
      async ({ t, owner, j }) => {
        await ownerSave(t, owner, j.pageId, { title: "Owner changed" })
      },
    ],
    [
      "a shared-draft save",
      async ({ t, owner, j }) => {
        const rows = await pageRows(t, j.pageId)
        await owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId: j.pageId,
          expectedLifecycleGeneration: rows.life.lifecycleGeneration,
          shared: {
            expectedGeneration: rows.shared.generation,
            seo: { noIndex: true } as never,
          },
        })
      },
    ],
    [
      "a second language's draft",
      async ({ t, owner, j }) => {
        await ownerSave(t, owner, j.pageId, { locale: "fr", title: "Titre" })
      },
    ],
    [
      "publish",
      async ({ t, owner, j }) => {
        await t.run(async (ctx) => {
          const settings = (await ctx.db.query("siteSettings").first())!
          await ctx.db.patch("siteSettings", settings._id, {
            homePageId: j.pageId,
          })
        })
        const rows = await pageRows(t, j.pageId)
        await owner.mutation(api.cms.publication.publishLocale, {
          pageId: j.pageId,
          locale: "en",
          expectedDraftGeneration: rows.states[0]!.draftGeneration,
          expectedSharedDraftGeneration: rows.shared.generation,
          expectedPublicGeneration: 0,
          expectedLifecycleGeneration: rows.life.lifecycleGeneration,
          expectedReleaseGeneration: 0,
        })
      },
    ],
    [
      "archive then restore",
      async ({ t, owner, j }) => {
        await owner.mutation(api.cms.publication.archivePage, {
          pageId: j.pageId,
          expectedLifecycleGeneration: (await pageRows(t, j.pageId)).life
            .lifecycleGeneration,
        })
        await owner.mutation(api.cms.publication.restorePage, {
          pageId: j.pageId,
          expectedLifecycleGeneration: (await pageRows(t, j.pageId)).life
            .lifecycleGeneration,
        })
      },
    ],
    [
      "a job row without the two Start fields",
      async ({ t, id }) => {
        await t.run((ctx) =>
          ctx.db.patch("aiJobs", id, {
            startLifecycleGeneration: undefined,
            startSharedDraftGeneration: undefined,
          })
        )
      },
    ],
  ]
  test.each(touches)("the page stays after %s", async (_name, touch) => {
    const context = await doneWrite(1)
    await touch(context)
    await expect(
      context.owner.mutation(api.cms.aiJobs.dismissPageJob, {
        jobId: context.id,
      })
    ).resolves.toEqual({ pageMovedToTrash: false })
    expect(
      (await pageRows(context.t, context.j.pageId)).life.lifecycleState
    ).toBe("active")
    expect(await progress(context.owner)).toEqual([])
  })
  test("the progress row says what Dismiss will do, and Dismiss agrees", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 1)
    // A running job: Dismiss refuses, so the preview says false.
    expect((await progress(owner))[0]).toMatchObject({
      jobId: id,
      dismissMovesPageToTrash: false,
    })
    await finish(t, id)
    expect((await progress(owner))[0]!.dismissMovesPageToTrash).toBe(true)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: true })
  })
  test.each(touches)(
    "the progress row says the page stays after %s, and Dismiss agrees",
    async (_name, touch) => {
      const context = await doneWrite(1)
      await touch(context)
      expect((await progress(context.owner))[0]!.dismissMovesPageToTrash).toBe(
        false
      )
      await expect(
        context.owner.mutation(api.cms.aiJobs.dismissPageJob, {
          jobId: context.id,
        })
      ).resolves.toEqual({ pageMovedToTrash: false })
    }
  )
  test("a translation job's progress row never says Trash", async () => {
    const { t, owner } = await setup({ multilingual: true })
    await translate(owner, await source(t, owner))
    expect((await progress(owner))[0]).toMatchObject({
      kind: "translation",
      dismissMovesPageToTrash: false,
    })
  })
  test("a page already in Trash: the job is cleared, false, no throw", async () => {
    const { t, owner, id, j } = await doneWrite(1)
    await trash(t, owner, j.pageId)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: false })
    expect((await job(t, id))!.reviewedAt).toBeDefined()
  })
  test("canceled and failed jobs can be dismissed; a running one cannot", async () => {
    const { t, owner } = await setup()
    const running = await start(owner, 2)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: running })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    await cancelQueued(t, owner, running)
    expect((await job(t, running))!.state).toBe("canceled")
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: running })
    ).resolves.toEqual({ pageMovedToTrash: true })
    const failing = await start(owner, 1)
    await failJob(t, failing)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: failing })
    ).resolves.toMatchObject({ pageMovedToTrash: true })
  })
  test("a translation job never trashes its page", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await source(t, owner)
    const id = await translate(owner, pageId)
    await cancelQueued(t, owner, id)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: false })
    expect((await pageRows(t, pageId)).life.lifecycleState).toBe("active")
  })
  test("a dismissed job cannot be resumed", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 2)
    await cancelQueued(t, owner, id)
    await owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    await expect(
      owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
    ).rejects.toThrow("AI_JOB_NOT_RESUMABLE")
  })
  test("the address of a dismissed job page can be used by a new job (record the outcome)", async () => {
    const { t, owner } = await setup()
    const first = await start(owner, 1)
    await cancelQueued(t, owner, first)
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: first })
    ).resolves.toEqual({ pageMovedToTrash: true })
    const again = await owner.mutation(api.cms.aiJobs.startPageJob, {
      input: writeInput(1),
    })
    const page = await t.run((ctx) =>
      ctx.db
        .get("aiJobs", again)
        .then((row) => ctx.db.get("pages", row!.pageId))
    )
    // Address reuse result: Start accepted the same address after Trash.
    expect(page!.slug).toBe(SLUG_ONE)
  })
})

describe("Write page with AI: async orders", () => {
  test("Cancel, then the worker's late completion, then dismiss: one consistent state, reservation released once", async () => {
    const { t, owner } = await setup()
    const id = await start(owner, 2)
    const claimed = (await claim(t, id))!
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    expect((await job(t, id))!.state).toBe("canceling")
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    await callback(t, claimed.unit, "failed")
    expect((await job(t, id))!.state).toBe("canceled")
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: true })
    // A repeated late callback changes nothing.
    await callback(t, claimed.unit, "failed")
    expect((await status(t)).reservedMicros).toBe(0)
    expect((await job(t, id))!.state).toBe("canceled")
    const reservations = await t.run((ctx) =>
      ctx.db.query("aiSpendingJobReservations").collect()
    )
    expect(reservations.map((r) => r.state)).toEqual(["released"])
  })
  test("accept racing the 7-day expiry ends in one state: either saved, or expired with nothing written", async () => {
    const { t, owner, id, j } = await doneWrite(1)
    vi.setSystemTime(j.expiresAt - 1)
    await owner.mutation(api.cms.aiJobs.acceptPageJob, {
      jobId: id,
      chosen: [0],
    })
    // The deadline passes after Accept: the expiry really runs and the
    // sections Accept saved stay in the draft.
    vi.setSystemTime(j.expiresAt)
    await t.mutation(internal.cms.aiJobs.expireJob, { jobId: id })
    expect((await job(t, id))!.state).toBe("expired")
    expect((await draftSlices(t, j.pageId)).length).toBe(1)
    expect((await job(t, id))!.reviewedAt).toBeDefined()
    expect((await status(t)).reservedMicros).toBe(0)

    const late = await doneWrite(1)
    vi.setSystemTime(late.j.expiresAt)
    await late.t.mutation(internal.cms.aiJobs.expireJob, { jobId: late.id })
    await expect(
      late.owner.mutation(api.cms.aiJobs.acceptPageJob, {
        jobId: late.id,
        chosen: [0],
      })
    ).rejects.toThrow("AI_JOB_EXPIRED")
    expect(await draftSlices(late.t, late.j.pageId)).toEqual([])
    expect((await status(late.t)).reservedMicros).toBe(0)
  })
})

// ---- Translate page with AI: server side (start, review, accept, dismiss) ----
const translationInput = (
  pageId: Id<"pages">,
  sourceLocale = "en",
  targetLocale = "fr"
) => ({ kind: "translation" as const, pageId, sourceLocale, targetLocale })
const startTranslation = (owner: Owner, pageId: Id<"pages">, target = "fr") =>
  owner.mutation(api.cms.aiJobs.startPageJob, {
    input: translationInput(pageId, "en", target),
  })
/** Puts a hero section with `paragraphs` rich-text paragraphs on the English draft. */
async function giveSource(t: App, pageId: Id<"pages">, paragraphs = 1) {
  const sample = (await import("./lib/slices/sample")).createSampleSlice(
    "hero-with-image"
  )
  const description = JSON.stringify({
    type: "doc",
    content: Array.from({ length: paragraphs }, (_, index) => ({
      type: "paragraph",
      content: [{ type: "text", text: `Paragraph ${index}` }],
    })),
  })
  await t.run(async (ctx) => {
    const draft = (await ctx.db
      .query("pageLocaleDrafts")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", "en")
      )
      .unique())!
    if (draft.pageType !== "page") throw new Error("Expected Page fixture")
    await ctx.db.patch("pageLocaleDrafts", draft._id, {
      content: {
        ...draft.content,
        slices: [{ ...sample, primary: { ...sample.primary, description } }],
      },
    })
  })
}
async function doneTranslation(paragraphs = 1) {
  fake.text = "Traduit"
  const { t, owner } = await setup({ multilingual: true })
  const pageId = await source(t, owner, "Source title")
  if (paragraphs > 0) await giveSource(t, pageId, paragraphs)
  const id = await startTranslation(owner, pageId)
  await finish(t, id)
  return { t, owner, pageId, id, j: (await job(t, id))! }
}
/** Gives every section of a done job's suggestion (and its stored draft) a presentation choice. */
const chooseInSuggestion = (t: App, id: Id<"aiJobs">, choice: string) =>
  t.run(async (ctx) => {
    const j = (await ctx.db.get("aiJobs", id))!
    const mark = (slices: object[]) =>
      slices.map((slice) => ({ ...slice, presentationIdV1: choice }))
    const draft = j.suggestion!.draft as { slices: object[] }
    await ctx.db.patch("aiJobs", id, {
      suggestion: {
        ...j.suggestion!,
        slices: mark(j.suggestion!.slices),
        draft: { ...draft, slices: mark(draft.slices) },
      },
    } as never)
  })
const jobCount = (t: App) =>
  t.run(async (ctx) => (await ctx.db.query("aiJobs").collect()).length)

describe("Translate page with AI: Start", () => {
  test("any language of this site works; a language the site does not have is refused; same language is refused", async () => {
    const { t, owner } = await setup({ multilingual: true })
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        enabledLocales: ["en", "fr", "de"],
      })
    })
    const pageId = await source(t, owner)
    const id = await startTranslation(owner, pageId, "de")
    expect((await job(t, id))!).toMatchObject({
      sourceLocale: "en",
      targetLocale: "de",
      locale: "de",
      targetDraftGeneration: 0,
    })
    await cancelQueued(t, owner, id)
    await owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    await expect(startTranslation(owner, pageId, "es")).rejects.toThrow(
      "LOCALE_NOT_ENABLED"
    )
    await expect(
      owner.mutation(api.cms.aiJobs.startPageJob, {
        input: translationInput(pageId, "zz", "fr"),
      })
    ).rejects.toThrow("LOCALE_NOT_ENABLED")
    await expect(
      owner.mutation(api.cms.aiJobs.startPageJob, {
        input: translationInput(pageId, "en", "en"),
      })
    ).rejects.toThrow("AI_JOB_INPUT_INVALID")
    expect(await jobCount(t)).toBe(1)
  })
  test("a target language that already has content is refused, by Start and by the estimate; no job, no reservation", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await source(t, owner, "Source", { withFrench: true })
    await expect(startTranslation(owner, pageId)).rejects.toThrow(
      "AI_JOB_TARGET_HAS_CONTENT"
    )
    await expect(
      owner.query(api.cms.aiJobs.estimatePageJob, {
        input: translationInput(pageId),
      })
    ).rejects.toThrow("AI_JOB_TARGET_HAS_CONTENT")
    expect(await jobCount(t)).toBe(0)
    expect((await status(t)).reservedMicros).toBe(0)
  })
  test("a language with a state row but no draft and no snapshot is still Not translated", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await source(t, owner)
    await t.run((ctx) =>
      ctx.db.insert("pageLocalePublicationStates", {
        pageId,
        locale: "fr",
        draftGeneration: 3,
        publicGeneration: 0,
        releaseGeneration: 0,
        hasCurrentSnapshot: false,
        updatedAt: 1,
      })
    )
    const id = await startTranslation(owner, pageId)
    expect((await job(t, id))!.targetDraftGeneration).toBe(3)
  })
  test("a source with no content is refused; a source over 60 segments is refused before any reservation", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const frenchOnly = await owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      title: "Seulement",
      slug: "seulement",
      content: { fr: { title: "Seulement", slices: [] } },
    })
    await expect(startTranslation(owner, frenchOnly)).rejects.toThrow(
      "AI_JOB_SOURCE_UNAVAILABLE"
    )
    const big = await source(t, owner, "Big")
    await giveSource(t, big, 70)
    await expect(startTranslation(owner, big)).rejects.toThrow(
      "AI_JOB_SOURCE_TOO_LARGE"
    )
    await expect(
      owner.query(api.cms.aiJobs.estimatePageJob, {
        input: translationInput(big),
      })
    ).rejects.toThrow("AI_JOB_SOURCE_TOO_LARGE")
    expect(await jobCount(t)).toBe(0)
    expect((await status(t)).reservedMicros).toBe(0)
  })
})

describe("Translate page with AI: pageJobResult", () => {
  test("serves readable text only: Title and Meta rows, then one entry per section; never raw values", async () => {
    const { owner, id, j } = await doneTranslation(2)
    const result = await owner.query(api.cms.aiJobs.pageJobResult, {
      jobId: id,
    })
    expect(result).toMatchObject({
      jobId: id,
      kind: "translation",
      pageId: j.pageId,
      locale: "fr",
      sourceLocale: "en",
      targetLocale: "fr",
      sourceChanged: false,
      pageAvailable: true,
    })
    expect(result.pageFields).toEqual([
      { label: "Title", text: "Traduit" },
      { label: "Meta title", text: "Traduit" },
      { label: "Meta description", text: "Traduit" },
    ])
    expect(result.sections).toHaveLength(1)
    expect(result.sections![0]).toMatchObject({
      index: 0,
      sliceType: "hero-with-image",
    })
    const text = result.sections![0]!.fields.map((f) => f.text).join("\n")
    expect(text).toContain("Traduit")
    expect(JSON.stringify(result)).not.toMatch(
      /"type":"doc"|\\"type\\":\\"doc\\"|costMicros|estimateMicros/
    )
  })
  test("sourceChanged turns true once the source language's draft moves on", async () => {
    const { t, owner, pageId, id } = await doneTranslation(0)
    await ownerSave(t, owner, pageId, { title: "Edited after Start" })
    const result = await owner.query(api.cms.aiJobs.pageJobResult, {
      jobId: id,
    })
    expect(result.sourceChanged).toBe(true)
  })
  test("a running job, a reviewed job and a done job with no suggestion are not reviewable", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const running = await startTranslation(owner, await source(t, owner))
    await expect(
      owner.query(api.cms.aiJobs.pageJobResult, { jobId: running })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    await t.run((ctx) => ctx.db.patch("aiJobs", running, { state: "done" }))
    await expect(
      owner.query(api.cms.aiJobs.pageJobResult, { jobId: running })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    const done = await doneTranslation()
    await done.owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: done.id })
    await expect(
      done.owner.query(api.cms.aiJobs.pageJobResult, { jobId: done.id })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
  })
})

describe("Translate page with AI: acceptPageJob", () => {
  test("one Accept saves the whole page as the French draft: nothing published, source untouched, copies deleted", async () => {
    const { t, owner, pageId, id } = await doneTranslation(2)
    const before = await pageRows(t, pageId, "en")
    expect(before.states.map((s) => s.locale)).toEqual(["en"])
    const sourceSlices = await draftSlices(t, pageId, "en")
    const result = await owner.mutation(api.cms.aiJobs.acceptPageJob, {
      jobId: id,
      chosen: [],
    })
    // The target language's draft generation after the save, for the editor.
    expect(result).toEqual({ pageId, saved: 1, draftGeneration: 1 })
    const fr = await pageRows(t, pageId, "fr")
    const frState = fr.states.find((s) => s.locale === "fr")!
    expect(frState).toMatchObject({
      draftGeneration: 1,
      publicGeneration: 0,
      hasCurrentSnapshot: false,
    })
    expect(fr.draft).toMatchObject({
      slug: "traduit",
      content: { title: "Traduit", metaTitle: "Traduit" },
    })
    const frSlices = await draftSlices(t, pageId, "fr")
    expect(frSlices).toHaveLength(1)
    // The section has its own id in the new language.
    expect(frSlices[0]!.id).not.toBe(sourceSlices[0]!.id)
    // English is exactly as it was.
    const after = await pageRows(t, pageId, "en")
    expect(after.draft).toEqual(before.draft)
    expect(after.states.find((s) => s.locale === "en")).toEqual(
      before.states.find((s) => s.locale === "en")
    )
    // B3: the suggestion and the unit text are gone; the job is reviewed.
    const j = (await job(t, id))!
    expect(j.reviewedAt).toBeDefined()
    expect(j.suggestion).toBeUndefined()
    expect(j.sourcePage).toBeUndefined()
    expect(
      (await units(t, id)).every(
        (u) => u.output === undefined && u.input === undefined
      )
    ).toBe(true)
    // A second call changes nothing.
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [] })
    ).resolves.toEqual({ pageId, saved: 0 })
    expect((await pageRows(t, pageId, "fr")).draft!.generation).toBe(1)
    await expect(
      owner.query(api.cms.aiJobs.pageJobResult, { jobId: id })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
  })
  test.each([
    { choice: undefined },
    { choice: "default" },
    { choice: "centered" },
  ])(
    "a source section with presentation $choice is saved into the target with the choice kept and a fresh id",
    async ({ choice }) => {
      const { t, owner, pageId, id } = await doneTranslation()
      if (choice !== undefined)
        await t.run(async (ctx) => {
          const draft = (await ctx.db
            .query("pageLocaleDrafts")
            .withIndex("by_pageId_and_locale", (q) =>
              q.eq("pageId", pageId).eq("locale", "en")
            )
            .unique())!
          const content = draft.content as { slices: object[] }
          await ctx.db.patch("pageLocaleDrafts", draft._id, {
            content: {
              ...content,
              slices: content.slices.map((slice) => ({
                ...slice,
                presentationIdV1: choice,
              })),
            },
          } as never)
        })
      // The job pinned its suggestion at Start, so give it the choice too.
      if (choice !== undefined) await chooseInSuggestion(t, id, choice)
      const sourceBefore = (await pageRows(t, pageId, "en")).draft
      const sourceSlice = (await draftSlices(t, pageId, "en"))[0]!
      const result = await owner.mutation(api.cms.aiJobs.acceptPageJob, {
        jobId: id,
        chosen: [],
      })
      expect(result).toMatchObject({ pageId, saved: 1, draftGeneration: 1 })
      const [saved] = (await draftSlices(t, pageId, "fr")) as {
        id: string
        presentationIdV1?: string
      }[]
      expect(saved!.presentationIdV1).toBe(choice)
      expect(saved!.id).not.toBe(sourceSlice.id)
      expect((await pageRows(t, pageId, "en")).draft).toEqual(sourceBefore)
    }
  )
  test("a presentation archived since Start is refused through the save; the job keeps its suggestion and no French draft exists", async () => {
    const { t, owner, pageId, id } = await doneTranslation()
    await chooseInSuggestion(t, id, "centered")
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        archivedSlicePresentationsV1: [
          { type: "hero-with-image", presentationId: "centered" },
        ],
      })
    })
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [] })
    ).rejects.toThrow("presentation-archived")
    const j = (await job(t, id))!
    expect(j.reviewedAt).toBeUndefined()
    expect(j.suggestion).toBeDefined()
    expect((await pageRows(t, pageId, "fr")).draft).toBeNull()
  })
  test("a list of section choices is refused: the whole page is saved or nothing", async () => {
    const { t, owner, pageId, id } = await doneTranslation()
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [0] })
    ).rejects.toThrow("AI_JOB_INPUT_INVALID")
    expect((await pageRows(t, pageId, "fr")).states.map((s) => s.locale)).toEqual(
      ["en"]
    )
    expect((await job(t, id))!.suggestion).toBeDefined()
  })
  test("the French draft changed since Start: refused with AI_JOB_TARGET_CHANGED; the job keeps its suggestion and nothing is overwritten", async () => {
    const { t, owner, pageId, id } = await doneTranslation()
    await ownerSave(t, owner, pageId, { locale: "fr", title: "Écrit à la main" })
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [] })
    ).rejects.toThrow("AI_JOB_TARGET_CHANGED")
    const fr = await pageRows(t, pageId, "fr")
    expect(fr.draft!.content).toMatchObject({ title: "Écrit à la main" })
    expect(fr.draft!.generation).toBe(1)
    const j = (await job(t, id))!
    expect(j.reviewedAt).toBeUndefined()
    expect(j.suggestion).toBeDefined()
    expect((await units(t, id)).some((u) => u.output !== undefined)).toBe(true)
  })
  test("a trashed page refuses through the save; the job stays reviewable", async () => {
    const { t, owner, pageId, id } = await doneTranslation()
    await trash(t, owner, pageId)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [] })
    ).rejects.toThrow()
    const j = (await job(t, id))!
    expect(j.reviewedAt).toBeUndefined()
    expect(j.suggestion).toBeDefined()
  })
  test("a language removed from the site since Start: refused by the save; the job keeps its suggestion", async () => {
    const { t, owner, pageId, id } = await doneTranslation()
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        enabledLocales: ["en"],
      })
    })
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [] })
    ).rejects.toThrow()
    expect((await job(t, id))!.suggestion).toBeDefined()
    expect((await pageRows(t, pageId, "fr")).draft).toBeNull()
  })
  test("an expired job is refused with AI_JOB_EXPIRED and writes nothing", async () => {
    const { t, owner, pageId, id, j } = await doneTranslation()
    vi.setSystemTime(j.expiresAt)
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [] })
    ).rejects.toThrow("AI_JOB_EXPIRED")
    expect((await pageRows(t, pageId, "fr")).draft).toBeNull()
  })
})

describe("Translate page with AI: Accept builds only from the draft pinned at Start", () => {
  const authorJob = async (roleTitle: "absent" | "empty") => {
    fake.text = "Traduit"
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      title: "Ada",
      name: "Ada",
      content: {
        en: {
          title: "Ada",
          ...(roleTitle === "empty" ? { roleTitle: "" } : {}),
          slices: [],
        },
      },
    })
    const id = await startTranslation(owner, pageId)
    await finish(t, id)
    return { t, owner, pageId, id }
  }
  const saveSource = async (
    t: App,
    owner: Owner,
    pageId: Id<"pages">,
    publish: boolean
  ) => {
    const rows = await pageRows(t, pageId, "en")
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: rows.life.lifecycleGeneration,
      localized: {
        locale: "en",
        slug: rows.draft!.slug,
        addressIntent: "typed",
        draft: {
          pageType: "author",
          localized: { title: "Ada", roleTitle: "Product designer" },
          slices: [],
        } as never,
        expectedGeneration: rows.states[0]!.draftGeneration,
      },
    })
    if (publish) {
      await t.run(async (ctx) => {
        const settings = (await ctx.db.query("siteSettings").first())!
        await ctx.db.patch("siteSettings", settings._id, { homePageId: pageId })
      })
      const after = await pageRows(t, pageId, "en")
      await owner.mutation(api.cms.publication.publishLocale, {
        pageId,
        locale: "en",
        expectedDraftGeneration: after.states[0]!.draftGeneration,
        expectedSharedDraftGeneration: after.shared.generation,
        expectedPublicGeneration: 0,
        expectedLifecycleGeneration: after.life.lifecycleGeneration,
        expectedReleaseGeneration: 0,
      })
    }
  }
  test.each([
    { roleTitle: "absent" as const, publish: false },
    { roleTitle: "absent" as const, publish: true },
    { roleTitle: "empty" as const, publish: false },
    { roleTitle: "empty" as const, publish: true },
  ])(
    "Author roleTitle $roleTitle at Start, source saved (published: $publish) after Start: Accept saves exactly the pinned translation",
    async ({ roleTitle, publish }) => {
      const { t, owner, pageId, id } = await authorJob(roleTitle)
      // What the English draft held at Start (the save may normalise "").
      const atStart = (
        (await pageRows(t, pageId, "en")).draft!.content as {
          roleTitle?: string
        }
      ).roleTitle
      await saveSource(t, owner, pageId, publish)
      await owner.mutation(api.cms.aiJobs.acceptPageJob, {
        jobId: id,
        chosen: [],
      })
      const content = (await pageRows(t, pageId, "fr")).draft!.content as Record<
        string,
        unknown
      >
      // Complete saved content: the pinned title translated, roleTitle as it
      // was at Start, and no metadata keys that the source never had.
      expect(content).toEqual({
        title: "Traduit",
        ...(atStart !== undefined ? { roleTitle: atStart } : {}),
        slices: [],
      })
      expect(content.roleTitle).not.toBe("Product designer")
    }
  )
  test("a job row without the stored draft refuses Accept, keeps its suggestion, and can be dismissed", async () => {
    const { t, owner, pageId, id } = await doneTranslation()
    await t.run(async (ctx) => {
      const j = (await ctx.db.get("aiJobs", id))!
      await ctx.db.patch("aiJobs", id, {
        suggestion: { ...j.suggestion!, draft: undefined },
      })
    })
    await expect(
      owner.mutation(api.cms.aiJobs.acceptPageJob, { jobId: id, chosen: [] })
    ).rejects.toThrow("AI_JOB_NOT_REVIEWABLE")
    const j = (await job(t, id))!
    expect(j.reviewedAt).toBeUndefined()
    expect(j.suggestion).toBeDefined()
    expect((await pageRows(t, pageId, "fr")).draft).toBeNull()
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: false })
  })
  test("the pinned draft keeps absent metadata absent and replays addressed leaves onto the pinned rows only", async () => {
    const { translatedDraft } = await import("./cms/aiJobs")
    const pinned = {
      pageType: "page",
      localized: {
        title: "Hello",
        items: [
          { label: "One", url: "/one", nested: { note: "n1" } },
          { label: "Two", url: "/two", nested: { note: "n2" } },
        ],
      },
      slices: [],
    } as never
    const result = translatedDraft(pinned, {
      title: "Bonjour",
      slices: [],
      translatables: [
        { path: "items[0].label", kind: "text", value: "Un" },
        { path: "items[1].nested.note", kind: "text", value: "n2-fr" },
      ],
    })
    // No metaTitle or metaDescription key appears; non-text siblings and row
    // order are the pinned ones, whatever the live source does later.
    expect(result).toEqual({
      pageType: "page",
      localized: {
        title: "Bonjour",
        items: [
          { label: "Un", url: "/one", nested: { note: "n1" } },
          { label: "Two", url: "/two", nested: { note: "n2-fr" } },
        ],
      },
      slices: [],
    })
    expect(Object.hasOwn(result.localized, "metaTitle")).toBe(false)
    // A content type with no slice body stays without a slices key.
    expect(
      Object.hasOwn(
        translatedDraft(
          { pageType: "testimonial", localized: { title: "T" } } as never,
          { title: "T2", slices: [], translatables: [] }
        ),
        "slices"
      )
    ).toBe(false)
  })
})

describe("Translate page with AI: dismissPageJob", () => {
  test("Dismiss deletes the suggestion and the unit text and saves nothing", async () => {
    const { t, owner, pageId, id } = await doneTranslation()
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: false })
    const j = (await job(t, id))!
    expect(j.reviewedAt).toBeDefined()
    expect(j.suggestion).toBeUndefined()
    expect(j.sourcePage).toBeUndefined()
    expect(
      (await units(t, id)).every(
        (u) => u.output === undefined && u.input === undefined
      )
    ).toBe(true)
    expect((await pageRows(t, pageId, "fr")).draft).toBeNull()
    // Another translation can start on the same page afterwards.
    const again = await startTranslation(owner, pageId)
    expect((await job(t, again))!.state).toBe("running")
  })
  test("Dismiss of a canceled job deletes its partial text", async () => {
    fake.text = "Traduit"
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await source(t, owner)
    await giveSource(t, pageId, 8)
    const id = await startTranslation(owner, pageId)
    await run(t, id, 0)
    expect((await units(t, id))[0]!.output).toBe("Traduit")
    await cancelQueued(t, owner, id)
    expect((await job(t, id))!.state).toBe("canceled")
    await owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    expect(
      (await units(t, id)).every(
        (u) => u.output === undefined && u.input === undefined
      )
    ).toBe(true)
    expect((await job(t, id))!.sourcePage).toBeUndefined()
  })
})

describe("Translate page with AI: Multilingual switched off", () => {
  test("Cancel stops the job and releases the reservation; Dismiss works; Resume refuses", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const id = await startTranslation(owner, await source(t, owner))
    expect((await status(t)).reservedMicros).toBeGreaterThan(0)
    await setModules(t, ["ai"])
    await owner.mutation(api.cms.aiJobs.cancelPageJob, { jobId: id })
    for (const row of await units(t, id))
      if (row.workId && row.state !== "inProgress")
        await callback(t, row, "canceled")
    expect((await job(t, id))!.state).toBe("canceled")
    expect((await status(t)).reservedMicros).toBe(0)
    await expect(
      owner.mutation(api.cms.aiJobs.resumePageJob, { jobId: id })
    ).rejects.toThrow("CMS_MODULE_NOT_READY")
    await expect(
      owner.mutation(api.cms.aiJobs.dismissPageJob, { jobId: id })
    ).resolves.toEqual({ pageMovedToTrash: false })
  })
  test("a claim made while Multilingual is off stops the job without a provider call", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const id = await startTranslation(owner, await source(t, owner))
    await setModules(t, ["ai"])
    expect(await claim(t, id, 0)).toBeNull()
    expect((await job(t, id))!.state).toBe("canceling")
    expect(fake.generate).not.toHaveBeenCalled()
  })
  test("the progress list never reports a translation job as resumable while Multilingual is off", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const id = await startTranslation(owner, await source(t, owner))
    await cancelQueued(t, owner, id)
    const on = (await progress(owner)).find((row) => row.jobId === id)!
    expect(on.state).toBe("canceled")
    expect(on.canResume).toBe(true)
    await setModules(t, ["ai"])
    expect((await progress(owner)).filter((row) => row.jobId === id)).toEqual(
      []
    )
  })
})

describe("Translate page with AI: identifiers are not translated, claims stay cheap", () => {
  test("a features grid keeps its icon names byte for byte, in the draft and out of the review text; titles change", async () => {
    fake.text = "Traduit"
    const { t, owner } = await setup({ multilingual: true })
    const pageId = await source(t, owner)
    const sample = (await import("./lib/slices/sample")).createSampleSlice(
      "features-icon-grid"
    ) as unknown as { items: { icon?: string }[] }
    await t.run(async (ctx) => {
      const draft = (await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique())!
      if (draft.pageType !== "page") throw new Error("Expected Page fixture")
      const icons = ["Zap", "Compass"]
      await ctx.db.patch("pageLocaleDrafts", draft._id, {
        content: {
          ...draft.content,
          slices: [
            {
              ...sample,
              items: sample.items
                .slice(0, 2)
                .map((item, index) => ({ ...item, icon: icons[index] })),
            },
          ],
        },
      } as never)
    })
    const id = await startTranslation(owner, pageId)
    // No unit is made for an icon field.
    expect(
      (await units(t, id)).filter((u) => u.address?.includes("icon"))
    ).toEqual([])
    await finish(t, id)
    const draft = (await job(t, id))!.suggestion!.draft as {
      slices: { items: { icon?: string; title: string }[] }[]
    }
    expect(draft.slices[0]!.items.map((item) => item.icon)).toEqual([
      "Zap",
      "Compass",
    ])
    expect(draft.slices[0]!.items[0]!.title).toContain("Traduit")
    const result = await owner.query(api.cms.aiJobs.pageJobResult, {
      jobId: id,
    })
    const text = result.sections[0]!.fields.map((f) => f.text).join("\n")
    expect(text).toContain("Traduit")
    expect(text).not.toMatch(/Zap|Compass/)
  })
  test("an icon is still editorial text, so the Write page writer fills and validates it", async () => {
    const { isEditorialTextPrimitive, isTranslatableTextPrimitive } =
      await import("./lib/slices/primitives")
    const { readSliceDefinition } = await import("./lib/slices")
    const items = readSliceDefinition("features-icon-grid")!.items!
    const item = items.config.item as { config: { fields: Record<string, Primitive> } }
    const icon = item.config.fields.icon!
    expect(isEditorialTextPrimitive(icon)).toBe(true)
    expect(isTranslatableTextPrimitive(icon)).toBe(false)
    // A rich text title is not a plain text primitive.
    expect(isTranslatableTextPrimitive(item.config.fields.title!)).toBe(false)
  })
  test("a translation claim reads no sibling rows; a write claim still returns its saved siblings", async () => {
    const { t, owner } = await setup({ multilingual: true })
    const translation = await startTranslation(owner, await source(t, owner))
    expect((await claim(t, translation, 0))!.units).toEqual([])
    const second = await setup()
    const write = await start(second.owner, 2)
    await run(second.t, write, 0)
    const claimed = (await claim(second.t, write, 1))!
    expect(claimed.units.map((u) => u.index)).toEqual([0, 1])
    expect(claimed.units[0]!.state).toBe("saved")
  })
})

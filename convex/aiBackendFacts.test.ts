// @vitest-environment node
/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import { api, internal } from "./_generated/api"
import schema from "./schema"
import { hashOwnerClaim } from "./lib/ownerClaim"
import { resolveRuntimeSelection } from "./lib/aiConfig"
import { createRuntimeAccounting, resolveAiModuleReadiness, resolveAiSettingsStatus } from "./lib/ai"
import type { ActionCtx } from "./_generated/server"
import { executeGeneration } from "../lib/ai/execute-generation"
import { recordProviderObservation } from "./cms/ai"
import {
  createOptionalModuleGate,
  type ModuleReadinessProvider,
} from "./lib/modules/state"
import { MODULE_CATALOG } from "../lib/modules/catalog"
import { taskProfileTuple } from "../lib/ai/task-profiles"
import actionRetrierTest from "@convex-dev/action-retrier/test"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "facts-owner",
  tokenIdentifier: "https://convex.test|facts-owner",
}
const KEY = "fake-provider-secret-sentinel"
beforeEach(() => {
  for (const name of [
    "ANTHROPIC_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENAI_API_KEY",
  ])
    vi.stubEnv(name, "")
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function app(settings = true) {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, OWNER)
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: [{ moduleId: "ai", configVersion: 1 }],
    })
    if (settings)
      await ctx.db.insert("siteSettings", {
        siteName: "Facts",
        siteUrl: "https://example.test",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
  })
  return { t, owner: t.withIdentity(OWNER) }
}

test("fake generation reaches runtime settlement with the action's trimmed-key fingerprint", async () => {
  vi.stubEnv("OPENAI_API_KEY", `  ${KEY}  `)
  const { t, owner } = await app()
  const ctx = { runMutation: t.mutation.bind(t) } as unknown as ActionCtx
  await executeGeneration(
    {
      target: { lane: "runtime", provider: "openai" },
      tuple: taskProfileTuple("openai", "editorial-copy"),
      profile: "editorial-copy",
      phase: "content-generation",
      input: { prompt: "Fake provider wiring proof" },
      requirements: { inputModalities: ["text"], structuredOutput: false },
      output: { kind: "text" },
    },
    {
      provider: "openai",
      generate: async () => ({
        text: "Fake response",
        actualModel: "gpt-5.6-terra",
        finishReason: "stop",
        usage: { inputTokens: 1, outputTokens: 1 },
      }),
    },
    createRuntimeAccounting(ctx, OWNER.subject)
  )
  const health = await t.run((context) => context.db.query("aiProviderHealth").unique())
  expect(health).toMatchObject({ provider: "openai", keyFingerprint: await hashOwnerClaim(KEY), state: "ok" })
  const status = await owner.query(api.cms.aiSettings.status, {})
  expect(status.card.state).toBe("active")
  expect(JSON.stringify(status)).not.toContain(KEY)
  expect(JSON.stringify(status)).not.toContain(health!.keyFingerprint)
})

test.each([
  ["all missing", "", undefined, "missing", false],
  ["one present", KEY, undefined, "active", true],
  ["refused only", KEY, "refused", "refused", false],
  ["unreachable only", KEY, "unreachable", "active", true],
] as const)("status/readiness: %s", async (_name, key, health, card, ready) => {
  vi.stubEnv("ANTHROPIC_API_KEY", ` ${key} `)
  const { t, owner } = await app()
  const fingerprint = await hashOwnerClaim(KEY)
  if (health)
    await t.run((ctx) =>
      ctx.db.insert("aiProviderHealth", {
        provider: "anthropic",
        keyFingerprint: fingerprint,
        state: health,
        observedAt: 10,
        sourceAttemptKey: "seed",
      })
    )
  const status = await owner.query(api.cms.aiSettings.status, {})
  expect(
    status.connections.map(({ provider, envVar }) => [provider, envVar])
  ).toEqual([
    ["anthropic", "ANTHROPIC_API_KEY"],
    ["openrouter", "OPENROUTER_API_KEY"],
    ["openai", "OPENAI_API_KEY"],
  ])
  expect(status.card.state).toBe(card)
  expect(status.assistants.find((a) => a.id === "writing")?.ready).toBe(ready)
  expect(status.assistants.find((a) => a.id === "translation")?.available).toBe(
    false
  )
  expect(
    await t.run((ctx) => resolveAiModuleReadiness(ctx, new Set(["ai"])))
  ).toEqual(
    ready
      ? { readiness: "ready", setup: "not_required" }
      : { readiness: "needs_setup", setup: "required" }
  )
  expect(JSON.stringify(status)).not.toContain(KEY)
  expect(JSON.stringify(status)).not.toContain(fingerprint)
  expect(JSON.stringify(status)).not.toContain("keyFingerprint")
})

test("explicit tuples do not fall back; translation alone needs Multilingual; refused wins missing", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", KEY)
  const { t, owner } = await app()
  for (const id of ["writing", "help"] as const)
    await owner.mutation(api.cms.aiSettings.setAssistant, {
      id,
      tuple: taskProfileTuple("anthropic", "editorial-copy"),
    })
  expect((await owner.query(api.cms.aiSettings.status, {})).card).toEqual({
    state: "missing",
  })
  const withTranslation = await t.run((ctx) =>
    resolveAiSettingsStatus(ctx, new Set(["ai", "multilingual"]))
  )
  expect(
    withTranslation.assistants.find((a) => a.id === "translation")
  ).toMatchObject({ available: true, ready: true })
  expect(withTranslation.card.state).toBe("active")
  vi.stubEnv("ANTHROPIC_API_KEY", KEY)
  await t.run((ctx) =>
    ctx.db.insert("aiProviderHealth", {
      provider: "anthropic",
      keyFingerprint: "old-key",
      state: "refused",
      observedAt: 1,
      sourceAttemptKey: "old",
    })
  )
  expect(
    (await owner.query(api.cms.aiSettings.status, {})).connections[0].state
  ).toBe("connected")
  await t.run((ctx) =>
    recordProviderObservation(
      ctx,
      {
        provider: "anthropic",
        keyFingerprint: hashPlaceholder,
        state: "refused",
        observedAt: 2,
      },
      "ignored"
    )
  )
  await t.run(async (ctx) => {
    const row = await ctx.db.query("aiProviderHealth").first()
    await ctx.db.patch("aiProviderHealth", row!._id, {
      keyFingerprint: await hashOwnerClaim(KEY),
    })
  })
  expect((await owner.query(api.cms.aiSettings.status, {})).card).toEqual({
    state: "refused",
    provider: "anthropic",
  })
})
const hashPlaceholder = "not-current"

test("default fallback uses first usable connection; legacy off is no setup preference", async () => {
  vi.stubEnv("OPENAI_API_KEY", KEY)
  const { owner } = await app()
  await owner.mutation(api.cms.aiSettings.setProductionAiConfiguration, {
    selectedProvider: "off",
    providerDefaults: {},
  })
  expect(
    (await owner.query(api.cms.aiSettings.status, {})).assistants.every(
      (a) => a.provider === "openai"
    )
  ).toBe(true)
  vi.stubEnv("OPENROUTER_API_KEY", KEY)
  expect(
    (await owner.query(api.cms.aiSettings.status, {})).assistants.every(
      (a) => a.provider === "openrouter"
    )
  ).toBe(true)
})

test("saving Writing on a legacy row preserves absent selection and other assistants", async () => {
  vi.stubEnv("OPENROUTER_API_KEY", KEY)
  vi.stubEnv("ANTHROPIC_API_KEY", KEY)
  const { t, owner } = await app()
  const availability = { openrouter: true, anthropic: true, openai: false }
  const beforeSettings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
  expect(beforeSettings).not.toHaveProperty("aiRuntime")
  const beforeSelection = resolveRuntimeSelection(beforeSettings?.aiRuntime?.selectedProvider, availability)
  expect(beforeSelection).toMatchObject({ status: "legacy-openrouter", effectiveProvider: "openrouter" })
  const before = await owner.query(api.cms.aiSettings.status, {})
  expect(before.assistants.map(({ provider }) => provider)).toEqual([
    "openrouter", "openrouter", "openrouter",
  ])
  const tuple = taskProfileTuple("anthropic", "editorial-copy")
  await owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })
  const runtime = await t.run(async (ctx) =>
    (await ctx.db.query("siteSettings").unique())?.aiRuntime
  )
  const after = await owner.query(api.cms.aiSettings.status, {})
  const otherProviders = (status: typeof before) => status.assistants
    .filter(({ id }) => id !== "writing")
    .map(({ id, provider }) => ({ id, provider }))
  expect({
    runtime,
    writing: after.assistants.find(({ id }) => id === "writing")?.provider,
    otherProviders: otherProviders(after),
    selection: resolveRuntimeSelection(runtime?.selectedProvider, availability),
  }).toEqual({
    runtime: { assistants: { writing: { tuple } } },
    writing: "anthropic",
    otherProviders: otherProviders(before),
    selection: beforeSelection,
  })
})

test("assistant writes validate every profile and bound instructions; whole-object writer preserves assistants", async () => {
  const { t, owner } = await app()
  const tuple = taskProfileTuple("openai", "mechanical-translation")
  await expect(
    owner.mutation(api.cms.aiSettings.setAssistant, {
      id: "translation",
      tuple: taskProfileTuple("openai", "brand-translation"),
    })
  ).rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
  await expect(
    owner.mutation(api.cms.aiSettings.setAssistant, {
      id: "writing",
      instructions: "x".repeat(4001),
    })
  ).rejects.toThrow("AI_ASSISTANT_INSTRUCTIONS_TOO_LONG")
  await owner.mutation(api.cms.aiSettings.setAssistant, {
    id: "translation",
    tuple,
    instructions: "x".repeat(4000),
  })
  await owner.mutation(api.cms.aiSettings.setProductionAiConfiguration, {
    selectedProvider: "off",
    providerDefaults: {},
  })
  expect(
    await t.run(
      async (ctx) =>
        (await ctx.db.query("siteSettings").first())?.aiRuntime?.assistants
          ?.translation
    )
  ).toEqual({ tuple, instructions: "x".repeat(4000) })
})

test("readiness reads no module state; missing settings cannot block Modules preview/commit", async () => {
  const { t, owner } = await app(false)
  await t.run(async (ctx) => {
    const db = new Proxy(ctx.db, {
      get(target, property) {
        if (property === "query")
          return (table: string) => {
            if (table === "cmsModuleState")
              throw new Error("second module-state read")
            return Reflect.apply(target.query, target, [table])
          }
        return Reflect.get(target, property)
      },
    })
    expect(
      await resolveAiModuleReadiness({ ...ctx, db }, new Set(["ai"]))
    ).toEqual({ readiness: "needs_setup", setup: "required" })
  })
  vi.restoreAllMocks()
  const changes = [{ moduleId: "redirects", enabled: true }]
  await expect(
    owner.query(api.cms.modules.preview, { changes })
  ).resolves.toBeDefined()
  await expect(
    owner.mutation(api.cms.modules.commit, {
      changes,
      expectedConfigurationVersion: 1,
    })
  ).resolves.toBeDefined()
})

test("a throwing AI provider cannot break Redirects or Multilingual guards", async () => {
  const { t } = await app(false)
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("cmsModuleState").first())!
    await ctx.db.patch("cmsModuleState", row._id, {
      enabledModules: ["ai", "redirects", "multilingual"].map((moduleId) => ({
        moduleId,
        configVersion: 1,
      })),
    })
  })
  const ai = vi
    .fn<ModuleReadinessProvider>()
    .mockRejectedValue(new Error("broken AI"))
  const multilingual = vi
    .fn<ModuleReadinessProvider>()
    .mockResolvedValue({ readiness: "ready", setup: "not_required" })
  const gate = createOptionalModuleGate({
    catalog: MODULE_CATALOG,
    readinessProviders: new Map([
      ["ai", ai],
      ["multilingual", multilingual],
    ]),
  })
  for (const id of ["redirects", "multilingual"])
    await expect(
      t.run((ctx) =>
        gate.requireOwnerAndOptionalModule(
          {
            ...ctx,
            auth: {
              ...ctx.auth,
              getUserIdentity: async () => ({
                ...OWNER,
                issuer: "https://convex.test",
              }),
            },
          },
          id
        )
      )
    ).resolves.toBeDefined()
  expect(ai).not.toHaveBeenCalled()
})

test("health transitions: stale/non-current/duplicate dropped, refusal latched, key rotation replaces, newer same-state observations persist", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", KEY)
  const { t } = await app()
  let fingerprint = await hashOwnerClaim(KEY)
  const observe = async (
    state: "ok" | "refused" | "unreachable",
    at: number,
    source = `attempt-${at}`
  ) =>
    t.run((ctx) =>
      recordProviderObservation(
        ctx,
        {
          provider: "anthropic",
          state,
          observedAt: at,
          keyFingerprint: fingerprint,
        },
        source
      )
    )
  const health = () => t.run((ctx) => ctx.db.query("aiProviderHealth").unique())
  await observe("ok", 10)
  const first = await health()
  await t.run(async (ctx) => {
    const replace = vi.spyOn(ctx.db, "replace"),
      insert = vi.spyOn(ctx.db, "insert")
    await recordProviderObservation(
      ctx,
      {
        provider: "anthropic",
        keyFingerprint: fingerprint,
        state: "ok",
        observedAt: 11,
      },
      "same"
    )
    expect(replace).toHaveBeenCalledTimes(1)
    expect(insert).not.toHaveBeenCalled()
  })
  vi.restoreAllMocks()
  expect(await health()).toEqual({ ...first, observedAt: 11, sourceAttemptKey: "same" })
  await observe("unreachable", 9)
  expect((await health())?.state).toBe("ok")
  await observe("unreachable", 12)
  const unreachable = await health()
  await t.run(async (ctx) => {
    const replace = vi.spyOn(ctx.db, "replace"),
      insert = vi.spyOn(ctx.db, "insert")
    await recordProviderObservation(
      ctx,
      {
        provider: "anthropic",
        keyFingerprint: fingerprint,
        state: "unreachable",
        observedAt: 13,
      },
      "same-unreachable"
    )
    expect(replace).toHaveBeenCalledTimes(1)
    expect(insert).not.toHaveBeenCalled()
  })
  vi.restoreAllMocks()
  const repeatedUnreachable = { ...unreachable, observedAt: 13, sourceAttemptKey: "same-unreachable" }
  expect(await health()).toEqual(repeatedUnreachable)
  await observe("refused", 13, "equal-time")
  expect(await health()).toEqual(repeatedUnreachable)
  await observe("ok", 14, "same-unreachable")
  expect(await health()).toEqual(repeatedUnreachable)
  await observe("ok", 15)
  expect((await health())?.state).toBe("ok")
  await observe("refused", 16)
  await observe("ok", 17)
  await observe("unreachable", 18)
  expect((await health())?.state).toBe("refused")
  vi.stubEnv("ANTHROPIC_API_KEY", "")
  await observe("ok", 19)
  expect((await health())?.state).toBe("refused")
  vi.stubEnv("ANTHROPIC_API_KEY", "new-fake-key")
  await observe("ok", 20)
  expect((await health())?.keyFingerprint).toBe(fingerprint)
  fingerprint = await hashOwnerClaim("new-fake-key")
  await observe("ok", 1)
  expect(await health()).toMatchObject({
    state: "ok",
    keyFingerprint: fingerprint,
    observedAt: 1,
  })
})

async function runtimeHealthHarness() {
  vi.stubEnv("ANTHROPIC_API_KEY", KEY)
  const { t } = await app()
  const keyFingerprint = await hashOwnerClaim(KEY)
  const admit = (attemptKey: string) => t.mutation(internal.cms.ai.admitRuntimeAttempt, {
    authId: OWNER.subject,
    request: {
      attemptKey, lane: "runtime", provider: "anthropic",
      modelId: taskProfileTuple("anthropic", "editorial-copy").model,
      profile: "editorial-copy", phase: "content-generation",
      inputTokens: 10, imageTokens: 0, maxOutputTokens: 10,
    },
  })
  const settle = (attemptKey: string, state: "ok" | "refused" | "unreachable", observedAt: number, fingerprint = keyFingerprint) =>
    t.mutation(internal.cms.ai.settleRuntimeAttempt, {
      attemptKey, outcome: "completed",
      providerObservation: { provider: "anthropic", keyFingerprint: fingerprint, state, observedAt },
    })
  const health = () => t.run((ctx) => ctx.db.query("aiProviderHealth").unique())
  return { t, keyFingerprint, admit, settle, health }
}

test.each([
  ["ok", "refused"],
  ["ok", "unreachable"],
  ["unreachable", "ok"],
  ["unreachable", "refused"],
] as const)("r1 health ordering: %s repeated before delayed %s", async (repeated, delayed) => {
  const { admit, settle, health, keyFingerprint } = await runtimeHealthHarness()
  for (const [state, observedAt, source] of [
    [repeated, 10, "first"], [repeated, 30, "newest"], [delayed, 20, "delayed"],
  ] as const) {
    await admit(source)
    await settle(source, state, observedAt)
  }
  expect(await health()).toMatchObject({
    state: repeated, observedAt: 30, sourceAttemptKey: "newest", keyFingerprint,
  })
})

test.each([
  ["ok", "refused"], ["refused", "ok"], ["unreachable", "ok"], ["ok", "unreachable"],
] as const)("r1 health equal timestamps: %s commits before %s", async (first, second) => {
  const { admit, settle, health } = await runtimeHealthHarness()
  await admit("first")
  await admit("equal")
  await settle("first", first, 20)
  const committed = await health()
  await settle("equal", second, 20)
  expect(await health()).toEqual(committed)
})

test.each([
  { name: "refusal before newer success stays refused", observations: [["refused", 20], ["ok", 30]], expected: { state: "refused", observedAt: 20 } },
  { name: "newer success before older refusal stays ok", observations: [["ok", 30], ["refused", 20]], expected: { state: "ok", observedAt: 30 } },
] as const)("r1 health arrival: $name", async ({ observations, expected }) => {
  const { admit, settle, health } = await runtimeHealthHarness()
  for (const index of observations.keys()) await admit(`arrival-${index}`)
  for (const [index, [state, at]] of observations.entries()) {
    await settle(`arrival-${index}`, state, at)
  }
  expect(await health()).toMatchObject(expected)
})

test("r1 health refusal is absorbing, including repeated refusal", async () => {
  const { admit, settle, health } = await runtimeHealthHarness()
  await admit("first-refusal")
  for (const at of [30, 40, 50]) await admit(`after-refusal-${at}`)
  await settle("first-refusal", "refused", 10)
  const committed = await health()
  for (const [state, at] of [["refused", 30], ["ok", 40], ["unreachable", 50]] as const) {
    await settle(`after-refusal-${at}`, state, at)
  }
  expect(await health()).toEqual(committed)
})

test("r1 health deduplicates an older attempt after an intervening observation", async () => {
  const { t, admit, settle, health } = await runtimeHealthHarness()
  await admit("older-attempt")
  const receipt = await settle("older-attempt", "ok", 10)
  await admit("intervening-attempt")
  await settle("intervening-attempt", "unreachable", 30)
  const committed = await health()
  expect(await settle("older-attempt", "refused", 40)).toEqual(receipt)
  expect(await health()).toEqual(committed)
  expect(await t.run((ctx) => ctx.db.query("aiSpendingAttempts")
    .withIndex("by_attemptKey", (q) => q.eq("attemptKey", "older-attempt")).unique()))
    .toMatchObject({ providerObservationRecorded: true })
})

test("r1 health deadline response records once even across an intervening observation", async () => {
  const { t, admit, settle, health } = await runtimeHealthHarness()
  await admit("deadline-attempt")
  const deadline = await t.mutation(internal.cms.ai.settleAttemptAtDeadline, { attemptKey: "deadline-attempt" })
  expect(await health()).toBeNull()
  expect(await settle("deadline-attempt", "ok", 10)).toEqual(deadline)
  expect(await health()).toMatchObject({ state: "ok", observedAt: 10, sourceAttemptKey: "deadline-attempt" })
  await admit("after-deadline")
  await settle("after-deadline", "unreachable", 20)
  const committed = await health()
  expect(await settle("deadline-attempt", "refused", 30)).toEqual(deadline)
  expect(await health()).toEqual(committed)
})

test("r1 health key rotation replaces regardless of time and drops the old key response", async () => {
  const { admit, settle, health } = await runtimeHealthHarness()
  await admit("old-first")
  await settle("old-first", "ok", 10)
  await admit("old-late")
  vi.stubEnv("ANTHROPIC_API_KEY", "rotated-fake-provider-key")
  const rotated = await hashOwnerClaim("rotated-fake-provider-key")
  await admit("new-key")
  await settle("new-key", "unreachable", 1, rotated)
  const committed = await health()
  expect(committed).toMatchObject({ state: "unreachable", observedAt: 1, keyFingerprint: rotated, sourceAttemptKey: "new-key" })
  await settle("old-late", "refused", 40)
  expect(await health()).toEqual(committed)
})

test.each(["writing", "translation", "help"] as const)(
  "r1 tuple validation: unsupported reasoning for %s leaves settings unchanged",
  async (id) => {
    const { t, owner } = await app()
    const before = await t.run((ctx) => ctx.db.query("siteSettings").unique())
    const tuple = {
      mode: "catalog", provider: "openrouter", model: "openai/gpt-4.1-mini",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id, tuple }))
      .rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
    expect(await t.run((ctx) => ctx.db.query("siteSettings").unique())).toEqual(before)
  }
)

test.each(["writing", "translation", "help"] as const)(
  "r1 tuple validation: active image-only catalog for %s leaves settings unchanged",
  async (id) => {
    const { t, owner } = await app()
    const tuple = {
      mode: "catalog", provider: "openrouter", model: "example/image-only-model",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    await t.run((ctx) => ctx.db.insert("openRouterCatalogModels", {
      modelId: tuple.model, name: "Image-only Model", inputModalities: ["image"],
      structuredOutput: false, reasoningEfforts: ["high"], syncedAt: 1,
    }))
    const before = await t.run((ctx) => ctx.db.query("siteSettings").unique())
    await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id, tuple }))
      .rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
    expect(await t.run((ctx) => ctx.db.query("siteSettings").unique())).toEqual(before)
  }
)

test("r1 tuple validation: valid synchronized capabilities override bundled writing limits", async () => {
  const { t, owner } = await app()
  const tuple = {
    mode: "catalog", provider: "openrouter", model: "amazon/nova-2-lite-v1",
    reasoning: { kind: "effort", effort: "high" },
  } as const
  // The bundled model lacks structured output; the active row adds it.
  await t.run((ctx) => ctx.db.insert("openRouterCatalogModels", {
    modelId: tuple.model, name: "Active Nova", inputModalities: ["text", "image"],
    structuredOutput: true, reasoningEfforts: ["high"], syncedAt: 1,
  }))
  await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })).resolves.toBeNull()
  expect(await t.run((ctx) => ctx.db.query("siteSettings").unique())).toMatchObject({
    aiRuntime: { assistants: { writing: { tuple } } },
  })
})

const cardCases = [
  { name: "unused refused connection", states: ["refused", "missing", "missing"], mode: "explicit-openai", multilingual: true, card: { state: "refused", provider: "anthropic" }, facts: [["writing", "openai", true, false], ["translation", "openai", true, false], ["help", "openai", true, false]], ready: false },
  { name: "two unused refusals", states: ["refused", "refused", "missing"], mode: "explicit-openai", multilingual: true, card: { state: "refused", provider: "anthropic" }, facts: [["writing", "openai", true, false], ["translation", "openai", true, false], ["help", "openai", true, false]], ready: false },
  { name: "translation unavailable", states: ["refused", "missing", "missing"], mode: "explicit-openai", multilingual: false, card: { state: "refused", provider: "anthropic" }, facts: [["writing", "openai", true, false], ["translation", "openai", false, false], ["help", "openai", true, false]], ready: false },
  { name: "writing active beats refusals", states: ["refused", "refused", "connected"], mode: "writing", multilingual: false, card: { state: "active" }, facts: [["writing", "openai", true, true], ["translation", "anthropic", false, false], ["help", "anthropic", true, false]], ready: true },
  { name: "help active beats refusals", states: ["refused", "refused", "connected"], mode: "help", multilingual: false, card: { state: "active" }, facts: [["writing", "anthropic", true, false], ["translation", "anthropic", false, false], ["help", "openai", true, true]], ready: true },
  { name: "translation active beats refusals", states: ["refused", "refused", "connected"], mode: "translation", multilingual: true, card: { state: "active" }, facts: [["writing", "anthropic", true, false], ["translation", "openai", true, true], ["help", "anthropic", true, false]], ready: true },
  { name: "unavailable translation cannot activate card", states: ["refused", "refused", "connected"], mode: "translation", multilingual: false, card: { state: "refused", provider: "anthropic" }, facts: [["writing", "anthropic", true, false], ["translation", "openai", false, false], ["help", "anthropic", true, false]], ready: false },
  { name: "refused default never falls back", states: ["refused", "connected", "missing"], mode: "defaults", multilingual: false, card: { state: "refused", provider: "anthropic" }, facts: [["writing", "anthropic", true, false], ["translation", "openrouter", false, false], ["help", "anthropic", true, false]], ready: false },
  { name: "missing default falls back to first usable", states: ["missing", "connected", "connected"], mode: "defaults", multilingual: false, card: { state: "active" }, facts: [["writing", "openrouter", true, true], ["translation", "openrouter", false, false], ["help", "openrouter", true, true]], ready: true },
  { name: "unreachable default remains usable", states: ["unreachable", "connected", "missing"], mode: "defaults", multilingual: false, card: { state: "active" }, facts: [["writing", "anthropic", true, true], ["translation", "openrouter", false, false], ["help", "anthropic", true, true]], ready: true },
  { name: "OpenRouter precedes OpenAI refusal", states: ["missing", "refused", "refused"], mode: "explicit-anthropic", multilingual: false, card: { state: "refused", provider: "openrouter" }, facts: [["writing", "anthropic", true, false], ["translation", "anthropic", false, false], ["help", "anthropic", true, false]], ready: false },
] as const

test.each(cardCases)("r1 card precedence: $name", async ({ states, mode, multilingual, card, facts, ready }) => {
  const { t, owner } = await app()
  const providers = ["anthropic", "openrouter", "openai"] as const
  const keyFingerprint = await hashOwnerClaim(KEY)
  for (const [index, provider] of providers.entries()) {
    const state = states[index]!
    vi.stubEnv(`${provider.toUpperCase()}_API_KEY`, state === "missing" ? "" : KEY)
    if (state === "refused" || state === "unreachable") {
      await t.run((ctx) => ctx.db.insert("aiProviderHealth", {
        provider, keyFingerprint, state, observedAt: 1, sourceAttemptKey: `card-${provider}`,
      }))
    }
  }
  const tupleFor = (id: "writing" | "translation" | "help") => taskProfileTuple(
    mode === "explicit-openai" || mode === id ? "openai" : "anthropic", "mechanical-translation"
  )
  const assistants = mode === "defaults" ? {} : {
    writing: { tuple: tupleFor("writing") }, translation: { tuple: tupleFor("translation") }, help: { tuple: tupleFor("help") },
  }
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("siteSettings").unique()
    await ctx.db.patch("siteSettings", settings!._id, { aiRuntime: { selectedProvider: "off", assistants } })
    if (multilingual) {
      const modules = await ctx.db.query("cmsModuleState").unique()
      await ctx.db.patch("cmsModuleState", modules!._id, { enabledModules: [
        { moduleId: "ai", configVersion: 1 }, { moduleId: "multilingual", configVersion: 1 },
      ] })
    }
  })
  const status = await owner.query(api.cms.aiSettings.status, {})
  expect(status.card).toEqual(card)
  expect(status.assistants.map(({ id, provider, available, ready }) => [id, provider, available, ready])).toEqual(facts)
  expect(await t.run((ctx) => resolveAiModuleReadiness(ctx, new Set(multilingual ? ["ai", "multilingual"] : ["ai"]))))
    .toEqual(ready ? { readiness: "ready", setup: "not_required" } : { readiness: "needs_setup", setup: "required" })
})

test("runtime health is independent of deadline finance; local settlement rejects health; owner erasure clears it", async () => {
  vi.stubEnv("OPENAI_API_KEY", KEY)
  const { t, owner } = await app()
  const attemptKey = "late-response"
  await t.mutation(internal.cms.ai.admitRuntimeAttempt, {
    authId: OWNER.subject,
    request: {
      attemptKey,
      provider: "openai",
      modelId: "gpt-5.6-luna",
      lane: "runtime",
      profile: "editorial-copy",
      phase: "content-generation",
      inputTokens: 10,
      imageTokens: 0,
      maxOutputTokens: 10,
    },
  })
  const first = await t.mutation(internal.cms.ai.settleAttemptAtDeadline, {
    attemptKey,
  })
  const providerObservation = {
    provider: "openai" as const,
    keyFingerprint: await hashOwnerClaim(KEY),
    state: "ok" as const,
    observedAt: 5,
  }
  expect(
    await t.mutation(internal.cms.ai.settleRuntimeAttempt, {
      attemptKey,
      outcome: "completed",
      providerObservation,
    })
  ).toEqual(first)
  expect(
    await t.run((ctx) => ctx.db.query("aiProviderHealth").unique())
  ).toMatchObject({ state: "ok", sourceAttemptKey: attemptKey })
  await t.mutation(internal.cms.ai.settleRuntimeAttempt, {
    attemptKey,
    outcome: "failed",
    providerObservation: {
      ...providerObservation,
      state: "refused",
      observedAt: 6,
    },
  })
  expect(
    await t.run((ctx) => ctx.db.query("aiProviderHealth").unique())
  ).toMatchObject({ state: "ok" })
  await expect(
    owner.mutation(api.cms.ai.settleLocalAttempt, {
      attemptKey,
      outcome: "completed",
      ...{ providerObservation },
    })
  ).rejects.toThrow()
  await owner.mutation(api.cms.aiAuditLog.deleteAuditLogForUser, {
    authId: OWNER.subject,
  })
  expect(
    await t.run((ctx) => ctx.db.query("aiProviderHealth").take(3))
  ).toEqual([])
  // A late completion after erasure must not recreate installation metadata.
  await t.mutation(internal.cms.ai.settleRuntimeAttempt, {
    attemptKey,
    outcome: "completed",
    providerObservation,
  })
  expect(
    await t.run((ctx) => ctx.db.query("aiProviderHealth").take(3))
  ).toEqual([])
})

test("health is retained across module disable/enable and remains bounded to three providers", async () => {
  const { t, owner } = await app()
  const keyFingerprint = await hashOwnerClaim(KEY)
  for (const provider of ["anthropic", "openrouter", "openai"] as const) {
    vi.stubEnv(`${provider.toUpperCase()}_API_KEY`, KEY)
    await t.run((ctx) =>
      recordProviderObservation(
        ctx,
        {
          provider,
          keyFingerprint,
          state: "ok",
          observedAt: 1,
        },
        provider
      )
    )
    await t.run((ctx) =>
      recordProviderObservation(
        ctx,
        {
          provider,
          keyFingerprint,
          state: "refused",
          observedAt: 2,
        },
        `refused-${provider}`
      )
    )
  }
  const before = await t.run((ctx) => ctx.db.query("aiProviderHealth").take(4))
  expect(before).toHaveLength(3)
  await owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: 1,
    changes: [{ moduleId: "ai", enabled: false }],
  })
  await owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: 2,
    changes: [{ moduleId: "ai", enabled: true }],
  })
  expect(
    await t.run((ctx) => ctx.db.query("aiProviderHealth").take(4))
  ).toEqual(before)
})

// S2b: cap enforcement is parked, while the same ledger still records spend.
test("parked cap admits and records spend above five dollars", async () => {
  const { t, owner } = await app()
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("siteSettings").unique()
    await ctx.db.patch("siteSettings", settings!._id, {
      aiMonthlyCapMicros: 5_000_000,
    })
  })
  const admission = await owner.mutation(api.cms.ai.admitLocalAttempt, {
    request: {
      attemptKey: "above-five-dollars",
      provider: "openai",
      modelId: "gpt-5.6-terra",
      lane: "local-build",
      profile: "editorial-copy",
      phase: "content-generation",
      inputTokens: 1,
      imageTokens: 0,
      maxOutputTokens: 1,
    },
  })
  expect(admission.admitted).toBe(true)
  await owner.mutation(api.cms.ai.settleLocalAttempt, {
    attemptKey: "above-five-dollars",
    outcome: "completed",
    usage: {
      inputTokens: 1,
      outputTokens: 1,
      noCacheInputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      providerCostUsd: 6,
    },
  })
  const next = await owner.mutation(api.cms.ai.admitLocalAttempt, {
    request: {
      attemptKey: "after-six-dollars",
      provider: "openai",
      modelId: "gpt-5.6-terra",
      lane: "local-build",
      profile: "editorial-copy",
      phase: "content-generation",
      inputTokens: 1,
      imageTokens: 0,
      maxOutputTokens: 1,
    },
  })
  expect(next.admitted).toBe(true)
  const month = await t.query(internal.cms.ai.monthStatus, { now: Date.now() })
  expect(month).toMatchObject({
    spentMicros: 6_000_000,
    capMicros: Number.MAX_SAFE_INTEGER,
    status: "below",
  })
  expect(
    await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())
  ).toHaveLength(2)
})

// OpenRouter prices come only from the synchronized catalog table. A new site
// has no rows until the first refresh succeeds, so admission is refused then.
const SLICE_ADMISSION = {
  "vision-spec": "slice-spec",
  "renderer-jsx": "renderer-jsx",
} as const

function sliceRequest(
  provider: "anthropic" | "openai" | "openrouter",
  profile: keyof typeof SLICE_ADMISSION,
  attemptKey: string
) {
  return {
    attemptKey,
    provider,
    modelId: taskProfileTuple(provider, profile).model,
    lane: "local-build" as const,
    profile,
    phase: SLICE_ADMISSION[profile],
    inputTokens: 1,
    imageTokens: 0,
    maxOutputTokens: 1,
  }
}

test("OpenRouter local admission is refused while the price list is empty", async () => {
  const { t, owner } = await app()
  expect(
    await t.run((ctx) => ctx.db.query("openRouterCatalogModels").take(1))
  ).toHaveLength(0)
  await expect(
    owner.mutation(api.cms.ai.admitLocalAttempt, {
      request: sliceRequest("openrouter", "vision-spec", "or-empty"),
    })
  ).rejects.toThrow("AI model has no complete price quote.")
})

test.each([
  ["anthropic", "vision-spec"],
  ["anthropic", "renderer-jsx"],
  ["openai", "vision-spec"],
  ["openai", "renderer-jsx"],
] as const)(
  "%s local admission for %s does not need the OpenRouter price list",
  async (provider, profile) => {
    const { owner } = await app()
    const admission = await owner.mutation(api.cms.ai.admitLocalAttempt, {
      request: sliceRequest(provider, profile, `direct-${provider}-${profile}`),
    })
    expect(admission.admitted).toBe(true)
  }
)

test("OpenRouter local admission passes once the default model has a published price", async () => {
  const { t, owner } = await app()
  const modelId = taskProfileTuple("openrouter", "vision-spec").model
  await t.mutation(internal.cms.openRouterCatalog.publishCatalog, {
    models: [
      {
        modelId,
        name: "Default",
        inputModalities: ["text", "image"],
        structuredOutput: true,
        reasoningEfforts: [],
        inputPerM: 1,
        outputPerM: 2,
        ceilingInputPerM: 1,
        ceilingOutputPerM: 2,
      },
    ],
    syncedAt: Date.now(),
  })
  const admission = await owner.mutation(api.cms.ai.admitLocalAttempt, {
    request: sliceRequest("openrouter", "vision-spec", "or-published"),
  })
  expect(admission.admitted).toBe(true)
})

// ensureFirstRefresh starts the Action Retrier run; the scheduled action is a
// real fetch, so the global fetch never resolves and no request leaves a test.
async function refreshApp() {
  const made = await app()
  actionRetrierTest.register(made.t)
  vi.stubGlobal("fetch", vi.fn(() => new Promise<Response>(() => {})))
  return made
}
const syncRow = (t: Awaited<ReturnType<typeof app>>["t"]) =>
  t.run((ctx) =>
    ctx.db
      .query("openRouterCatalogSync")
      .withIndex("by_key", (q) => q.eq("key", "openrouter"))
      .unique()
  )

test("ensureFirstRefresh starts a refresh when none ever ran", async () => {
  const { t } = await refreshApp()
  await t.mutation(internal.cms.openRouterCatalog.ensureFirstRefresh, {})
  expect(await syncRow(t)).toMatchObject({ status: "running" })
  expect((await syncRow(t))?.runId).toEqual(expect.any(String))
})

test("ensureFirstRefresh does nothing after a refresh succeeded", async () => {
  const { t } = await refreshApp()
  await t.run((ctx) =>
    ctx.db.insert("openRouterCatalogSync", {
      key: "openrouter",
      status: "success",
      lastAttemptAt: 1,
      lastSuccessAt: 1,
      modelCount: 3,
      runId: "done",
    })
  )
  const before = await syncRow(t)
  await t.mutation(internal.cms.openRouterCatalog.ensureFirstRefresh, {})
  expect(await syncRow(t)).toEqual(before)
})

test("ensureFirstRefresh leaves a run inside the lock window alone", async () => {
  const { t } = await refreshApp()
  await t.run((ctx) =>
    ctx.db.insert("openRouterCatalogSync", {
      key: "openrouter",
      status: "running",
      lastAttemptAt: Date.now() - 1_000,
      runId: "in-flight",
    })
  )
  const before = await syncRow(t)
  await t.mutation(internal.cms.openRouterCatalog.ensureFirstRefresh, {})
  expect(await syncRow(t)).toEqual(before)
})

test("ensureFirstRefresh retries after a failed first attempt", async () => {
  const { t } = await refreshApp()
  await t.run((ctx) =>
    ctx.db.insert("openRouterCatalogSync", {
      key: "openrouter",
      status: "failed",
      lastAttemptAt: 1,
      lastFailureAt: 1,
      runId: "old-run",
      error: "boom",
    })
  )
  await t.mutation(internal.cms.openRouterCatalog.ensureFirstRefresh, {})
  const after = await syncRow(t)
  expect(after).toMatchObject({ status: "running", lastFailureAt: 1 })
  expect(after?.runId).not.toBe("old-run")
})

test("live status has no Slice creator and module readiness is unchanged", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", KEY)
  vi.stubEnv("OPENAI_API_KEY", KEY)
  const { t, owner } = await app()
  // Anthropic stays usable; OpenAI is refused, and Writing and Help are pinned to it.
  await t.run(async (ctx) => {
    await ctx.db.insert("aiProviderHealth", {
      provider: "openai",
      keyFingerprint: await hashOwnerClaim(KEY),
      state: "refused",
      observedAt: 10,
      sourceAttemptKey: "seed",
    })
  })
  await owner.mutation(api.cms.aiSettings.setAssistant, {
    id: "writing",
    tuple: taskProfileTuple("openai", "editorial-copy"),
  })
  await owner.mutation(api.cms.aiSettings.setAssistant, {
    id: "help",
    tuple: taskProfileTuple("openai", "grounded-help"),
  })
  const observe = async () => ({
    status: await owner.query(api.cms.aiSettings.status, {}),
    configured: await owner.query(api.cms.ai.isConfigured, {}),
    readiness: await t.run((ctx) => resolveAiModuleReadiness(ctx, new Set(["ai"]))),
  })
  const before = await observe()
  expect(before.status.assistants.map(({ id }) => id)).toEqual(["writing", "translation", "help"])
  expect(before.status.card).toEqual({ state: "refused", provider: "openai" })
  expect(before.configured).toBe(false)

  const tuple = taskProfileTuple("anthropic", "vision-spec")
  await owner.mutation(api.cms.aiSettings.setSliceCreator, { tuple, instructions: "Keep it plain." })
  const stored = await t.run((ctx) => ctx.db.query("siteSettings").unique())
  expect(stored?.aiRuntime?.assistants?.sliceCreator).toEqual({ tuple, instructions: "Keep it plain." })

  const after = await observe()
  expect(after).toEqual(before)
  expect(after.status.assistants.map(({ id }) => id)).toEqual(["writing", "translation", "help"])
  expect(after.status.card.state).not.toBe("active")
  expect(JSON.stringify(after.status)).not.toContain("sliceCreator")
})

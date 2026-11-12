/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { api } from "./_generated/api"
import schema from "./schema"
import { signLocalAiAudit } from "./lib/localAiAuditProof"
import { seedCommunityOwner } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")

/**
 * The one durable Community owner. Both identity fields are explicit and
 * shared, so `withIdentity(OWNER)` matches the seeded `cmsOwner` binding
 * exactly rather than relying on convex-test's `<issuer>|<subject>` default.
 */
const OWNER = {
  subject: "owner-1",
  tokenIdentifier: "https://convex.test|owner-1",
  email: "owner@example.test",
}

async function setup() {
  const t = convexTest(schema, modules)
  rateLimiterTest.register(t)
  await seedCommunityOwner(t, OWNER)
  await t.run((ctx) =>
    ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: [{ moduleId: "ai", configVersion: 1 }],
    })
  )
  return t
}

describe("local generation preflight", () => {
  test("returns only task-scoped prompt and brand configuration", async () => {
    const t = await setup()
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", {
        siteName: "Test site",
        siteUrl: "https://example.test",
        defaultLocale: "en",
        enabledLocales: ["en"],
        brandVoice: "Warm, direct, and specific.",
        aiProvider: "legacy-provider",
        aiDefaultModel: "production-only-model",
        aiRuntime: {
          selectedProvider: "openrouter",
          providerDefaults: {
            openrouter: {
              mode: "catalog",
              provider: "openrouter",
              model: "production/provider-model",
            },
          },
        },
        updatedAt: 1,
      })
      await ctx.db.insert("agentConfigs", {
        agent: "content",
        model: "production-agent-model",
        userPromptTemplate: "Saved brief: {brief}",
        updatedAt: 1,
      })
    })

    const asOwner = t.withIdentity(OWNER)
    const result = await asOwner.action(api.agents.localGeneration.preflight, {
      kind: "field-generate",
    })

    expect(result).toEqual({
      profile: "editorial-copy",
      phase: "content-generation",
      userPromptTemplate: "Saved brief: {brief}",
      brandVoice: "Warm, direct, and specific.",
    })
    const serialized = JSON.stringify(result)
    expect(serialized).not.toContain("production-only-model")
    expect(serialized).not.toContain("production-agent-model")
    expect(serialized).not.toContain("production/provider-model")
    expect(serialized).not.toContain("selectedProvider")
    expect(serialized).not.toContain("modelOverrides")
  })

  test("derives every owner task profile and phase from the operation", async () => {
    const t = await setup()
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", {
        siteName: "Test site",
        siteUrl: "https://example.test",
        defaultLocale: "en",
        enabledLocales: ["en"],
        brandVoice: "Use the configured brand voice.",
        aiProvider: "legacy-provider",
        updatedAt: 1,
      })
      await Promise.all([
        ctx.db.insert("agentConfigs", {
          agent: "translation",
          userPromptTemplate: "Translate saved: {text}",
          updatedAt: 1,
        }),
        ctx.db.insert("agentConfigs", {
          agent: "content",
          userPromptTemplate: "Content saved: {brief}",
          updatedAt: 1,
        }),
        ctx.db.insert("agentConfigs", {
          agent: "help-assistant",
          userPromptTemplate: "Help saved: {question}",
          updatedAt: 1,
        }),
      ])
    })

    const asOwner = t.withIdentity(OWNER)
    const cases = [
      [
        "field-translate",
        "mechanical-translation",
        "translation",
        "Translate saved: {text}",
        null,
      ],
      [
        "page-translate",
        "brand-translation",
        "translation",
        "Translate saved: {text}",
        null,
      ],
      [
        "field-refine",
        "editorial-copy",
        "content-refinement",
        null,
        "Use the configured brand voice.",
      ],
      [
        "slice-generate",
        "editorial-copy",
        "content-generation",
        "Content saved: {brief}",
        "Use the configured brand voice.",
      ],
      [
        "page-generate-fill",
        "editorial-copy",
        "page-fill",
        "Content saved: {brief}",
        "Use the configured brand voice.",
      ],
      [
        "page-generate-meta",
        "structured-outline-meta",
        "page-meta",
        null,
        "Use the configured brand voice.",
      ],
      [
        "page-generate-outline",
        "structured-outline-meta",
        "page-outline",
        "Content saved: {brief}",
        "Use the configured brand voice.",
      ],
      [
        "help-answer",
        "grounded-help",
        "help-answer",
        "Help saved: {question}",
        null,
      ],
    ] as const

    for (const [
      kind,
      profile,
      phase,
      userPromptTemplate,
      brandVoice,
    ] of cases) {
      const result = await asOwner.action(
        api.agents.localGeneration.preflight,
        { kind }
      )
      expect(result).toMatchObject({
        profile,
        phase,
        userPromptTemplate,
        brandVoice,
      })
      expect(result).not.toHaveProperty("audit")
    }
  })

  // Frozen Team role evidence; re-home under T01/F04 without weakening it
  // into Community owner-only assertions. The preserved intent is that an
  // *editor* tier — not the installation owner — reaches preflight and gets
  // the same task-scoped envelope. Community resolves no editor role, so
  // there is no Community authority this can assert against today.
  test.skip("derives every editor task profile and phase from the operation", async () => {
    const t = convexTest(schema, modules)
    rateLimiterTest.register(t)
    await t.run(async (ctx) => {
      await ctx.db.insert("roles", {
        authId: "editor-1",
        role: "editor",
        assignedAt: Date.now(),
      })
      await ctx.db.insert("siteSettings", {
        siteName: "Test site",
        siteUrl: "https://example.test",
        defaultLocale: "en",
        enabledLocales: ["en"],
        brandVoice: "Use the configured brand voice.",
        updatedAt: 1,
      })
      await ctx.db.insert("agentConfigs", {
        agent: "content",
        userPromptTemplate: "Content saved: {brief}",
        updatedAt: 1,
      })
    })

    const asEditor = t.withIdentity({
      subject: "editor-1",
      tokenIdentifier: "https://convex.test|editor-1",
      email: "editor@example.test",
    })

    await expect(
      asEditor.action(api.agents.localGeneration.preflight, {
        kind: "slice-generate",
      })
    ).resolves.toMatchObject({
      profile: "editorial-copy",
      phase: "content-generation",
      userPromptTemplate: "Content saved: {brief}",
      brandVoice: "Use the configured brand voice.",
    })
  })
})

describe("local generation audit ingress", () => {
  beforeEach(() => {
    vi.stubEnv("CONTACT_IP_PROOF_SECRET", "test-local-ai-audit-proof-secret")
  })

  afterEach(() => {
    vi.unstubAllEnvs()
  })

  test("rejects direct authenticated audit calls with forged valid-looking identity", async () => {
    const t = await setup()
    const asOwner = t.withIdentity(OWNER)

    const forgedEvent = {
      kind: "help-answer" as const,
      selectedEngine: "claude-cli" as const,
      selectedModel: "private-customer-identifier",
      selectedReasoning: "low" as const,
      actualEngine: "claude-cli" as const,
      actualModel: "claude-haiku-4-5",
      actualReasoning: "low" as const,
      identityEvidence: "transcript-observed" as const,
      attempts: 1 as const,
      tokenUsage: {},
      success: true,
    }

    await expect(
      asOwner.mutation(api.agents.localGeneration.recordAudit, forgedEvent)
    ).rejects.toThrow(/server proof/i)

    const signedLegitimateEvent = await signLocalAiAudit({
      ...forgedEvent,
      selectedModel: "haiku",
    })
    await expect(
      asOwner.mutation(api.agents.localGeneration.recordAudit, {
        ...signedLegitimateEvent,
        selectedModel: forgedEvent.selectedModel,
      })
    ).rejects.toThrow(/server proof/i)

    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(0)
  })

  test("records a same-locale page translation without fabricated generation identity", async () => {
    const t = await setup()
    const asOwner = t.withIdentity(OWNER)
    const noGeneration = {
      kind: "page-translate" as const,
      selectedEngine: "openrouter-api" as const,
      selectedReasoning: "medium" as const,
      attempts: 0 as const,
      tokenUsage: {},
      success: true,
    }

    await expect(
      asOwner.mutation(
        api.agents.localGeneration.recordAudit,
        await signLocalAiAudit(noGeneration)
      )
    ).resolves.toBeNull()

    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "page-translate",
      profile: "brand-translation",
      selectedEngine: "openrouter-api",
      selectedReasoning: "medium",
      attempts: 0,
      tokenUsage: {},
      success: true,
    })
    expect(rows[0]!.actualEngine).toBeUndefined()
    expect(rows[0]!.identityEvidence).toBeUndefined()

    for (const invalid of [
      { ...noGeneration, kind: "field-translate" as const },
      { ...noGeneration, attempts: 1 as const },
      { ...noGeneration, actualEngine: "openrouter-api" as const },
      { ...noGeneration, actualReasoning: "medium" as const },
      { ...noGeneration, identityEvidence: "runtime-observed" as const },
      { ...noGeneration, tokenUsage: { totalTokens: 0 } },
      { ...noGeneration, errorCode: "TIMEOUT" as const },
    ]) {
      await expect(
        asOwner.mutation(
          api.agents.localGeneration.recordAudit,
          await signLocalAiAudit(invalid)
        )
      ).rejects.toThrow(/identity|no-generation|zero-attempt/i)
    }
  })

  test("persists only a page-fill SHA-256 brief hash", async () => {
    const t = await setup()
    const asOwner = t.withIdentity(OWNER)
    const briefHash =
      "a7be5022f2a7eb55fe155382755b81370041a163fa0199e921c23b923f78b554"
    const event = {
      kind: "page-generate-fill" as const,
      briefHash,
      sliceCount: 1,
      selectedEngine: "codex-cli" as const,
      selectedReasoning: "medium" as const,
      identityEvidence: "selected-only" as const,
      attempts: 1 as const,
      tokenUsage: { promptTokens: 30, completionTokens: 8, totalTokens: 38 },
      success: true,
    }

    await expect(
      asOwner.mutation(
        api.agents.localGeneration.recordAudit,
        await signLocalAiAudit(event)
      )
    ).resolves.toBeNull()
    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "page-generate-fill",
      briefHash,
      sliceCount: 1,
    })

    for (const invalid of [
      { ...event, briefHash: "private customer brief" },
      { ...event, briefHash: briefHash.toUpperCase() },
      { ...event, kind: "field-generate" as const },
    ]) {
      await expect(
        asOwner.mutation(
          api.agents.localGeneration.recordAudit,
          await signLocalAiAudit(invalid)
        )
      ).rejects.toThrow(/brief hash|sha-256|page fill/i)
    }
  })

  test("persists a lowercase SHA-256 outline brief hash", async () => {
    const t = await setup()
    const asOwner = t.withIdentity(OWNER)
    const briefHash =
      "76f5e757fd4613caa049ba941e198dad51ecfda0ea0dc3d768a9727c4b575470"
    const event = {
      kind: "page-generate-outline" as const,
      briefHash,
      sliceCount: 2,
      selectedEngine: "claude-cli" as const,
      selectedReasoning: "medium" as const,
      actualEngine: "claude-cli" as const,
      actualReasoning: "medium" as const,
      identityEvidence: "transcript-observed" as const,
      attempts: 1 as const,
      tokenUsage: { promptTokens: 40, completionTokens: 25, totalTokens: 65 },
      success: true,
    }

    await expect(
      asOwner.mutation(
        api.agents.localGeneration.recordAudit,
        await signLocalAiAudit(event)
      )
    ).resolves.toBeNull()
    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      kind: "page-generate-outline",
      briefHash,
      sliceCount: 2,
    })

    const { briefHash: removedBriefHash, ...withoutHash } = event
    expect(removedBriefHash).toBe(briefHash)
    for (const invalid of [
      withoutHash,
      { ...event, briefHash: "private customer brief" },
      { ...event, briefHash: briefHash.toUpperCase() },
    ]) {
      await expect(
        asOwner.mutation(
          api.agents.localGeneration.recordAudit,
          await signLocalAiAudit(invalid)
        )
      ).rejects.toThrow(/brief hash|sha-256|page outline/i)
    }
  })

  test("derives authenticated local metadata and rejects customer content", async () => {
    const t = await setup()
    const asOwner = t.withIdentity(OWNER)
    const event = {
      kind: "help-answer" as const,
      selectedEngine: "claude-cli" as const,
      selectedModel: "haiku",
      selectedReasoning: "low" as const,
      actualEngine: "claude-cli" as const,
      actualModel: "claude-haiku-4-5",
      actualReasoning: "low" as const,
      identityEvidence: "transcript-observed" as const,
      attempts: 1 as const,
      tokenUsage: { promptTokens: 12, completionTokens: 18, totalTokens: 30 },
      success: true,
    }

    await expect(
      asOwner.mutation(
        api.agents.localGeneration.recordAudit,
        await signLocalAiAudit(event)
      )
    ).resolves.toBeNull()

    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      authId: "owner-1",
      kind: "help-answer",
      profile: "grounded-help",
      phase: "help-answer",
      selectedLane: "local-build",
      selectedEngine: "claude-cli",
      selectedModel: "haiku",
      selectedReasoning: "low",
      actualEngine: "claude-cli",
      actualModel: "claude-haiku-4-5",
      actualReasoning: "low",
      identityEvidence: "transcript-observed",
      attempts: 1,
      tokenUsage: { promptTokens: 12, completionTokens: 18, totalTokens: 30 },
      success: true,
      sliceCount: 0,
      modelId: "claude-cli",
    })
    expect(rows[0]!.selectedProvider).toBeUndefined()
    expect(rows[0]!.actualProvider).toBeUndefined()

    await expect(
      asOwner.mutation(
        api.agents.localGeneration.recordAudit,
        await signLocalAiAudit({
          ...event,
          prompt: "private customer prompt",
          output: "private generated output",
        } as typeof event)
      )
    ).rejects.toThrow(/ArgumentValidationError|Validator error/)

    for (const injected of [
      { selectedModel: "private customer prompt" },
      { briefHash: "private-customer-prompt" },
      { errorCode: "private-customer-prompt" },
    ]) {
      await expect(
        asOwner.mutation(
          api.agents.localGeneration.recordAudit,
          await signLocalAiAudit({
            ...event,
            ...injected,
          } as typeof event)
        )
      ).rejects.toThrow(
        /ArgumentValidationError|Validator error|Only page fill|bounded model identifier/
      )
    }

    const serialized = JSON.stringify(
      await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    )
    expect(serialized).not.toContain("private customer prompt")
    expect(serialized).not.toContain("private generated output")
  })

  test("rejects identity evidence that the selected engine cannot provide", async () => {
    const t = await setup()
    const asOwner = t.withIdentity(OWNER)

    await expect(
      asOwner.mutation(
        api.agents.localGeneration.recordAudit,
        await signLocalAiAudit({
          kind: "help-answer",
          selectedEngine: "codex-cli",
          selectedReasoning: "low",
          identityEvidence: "transcript-observed",
          attempts: 1,
          tokenUsage: {},
          success: true,
        })
      )
    ).rejects.toThrow(/selected-only/i)

    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(0)
  })

  test("rejects unbounded or non-integer audit counts", async () => {
    const t = await setup()
    const asOwner = t.withIdentity(OWNER)
    const event = {
      kind: "help-answer" as const,
      selectedEngine: "codex-cli" as const,
      selectedReasoning: "low" as const,
      identityEvidence: "selected-only" as const,
      attempts: 1 as const,
      tokenUsage: {},
      success: true,
    }

    for (const invalid of [
      { sliceCount: -1 },
      { sliceCount: 1.5 },
      { tokenUsage: { promptTokens: Number.NaN } },
      { tokenUsage: { totalTokens: 1_000_000_001 } },
    ]) {
      await expect(
        asOwner.mutation(
          api.agents.localGeneration.recordAudit,
          await signLocalAiAudit({
            ...event,
            ...invalid,
          })
        )
      ).rejects.toThrow(/bounded non-negative integers/i)
    }

    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(0)
  })

  test("rate-limits the independently callable audit ingress", async () => {
    const t = await setup()
    const asOwner = t.withIdentity(OWNER)
    const event = {
      kind: "help-answer" as const,
      selectedEngine: "codex-cli" as const,
      selectedReasoning: "low" as const,
      identityEvidence: "selected-only" as const,
      attempts: 1 as const,
      tokenUsage: {},
      success: true,
    }

    for (let index = 0; index < 20; index += 1) {
      await expect(
        asOwner.mutation(
          api.agents.localGeneration.recordAudit,
          await signLocalAiAudit(event)
        )
      ).resolves.toBeNull()
    }
    await expect(
      asOwner.mutation(
        api.agents.localGeneration.recordAudit,
        await signLocalAiAudit(event)
      )
    ).rejects.toThrow(/RateLimited|aiAuditPerUser/)

    const rows = await t.run((ctx) => ctx.db.query("aiAuditLog").collect())
    expect(rows).toHaveLength(20)
  })
})

// @vitest-environment node
/// <reference types="vite/client" />
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import schema from "./schema"
import { api, internal } from "./_generated/api"
import { hashOwnerClaim } from "./lib/ownerClaim"
import { ASSISTANT_PROFILES, taskProfileTuple } from "../lib/ai/task-profiles"
import { resolveAssistantRuntimeTuple } from "./lib/ai"
import rateLimiterTest from "@convex-dev/rate-limiter/test"

const fake = vi.hoisted(() => ({ generate: vi.fn(), beforeAdmission: vi.fn() }))
vi.mock("ai", () => ({ generateText: fake.generate }))
// Pause at our accounting seam, after real prepare and before real admission.
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
  }
})
const modules = import.meta.glob("./**/*.ts")
const identity = {
  subject: "execution-owner",
  tokenIdentifier: "https://test|execution-owner",
}
beforeEach(() => {
  fake.beforeAdmission.mockReset()
  vi.stubEnv("ANTHROPIC_API_KEY", "fake-anthropic")
  vi.stubEnv("OPENAI_API_KEY", "fake-openai")
  vi.stubEnv("OPENROUTER_API_KEY", "")
  vi.stubEnv("CMS_AI_MODEL", "")
  fake.generate
    .mockReset()
    .mockResolvedValue({
      text: "Clear text",
      finishReason: "stop",
      usage: { raw: { reported: true }, inputTokens: 1, outputTokens: 1 },
      finalStep: { response: { modelId: "gpt-5.6-terra" } },
    })
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
async function app(on = true) {
  const t = convexTest(schema, modules)
  rateLimiterTest.register(t)
  await seedCommunityOwner(t, identity)
  const settingsId = await t.run(async (ctx) => {
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: on ? [{ moduleId: "ai", configVersion: 1 }] : [],
    })
    return ctx.db.insert("siteSettings", {
      siteName: "Execution",
      siteUrl: "https://example.test",
      defaultLocale: "en",
      enabledLocales: ["en"],
      updatedAt: 1,
    })
  })
  const owner = t.withIdentity(identity)
  return { t, owner, settingsId }
}
const field = {
  sliceType: "hero-with-image",
  fieldLabel: "Title",
  locale: "en",
  brief: "Describe our service",
}

test("S2b module off refuses prepare and local admission before any provider work", async () => {
  const { t, owner } = await app(false)
  await expect(
    owner.query(internal.agents.contentWriter.prepareGeneration, {})
  ).rejects.toThrow("CMS_MODULE_DISABLED")
  await expect(owner.query(api.cms.ai.isConfigured, {})).rejects.toThrow(
    "CMS_MODULE_DISABLED"
  )
  await expect(
    owner.mutation(api.cms.ai.admitLocalAttempt, {
      request: {
        attemptKey: "off-local",
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
  ).rejects.toThrow("CMS_MODULE_DISABLED")
  expect(fake.generate).not.toHaveBeenCalled()
  expect(
    await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())
  ).toEqual([])
})

test("S2b explicit missing key refuses before admission and health writes", async () => {
  vi.stubEnv("OPENAI_API_KEY", "")
  const { t, owner, settingsId } = await app()
  await t.run((ctx) =>
    ctx.db.patch("siteSettings", settingsId, {
      aiRuntime: {
        assistants: {
          writing: { tuple: taskProfileTuple("openai", "editorial-copy") },
        },
      },
    })
  )
  await expect(
    owner.action(api.agents.contentWriter.generateField, field)
  ).rejects.toMatchObject({
    data: expect.objectContaining({
      category: "CONFIG_MISSING",
      attempts: 0,
      nextAction: "configure-provider",
    }),
  })
  expect(fake.generate).not.toHaveBeenCalled()
  expect(
    await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())
  ).toEqual([])
  expect(
    await t.run((ctx) => ctx.db.query("aiProviderHealth").collect())
  ).toEqual([])
})

test("S2b refused key blocks its assistant only, before provider or admission", async () => {
  const { t, owner, settingsId } = await app()
  await t.run(async (ctx) => {
    await ctx.db.patch("siteSettings", settingsId, {
      aiRuntime: {
        assistants: {
          writing: { tuple: taskProfileTuple("openai", "editorial-copy") },
        },
      },
    })
    await ctx.db.insert("aiProviderHealth", {
      provider: "openai",
      keyFingerprint: await hashOwnerClaim("fake-openai"),
      state: "refused",
      observedAt: 1,
      sourceAttemptKey: "fixture",
    })
  })
  await expect(
    owner.action(api.agents.contentWriter.generateField, field)
  ).rejects.toMatchObject({
    data: expect.objectContaining({
      category: "AUTH_REQUIRED",
      attempts: 0,
      nextAction: "authenticate-provider",
    }),
  })
  await expect(
    owner.query(internal.agents.helpAssistant.prepareHelp, {})
  ).resolves.toBeDefined()
  expect(fake.generate).not.toHaveBeenCalled()
  expect(
    await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())
  ).toEqual([])
})

test("S2b explicit tuple overrides agent model and prepends stored instructions to the contract", async () => {
  const { t, owner, settingsId } = await app()
  await t.run(async (ctx) => {
    await ctx.db.patch("siteSettings", settingsId, {
      aiRuntime: {
        selectedProvider: "anthropic",
        assistants: {
          writing: {
            tuple: taskProfileTuple("openai", "editorial-copy"),
            instructions: "Use our exact voice.",
          },
        },
      },
    })
    await ctx.db.insert("agentConfigs", {
      agent: "content",
      modelOverrides: {
        openai: {
          mode: "catalog",
          provider: "openai",
          model: "gpt-5.6-sol",
          reasoning: { kind: "effort", effort: "high" },
        },
      },
      updatedAt: 1,
    })
  })
  await owner.action(api.agents.contentWriter.generateField, field)
  const call = fake.generate.mock.calls[0]![0]
  expect(call.model.modelId).toBe(
    taskProfileTuple("openai", "editorial-copy").model
  )
  expect(call.instructions).toContain("Use our exact voice.\n\n")
  expect(call.instructions.indexOf("Use our exact voice.")).toBe(0)
  expect(call.instructions).toContain(
    "Output ONLY the requested labeled fields."
  )
})

test("S2b legacy off is no preference and uses the same provider as status", async () => {
  const { t, owner, settingsId } = await app()
  await t.run((ctx) =>
    ctx.db.patch("siteSettings", settingsId, {
      aiRuntime: { selectedProvider: "off" },
    })
  )
  const status = await owner.query(api.cms.aiSettings.status, {})
  const cfg = await owner.query(
    internal.agents.contentWriter.prepareGeneration,
    {}
  )
  expect(cfg).toMatchObject({
    assistant: {
      provider: status.assistants.find((a) => a.id === "writing")!.provider,
    },
  })
  await owner.action(api.agents.contentWriter.generateField, field)
  expect(fake.generate).toHaveBeenCalledOnce()
})

test("S2b Translation refuses Multilingual off even when Writing is ready", async () => {
  const { owner } = await app()
  await expect(
    owner.query(internal.agents.localizer.prepareTranslation, {})
  ).rejects.toThrow("CMS_MODULE_NOT_READY")
  await expect(
    owner.query(internal.agents.contentWriter.prepareGeneration, {})
  ).resolves.toBeDefined()
  expect(fake.generate).not.toHaveBeenCalled()
})

test.each([undefined, "", "  "])(
  "S2b instructions %j preserve the code-owned contract",
  async (instructions) => {
    const { t, owner, settingsId } = await app()
    await t.run((ctx) =>
      ctx.db.patch("siteSettings", settingsId, {
        aiRuntime: {
          selectedProvider: "openai",
          assistants: {
            writing: {
              tuple: taskProfileTuple("openai", "editorial-copy"),
              ...(instructions === undefined ? {} : { instructions }),
            },
          },
        },
      })
    )
    await owner.action(api.agents.contentWriter.generateField, field)
    const prompt = fake.generate.mock.calls[0]![0].instructions
    const expected =
      "You write clear, friendly web pages. Use short sentences and plain words. Follow the brand voice in Settings › General. Never invent prices, dates or facts."
    expect(
      prompt.startsWith(
        instructions === undefined
          ? `${expected}\n\n`
          : "You are a professional content writer."
      )
    ).toBe(true)
    expect(prompt).toContain("Output ONLY the requested labeled fields.")
  }
)

test("S2b unreachable never blocks ready assistants, and Help prepends to system", async () => {
  const { t, owner, settingsId } = await app()
  await t.run(async (ctx) => {
    await ctx.db.patch("siteSettings", settingsId, {
      aiRuntime: {
        selectedProvider: "openai",
        assistants: {
          help: {
            tuple: taskProfileTuple("openai", "grounded-help"),
            instructions: "Be brief.",
          },
        },
      },
    })
    await ctx.db.insert("aiProviderHealth", {
      provider: "openai",
      keyFingerprint: await hashOwnerClaim("fake-openai"),
      state: "unreachable",
      observedAt: 1,
      sourceAttemptKey: "fixture",
    })
  })
  fake.generate.mockResolvedValueOnce({
    text: "Use Settings.",
    finishReason: "stop",
    usage: { raw: {}, inputTokens: 1, outputTokens: 1 },
    finalStep: { response: { modelId: "gpt-5.6-terra" } },
  })
  await owner.action(api.agents.helpAssistant.answer, {
    question: "Where are settings?",
  })
  expect(fake.generate.mock.calls[0]![0].system).toMatch(/^Be brief\.\n\n/)
  expect(fake.generate.mock.calls[0]![0].instructions).toBeUndefined()
})

test("S2b disable after prepare refuses runtime admission atomically", async () => {
  const { t, owner } = await app()
  await owner.query(internal.agents.contentWriter.prepareGeneration, {})
  await t.run(async (ctx) => {
    const state = (await ctx.db.query("cmsModuleState").first())!
    await ctx.db.patch("cmsModuleState", state._id, { enabledModules: [] })
  })
  await expect(
    t.mutation(internal.cms.ai.admitRuntimeAttempt, {
      authId: identity.subject,
      request: {
        attemptKey: "after-disable",
        provider: "openai",
        modelId: "gpt-5.6-terra",
        lane: "runtime",
        profile: "editorial-copy",
        phase: "content-generation",
        inputTokens: 1,
        imageTokens: 0,
        maxOutputTokens: 1,
      },
    })
  ).rejects.toThrow("CMS_MODULE_DISABLED")
  expect(
    await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())
  ).toEqual([])
  expect(fake.generate).not.toHaveBeenCalled()
})

test("S2b a missing legacy provider preference falls back to the resolver's usable connection", async () => {
  vi.stubEnv("OPENAI_API_KEY", "")
  const { t, owner, settingsId } = await app()
  await t.run((ctx) =>
    ctx.db.patch("siteSettings", settingsId, {
      aiRuntime: { selectedProvider: "openai" },
    })
  )
  await owner.action(api.agents.contentWriter.generateField, field)
  expect(fake.generate.mock.calls[0]![0].model.modelId).toBe(
    taskProfileTuple("anthropic", "editorial-copy").model
  )
  expect(await owner.query(api.cms.ai.isConfigured, {})).toBe(true)
})

const runtimeCallers = ["Writing", "Help", "Translation fan-out"] as const
for (const caller of runtimeCallers) {
  test.each(["refused", "unreachable"] as const)(
    `R2 ${caller}: %s after prepare uses the request connection at admission`,
    async (state) => {
      const { t, owner, settingsId } = await app()
      await t.run(async (ctx) => {
        const moduleState = (await ctx.db.query("cmsModuleState").first())!
        await ctx.db.patch("cmsModuleState", moduleState._id, {
          enabledModules: ["ai", "multilingual"].map((moduleId) => ({ moduleId, configVersion: 1 })),
        })
        await ctx.db.patch("siteSettings", settingsId, {
          enabledLocales: ["en", "fr"],
          aiRuntime: { assistants: {
            writing: { tuple: taskProfileTuple(caller === "Writing" ? "openai" : "anthropic", "editorial-copy") },
            help: { tuple: taskProfileTuple(caller === "Help" ? "openai" : "anthropic", "grounded-help") },
            translation: { tuple: taskProfileTuple("openai", "brand-translation") },
          } },
        })
      })
      let healthBefore: unknown
      fake.beforeAdmission.mockImplementationOnce(async (request) => {
        expect(request.provider).toBe("openai")
        expect(request.lane).toBe("runtime")
        await t.run(async (ctx) => {
          await ctx.db.insert("aiProviderHealth", {
            provider: "openai", keyFingerprint: await hashOwnerClaim("fake-openai"),
            state, observedAt: 1, sourceAttemptKey: "changed-after-prepare",
          })
        })
        healthBefore = await t.run((ctx) => ctx.db.query("aiProviderHealth").collect())
      })
      const work = caller === "Writing"
        ? owner.action(api.agents.contentWriter.generateField, field)
        : caller === "Help"
          ? owner.action(api.agents.helpAssistant.answer, { question: "Where are pages?" })
          : owner.action(api.agents.localizer.localizePage, {
              title: "Title", metaTitle: "Meta title", metaDescription: "Description", slices: [],
              sourceLocale: "en", targetLocale: "fr",
            })
      if (state === "refused") {
        await expect(work).rejects.toMatchObject({ data: expect.objectContaining({
          category: "AUTH_REQUIRED", attempts: 0, retryable: false,
          selected: expect.objectContaining({ lane: "runtime", provider: "openai", model: taskProfileTuple("openai", caller === "Help" ? "grounded-help" : caller === "Writing" ? "editorial-copy" : "brand-translation").model }),
          phase: caller === "Help" ? "help-answer" : caller === "Writing" ? "content-generation" : "translation",
          nextAction: "authenticate-provider",
        }) })
        expect(fake.generate).not.toHaveBeenCalled()
        expect(await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())).toEqual([])
        expect(await t.run((ctx) => ctx.db.query("aiSpendingMonths").collect())).toEqual([])
        expect(await t.run((ctx) => ctx.db.query("aiProviderHealth").collect())).toEqual(healthBefore)
      } else {
        await work
        expect(fake.generate).toHaveBeenCalled()
        expect((await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())).length).toBeGreaterThan(0)
      }
      expect(fake.beforeAdmission).toHaveBeenCalled()
    }
  )
}

test("R2 red: refused admission stays structured when no other assistant is ready", async () => {
  const { t, owner, settingsId } = await app()
  await t.run((ctx) => ctx.db.patch("siteSettings", settingsId, { aiRuntime: { assistants: {
    writing: { tuple: taskProfileTuple("openai", "editorial-copy") },
    help: { tuple: taskProfileTuple("openai", "grounded-help") },
  } } }))
  fake.beforeAdmission.mockImplementationOnce(async () => {
    await t.run(async (ctx) => ctx.db.insert("aiProviderHealth", {
      provider: "openai", keyFingerprint: await hashOwnerClaim("fake-openai"),
      state: "refused", observedAt: 1, sourceAttemptKey: "after-prepare",
    }))
  })
  await expect(owner.action(api.agents.contentWriter.generateField, field)).rejects.toMatchObject({
    data: expect.objectContaining({ category: "AUTH_REQUIRED", attempts: 0, retryable: false, nextAction: "authenticate-provider" }),
  })
  expect(fake.generate).not.toHaveBeenCalled()
  expect(await t.run((ctx) => ctx.db.query("aiSpendingAttempts").collect())).toEqual([])
})

test.each(["anthropic", "openrouter", "openai"] as const)(
  "S3 seam a prepare callers match status.effective on fresh %s sites",
  async (provider) => {
    const { t, owner, settingsId } = await app()
    vi.stubEnv("ANTHROPIC_API_KEY", provider === "anthropic" ? "fake-anthropic" : "")
    vi.stubEnv("OPENROUTER_API_KEY", provider === "openrouter" ? "fake-openrouter" : "")
    vi.stubEnv("OPENAI_API_KEY", provider === "openai" ? "fake-openai" : "")
    await t.run(async (ctx) => {
      await ctx.db.patch("siteSettings", settingsId, { aiRuntime: { selectedProvider: provider } })
      const state = (await ctx.db.query("cmsModuleState").first())!
      await ctx.db.patch("cmsModuleState", state._id, { enabledModules: [
        { moduleId: "ai", configVersion: 1 },
        { moduleId: "multilingual", configVersion: 1 },
      ] })
    })
    const status = await owner.query(api.cms.aiSettings.status, {})
    const writing = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    const translation = await owner.query(internal.agents.localizer.prepareTranslation, {})
    const help = await owner.query(internal.agents.helpAssistant.prepareHelp, {})
    for (const [id, cfg] of [["writing", writing], ["translation", translation], ["help", help]] as const) {
      for (const profile of ASSISTANT_PROFILES[id]) {
        expect(resolveAssistantRuntimeTuple(cfg.assistant, {
          profile, phase: "content-generation",
          legacyModelId: cfg.modelId ?? undefined,
          providerDefaults: cfg.providerDefaults ?? undefined,
          taskDefaults: cfg.taskDefaults ?? undefined,
          modelOverrides: cfg.modelOverrides ?? undefined,
        })).toEqual(status.assistants.find((a) => a.id === id)!.effective)
      }
    }
    expect(fake.generate).not.toHaveBeenCalled()
  }
)

test.each(["explicit", "legacy-chain", "legacy-off", "legacy-overrides"] as const)(
  "S3 effective keeps primary-profile precedence: %s",
  async (mode) => {
    const { t, owner, settingsId } = await app()
    vi.stubEnv("OPENROUTER_API_KEY", "fake-openrouter")
    await t.run(async (ctx) => {
      await ctx.db.patch("siteSettings", settingsId, {
        aiDefaultModel: "openrouter:legacy/site-first",
        aiRuntime: mode === "legacy-chain" ? {} : mode === "legacy-off"
          ? { selectedProvider: "off" }
          : mode === "explicit" ? { assistants: { writing: { tuple: taskProfileTuple("openai", "editorial-copy") } } }
          : { selectedProvider: "openai",
              providerDefaults: { openai: taskProfileTuple("openai", "mechanical-translation") as Extract<ReturnType<typeof taskProfileTuple>, { provider: "openai" }> },
              taskDefaults: { "editorial-copy": taskProfileTuple("openai", "structured-outline-meta") } },
      })
      if (mode === "legacy-chain" || mode === "legacy-overrides") {
        await ctx.db.insert("agentConfigs", { agent: "content", model: "openrouter:legacy/agent-first",
          ...(mode === "legacy-overrides" ? { modelOverrides: { openai: { mode: "catalog", provider: "openai", model: "gpt-6.1-sol", reasoning: { kind: "effort", effort: "high" } } } } : {}), updatedAt: 1 })
      }
    })
    const status = await owner.query(api.cms.aiSettings.status, {})
    const cfg = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    const expected = mode === "legacy-chain" ? { mode: "legacy", provider: "openrouter", model: "legacy/agent-first" }
      : mode === "legacy-off" ? taskProfileTuple("anthropic", "editorial-copy")
      : mode === "explicit" ? taskProfileTuple("openai", "editorial-copy")
      : { mode: "catalog", provider: "openai", model: "gpt-6.1-sol", reasoning: { kind: "effort", effort: "high" } }
    expect(status.assistants.find((a) => a.id === "writing")!.effective).toEqual(expected)
    expect(resolveAssistantRuntimeTuple(cfg.assistant, { profile: "editorial-copy", phase: "content-generation",
      legacyModelId: cfg.modelId ?? undefined, providerDefaults: cfg.providerDefaults ?? undefined,
      taskDefaults: cfg.taskDefaults ?? undefined, modelOverrides: cfg.modelOverrides ?? undefined,
    })).toEqual(expected)
  }
)

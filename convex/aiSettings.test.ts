/// <reference types="vite/client" />
import { prepareAuthSessions } from "../test-utils/convexAuthFixtures"
import { convexTestWithAuth as convexTest } from "../test-utils/convexAuthFixtures"
import { ConvexError } from "convex/values"
import { afterEach, describe, expect, test, vi } from "vitest"
import { BUNDLED_MODEL_CATALOG, catalogFromEntries, isNotOffered } from "../lib/ai/model-catalog"
import { DIRECT_PRICES } from "../lib/ai/price-quote"
import { api, internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"
import type { RuntimeSelectedProvider } from "./lib/aiConfig"
import { API_PROVIDERS } from "../lib/ai/execution-contract"
import {
  API_TASK_PROFILES,
  ASSISTANT_PROFILES,
  RUNTIME_TASK_PROFILES,
  BLOCK_CREATOR_PROFILES,
  taskProfileTuple,
  validateApiModelTuple,
  validateTupleForProfiles,
} from "../lib/ai/task-profiles"
import { ANTHROPIC_API_CATALOG } from "../lib/ai/capabilities/anthropic-api"
import { OPENAI_API_CATALOG } from "../lib/ai/capabilities/openai-api"
import { OPENROUTER_API_CATALOG } from "../lib/ai/capabilities/openrouter-api"
import { OPENROUTER_PORTABLE_EFFORTS } from "../lib/ai/openrouter-catalog"
import * as aiRuntime from "./lib/ai"
import type { ApiModelCapability, ApiModelTuple } from "../lib/ai/execution-contract"
import schema from "./schema"
import { loadProviderCatalog } from "./lib/aiCatalog"
import { resolveLocalApiTuple } from "../scripts/lib/ai-api-engine"
import rateLimiterTest from "@convex-dev/rate-limiter/test"

const modules = import.meta.glob("./**/*.ts")

/** The shared catalog the Settings query reads, for direct resolver checks. */
async function liveCatalog(t: ReturnType<typeof convexTest>) {
  return catalogFromEntries(await t.run(async (ctx) =>
    (await Promise.all(API_PROVIDERS.map((provider) => loadProviderCatalog(ctx, provider)))).flat()
  ))
}

/** A synchronized OpenRouter row as the refresh stores it: priced, with a
 *  successful sync recorded, so the shared catalog reads the live list. */
async function insertSyncedOpenRouterRow(
  ctx: MutationCtx,
  row: Omit<Doc<"openRouterCatalogModels">, "_id" | "_creationTime">
) {
  await ctx.db.insert("openRouterCatalogModels", { ceilingInputPerM: 1, ceilingOutputPerM: 2, ...row })
  const sync = await ctx.db.query("openRouterCatalogSync")
    .withIndex("by_key", (q) => q.eq("key", "openrouter")).unique()
  if (!sync) {
    await ctx.db.insert("openRouterCatalogSync", {
      key: "openrouter", status: "success", lastAttemptAt: 1, lastSuccessAt: 1,
    })
  }
}

const SECRET_VALUES = {
  openrouter: "openrouter-secret-sentinel",
  anthropic: "anthropic-secret-sentinel",
  openai: "openai-secret-sentinel",
} as const

type Availability = Record<(typeof API_PROVIDERS)[number], boolean>

const PROVIDER_DEFAULTS = {
  openrouter: {
    mode: "catalog",
    provider: "openrouter",
    model: "google/gemini-3.5-flash",
    reasoning: { kind: "effort", effort: "high" },
  },
  anthropic: {
    mode: "catalog",
    provider: "anthropic",
    model: "claude-sonnet-5",
    reasoning: { kind: "effort", effort: "high" },
  },
  openai: {
    mode: "catalog",
    provider: "openai",
    model: "gpt-5.6-sol",
    reasoning: { kind: "effort", effort: "high" },
  },
} as const

afterEach(() => {
  vi.unstubAllEnvs()
  vi.useRealTimers()
})

function setAvailability(availability: Availability) {
  vi.stubEnv(
    "OPENROUTER_API_KEY",
    availability.openrouter ? SECRET_VALUES.openrouter : ""
  )
  vi.stubEnv(
    "ANTHROPIC_API_KEY",
    availability.anthropic ? SECRET_VALUES.anthropic : ""
  )
  vi.stubEnv("OPENAI_API_KEY", availability.openai ? SECRET_VALUES.openai : "")
}

async function seed(
  t: ReturnType<typeof convexTest>,
  selectedProvider?: RuntimeSelectedProvider
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: [{ moduleId: "ai", configVersion: 1 }],
    })
    await ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: "admin-1",
      tokenIdentifier: "admin-1",
      establishedAt: 1,
      updatedAt: 1,
    })
    await ctx.db.insert("siteSettings", {
      siteName: "Test site",
      siteUrl: "https://example.test",
      defaultLocale: "en",
      enabledLocales: ["en"],
      aiProvider: "legacy-provider",
      aiDefaultModel: "legacy-model",
      ...(selectedProvider === undefined
        ? {}
        : { aiRuntime: { selectedProvider } }),
      updatedAt: 1,
    })
  })
}

function identity(t: ReturnType<typeof convexTest>, subject: string) {
  return t.withIdentity({ subject, email: `${subject}@example.test` })
}

function assertNoRuntimeSecretsOrLocalState(value: unknown) {
  const serialized = JSON.stringify(value)
  for (const secret of Object.values(SECRET_VALUES)) {
    expect(serialized).not.toContain(secret)
  }
  for (const forbidden of [
    "API_KEY",
    "NEXTCMS_DEV",
    "credentialPath",
    "subscriptionState",
    "localEngine",
    "claude-cli",
    "codex-cli",
  ]) {
    expect(serialized).not.toContain(forbidden)
  }
}

const productionAiStatusCases = (
  [undefined, "off", "openrouter", "anthropic", "openai"] as const
).flatMap((selected) =>
  Array.from({ length: 8 }, (_, mask) => ({
    label: selected ?? "legacy",
    selected,
    mask,
    availability: {
      openrouter: Boolean(mask & 1),
      anthropic: Boolean(mask & 2),
      openai: Boolean(mask & 4),
    } satisfies Availability,
  }))
)

describe("cms.ai Production AI status", () => {
  test("keeps the committed catalog and readiness owner-gated", async () => {
    setAvailability({ openrouter: true, anthropic: false, openai: false })
    const t = convexTest(schema, modules)
    await seed(t)

    await expect(t.query(api.cms.ai.getModelsSettings, {})).rejects.toThrow(
      /UNAUTHENTICATED/
    )
    // Community operation access is owner-bound. The inherited editor role is
    // retained as Team evidence and does not grant Community access.
    await expect(
      identity(t, "editor-1").query(api.cms.ai.getModelsSettings, {})
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)
    await expect(
      identity(t, "viewer-1").query(api.cms.ai.getModelsSettings, {})
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)

    await expect(t.query(api.cms.ai.isConfigured, {})).rejects.toThrow(
      /UNAUTHENTICATED/
    )
    await expect(
      identity(t, "admin-1").query(api.cms.ai.isConfigured, {})
    ).resolves.toBe(true)
    await expect(
      identity(t, "editor-1").query(api.cms.ai.isConfigured, {})
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)
  })

  test.each(productionAiStatusCases)(
    "projects $label selection with key-availability mask $mask without secrets",
    async ({ selected, availability }) => {
      setAvailability(availability)
      const t = convexTest(schema, modules)
      await seed(t, selected)
      const result = await identity(t, "admin-1").query(
        api.cms.ai.getModelsSettings,
        {}
      )

      const expected =
        selected === undefined
          ? availability.openrouter
            ? { selectedProvider: "openrouter", status: "legacy-openrouter" }
            : { selectedProvider: "off", status: "off" }
          : selected === "off"
            ? { selectedProvider: "off", status: "off" }
            : {
                selectedProvider: selected,
                status: availability[selected]
                  ? "ready"
                  : "selected-unavailable",
              }

      expect(result.runtime).toEqual({ ...expected, availability })
      await expect(
        identity(t, "admin-1").query(api.cms.ai.isConfigured, {})
      ).resolves.toBe(Object.values(availability).some(Boolean))
      expect(result.providers.map((provider) => provider.id)).toEqual(
        API_PROVIDERS
      )
      for (const provider of result.providers) {
        expect(provider.available).toBe(availability[provider.id])
        expect(provider.profiles.map((profile) => profile.profile)).toEqual(
          RUNTIME_TASK_PROFILES
        )
        expect(provider.selections.length).toBeGreaterThan(0)
      }
      expect(result.providerDefaults).toEqual({})
      expect(result.taskDefaults).toEqual({})
      assertNoRuntimeSecretsOrLocalState(result)
    }
  )

  test("treats whitespace-only deployment credentials as unavailable", async () => {
    vi.stubEnv("OPENROUTER_API_KEY", "   ")
    vi.stubEnv("ANTHROPIC_API_KEY", "\n")
    vi.stubEnv("OPENAI_API_KEY", "\t")
    const t = convexTest(schema, modules)
    await seed(t)

    const result = await identity(t, "admin-1").query(
      api.cms.ai.getModelsSettings,
      {}
    )
    expect(result.runtime).toMatchObject({
      selectedProvider: "off",
      status: "off",
      availability: { openrouter: false, anthropic: false, openai: false },
    })
    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        { selectedProvider: "anthropic", providerDefaults: PROVIDER_DEFAULTS }
      )
    ).rejects.toThrow(/PROVIDER_UNAVAILABLE/)
  })

  test("projects the synchronized OpenRouter catalog with names and pricing", async () => {
    setAvailability({ openrouter: true, anthropic: false, openai: false })
    const t = convexTest(schema, modules)
    await seed(t, "openrouter")
    await t.mutation(internal.cms.openRouterCatalog.publishCatalog, {
      syncedAt: 1_752_560_000_000,
      models: [
        {
          modelId: "example/new-model",
          name: "Example New Model",
          inputModalities: ["text", "image"],
          structuredOutput: true,
          reasoningEfforts: ["high", "medium", "low"],
          inputPerM: 0.25,
          outputPerM: 1.5,
          ceilingInputPerM: 0.25,
          ceilingOutputPerM: 1.5,
        },
      ],
    })

    const result = await identity(t, "admin-1").query(
      api.cms.ai.getModelsSettings,
      {}
    )
    expect(result.openRouterCatalog).toEqual({
      source: "synced",
      refreshStatus: "success",
      modelCount: 1,
      updatedAt: 1_752_560_000_000,
    })
    const openRouter = result.providers.find(
      (provider) => provider.id === "openrouter"
    )
    expect(openRouter?.selections).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: "example/new-model",
          name: "Example New Model",
          reasoning: "high",
          pricePerM: { inputPerM: 0.25, outputPerM: 1.5 },
          siteDefaultEligible: true,
        }),
      ])
    )
    expect(
      openRouter?.selections.every(
        (selection) => selection.model === "example/new-model"
      )
    ).toBe(true)
  })
})

describe("cms.aiConnections validation", () => {
  test("checks permission and reports a missing deployment credential safely", async () => {
    setAvailability({ openrouter: false, anthropic: false, openai: false })
    const t = convexTest(schema, modules)
    // `validateProductionConnection` charges the rate limiter after its
    // permission gate (each call hits a paid vendor endpoint).
    rateLimiterTest.register(t)
    await seed(t)

    await expect(
      t.action(api.cms.aiConnections.validateProductionConnection, {
        provider: "openrouter",
      })
    ).rejects.toThrow(/UNAUTHENTICATED/)
    await expect(
      identity(t, "viewer-1").action(
        api.cms.aiConnections.validateProductionConnection,
        { provider: "openrouter" }
      )
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)

    const result = await identity(t, "admin-1").action(
      api.cms.aiConnections.validateProductionConnection,
      { provider: "openrouter" }
    )
    expect(result).toEqual({ state: "not-configured", issue: "missing-key" })
    assertNoRuntimeSecretsOrLocalState(result)
  })
})

describe("aiSettings.setProductionAiConfiguration", () => {
  test("requires settings:update", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)

    await expect(
      t.mutation(api.cms.aiSettings.setProductionAiConfiguration, {
        selectedProvider: "openrouter",
        providerDefaults: PROVIDER_DEFAULTS,
      })
    ).rejects.toThrow(/UNAUTHENTICATED/)
    await expect(
      identity(t, "editor-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        { selectedProvider: "openrouter", providerDefaults: PROVIDER_DEFAULTS }
      )
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)
  })

  test("rejects a newly unavailable provider but preserves an unchanged active selection", async () => {
    setAvailability({ openrouter: false, anthropic: false, openai: false })

    const fresh = convexTest(schema, modules)
    await seed(fresh)
    await expect(
      identity(fresh, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        { selectedProvider: "anthropic", providerDefaults: PROVIDER_DEFAULTS }
      )
    ).rejects.toThrow(/PROVIDER_UNAVAILABLE/)

    const active = convexTest(schema, modules)
    await seed(active, "anthropic")
    await expect(
      identity(active, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        { selectedProvider: "anthropic", providerDefaults: PROVIDER_DEFAULTS }
      )
    ).resolves.toBeNull()
    const row = await active.run((ctx) => ctx.db.query("siteSettings").first())
    expect(row?.aiRuntime).toEqual({
      selectedProvider: "anthropic",
      providerDefaults: PROVIDER_DEFAULTS,
    })
    expect(row?.updatedAt).toBeGreaterThan(1)
  })

  test("persists only the selected provider and never rewrites legacy fields", async () => {
    for (const selectedProvider of [
      "openrouter",
      "anthropic",
      "openai",
      "off",
    ] as const) {
      setAvailability({
        openrouter: selectedProvider === "openrouter",
        anthropic: selectedProvider === "anthropic",
        openai: selectedProvider === "openai",
      })
      const t = convexTest(schema, modules)
      await seed(t)
      await identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        { selectedProvider, providerDefaults: PROVIDER_DEFAULTS }
      )
      const row = await t.run((ctx) => ctx.db.query("siteSettings").first())
      expect(row?.aiRuntime).toEqual({
        selectedProvider,
        providerDefaults: PROVIDER_DEFAULTS,
      })
      expect(row?.aiProvider).toBe("legacy-provider")
      expect(row?.aiDefaultModel).toBe("legacy-model")
      expect(row?.updatedAt).toBeGreaterThan(1)
      assertNoRuntimeSecretsOrLocalState(row)
    }
  })

  test("rejects values outside the closed provider union", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        {
          selectedProvider: "claude" as "openrouter",
          providerDefaults: PROVIDER_DEFAULTS,
        }
      )
    ).rejects.toThrow(/ArgumentValidationError|Validator error/)
  })

  test("stored runtime settings contain no secret or local execution fields", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    await identity(t, "admin-1").mutation(
      api.cms.aiSettings.setProductionAiConfiguration,
      { selectedProvider: "openai", providerDefaults: PROVIDER_DEFAULTS }
    )
    const row = (await t.run((ctx) =>
      ctx.db.query("siteSettings").first()
    )) as Doc<"siteSettings"> | null
    expect(Object.keys(row?.aiRuntime ?? {}).sort()).toEqual([
      "providerDefaults",
      "selectedProvider",
    ])
    assertNoRuntimeSecretsOrLocalState(row?.aiRuntime)
  })

  test("rejects a non-universal default atomically", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    const before = await t.run((ctx) => ctx.db.query("siteSettings").first())

    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        {
          selectedProvider: "openai",
          providerDefaults: {
            openai: {
              mode: "catalog",
              provider: "openai",
              model: "gpt-5.6-luna",
              reasoning: { kind: "effort", effort: "low" },
            },
          },
        }
      )
    ).rejects.toThrow(/INVALID_AI_SELECTION/)

    const after = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(after).toEqual(before)
  })

  test("persists per-task defaults and surfaces them through getModelsSettings", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    // A per-profile tuple that meets that profile alone (low effort would fail
    // the site-default universal gate, but per-task it needs no floor).
    const taskDefaults = {
      "editorial-copy": {
        mode: "catalog",
        provider: "openai",
        model: "gpt-5.6-terra",
        reasoning: { kind: "effort", effort: "low" },
      },
    } as const
    await identity(t, "admin-1").mutation(
      api.cms.aiSettings.setProductionAiConfiguration,
      {
        selectedProvider: "openai",
        providerDefaults: PROVIDER_DEFAULTS,
        taskDefaults,
      }
    )
    const row = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(row?.aiRuntime).toEqual({
      selectedProvider: "openai",
      providerDefaults: PROVIDER_DEFAULTS,
      taskDefaults,
    })
    const projected = await identity(t, "admin-1").query(
      api.cms.ai.getModelsSettings,
      {}
    )
    expect(projected.taskDefaults).toEqual(taskDefaults)
  })

  test("validates newly synchronized OpenRouter models against active capabilities", async () => {
    setAvailability({ openrouter: true, anthropic: false, openai: false })
    const t = convexTest(schema, modules)
    await seed(t)
    await t.mutation(internal.cms.openRouterCatalog.publishCatalog, {
      syncedAt: 1_752_560_000_000,
      models: [
        {
          modelId: "example/universal-model",
          name: "Universal Model",
          inputModalities: ["text", "image"],
          structuredOutput: true,
          reasoningEfforts: ["high", "medium", "low"],
          inputPerM: 0.25,
          outputPerM: 1.5,
          ceilingInputPerM: 0.25,
          ceilingOutputPerM: 1.5,
        },
        {
          modelId: "example/image-only-model",
          name: "Image-only Model",
          inputModalities: ["image"],
          structuredOutput: false,
          reasoningEfforts: ["high"],
        },
      ],
    })

    const universal = {
      mode: "catalog",
      provider: "openrouter",
      model: "example/universal-model",
      reasoning: { kind: "effort", effort: "high" },
    } as const
    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        {
          selectedProvider: "openrouter",
          providerDefaults: { openrouter: universal },
        }
      )
    ).resolves.toBeNull()

    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        {
          selectedProvider: "openrouter",
          providerDefaults: { openrouter: universal },
          taskDefaults: {
            "editorial-copy": {
              mode: "catalog",
              provider: "openrouter",
              model: "example/image-only-model",
              reasoning: { kind: "effort", effort: "high" },
            },
          },
        }
      )
    ).rejects.toThrow(/INVALID_AI_SELECTION/)
  })

  test("rejects a task default whose provider does not match the selection", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        {
          selectedProvider: "openai",
          providerDefaults: PROVIDER_DEFAULTS,
          taskDefaults: {
            "editorial-copy": {
              mode: "catalog",
              provider: "anthropic",
              model: "claude-sonnet-5",
              reasoning: { kind: "effort", effort: "medium" },
            },
          },
        }
      )
    ).rejects.toThrow(/INVALID_AI_SELECTION/)
  })

  test("rejects task defaults when the lane is off", async () => {
    setAvailability({ openrouter: false, anthropic: false, openai: false })
    const t = convexTest(schema, modules)
    await seed(t, "off")
    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        {
          selectedProvider: "off",
          providerDefaults: {},
          taskDefaults: {
            "editorial-copy": {
              mode: "catalog",
              provider: "openai",
              model: "gpt-5.6-terra",
              reasoning: { kind: "effort", effort: "medium" },
            },
          },
        }
      )
    ).rejects.toThrow(/INVALID_AI_SELECTION/)
  })

  test("rejects a task default that does not support its own workflow", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    // mechanical-translation is contractually explicit `high` — a `low`
    // tuple must be rejected at save time (mirror of the resolver's runtime
    // fall-through). Uses this profile rather than the retired vision-spec /
    // renderer-jsx build-lane profiles that used to carry the floor test.
    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        {
          selectedProvider: "openai",
          providerDefaults: PROVIDER_DEFAULTS,
          taskDefaults: {
            "mechanical-translation": {
              mode: "catalog",
              provider: "openai",
              model: "gpt-5.6-luna",
              reasoning: { kind: "effort", effort: "low" },
            },
          },
        }
      )
    ).rejects.toThrow(/INVALID_AI_SELECTION/)
  })

  test("rejects an unknown task profile key in the mutation handler", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    // The taskDefaults validator uses v.record(v.string(), …) because
    // v.object with hyphenated keys crashes Convex's function-export codepath
    // ("Identifier brand-translation has invalid character '-'"). Key
    // narrowing therefore happens in the handler, not the validator.
    await expect(
      identity(t, "admin-1").mutation(
        api.cms.aiSettings.setProductionAiConfiguration,
        {
          selectedProvider: "openai",
          providerDefaults: PROVIDER_DEFAULTS,
          taskDefaults: {
            "judgment-transform": {
              mode: "catalog",
              provider: "openai",
              model: "gpt-5.6-sol",
              reasoning: { kind: "effort", effort: "high" },
            },
          },
        }
      )
    ).rejects.toThrow(/INVALID_AI_SELECTION: Unknown task profile/)
  })

  test("updates updatedAt when only task defaults change (no short-circuit)", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t, "openai")
    // Mint the fixture session on the real clock; its token is signed with it.
    await prepareAuthSessions(t, "admin-1")

    // Baseline save with no task defaults.
    await identity(t, "admin-1").mutation(
      api.cms.aiSettings.setProductionAiConfiguration,
      { selectedProvider: "openai", providerDefaults: PROVIDER_DEFAULTS }
    )
    const first = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(first?.aiRuntime?.taskDefaults).toBeUndefined()
    // Convex does not promise that two mutations see different `Date.now()`
    // values, so do not compare two clock readings. Reset the stored stamp to a
    // sentinel that no clock reading can equal; only a second write replaces it.
    await t.run((ctx) =>
      ctx.db.patch("siteSettings", first!._id, { updatedAt: 1 })
    )

    // Task-only edit must NOT be short-circuited as "unchanged".
    await identity(t, "admin-1").mutation(
      api.cms.aiSettings.setProductionAiConfiguration,
      {
        selectedProvider: "openai",
        providerDefaults: PROVIDER_DEFAULTS,
        taskDefaults: {
          "editorial-copy": {
            mode: "catalog",
            provider: "openai",
            model: "gpt-5.6-terra",
            reasoning: { kind: "effort", effort: "medium" },
          },
        },
      }
    )
    const second = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(second?.updatedAt).toBeGreaterThan(1)
    expect(second?.aiRuntime?.taskDefaults).toBeDefined()
  })
})


test("every direct catalog model persists through assistant settings and status", async () => {
  setAvailability({ openrouter: true, anthropic: true, openai: true })
  const t = convexTest(schema, modules)
  await seed(t)
  const owner = identity(t, "admin-1")
  const initial = (await owner.query(api.cms.aiSettings.status, {}))!
  for (const assistant of initial.assistants) {
    for (const provider of API_PROVIDERS) {
      const tuple = assistant.defaults[provider]
      expect(tuple).not.toBeNull()
      expect(tuple).toEqual(taskProfileTuple(provider, ASSISTANT_PROFILES[assistant.id][0]))
      if (!tuple) throw new Error("Expected a bundled default")
      const choice = assistant.choices[provider].find((choice) => choice.model === tuple.model)!
      expect(choice).toBeDefined()
      if ("reasoning" in tuple && tuple.reasoning) expect(choice.efforts).toContain(tuple.reasoning.effort)
      else expect(choice.efforts).toEqual([])
      await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: assistant.id, tuple })).resolves.toBeNull()
      const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
      expect(stored!.aiRuntime!.assistants![assistant.id]!.tuple).toEqual(tuple)
      for (const profile of ASSISTANT_PROFILES[assistant.id]) {
        expect(aiRuntime.resolveAssistantRuntimeTuple({
          provider, tuple: stored!.aiRuntime!.assistants![assistant.id]!.tuple!, legacy: false, instructions: "",
        }, { catalog: BUNDLED_MODEL_CATALOG, profile, phase: "content-generation" })).toEqual(tuple)
      }
    }
  }
  for (const [provider, catalog] of [
    ["anthropic", ANTHROPIC_API_CATALOG], ["openai", OPENAI_API_CATALOG],
  ] as const) {
    for (const [model, cap] of Object.entries(catalog) as [string, ApiModelCapability][]) {
      const tuple = validateApiModelTuple({
        mode: "catalog", provider, model,
        ...(cap.reasoning.kind === "effort" ? { reasoning: { kind: "effort", effort: cap.reasoning.providerDefault } } : {}),
      }, BUNDLED_MODEL_CATALOG)
      if (tuple.mode !== "catalog") throw new Error("Expected a catalog tuple")
      // Owner 2026-11-15: a not-offered model is refused at save (it still
      // shows when already saved). A model whose price ends saves only until
      // that date, so it is left to the clock-free price tests.
      if (isNotOffered(provider, model)) {
        await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple }))
          .rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
        continue
      }
      if (DIRECT_PRICES[`${provider}:${model}`]?.endsAt != null) continue
      await owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })
      const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
      expect(stored?.aiRuntime?.assistants?.writing?.tuple).toEqual(tuple)
      const status = (await owner.query(api.cms.aiSettings.status, {}))!
      expect(status.assistants.find((a) => a.id === "writing")?.tuple).toEqual(tuple)
    }
  }
})

test("a direct model whose price ends is no longer offered; OpenRouter keeps its id", async () => {
  setAvailability({ openrouter: true, anthropic: true, openai: true })
  const t = convexTest(schema, modules)
  await seed(t)
  const owner = identity(t, "admin-1")
  const status = (await owner.query(api.cms.aiSettings.status, {}))!
  const creator = await owner.query(api.cms.aiSettings.blockCreator, {})
  for (const choices of [...status.assistants.map((a) => a.choices), creator.choices]) {
    expect(choices.openai.length).toBeGreaterThan(0)
    expect(choices.openai.map((choice) => choice.model)).not.toContain("gpt-5.6-sol")
  }
  expect(creator.choices.openrouter.map((choice) => choice.model)).toContain("openai/gpt-5.6-sol")
})

test.each(["bootstrap", "synchronized", "reasoning-lost", "reasoning-gained", "non-portable"] as const)(
  "S3 seam c: every offered %s choice and effort passes setAssistant and runtime profiles",
  async (catalog) => {
    setAvailability({ anthropic: false, openrouter: false, openai: false })
    const t = convexTest(schema, modules)
    await seed(t, "off")
    if (catalog !== "bootstrap") {
      expect(OPENROUTER_API_CATALOG["google/gemini-3-flash-preview"].reasoning.kind).toBe("effort")
      expect(OPENROUTER_API_CATALOG["cohere/command-a"].reasoning.kind).toBe("unsupported")
      expect(OPENROUTER_API_CATALOG["new/non-portable"]).toBeUndefined()
      expect(OPENROUTER_PORTABLE_EFFORTS).not.toContain("xhigh")
      await t.run(async (ctx) => {
        for (const row of [
          { modelId: "new/reasoning", name: "New reasoning model", inputModalities: ["text"] as const, structuredOutput: true, reasoningEfforts: ["low", "high"] as const },
          ...(catalog === "synchronized" ? [
            { modelId: "new/effortless", name: "New effortless model", inputModalities: ["text"] as const, structuredOutput: true, reasoningEfforts: [] },
            { modelId: "google/gemini-3-flash-preview", name: "Updated bundled model", inputModalities: ["text"] as const, structuredOutput: false, reasoningEfforts: ["high"] as const },
            { modelId: "amazon/nova-2-lite-v1", name: "Drifted structured capability", inputModalities: ["text"] as const, structuredOutput: true, reasoningEfforts: ["high", "medium", "low"] as const },
            { modelId: "new/image-only", name: "Not for assistants", inputModalities: ["image"] as const, structuredOutput: true, reasoningEfforts: ["high"] as const },
          ] : catalog === "reasoning-lost" ? [
            { modelId: "google/gemini-3-flash-preview", name: "Lost synchronized reasoning", inputModalities: ["text"] as const, structuredOutput: true, reasoningEfforts: [] },
          ] : catalog === "reasoning-gained" ? [
            { modelId: "cohere/command-a", name: "Gained synchronized reasoning", inputModalities: ["text"] as const, structuredOutput: true, reasoningEfforts: ["high", "medium", "low"] as const },
          ] : [
            { modelId: "new/non-portable", name: "New model with non-portable effort", inputModalities: ["text"] as const, structuredOutput: true, reasoningEfforts: ["xhigh", "low", "high"] as const },
          ]),
        ]) {
          await insertSyncedOpenRouterRow(ctx, { ...row, inputModalities: [...row.inputModalities], reasoningEfforts: [...row.reasoningEfforts], syncedAt: 1 })
        }
      })
    }
    const owner = identity(t, "admin-1")
    const status = (await owner.query(api.cms.aiSettings.status, {}))!
    const live = await liveCatalog(t)
    let offeredTuples = 0
    for (const assistant of status.assistants) {
      // Missing credentials and unavailable Multilingual do not suppress the projection.
      expect(assistant.ready).toBe(false)
      expect(assistant.effective).toBeDefined()
      // One shared catalog (AI-MODELS-1b): a synchronized row is the whole
      // truth for its model; the bundled capability no longer narrows it.
      if (catalog === "reasoning-lost") {
        expect(assistant.choices.openrouter.map((choice) => choice.model)).toEqual(
          assistant.id === "translation" ? ["new/reasoning"] : ["new/reasoning", "google/gemini-3-flash-preview"]
        )
      } else if (catalog === "reasoning-gained") {
        expect(assistant.choices.openrouter.map((choice) => choice.model)).toEqual(["new/reasoning", "cohere/command-a"])
      } else if (catalog === "non-portable") {
        const choice = assistant.choices.openrouter.find((choice) => choice.model === "new/non-portable")!
        expect(choice.efforts).not.toContain("xhigh")
        expect(choice.efforts).toEqual(assistant.id === "translation" ? ["high"] : ["low", "high"])
      }
      for (const provider of API_PROVIDERS) {
        const choices = assistant.choices[provider]
        expect(choices.length).toBeGreaterThan(0)
        for (const choice of choices) {
          expect(choice.name).not.toBe("")
          if (assistant.id === "translation") expect(choice.efforts).toEqual(["high"])
          for (const effort of choice.efforts.length ? choice.efforts : [null]) {
            const tuple = { mode: "catalog", provider, model: choice.model,
              ...(effort === null ? {} : { reasoning: { kind: "effort", effort } }),
            } as Exclude<ApiModelTuple, { mode: "legacy" }>
            await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: assistant.id, tuple })).resolves.toBeNull()
            const saved = await t.run((ctx) => ctx.db.query("siteSettings").first())
            const savedTuple = saved!.aiRuntime!.assistants![assistant.id]!.tuple!
            expect(savedTuple).toEqual(tuple)
            for (const profile of ASSISTANT_PROFILES[assistant.id]) {
              expect(aiRuntime.resolveAssistantRuntimeTuple({
                provider, tuple: savedTuple, legacy: false, instructions: "",
              }, { catalog: live, profile, phase: "content-generation" })).toEqual(savedTuple)
            }
            offeredTuples++
          }
        }
      }
      if (catalog === "synchronized") {
        expect(assistant.choices.openrouter.map((choice) => choice.model)).toEqual(
          assistant.id === "writing" ? ["new/reasoning", "new/effortless", "amazon/nova-2-lite-v1"]
            : assistant.id === "translation" ? ["new/reasoning", "google/gemini-3-flash-preview", "amazon/nova-2-lite-v1"]
            : ["new/reasoning", "new/effortless", "google/gemini-3-flash-preview", "amazon/nova-2-lite-v1"]
        )
        const noEffort = assistant.choices.openrouter.find((choice) => choice.model === "new/effortless")
        if (noEffort) expect(noEffort).toEqual({ model: "new/effortless", name: "New effortless model", efforts: [], providerDefault: null, family: "New effortless model", priceSource: "openrouter" })
        const reasoning = assistant.choices.openrouter.find((choice) => choice.model === "new/reasoning")!
        expect(reasoning.providerDefault).toBe("medium")
      } else if (catalog === "bootstrap") {
        expect(assistant.choices.openrouter.length).toBeGreaterThan(100)
      }
    }
    expect(offeredTuples).toBeGreaterThan(0)
    const serialized = JSON.stringify(status)
    for (const secret of Object.values(SECRET_VALUES)) expect(serialized).not.toContain(secret)
    expect(serialized).not.toContain("Fingerprint")
  },
  30_000
)

test("S3 r2 status retains a saved invalid reasoning shape while the real prepare path still refuses", async () => {
  setAvailability({ anthropic: false, openrouter: true, openai: false })
  const t = convexTest(schema, modules)
  await seed(t, "openrouter")
  const owner = identity(t, "admin-1")
  const tuple = {
    mode: "catalog", provider: "openrouter", model: "google/gemini-3-flash-preview",
  } as const
  await t.run((ctx) => insertSyncedOpenRouterRow(ctx, {
    modelId: tuple.model, name: "Lost synchronized reasoning", inputModalities: ["text"],
    structuredOutput: true, reasoningEfforts: [], syncedAt: 1,
  }))
  await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })).resolves.toBeNull()
  const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
  expect(stored!.aiRuntime!.assistants!.writing!.tuple).toEqual(tuple)
  // The next list gives the model effort control: the saved effortless shape
  // is now invalid against the shared catalog, and is never rewritten.
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("openRouterCatalogModels")
      .withIndex("by_modelId", (q) => q.eq("modelId", tuple.model)).unique())!
    await ctx.db.patch("openRouterCatalogModels", row._id, { reasoningEfforts: ["high", "medium", "low"] })
  })
  const live = await liveCatalog(t)
  expect(() => validateApiModelTuple(tuple, live)).toThrow()
  const resolver = vi.spyOn(aiRuntime, "resolveAssistantRuntimeTuple")
  try {
    const status = (await owner.query(api.cms.aiSettings.status, {}))!
    expect(status.assistants.find((assistant) => assistant.id === "writing")!.effective).toEqual(tuple)
    expect(resolver.mock.calls.some(([assistant]) => assistant.tuple?.model === tuple.model)).toBe(false)
  } finally {
    resolver.mockRestore()
  }
  const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
  expect(prepared.assistant.tuple).toEqual(tuple)
  expect(() => aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, { catalog: catalogFromEntries(prepared.catalog),
    profile: "editorial-copy", phase: "content-generation",
    legacyModelId: prepared.modelId ?? undefined,
    providerDefaults: prepared.providerDefaults ?? undefined,
    taskDefaults: prepared.taskDefaults ?? undefined,
    modelOverrides: prepared.modelOverrides ?? undefined,
  })).toThrow(/UNSUPPORTED_CAPABILITY/)
})


// AI-MODELS-1b: the synchronized row is the one source, so a model whose live
// row adds structured output is offered to Writing too (the bundled flag no
// longer narrows it).
test("S3 r1 drift: the synchronized capability decides every assistant's choices", async () => {
  setAvailability({ anthropic: false, openrouter: true, openai: false })
  const t = convexTest(schema, modules)
  await seed(t, "openrouter")
  const model = "amazon/nova-2-lite-v1"
  expect(OPENROUTER_API_CATALOG[model].structuredOutput).toBe(false)
  await t.run((ctx) => insertSyncedOpenRouterRow(ctx, {
    modelId: model, name: "Drifted structured capability", inputModalities: ["text"],
    structuredOutput: true, reasoningEfforts: ["high", "medium", "low"], syncedAt: 1,
  }))
  const status = (await identity(t, "admin-1").query(api.cms.aiSettings.status, {}))!
  for (const assistant of status.assistants) {
    const offered = assistant.choices.openrouter.map((choice) => choice.model)
    expect(offered).toContain(model)
  }
})

test("S3 r1 status retains the saved tuple on a capability refusal and prepare still refuses", async () => {
  setAvailability({ anthropic: false, openrouter: true, openai: false })
  const t = convexTest(schema, modules)
  await seed(t, "openrouter")
  const owner = identity(t, "admin-1")
  const tuple = {
    mode: "catalog", provider: "openrouter", model: "amazon/nova-2-lite-v1",
    reasoning: { kind: "effort", effort: "high" },
  } as const
  await t.run((ctx) => insertSyncedOpenRouterRow(ctx, {
    modelId: tuple.model, name: "Drifted structured capability", inputModalities: ["text"],
    structuredOutput: true, reasoningEfforts: ["high", "medium", "low"], syncedAt: 1,
  }))
  await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })).resolves.toBeNull()
  // The next list drops structured output: the saved choice stays as saved.
  await t.run(async (ctx) => {
    const row = (await ctx.db.query("openRouterCatalogModels")
      .withIndex("by_modelId", (q) => q.eq("modelId", tuple.model)).unique())!
    await ctx.db.patch("openRouterCatalogModels", row._id, { structuredOutput: false })
  })
  const status = (await owner.query(api.cms.aiSettings.status, {}))!
  expect(status.assistants.find((assistant) => assistant.id === "writing")!.effective).toEqual(tuple)
  const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
  let refusal: unknown
  try {
    aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, { catalog: catalogFromEntries(prepared.catalog),
      profile: "structured-outline-meta", phase: "page-meta",
      legacyModelId: prepared.modelId ?? undefined,
      providerDefaults: prepared.providerDefaults ?? undefined,
      taskDefaults: prepared.taskDefaults ?? undefined,
      modelOverrides: prepared.modelOverrides ?? undefined,
    })
  } catch (error) {
    refusal = error
  }
  expect(refusal).toMatchObject({ data: { category: "UNSUPPORTED_CAPABILITY" } })
  // Writing's primary profile needs no structured output today. Replay the real
  // secondary-profile refusal at status's resolver seam to exercise its catch.
  const resolver = vi.spyOn(aiRuntime, "resolveAssistantRuntimeTuple")
    .mockImplementationOnce(() => { throw refusal })
  try {
    const refusedStatus = (await owner.query(api.cms.aiSettings.status, {}))!
    expect(refusedStatus.assistants.find((assistant) => assistant.id === "writing")!.effective).toEqual(tuple)
    for (const other of [
      new Error("Persisted AI model selection is incompatible with this task profile. Unexpected failure."),
      new ConvexError({ category: "CONFIG_MISSING" }),
    ]) {
      resolver.mockImplementationOnce(() => { throw other })
      await expect(owner.query(api.cms.aiSettings.status, {})).rejects.toThrow(other.message)
    }
  } finally {
    resolver.mockRestore()
  }
})

// Review 1b finding 2: Settings shows the saved selection a run would use,
// even when that run refuses it (here, medium effort where Translation's
// primary profile needs high); it never shows the committed default instead.
test("S3 r1 status shows a refused inherited provider default as saved until an assistant is saved", async () => {
  setAvailability({ anthropic: false, openrouter: true, openai: false })
  const t = convexTest(schema, modules)
  await seed(t, "openrouter")
  // Legacy D3 can contain medium effort; Translation's primary profile needs high.
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").first())!
    await ctx.db.patch("siteSettings", settings._id, {
      aiRuntime: { selectedProvider: "openrouter", providerDefaults: {
        openrouter: { mode: "catalog", provider: "openrouter", model: "amazon/nova-2-lite-v1",
          reasoning: { kind: "effort", effort: "medium" } },
      } },
    })
  })
  const owner = identity(t, "admin-1")
  const status = (await owner.query(api.cms.aiSettings.status, {}))!
  const primary = taskProfileTuple("openrouter", ASSISTANT_PROFILES.translation[0])
  const translation = status.assistants.find((assistant) => assistant.id === "translation")!
  const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
  expect(stored!.aiRuntime!.assistants?.translation?.tuple).toBeUndefined()
  expect(translation.effective).toEqual({ mode: "catalog", provider: "openrouter", model: "amazon/nova-2-lite-v1",
    reasoning: { kind: "effort", effort: "medium" } })
  expect(translation.effective).not.toEqual(primary)
  expect(() => aiRuntime.resolveAssistantRuntimeTuple({
    provider: "openrouter", tuple: null, legacy: false, instructions: "",
  }, { catalog: BUNDLED_MODEL_CATALOG, profile: ASSISTANT_PROFILES.translation[0], phase: "translation",
    providerDefaults: { openrouter: { mode: "catalog", provider: "openrouter", model: "amazon/nova-2-lite-v1",
      reasoning: { kind: "effort", effort: "medium" } } },
  })).toThrow("Persisted AI model selection is incompatible with this task profile.")
  const saved = taskProfileTuple("openrouter", "mechanical-translation")
  await owner.mutation(api.cms.aiSettings.setAssistant, { id: "translation", tuple: saved })
  const updated = (await owner.query(api.cms.aiSettings.status, {}))!
  expect(updated.assistants.find((assistant) => assistant.id === "translation")!.effective).toEqual(saved)
  expect(aiRuntime.resolveAssistantRuntimeTuple({
    provider: "openrouter", tuple: saved, legacy: false, instructions: "",
  }, { catalog: BUNDLED_MODEL_CATALOG, profile: "mechanical-translation", phase: "translation" })).toEqual(saved)
})


test.each(["reasoning-lost", "primary-removed"] as const)(
  "S3 defaults drift: %s uses the first offered OpenRouter tuple through Save and every Writing profile",
  async (drift) => {
    setAvailability({ anthropic: false, openrouter: true, openai: false })
    const t = convexTest(schema, modules)
    await seed(t, "openrouter")
    await t.run(async (ctx) => {
      if (drift === "reasoning-lost") {
        await insertSyncedOpenRouterRow(ctx, {
          modelId: "google/gemini-3-flash-preview", name: "Reasoning lost",
          inputModalities: ["text"], structuredOutput: true, reasoningEfforts: [], syncedAt: 1,
        })
      }
      await insertSyncedOpenRouterRow(ctx, {
        modelId: "new/default", name: "First offered replacement", inputModalities: ["text"],
        structuredOutput: true, reasoningEfforts: ["low", "high"], syncedAt: 1,
      })
    })
    const owner = identity(t, "admin-1")
    const status = (await owner.query(api.cms.aiSettings.status, {}))!
    const writing = status.assistants.find((assistant) => assistant.id === "writing")!
    // reasoning-lost: the live row offers the primary model without effort
    // control, so the primary tuple (with effort) is not offered.
    const first = drift === "reasoning-lost"
      ? { mode: "catalog", provider: "openrouter", model: "google/gemini-3-flash-preview" }
      : { mode: "catalog", provider: "openrouter", model: "new/default", reasoning: { kind: "effort", effort: "low" } }
    expect(writing.choices.openrouter.map((choice) => choice.model)).toEqual(
      drift === "reasoning-lost" ? ["google/gemini-3-flash-preview", "new/default"] : ["new/default"]
    )
    expect(writing.defaults.openrouter).toEqual(first)
    const tuple = writing.defaults.openrouter!
    await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })).resolves.toBeNull()
    const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(stored!.aiRuntime!.assistants!.writing!.tuple).toEqual(tuple)
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    for (const profile of ASSISTANT_PROFILES.writing) {
      expect(aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, { catalog: catalogFromEntries(prepared.catalog),
        profile, phase: "content-generation", legacyModelId: prepared.modelId ?? undefined,
        providerDefaults: prepared.providerDefaults ?? undefined, taskDefaults: prepared.taskDefaults ?? undefined,
        modelOverrides: prepared.modelOverrides ?? undefined,
      })).toEqual(tuple)
    }
  }
)

describe("one default rule for Settings and runs (nothing saved)", () => {
  async function app(withReplacement: boolean) {
    setAvailability({ anthropic: false, openrouter: true, openai: false })
    const t = convexTest(schema, modules)
    await seed(t, "openrouter")
    if (withReplacement) {
      await t.run(async (ctx) => {
        await insertSyncedOpenRouterRow(ctx, {
          modelId: "new/default", name: "First offered replacement", inputModalities: ["text"],
          structuredOutput: true, reasoningEfforts: ["low", "high"], syncedAt: 1,
        })
      })
    }
    return { t, owner: identity(t, "admin-1") }
  }

  test("committed default missing from the live list: a run uses the tuple Settings shows", async () => {
    const { owner } = await app(true)
    const status = (await owner.query(api.cms.aiSettings.status, {}))!
    const writing = status.assistants.find((assistant) => assistant.id === "writing")!
    const shown = writing.defaults.openrouter!
    expect(shown).toMatchObject({ provider: "openrouter", model: "new/default" })
    expect(writing.effective).toEqual(shown)
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    expect(prepared.assistant.tuple).toBeNull()
    const catalog = catalogFromEntries(prepared.catalog)
    for (const profile of ASSISTANT_PROFILES.writing) {
      const tuple = aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, {
        catalog, profile, phase: "content-generation", legacyModelId: prepared.modelId ?? undefined,
        providerDefaults: prepared.providerDefaults ?? undefined, taskDefaults: prepared.taskDefaults ?? undefined,
        modelOverrides: prepared.modelOverrides ?? undefined,
      })
      expect(tuple).toEqual(shown)
      // The run is admitted: the shared catalog accepts the tuple for this profile.
      expect(() => validateTupleForProfiles(tuple, [profile], catalog)).not.toThrow()
    }
  })

  test("committed default offered: unchanged, Settings and runs both use it", async () => {
    const { owner } = await app(false)
    const status = (await owner.query(api.cms.aiSettings.status, {}))!
    const writing = status.assistants.find((assistant) => assistant.id === "writing")!
    expect(writing.defaults.openrouter).toEqual(taskProfileTuple("openrouter", "editorial-copy"))
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    expect(aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, {
      catalog: catalogFromEntries(prepared.catalog), profile: "editorial-copy", phase: "content-generation",
    })).toEqual(taskProfileTuple("openrouter", "editorial-copy"))
  })
})

// Review 1b round 2: with nothing saved and the committed tuple not offered,
// a prepared run decides from the same whole, ordered list Settings shows.
describe("review 1b round 2: prepared runs use the default Settings shows", () => {
  const writingRun = (prepared: {
    assistant: Parameters<typeof aiRuntime.resolveAssistantRuntimeTuple>[0]
    catalog: Parameters<typeof catalogFromEntries>[0]
    modelId: string | null
    providerDefaults: Parameters<typeof aiRuntime.resolveAssistantRuntimeTuple>[1]["providerDefaults"] | null
    taskDefaults: Parameters<typeof aiRuntime.resolveAssistantRuntimeTuple>[1]["taskDefaults"] | null
    modelOverrides: Parameters<typeof aiRuntime.resolveAssistantRuntimeTuple>[1]["modelOverrides"] | null
  }, profile: Parameters<typeof aiRuntime.resolveAssistantRuntimeTuple>[1]["profile"], phase: "content-generation" | "translation") =>
    aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, {
      catalog: catalogFromEntries(prepared.catalog), profile, phase,
      legacyModelId: prepared.modelId ?? undefined,
      providerDefaults: prepared.providerDefaults ?? undefined,
      taskDefaults: prepared.taskDefaults ?? undefined,
      modelOverrides: prepared.modelOverrides ?? undefined,
    })
  const row = (modelId: string, extra: Partial<Omit<Doc<"openRouterCatalogModels">, "_id" | "_creationTime">> = {}) => ({
    modelId, name: modelId, inputModalities: ["text" as const], structuredOutput: true,
    reasoningEfforts: ["low" as const, "medium" as const, "high" as const], syncedAt: 1, ...extra,
  })
  async function writingApp(rows: ReturnType<typeof row>[]) {
    setAvailability({ anthropic: false, openrouter: true, openai: false })
    const t = convexTest(schema, modules)
    await seed(t, "openrouter")
    await t.run(async (ctx) => {
      for (const r of rows) await insertSyncedOpenRouterRow(ctx, r)
    })
    return { t, owner: identity(t, "admin-1") }
  }
  const writingStatus = async (owner: ReturnType<typeof identity>) =>
    ((await owner.query(api.cms.aiSettings.status, {}))!).assistants.find((a) => a.id === "writing")!

  test("counterexample (a): the committed model lost effort control and a newer dated model is offered", async () => {
    const { owner } = await writingApp([
      row("google/gemini-3-flash-preview", { reasoningEfforts: [], releasedAt: 1_700_000_000_000 }),
      row("new/dated", { releasedAt: 1_790_000_000_000 }),
    ])
    const writing = await writingStatus(owner)
    const shown = writing.defaults.openrouter!
    expect(shown).toMatchObject({ provider: "openrouter", model: "new/dated", reasoning: { kind: "effort" } })
    expect(writing.effective).toEqual(shown)
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    for (const profile of ASSISTANT_PROFILES.writing) {
      const tuple = writingRun(prepared, profile, "content-generation")
      expect(tuple).toEqual(shown)
      expect(() => validateTupleForProfiles(tuple, [profile], catalogFromEntries(prepared.catalog))).not.toThrow()
    }
  })

  test("counterexample (b): undated legacy rows with Translation's primary absent", async () => {
    setAvailability({ anthropic: false, openrouter: true, openai: false })
    const t = convexTest(schema, modules)
    await seed(t, "openrouter")
    await t.run(async (ctx) => {
      const state = (await ctx.db.query("cmsModuleState").first())!
      await ctx.db.patch("cmsModuleState", state._id, {
        enabledModules: [{ moduleId: "ai", configVersion: 1 }, { moduleId: "multilingual", configVersion: 1 }],
      })
      // No release dates: the order is the stored order, as Settings reads it.
      await insertSyncedOpenRouterRow(ctx, row("aion-labs/aion-2.0"))
      await insertSyncedOpenRouterRow(ctx, row("google/gemini-3-flash-preview"))
    })
    const owner = identity(t, "admin-1")
    const translation = ((await owner.query(api.cms.aiSettings.status, {}))!).assistants.find((a) => a.id === "translation")!
    const shown = translation.defaults.openrouter!
    expect(shown).toEqual({ mode: "catalog", provider: "openrouter", model: "aion-labs/aion-2.0", reasoning: { kind: "effort", effort: "high" } })
    const prepared = await owner.query(internal.agents.localizer.prepareTranslation, {})
    for (const profile of ASSISTANT_PROFILES.translation) {
      expect(writingRun(prepared, profile, "translation")).toEqual(shown)
    }
  })

  test("committed tuple offered: unchanged, and the whole list is not read", async () => {
    const { owner } = await writingApp([
      row("google/gemini-3-flash-preview"),
      ...Array.from({ length: 30 }, (_, i) => row(`other/model-${i}`)),
    ])
    const writing = await writingStatus(owner)
    expect(writing.defaults.openrouter).toEqual(taskProfileTuple("openrouter", "editorial-copy"))
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    expect(prepared.catalog.length).toBeLessThan(10)
    for (const profile of ASSISTANT_PROFILES.writing) {
      expect(writingRun(prepared, profile, "content-generation")).toEqual(taskProfileTuple("openrouter", profile))
    }
  })

  test.each(["offered", "removed"] as const)(
    "a saved site default (%s) keeps precedence while the default falls back",
    async (state) => {
      const { t, owner } = await writingApp([
        row("google/gemini-3-flash-preview", { reasoningEfforts: [], releasedAt: 1_700_000_000_000 }),
        row("new/dated", { releasedAt: 1_790_000_000_000 }),
        row("saved/choice", { releasedAt: 1_600_000_000_000 }),
      ])
      const saved = { mode: "catalog", provider: "openrouter", model: "saved/choice", reasoning: { kind: "effort", effort: "medium" } } as const
      await t.run(async (ctx) => {
        const settings = (await ctx.db.query("siteSettings").first())!
        await ctx.db.patch("siteSettings", settings._id, {
          aiRuntime: { selectedProvider: "openrouter", providerDefaults: { openrouter: saved } },
        })
        if (state === "removed") {
          const stored = await ctx.db.query("openRouterCatalogModels")
            .withIndex("by_modelId", (q) => q.eq("modelId", "saved/choice")).unique()
          await ctx.db.delete("openRouterCatalogModels", stored!._id)
        }
      })
      const writing = await writingStatus(owner)
      expect(writing.defaults.openrouter).toMatchObject({ model: "new/dated" })
      expect(writing.effective).toEqual(saved)
      const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
      for (const profile of ASSISTANT_PROFILES.writing) {
        if (state === "offered") expect(writingRun(prepared, profile, "content-generation")).toEqual(saved)
        else expect(() => writingRun(prepared, profile, "content-generation")).toThrow()
      }
    }
  )

  test("no offered choice: Settings shows no default and every run refuses", async () => {
    // The only row lacks structured output, which Writing's second profile needs.
    const { owner } = await writingApp([row("text/only", { structuredOutput: false, reasoningEfforts: [] })])
    const writing = await writingStatus(owner)
    expect(writing.choices.openrouter).toEqual([])
    expect(writing.defaults.openrouter).toBeNull()
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    expect(prepared.catalog.map((entry) => entry.model)).toContain("text/only")
    for (const profile of ASSISTANT_PROFILES.writing) {
      expect(() => writingRun(prepared, profile, "content-generation")).toThrow()
    }
  })

  test("Block creator: every provider's prepared catalog gives the default Settings shows", async () => {
    setAvailability({ anthropic: true, openrouter: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    // OpenRouter is live without its committed tuple offered; the direct
    // providers keep their bundled committed defaults.
    await t.run(async (ctx) => {
      for (const id of ["vision/a", "vision/b"])
        await insertSyncedOpenRouterRow(ctx, row(id, { inputModalities: ["text", "image"] }))
      // A saved Block creator model is a candidate entry: a partial list would
      // put it ahead of Settings' first choice (vision/a).
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        aiRuntime: {
          ...settings.aiRuntime,
          assistants: { blockCreator: { tuple: { mode: "catalog", provider: "openrouter", model: "vision/b", reasoning: { kind: "effort", effort: "high" } } } },
        },
      })
    })
    const owner = identity(t, "admin-1")
    const creator = await owner.query(api.cms.aiSettings.blockCreator, {})
    expect(creator.defaults.openrouter).toEqual({ mode: "catalog", provider: "openrouter", model: "vision/a", reasoning: { kind: "effort", effort: "high" } })
    expect(creator.defaults.anthropic).toEqual(taskProfileTuple("anthropic", "vision-spec"))
    const catalog = catalogFromEntries(creator.catalog)
    for (const provider of API_PROVIDERS) {
      const shown = creator.defaults[provider]
      expect(shown).not.toBeNull()
      for (const profile of BLOCK_CREATOR_PROFILES) {
        expect(resolveLocalApiTuple(provider, profile, {}, catalog), `${provider}/${profile}`).toEqual(shown)
      }
    }
  })

  test("P3: the legacy models projection lists only offered models", async () => {
    setAvailability({ anthropic: false, openrouter: false, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    const owner = identity(t, "admin-1")
    const settings = await owner.query(api.cms.ai.getModelsSettings, {})
    for (const provider of settings.providers) {
      const offered = await t.run(async (ctx) =>
        catalogFromEntries(await loadProviderCatalog(ctx, provider.id)).list(provider.id, Date.now()).map((e) => e.model)
      )
      for (const selection of provider.selections) expect(offered).toContain(selection.model)
    }
    const openai = settings.providers.find((p) => p.id === "openai")!
    expect(openai.selections.length).toBeGreaterThan(0)
    expect(openai.selections.map((selection) => selection.model)).not.toContain("gpt-6-sol")
  })
})

describe("status while the AI module is off", () => {
  test("returns null for the owner and still refuses everyone else", async () => {
    setAvailability({ anthropic: false, openrouter: false, openai: false })
    const t = convexTest(schema, modules)
    await seed(t)
    const owner = identity(t, "admin-1")
    expect(await owner.query(api.cms.aiSettings.status, {})).not.toBeNull()
    await t.run(async (ctx) => {
      const state = await ctx.db.query("cmsModuleState").first()
      await ctx.db.patch("cmsModuleState", state!._id, { enabledModules: [] })
    })
    expect(await owner.query(api.cms.aiSettings.status, {})).toBeNull()
    await expect(t.query(api.cms.aiSettings.status, {})).rejects.toThrow(/UNAUTHENTICATED/)
    await expect(identity(t, "viewer-1").query(api.cms.aiSettings.status, {}))
      .rejects.toThrow(/CMS_OWNER_REQUIRED/)
  })
})

describe("Block creator settings (fourth assistant, local-only)", () => {
  async function blockApp() {
    setAvailability({ anthropic: false, openrouter: false, openai: false })
    const t = convexTest(schema, modules)
    await seed(t)
    return { t, owner: identity(t, "admin-1") }
  }
  const storedAssistants = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => (await ctx.db.query("siteSettings").first())?.aiRuntime?.assistants ?? {})
  const valid = taskProfileTuple("anthropic", "vision-spec")

  test("read: owner-only, module-gated, empty by default, returns the saved entry", async () => {
    const { t, owner } = await blockApp()
    await expect(t.query(api.cms.aiSettings.blockCreator, {})).rejects.toThrow(/UNAUTHENTICATED/)
    for (const subject of ["editor-1", "viewer-1"]) {
      await expect(identity(t, subject).query(api.cms.aiSettings.blockCreator, {}))
        .rejects.toThrow(/CMS_OWNER_REQUIRED/)
    }
    const empty = await owner.query(api.cms.aiSettings.blockCreator, {})
    expect(empty).not.toHaveProperty("tuple")
    expect(empty).not.toHaveProperty("instructions")
    await owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: valid, instructions: "Plain words." })
    const saved = await owner.query(api.cms.aiSettings.blockCreator, {})
    expect(saved).toMatchObject({ tuple: valid, instructions: "Plain words." })
    assertNoRuntimeSecretsOrLocalState(saved)
    expect(Object.keys(saved).sort()).toEqual(["catalog", "choices", "defaults", "instructions", "newerModels", "tuple"])

    await t.run(async (ctx) => {
      const state = await ctx.db.query("cmsModuleState").first()
      await ctx.db.patch("cmsModuleState", state!._id, { enabledModules: [] })
    })
    await expect(owner.query(api.cms.aiSettings.blockCreator, {})).rejects.toThrow(/CMS_MODULE_DISABLED/)
  })

  test("every offered choice and effort passes both Block creator profiles; defaults hold a tuple or null", async () => {
    const { owner } = await blockApp()
    const { choices, defaults } = await owner.query(api.cms.aiSettings.blockCreator, {})
    let offered = 0
    for (const provider of API_PROVIDERS) {
      for (const choice of choices[provider]) {
        expect(choice.efforts.length).toBeGreaterThan(0)
        for (const effort of choice.efforts) {
          const tuple = { mode: "catalog", provider, model: choice.model, reasoning: { kind: "effort", effort } }
          for (const profile of BLOCK_CREATOR_PROFILES) {
            expect(() => validateTupleForProfiles(tuple, [profile], BUNDLED_MODEL_CATALOG), `${provider}/${choice.model}/${effort}/${profile}`).not.toThrow()
          }
          offered += 1
        }
      }
      const tuple = defaults[provider]
      if (tuple !== null) {
        expect(() => validateTupleForProfiles(tuple, ["vision-spec"], BUNDLED_MODEL_CATALOG)).not.toThrow()
        expect(() => validateTupleForProfiles(tuple, ["renderer-jsx"], BUNDLED_MODEL_CATALOG)).not.toThrow()
      }
    }
    expect(offered).toBeGreaterThan(0)
    expect(defaults.anthropic).toEqual(taskProfileTuple("anthropic", "vision-spec"))
  })

  test("save: owner-only, module-gated, bounded, validated, replace semantics", async () => {
    const { t, owner } = await blockApp()
    await expect(t.mutation(api.cms.aiSettings.setBlockCreator, { tuple: valid })).rejects.toThrow(/UNAUTHENTICATED/)
    await expect(identity(t, "editor-1").mutation(api.cms.aiSettings.setBlockCreator, { tuple: valid }))
      .rejects.toThrow(/CMS_OWNER_REQUIRED/)
    await expect(storedAssistants(t)).resolves.toEqual({})

    await expect(owner.mutation(api.cms.aiSettings.setBlockCreator, { instructions: "x".repeat(4_001) }))
      .rejects.toThrow("AI_ASSISTANT_INSTRUCTIONS_TOO_LONG")
    const low = { ...valid, reasoning: { kind: "effort", effort: "low" } } as Exclude<ApiModelTuple, { mode: "legacy" }>
    await expect(owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: low }))
      .rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
    const unknown = { mode: "catalog", provider: "anthropic", model: "no-such-model",
      reasoning: { kind: "effort", effort: "high" } } as unknown as Exclude<ApiModelTuple, { mode: "legacy" }>
    await expect(owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: unknown }))
      .rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
    await expect(storedAssistants(t)).resolves.toEqual({})

    await owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: valid, instructions: "x".repeat(4_000) })
    expect((await storedAssistants(t))?.blockCreator).toEqual({ tuple: valid, instructions: "x".repeat(4_000) })
    await owner.mutation(api.cms.aiSettings.setBlockCreator, { instructions: "Only words." })
    expect((await storedAssistants(t))?.blockCreator).toEqual({ instructions: "Only words." })
    expect(await owner.query(api.cms.aiSettings.blockCreator, {})).not.toHaveProperty("tuple")

    await t.run(async (ctx) => {
      const state = await ctx.db.query("cmsModuleState").first()
      await ctx.db.patch("cmsModuleState", state!._id, { enabledModules: [] })
    })
    await expect(owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: valid }))
      .rejects.toThrow(/CMS_MODULE_DISABLED/)
  })

  test("neighbours keep each other's entries", async () => {
    const { t, owner } = await blockApp()
    await owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: valid, instructions: "Keep me." })
    await owner.mutation(api.cms.aiSettings.setAssistant, {
      id: "writing", tuple: taskProfileTuple("anthropic", "editorial-copy"),
    })
    await owner.mutation(api.cms.aiSettings.setProductionAiConfiguration, {
      selectedProvider: "off", providerDefaults: {},
    })
    const afterNeighbours = await storedAssistants(t)
    expect(afterNeighbours?.blockCreator).toEqual({ tuple: valid, instructions: "Keep me." })
    expect(afterNeighbours?.writing?.tuple).toEqual(taskProfileTuple("anthropic", "editorial-copy"))

    await owner.mutation(api.cms.aiSettings.setAssistant, { id: "help", instructions: "Be brief." })
    const three = { ...(await storedAssistants(t))! }
    delete three.blockCreator
    await owner.mutation(api.cms.aiSettings.setBlockCreator, { tuple: valid })
    const { blockCreator: replaced, ...threeAfter } = (await storedAssistants(t))!
    expect(threeAfter).toEqual(three)
    expect(replaced).toEqual({ tuple: valid })
  })
})


describe("widened direct tuple storage (AI-MODELS-1 step A)", () => {
  // Every shape stored today, a direct id the committed lists do not know, and
  // Haiku 4.5 with no effort must pass the real table validators.
  const directShapes = (["anthropic", "openai"] as const).flatMap((provider) =>
    Object.entries(provider === "anthropic" ? ANTHROPIC_API_CATALOG : OPENAI_API_CATALOG)
      .flatMap(([model, cap]: [string, ApiModelCapability]) =>
        cap.reasoning.kind === "effort"
          ? cap.reasoning.supportedEfforts.map((effort) =>
            ({ mode: "catalog", provider, model, reasoning: { kind: "effort", effort } }))
          : [{ mode: "catalog", provider, model }]))
  const committedShapes = [
    ...directShapes,
    ...API_PROVIDERS.flatMap((provider) => RUNTIME_TASK_PROFILES.map((profile) => taskProfileTuple(provider, profile))),
    { mode: "catalog", provider: "openrouter", model: "google/gemini-3-flash-preview", reasoning: { kind: "effort", effort: "medium" } },
    { mode: "catalog", provider: "openrouter", model: "example/no-reasoning" },
  ]
  const newShapes = [
    { mode: "catalog", provider: "anthropic", model: "claude-opus-9-9", reasoning: { kind: "effort", effort: "high" } },
    { mode: "catalog", provider: "anthropic", model: "claude-opus-9-9" },
    { mode: "catalog", provider: "openai", model: "gpt-9-sol", reasoning: { kind: "effort", effort: "minimal" } },
    { mode: "catalog", provider: "anthropic", model: "claude-haiku-4-5-20251001" },
  ]
  const invalid = [
    { mode: "catalog", provider: "anthropic", model: "claude-opus-5-5", reasoning: { kind: "effort", effort: "ultra" } },
    { mode: "catalog", provider: "openai", model: "gpt-6.1-sol", reasoning: { kind: "effort", effort: "high" }, credential: "x" },
    { mode: "catalog", provider: "openai", model: 7 },
  ]
  const tables = schema.tables

  test("siteSettings.aiRuntime, agentConfigs.modelOverrides and aiJobs.tuple accept every stored and new shape", async () => {
    const { validate } = await import("convex-helpers/validators")
    const aiRuntime = tables.siteSettings.validator.fields.aiRuntime
    const modelOverrides = tables.agentConfigs.validator.fields.modelOverrides
    const jobTuple = tables.aiJobs.validator.fields.tuple
    expect(directShapes.length).toBeGreaterThan(30)
    for (const tuple of [...committedShapes, ...newShapes]) {
      const provider = tuple.provider
      expect(validate(aiRuntime, {
        selectedProvider: provider,
        providerDefaults: { [provider]: tuple },
        taskDefaults: { "editorial-copy": tuple },
        assistants: { writing: { tuple }, translation: { tuple }, help: { tuple }, blockCreator: { tuple } },
      }), JSON.stringify(tuple)).toBe(true)
      expect(validate(modelOverrides, { [provider]: tuple }), JSON.stringify(tuple)).toBe(true)
      expect(validate(jobTuple, tuple), JSON.stringify(tuple)).toBe(true)
    }
    expect(validate(jobTuple, { mode: "legacy", provider: "openrouter", model: "google/gemini-2.5-flash" })).toBe(true)
    for (const tuple of invalid) {
      expect(validate(jobTuple, tuple), JSON.stringify(tuple)).toBe(false)
      expect(validate(aiRuntime, { assistants: { writing: { tuple } } }), JSON.stringify(tuple)).toBe(false)
    }
    // A provider key holding another provider's tuple stays refused.
    expect(validate(modelOverrides, { openai: newShapes[0] })).toBe(false)
  })

  test("a new direct id stores through the schema and is still refused at Settings save", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    const t = convexTest(schema, modules)
    await seed(t)
    const unknown = newShapes[0] as Exclude<ApiModelTuple, { mode: "legacy" }>
    await t.run(async (ctx) => {
      const settings = await ctx.db.query("siteSettings").first()
      await ctx.db.patch("siteSettings", settings!._id, {
        aiRuntime: { ...settings!.aiRuntime, assistants: { writing: { tuple: unknown } } },
      })
    })
    const owner = identity(t, "admin-1")
    await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple: unknown }))
      .rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
    for (const tuple of [unknown, { mode: "catalog", provider: "openai", model: "gpt-9-sol",
      reasoning: { kind: "effort", effort: "high" } } as const]) {
      await expect(owner.mutation(api.cms.aiSettings.setProductionAiConfiguration, {
        selectedProvider: tuple.provider, providerDefaults: { [tuple.provider]: tuple },
      })).rejects.toThrow(/INVALID_AI_SELECTION: A site default/)
    }
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    expect(prepared.assistant.tuple).toEqual(unknown)
    expect(() => aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, { catalog: catalogFromEntries(prepared.catalog),
      profile: "editorial-copy", phase: "content-generation",
    })).toThrow(/UNSUPPORTED_CAPABILITY/)
  })
})

describe("an OpenRouter key alone no longer selects the legacy model", () => {
  const LEGACY = { mode: "legacy", provider: "openrouter" } as const
  async function freshInstall(
    setup: { siteModel?: boolean; agentModel?: boolean; savedWriting?: boolean } = {}
  ) {
    const t = convexTest(schema, modules)
    await seed(t)
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").first())!
      await ctx.db.patch("siteSettings", settings._id, {
        aiDefaultModel: setup.siteModel ? "site/model" : undefined,
        ...(setup.savedWriting
          ? { aiRuntime: { assistants: { writing: { tuple: PROVIDER_DEFAULTS.openai } } } }
          : {}),
      })
      if (setup.agentModel) {
        await ctx.db.insert("agentConfigs", {
          agent: "content", model: "agent/model", updatedAt: 1,
        } as never)
      }
    })
    return { t, owner: identity(t, "admin-1") }
  }
  async function effectiveAndPrepared(owner: ReturnType<typeof identity>) {
    const status = (await owner.query(api.cms.aiSettings.status, {}))!
    const writing = status.assistants.find((a) => a.id === "writing")!
    const help = status.assistants.find((a) => a.id === "help")!
    const writer = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    const helper = await owner.query(internal.agents.helpAssistant.prepareHelp, {})
    const resolve = (
      prepared: typeof writer, profile: "editorial-copy" | "grounded-help"
    ) => aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, { catalog: catalogFromEntries(prepared.catalog),
      profile,
      phase: profile === "grounded-help" ? "help-answer" : "content-generation",
      legacyModelId: prepared.modelId ?? undefined,
      providerDefaults: prepared.providerDefaults ?? undefined,
      taskDefaults: prepared.taskDefaults ?? undefined,
      modelOverrides: prepared.modelOverrides ?? undefined,
    })
    return {
      writing, help,
      writingRun: resolve(writer, "editorial-copy"),
      helpRun: resolve(helper as unknown as typeof writer, "grounded-help"),
    }
  }

  test("only an OpenRouter key: committed defaults with their effort", async () => {
    setAvailability({ openrouter: true, anthropic: false, openai: false })
    const { owner } = await freshInstall()
    const r = await effectiveAndPrepared(owner)
    const writingDefault = API_TASK_PROFILES.openrouter["editorial-copy"]
    const helpDefault = API_TASK_PROFILES.openrouter["grounded-help"]
    expect(r.writing.effective).toEqual(writingDefault)
    expect(r.help.effective).toEqual(helpDefault)
    expect(r.writingRun).toEqual(writingDefault)
    expect(r.helpRun).toEqual(helpDefault)
    expect(r.writingRun.mode).not.toBe("legacy")
    expect("reasoning" in r.writingRun && r.writingRun.reasoning).toBeTruthy()
  })

  test("Anthropic and OpenRouter keys: Writing uses the Anthropic default", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: false })
    const { owner } = await freshInstall()
    const r = await effectiveAndPrepared(owner)
    expect(r.writing.effective).toEqual(API_TASK_PROFILES.anthropic["editorial-copy"])
    expect(r.writingRun).toEqual(API_TASK_PROFILES.anthropic["editorial-copy"])
  })

  test.each([
    ["CMS_AI_MODEL", "env", "env/model"],
    ["site default model", "site", "site/model"],
    ["agent model", "agent", "agent/model"],
  ])("%s set: the legacy tuple as before", async (_label, kind, model) => {
    setAvailability({ openrouter: true, anthropic: false, openai: false })
    if (kind === "env") vi.stubEnv("CMS_AI_MODEL", model)
    const { owner } = await freshInstall({
      siteModel: kind === "site", agentModel: kind === "agent",
    })
    const r = await effectiveAndPrepared(owner)
    expect(r.writing.effective).toEqual({ ...LEGACY, model })
    expect(r.writingRun).toEqual({ ...LEGACY, model })
  })

  test("a saved assistant tuple wins whether or not a legacy model is set", async () => {
    setAvailability({ openrouter: true, anthropic: true, openai: true })
    for (const legacy of [false, true]) {
      vi.stubEnv("CMS_AI_MODEL", legacy ? "env/model" : "")
      const { owner } = await freshInstall({ savedWriting: true })
      const r = await effectiveAndPrepared(owner)
      expect(r.writing.effective).toEqual(PROVIDER_DEFAULTS.openai)
      expect(r.writingRun).toEqual(PROVIDER_DEFAULTS.openai)
    }
  })
})

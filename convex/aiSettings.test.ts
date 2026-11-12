/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { ConvexError } from "convex/values"
import { afterEach, describe, expect, test, vi } from "vitest"
import { api, internal } from "./_generated/api"
import type { Doc } from "./_generated/dataModel"
import type { RuntimeSelectedProvider } from "./lib/aiConfig"
import { API_PROVIDERS } from "../lib/ai/execution-contract"
import {
  ASSISTANT_PROFILES,
  RUNTIME_TASK_PROFILES,
  SLICE_CREATOR_PROFILES,
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
import rateLimiterTest from "@convex-dev/rate-limiter/test"

const modules = import.meta.glob("./**/*.ts")

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
    await ctx.db.insert("roles", {
      authId: "admin-1",
      role: "admin",
      assignedAt: Date.now(),
    })
    await ctx.db.insert("roles", {
      authId: "editor-1",
      role: "editor",
      assignedAt: Date.now(),
    })
    await ctx.db.insert("roles", {
      authId: "viewer-1",
      role: "viewer",
      assignedAt: Date.now(),
    })
    await ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: "admin-1",
      tokenIdentifier: "https://convex.test|admin-1",
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

    // Both saves call `Date.now()`, so on a fast machine they can land in the
    // same millisecond and the strict `>` below fails for a reason that has
    // nothing to do with the short-circuit this test covers. Pin the clock and
    // step it by hand. Only `Date` is faked — convex-test drives its async work
    // through real timers, which faking wholesale would stall.
    vi.useFakeTimers({ toFake: ["Date"] })
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"))

    // Baseline save with no task defaults.
    await identity(t, "admin-1").mutation(
      api.cms.aiSettings.setProductionAiConfiguration,
      { selectedProvider: "openai", providerDefaults: PROVIDER_DEFAULTS }
    )
    const first = await t.run((ctx) => ctx.db.query("siteSettings").first())
    const firstUpdatedAt = first?.updatedAt ?? 0
    expect(first?.aiRuntime?.taskDefaults).toBeUndefined()

    vi.setSystemTime(new Date("2026-01-01T00:00:01.000Z"))

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
    expect(second?.updatedAt).toBeGreaterThan(firstUpdatedAt)
    expect(second?.aiRuntime?.taskDefaults).toBeDefined()
  })
})


test("every direct catalog model persists through assistant settings and status", async () => {
  setAvailability({ openrouter: true, anthropic: true, openai: true })
  const t = convexTest(schema, modules)
  await seed(t)
  const owner = identity(t, "admin-1")
  const initial = await owner.query(api.cms.aiSettings.status, {})
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
        }, { profile, phase: "content-generation" })).toEqual(tuple)
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
      })
      if (tuple.mode !== "catalog") throw new Error("Expected a catalog tuple")
      await owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })
      const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
      expect(stored?.aiRuntime?.assistants?.writing?.tuple).toEqual(tuple)
      const status = await owner.query(api.cms.aiSettings.status, {})
      expect(status.assistants.find((a) => a.id === "writing")?.tuple).toEqual(tuple)
    }
  }
})

test("a direct model whose price ends is no longer offered; OpenRouter keeps its id", async () => {
  setAvailability({ openrouter: true, anthropic: true, openai: true })
  const t = convexTest(schema, modules)
  await seed(t)
  const owner = identity(t, "admin-1")
  const status = await owner.query(api.cms.aiSettings.status, {})
  const creator = await owner.query(api.cms.aiSettings.sliceCreator, {})
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
      expect(OPENROUTER_API_CATALOG["ai21/jamba-large-1.7"].reasoning.kind).toBe("unsupported")
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
            { modelId: "ai21/jamba-large-1.7", name: "Gained synchronized reasoning", inputModalities: ["text"] as const, structuredOutput: true, reasoningEfforts: ["high", "medium", "low"] as const },
          ] : [
            { modelId: "new/non-portable", name: "New model with non-portable effort", inputModalities: ["text"] as const, structuredOutput: true, reasoningEfforts: ["xhigh", "low", "high"] as const },
          ]),
        ]) {
          await ctx.db.insert("openRouterCatalogModels", { ...row, inputModalities: [...row.inputModalities], reasoningEfforts: [...row.reasoningEfforts], syncedAt: 1 })
        }
      })
    }
    const owner = identity(t, "admin-1")
    const status = await owner.query(api.cms.aiSettings.status, {})
    let offeredTuples = 0
    for (const assistant of status.assistants) {
      // Missing credentials and unavailable Multilingual do not suppress the projection.
      expect(assistant.ready).toBe(false)
      expect(assistant.effective).toBeDefined()
      if (catalog === "reasoning-lost" || catalog === "reasoning-gained") {
        expect(assistant.choices.openrouter.map((choice) => choice.model)).toEqual(["new/reasoning"])
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
              }, { profile, phase: "content-generation" })).toEqual(savedTuple)
            }
            offeredTuples++
          }
        }
      }
      if (catalog === "synchronized") {
        expect(assistant.choices.openrouter.map((choice) => choice.model)).toEqual(
          assistant.id === "writing" ? ["new/reasoning", "new/effortless"]
            : assistant.id === "translation" ? ["new/reasoning", "google/gemini-3-flash-preview", "amazon/nova-2-lite-v1"]
            : ["new/reasoning", "new/effortless", "google/gemini-3-flash-preview", "amazon/nova-2-lite-v1"]
        )
        const noEffort = assistant.choices.openrouter.find((choice) => choice.model === "new/effortless")
        if (noEffort) expect(noEffort).toEqual({ model: "new/effortless", name: "New effortless model", efforts: [], providerDefault: null })
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
  await t.run((ctx) => ctx.db.insert("openRouterCatalogModels", {
    modelId: tuple.model, name: "Lost synchronized reasoning", inputModalities: ["text"],
    structuredOutput: true, reasoningEfforts: [], syncedAt: 1,
  }))
  await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })).resolves.toBeNull()
  const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
  expect(stored!.aiRuntime!.assistants!.writing!.tuple).toEqual(tuple)
  expect(() => validateApiModelTuple(tuple)).toThrow()
  const resolver = vi.spyOn(aiRuntime, "resolveAssistantRuntimeTuple")
  try {
    const status = await owner.query(api.cms.aiSettings.status, {})
    expect(status.assistants.find((assistant) => assistant.id === "writing")!.effective).toEqual(tuple)
    expect(resolver.mock.calls.some(([assistant]) => assistant.tuple?.model === tuple.model)).toBe(false)
  } finally {
    resolver.mockRestore()
  }
  const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
  expect(prepared.assistant.tuple).toEqual(tuple)
  expect(() => aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, {
    profile: "editorial-copy", phase: "content-generation",
    legacyModelId: prepared.modelId ?? undefined,
    providerDefaults: prepared.providerDefaults ?? undefined,
    taskDefaults: prepared.taskDefaults ?? undefined,
    modelOverrides: prepared.modelOverrides ?? undefined,
  })).toThrow("The model tuple requires one exact reasoning effort.")
})


test("S3 r1 drift excludes unsupported structured choices but retains other assistants", async () => {
  setAvailability({ anthropic: false, openrouter: true, openai: false })
  const t = convexTest(schema, modules)
  await seed(t, "openrouter")
  const model = "amazon/nova-2-lite-v1"
  expect(OPENROUTER_API_CATALOG[model].structuredOutput).toBe(false)
  await t.run((ctx) => ctx.db.insert("openRouterCatalogModels", {
    modelId: model, name: "Drifted structured capability", inputModalities: ["text"],
    structuredOutput: true, reasoningEfforts: ["high", "medium", "low"], syncedAt: 1,
  }))
  const status = await identity(t, "admin-1").query(api.cms.aiSettings.status, {})
  for (const assistant of status.assistants) {
    const offered = assistant.choices.openrouter.map((choice) => choice.model)
    if (assistant.id === "writing") expect(offered).not.toContain(model)
    else expect(offered).toContain(model)
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
  await t.run((ctx) => ctx.db.insert("openRouterCatalogModels", {
    modelId: tuple.model, name: "Drifted structured capability", inputModalities: ["text"],
    structuredOutput: true, reasoningEfforts: ["high", "medium", "low"], syncedAt: 1,
  }))
  await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })).resolves.toBeNull()
  const status = await owner.query(api.cms.aiSettings.status, {})
  expect(status.assistants.find((assistant) => assistant.id === "writing")!.effective).toEqual(tuple)
  const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
  let refusal: unknown
  try {
    aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, {
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
    const refusedStatus = await owner.query(api.cms.aiSettings.status, {})
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

test("S3 r1 status shows the primary default for refused legacy provider defaults until an assistant is saved", async () => {
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
  const status = await owner.query(api.cms.aiSettings.status, {})
  const primary = taskProfileTuple("openrouter", ASSISTANT_PROFILES.translation[0])
  const translation = status.assistants.find((assistant) => assistant.id === "translation")!
  const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
  expect(stored!.aiRuntime!.assistants?.translation?.tuple).toBeUndefined()
  expect(translation.effective).toEqual(primary)
  expect(() => aiRuntime.resolveAssistantRuntimeTuple({
    provider: "openrouter", tuple: null, legacy: false, instructions: "",
  }, { profile: ASSISTANT_PROFILES.translation[0], phase: "translation",
    providerDefaults: { openrouter: { mode: "catalog", provider: "openrouter", model: "amazon/nova-2-lite-v1",
      reasoning: { kind: "effort", effort: "medium" } } },
  })).toThrow("Persisted AI model selection is incompatible with this task profile.")
  const saved = taskProfileTuple("openrouter", "mechanical-translation")
  await owner.mutation(api.cms.aiSettings.setAssistant, { id: "translation", tuple: saved })
  const updated = await owner.query(api.cms.aiSettings.status, {})
  expect(updated.assistants.find((assistant) => assistant.id === "translation")!.effective).toEqual(saved)
  expect(aiRuntime.resolveAssistantRuntimeTuple({
    provider: "openrouter", tuple: saved, legacy: false, instructions: "",
  }, { profile: "mechanical-translation", phase: "translation" })).toEqual(saved)
})


test.each(["reasoning-lost", "primary-removed"] as const)(
  "S3 defaults drift: %s uses the first offered OpenRouter tuple through Save and every Writing profile",
  async (drift) => {
    setAvailability({ anthropic: false, openrouter: true, openai: false })
    const t = convexTest(schema, modules)
    await seed(t, "openrouter")
    await t.run(async (ctx) => {
      if (drift === "reasoning-lost") {
        await ctx.db.insert("openRouterCatalogModels", {
          modelId: "google/gemini-3-flash-preview", name: "Reasoning lost",
          inputModalities: ["text"], structuredOutput: true, reasoningEfforts: [], syncedAt: 1,
        })
      }
      await ctx.db.insert("openRouterCatalogModels", {
        modelId: "new/default", name: "First offered replacement", inputModalities: ["text"],
        structuredOutput: true, reasoningEfforts: ["low", "high"], syncedAt: 1,
      })
    })
    const owner = identity(t, "admin-1")
    const status = await owner.query(api.cms.aiSettings.status, {})
    const writing = status.assistants.find((assistant) => assistant.id === "writing")!
    expect(writing.choices.openrouter.map((choice) => choice.model)).toEqual(["new/default"])
    expect(writing.defaults.openrouter).toEqual({
      mode: "catalog", provider: "openrouter", model: "new/default", reasoning: { kind: "effort", effort: "low" },
    })
    const tuple = writing.defaults.openrouter!
    await expect(owner.mutation(api.cms.aiSettings.setAssistant, { id: "writing", tuple })).resolves.toBeNull()
    const stored = await t.run((ctx) => ctx.db.query("siteSettings").first())
    expect(stored!.aiRuntime!.assistants!.writing!.tuple).toEqual(tuple)
    const prepared = await owner.query(internal.agents.contentWriter.prepareGeneration, {})
    for (const profile of ASSISTANT_PROFILES.writing) {
      expect(aiRuntime.resolveAssistantRuntimeTuple(prepared.assistant, {
        profile, phase: "content-generation", legacyModelId: prepared.modelId ?? undefined,
        providerDefaults: prepared.providerDefaults ?? undefined, taskDefaults: prepared.taskDefaults ?? undefined,
        modelOverrides: prepared.modelOverrides ?? undefined,
      })).toEqual(tuple)
    }
  }
)

describe("Slice creator settings (fourth assistant, local-only)", () => {
  async function sliceApp() {
    setAvailability({ anthropic: false, openrouter: false, openai: false })
    const t = convexTest(schema, modules)
    await seed(t)
    return { t, owner: identity(t, "admin-1") }
  }
  const storedAssistants = (t: ReturnType<typeof convexTest>) =>
    t.run(async (ctx) => (await ctx.db.query("siteSettings").first())?.aiRuntime?.assistants ?? {})
  const valid = taskProfileTuple("anthropic", "vision-spec")

  test("read: owner-only, module-gated, empty by default, returns the saved entry", async () => {
    const { t, owner } = await sliceApp()
    await expect(t.query(api.cms.aiSettings.sliceCreator, {})).rejects.toThrow(/UNAUTHENTICATED/)
    for (const subject of ["editor-1", "viewer-1"]) {
      await expect(identity(t, subject).query(api.cms.aiSettings.sliceCreator, {}))
        .rejects.toThrow(/CMS_OWNER_REQUIRED/)
    }
    const empty = await owner.query(api.cms.aiSettings.sliceCreator, {})
    expect(empty).not.toHaveProperty("tuple")
    expect(empty).not.toHaveProperty("instructions")
    await owner.mutation(api.cms.aiSettings.setSliceCreator, { tuple: valid, instructions: "Plain words." })
    const saved = await owner.query(api.cms.aiSettings.sliceCreator, {})
    expect(saved).toMatchObject({ tuple: valid, instructions: "Plain words." })
    assertNoRuntimeSecretsOrLocalState(saved)
    expect(Object.keys(saved).sort()).toEqual(["choices", "defaults", "instructions", "tuple"])

    await t.run(async (ctx) => {
      const state = await ctx.db.query("cmsModuleState").first()
      await ctx.db.patch("cmsModuleState", state!._id, { enabledModules: [] })
    })
    await expect(owner.query(api.cms.aiSettings.sliceCreator, {})).rejects.toThrow(/CMS_MODULE_DISABLED/)
  })

  test("every offered choice and effort passes both Slice creator profiles; defaults hold a tuple or null", async () => {
    const { owner } = await sliceApp()
    const { choices, defaults } = await owner.query(api.cms.aiSettings.sliceCreator, {})
    let offered = 0
    for (const provider of API_PROVIDERS) {
      for (const choice of choices[provider]) {
        expect(choice.efforts.length).toBeGreaterThan(0)
        for (const effort of choice.efforts) {
          const tuple = { mode: "catalog", provider, model: choice.model, reasoning: { kind: "effort", effort } }
          for (const profile of SLICE_CREATOR_PROFILES) {
            expect(() => validateTupleForProfiles(tuple, [profile]), `${provider}/${choice.model}/${effort}/${profile}`).not.toThrow()
          }
          offered += 1
        }
      }
      const tuple = defaults[provider]
      if (tuple !== null) {
        expect(() => validateTupleForProfiles(tuple, ["vision-spec"])).not.toThrow()
        expect(() => validateTupleForProfiles(tuple, ["renderer-jsx"])).not.toThrow()
      }
    }
    expect(offered).toBeGreaterThan(0)
    expect(defaults.anthropic).toEqual(taskProfileTuple("anthropic", "vision-spec"))
  })

  test("save: owner-only, module-gated, bounded, validated, replace semantics", async () => {
    const { t, owner } = await sliceApp()
    await expect(t.mutation(api.cms.aiSettings.setSliceCreator, { tuple: valid })).rejects.toThrow(/UNAUTHENTICATED/)
    await expect(identity(t, "editor-1").mutation(api.cms.aiSettings.setSliceCreator, { tuple: valid }))
      .rejects.toThrow(/CMS_OWNER_REQUIRED/)
    await expect(storedAssistants(t)).resolves.toEqual({})

    await expect(owner.mutation(api.cms.aiSettings.setSliceCreator, { instructions: "x".repeat(4_001) }))
      .rejects.toThrow("AI_ASSISTANT_INSTRUCTIONS_TOO_LONG")
    const low = { ...valid, reasoning: { kind: "effort", effort: "low" } } as Exclude<ApiModelTuple, { mode: "legacy" }>
    await expect(owner.mutation(api.cms.aiSettings.setSliceCreator, { tuple: low }))
      .rejects.toThrow("INVALID_AI_ASSISTANT_SELECTION")
    const unknown = { mode: "catalog", provider: "anthropic", model: "no-such-model",
      reasoning: { kind: "effort", effort: "high" } } as unknown as Exclude<ApiModelTuple, { mode: "legacy" }>
    await expect(owner.mutation(api.cms.aiSettings.setSliceCreator, { tuple: unknown }))
      .rejects.toThrow(/Validator error|INVALID_AI_ASSISTANT_SELECTION/)
    await expect(storedAssistants(t)).resolves.toEqual({})

    await owner.mutation(api.cms.aiSettings.setSliceCreator, { tuple: valid, instructions: "x".repeat(4_000) })
    expect((await storedAssistants(t))?.sliceCreator).toEqual({ tuple: valid, instructions: "x".repeat(4_000) })
    await owner.mutation(api.cms.aiSettings.setSliceCreator, { instructions: "Only words." })
    expect((await storedAssistants(t))?.sliceCreator).toEqual({ instructions: "Only words." })
    expect(await owner.query(api.cms.aiSettings.sliceCreator, {})).not.toHaveProperty("tuple")

    await t.run(async (ctx) => {
      const state = await ctx.db.query("cmsModuleState").first()
      await ctx.db.patch("cmsModuleState", state!._id, { enabledModules: [] })
    })
    await expect(owner.mutation(api.cms.aiSettings.setSliceCreator, { tuple: valid }))
      .rejects.toThrow(/CMS_MODULE_DISABLED/)
  })

  test("neighbours keep each other's entries", async () => {
    const { t, owner } = await sliceApp()
    await owner.mutation(api.cms.aiSettings.setSliceCreator, { tuple: valid, instructions: "Keep me." })
    await owner.mutation(api.cms.aiSettings.setAssistant, {
      id: "writing", tuple: taskProfileTuple("anthropic", "editorial-copy"),
    })
    await owner.mutation(api.cms.aiSettings.setProductionAiConfiguration, {
      selectedProvider: "off", providerDefaults: {},
    })
    const afterNeighbours = await storedAssistants(t)
    expect(afterNeighbours?.sliceCreator).toEqual({ tuple: valid, instructions: "Keep me." })
    expect(afterNeighbours?.writing?.tuple).toEqual(taskProfileTuple("anthropic", "editorial-copy"))

    await owner.mutation(api.cms.aiSettings.setAssistant, { id: "help", instructions: "Be brief." })
    const three = { ...(await storedAssistants(t))! }
    delete three.sliceCreator
    await owner.mutation(api.cms.aiSettings.setSliceCreator, { tuple: valid })
    const { sliceCreator: replaced, ...threeAfter } = (await storedAssistants(t))!
    expect(threeAfter).toEqual(three)
    expect(replaced).toEqual({ tuple: valid })
  })
})

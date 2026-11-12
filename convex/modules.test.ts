/// <reference types="vite/client" />

import { convexTest } from "convex-test"
import type { FunctionReference } from "convex/server"
import { describe, expect, test, vi } from "vitest"
import { MODULE_CATALOG } from "../lib/modules/catalog"
import { api } from "./_generated/api"
import { readOwnerState, replaceOwnerBinding } from "./lib/access/owner"
import { resolveEffectiveModuleState } from "./lib/modules/state"
import schema from "./schema"

const readinessTest = vi.hoisted(() => ({ fail: false, setup: false }))
vi.mock("./lib/language/multilingual", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./lib/language/multilingual")>()
  return {
    ...original,
    resolveMultilingualModuleReadiness: async () => {
      if (readinessTest.fail) throw new Error("optional readiness failed")
      return readinessTest.setup
        ? { readiness: "needs_setup", setup: "required" }
        : original.resolveMultilingualModuleReadiness()
    },
  }
})

const modules = import.meta.glob("./**/*.ts")

// F07b intentionally does not run Convex code generation. The registered
// paths are exercised through the runtime API proxy while generated types stay
// untouched until the separately authorized generation boundary.
const moduleApi = api as unknown as {
  cms: {
    modules: {
      preview: FunctionReference<"query">
      commit: FunctionReference<"mutation">
    }
  }
}
const modulesApi = moduleApi.cms.modules

function makeTest() {
  return convexTest(schema, modules)
}

const owner = {
  subject: "modules-owner",
  tokenIdentifier: "https://issuer.test|modules-owner",
  email: "owner@example.test",
}
const unrelated = {
  subject: "modules-unrelated",
  tokenIdentifier: "https://issuer.test|modules-unrelated",
  email: "unrelated@example.test",
}
const successor = {
  subject: "modules-successor",
  tokenIdentifier: "https://issuer.test|modules-successor",
  email: "successor@example.test",
}

async function withResendApiKey<T>(
  apiKey: string | undefined,
  run: () => Promise<T>
): Promise<T> {
  const previous = process.env.RESEND_API_KEY
  if (apiKey === undefined) delete process.env.RESEND_API_KEY
  else process.env.RESEND_API_KEY = apiKey

  try {
    return await run()
  } finally {
    if (previous === undefined) delete process.env.RESEND_API_KEY
    else process.env.RESEND_API_KEY = previous
  }
}

async function makeOwnerTest() {
  const t = makeTest()
  await t.run((ctx) =>
    ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: owner.subject,
      tokenIdentifier: owner.tokenIdentifier,
      establishedAt: 1,
      updatedAt: 1,
    })
  )
  return t
}

function moduleState(
  snapshot: Awaited<ReturnType<typeof resolveEffectiveModuleState>>,
  moduleId: string
) {
  const state = snapshot.modules.find((module) => module.moduleId === moduleId)
  if (!state) throw new Error(`Missing resolved module "${moduleId}".`)
  return state
}

async function insertState(
  t: ReturnType<typeof makeTest>,
  overrides: Partial<{
    configurationVersion: number
    enabledModules: Array<{ moduleId: string; configVersion: number }>
  }> = {}
) {
  await t.run((ctx) =>
    ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: overrides.configurationVersion ?? 1,
      enabledModules: overrides.enabledModules ?? [],
    })
  )
}

describe("F07a persisted module state and effective resolver", () => {
  test("uses fresh defaults: Email needs setup while required modules stay active and redirects is disabled", async () => {
    await withResendApiKey(undefined, async () => {
      const t = makeTest()
      const snapshot = await t.run((ctx) => resolveEffectiveModuleState(ctx))

      expect(snapshot.configurationVersion).toBe(0)
      expect(snapshot.modules).toHaveLength(MODULE_CATALOG.length)
      for (const descriptor of MODULE_CATALOG.filter(
        (module) => module.required && module.id !== "email"
      )) {
        expect(moduleState(snapshot, descriptor.id)).toMatchObject({
          available: true,
          enabled: true,
          effective: true,
          readiness: "ready",
          setup: "not_required",
        })
      }
      expect(moduleState(snapshot, "email")).toMatchObject({
        available: true,
        enabled: true,
        effective: true,
        readiness: "needs_setup",
        setup: "required",
      })
      expect(moduleState(snapshot, "redirects")).toMatchObject({
        available: true,
        enabled: false,
        effective: false,
        readiness: "ready",
        setup: "not_required",
      })
    })
  })

  test("keeps legacy provider rows non-ready migration input", async () => {
    await withResendApiKey(undefined, async () => {
      const t = makeTest()
      const emailSettingsId = await t.run((ctx) =>
        ctx.db.insert("emailSettings", {
          provider: "console",
          schemaVersion: 1,
          updatedAt: 1,
        })
      )
      expect(
        moduleState(
          await t.run((ctx) => resolveEffectiveModuleState(ctx)),
          "email"
        )
      ).toMatchObject({
        enabled: true,
        effective: true,
        readiness: "needs_setup",
        setup: "required",
      })

      await t.run((ctx) =>
        ctx.db.patch(emailSettingsId, {
          provider: "smtp",
          smtpHost: "smtp.example.test",
        })
      )
      expect(
        moduleState(
          await t.run((ctx) => resolveEffectiveModuleState(ctx)),
          "email"
        )
      ).toMatchObject({
        enabled: true,
        effective: true,
        readiness: "needs_setup",
        setup: "required",
      })
    })
  })

  test("reports ready only for an active Resend provider with current environment readiness", async () => {
    await withResendApiKey("resend-key-sentinel", async () => {
      const t = await makeOwnerTest()
      await t.run((ctx) =>
        ctx.db.insert("emailProviderState", {
          key: "owner",
          provider: {
            kind: "active",
            providerId: "resend",
            configuration: {},
          },
          sender: { address: "sender@example.test" },
          configurationVersion: 1,
          updatedAt: 1,
        })
      )
      const preview = await t.withIdentity(owner).query(modulesApi.preview, {
        changes: [],
      })
      const email = preview.readiness.find(
        (module: { moduleId: string }) => module.moduleId === "email"
      )!

      expect(email).toEqual({
        moduleId: "email",
        available: true,
        enabled: true,
        effective: true,
        readiness: "ready",
        setup: "not_required",
      })
      expect(JSON.stringify(email)).not.toContain("resend-key-sentinel")
    })
  })

  test("fails closed for duplicate Email settings rows", async () => {
    await withResendApiKey(undefined, async () => {
      const t = makeTest()
      await t.run(async (ctx) => {
        await ctx.db.insert("emailSettings", {
          provider: "console",
          schemaVersion: 1,
          updatedAt: 1,
        })
        await ctx.db.insert("emailSettings", {
          provider: "console",
          schemaVersion: 1,
          updatedAt: 2,
        })
      })

      await expect(
        t.run((ctx) => resolveEffectiveModuleState(ctx))
      ).rejects.toThrow("CMS_EMAIL_PROVIDER_MIGRATION_SOURCE_INVALID")
    })
  })

  test("reloads a persisted owner choice at its current catalog config version", async () => {
    const t = makeTest()
    const redirects = MODULE_CATALOG.find(
      (module) => module.id === "redirects"
    )!
    await insertState(t, {
      configurationVersion: 7,
      enabledModules: [
        { moduleId: redirects.id, configVersion: redirects.configVersion },
      ],
    })

    const firstRead = await t.run((ctx) => resolveEffectiveModuleState(ctx))
    const reloaded = await t.run((ctx) => resolveEffectiveModuleState(ctx))

    expect(reloaded).toEqual(firstRead)
    expect(reloaded.configurationVersion).toBe(7)
    expect(moduleState(reloaded, "redirects")).toMatchObject({
      enabled: true,
      effective: true,
    })
  })

  test.each([
    {
      name: "unknown module IDs",
      enabledModules: [{ moduleId: "unknown-module", configVersion: 1 }],
    },
    {
      name: "unsupported module config versions",
      enabledModules: [{ moduleId: "redirects", configVersion: 999 }],
    },
    {
      name: "required module entries",
      enabledModules: [{ moduleId: "system", configVersion: 1 }],
    },
    {
      name: "duplicate module entries",
      enabledModules: [
        { moduleId: "redirects", configVersion: 1 },
        { moduleId: "redirects", configVersion: 1 },
      ],
    },
    {
      name: "invalid monotonic configuration versions",
      configurationVersion: -1,
    },
  ])(
    "fails closed for $name",
    async ({ configurationVersion, enabledModules }) => {
      const t = makeTest()
      await insertState(t, { configurationVersion, enabledModules })

      await expect(
        t.run((ctx) => resolveEffectiveModuleState(ctx))
      ).rejects.toThrow("CMS_MODULE_STATE_INVALID")
    }
  )

  test("fails closed rather than choosing between duplicate owner rows", async () => {
    const t = makeTest()
    await insertState(t)
    await insertState(t, { configurationVersion: 2 })

    await expect(
      t.run((ctx) => resolveEffectiveModuleState(ctx))
    ).rejects.toThrow("CMS_MODULE_STATE_INVALID")
  })
})

describe("F07b owner module lifecycle APIs", () => {
  test("previews exact changes and persists an owner-reviewed enablement", async () => {
    await withResendApiKey(undefined, async () => {
      const t = await makeOwnerTest()
      const asOwner = t.withIdentity(owner)
      const changes = [{ moduleId: "redirects", enabled: true }]

      const preview = await asOwner.query(modulesApi.preview, { changes })
      expect(preview).toMatchObject({
        configurationVersion: 0,
        changes: [
          { moduleId: "redirects", fromEnabled: false, toEnabled: true },
        ],
        requiredDependencies: ["owner-access", "publication", "system"],
        blockers: [],
      })
      expect(preview.readiness).toContainEqual(
        expect.objectContaining({
          moduleId: "redirects",
          enabled: true,
          effective: true,
          readiness: "ready",
        })
      )
      expect(preview.readiness).toContainEqual(
        expect.objectContaining({
          moduleId: "email",
          enabled: true,
          effective: true,
          readiness: "needs_setup",
          setup: "required",
        })
      )

      const committed = await asOwner.mutation(modulesApi.commit, {
        expectedConfigurationVersion: preview.configurationVersion,
        changes,
      })
      expect(committed).toMatchObject({
        committed: true,
        configurationVersion: 1,
      })
      expect(committed.readiness).toContainEqual(
        expect.objectContaining({
          moduleId: "email",
          enabled: true,
          effective: true,
          readiness: "needs_setup",
          setup: "required",
        })
      )
      expect(
        moduleState(
          await t.run((ctx) => resolveEffectiveModuleState(ctx)),
          "redirects"
        )
      ).toMatchObject({ enabled: true, effective: true })
    })
  })

  test("does not advance the revision for a repeated current no-op request", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    await asOwner.mutation(modulesApi.commit, {
      expectedConfigurationVersion: 0,
      changes: [{ moduleId: "redirects", enabled: true }],
    })

    const repeated = await asOwner.mutation(modulesApi.commit, {
      expectedConfigurationVersion: 1,
      changes: [{ moduleId: "redirects", enabled: true }],
    })
    expect(repeated).toMatchObject({
      committed: false,
      configurationVersion: 1,
      changes: [],
    })
  })

  test("allows only the durable owner to preview or commit", async () => {
    const t = await makeOwnerTest()
    const asUnrelated = t.withIdentity(unrelated)

    await expect(t.query(modulesApi.preview, { changes: [] })).rejects.toThrow(
      "UNAUTHENTICATED"
    )
    await expect(
      t.mutation(modulesApi.commit, {
        expectedConfigurationVersion: 0,
        changes: [],
      })
    ).rejects.toThrow("UNAUTHENTICATED")
    await expect(
      asUnrelated.query(modulesApi.preview, { changes: [] })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      asUnrelated.mutation(modulesApi.commit, {
        expectedConfigurationVersion: 0,
        changes: [],
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

  test("rechecks the durable binding after owner replacement", async () => {
    const t = await makeOwnerTest()
    await t.run(async (ctx) => {
      const ownerState = await readOwnerState(ctx)
      if (ownerState.status !== "ready") {
        throw new Error("Expected a durable owner before replacement.")
      }
      await replaceOwnerBinding(ctx, ownerState.owner, {
        authId: successor.subject,
        tokenIdentifier: successor.tokenIdentifier,
        email: successor.email,
      })
    })

    await expect(
      t.withIdentity(owner).mutation(modulesApi.commit, {
        expectedConfigurationVersion: 0,
        changes: [{ moduleId: "redirects", enabled: true }],
      })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
    await expect(
      t.withIdentity(successor).mutation(modulesApi.commit, {
        expectedConfigurationVersion: 0,
        changes: [{ moduleId: "redirects", enabled: true }],
      })
    ).resolves.toMatchObject({ committed: true, configurationVersion: 1 })
  })

  test("rejects a stale competing commit and preserves the winner's persisted state", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    const changes = [{ moduleId: "redirects", enabled: true }]

    const [first, second] = await Promise.allSettled([
      asOwner.mutation(modulesApi.commit, {
        expectedConfigurationVersion: 0,
        changes,
      }),
      asOwner.mutation(modulesApi.commit, {
        expectedConfigurationVersion: 0,
        changes,
      }),
    ])

    expect(
      [first, second].filter((result) => result.status === "fulfilled")
    ).toHaveLength(1)
    const rejected = [first, second].find(
      (result): result is PromiseRejectedResult => result.status === "rejected"
    )
    expect(rejected).toBeDefined()
    expect(String(rejected!.reason)).toContain("CMS_MODULE_CONFIGURATION_STALE")
    expect(
      await t.run((ctx) => resolveEffectiveModuleState(ctx))
    ).toMatchObject({ configurationVersion: 1 })
    expect(
      moduleState(
        await t.run((ctx) => resolveEffectiveModuleState(ctx)),
        "redirects"
      )
    ).toMatchObject({ enabled: true, effective: true })
  })

  test("rejects stale or invalid transitions without changing persisted state", async () => {
    const t = await makeOwnerTest()
    const asOwner = t.withIdentity(owner)
    await expect(
      asOwner.mutation(modulesApi.commit, {
        expectedConfigurationVersion: 0,
        changes: [{ moduleId: "redirects", enabled: true }],
      })
    ).resolves.toMatchObject({ committed: true })
    await expect(
      asOwner.mutation(modulesApi.commit, {
        expectedConfigurationVersion: 0,
        changes: [{ moduleId: "redirects", enabled: false }],
      })
    ).rejects.toThrow("CMS_MODULE_CONFIGURATION_STALE")
    await expect(
      asOwner.query(modulesApi.preview, {
        changes: [{ moduleId: "not-installed", enabled: true }],
      })
    ).rejects.toThrow("CMS_MODULE_TRANSITION_INVALID")
    await expect(
      asOwner.query(modulesApi.preview, {
        changes: [
          { moduleId: "redirects", enabled: false },
          { moduleId: "redirects", enabled: true },
        ],
      })
    ).rejects.toThrow("CMS_MODULE_TRANSITION_INVALID")
    await expect(
      asOwner.mutation(modulesApi.commit, {
        expectedConfigurationVersion: 1,
        changes: [{ moduleId: "system", enabled: false }],
      })
    ).rejects.toThrow("CMS_MODULE_TRANSITION_BLOCKED")
    expect(
      await t.run((ctx) => resolveEffectiveModuleState(ctx))
    ).toMatchObject({ configurationVersion: 1 })
  })
})

describe("S1 committed visibility query", () => {
  test("owner-only, optional-only and independent of preview drafts", async () => {
    const t = await makeOwnerTest()
    await expect(t.query(api.cms.modules.effective, {})).rejects.toThrow()
    await expect(
      t.withIdentity(unrelated).query(api.cms.modules.effective, {})
    ).rejects.toThrow()
    const ownerClient = t.withIdentity(owner)
    expect(await ownerClient.query(api.cms.modules.effective, {})).toEqual({
      version: 0,
      modules: [
        { id: "redirects", outcome: "off" },
        { id: "multilingual", outcome: "off" },
        { id: "ai", outcome: "off" },
      ],
    })
    await ownerClient.query(modulesApi.preview, {
      changes: [{ moduleId: "redirects", enabled: true }],
    })
    expect(
      (await ownerClient.query(api.cms.modules.effective, {})).modules[0]
        ?.outcome
    ).toBe("off")
    await insertState(t, {
      configurationVersion: 3,
      enabledModules: [
        { moduleId: "redirects", configVersion: 1 },
        { moduleId: "multilingual", configVersion: 1 },
      ],
    })
    expect(await ownerClient.query(api.cms.modules.effective, {})).toEqual({
      version: 3,
      modules: [
        { id: "redirects", outcome: "on" },
        { id: "multilingual", outcome: "on" },
        { id: "ai", outcome: "off" },
      ],
    })
    await expect(
      ownerClient.mutation(modulesApi.commit, {
        expectedConfigurationVersion: 2,
        changes: [{ moduleId: "redirects", enabled: false }],
      })
    ).rejects.toThrow()
    expect(
      (await ownerClient.query(api.cms.modules.effective, {})).version
    ).toBe(3)
  })

  test("invalid shared state throws instead of reporting off", async () => {
    const t = await makeOwnerTest()
    await insertState(t, { configurationVersion: -1 })
    await expect(
      t.withIdentity(owner).query(api.cms.modules.effective, {})
    ).rejects.toThrow("CMS_MODULE_STATE_INVALID")
  })
})

// Required readiness remains fail-closed in preview, but cannot poison visibility.
test("S1 effective skips corrupt required Email facts while preview still refuses", async () => {
  const t = await makeOwnerTest()
  await t.run(async (ctx) => {
    for (const updatedAt of [1, 2])
      await ctx.db.insert("emailSettings", {
        provider: "console",
        schemaVersion: 1,
        updatedAt,
      })
  })
  await expect(
    t.withIdentity(owner).query(modulesApi.preview, { changes: [] })
  ).rejects.toThrow("CMS_EMAIL_PROVIDER_MIGRATION_SOURCE_INVALID")
  expect(
    (await t.withIdentity(owner).query(api.cms.modules.effective, {})).modules
  ).toHaveLength(3)
})

test("S1 query isolates provider errors and sanitizes setup, while preview refuses the same throw", async () => {
  const t = await makeOwnerTest()
  await insertState(t, {
    enabledModules: [
      { moduleId: "redirects", configVersion: 1 },
      { moduleId: "multilingual", configVersion: 1 },
    ],
  })
  const signal = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    readinessTest.fail = true
    expect(
      (await t.withIdentity(owner).query(api.cms.modules.effective, {})).modules
    ).toEqual([
      { id: "redirects", outcome: "on" },
      {
        id: "multilingual",
        outcome: "error",
        errorCode: "CMS_MODULE_READINESS_FAILED",
      },
      { id: "ai", outcome: "off" },
    ])
    await expect(
      t.withIdentity(owner).query(modulesApi.preview, { changes: [] })
    ).rejects.toThrow("optional readiness failed")
    expect(signal).toHaveBeenCalledTimes(1)
    readinessTest.fail = false
    readinessTest.setup = true
    expect(
      (await t.withIdentity(owner).query(api.cms.modules.effective, {}))
        .modules[1]
    ).toEqual({
      id: "multilingual",
      outcome: "needs_setup",
      setup: ["required"],
    })
  } finally {
    readinessTest.fail = false
    readinessTest.setup = false
    signal.mockRestore()
  }
})

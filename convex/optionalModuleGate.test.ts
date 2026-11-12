/// <reference types="vite/client" />

import { describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import { MODULE_CATALOG } from "../lib/modules/catalog"
import type { ModuleDescriptorV1 } from "../lib/modules/types"
import {
  createOptionalModuleGate,
  requireOwnerAndOptionalModule as requireInstalledOwnerAndModule,
  type ModuleReadinessProvider,
  type OptionalModuleGateOptions,
} from "./lib/modules/state"
import schema from "./schema"

// Step 1 of the AI release plan: the module-state gate MECHANISM, proven with
// test-only catalog entries. S2a also installs the real AI descriptor; these
// fixtures still exercise provider injection independently of that module.
const modules = import.meta.glob("./**/*.ts")

const OWNER = {
  subject: "gate-owner",
  tokenIdentifier: "https://convex.test|gate-owner",
  email: "gate-owner@example.com",
}
const STRANGER = {
  subject: "gate-stranger",
  tokenIdentifier: "https://convex.test|gate-stranger",
  email: "gate-stranger@example.com",
}

function fake(
  id: string,
  dependencies: readonly string[] = ["system", "owner-access"]
): ModuleDescriptorV1 {
  return {
    id,
    name: id,
    summary: "Test-only optional module.",
    descriptorVersion: 1,
    configVersion: 1,
    required: false,
    dependencies,
    environments: ["server"],
    contributions: [],
  }
}

// `fake-plain` declares no readiness provider; `fake-setup` has an injected one.
const catalog = [
  ...MODULE_CATALOG,
  fake("fake-plain"),
  fake("fake-setup"),
  fake("fake-child", ["fake-plain"]),
]
let readiness: "ready" | "needs_setup" = "ready"
const setupProvider: ModuleReadinessProvider = async () =>
  readiness === "ready"
    ? { readiness: "ready", setup: "not_required" }
    : { readiness: "needs_setup", setup: "required" }
// The test instance is built through the factory; production callers only get
// the installed-catalog functions, which take no catalog or provider options.
const testGate = createOptionalModuleGate({
  catalog,
  readinessProviders: new Map([["fake-setup", setupProvider]]),
})
const { requireOwnerAndOptionalModule, resolveOptionalModuleGuardState } =
  testGate
const baseOptions: OptionalModuleGateOptions = {}

function app() {
  return convexTest({ schema, modules, ownerIdentity: OWNER })
}
type App = ReturnType<typeof app>

async function seedState(t: App, enabled: readonly string[]) {
  await t.run(async (ctx) => {
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: enabled.map((moduleId) => ({
        moduleId,
        configVersion: 1,
      })),
    })
  })
}

async function ownerSite(enabled: readonly string[]) {
  const t = app()
  await seedCommunityOwner(t, OWNER)
  await seedState(t, enabled)
  return t
}

async function codeOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ConvexError) return error.data
    throw error
  }
  return "ALLOWED"
}

function gate(
  t: App,
  moduleId: string,
  options: OptionalModuleGateOptions = baseOptions,
  identity: typeof OWNER | null = OWNER,
  requireGate: typeof requireOwnerAndOptionalModule = requireOwnerAndOptionalModule
) {
  const caller = identity ? t.withIdentity(identity) : t
  return codeOf(caller.run((ctx) => requireGate(ctx, moduleId, options)))
}

describe("requireOwnerAndOptionalModule (fake catalog entries)", () => {
  test("owner + module enabled -> allowed, and returns the owner principal", async () => {
    const t = await ownerSite(["fake-plain"])
    expect(await gate(t, "fake-plain")).toBe("ALLOWED")
    const principal = await t
      .withIdentity(OWNER)
      .run((ctx) =>
        requireOwnerAndOptionalModule(ctx, "fake-plain", baseOptions)
      )
    expect(principal).toMatchObject({ authId: OWNER.subject, role: "admin" })
  })

  test("module off -> CMS_MODULE_DISABLED, including a fresh install with no state row", async () => {
    const enabledOther = await ownerSite(["fake-setup"])
    expect(await gate(enabledOther, "fake-plain")).toBe("CMS_MODULE_DISABLED")

    const fresh = app()
    await seedCommunityOwner(fresh, OWNER)
    expect(await gate(fresh, "fake-plain")).toBe("CMS_MODULE_DISABLED")
  })

  test("enabled module whose dependency is not effective -> CMS_MODULE_DISABLED", async () => {
    const t = await ownerSite(["fake-child"])
    expect(await gate(t, "fake-child")).toBe("CMS_MODULE_DISABLED")
    const both = await ownerSite(["fake-plain", "fake-child"])
    expect(await gate(both, "fake-child")).toBe("ALLOWED")
  })

  test("readiness module not ready -> CMS_MODULE_NOT_READY; allowed once ready", async () => {
    const t = await ownerSite(["fake-setup"])
    readiness = "needs_setup"
    try {
      expect(await gate(t, "fake-setup")).toBe("CMS_MODULE_NOT_READY")
      // The module's own setup entry may opt out of the readiness requirement.
      expect(
        await gate(t, "fake-setup", { ...baseOptions, requireReady: false })
      ).toBe("ALLOWED")
      // Off still wins over the opt-out.
      const off = await ownerSite([])
      expect(
        await gate(off, "fake-setup", { ...baseOptions, requireReady: false })
      ).toBe("CMS_MODULE_DISABLED")
    } finally {
      readiness = "ready"
    }
    expect(await gate(t, "fake-setup")).toBe("ALLOWED")
  })

  test("guard state reports readiness for a readiness module (the GuardedModuleId gap)", async () => {
    const t = await ownerSite(["fake-setup"])
    readiness = "needs_setup"
    try {
      const state = await t.run((ctx) =>
        resolveOptionalModuleGuardState(ctx, "fake-setup")
      )
      expect(state).toEqual({
        moduleId: "fake-setup",
        effective: true,
        readiness: "needs_setup",
        setup: "required",
      })
    } finally {
      readiness = "ready"
    }
  })

  test("unknown or required module id fails closed with CMS_MODULE_STATE_INVALID", async () => {
    const t = await ownerSite(["fake-plain"])
    for (const moduleId of ["fake-missing", "ai-runtime", "system", ""]) {
      expect(await gate(t, moduleId), moduleId).toBe("CMS_MODULE_STATE_INVALID")
    }
  })

  test("persisted state naming a module outside the catalog fails closed, never disabled", async () => {
    const t = await ownerSite(["fake-plain", "fake-gone"])
    expect(await gate(t, "fake-plain")).toBe("CMS_MODULE_STATE_INVALID")
  })

  test("not signed in -> UNAUTHENTICATED; non-owner -> CMS_OWNER_REQUIRED; before any module fact", async () => {
    const enabled = await ownerSite(["fake-plain"])
    expect(await gate(enabled, "fake-plain", baseOptions, null)).toBe(
      "UNAUTHENTICATED"
    )
    expect(await gate(enabled, "fake-plain", baseOptions, STRANGER)).toBe(
      "CMS_OWNER_REQUIRED"
    )
    // Owner failure wins over module state: a stranger learns nothing about it.
    const off = await ownerSite([])
    expect(await gate(off, "fake-plain", baseOptions, STRANGER)).toBe(
      "CMS_OWNER_REQUIRED"
    )
    expect(await gate(off, "fake-plain", baseOptions, null)).toBe(
      "UNAUTHENTICATED"
    )
    // Even an unknown id reports the owner failure first.
    expect(await gate(off, "fake-missing", baseOptions, STRANGER)).toBe(
      "CMS_OWNER_REQUIRED"
    )
  })

  test("no owner established -> CMS_OWNER_NOT_ESTABLISHED", async () => {
    const t = app()
    await seedState(t, ["fake-plain"])
    expect(await gate(t, "fake-plain")).toBe("CMS_OWNER_NOT_ESTABLISHED")
  })
})

// The production export: built over the installed catalog and providers.
function installed(t: App, moduleId: string) {
  return gate(t, moduleId, {}, OWNER, requireInstalledOwnerAndModule)
}

describe("createOptionalModuleGate (the injection seam is the factory)", () => {
  test("an instance only sees its own catalog and providers", async () => {
    const t = await ownerSite(["fake-plain"])
    // The installed gate does not know the test-only module: fail closed.
    expect(await installed(t, "fake-plain")).toBe("CMS_MODULE_STATE_INVALID")
    expect(await gate(t, "fake-plain")).toBe("ALLOWED")
  })

  test("readiness comes only from the instance's own providers", async () => {
    const noProviders = createOptionalModuleGate({
      catalog,
      readinessProviders: new Map(),
    })
    const t = await ownerSite(["fake-setup"])
    readiness = "needs_setup"
    try {
      // No provider registered for fake-setup: nothing reports it unready.
      expect(
        await gate(
          t,
          "fake-setup",
          {},
          OWNER,
          noProviders.requireOwnerAndOptionalModule
        )
      ).toBe("ALLOWED")
      expect(await gate(t, "fake-setup")).toBe("CMS_MODULE_NOT_READY")
    } finally {
      readiness = "ready"
    }
  })

  test("an invalid catalog fails when the instance is built", () => {
    expect(() =>
      createOptionalModuleGate({
        catalog: [fake("fake-plain"), fake("fake-plain")],
        readinessProviders: new Map(),
      })
    ).toThrow()
  })

  test("the production gate takes no catalog or provider options", () => {
    // A bypass would need a type error to be written; keep it a compile-time fact.
    const asOptions = (options: OptionalModuleGateOptions) => options
    // @ts-expect-error catalog is not a production option
    asOptions({ catalog })
    // @ts-expect-error readinessProviders is not a production option
    asOptions({ readinessProviders: new Map() })
    expect(asOptions({ requireReady: false })).toEqual({ requireReady: false })
  })
})

describe("requireOwnerAndOptionalModule (installed catalog and providers)", () => {
  test("redirects: off -> disabled, owner-enabled through the real commit -> allowed", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await seedCommunityOwner(t, OWNER)
    expect(await installed(t, "redirects")).toBe("CMS_MODULE_DISABLED")
    await enableRedirectsForTest(owner)
    expect(await installed(t, "redirects")).toBe("ALLOWED")
  })

  test("multilingual (a readiness module in the installed set): off -> disabled", async () => {
    const t = app()
    await seedCommunityOwner(t, OWNER)
    expect(await installed(t, "multilingual")).toBe("CMS_MODULE_DISABLED")
  })

  test("required installed modules (email, language) are not gateable", async () => {
    const t = app()
    await seedCommunityOwner(t, OWNER)
    for (const moduleId of ["email", "language", "system"]) {
      expect(await installed(t, moduleId), moduleId).toBe(
        "CMS_MODULE_STATE_INVALID"
      )
    }
  })
})

describe("S1 effective-readiness isolation", () => {
  test("off and required win; one provider throw preserves its siblings and emits a signal", async () => {
    const {
      resolveEffectiveReadiness,
      resolveEffectiveModuleStateFromEnabled,
    } = await import("./lib/modules/state")
    const t = app()
    const calls: string[] = []
    const providers = new Map<string, ModuleReadinessProvider>([
      [
        "email",
        async () => {
          calls.push("email")
          throw new Error("required must not run")
        },
      ],
      [
        "fake-plain",
        async () => {
          calls.push("fake-plain")
          throw new Error("off must not run")
        },
      ],
      [
        "fake-setup",
        async () => {
          calls.push("fake-setup")
          throw new Error("setup provider failed")
        },
      ],
      [
        "redirects",
        async () => {
          calls.push("redirects")
          return { readiness: "ready", setup: "not_required" }
        },
      ],
      [
        "multilingual",
        async () => {
          calls.push("multilingual")
          return { readiness: "needs_setup", setup: "required" }
        },
      ],
    ])
    const snapshot = resolveEffectiveModuleStateFromEnabled(
      7,
      new Set(["fake-setup", "redirects", "multilingual"]),
      new Map(),
      catalog
    )
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    try {
      const result = await t.run(async (ctx) => {
        const isolated = await resolveEffectiveReadiness(
          ctx,
          snapshot,
          catalog,
          providers
        )
        return {
          readiness: [...isolated.readiness],
          failures: [...isolated.failures],
        }
      })
      expect(calls.toSorted()).toEqual([
        "fake-setup",
        "multilingual",
        "redirects",
      ])
      expect(result.failures).toEqual(["fake-setup"])
      expect(new Map(result.readiness).get("redirects")?.readiness).toBe(
        "ready"
      )
      expect(new Map(result.readiness).get("multilingual")).toEqual({
        readiness: "needs_setup",
        setup: "required",
      })
      expect(signal).toHaveBeenCalledWith(
        expect.stringContaining(
          "module=fake-setup boundary=admin.effective-readiness"
        ),
        expect.objectContaining({ cause: "setup provider failed" })
      )
      const guard = createOptionalModuleGate({
        catalog,
        readinessProviders: providers,
      })
      const enabled = await ownerSite(["fake-setup"])
      await expect(
        enabled
          .withIdentity(OWNER)
          .run((ctx) => guard.requireOwnerAndOptionalModule(ctx, "fake-setup"))
      ).rejects.toThrow("setup provider failed")
      expect(signal).toHaveBeenCalledTimes(1)
    } finally {
      signal.mockRestore()
    }
  })
})

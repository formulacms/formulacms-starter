import { ConvexError } from "convex/values"
import { convexTest } from "convex-test"
import { expect } from "vitest"
import actionRetrierTest from "@convex-dev/action-retrier/test"
import betterAuthTest from "@convex-dev/better-auth/test"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import schema from "../../convex/schema"

export type ModuleMap = Record<string, () => Promise<unknown>>
export function makeSite(modules: ModuleMap) {
  const t = convexTest(schema, modules)
  actionRetrierTest.register(t)
  betterAuthTest.register(t)
  rateLimiterTest.register(t)
  return t
}
export type Site = ReturnType<typeof makeSite>
export type CallTarget = Pick<Site, "query" | "mutation" | "action">
export type Actor = ReturnType<Site["withIdentity"]>
export type FunctionKind = "query" | "mutation" | "action"

export const FORMER = {
  subject: "matrix-former-owner",
  tokenIdentifier: "https://convex.test|matrix-former-owner",
}
export const OWNER = {
  subject: "matrix-current-owner",
  tokenIdentifier: "https://convex.test|matrix-current-owner",
}
export const UNRELATED = {
  subject: "matrix-unrelated",
  tokenIdentifier: "https://convex.test|matrix-unrelated",
}

export type MatrixState = {
  redirects: "off" | "on"
  language: "F09" | "M05"
}
export const MATRIX_STATES: readonly MatrixState[] = [
  { redirects: "off", language: "F09" },
  { redirects: "on", language: "F09" },
  { redirects: "off", language: "M05" },
  { redirects: "on", language: "M05" },
]
export function stateLabel(state: MatrixState): string {
  return `redirects-${state.redirects}/${state.language}`
}

/** Valid F09 or owner-activated M05 authority and Redirects module state. */
export async function setupModuleLanguageState(
  t: Site,
  state: MatrixState,
): Promise<{ languageVersion: number }> {
  await t.run(async (ctx) => {
    const locales = state.language === "M05" ? ["en", "fr"] : ["en"]
    await ctx.db.insert("siteSettings", {
      siteName: "Authorization matrix site",
      siteUrl: "https://example.test",
      defaultLocale: "en",
      enabledLocales: locales,
      updatedAt: 1,
    })
    await ctx.db.insert("siteLanguageAuthority", {
      key: "site-language-v1",
      version: 1,
      currentLocale: "en",
      ...(state.language === "M05"
        ? { mode: "multilingual" as const, enabledLocales: locales }
        : {}),
      updatedAt: 1,
    })
    await ctx.db.insert("pagePublicationCutover", {
      key: "published-snapshot-v1",
      phase: "legacy",
      revision: 1,
      updatedAt: 1,
    })
    const enabledModules = [
      ...(state.redirects === "on" ? [{ moduleId: "redirects", configVersion: 1 }] : []),
      ...(state.language === "M05" ? [{ moduleId: "multilingual", configVersion: 1 }] : []),
    ]
    if (enabledModules.length) {
      await ctx.db.insert("cmsModuleState", {
        key: "owner",
        configurationVersion: 1,
        enabledModules,
      })
    }
  })
  return { languageVersion: 1 }
}

/** S4 authority shape with the required active snapshot publication cutover. */
export async function setupSnapshotActiveS4(
  t: Site,
  redirects: "off" | "on",
): Promise<{ languageVersion: number }> {
  const result = await setupModuleLanguageState(t, {
    redirects,
    language: "M05",
  })
  await t.run(async (ctx) => {
    const cutover = await ctx.db.query("pagePublicationCutover").unique()
    await ctx.db.patch(cutover!._id, { phase: "snapshot_active", revision: 2 })
  })
  return result
}

export type Outcome =
  | { error: string }
  | { value: unknown }
  | { check: (value: unknown) => void }
type IdentityOutcomes = {
  owner: Outcome
  signedOut: Outcome
  unrelated: Outcome
  former: Outcome
}

type Actors = {
  owner: Actor
  signedOut: Site
  unrelated: Actor
  former: Actor
}

export type Scenario<Fixture> = {
  label: string
  setup: (t: Site, actors: Actors) => Promise<Fixture>
  call: (actor: CallTarget, fixture: Fixture) => Promise<unknown>
  outcomes: IdentityOutcomes | ((fixture: Fixture) => IdentityOutcomes)
  /** A successful read must also preserve every app and writable system table. */
  readOnly?: boolean
  /** Verify the owner effect when the return value alone cannot prove it. */
  after?: (t: Site, fixture: Fixture) => Promise<void>
  /** Restore row-local env or mocks even when an expectation fails. */
  teardown?: (t: Site, fixture: Fixture) => Promise<void>
}

export type AuthorizationRow = {
  name: string
  kind: FunctionKind
  scenarioLabels: readonly string[]
  run: (modules: ModuleMap) => Promise<void>
}

export async function seedReplacedOwner(t: Site): Promise<void> {
  await t.run(async (ctx) => {
    const ownerId = await ctx.db.insert("cmsOwner", {
      key: "owner",
      authId: FORMER.subject,
      tokenIdentifier: FORMER.tokenIdentifier,
      establishedAt: 1,
      updatedAt: 1,
    })
    await ctx.db.patch(ownerId, {
      authId: OWNER.subject,
      tokenIdentifier: OWNER.tokenIdentifier,
      updatedAt: 2,
    })
  })
}

/** Includes all 90 schema tables and both writable Convex system tables. */
export async function snapshotAllWritableTables(t: Site) {
  return t.run(async (ctx) => {
    const snapshot: Record<string, unknown> = {}
    for (const table of Object.keys(schema.tables) as Array<keyof typeof schema.tables & string>) {
      snapshot[table] = await ctx.db.query(table).collect()
    }
    snapshot._scheduled_functions = await ctx.db.system.query("_scheduled_functions").collect()
    snapshot._storage = await ctx.db.system.query("_storage").collect()
    return snapshot
  })
}

async function assertOutcome(
  t: Site,
  run: () => Promise<unknown>,
  expected: Outcome,
  readOnly: boolean,
): Promise<void> {
  const unchanged = "error" in expected || readOnly
  const before = unchanged ? await snapshotAllWritableTables(t) : null
  if ("error" in expected) {
    let thrown: unknown
    try {
      await run()
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(ConvexError)
    expect((thrown as ConvexError<string>).data).toBe(expected.error)
  } else if ("value" in expected) {
    await expect(run()).resolves.toEqual(expected.value)
  } else {
    expected.check(await run())
  }
  if (unchanged) {
    expect(await snapshotAllWritableTables(t)).toEqual(before)
  }
}

/**
 * A row exists only when it carries executable identity cases. The central
 * suite checks these rows against independently imported registrations.
 */
export function defineRow<Fixture>(config: {
  name: string
  kind: FunctionKind
  scenarios: readonly Scenario<Fixture>[]
  requiredScenarioLabels?: readonly string[]
}): AuthorizationRow {
  if (config.scenarios.length === 0) {
    throw new Error(`Authorization row has no scenarios: ${config.name}`)
  }
  const labels = config.scenarios.map(({ label }) => label)
  if (new Set(labels).size !== labels.length) {
    throw new Error(`Authorization row repeats a scenario: ${config.name}`)
  }
  for (const state of MATRIX_STATES) {
    if (!labels.includes(stateLabel(state))) {
      throw new Error(`Authorization row lacks ${stateLabel(state)}: ${config.name}`)
    }
  }
  if (
    (config.name.startsWith("cms/language:") ||
      config.name.startsWith("cms/languageLifecycle:") ||
      config.name.startsWith("cms/multilingual:")) &&
    (!config.requiredScenarioLabels ||
      !["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"]
        .every((label) => config.requiredScenarioLabels!.includes(label)))
  ) {
    throw new Error(`M05 lifecycle row lacks snapshot-active S4 state: ${config.name}`)
  }
  for (const required of config.requiredScenarioLabels ?? []) {
    if (!labels.includes(required)) {
      throw new Error(`Authorization row lacks ${required}: ${config.name}`)
    }
  }
  return {
    name: config.name,
    kind: config.kind,
    scenarioLabels: labels,
    run: async (modules) => {
      for (const scenario of config.scenarios) {
        const t = makeSite(modules)
        await seedReplacedOwner(t)
        const actors: Actors = {
          owner: t.withIdentity(OWNER),
          signedOut: t,
          unrelated: t.withIdentity(UNRELATED),
          former: t.withIdentity(FORMER),
        }
        const fixture = await scenario.setup(t, actors)
        try {
          const outcomes = typeof scenario.outcomes === "function"
            ? scenario.outcomes(fixture)
            : scenario.outcomes
          for (const identity of ["signedOut", "unrelated", "former", "owner"] as const) {
            const outcome = outcomes[identity]
            if (!outcome || !("error" in outcome || "value" in outcome || "check" in outcome)) {
              throw new Error(`Authorization outcome missing: ${config.name}/${scenario.label}/${identity}`)
            }
          }
          for (const identity of ["signedOut", "unrelated", "former", "owner"] as const) {
            await assertOutcome(
              t,
              () => scenario.call(actors[identity], fixture),
              outcomes[identity],
              scenario.readOnly ?? config.kind === "query",
            )
          }
          await scenario.after?.(t, fixture)
        } finally {
          await scenario.teardown?.(t, fixture)
        }
      }
    },
  }
}

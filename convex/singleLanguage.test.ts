/// <reference types="vite/client" />

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { api, internal } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"
import { convexTest } from "../convexTestWithExplicitAdmin"
import {
  activateLanguageTransitionInTransaction,
  languageCarrySeam,
  runLanguageTransitionStep,
} from "./cms/language"
import { digestCarryDecisionCorpus } from "./lib/language/carryDecisionDigest"
import { readCurrentSnapshotProjection } from "./lib/publishing/snapshots"
import schema from "./schema"

// F09a proof: rows 1, 2, 4, 5, 6, 8, 9, 12, 28, 31, 34, 36, 37 and the F09a
// parts of 7, 10 and 11 of the F09 single-language contract proof map.
// F09c F1 adds the Convex activation/readiness parts of rows 3, 4, 7, 13–19,
// 24–26, 29, 32 and 33. Public reader/routing/cache parts remain F2.

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "f09a-owner",
  tokenIdentifier: "https://convex.test|f09a-owner",
}
const STRANGER = {
  subject: "f09a-stranger",
  tokenIdentifier: "https://convex.test|f09a-stranger",
}

type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>
type Mode = "correct_label" | "replace_content"
type ActivationArgs = Parameters<
  typeof activateLanguageTransitionInTransaction
>[1]

const KIB = 1024
const MIB = KIB * KIB
const CARRY_METRICS = [
  "databaseQueries",
  "documentsRead",
  "documentsWritten",
  "functionsScheduled",
  "bytesRead",
  "bytesWritten",
  "scheduledFunctionArgsBytes",
] as const
type CarryMetrics = Record<(typeof CARRY_METRICS)[number], number>

async function usedCarryMetrics(ctx: MutationCtx): Promise<CarryMetrics> {
  const metrics = await ctx.meta.getTransactionMetrics()
  return Object.fromEntries(
    CARRY_METRICS.map((key) => [key, metrics[key].used])
  ) as CarryMetrics
}

function app(publicationAuthority: "legacy" | "missing" = "missing") {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority,
  })
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise
  } catch (error) {
    if (error instanceof ConvexError) return String(error.data)
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error("expected the call to be refused")
}

async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers)
}

async function bootstrap(t: T, owner: Caller, locale = "en") {
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "F09a site",
    timezone: "UTC",
    defaultLocale: locale,
  })
  const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
  return settings!.homePageId!
}

async function createPage(owner: Caller, slug: string, locale = "en") {
  return owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    content: { [locale]: { title: slug, slices: [] } },
  })
}

async function generations(t: T, pageId: Id<"pages">, locale: string) {
  return t.run(async (ctx) => ({
    state: await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique(),
    shared: await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique(),
    page: await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique(),
  }))
}

async function publish(
  t: T,
  owner: Caller,
  pageId: Id<"pages">,
  locale = "en"
) {
  const { state, shared, page } = await generations(t, pageId, locale)
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration: state!.draftGeneration,
    expectedSharedDraftGeneration: shared!.generation,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
    expectedReleaseGeneration: state!.releaseGeneration,
  })
}

async function saveDraft(
  t: T,
  owner: Caller,
  pageId: Id<"pages">,
  locale: string,
  slug: string,
  title: string
) {
  const { state, page } = await generations(t, pageId, locale)
  return owner.mutation(api.cms.publication.saveLocaleDraft, {
    pageId,
    locale,
    slug,
    draft: {
      pageType: "landing-page",
      localized: { title },
      slices: [],
    } as never,
    expectedDraftGeneration: state?.draftGeneration ?? 0,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
  })
}

async function englishSite(t: T, owner: Caller, slugs: string[] = ["about"]) {
  const homeId = await bootstrap(t, owner)
  await publish(t, owner, homeId)
  const ids: Record<string, Id<"pages">> = {}
  for (const slug of slugs) {
    ids[slug] = await createPage(owner, slug)
    await publish(t, owner, ids[slug])
  }
  return { homeId, ids }
}

async function startTransition(
  t: T,
  owner: Caller,
  mode: Mode,
  target: string
) {
  // `first()`: refusal tests deliberately seed duplicate authority rows.
  const { settings, authority } = await t.run(async (ctx) => ({
    settings: await ctx.db.query("siteSettings").first(),
    authority: await ctx.db.query("siteLanguageAuthority").first(),
  }))
  return owner.mutation(api.cms.language.startLanguageTransition, {
    mode,
    sourceLocale: settings!.defaultLocale,
    targetLocale: target,
    expectedSettingsUpdatedAt: settings!.updatedAt,
    expectedAuthorityVersion: authority?.version ?? 0,
  })
}

async function transitionOf(t: T, id: Id<"siteLanguageTransitions">) {
  const transition = await t.run((ctx) => ctx.db.get(id))
  if (!transition) throw new Error("transition missing")
  return transition
}

async function rowOf(
  t: T,
  id: Id<"siteLanguageTransitions">,
  pageId: Id<"pages">
) {
  return t.run((ctx) =>
    ctx.db
      .query("siteLanguageTransitionPages")
      .withIndex("by_transitionId_and_pageId", (q) =>
        q.eq("transitionId", id).eq("pageId", pageId)
      )
      .unique()
  )
}

async function publicProjection(t: T, pageId: Id<"pages">, locale: string) {
  return t.run((ctx) => readCurrentSnapshotProjection(ctx, pageId, locale))
}

async function languageTables(t: T) {
  return t.run(async (ctx) => ({
    settings: await ctx.db.query("siteSettings").collect(),
    authority: await ctx.db.query("siteLanguageAuthority").collect(),
    transitions: await ctx.db.query("siteLanguageTransitions").collect(),
    pages: await ctx.db.query("siteLanguageTransitionPages").collect(),
    routes: await ctx.db.query("siteLanguageTransitionRoutes").collect(),
  }))
}

async function confirmAndValidate(
  t: T,
  owner: Caller,
  id: Id<"siteLanguageTransitions">
) {
  const before = await transitionOf(t, id)
  await owner.mutation(api.cms.language.confirmTransitionPreview, {
    transitionId: id,
    expectedPreparedSetVersion: before.preparedSetVersion,
  })
  const confirmed = await transitionOf(t, id)
  await owner.mutation(api.cms.language.validateLanguageTransition, {
    transitionId: id,
    expectedGeneration: confirmed.generation,
  })
  await drain(t)
  return transitionOf(t, id)
}

async function activationArgs(
  t: T,
  id: Id<"siteLanguageTransitions">
): Promise<ActivationArgs> {
  const { transition, settings, authority } = await t.run(async (ctx) => ({
    transition: await ctx.db.get(id),
    settings: await ctx.db.query("siteSettings").unique(),
    authority: await ctx.db.query("siteLanguageAuthority").unique(),
  }))
  if (!transition?.manifest || !settings || !authority) {
    throw new Error("activation fixture is not ready")
  }
  return {
    transitionId: id,
    expectedGeneration: transition.generation,
    expectedAuthorityVersion: authority.version,
    expectedSettingsUpdatedAt: settings.updatedAt,
    expectedReadinessVersion: transition.manifest.readinessVersion,
  }
}

async function activate(
  t: T,
  owner: Caller,
  id: Id<"siteLanguageTransitions">
) {
  return owner.mutation(
    api.cms.language.activateLanguageTransition,
    await activationArgs(t, id)
  )
}

async function readyCorrection(
  t: T,
  owner: Caller,
  slugs: string[] = ["about"]
) {
  const site = await englishSite(t, owner, slugs)
  const id = await startTransition(t, owner, "correct_label", "fr")
  await drain(t)
  const ready = await confirmAndValidate(t, owner, id)
  if (ready.phase !== "ready")
    throw new Error("transition did not become ready")
  return { ...site, id, ready }
}

type PointedRouteInput = {
  key: string
  fromPath: string
  pageId: Id<"pages">
  locale?: string
  retired?: boolean
}

async function seedPointedContinuity(
  t: T,
  rows: PointedRouteInput[]
): Promise<Record<string, Id<"siteDefaultLanguageRoutes">>> {
  return t.run(async (ctx) => {
    const installationOwner = await ctx.db.query("cmsOwner").unique()
    const authority = await ctx.db.query("siteLanguageAuthority").unique()
    if (!installationOwner || !authority) throw new Error("fixture incomplete")
    const migrationId = await ctx.db.insert("siteDefaultLanguageMigrations", {
      fromLocale: "de",
      toLocale: "en",
      phase: "committed",
      generation: 1,
      captured: {
        authorityVersion: authority.version,
        moduleConfigurationVersion: 1,
        site: { routeClaimVersion: 0, publicationSetVersion: 0 },
        from: { routeClaimVersion: 0, publicationSetVersion: 0 },
        to: { routeClaimVersion: 0, publicationSetVersion: 0 },
      },
      counts: {
        rows: rows.length,
        shadowedByCurrent: 0,
        shadowedByHistorical: 0,
        manualRulesShadowed: 0,
        manualRulesShifted: 0,
        manualRulesUnprefixed: 0,
        carriedShadowedSkipped: 0,
        blockers: 0,
      },
      disclosurePageCount: 0,
      reviewedThroughOrdinal: -1,
      attribution: {
        kind: "owner",
        ownerId: installationOwner._id,
        authId: OWNER.subject,
        tokenIdentifier: OWNER.tokenIdentifier,
      },
      createdAt: 1,
      updatedAt: 1,
    })
    const routeIds: Record<string, Id<"siteDefaultLanguageRoutes">> = {}
    for (const [index, row] of rows.entries()) {
      routeIds[row.key] = await ctx.db.insert("siteDefaultLanguageRoutes", {
        migrationId,
        generation: 1,
        fromPath: row.fromPath,
        pageId: row.pageId,
        locale: row.locale ?? "en",
        origin: "old_default_current",
        ...(row.retired
          ? {
              retiredAt: 100 + index,
              retiredReason: "to_current" as const,
            }
          : {}),
        createdAt: 10 + index,
      })
    }
    await ctx.db.patch(authority._id, {
      continuityPointer: { migrationId, generation: 1 },
    })
    return routeIds
  })
}

async function driveTransitionUntil(
  t: T,
  transitionId: Id<"siteLanguageTransitions">,
  predicate: (transition: Awaited<ReturnType<typeof transitionOf>>) => boolean
) {
  for (let guard = 0; guard < 80; guard += 1) {
    const transition = await transitionOf(t, transitionId)
    if (predicate(transition)) return transition
    await t.mutation(internal.cms.language.stepLanguageTransition, {
      transitionId,
      generation: transition.generation,
    })
  }
  throw new Error("transition did not reach the requested state")
}

async function measureCarrySteps(
  t: T,
  transitionId: Id<"siteLanguageTransitions">,
  done: (transition: Awaited<ReturnType<typeof transitionOf>>) => boolean
) {
  const paginate = vi.spyOn(languageCarrySeam, "paginate")
  const steps: Array<{
    cursorPhase: string | undefined
    part: string
    paginated: number
    used: CarryMetrics
  }> = []
  try {
    for (let guard = 0; guard < 40; guard += 1) {
      const transition = await transitionOf(t, transitionId)
      if (done(transition)) return steps
      const cursor = transition.cursor ? JSON.parse(transition.cursor) : {}
      const before = paginate.mock.calls.length
      const used = await t.run(async (ctx) => {
        await runLanguageTransitionStep(
          ctx,
          transitionId,
          transition.generation
        )
        return usedCarryMetrics(ctx)
      })
      steps.push({
        cursorPhase: transition.cursorPhase,
        part: typeof cursor.part === "string" ? cursor.part : "decide",
        paginated: paginate.mock.calls.length - before,
        used,
      })
    }
  } finally {
    paginate.mockRestore()
  }
  throw new Error("carry phase did not complete")
}

async function freshCarryCoverageFixture() {
  const t = app()
  const owner = t.withIdentity(OWNER)
  const { ids } = await englishSite(t, owner, ["carry", "other"])
  const routeIds = await seedPointedContinuity(t, [
    {
      key: "carry",
      fromPath: "/legacy-carry",
      pageId: ids.carry!,
    },
  ])
  const transitionId = await startTransition(t, owner, "replace_content", "fr")
  await driveTransitionUntil(
    t,
    transitionId,
    (transition) => transition.cursorPhase === "carried_routes"
  )
  await t.run(async (ctx) => {
    const row = await ctx.db
      .query("siteLanguageTransitionPages")
      .withIndex("by_transitionId_and_pageId", (q) =>
        q.eq("transitionId", transitionId).eq("pageId", ids.carry!)
      )
      .unique()
    const transition = await ctx.db.get(transitionId)
    await ctx.db.patch(row!._id, { disposition: "target", status: "ready" })
    await ctx.db.patch(transitionId, {
      targetCount: transition!.targetCount + 1,
      unresolvedCount: transition!.unresolvedCount - 1,
    })
  })
  await driveTransitionUntil(
    t,
    transitionId,
    (transition) => transition.cursorPhase === "carry_coverage"
  )
  return { t, owner, ids, routeId: routeIds.carry!, transitionId }
}

async function preparedPointedReplacementFixture(routeCount = 1) {
  const t = app()
  const owner = t.withIdentity(OWNER)
  const homeId = await bootstrap(t, owner)
  await publish(t, owner, homeId)
  await seedPointedContinuity(
    t,
    Array.from({ length: routeCount }, (_, index) => ({
      key: `route-${index}`,
      fromPath: `/legacy-${String(index).padStart(2, "0")}`,
      pageId: homeId,
    }))
  )
  const transitionId = await startTransition(t, owner, "replace_content", "fr")
  await driveTransitionUntil(
    t,
    transitionId,
    (transition) =>
      transition.phase === "preparing" &&
      transition.cursorPhase === undefined &&
      transition.carryDecisionDigest !== undefined
  )

  let row = (await rowOf(t, transitionId, homeId))!
  await owner.mutation(api.cms.language.setPageDisposition, {
    transitionId,
    pageId: homeId,
    disposition: "target",
    expectedPageGeneration: row.generation,
  })
  await owner.mutation(api.cms.language.copySourceToTargetDraft, {
    transitionId,
    pageId: homeId,
    expectedSourceDraftGeneration: (await generations(t, homeId, "en")).state!
      .draftGeneration,
    expectedLifecycleGeneration: 1,
  })
  row = (await rowOf(t, transitionId, homeId))!
  const target = (await generations(t, homeId, "fr")).state!
  const shared = (await generations(t, homeId, "en")).shared!
  await owner.mutation(api.cms.language.confirmTargetContent, {
    transitionId,
    pageId: homeId,
    expectedTargetDraftGeneration: target.draftGeneration,
    expectedSharedDraftGeneration: shared.generation,
    expectedPageGeneration: row.generation,
  })
  row = (await rowOf(t, transitionId, homeId))!
  await owner.mutation(api.cms.language.prepareTargetPage, {
    transitionId,
    pageId: homeId,
    expectedPageGeneration: row.generation,
  })
  const covered = await driveTransitionUntil(
    t,
    transitionId,
    (transition) =>
      transition.phase === "preparing" && transition.cursorPhase === undefined
  )
  return { t, owner, homeId, transitionId, covered }
}

async function readyPointedReplacementFixture(routeCount = 1) {
  const fixture = await preparedPointedReplacementFixture(routeCount)
  await fixture.owner.mutation(api.cms.language.confirmTransitionPreview, {
    transitionId: fixture.transitionId,
    expectedPreparedSetVersion: fixture.covered.preparedSetVersion,
    expectedCarryDecisionDigest: fixture.covered.carryDecisionDigest,
  })
  const confirmed = await transitionOf(fixture.t, fixture.transitionId)
  await fixture.owner.mutation(api.cms.language.validateLanguageTransition, {
    transitionId: fixture.transitionId,
    expectedGeneration: confirmed.generation,
  })
  const ready = await driveTransitionUntil(
    fixture.t,
    fixture.transitionId,
    (transition) => transition.phase === "ready"
  )
  return { ...fixture, ready }
}

async function runCoverageStep(
  t: T,
  transitionId: Id<"siteLanguageTransitions">
) {
  const transition = await transitionOf(t, transitionId)
  return t.run((ctx) =>
    runLanguageTransitionStep(ctx, transitionId, transition.generation)
  )
}

describe("M05 P24 carry conversion and reconciliation (C3e.2)", () => {
  test("pointed carried_routes records the five initial outcomes and skips an already-retired row", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner, [
      "carry",
      "claimed",
      "duplicate",
      "disposition",
      "locale",
      "retired",
    ])
    const routeIds = await seedPointedContinuity(t, [
      {
        key: "carry",
        fromPath: "/legacy-carry",
        pageId: ids.carry!,
      },
      {
        key: "claimed",
        fromPath: "/claimed",
        pageId: ids.claimed!,
      },
      {
        key: "duplicate",
        fromPath: "/legacy-duplicate",
        pageId: ids.duplicate!,
      },
      {
        key: "disposition",
        fromPath: "/legacy-disposition",
        pageId: ids.disposition!,
      },
      {
        key: "locale",
        fromPath: "/legacy-locale",
        pageId: ids.locale!,
        locale: "de",
      },
      {
        key: "retired",
        fromPath: "/legacy-retired",
        pageId: ids.retired!,
        retired: true,
      },
    ])
    await t.run(async (ctx) => {
      const pointed = await ctx.db.get(routeIds.carry!)
      await ctx.db.insert("siteDefaultLanguageRoutes", {
        migrationId: pointed!.migrationId,
        generation: 2,
        fromPath: "/wrong-generation",
        pageId: ids.carry!,
        locale: "en",
        origin: "old_default_current",
        createdAt: 99,
      })
    })
    const transitionId = await startTransition(
      t,
      owner,
      "replace_content",
      "fr"
    )
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === "carried_routes"
    )
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect()
      for (const row of rows) {
        if (row.pageId === ids.disposition!) continue
        await ctx.db.patch(row._id, { disposition: "target", status: "ready" })
      }
      await ctx.db.insert("siteLanguageTransitionRoutes", {
        transitionId,
        fromPath: "/legacy-duplicate",
        pageId: ids.carry!,
        origin: "source_historical",
        createdAt: 50,
      })
    })

    const converted = await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.phase === "preparing" && transition.cursorPhase === undefined
    )
    const stored = await t.run(async (ctx) => ({
      decisions: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect(),
      routes: await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect(),
    }))

    expect(
      Object.fromEntries(
        stored.decisions.map((decision) => [
          decision.fromPath,
          decision.outcome,
        ])
      )
    ).toEqual({
      "/legacy-carry": "carry",
      "/claimed": "drop_claimed",
      "/legacy-duplicate": "drop_duplicate",
      "/legacy-disposition": "drop_disposition",
      "/legacy-locale": "drop_locale",
    })
    expect(stored.decisions).toHaveLength(5)
    expect(
      stored.decisions.find(
        (decision) => decision.fromPath === "/wrong-generation"
      )
    ).toBeUndefined()
    expect(
      stored.decisions.find((decision) => decision.routeId === routeIds.retired)
    ).toBeUndefined()
    expect(stored.decisions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          capturedSourcePublicSetVersion: 0,
          capturedCarryInputVersion: 0,
          capturedCarryDecisionGeneration: 0,
        }),
      ])
    )
    expect(converted.carryDecisionGeneration ?? 0).toBe(0)
    expect(converted.carryDecisionDigest).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(converted.carryDecisionDigest).toBe(
      await digestCarryDecisionCorpus(stored.decisions)
    )
    expect(
      stored.routes.map(({ fromPath, pageId, origin }) => ({
        fromPath,
        pageId,
        origin,
      }))
    ).toEqual(
      expect.arrayContaining([
        {
          fromPath: "/legacy-carry",
          pageId: ids.carry!,
          origin: "carried",
        },
        {
          fromPath: "/legacy-duplicate",
          pageId: ids.carry!,
          origin: "source_historical",
        },
      ])
    )
    expect(
      stored.routes.filter((route) => route.origin === "carried")
    ).toHaveLength(1)
  })

  test("carry_reconcile flips a decision and deletes only its exact owned route", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner, ["carry"])
    await seedPointedContinuity(t, [
      {
        key: "carry",
        fromPath: "/legacy-carry",
        pageId: ids.carry!,
      },
    ])
    const transitionId = await startTransition(
      t,
      owner,
      "replace_content",
      "fr"
    )
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === "carried_routes"
    )
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId).eq("pageId", ids.carry!)
        )
        .unique()
      const transition = await ctx.db.get(transitionId)
      await ctx.db.patch(row!._id, { disposition: "target", status: "ready" })
      await ctx.db.patch(transitionId, {
        targetCount: transition!.targetCount + 1,
        unresolvedCount: transition!.unresolvedCount - 1,
      })
    })
    const converted = await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.phase === "preparing" && transition.cursorPhase === undefined
    )
    const firstDigest = converted.carryDecisionDigest!
    expect(converted.carryDecisionGeneration ?? 0).toBe(0)

    const row = (await rowOf(t, transitionId, ids.carry!))!
    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId,
      pageId: ids.carry!,
      disposition: "withdraw",
      expectedPageGeneration: row.generation,
    })
    const armed = await transitionOf(t, transitionId)
    expect(armed).toMatchObject({
      phase: "preparing",
      cursorPhase: "carry_reconcile",
      carryInputVersion: 1,
    })
    expect(armed.carryDecisionGeneration ?? 0).toBe(0)
    await t.run(async (ctx) => {
      for (const [index, origin] of (
        [
          "source_current",
          "source_historical",
          "carried",
          "redirect_disposition",
        ] as const
      ).entries()) {
        await ctx.db.insert("siteLanguageTransitionRoutes", {
          transitionId,
          fromPath: `/unrelated-${origin}`,
          pageId: ids.carry!,
          origin,
          createdAt: 99 + index,
        })
      }
    })

    const reconciled = await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.phase === "preparing" &&
        transition.cursorPhase === undefined &&
        transition.carryDecisionGeneration === 1
    )
    const stored = await t.run(async (ctx) => ({
      decision: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transitionId).eq("fromPath", "/legacy-carry")
        )
        .unique(),
      routes: await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId).eq("pageId", ids.carry!)
        )
        .collect(),
    }))
    expect(stored.decision).toMatchObject({
      outcome: "drop_disposition",
      capturedSourcePublicSetVersion: 0,
      capturedCarryInputVersion: 1,
      capturedCarryDecisionGeneration: 1,
    })
    expect(reconciled.carryDecisionDigest).not.toBe(firstDigest)
    expect(
      stored.routes.map(({ fromPath, origin }) => ({ fromPath, origin }))
    ).toEqual(
      expect.arrayContaining([
        { fromPath: "/unrelated-source_current", origin: "source_current" },
        {
          fromPath: "/unrelated-source_historical",
          origin: "source_historical",
        },
        { fromPath: "/unrelated-carried", origin: "carried" },
        {
          fromPath: "/unrelated-redirect_disposition",
          origin: "redirect_disposition",
        },
      ])
    )
    expect(stored.routes).toHaveLength(4)

    const beforeConfirmation = await transitionOf(t, transitionId)
    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId,
      expectedPreparedSetVersion: beforeConfirmation.preparedSetVersion,
      expectedCarryDecisionDigest: beforeConfirmation.carryDecisionDigest,
    })
    const confirmed = await transitionOf(t, transitionId)
    expect(confirmed).toMatchObject({
      carryInputVersion: beforeConfirmation.carryInputVersion,
      carryDecisionGeneration: beforeConfirmation.carryDecisionGeneration,
      carryDecisionDigest: beforeConfirmation.carryDecisionDigest,
      previewConfirmedCarryDecisionDigest:
        beforeConfirmation.carryDecisionDigest,
    })
    expect(confirmed.cursorPhase).toBeUndefined()

    const withdrawn = (await rowOf(t, transitionId, ids.carry!))!
    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId,
      pageId: ids.carry!,
      disposition: "target",
      expectedPageGeneration: withdrawn.generation,
    })
    const restored = await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.cursorPhase === undefined &&
        transition.carryDecisionGeneration === 2
    )
    const redecided = await t.run(async (ctx) => ({
      decision: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transitionId).eq("fromPath", "/legacy-carry")
        )
        .unique(),
      routes: await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId).eq("pageId", ids.carry!)
        )
        .collect(),
    }))
    expect(redecided.decision).toMatchObject({
      outcome: "carry",
      capturedCarryInputVersion: 2,
      capturedCarryDecisionGeneration: 2,
    })
    expect(restored.carryDecisionDigest).not.toBe(
      reconciled.carryDecisionDigest
    )
    expect(
      redecided.routes.map(({ fromPath, origin }) => ({ fromPath, origin }))
    ).toEqual(
      expect.arrayContaining([
        { fromPath: "/legacy-carry", origin: "carried" },
        { fromPath: "/unrelated-source_current", origin: "source_current" },
        {
          fromPath: "/unrelated-source_historical",
          origin: "source_historical",
        },
        { fromPath: "/unrelated-carried", origin: "carried" },
        {
          fromPath: "/unrelated-redirect_disposition",
          origin: "redirect_disposition",
        },
      ])
    )
    expect(redecided.routes).toHaveLength(5)
  })

  test("a carried row retired by publication becomes terminal across withdrawal", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner, ["carry", "claimer", "stable"])
    await saveDraft(
      t,
      owner,
      ids.claimer!,
      "en",
      "legacy-carry",
      "Claiming page"
    )
    const routeIds = await seedPointedContinuity(t, [
      {
        key: "carry",
        fromPath: "/legacy-carry",
        pageId: ids.carry!,
      },
      {
        key: "stable",
        fromPath: "/legacy-stable",
        pageId: ids.stable!,
      },
    ])
    const transitionId = await startTransition(
      t,
      owner,
      "replace_content",
      "fr"
    )
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === "carried_routes"
    )
    await t.run(async (ctx) => {
      const rows = await Promise.all(
        [ids.carry!, ids.stable!].map((pageId) =>
          ctx.db
            .query("siteLanguageTransitionPages")
            .withIndex("by_transitionId_and_pageId", (q) =>
              q.eq("transitionId", transitionId).eq("pageId", pageId)
            )
            .unique()
        )
      )
      const transition = await ctx.db.get(transitionId)
      for (const row of rows) {
        await ctx.db.patch(row!._id, {
          disposition: "target",
          status: "ready",
        })
      }
      await ctx.db.patch(transitionId, {
        targetCount: transition!.targetCount + 2,
        unresolvedCount: transition!.unresolvedCount - 2,
      })
    })
    const converted = await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.phase === "preparing" && transition.cursorPhase === undefined
    )
    expect(converted.carryDecisionGeneration ?? 0).toBe(0)

    await publish(t, owner, ids.claimer!)
    expect(await transitionOf(t, transitionId)).toMatchObject({
      cursorPhase: "carry_reconcile",
      sourcePublicSetVersion: 1,
    })
    const retired = await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.cursorPhase === undefined &&
        transition.carryDecisionGeneration === 1
    )
    const afterRetirement = await t.run(async (ctx) => ({
      decision: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId).eq("routeId", routeIds.carry!)
        )
        .unique(),
      pointed: await ctx.db.get(routeIds.carry!),
      owned: await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transitionId).eq("fromPath", "/legacy-carry")
        )
        .collect(),
    }))
    expect(afterRetirement.pointed).toMatchObject({
      retiredReason: "to_current",
    })
    expect(afterRetirement.decision).toMatchObject({
      outcome: "drop_retired",
      capturedSourcePublicSetVersion: 1,
      capturedCarryDecisionGeneration: 1,
    })
    expect(afterRetirement.owned).toEqual([])

    const claimerState = (await generations(t, ids.claimer!, "en")).state!
    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: ids.claimer!,
      locale: "en",
      expectedSnapshotId: claimerState.currentSnapshotId!,
      expectedPublicGeneration: claimerState.publicGeneration,
      expectedLifecycleGeneration: 1,
    })
    expect(await transitionOf(t, transitionId)).toMatchObject({
      cursorPhase: "carry_reconcile",
      sourcePublicSetVersion: 2,
    })
    const afterWithdrawal = await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.cursorPhase === undefined &&
        transition.carryDecisionGeneration === 2
    )
    const decisions = await t.run(async (ctx) => ({
      terminal: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId).eq("routeId", routeIds.carry!)
        )
        .unique(),
      stable: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId).eq("routeId", routeIds.stable!)
        )
        .unique(),
    }))
    expect(decisions.terminal).toEqual(afterRetirement.decision)
    expect(decisions.stable).toMatchObject({
      outcome: "carry",
      capturedSourcePublicSetVersion: 2,
      capturedCarryDecisionGeneration: 2,
    })
    expect(afterWithdrawal).toMatchObject({
      carryDecisionGeneration: 2,
    })
    expect(afterWithdrawal.carryDecisionDigest).not.toBe(
      retired.carryDecisionDigest
    )

    await saveDraft(
      t,
      owner,
      ids.claimer!,
      "en",
      "legacy-stable",
      "Second claiming path"
    )
    await publish(t, owner, ids.claimer!)
    const allRetired = await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.cursorPhase === undefined &&
        transition.carryDecisionGeneration === 3
    )
    const terminalCorpus = await t.run((ctx) =>
      ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect()
    )
    expect(terminalCorpus).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          routeId: routeIds.carry!,
          outcome: "drop_retired",
        }),
        expect.objectContaining({
          routeId: routeIds.stable!,
          outcome: "drop_retired",
          capturedSourcePublicSetVersion: allRetired.sourcePublicSetVersion,
          capturedCarryDecisionGeneration: 3,
        }),
      ])
    )

    const secondClaimerState = (await generations(t, ids.claimer!, "en")).state!
    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: ids.claimer!,
      locale: "en",
      expectedSnapshotId: secondClaimerState.currentSnapshotId!,
      expectedPublicGeneration: secondClaimerState.publicGeneration,
      expectedLifecycleGeneration: 1,
    })
    const terminalOnly = await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === undefined
    )
    expect(terminalOnly).toMatchObject({
      sourcePublicSetVersion: allRetired.sourcePublicSetVersion + 1,
      carryDecisionGeneration: 3,
      carryDecisionDigest: allRetired.carryDecisionDigest,
    })
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect()
      )
    ).toEqual(terminalCorpus)
  })

  test("the no-pointer path still carries the last committed F09 routes without decisions", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids, id: first } = await readyCorrection(t, owner)
    await activate(t, owner, first)
    await t.run((ctx) =>
      ctx.db.insert("siteLanguageTransitionRoutes", {
        transitionId: first,
        fromPath: "/legacy-f09",
        pageId: ids.about!,
        origin: "carried",
        createdAt: 100,
      })
    )
    const authority = await t.run((ctx) =>
      ctx.db.query("siteLanguageAuthority").unique()
    )
    expect(authority?.continuityPointer).toBeUndefined()
    const second = await startTransition(t, owner, "correct_label", "nl")
    const carrying = await driveTransitionUntil(
      t,
      second,
      (transition) => transition.cursorPhase === "carried_routes"
    )
    await t.mutation(internal.cms.language.stepLanguageTransition, {
      transitionId: second,
      generation: carrying.generation,
    })
    const stored = await t.run(async (ctx) => ({
      transition: await ctx.db.get(second),
      authority: await ctx.db.query("siteLanguageAuthority").unique(),
      page: await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", second).eq("pageId", ids.about!)
        )
        .unique(),
      decisions: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", second)
        )
        .collect(),
      routes: await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", second).eq("fromPath", "/legacy-f09")
        )
        .collect(),
    }))
    expect(stored.transition).toMatchObject({ phase: "preparing" })
    expect(stored.page).toMatchObject({ disposition: "target" })
    expect(stored.transition?.carryDecisionDigest).toBeUndefined()
    expect(stored.decisions).toEqual([])
    expect(stored.routes).toEqual([
      expect.objectContaining({
        pageId: ids.about!,
        origin: "carried",
      }),
    ])
  })
})

describe("M05 P24 carry coverage (C3e.3a)", () => {
  test("conversion enters bounded coverage for fresh carry, drop and skipped retired rows", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner, [
      "carry",
      "disposition",
      "retired",
    ])
    const routeIds = await seedPointedContinuity(t, [
      {
        key: "carry",
        fromPath: "/legacy-carry",
        pageId: ids.carry!,
      },
      {
        key: "disposition",
        fromPath: "/legacy-disposition",
        pageId: ids.disposition!,
      },
      {
        key: "retired",
        fromPath: "/legacy-retired",
        pageId: ids.retired!,
        retired: true,
      },
    ])
    const transitionId = await startTransition(
      t,
      owner,
      "replace_content",
      "fr"
    )
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === "carried_routes"
    )
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId).eq("pageId", ids.carry!)
        )
        .unique()
      const transition = await ctx.db.get(transitionId)
      await ctx.db.patch(row!._id, { disposition: "target", status: "ready" })
      await ctx.db.patch(transitionId, {
        targetCount: transition!.targetCount + 1,
        unresolvedCount: transition!.unresolvedCount - 1,
      })
    })

    const covering = await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === "carry_coverage"
    )
    expect(covering).toMatchObject({
      phase: "preparing",
      cursorPhase: "carry_coverage",
    })
    const completed = await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === undefined
    )
    expect(completed.phase).toBe("preparing")
    expect(
      await t.run(async (ctx) => ({
        carry: await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId).eq("routeId", routeIds.carry!)
          )
          .unique(),
        disposition: await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q
              .eq("transitionId", transitionId)
              .eq("routeId", routeIds.disposition!)
          )
          .unique(),
        retired: await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId).eq("routeId", routeIds.retired!)
          )
          .unique(),
      }))
    ).toEqual({
      carry: expect.objectContaining({ outcome: "carry" }),
      disposition: expect.objectContaining({ outcome: "drop_disposition" }),
      retired: null,
    })
  })

  test("missing, duplicate, stale, wrong-transition and malformed decisions fail closed", async () => {
    for (const corruption of [
      "missing",
      "duplicate",
      "stale_source",
      "stale_input",
      "stale_generation",
      "live_drop_retired",
      "wrong_transition",
      "wrong_path",
    ] as const) {
      const { t, routeId, transitionId } = await freshCarryCoverageFixture()
      const before = await transitionOf(t, transitionId)
      await t.run(async (ctx) => {
        const decision = await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId).eq("routeId", routeId)
          )
          .unique()
        if (!decision) throw new Error("decision missing")
        if (corruption === "missing") {
          await ctx.db.delete(decision._id)
        } else if (corruption === "duplicate") {
          const { _id, _creationTime, ...fields } = decision
          void _id
          void _creationTime
          await ctx.db.insert("siteLanguageCarryDecisions", fields)
        } else if (corruption === "stale_source") {
          await ctx.db.patch(transitionId, {
            sourcePublicSetVersion: before.sourcePublicSetVersion + 1,
          })
        } else if (corruption === "stale_input") {
          await ctx.db.patch(transitionId, {
            carryInputVersion: (before.carryInputVersion ?? 0) + 1,
          })
        } else if (corruption === "stale_generation") {
          await ctx.db.patch(transitionId, {
            carryDecisionGeneration: (before.carryDecisionGeneration ?? 0) + 1,
          })
        } else if (corruption === "live_drop_retired") {
          const route = await ctx.db
            .query("siteLanguageTransitionRoutes")
            .withIndex("by_transitionId_and_fromPath", (q) =>
              q.eq("transitionId", transitionId).eq("fromPath", "/legacy-carry")
            )
            .unique()
          await ctx.db.patch(decision._id, { outcome: "drop_retired" })
          await ctx.db.delete(route!._id)
        } else if (corruption === "wrong_transition") {
          const transition = await ctx.db.get(transitionId)
          if (!transition) throw new Error("transition missing")
          const { _id, _creationTime, ...fields } = transition
          void _id
          void _creationTime
          const otherId = await ctx.db.insert("siteLanguageTransitions", {
            ...fields,
            phase: "cancelled",
            cursorPhase: undefined,
            cursor: undefined,
            cancelledAt: Date.now(),
          })
          await ctx.db.patch(decision._id, { transitionId: otherId })
        } else {
          await ctx.db.patch(decision._id, { fromPath: "/wrong-path" })
        }
      })

      expect({
        corruption,
        code: await codeOf(runCoverageStep(t, transitionId)),
      }).toEqual({
        corruption,
        code: "LANGUAGE_TRANSITION_STATE_INVALID",
      })
      expect(await transitionOf(t, transitionId)).toMatchObject({
        cursorPhase: "carry_coverage",
        cursor: before.cursor,
      })
    }
  })

  test("missing, duplicate, excess, wrong-page and wrong-origin carried routes fail closed", async () => {
    for (const corruption of [
      "missing",
      "duplicate",
      "excess",
      "wrong_page",
      "wrong_origin",
      "drop_has_owned",
      "drop_excess",
    ] as const) {
      const { t, ids, routeId, transitionId } =
        await freshCarryCoverageFixture()
      const before = await transitionOf(t, transitionId)
      await t.run(async (ctx) => {
        const route = await ctx.db
          .query("siteLanguageTransitionRoutes")
          .withIndex("by_transitionId_and_fromPath", (q) =>
            q.eq("transitionId", transitionId).eq("fromPath", "/legacy-carry")
          )
          .unique()
        if (!route) throw new Error("owned route missing")
        if (corruption === "missing") {
          await ctx.db.delete(route._id)
        } else if (corruption === "duplicate") {
          const { _id, _creationTime, ...fields } = route
          void _id
          void _creationTime
          await ctx.db.insert("siteLanguageTransitionRoutes", fields)
        } else if (corruption === "excess") {
          await ctx.db.insert("siteLanguageTransitionRoutes", {
            transitionId,
            fromPath: route.fromPath,
            pageId: ids.other!,
            origin: "source_current",
            createdAt: Date.now(),
          })
        } else if (corruption === "wrong_page") {
          await ctx.db.patch(route._id, { pageId: ids.other! })
        } else if (corruption === "wrong_origin") {
          await ctx.db.patch(route._id, { origin: "source_current" })
        } else if (corruption === "drop_has_owned") {
          const decision = await ctx.db
            .query("siteLanguageCarryDecisions")
            .withIndex("by_transitionId_and_routeId", (q) =>
              q.eq("transitionId", transitionId).eq("routeId", routeId)
            )
            .unique()
          await ctx.db.patch(decision!._id, { outcome: "drop_disposition" })
        } else {
          const decision = await ctx.db
            .query("siteLanguageCarryDecisions")
            .withIndex("by_transitionId_and_routeId", (q) =>
              q.eq("transitionId", transitionId).eq("routeId", routeId)
            )
            .unique()
          await ctx.db.patch(decision!._id, { outcome: "drop_duplicate" })
          await ctx.db.delete(route._id)
          for (const origin of [
            "source_current",
            "source_historical",
          ] as const) {
            await ctx.db.insert("siteLanguageTransitionRoutes", {
              transitionId,
              fromPath: route.fromPath,
              pageId: ids.other!,
              origin,
              createdAt: Date.now(),
            })
          }
        }
      })

      expect({
        corruption,
        code: await codeOf(runCoverageStep(t, transitionId)),
      }).toEqual({
        corruption,
        code: "LANGUAGE_TRANSITION_STATE_INVALID",
      })
      expect(await transitionOf(t, transitionId)).toMatchObject({
        cursorPhase: "carry_coverage",
        cursor: before.cursor,
      })
    }
  })

  test("duplicate fromPath rows fail closed across coverage pages", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner, ["first", "second"])
    const routeIds = await seedPointedContinuity(
      t,
      Array.from({ length: 33 }, (_, index) => ({
        key: `route-${index}`,
        fromPath: `/path-${String(index).padStart(2, "0")}`,
        pageId: index === 16 ? ids.second! : ids.first!,
      }))
    )
    const transitionId = await startTransition(
      t,
      owner,
      "replace_content",
      "fr"
    )
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === "carried_routes"
    )
    await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect()
      const transition = await ctx.db.get(transitionId)
      for (const row of rows) {
        await ctx.db.patch(row._id, { disposition: "target", status: "ready" })
      }
      await ctx.db.patch(transitionId, {
        targetCount: transition!.targetCount + rows.length,
        unresolvedCount: transition!.unresolvedCount - rows.length,
      })
    })
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === "carry_coverage"
    )
    await t.run(async (ctx) => {
      const decision = await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q
            .eq("transitionId", transitionId)
            .eq("routeId", routeIds["route-16"]!)
        )
        .unique()
      const route = await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transitionId).eq("fromPath", "/path-16")
        )
        .unique()
      await ctx.db.patch(routeIds["route-16"]!, { fromPath: "/path-15" })
      await ctx.db.patch(decision!._id, {
        fromPath: "/path-15",
        outcome: "drop_duplicate",
      })
      await ctx.db.delete(route!._id)
    })
    await runCoverageStep(t, transitionId)
    await driveTransitionUntil(t, transitionId, (transition) => {
      if (!transition.cursor) return false
      const cursor = JSON.parse(transition.cursor)
      return cursor.size === 16 && cursor.page !== null
    })

    expect(await codeOf(runCoverageStep(t, transitionId))).toBe(
      "LANGUAGE_TRANSITION_STATE_INVALID"
    )
  })

  test("retired rows accept only no decision or terminal route-free evidence", async () => {
    for (const state of [
      "valid_terminal",
      "wrong_outcome",
      "skipped_with_route",
    ] as const) {
      const { t, routeId, transitionId } = await freshCarryCoverageFixture()
      await t.run(async (ctx) => {
        const decision = await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId).eq("routeId", routeId)
          )
          .unique()
        const owned = await ctx.db
          .query("siteLanguageTransitionRoutes")
          .withIndex("by_transitionId_and_fromPath", (q) =>
            q.eq("transitionId", transitionId).eq("fromPath", "/legacy-carry")
          )
          .unique()
        await ctx.db.patch(routeId, {
          retiredAt: Date.now(),
          retiredReason: "to_current",
        })
        if (state === "valid_terminal") {
          await ctx.db.patch(decision!._id, { outcome: "drop_retired" })
          await ctx.db.delete(owned!._id)
          const transition = await ctx.db.get(transitionId)
          await ctx.db.patch(transitionId, {
            sourcePublicSetVersion: transition!.sourcePublicSetVersion + 1,
          })
        } else if (state === "wrong_outcome") {
          await ctx.db.delete(owned!._id)
        } else {
          await ctx.db.delete(decision!._id)
        }
      })

      const result = codeOf(runCoverageStep(t, transitionId))
      if (state === "valid_terminal") {
        await expect(result).rejects.toThrow("expected the call to be refused")
        expect(
          (await transitionOf(t, transitionId)).cursorPhase
        ).toBeUndefined()
      } else {
        await expect(result).resolves.toBe("LANGUAGE_TRANSITION_STATE_INVALID")
      }
    }
  })

  test("bare preview confirmation preserves covered carry axes", async () => {
    const { t, owner, transitionId } = await freshCarryCoverageFixture()
    const covered = await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === undefined
    )
    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId,
      expectedPreparedSetVersion: covered.preparedSetVersion,
      expectedCarryDecisionDigest: covered.carryDecisionDigest,
    })
    const confirmed = await transitionOf(t, transitionId)
    expect({
      carryInputVersion: confirmed.carryInputVersion,
      carryDecisionGeneration: confirmed.carryDecisionGeneration,
      carryDecisionDigest: confirmed.carryDecisionDigest,
    }).toEqual({
      carryInputVersion: covered.carryInputVersion,
      carryDecisionGeneration: covered.carryDecisionGeneration,
      carryDecisionDigest: covered.carryDecisionDigest,
    })
    expect(confirmed).toMatchObject({
      previewConfirmedCarryDecisionDigest: covered.carryDecisionDigest,
    })
    expect(confirmed.cursorPhase).toBeUndefined()
    expect(confirmed.cursor).toBeUndefined()
  })
})

describe("M05 P24 carry readiness gate (C3e.3b)", () => {
  test("validation re-runs pointed coverage immediately before the validation cursor", async () => {
    const { t, owner, transitionId, covered } =
      await preparedPointedReplacementFixture()
    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId,
      expectedPreparedSetVersion: covered.preparedSetVersion,
      expectedCarryDecisionDigest: covered.carryDecisionDigest,
    })
    const confirmed = await transitionOf(t, transitionId)
    await owner.mutation(api.cms.language.validateLanguageTransition, {
      transitionId,
      expectedGeneration: confirmed.generation,
    })

    expect(await transitionOf(t, transitionId)).toMatchObject({
      phase: "validating",
      cursorPhase: "carry_coverage",
    })
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.phase === "validating" &&
        transition.cursorPhase === "validation"
    )
    const ready = await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.phase === "ready"
    )
    expect(ready.manifest).toMatchObject({
      sourcePublicSetVersion: ready.sourcePublicSetVersion,
      preparedSetVersion: ready.preparedSetVersion,
    })
  })

  test("validation refuses every missing or mismatched confirmation receipt", async () => {
    for (const corruption of [
      "missing_prepared",
      "mismatched_prepared",
      "missing_carry",
      "mismatched_carry",
    ] as const) {
      const { t, owner, transitionId, covered } =
        await preparedPointedReplacementFixture()
      await owner.mutation(api.cms.language.confirmTransitionPreview, {
        transitionId,
        expectedPreparedSetVersion: covered.preparedSetVersion,
        expectedCarryDecisionDigest: covered.carryDecisionDigest,
      })
      await t.run(async (ctx) => {
        const confirmed = await ctx.db.get(transitionId)
        if (!confirmed) throw new Error("transition missing")
        await ctx.db.patch(
          transitionId,
          corruption === "missing_prepared"
            ? { previewConfirmedPreparedSetVersion: undefined }
            : corruption === "mismatched_prepared"
              ? {
                  previewConfirmedPreparedSetVersion:
                    confirmed.preparedSetVersion - 1,
                }
              : corruption === "missing_carry"
                ? { previewConfirmedCarryDecisionDigest: undefined }
                : {
                    previewConfirmedCarryDecisionDigest:
                      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                  }
        )
      })
      const corrupted = await transitionOf(t, transitionId)
      expect({
        corruption,
        code: await codeOf(
          owner.mutation(api.cms.language.validateLanguageTransition, {
            transitionId,
            expectedGeneration: corrupted.generation,
          })
        ),
      }).toEqual({
        corruption,
        code: "LANGUAGE_TRANSITION_PREVIEW_UNCONFIRMED",
      })
      expect(await transitionOf(t, transitionId)).toMatchObject({
        phase: "preparing",
      })
      expect((await transitionOf(t, transitionId)).cursorPhase).toBeUndefined()
    }
  })

  test("a post-confirmation source move requires reconciliation, coverage and carry reconfirmation", async () => {
    const { t, owner, transitionId, covered } =
      await preparedPointedReplacementFixture()
    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId,
      expectedPreparedSetVersion: covered.preparedSetVersion,
      expectedCarryDecisionDigest: covered.carryDecisionDigest,
    })
    const confirmed = await transitionOf(t, transitionId)

    // A settings write outside every public scope (`dateFormat` has no
    // public reader) still moves the source set.
    await owner.mutation(api.cms.settings.updateSettings, {
      dateFormat: "PPP",
    })
    expect(await transitionOf(t, transitionId)).toMatchObject({
      phase: "preparing",
      cursorPhase: "carry_reconcile",
      previewConfirmedPreparedSetVersion: confirmed.preparedSetVersion,
      previewConfirmedCarryDecisionDigest: confirmed.carryDecisionDigest,
    })
    const reconciled = await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === undefined
    )
    expect(reconciled.previewConfirmedPreparedSetVersion).toBe(
      reconciled.preparedSetVersion
    )
    expect(reconciled.previewConfirmedCarryDecisionDigest).not.toBe(
      reconciled.carryDecisionDigest
    )
    expect(
      await codeOf(
        owner.mutation(api.cms.language.validateLanguageTransition, {
          transitionId,
          expectedGeneration: reconciled.generation,
        })
      )
    ).toBe("LANGUAGE_TRANSITION_PREVIEW_UNCONFIRMED")

    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId,
      expectedPreparedSetVersion: reconciled.preparedSetVersion,
      expectedCarryDecisionDigest: reconciled.carryDecisionDigest,
    })
    const reconfirmed = await transitionOf(t, transitionId)
    await owner.mutation(api.cms.language.validateLanguageTransition, {
      transitionId,
      expectedGeneration: reconfirmed.generation,
    })
    expect(await transitionOf(t, transitionId)).toMatchObject({
      phase: "validating",
      cursorPhase: "carry_coverage",
    })
    const ready = await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.phase === "ready"
    )
    expect(ready.manifest?.sourcePublicSetVersion).toBe(
      ready.sourcePublicSetVersion
    )
  })

  test("readiness does not trust an earlier coverage pass after the corpus develops a gap", async () => {
    const { t, owner, transitionId, covered } =
      await preparedPointedReplacementFixture()
    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId,
      expectedPreparedSetVersion: covered.preparedSetVersion,
      expectedCarryDecisionDigest: covered.carryDecisionDigest,
    })
    const confirmed = await transitionOf(t, transitionId)
    await owner.mutation(api.cms.language.validateLanguageTransition, {
      transitionId,
      expectedGeneration: confirmed.generation,
    })
    const armed = await transitionOf(t, transitionId)
    await t.run(async (ctx) => {
      const decision = await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .first()
      if (!decision) throw new Error("decision missing")
      await ctx.db.delete(decision._id)
    })

    expect(
      await codeOf(
        t.mutation(internal.cms.language.stepLanguageTransition, {
          transitionId,
          generation: armed.generation,
        })
      )
    ).toBe("LANGUAGE_TRANSITION_STATE_INVALID")
    expect(await transitionOf(t, transitionId)).toMatchObject({
      phase: "validating",
      cursorPhase: "carry_coverage",
      cursor: armed.cursor,
    })
    expect((await transitionOf(t, transitionId)).manifest).toBeUndefined()
  })

  test("the coverage-to-validation handoff rechecks both receipts atomically", async () => {
    for (const receipt of ["prepared", "carry"] as const) {
      const { t, owner, transitionId, covered } =
        await preparedPointedReplacementFixture()
      await owner.mutation(api.cms.language.confirmTransitionPreview, {
        transitionId,
        expectedPreparedSetVersion: covered.preparedSetVersion,
        expectedCarryDecisionDigest: covered.carryDecisionDigest,
      })
      const confirmed = await transitionOf(t, transitionId)
      await owner.mutation(api.cms.language.validateLanguageTransition, {
        transitionId,
        expectedGeneration: confirmed.generation,
      })
      const armed = await transitionOf(t, transitionId)
      await t.run((ctx) =>
        ctx.db.patch(
          transitionId,
          receipt === "prepared"
            ? { previewConfirmedPreparedSetVersion: undefined }
            : { previewConfirmedCarryDecisionDigest: undefined }
        )
      )

      expect({
        receipt,
        code: await codeOf(
          t.mutation(internal.cms.language.stepLanguageTransition, {
            transitionId,
            generation: armed.generation,
          })
        ),
      }).toEqual({
        receipt,
        code: "LANGUAGE_TRANSITION_PREVIEW_UNCONFIRMED",
      })
      expect(await transitionOf(t, transitionId)).toMatchObject({
        phase: "validating",
        cursorPhase: "carry_coverage",
        cursor: armed.cursor,
      })
    }
  })

  test("readiness rechecks both receipts after the validation scan", async () => {
    const { t, owner, transitionId, covered } =
      await preparedPointedReplacementFixture()
    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId,
      expectedPreparedSetVersion: covered.preparedSetVersion,
      expectedCarryDecisionDigest: covered.carryDecisionDigest,
    })
    const confirmed = await transitionOf(t, transitionId)
    await owner.mutation(api.cms.language.validateLanguageTransition, {
      transitionId,
      expectedGeneration: confirmed.generation,
    })
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) =>
        transition.phase === "validating" &&
        transition.cursorPhase === "validation"
    )
    await t.run((ctx) =>
      ctx.db.patch(transitionId, {
        previewConfirmedCarryDecisionDigest: undefined,
      })
    )

    const refused = await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.phase !== "validating"
    )
    expect(refused.phase).toBe("preparing")
    expect(refused.cursorPhase).toBeUndefined()
    expect(refused.manifest).toBeUndefined()
  })
})

describe("M05 P11c bounded carry workers (C3e.2/C3e.3a/C3e.3b cells)", () => {
  test("the immediate pre-validation coverage gate stays within all seven ceilings", async () => {
    const { t, owner, transitionId, covered } =
      await preparedPointedReplacementFixture(33)
    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId,
      expectedPreparedSetVersion: covered.preparedSetVersion,
      expectedCarryDecisionDigest: covered.carryDecisionDigest,
    })
    const confirmed = await transitionOf(t, transitionId)
    await owner.mutation(api.cms.language.validateLanguageTransition, {
      transitionId,
      expectedGeneration: confirmed.generation,
    })

    const steps = await measureCarrySteps(
      t,
      transitionId,
      (transition) =>
        transition.phase === "validating" &&
        transition.cursorPhase === "validation"
    )
    expect(steps).toHaveLength(4)
    const ceiling: CarryMetrics = {
      databaseQueries: 66,
      documentsRead: 97,
      documentsWritten: 1,
      functionsScheduled: 1,
      bytesRead: 4 * MIB,
      bytesWritten: 1 * MIB,
      scheduledFunctionArgsBytes: 64 * KIB,
    }
    for (const [index, step] of steps.entries()) {
      expect({
        index,
        phase: step.cursorPhase,
        paginated: step.paginated,
      }).toEqual({
        index,
        phase: "carry_coverage",
        paginated: 1,
      })
      for (const metric of CARRY_METRICS) {
        expect({
          index,
          metric,
          used: step.used[metric],
          ceiling: ceiling[metric],
          within: step.used[metric] <= ceiling[metric],
        }).toEqual({
          index,
          metric,
          used: step.used[metric],
          ceiling: ceiling[metric],
          within: true,
        })
      }
    }
  })

  test("conversion, reconciliation and coverage resume within every seven-metric ceiling", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner, ["carry"])
    await seedPointedContinuity(
      t,
      Array.from({ length: 33 }, (_, index) => ({
        key: `route-${index}`,
        fromPath: `/legacy-${String(index).padStart(2, "0")}`,
        pageId: ids.carry!,
      }))
    )
    const transitionId = await startTransition(
      t,
      owner,
      "replace_content",
      "fr"
    )
    await driveTransitionUntil(
      t,
      transitionId,
      (transition) => transition.cursorPhase === "carried_routes"
    )
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", transitionId).eq("pageId", ids.carry!)
        )
        .unique()
      const transition = await ctx.db.get(transitionId)
      await ctx.db.patch(row!._id, { disposition: "target", status: "ready" })
      await ctx.db.patch(transitionId, {
        targetCount: transition!.targetCount + 1,
        unresolvedCount: transition!.unresolvedCount - 1,
      })
    })

    const conversion = await measureCarrySteps(
      t,
      transitionId,
      (transition) =>
        transition.phase === "preparing" &&
        transition.cursorPhase === "carry_coverage"
    )
    expect(conversion).toHaveLength(4)
    const initialCoverage = await measureCarrySteps(
      t,
      transitionId,
      (transition) => transition.cursorPhase === undefined
    )
    expect(initialCoverage).toHaveLength(4)
    const converted = await t.run(async (ctx) => ({
      decisions: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect(),
      routes: await ctx.db
        .query("siteLanguageTransitionRoutes")
        .withIndex("by_transitionId_and_fromPath", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect(),
    }))
    expect(converted.decisions).toHaveLength(33)
    expect(
      new Set(converted.decisions.map(({ routeId }) => routeId)).size
    ).toBe(33)
    expect(
      converted.routes.filter(({ origin }) => origin === "carried")
    ).toHaveLength(33)

    const row = (await rowOf(t, transitionId, ids.carry!))!
    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId,
      pageId: ids.carry!,
      disposition: "withdraw",
      expectedPageGeneration: row.generation,
    })
    const reconciliation = await measureCarrySteps(
      t,
      transitionId,
      (transition) =>
        transition.cursorPhase === "carry_coverage" &&
        transition.carryDecisionGeneration === 1
    )
    expect(reconciliation).toHaveLength(5)
    const reconciledCoverage = await measureCarrySteps(
      t,
      transitionId,
      (transition) => transition.cursorPhase === undefined
    )
    expect(reconciledCoverage).toHaveLength(4)

    const conversionCeiling: CarryMetrics = {
      databaseQueries: 162,
      documentsRead: 193,
      documentsWritten: 65,
      functionsScheduled: 1,
      bytesRead: 4 * MIB,
      bytesWritten: 1 * MIB,
      scheduledFunctionArgsBytes: 64 * KIB,
    }
    const reconcileCeiling: CarryMetrics = {
      databaseQueries: 194,
      documentsRead: 225,
      documentsWritten: 65,
      functionsScheduled: 1,
      bytesRead: 4 * MIB,
      bytesWritten: 1 * MIB,
      scheduledFunctionArgsBytes: 64 * KIB,
    }
    const coverageCeiling: CarryMetrics = {
      databaseQueries: 66,
      documentsRead: 97,
      documentsWritten: 1,
      functionsScheduled: 1,
      bytesRead: 4 * MIB,
      bytesWritten: 1 * MIB,
      scheduledFunctionArgsBytes: 64 * KIB,
    }
    for (const [phase, steps, ceiling] of [
      ["conversion", conversion, conversionCeiling],
      ["initial coverage", initialCoverage, coverageCeiling],
      ["reconciliation", reconciliation, reconcileCeiling],
      ["reconciled coverage", reconciledCoverage, coverageCeiling],
    ] as const) {
      for (const [index, step] of steps.entries()) {
        expect({ phase, index, paginated: step.paginated }).toEqual({
          phase,
          index,
          paginated: 1,
        })
        for (const metric of CARRY_METRICS) {
          expect({
            phase,
            index,
            part: step.part,
            metric,
            used: step.used[metric],
            ceiling: ceiling[metric],
            within: step.used[metric] <= ceiling[metric],
          }).toEqual({
            phase,
            index,
            part: step.part,
            metric,
            used: step.used[metric],
            ceiling: ceiling[metric],
            within: true,
          })
        }
      }
    }
  })

  test("coverage split and reserve retries write only the halved cursor and size one refuses", async () => {
    for (const injected of ["split", "reserve"] as const) {
      const { t, transitionId } = await freshCarryCoverageFixture()
      const before = await t.run(async (ctx) => ({
        transition: await ctx.db.get(transitionId),
        decisions: await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect(),
        routes: await ctx.db
          .query("siteLanguageTransitionRoutes")
          .withIndex("by_transitionId_and_fromPath", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect(),
      }))
      const realPaginate = languageCarrySeam.paginate.bind(languageCarrySeam)
      const realMetrics = languageCarrySeam.metrics.bind(languageCarrySeam)
      const paginate = vi.spyOn(languageCarrySeam, "paginate")
      const metrics = vi.spyOn(languageCarrySeam, "metrics")
      try {
        if (injected === "split") {
          paginate.mockImplementationOnce(async (query, options) => ({
            ...(await realPaginate(query, options)),
            pageStatus: "SplitRequired",
          }))
        } else {
          metrics.mockImplementationOnce(async (ctx) => {
            const measured = await realMetrics(ctx)
            return {
              ...measured,
              documentsRead: { ...measured.documentsRead, remaining: 0 },
            }
          })
        }
        await runCoverageStep(t, transitionId)
      } finally {
        paginate.mockRestore()
        metrics.mockRestore()
      }
      const after = await t.run(async (ctx) => ({
        transition: await ctx.db.get(transitionId),
        decisions: await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect(),
        routes: await ctx.db
          .query("siteLanguageTransitionRoutes")
          .withIndex("by_transitionId_and_fromPath", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect(),
      }))
      expect({
        injected,
        cursor: JSON.parse(after.transition!.cursor!),
      }).toEqual({
        injected,
        cursor: {
          ...JSON.parse(before.transition!.cursor!),
          size: 16,
        },
      })
      expect(after.decisions).toEqual(before.decisions)
      expect(after.routes).toEqual(before.routes)
    }

    for (const injected of ["split", "reserve"] as const) {
      const { t, transitionId } = await freshCarryCoverageFixture()
      const before = await transitionOf(t, transitionId)
      await t.run((ctx) =>
        ctx.db.patch(transitionId, {
          cursor: JSON.stringify({ ...JSON.parse(before.cursor!), size: 1 }),
        })
      )
      const realPaginate = languageCarrySeam.paginate.bind(languageCarrySeam)
      const realMetrics = languageCarrySeam.metrics.bind(languageCarrySeam)
      const paginate = vi.spyOn(languageCarrySeam, "paginate")
      const metrics = vi.spyOn(languageCarrySeam, "metrics")
      try {
        if (injected === "split") {
          paginate.mockImplementationOnce(async (query, options) => ({
            ...(await realPaginate(query, options)),
            pageStatus: "SplitRequired",
          }))
        } else {
          metrics.mockImplementationOnce(async (ctx) => {
            const measured = await realMetrics(ctx)
            return {
              ...measured,
              documentsRead: { ...measured.documentsRead, remaining: 0 },
            }
          })
        }
        expect(await codeOf(runCoverageStep(t, transitionId))).toBe(
          "LANGUAGE_TRANSITION_CARRY_LIMIT"
        )
      } finally {
        paginate.mockRestore()
        metrics.mockRestore()
      }
      expect(JSON.parse((await transitionOf(t, transitionId)).cursor!)).toEqual(
        { ...JSON.parse(before.cursor!), size: 1 }
      )
    }
  })

  test("SplitRequired and reserve crossings write no corpus and retry at half size", async () => {
    const fixture = async () => {
      const t = app()
      const owner = t.withIdentity(OWNER)
      const { ids } = await englishSite(t, owner, ["carry"])
      await seedPointedContinuity(t, [
        {
          key: "carry",
          fromPath: "/legacy-carry",
          pageId: ids.carry!,
        },
      ])
      const transitionId = await startTransition(
        t,
        owner,
        "replace_content",
        "fr"
      )
      await driveTransitionUntil(
        t,
        transitionId,
        (transition) => transition.cursorPhase === "carried_routes"
      )
      await t.run(async (ctx) => {
        const row = await ctx.db
          .query("siteLanguageTransitionPages")
          .withIndex("by_transitionId_and_pageId", (q) =>
            q.eq("transitionId", transitionId).eq("pageId", ids.carry!)
          )
          .unique()
        const transition = await ctx.db.get(transitionId)
        await ctx.db.patch(row!._id, {
          disposition: "target",
          status: "ready",
        })
        await ctx.db.patch(transitionId, {
          targetCount: transition!.targetCount + 1,
          unresolvedCount: transition!.unresolvedCount - 1,
        })
      })
      return { t, transitionId }
    }

    for (const injected of ["split", "reserve"] as const) {
      const { t, transitionId } = await fixture()
      const realPaginate = languageCarrySeam.paginate.bind(languageCarrySeam)
      const realMetrics = languageCarrySeam.metrics.bind(languageCarrySeam)
      const paginate = vi.spyOn(languageCarrySeam, "paginate")
      const metrics = vi.spyOn(languageCarrySeam, "metrics")
      try {
        if (injected === "split") {
          paginate.mockImplementationOnce(async (query, options) => ({
            ...(await realPaginate(query, options)),
            pageStatus: "SplitRequired",
          }))
        } else {
          metrics.mockImplementationOnce(async (ctx) => {
            const measured = await realMetrics(ctx)
            return {
              ...measured,
              documentsRead: { ...measured.documentsRead, remaining: 0 },
            }
          })
        }
        const transition = await transitionOf(t, transitionId)
        await t.run((ctx) =>
          runLanguageTransitionStep(ctx, transitionId, transition.generation)
        )
      } finally {
        paginate.mockRestore()
        metrics.mockRestore()
      }
      const after = await transitionOf(t, transitionId)
      expect({ injected, cursor: JSON.parse(after.cursor!) }).toEqual({
        injected,
        cursor: {
          part: "decide",
          page: null,
          size: 16,
          startSourcePublicSetVersion: 0,
          startCarryInputVersion: 0,
        },
      })
      expect(
        await t.run(async (ctx) => ({
          decisions: await ctx.db.query("siteLanguageCarryDecisions").collect(),
          routes: await ctx.db.query("siteLanguageTransitionRoutes").collect(),
        }))
      ).toEqual({ decisions: [], routes: [] })
    }

    const { t, transitionId } = await fixture()
    await t.run((ctx) =>
      ctx.db.patch(transitionId, {
        cursor: JSON.stringify({
          part: "decide",
          page: null,
          size: 1,
          startSourcePublicSetVersion: 0,
          startCarryInputVersion: 0,
        }),
      })
    )
    const realPaginate = languageCarrySeam.paginate.bind(languageCarrySeam)
    const paginate = vi.spyOn(languageCarrySeam, "paginate")
    try {
      paginate.mockImplementationOnce(async (query, options) => ({
        ...(await realPaginate(query, options)),
        pageStatus: "SplitRequired",
      }))
      const transition = await transitionOf(t, transitionId)
      expect(
        await codeOf(
          t.run((ctx) =>
            runLanguageTransitionStep(ctx, transitionId, transition.generation)
          )
        )
      ).toBe("LANGUAGE_TRANSITION_CARRY_LIMIT")
    } finally {
      paginate.mockRestore()
    }
    expect(
      await t.run(async (ctx) => ({
        decisions: await ctx.db.query("siteLanguageCarryDecisions").collect(),
        routes: await ctx.db.query("siteLanguageTransitionRoutes").collect(),
      }))
    ).toEqual({ decisions: [], routes: [] })
  })
})

describe("M05 C3e.1 carry foundation", () => {
  test("preview confirmation stores both receipts without moving carry counters", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await englishSite(t, owner)
    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)

    const legacy = await transitionOf(t, id)
    expect(legacy.carryInputVersion).toBeUndefined()
    expect(legacy.carryDecisionGeneration).toBeUndefined()
    await t.run((ctx) =>
      ctx.db.patch(id, {
        carryInputVersion: 4,
        carryDecisionGeneration: 2,
        carryDecisionDigest: "carry-digest-a",
      })
    )
    const before = await transitionOf(t, id)

    await expect(
      owner.mutation(api.cms.language.confirmTransitionPreview, {
        transitionId: id,
        expectedPreparedSetVersion: before.preparedSetVersion,
        expectedCarryDecisionDigest: "carry-digest-a",
      })
    ).resolves.toEqual({
      preparedSetVersion: before.preparedSetVersion + 1,
    })

    expect(await transitionOf(t, id)).toMatchObject({
      preparedSetVersion: before.preparedSetVersion + 1,
      previewConfirmedPreparedSetVersion: before.preparedSetVersion + 1,
      carryInputVersion: 4,
      carryDecisionGeneration: 2,
      carryDecisionDigest: "carry-digest-a",
      previewConfirmedCarryDecisionDigest: "carry-digest-a",
    })
    await expect(
      owner.query(api.cms.language.getLanguageState, {})
    ).resolves.toMatchObject({
      transition: {
        carryDecisionDigest: "carry-digest-a",
        previewConfirmedCarryDecisionDigest: "carry-digest-a",
      },
    })
  })

  test("a carry digest mismatch changes no transition state", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await englishSite(t, owner)
    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)
    await t.run((ctx) =>
      ctx.db.patch(id, {
        carryInputVersion: 3,
        carryDecisionGeneration: 7,
        carryDecisionDigest: "carry-digest-live",
      })
    )
    const before = await transitionOf(t, id)

    expect(
      await codeOf(
        owner.mutation(api.cms.language.confirmTransitionPreview, {
          transitionId: id,
          expectedPreparedSetVersion: before.preparedSetVersion,
          expectedCarryDecisionDigest: "carry-digest-stale",
        })
      )
    ).toBe("LANGUAGE_TRANSITION_STALE")
    expect(await transitionOf(t, id)).toEqual(before)
  })

  test("legacy transition rows accept both carry cursor phases", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await englishSite(t, owner)
    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)
    const legacy = await transitionOf(t, id)
    expect(legacy.carryInputVersion).toBeUndefined()
    expect(legacy.carryDecisionGeneration).toBeUndefined()

    await t.run((ctx) => ctx.db.patch(id, { cursorPhase: "carry_reconcile" }))
    expect((await transitionOf(t, id)).cursorPhase).toBe("carry_reconcile")
    await t.run((ctx) => ctx.db.patch(id, { cursorPhase: "carry_coverage" }))
    expect((await transitionOf(t, id)).cursorPhase).toBe("carry_coverage")
  })

  test("only disposition, content confirmation and target preparation move the carry input", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    const about = ids.about!
    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)
    expect((await transitionOf(t, id)).carryInputVersion).toBeUndefined()

    let row = (await rowOf(t, id, about))!
    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId: id,
      pageId: about,
      disposition: "target",
      expectedPageGeneration: row.generation,
    })
    const dispositioned = await transitionOf(t, id)
    expect(dispositioned.carryInputVersion).toBe(1)
    expect(dispositioned.cursorPhase).toBeUndefined()

    const source = await generations(t, about, "en")
    await owner.mutation(api.cms.language.copySourceToTargetDraft, {
      transitionId: id,
      pageId: about,
      expectedSourceDraftGeneration: source.state!.draftGeneration,
      expectedLifecycleGeneration: source.page!.lifecycleGeneration,
    })
    expect((await transitionOf(t, id)).carryInputVersion).toBe(1)

    const target = await generations(t, about, "fr")
    row = (await rowOf(t, id, about))!
    await owner.mutation(api.cms.language.confirmTargetContent, {
      transitionId: id,
      pageId: about,
      expectedTargetDraftGeneration: target.state!.draftGeneration,
      expectedSharedDraftGeneration: source.shared!.generation,
      expectedPageGeneration: row.generation,
    })
    expect((await transitionOf(t, id)).carryInputVersion).toBe(2)

    row = (await rowOf(t, id, about))!
    await owner.mutation(api.cms.language.prepareTargetPage, {
      transitionId: id,
      pageId: about,
      expectedPageGeneration: row.generation,
    })
    const prepared = await transitionOf(t, id)
    expect(prepared.carryInputVersion).toBe(3)

    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId: id,
      expectedPreparedSetVersion: prepared.preparedSetVersion,
    })
    expect(await transitionOf(t, id)).toMatchObject({ carryInputVersion: 3 })
    expect(
      (await transitionOf(t, id)).previewConfirmedCarryDecisionDigest
    ).toBeUndefined()
  })

  test("a target-locale-only Menu text write moves the carry input once", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    await owner.mutation(api.cms.menus.createCanonical, { slug: "primary" })
    await owner.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      locale: "en",
      nav: [
        {
          id: "about",
          label: { en: "About" },
          target: { type: "internal", pageId: ids.about! },
        },
      ],
    })
    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)
    const before = await transitionOf(t, id)
    expect(before.carryInputVersion).toBeUndefined()

    await owner.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      locale: "fr",
      nav: [
        {
          id: "about",
          label: { en: "About", fr: "À propos" },
          target: { type: "internal", pageId: ids.about! },
        },
      ],
    })

    expect(await transitionOf(t, id)).toMatchObject({
      preparedSetVersion: before.preparedSetVersion + 1,
      carryInputVersion: 1,
    })
  })

  test("correction preparation and automatic Menu copying each move the carry input", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const homeId = await bootstrap(t, owner)
    await publish(t, owner, homeId)
    await owner.mutation(api.cms.menus.createCanonical, { slug: "primary" })
    await owner.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      locale: "en",
      nav: [
        {
          id: "home",
          label: { en: "Home" },
          target: { type: "internal", pageId: homeId },
        },
      ],
    })

    const id = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)

    expect(await transitionOf(t, id)).toMatchObject({
      phase: "preparing",
      unresolvedCount: 0,
      preparedSetVersion: 2,
      carryInputVersion: 2,
    })
  })

  test("the owner pages a filterable carry-decision read model", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const stranger = t.withIdentity(STRANGER)
    const { ids } = await englishSite(t, owner, ["alpha", "beta", "gamma"])
    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)

    await t.run(async (ctx) => {
      const installationOwner = await ctx.db.query("cmsOwner").unique()
      const migrationId = await ctx.db.insert("siteDefaultLanguageMigrations", {
        fromLocale: "de",
        toLocale: "en",
        phase: "committed",
        generation: 1,
        captured: {
          authorityVersion: 1,
          moduleConfigurationVersion: 1,
          site: { routeClaimVersion: 0, publicationSetVersion: 0 },
          from: { routeClaimVersion: 0, publicationSetVersion: 0 },
          to: { routeClaimVersion: 0, publicationSetVersion: 0 },
        },
        counts: {
          rows: 3,
          shadowedByCurrent: 0,
          shadowedByHistorical: 0,
          manualRulesShadowed: 0,
          manualRulesShifted: 0,
          manualRulesUnprefixed: 0,
          carriedShadowedSkipped: 0,
          blockers: 0,
        },
        disclosurePageCount: 0,
        reviewedThroughOrdinal: -1,
        attribution: {
          kind: "owner",
          ownerId: installationOwner!._id,
          authId: OWNER.subject,
          tokenIdentifier: OWNER.tokenIdentifier,
        },
        createdAt: 1,
        updatedAt: 1,
      })
      const decisions = [
        { fromPath: "/carry", pageId: ids.alpha!, outcome: "carry" as const },
        {
          fromPath: "/drop-locale",
          pageId: ids.beta!,
          outcome: "drop_locale" as const,
        },
        {
          fromPath: "/drop-retired",
          pageId: ids.gamma!,
          outcome: "drop_retired" as const,
        },
      ]
      for (const decision of decisions) {
        const routeId = await ctx.db.insert("siteDefaultLanguageRoutes", {
          migrationId,
          generation: 1,
          fromPath: decision.fromPath,
          pageId: decision.pageId,
          locale: "en",
          origin: "old_default_current",
          createdAt: 1,
        })
        await ctx.db.insert("siteLanguageCarryDecisions", {
          transitionId: id,
          routeId,
          fromPath: decision.fromPath,
          outcome: decision.outcome,
          capturedSourcePublicSetVersion: 0,
          capturedCarryInputVersion: 0,
          capturedCarryDecisionGeneration: 0,
          decidedAt: 1,
        })
      }
    })

    const first = await owner.query(
      api.cms.language.listLanguageCarryDecisions,
      {
        transitionId: id,
        paginationOpts: { numItems: 1, cursor: null },
        filter: "all",
      }
    )
    expect(first.page).toEqual([{ fromPath: "/carry", outcome: "carry" }])
    expect(first.isDone).toBe(false)
    const rest = await owner.query(
      api.cms.language.listLanguageCarryDecisions,
      {
        transitionId: id,
        paginationOpts: { numItems: 10, cursor: first.continueCursor },
        filter: "all",
      }
    )
    expect(rest.page).toEqual([
      { fromPath: "/drop-locale", outcome: "drop_locale" },
      { fromPath: "/drop-retired", outcome: "drop_retired" },
    ])
    await expect(
      owner.query(api.cms.language.listLanguageCarryDecisions, {
        transitionId: id,
        paginationOpts: { numItems: 10, cursor: null },
        filter: "carried",
      })
    ).resolves.toMatchObject({
      page: [{ fromPath: "/carry", outcome: "carry" }],
    })
    await expect(
      owner.query(api.cms.language.listLanguageCarryDecisions, {
        transitionId: id,
        paginationOpts: { numItems: 10, cursor: null },
        filter: "dropped",
      })
    ).resolves.toMatchObject({
      page: [
        { fromPath: "/drop-locale", outcome: "drop_locale" },
        { fromPath: "/drop-retired", outcome: "drop_retired" },
      ],
    })
    await expect(
      stranger.query(api.cms.language.listLanguageCarryDecisions, {
        transitionId: id,
        paginationOpts: { numItems: 10, cursor: null },
        filter: "all",
      })
    ).rejects.toThrow()
  })
})

describe("F09a initial selection", () => {
  test("row 1: a French bootstrap commits authority v1 fr and publishes nothing", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const homeId = await bootstrap(t, owner, "fr")

    const stored = await t.run(async (ctx) => ({
      authority: await ctx.db.query("siteLanguageAuthority").collect(),
      settings: await ctx.db.query("siteSettings").unique(),
      drafts: await ctx.db.query("pageLocaleDrafts").collect(),
      snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
      candidates: await ctx.db
        .query("pageLocalePublicationCandidates")
        .collect(),
    }))
    expect(stored.authority).toHaveLength(1)
    expect(stored.authority[0]).toMatchObject({
      version: 1,
      currentLocale: "fr",
    })
    expect(stored.authority[0]!.activeTransitionId).toBeUndefined()
    expect(stored.settings).toMatchObject({
      defaultLocale: "fr",
      enabledLocales: ["fr"],
      homePageId: homeId,
    })
    expect(stored.drafts.map((draft) => [draft.pageId, draft.locale])).toEqual([
      [homeId, "fr"],
    ])
    expect(stored.snapshots).toEqual([])
    expect(stored.candidates).toEqual([])
    expect(
      await owner.query(api.cms.language.getLanguageState, {})
    ).toMatchObject({
      kind: "current",
      version: 1,
      currentLocale: "fr",
      transition: null,
    })

    // A resumed bootstrap keeps exactly one authority row.
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "F09a site",
      timezone: "UTC",
      defaultLocale: "fr",
    })
    expect(
      await t.run((ctx) => ctx.db.query("siteLanguageAuthority").collect())
    ).toHaveLength(1)
  })
})

describe("F09a refusals and authority", () => {
  test("row 4: an unrelated identity cannot drive any transition command", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const stranger = t.withIdentity(STRANGER)
    const { ids } = await englishSite(t, owner)
    const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())

    await expect(
      stranger.mutation(api.cms.language.startLanguageTransition, {
        mode: "replace_content",
        sourceLocale: "en",
        targetLocale: "fr",
        expectedSettingsUpdatedAt: settings!.updatedAt,
        expectedAuthorityVersion: 1,
      })
    ).rejects.toThrow()
    expect((await languageTables(t)).transitions).toEqual([])

    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)
    const before = await languageTables(t)
    const transition = await transitionOf(t, id)
    const row = await rowOf(t, id, ids.about!)
    const calls: Array<Promise<unknown>> = [
      stranger.mutation(api.cms.language.initializeSiteLanguageAuthority, {}),
      stranger.mutation(api.cms.language.continueLanguageTransition, {
        transitionId: id,
        expectedGeneration: transition.generation,
      }),
      stranger.mutation(api.cms.language.setPageDisposition, {
        transitionId: id,
        pageId: ids.about!,
        disposition: "target",
        expectedPageGeneration: row!.generation,
      }),
      stranger.mutation(api.cms.language.copySourceToTargetDraft, {
        transitionId: id,
        pageId: ids.about!,
        expectedSourceDraftGeneration: 1,
        expectedLifecycleGeneration: 1,
      }),
      stranger.mutation(api.cms.language.confirmTargetContent, {
        transitionId: id,
        pageId: ids.about!,
        expectedTargetDraftGeneration: 1,
        expectedSharedDraftGeneration: 1,
        expectedPageGeneration: row!.generation,
      }),
      stranger.mutation(api.cms.language.prepareTargetPage, {
        transitionId: id,
        pageId: ids.about!,
        expectedPageGeneration: row!.generation,
      }),
      stranger.mutation(api.cms.language.confirmTransitionPreview, {
        transitionId: id,
        expectedPreparedSetVersion: transition.preparedSetVersion,
      }),
      stranger.mutation(api.cms.language.validateLanguageTransition, {
        transitionId: id,
        expectedGeneration: transition.generation,
      }),
      stranger.mutation(api.cms.language.cancelLanguageTransition, {
        transitionId: id,
        expectedGeneration: transition.generation,
        discardTargetDrafts: true,
      }),
      stranger.query(api.cms.language.getLanguageState, {}),
    ]
    for (const call of calls) await expect(call).rejects.toThrow()
    expect(await languageTables(t)).toEqual(before)
  })

  test("rows 5 and 37: multi-locale and legacy installs are refused and left untouched", async () => {
    const legacy = app("legacy")
    const legacyOwner = legacy.withIdentity(OWNER)
    await legacy.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Legacy",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        updatedAt: 1,
      })
    )
    const legacyBefore = await languageTables(legacy)
    expect(
      await codeOf(startTransition(legacy, legacyOwner, "correct_label", "fr"))
    ).toBe("LANGUAGE_TRANSITION_REQUIRES_SNAPSHOT_AUTHORITY")
    expect(await languageTables(legacy)).toEqual(legacyBefore)

    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    const pageFor = (slug: string) =>
      owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        slug,
        title: slug,
        content: {
          en: { title: `${slug} en`, slices: [] },
          fr: { title: `${slug} fr`, slices: [] },
        },
      })
    const homeId = await pageFor("home")
    const aboutId = await pageFor("about")
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "Multi",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        homePageId: homeId,
        updatedAt: 1,
      })
    )
    for (const pageId of [homeId, aboutId]) {
      await publish(t, owner, pageId, "en")
      await publish(t, owner, pageId, "fr")
    }
    // Version 0 compatibility: both enabled locales keep serving.
    expect(await publicProjection(t, aboutId, "en")).not.toBeNull()
    expect(await publicProjection(t, aboutId, "fr")).not.toBeNull()
    expect(
      await owner.query(api.cms.language.getLanguageState, {})
    ).toMatchObject({ kind: "multi_locale", version: 0 })

    const before = await languageTables(t)
    expect(
      await codeOf(
        owner.mutation(api.cms.language.initializeSiteLanguageAuthority, {})
      )
    ).toBe("LANGUAGE_MULTI_LOCALE_REQUIRES_L01_M05")
    expect(await codeOf(startTransition(t, owner, "correct_label", "de"))).toBe(
      "LANGUAGE_MULTI_LOCALE_REQUIRES_L01_M05"
    )
    expect(await languageTables(t)).toEqual(before)
    expect(before.authority).toEqual([])
  })

  test("row 7 (start): pending and held publication releases refuse start", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    const state = (await generations(t, ids.about!, "en")).state!
    const snapshot = await t.run((ctx) => ctx.db.get(state.currentSnapshotId!))
    for (const status of ["pending", "held"] as const) {
      const releaseId = await t.run((ctx) =>
        ctx.db.insert("pageLocalePublicationReleases", {
          pageId: ids.about!,
          locale: "en",
          candidateId: snapshot!.candidateId,
          generation: 99,
          expectedPublicGeneration: state.publicGeneration,
          expectedLifecycleGeneration: 1,
          executeAt: Date.now() + 60_000,
          status,
          attribution: snapshot!.attribution,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      )
      expect(
        await codeOf(startTransition(t, owner, "correct_label", "fr"))
      ).toBe("LANGUAGE_TRANSITION_PENDING_PUBLICATION_OBLIGATIONS")
      expect((await languageTables(t)).transitions).toEqual([])
      await t.run((ctx) => ctx.db.delete(releaseId))
    }
  })

  test("row 28: missing, duplicate or disagreeing authority fails readers and commands closed", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    await saveDraft(t, owner, ids.about!, "en", "about", "About v2")
    const authority = await t.run((ctx) =>
      ctx.db.query("siteLanguageAuthority").unique()
    )

    const assertClosed = async () => {
      expect(
        (await owner.query(api.cms.language.getLanguageState, {})).kind
      ).toBe("invalid")
      expect(await publicProjection(t, ids.about!, "en")).toBeNull()
      expect(await codeOf(publish(t, owner, ids.about!))).toBe(
        "SITE_LANGUAGE_AUTHORITY_INVALID"
      )
      expect(
        await codeOf(startTransition(t, owner, "correct_label", "fr"))
      ).toBe("SITE_LANGUAGE_AUTHORITY_INVALID")
    }

    // Duplicate rows.
    const duplicateId = await t.run((ctx) =>
      ctx.db.insert("siteLanguageAuthority", {
        key: "site-language-v1",
        version: 1,
        currentLocale: "en",
        updatedAt: 1,
      })
    )
    await assertClosed()
    await t.run((ctx) => ctx.db.delete(duplicateId))

    // Disagreement with settings.
    await t.run((ctx) => ctx.db.patch(authority!._id, { currentLocale: "fr" }))
    await assertClosed()

    // Missing on a single-language install: version 0, readers still serve,
    // no transition may start until initialization.
    await t.run((ctx) => ctx.db.delete(authority!._id))
    expect(await publicProjection(t, ids.about!, "en")).not.toBeNull()
    expect(await codeOf(startTransition(t, owner, "correct_label", "fr"))).toBe(
      "SITE_LANGUAGE_AUTHORITY_INVALID"
    )
    expect(
      await owner.mutation(api.cms.language.initializeSiteLanguageAuthority, {})
    ).toEqual({ version: 1, currentLocale: "en" })
  })
})

describe("F09a preparation", () => {
  test("row 8: only preparation commands accept the hidden target; ordinary commands fail closed", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    const about = ids.about!
    const id = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)
    const fr = (await generations(t, about, "fr")).state!
    expect(fr.hasCurrentSnapshot).toBe(true)
    expect(await publicProjection(t, about, "fr")).toBeNull()

    const frDraft = {
      pageType: "landing-page",
      localized: { title: "Brouillon" },
      slices: [],
    } as never
    expect(
      await codeOf(
        owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId: about,
          expectedLifecycleGeneration: 1,
          localized: {
            locale: "fr",
            slug: "about",
            draft: frDraft,
            expectedGeneration: fr.draftGeneration,
          },
        })
      )
    ).toBe("LOCALE_NOT_ENABLED")
    expect(await codeOf(publish(t, owner, about, "fr"))).toBe(
      "PUBLICATION_LOCALE_CONFIG_INVALID"
    )
    expect(
      await codeOf(
        owner.mutation(api.cms.publication.withdrawLocale, {
          pageId: about,
          locale: "fr",
          expectedSnapshotId: fr.currentSnapshotId!,
          expectedPublicGeneration: fr.publicGeneration,
          expectedLifecycleGeneration: 1,
        })
      )
    ).toBe("LOCALE_NOT_ENABLED")
    expect(
      await codeOf(
        owner.mutation(api.cms.publication.deleteLocaleContent, {
          pageId: about,
          locale: "fr",
          expectedDraftGeneration: fr.draftGeneration,
          expectedPublicGeneration: fr.publicGeneration,
          expectedLifecycleGeneration: 1,
        })
      )
    ).toBe("LOCALE_NOT_ENABLED")
    expect(
      await codeOf(
        owner.mutation(api.cms.preview.createPreviewSession, {
          pageId: about,
          locale: "fr",
        })
      )
    ).toBe("LOCALE_NOT_ENABLED")
    expect(
      await codeOf(saveDraft(t, owner, about, "de", "about", "Entwurf"))
    ).toBe("LOCALE_NOT_ENABLED")

    // Named preparation commands: target draft save and discard.
    const preparedBefore = (await transitionOf(t, id)).preparedSetVersion
    await saveDraft(t, owner, about, "fr", "about", "Brouillon")
    const saved = (await generations(t, about, "fr")).state!
    expect((await rowOf(t, id, about))?.target).toMatchObject({
      draftGeneration: saved.draftGeneration,
      draftCreatedByTransition: true,
    })
    await owner.mutation(api.cms.publication.discardLocaleDraft, {
      pageId: about,
      locale: "fr",
      expectedDraftGeneration: saved.draftGeneration,
      expectedLifecycleGeneration: 1,
    })
    expect((await transitionOf(t, id)).preparedSetVersion).toBe(
      preparedBefore + 2
    )
    expect(await publicProjection(t, about, "fr")).toBeNull()
    expect(
      (await t.run((ctx) => ctx.db.query("siteSettings").unique()))!
        .enabledLocales
    ).toEqual(["en"])

    // With the settings row absent every ordinary command fails closed.
    const u = app()
    const uOwner = u.withIdentity(OWNER)
    const site = await englishSite(u, uOwner)
    const page = site.ids.about!
    await saveDraft(u, uOwner, page, "en", "about", "About v2")
    const en = (await generations(u, page, "en")).state!
    await u.run(async (ctx) => {
      const settings = await ctx.db.query("siteSettings").unique()
      await ctx.db.delete(settings!._id)
    })
    const enDraft = {
      pageType: "landing-page",
      localized: { title: "About v3" },
      slices: [],
    } as never
    const refusals = [
      saveDraft(u, uOwner, page, "en", "about", "About v3"),
      uOwner.mutation(api.cms.publication.saveEditorDraft, {
        pageId: page,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug: "about",
          draft: enDraft,
          expectedGeneration: en.draftGeneration,
        },
      }),
      publish(u, uOwner, page, "en"),
      uOwner.mutation(api.cms.publication.withdrawLocale, {
        pageId: page,
        locale: "en",
        expectedSnapshotId: en.currentSnapshotId!,
        expectedPublicGeneration: en.publicGeneration,
        expectedLifecycleGeneration: 1,
      }),
      uOwner.mutation(api.cms.publication.discardLocaleDraft, {
        pageId: page,
        locale: "en",
        expectedDraftGeneration: en.draftGeneration,
        expectedLifecycleGeneration: 1,
      }),
      uOwner.mutation(api.cms.publication.deleteLocaleContent, {
        pageId: page,
        locale: "en",
        expectedDraftGeneration: en.draftGeneration,
        expectedPublicGeneration: en.publicGeneration,
        expectedLifecycleGeneration: 1,
      }),
      uOwner.mutation(api.cms.preview.createPreviewSession, {
        pageId: page,
        locale: "en",
      }),
    ]
    for (const refusal of refusals) {
      expect(await codeOf(refusal)).toBe("SITE_LANGUAGE_AUTHORITY_INVALID")
    }
  })

  test("rows 9 and 10: correction copies the frozen snapshot, never the unpublished edit, and reports every page fact", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const homeId = await bootstrap(t, owner)
    await publish(t, owner, homeId)
    const about = await createPage(owner, "about")
    const { shared } = await generations(t, about, "en")
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId: about,
      expectedSharedDraftGeneration: shared!.generation,
      expectedLifecycleGeneration: 1,
      seo: { metaTitle: "About us" },
    })
    await publish(t, owner, about)
    await saveDraft(t, owner, about, "en", "about", "Unpublished edit")

    const before = await t.run(async (ctx) => {
      const state = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "en")
        )
        .unique()
      const snapshot = await ctx.db.get(state!.currentSnapshotId!)
      return {
        state,
        snapshot,
        candidate: await ctx.db.get(snapshot!.candidateId),
        page: await ctx.db.get(about),
      }
    })

    const id = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)

    const after = await t.run(async (ctx) => {
      const fr = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "fr")
        )
        .unique()
      const frSnapshot = fr?.currentSnapshotId
        ? await ctx.db.get(fr.currentSnapshotId)
        : null
      return {
        enSnapshot: await ctx.db.get(before.snapshot!._id),
        enCandidate: await ctx.db.get(before.candidate!._id),
        page: await ctx.db.get(about),
        fr,
        frSnapshot,
        frCandidate: frSnapshot
          ? await ctx.db.get(frSnapshot.candidateId)
          : null,
        frDraft: await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", about).eq("locale", "fr")
          )
          .unique(),
      }
    })
    expect(after.enSnapshot).toEqual(before.snapshot)
    expect(after.enCandidate).toEqual(before.candidate)
    expect(after.page).toEqual(before.page)
    expect(after.frSnapshot?._id).toBeDefined()
    expect(after.frSnapshot!._id).not.toBe(before.snapshot!._id)
    expect(after.frSnapshot!.attribution).toEqual(before.snapshot!.attribution)
    const enPayload = JSON.parse(before.candidate!.payloadJson)
    const frPayload = JSON.parse(after.frCandidate!.payloadJson)
    expect(frPayload.locale).toBe("fr")
    expect(frPayload.page).toEqual(enPayload.page)
    expect(frPayload.localized).toEqual(enPayload.localized)
    expect(frPayload.shared).toEqual(enPayload.shared)
    expect(JSON.stringify(frPayload)).not.toContain("Unpublished edit")
    // The unpublished edit survives only as a private target Working Draft.
    expect(after.frDraft?.content).toMatchObject({ title: "Unpublished edit" })
    expect(await rowOf(t, id, about)).toMatchObject({
      kind: "public_route",
      disposition: "target",
      status: "ready",
      target: {
        snapshotId: after.frSnapshot!._id,
        path: "/about",
        draftCreatedByTransition: true,
      },
    })
    expect((await publicProjection(t, about, "en"))?.payload.localized).toEqual(
      enPayload.localized
    )
    expect(await publicProjection(t, about, "fr")).toBeNull()

    const report = await owner.query(
      api.cms.language.listLanguageTransitionPages,
      {
        transitionId: id,
        paginationOpts: { numItems: 10, cursor: null },
      }
    )
    const aboutReport = report.page.find((entry) => entry.pageId === about)
    expect(aboutReport).toMatchObject({
      sourcePath: "/about",
      targetPath: "/about",
      sourceSlug: "about",
      targetRouteConflict: false,
    })
    expect(aboutReport!.contentKeys).toEqual(["slices", "title"])
    expect(aboutReport!.seoJson).toContain("About us")
    expect(report.page.map((entry) => entry.pageId).sort()).toEqual(
      [homeId, about].sort()
    )
  })

  test("row 34: hidden-target preparation orders ancestry and defers references to validation", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const homeId = await bootstrap(t, owner)
    await publish(t, owner, homeId)
    // Created before its parent, so the first pass must wait for the parent.
    const child = await createPage(owner, "child")
    const parent = await createPage(owner, "parent")
    await publish(t, owner, parent)
    await t.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", child))
        .unique()
      await ctx.db.patch(shared!._id, { system: { parentId: parent } })
    })
    await publish(t, owner, child)
    // A post created before the author it references: correction prepares the
    // post first, so its author reference is recorded before the author exists
    // in the target and is closed only by validation.
    const post = await owner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      slug: "news",
      title: "News",
      content: { en: { title: "News", slices: [] } },
    })
    const author = await owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      slug: "ada",
      title: "Ada",
      name: "Ada",
      content: { en: { title: "Ada", slices: [] } },
    })
    await publish(t, owner, author)
    const postShared = (await generations(t, post, "en")).shared!
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId: post,
      expectedSharedDraftGeneration: postShared.generation,
      expectedLifecycleGeneration: 1,
      authorIds: [author],
    })
    await publish(t, owner, post)

    const id = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)

    const transition = await transitionOf(t, id)
    expect(transition).toMatchObject({
      phase: "preparing",
      unresolvedCount: 0,
      blockedCount: 0,
      pageCount: 5,
    })
    const childFr = await publicProjection(t, child, "fr")
    expect(childFr).toBeNull()
    const childCandidate = await t.run(async (ctx) => {
      const state = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", child).eq("locale", "fr")
        )
        .unique()
      const snapshot = await ctx.db.get(state!.currentSnapshotId!)
      return JSON.parse((await ctx.db.get(snapshot!.candidateId))!.payloadJson)
    })
    expect(childCandidate.route).toMatchObject({
      kind: "routable",
      canonicalPath: "/parent/child",
      ancestry: [{ pageId: parent, canonicalPath: "/parent" }],
    })
    const postReferences = await t.run((ctx) =>
      ctx.db
        .query("pagePublicationDocumentReferences")
        .withIndex("by_pageId_and_locale_and_sourceKind", (q) =>
          q
            .eq("pageId", post)
            .eq("locale", "fr")
            .eq("sourceKind", "current_public")
        )
        .collect()
    )
    expect(postReferences.map((reference) => reference.targetId)).toContain(
      author
    )

    const ready = await confirmAndValidate(t, owner, id)
    expect(ready.phase).toBe("ready")
    expect(ready.manifest).toMatchObject({
      readinessVersion: 1,
      pageCount: 5,
      sourcePublicSetVersion: ready.sourcePublicSetVersion,
      preparedSetVersion: ready.preparedSetVersion,
    })
  })

  test("rows 6: owned retained target artifacts need a disposition; fault-injected unattributed content blocks; nothing is deleted", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner, ["alpha", "charlie"])
    const alpha = ids.alpha!
    const charlie = ids.charlie!
    await saveDraft(t, owner, alpha, "en", "alpha", "Alpha edit")
    const first = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)
    const retained = (await generations(t, alpha, "fr")).state!
    expect(retained.hasCurrentSnapshot).toBe(true)

    // Seed: the first transition is recorded as cancelled with its prepared
    // alpha selection and transition-created draft still retained.
    await t.run(async (ctx) => {
      await ctx.db.patch(first, { phase: "cancelled", cancelledAt: Date.now() })
      const authority = await ctx.db.query("siteLanguageAuthority").unique()
      await ctx.db.patch(authority!._id, { activeTransitionId: undefined })
    })
    // Alpha leaves the source site, so only its retained fr artifacts remain.
    const alphaEn = (await generations(t, alpha, "en")).state!
    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: alpha,
      locale: "en",
      expectedSnapshotId: alphaEn.currentSnapshotId!,
      expectedPublicGeneration: alphaEn.publicGeneration,
      expectedLifecycleGeneration: 1,
    })
    // Fault injection: product mutations cannot create an unattributed target
    // draft, so insert the impossible storage state to prove fail-closed.
    const snapshotAttribution = (await t.run((ctx) =>
      ctx.db.get(alphaEn.currentSnapshotId!)
    ))!.attribution
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("pageLocalePublicationStates", {
        pageId: charlie,
        locale: "fr",
        draftGeneration: 1,
        publicGeneration: 0,
        releaseGeneration: 0,
        hasCurrentSnapshot: false,
        updatedAt: now,
      })
      await ctx.db.insert("pageLocaleDrafts", {
        pageId: charlie,
        locale: "fr",
        pageType: "landing-page",
        generation: 1,
        slug: "charlie",
        content: { title: "Charlie fr", slices: [] },
        updatedBy: snapshotAttribution,
        createdAt: now,
        updatedAt: now,
      } as never)
    })
    const frBefore = await t.run(async (ctx) => ({
      snapshots: (await ctx.db.query("pagePublishedSnapshots").collect())
        .filter((snapshot) => snapshot.locale === "fr")
        .map((snapshot) => snapshot._id),
      drafts: (await ctx.db.query("pageLocaleDrafts").collect())
        .filter((draft) => draft.locale === "fr")
        .map((draft) => draft._id),
    }))

    const second = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)

    expect(await rowOf(t, second, alpha)).toMatchObject({
      kind: "retained_target",
      disposition: "undecided",
      status: "unready",
    })
    expect(await rowOf(t, second, charlie)).toMatchObject({
      status: "blocked",
      blockerCode: "TARGET_LOCALE_HAS_RETAINED_CONTENT",
    })
    const frAfter = await t.run(async (ctx) => ({
      snapshots: await Promise.all(
        frBefore.snapshots.map((id) => ctx.db.get(id))
      ),
      drafts: await Promise.all(frBefore.drafts.map((id) => ctx.db.get(id))),
    }))
    expect(frAfter.snapshots.every((snapshot) => snapshot !== null)).toBe(true)
    expect(frAfter.drafts.every((draft) => draft !== null)).toBe(true)
    expect((await generations(t, alpha, "fr")).state!.currentSnapshotId).toBe(
      retained.currentSnapshotId
    )
  })

  test("retained review is exact, advances P24 inputs, reuses without publishing, and cancellation holds on a pointer mismatch", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner, ["adopt"])
    const pageId = ids.adopt!

    const predecessor = await startTransition(
      t,
      owner,
      "correct_label",
      "fr"
    )
    await drain(t)
    const retainedState = (await generations(t, pageId, "fr")).state!
    const retainedSnapshotId = retainedState.currentSnapshotId!
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) =>
          q.eq("transitionId", predecessor).eq("pageId", pageId)
        )
        .unique()
      await ctx.db.delete(row!._id)
      await ctx.db.patch(predecessor, {
        phase: "cancelled",
        cancelledAt: Date.now(),
      })
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { activeTransitionId: undefined })
    })

    const transitionId = await startTransition(
      t,
      owner,
      "replace_content",
      "fr"
    )
    await drain(t)
    let report = await owner.query(
      api.cms.language.listLanguageTransitionPages,
      {
        transitionId,
        paginationOpts: { numItems: 100, cursor: null },
      }
    )
    let row = report.page.find((candidate) => candidate.pageId === pageId)!
    expect(row).toMatchObject({
      status: "blocked",
      blockerCode: "TARGET_LOCALE_HAS_RETAINED_CONTENT",
      retainedTarget: {
        selection: { snapshotId: retainedSnapshotId },
      },
    })
    expect(
      await codeOf(
        owner.mutation(api.cms.language.setPageDisposition, {
          transitionId,
          pageId,
          disposition: "target",
          expectedPageGeneration: row.generation,
        })
      )
    ).toBe("TARGET_LOCALE_HAS_RETAINED_CONTENT")

    const staleDigest = row.retainedTarget!.reviewDigest
    const targetBefore = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "fr")
        )
        .unique()
    )
    await t.run((ctx) =>
      ctx.db.patch(targetBefore!._id, { updatedAt: targetBefore!.updatedAt + 1 })
    )
    expect(
      await codeOf(
        owner.mutation(api.cms.language.setPageDisposition, {
          transitionId,
          pageId,
          disposition: "target",
          expectedPageGeneration: row.generation,
          retainedTargetReview: {
            digest: staleDigest,
            basis: "retained_snapshot",
          },
        })
      )
    ).toBe("RETAINED_TARGET_REVIEW_STALE")
    expect(await rowOf(t, transitionId, pageId)).toMatchObject({
      status: "blocked",
      blockerCode: "TARGET_LOCALE_HAS_RETAINED_CONTENT",
    })

    await t.run((ctx) =>
      ctx.db.patch(targetBefore!._id, { updatedAt: targetBefore!.updatedAt })
    )
    report = await owner.query(api.cms.language.listLanguageTransitionPages, {
      transitionId,
      paginationOpts: { numItems: 100, cursor: null },
    })
    row = report.page.find((candidate) => candidate.pageId === pageId)!
    const beforeDecision = await transitionOf(t, transitionId)
    const decided = await owner.mutation(
      api.cms.language.setPageDisposition,
      {
        transitionId,
        pageId,
        disposition: "target",
        expectedPageGeneration: row.generation,
        retainedTargetReview: {
          digest: row.retainedTarget!.reviewDigest,
          basis: "retained_snapshot",
        },
      }
    )
    const afterDecision = await transitionOf(t, transitionId)
    expect(afterDecision.preparedSetVersion).toBe(
      beforeDecision.preparedSetVersion + 1
    )
    expect(afterDecision.carryInputVersion).toBe(
      (beforeDecision.carryInputVersion ?? 0) + 1
    )
    expect(
      await owner.mutation(api.cms.language.prepareTargetPage, {
        transitionId,
        pageId,
        expectedPageGeneration: decided.generation,
      })
    ).toMatchObject({ snapshotId: retainedSnapshotId })
    expect((await generations(t, pageId, "fr")).state).toMatchObject({
      currentSnapshotId: retainedSnapshotId,
      publicGeneration: retainedState.publicGeneration,
    })

    const preparedTransition = await transitionOf(t, transitionId)
    await t.run((ctx) =>
      ctx.db.patch(targetBefore!._id, {
        publicGeneration: retainedState.publicGeneration + 1,
      })
    )
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId,
      expectedGeneration: preparedTransition.generation,
      discardTargetDrafts: true,
    })
    await drain(t)
    expect(await transitionOf(t, transitionId)).toMatchObject({
      phase: "cancelling",
    })
    expect((await generations(t, pageId, "fr")).state).toMatchObject({
      currentSnapshotId: retainedSnapshotId,
      hasCurrentSnapshot: true,
    })
  })
})

describe("F09a replacement", () => {
  test("rows 11 and 12: the source stays public while unconfirmed or stale target text blocks readiness", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    const about = ids.about!
    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)
    expect(await transitionOf(t, id)).toMatchObject({ phase: "preparing" })
    expect(await rowOf(t, id, about)).toMatchObject({
      disposition: "undecided",
      status: "unready",
    })
    let row = (await rowOf(t, id, about))!
    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId: id,
      pageId: about,
      disposition: "target",
      expectedPageGeneration: row.generation,
    })

    // Copied text starts unconfirmed; so does a stubbed AI rewrite through the
    // ordinary target draft path. No AI is involved or required.
    const copy = await owner.mutation(
      api.cms.language.copySourceToTargetDraft,
      {
        transitionId: id,
        pageId: about,
        expectedSourceDraftGeneration: (await generations(t, about, "en"))
          .state!.draftGeneration,
        expectedLifecycleGeneration: 1,
      }
    )
    await saveDraft(t, owner, about, "fr", "a-propos", "À propos (IA)")
    expect(await publicProjection(t, about, "en")).not.toBeNull()
    expect(await publicProjection(t, about, "fr")).toBeNull()
    expect(copy.draftGeneration).toBe(1)
    row = (await rowOf(t, id, about))!
    expect(row.status).toBe("stale")
    expect(
      await codeOf(
        owner.mutation(api.cms.language.prepareTargetPage, {
          transitionId: id,
          pageId: about,
          expectedPageGeneration: row.generation,
        })
      )
    ).toBe("TARGET_CONFIRMATION_STALE")
    const transition = await transitionOf(t, id)
    expect(
      await codeOf(
        owner.mutation(api.cms.language.validateLanguageTransition, {
          transitionId: id,
          expectedGeneration: transition.generation,
        })
      )
    ).toBe("LANGUAGE_TRANSITION_NOT_RESOLVED")

    // Confirm the exact generations, then a Shared Draft edit stales them.
    const confirmFor = async () => {
      const current = await generations(t, about, "fr")
      const shared = (await generations(t, about, "en")).shared!
      const currentRow = (await rowOf(t, id, about))!
      await owner.mutation(api.cms.language.confirmTargetContent, {
        transitionId: id,
        pageId: about,
        expectedTargetDraftGeneration: current.state!.draftGeneration,
        expectedSharedDraftGeneration: shared.generation,
        expectedPageGeneration: currentRow.generation,
      })
    }
    await confirmFor()
    const shared = (await generations(t, about, "en")).shared!
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId: about,
      expectedSharedDraftGeneration: shared.generation,
      expectedLifecycleGeneration: 1,
      seo: { metaTitle: "À propos" },
    })
    row = (await rowOf(t, id, about))!
    expect(row.status).toBe("stale")
    expect(
      await codeOf(
        owner.mutation(api.cms.language.prepareTargetPage, {
          transitionId: id,
          pageId: about,
          expectedPageGeneration: row.generation,
        })
      )
    ).toBe("TARGET_CONFIRMATION_STALE")

    await confirmFor()
    row = (await rowOf(t, id, about))!
    const prepared = await owner.mutation(api.cms.language.prepareTargetPage, {
      transitionId: id,
      pageId: about,
      expectedPageGeneration: row.generation,
    })
    expect(prepared.snapshotId).not.toBeNull()
    expect(await rowOf(t, id, about)).toMatchObject({
      status: "ready",
      target: { path: "/a-propos" },
    })
    // The changed path keeps the source URL resolving in the target space.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("siteLanguageTransitionRoutes")
          .withIndex("by_transitionId_and_pageId", (q) =>
            q.eq("transitionId", id).eq("pageId", about)
          )
          .collect()
      )
    ).toMatchObject([{ fromPath: "/about", origin: "source_current" }])
    expect(await publicProjection(t, about, "fr")).toBeNull()
    expect(await publicProjection(t, about, "en")).not.toBeNull()
  })
})

describe("F09a freshness and coverage", () => {
  test("rows 31 and 36: late source pages need a row, and non-public settings writes stale readiness", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await englishSite(t, owner)
    const id = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)
    expect(await transitionOf(t, id)).toMatchObject({
      phase: "preparing",
      unresolvedCount: 0,
    })

    // Row 31: a Page first published after enumeration gets its own row.
    const late = await createPage(owner, "late")
    await publish(t, owner, late)
    expect(await rowOf(t, id, late)).toMatchObject({
      kind: "public_route",
      disposition: "target",
      status: "unready",
    })
    const afterLate = await transitionOf(t, id)
    expect(afterLate).toMatchObject({
      sourcePublicSetVersion: 1,
      unresolvedCount: 1,
    })
    await owner.mutation(api.cms.language.confirmTransitionPreview, {
      transitionId: id,
      expectedPreparedSetVersion: afterLate.preparedSetVersion,
    })
    const confirmed = await transitionOf(t, id)
    expect(
      await codeOf(
        owner.mutation(api.cms.language.validateLanguageTransition, {
          transitionId: id,
          expectedGeneration: confirmed.generation,
        })
      )
    ).toBe("LANGUAGE_TRANSITION_NOT_RESOLVED")
    await owner.mutation(api.cms.language.continueLanguageTransition, {
      transitionId: id,
      expectedGeneration: confirmed.generation,
    })
    await drain(t)
    expect(await rowOf(t, id, late)).toMatchObject({ status: "ready" })

    const ready = await confirmAndValidate(t, owner, id)
    expect(ready.phase).toBe("ready")
    expect(ready.manifest?.readinessVersion).toBe(1)

    // Row 36: a non-public settings save (`dateFormat` has no public reader)
    // still stales readiness. The AI configuration save records through the
    // same `recordPublicChange(ctx, { scopes: [] })` call.
    await owner.mutation(api.cms.settings.updateSettings, {
      dateFormat: "PPP",
    })
    const stale = await transitionOf(t, id)
    expect(stale).toMatchObject({
      phase: "preparing",
      sourcePublicSetVersion: ready.sourcePublicSetVersion + 1,
    })
    expect(stale.manifest?.sourcePublicSetVersion).not.toBe(
      stale.sourcePublicSetVersion
    )
    await owner.mutation(api.cms.language.validateLanguageTransition, {
      transitionId: id,
      expectedGeneration: stale.generation,
    })
    await drain(t)
    const revalidated = await transitionOf(t, id)
    const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
    expect(revalidated.phase).toBe("ready")
    // Activation's freshness preconditions (F09c) now hold.
    expect(revalidated.manifest).toMatchObject({
      readinessVersion: 2,
      sourcePublicSetVersion: revalidated.sourcePublicSetVersion,
      preparedSetVersion: revalidated.preparedSetVersion,
      settingsUpdatedAt: settings!.updatedAt,
      authorityVersion: 1,
    })

    // Validation is also accepted from `ready`.
    await owner.mutation(api.cms.language.validateLanguageTransition, {
      transitionId: id,
      expectedGeneration: revalidated.generation,
    })
    await drain(t)
    expect((await transitionOf(t, id)).manifest?.readinessVersion).toBe(3)
  })
})

// F09b proof: row 27 (server side), row 39 (server signal) and the generation
// tokens the owner workflow UI passes back.
describe("F09b owner workflow", () => {
  async function adminPreferenceRows(t: T) {
    return t.run((ctx) => ctx.db.query("userPreferences").collect())
  }

  test("row 27: a saved French admin language survives every replacement command on an English site", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    const about = ids.about!
    await owner.mutation(api.cms.userPreferences.setAdminLocale, {
      locale: "fr",
    })
    const saved = await adminPreferenceRows(t)
    expect(saved).toMatchObject([{ adminLocale: "fr" }])
    const expectUnchanged = async () => {
      expect(await adminPreferenceRows(t)).toEqual(saved)
      expect(
        await owner.query(api.cms.userPreferences.getAdminLocale, {})
      ).toBe("fr")
    }

    // Start with the exact tokens the workflow UI reads: `getSettings` for the
    // settings version and `getLanguageState` for the authority version.
    const uiSettings = await owner.query(api.cms.settings.getSettings, {})
    const uiState = await owner.query(api.cms.language.getLanguageState, {})
    const id = await owner.mutation(api.cms.language.startLanguageTransition, {
      mode: "replace_content",
      sourceLocale: uiState.currentLocale!,
      targetLocale: "nl",
      expectedSettingsUpdatedAt: uiSettings!.updatedAt,
      expectedAuthorityVersion: uiState.version!,
    })
    await drain(t)
    await expectUnchanged()
    let row = (await rowOf(t, id, about))!
    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId: id,
      pageId: about,
      disposition: "target",
      expectedPageGeneration: row.generation,
    })
    const report = await owner.query(
      api.cms.language.listLanguageTransitionPages,
      {
        transitionId: id,
        paginationOpts: { numItems: 10, cursor: null },
      }
    )
    const aboutReport = report.page.find((entry) => entry.pageId === about)!
    await owner.mutation(api.cms.language.copySourceToTargetDraft, {
      transitionId: id,
      pageId: about,
      expectedSourceDraftGeneration: aboutReport.sourceDraftGeneration,
      expectedLifecycleGeneration: aboutReport.lifecycleGeneration!,
    })
    await expectUnchanged()
    const copied = (
      await owner.query(api.cms.language.listLanguageTransitionPages, {
        transitionId: id,
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).page.find((entry) => entry.pageId === about)!
    expect(copied).toMatchObject({ hasTargetDraft: true, confirmed: false })
    await owner.mutation(api.cms.language.confirmTargetContent, {
      transitionId: id,
      pageId: about,
      expectedTargetDraftGeneration: copied.targetDraftGeneration!,
      expectedSharedDraftGeneration: copied.sharedDraftGeneration!,
      expectedPageGeneration: copied.generation,
    })
    row = (await rowOf(t, id, about))!
    await owner.mutation(api.cms.language.prepareTargetPage, {
      transitionId: id,
      pageId: about,
      expectedPageGeneration: row.generation,
    })
    await expectUnchanged()
    const before = await transitionOf(t, id)
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId: id,
      expectedGeneration: before.generation,
      discardTargetDrafts: true,
    })
    await drain(t)
    expect((await transitionOf(t, id)).phase).toBe("cancelled")
    // Activation is F09c; every F09a/F09b command above left the preference
    // untouched.
    await expectUnchanged()
  })

  test("row 39: the editor is told when a source publication would publish a changed Shared Draft during a replacement", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const stranger = t.withIdentity(STRANGER)
    const { ids } = await englishSite(t, owner)
    const about = ids.about!
    const notice = () =>
      owner.query(api.cms.language.getSourcePublicationNotice, {
        pageId: about,
      })

    expect(await notice()).toBeNull()
    const id = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)
    expect(await notice()).toEqual({
      sourceLocale: "en",
      targetLocale: "fr",
      sharedChangedSinceSourcePublication: false,
    })
    expect(
      await stranger.query(api.cms.language.getSourcePublicationNotice, {
        pageId: about,
      })
    ).toBeNull()

    const shared = (await generations(t, about, "en")).shared!
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId: about,
      expectedSharedDraftGeneration: shared.generation,
      expectedLifecycleGeneration: 1,
      seo: { metaTitle: "À propos" },
    })
    expect(await notice()).toMatchObject({
      sharedChangedSinceSourcePublication: true,
    })

    // Once published, the source snapshot carries that Shared Draft again. The
    // first publication consumed the Working Draft, so save one to republish.
    await saveDraft(t, owner, about, "en", "about", "about")
    await publish(t, owner, about)
    expect(await notice()).toMatchObject({
      sharedChangedSinceSourcePublication: false,
    })

    const open = await transitionOf(t, id)
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId: id,
      expectedGeneration: open.generation,
      discardTargetDrafts: false,
    })
    await drain(t)
    await startTransition(t, owner, "correct_label", "fr")
    await drain(t)
    // A label correction never publishes Shared Draft text, so no notice.
    expect(await notice()).toBeNull()
  })
})

describe("M05 P24 activation handoff (C3e.3c-1)", () => {
  test("activation refuses every missing or mismatched live receipt before writes", async () => {
    for (const corruption of [
      "missing_prepared",
      "mismatched_prepared",
      "missing_carry",
      "mismatched_carry",
    ] as const) {
      const { t, owner, transitionId } = await readyPointedReplacementFixture()
      await t.run(async (ctx) => {
        const transition = await ctx.db.get(transitionId)
        if (!transition) throw new Error("transition missing")
        await ctx.db.patch(
          transitionId,
          corruption === "missing_prepared"
            ? { previewConfirmedPreparedSetVersion: undefined }
            : corruption === "mismatched_prepared"
              ? {
                  previewConfirmedPreparedSetVersion:
                    transition.preparedSetVersion - 1,
                }
              : corruption === "missing_carry"
                ? { previewConfirmedCarryDecisionDigest: undefined }
                : {
                    previewConfirmedCarryDecisionDigest:
                      "sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
                  }
        )
      })
      const args = await activationArgs(t, transitionId)
      const before = await languageTables(t)

      expect({
        corruption,
        code: await codeOf(
          owner.mutation(api.cms.language.activateLanguageTransition, args)
        ),
      }).toEqual({ corruption, code: "LANGUAGE_TRANSITION_STALE" })
      expect(await languageTables(t)).toEqual(before)
    }
  })

  test("pointed activation clears the pointer with the commit and retains carry decisions", async () => {
    const { t, owner, transitionId } = await readyPointedReplacementFixture()
    const decisionsBefore = await t.run((ctx) =>
      ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect()
    )

    await activate(t, owner, transitionId)

    const committed = await t.run(async (ctx) => ({
      authority: await ctx.db.query("siteLanguageAuthority").unique(),
      transition: await ctx.db.get(transitionId),
      decisions: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .collect(),
    }))
    expect(committed.authority).toMatchObject({
      lastCommittedTransitionId: transitionId,
    })
    expect(committed.authority?.activeTransitionId).toBeUndefined()
    expect(committed.authority?.continuityPointer).toBeUndefined()
    expect(committed.transition?.phase).toBe("committed")
    expect(committed.decisions).toEqual(decisionsBefore)
  })

  test("activation fails closed when the live pointer and carry corpus disagree", async () => {
    for (const corruption of ["missing_pointer", "missing_corpus"] as const) {
      const { t, owner, transitionId } = await readyPointedReplacementFixture()
      await t.run(async (ctx) => {
        if (corruption === "missing_pointer") {
          const authority = await ctx.db.query("siteLanguageAuthority").unique()
          if (!authority) throw new Error("authority missing")
          await ctx.db.patch(authority._id, { continuityPointer: undefined })
          return
        }
        await ctx.db.patch(transitionId, {
          carryDecisionDigest: undefined,
          previewConfirmedCarryDecisionDigest: undefined,
        })
      })
      const args = await activationArgs(t, transitionId)
      const before = await languageTables(t)

      expect({
        corruption,
        code: await codeOf(
          owner.mutation(api.cms.language.activateLanguageTransition, args)
        ),
      }).toEqual({ corruption, code: "LANGUAGE_TRANSITION_STALE" })
      expect(await languageTables(t)).toEqual(before)
    }
  })

  test("activation preserves no-pointer compatibility", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { id } = await readyCorrection(t, owner)

    await activate(t, owner, id)

    const stored = await t.run(async (ctx) => ({
      authority: await ctx.db.query("siteLanguageAuthority").unique(),
      decisions: await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", id)
        )
        .collect(),
    }))
    expect(stored.authority).toMatchObject({
      lastCommittedTransitionId: id,
    })
    expect(stored.authority?.continuityPointer).toBeUndefined()
    expect(stored.decisions).toEqual([])
  })

  test("P11c activation stays fixed for small and dense pointed corpora", async () => {
    const measurements: Array<{ routeCount: number; used: CarryMetrics }> = []
    for (const routeCount of [1, 33]) {
      const { t, transitionId } =
        await readyPointedReplacementFixture(routeCount)
      const args = await activationArgs(t, transitionId)
      const used = await t.run(async (ctx) => {
        await activateLanguageTransitionInTransaction(ctx, args)
        return usedCarryMetrics(ctx)
      })
      measurements.push({ routeCount, used })
    }

    for (const metric of [
      "databaseQueries",
      "documentsRead",
      "documentsWritten",
      "functionsScheduled",
    ] as const) {
      expect(new Set(measurements.map(({ used }) => used[metric])).size).toBe(1)
    }
    for (const { routeCount, used } of measurements) {
      expect({
        routeCount,
        databaseQueries: used.databaseQueries,
        documentsRead: used.documentsRead,
        documentsWritten: used.documentsWritten,
        functionsScheduled: used.functionsScheduled,
      }).toEqual({
        routeCount,
        databaseQueries: 7,
        documentsRead: 7,
        documentsWritten: 3,
        functionsScheduled: 1,
      })
      expect(used.bytesRead).toBeLessThanOrEqual(4 * MIB)
      expect(used.bytesWritten).toBeLessThanOrEqual(MIB)
      expect(used.scheduledFunctionArgsBytes).toBeLessThanOrEqual(64 * KIB)
    }
  })
})

describe("M05 P24 cancellation cleanup (C3e.3c-2)", () => {
  test("deletes 33 carry decisions in bounded pages before terminal cancellation releases the authority slot", async () => {
    const { t, owner, homeId, transitionId } =
      await preparedPointedReplacementFixture(33)
    const retainedArtifacts = () =>
      t.run(async (ctx) => ({
        pointer: (await ctx.db.query("siteLanguageAuthority").unique())
          ?.continuityPointer,
        routes: await ctx.db
          .query("siteLanguageTransitionRoutes")
          .withIndex("by_transitionId_and_fromPath", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect(),
        snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
        candidates: await ctx.db
          .query("pageLocalePublicationCandidates")
          .collect(),
        sourceState: await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", homeId).eq("locale", "en")
          )
          .unique(),
      }))
    const retainedBefore = await retainedArtifacts()
    const beforeCancel = await transitionOf(t, transitionId)
    const cancel = await owner.mutation(
      api.cms.language.cancelLanguageTransition,
      {
        transitionId,
        expectedGeneration: beforeCancel.generation,
        discardTargetDrafts: false,
      }
    )
    const step = () =>
      t.run((ctx) =>
        runLanguageTransitionStep(ctx, transitionId, cancel.generation)
      )
    const cancellationState = () =>
      t.run(async (ctx) => ({
        transition: await ctx.db.get(transitionId),
        authority: await ctx.db.query("siteLanguageAuthority").unique(),
        decisions: await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect(),
      }))
    const paginate = vi.spyOn(languageCarrySeam, "paginate")

    try {
      const initiated = await cancellationState()
      expect(initiated.transition).toMatchObject({
        phase: "cancelling",
        generation: cancel.generation,
        targetDrafts: "retained",
      })
      expect(JSON.parse(initiated.transition!.cursor!)).toEqual({
        part: "pages",
        cursor: null,
        failed: false,
        passes: 0,
      })
      expect(initiated.authority?.activeTransitionId).toBe(transitionId)
      expect(initiated.decisions).toHaveLength(33)

      await step()
      const afterPages = await cancellationState()
      expect(afterPages.transition?.phase).toBe("cancelling")
      expect(JSON.parse(afterPages.transition!.cursor!)).toMatchObject({
        part: "carry_decisions",
        cursor: null,
      })
      expect(afterPages.authority?.activeTransitionId).toBe(transitionId)
      expect(afterPages.decisions).toHaveLength(33)
      expect(paginate).toHaveBeenCalledTimes(0)

      await step()
      const afterFirstDecisionPage = await cancellationState()
      expect(afterFirstDecisionPage.transition?.phase).toBe("cancelling")
      expect(JSON.parse(afterFirstDecisionPage.transition!.cursor!)).toEqual({
        part: "carry_decisions",
        cursor: expect.any(String),
      })
      expect(afterFirstDecisionPage.authority?.activeTransitionId).toBe(
        transitionId
      )
      expect(afterFirstDecisionPage.decisions).toHaveLength(1)
      expect(paginate).toHaveBeenCalledTimes(1)
      expect(paginate.mock.calls[0]?.[1]).toMatchObject({ numItems: 32 })
      expect(await retainedArtifacts()).toEqual(retainedBefore)

      await step()
      const completed = await cancellationState()
      expect(completed.transition).toMatchObject({ phase: "cancelled" })
      expect(completed.transition?.cursorPhase).toBeUndefined()
      expect(completed.transition?.cursor).toBeUndefined()
      expect(completed.authority?.activeTransitionId).toBeUndefined()
      expect(completed.decisions).toEqual([])
      expect(paginate).toHaveBeenCalledTimes(2)
    } finally {
      paginate.mockRestore()
    }
  })

  test("deletes only this transition's decisions and preserves every retained artifact", async () => {
    const { t, owner, homeId, transitionId } =
      await preparedPointedReplacementFixture(2)
    const otherTransitionId = await t.run(async (ctx) => {
      const transition = await ctx.db.get(transitionId)
      const decision = await ctx.db
        .query("siteLanguageCarryDecisions")
        .withIndex("by_transitionId_and_routeId", (q) =>
          q.eq("transitionId", transitionId)
        )
        .first()
      if (!transition || !decision) throw new Error("fixture incomplete")
      const { _id, _creationTime, ...transitionFields } = transition
      void _id
      void _creationTime
      const otherId = await ctx.db.insert("siteLanguageTransitions", {
        ...transitionFields,
        phase: "cancelled",
        cursorPhase: undefined,
        cursor: undefined,
        cancelledAt: Date.now(),
      })
      const {
        _id: _decisionId,
        _creationTime: _decisionCreationTime,
        ...decisionFields
      } = decision
      void _decisionId
      void _decisionCreationTime
      await ctx.db.insert("siteLanguageCarryDecisions", {
        ...decisionFields,
        transitionId: otherId,
      })
      return otherId
    })
    const retainedArtifacts = () =>
      t.run(async (ctx) => ({
        pointer: (await ctx.db.query("siteLanguageAuthority").unique())
          ?.continuityPointer,
        routes: await ctx.db
          .query("siteLanguageTransitionRoutes")
          .withIndex("by_transitionId_and_fromPath", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect(),
        snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
        candidates: await ctx.db
          .query("pageLocalePublicationCandidates")
          .collect(),
        sourceState: await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", homeId).eq("locale", "en")
          )
          .unique(),
        otherDecisions: await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", otherTransitionId)
          )
          .collect(),
      }))
    const before = await retainedArtifacts()
    const open = await transitionOf(t, transitionId)

    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId,
      expectedGeneration: open.generation,
      discardTargetDrafts: false,
    })
    await drain(t)

    expect(
      await t.run((ctx) =>
        ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect()
      )
    ).toEqual([])
    expect(await retainedArtifacts()).toEqual(before)
  })

  test.each([
    { discardTargetDrafts: false, targetDrafts: "retained", keepsDraft: true },
    {
      discardTargetDrafts: true,
      targetDrafts: "discarded",
      keepsDraft: false,
    },
  ] as const)(
    "keeps no-pointer cancellation compatible when target drafts finish as $targetDrafts",
    async ({ discardTargetDrafts, targetDrafts, keepsDraft }) => {
      const t = app()
      const owner = t.withIdentity(OWNER)
      const homeId = await bootstrap(t, owner)
      await publish(t, owner, homeId)
      const transitionId = await startTransition(
        t,
        owner,
        "replace_content",
        "fr"
      )
      await drain(t)
      const row = (await rowOf(t, transitionId, homeId))!
      await owner.mutation(api.cms.language.setPageDisposition, {
        transitionId,
        pageId: homeId,
        disposition: "target",
        expectedPageGeneration: row.generation,
      })
      await owner.mutation(api.cms.language.copySourceToTargetDraft, {
        transitionId,
        pageId: homeId,
        expectedSourceDraftGeneration: (await generations(t, homeId, "en"))
          .state!.draftGeneration,
        expectedLifecycleGeneration: 1,
      })
      const open = await transitionOf(t, transitionId)

      await owner.mutation(api.cms.language.cancelLanguageTransition, {
        transitionId,
        expectedGeneration: open.generation,
        discardTargetDrafts,
      })
      await drain(t)

      const stored = await t.run(async (ctx) => ({
        transition: await ctx.db.get(transitionId),
        authority: await ctx.db.query("siteLanguageAuthority").unique(),
        decisions: await ctx.db
          .query("siteLanguageCarryDecisions")
          .withIndex("by_transitionId_and_routeId", (q) =>
            q.eq("transitionId", transitionId)
          )
          .collect(),
        draft: await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", homeId).eq("locale", "fr")
          )
          .unique(),
        targetState: await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", homeId).eq("locale", "fr")
          )
          .unique(),
      }))
      expect(stored.transition).toMatchObject({
        phase: "cancelled",
        targetDrafts,
      })
      expect(stored.authority?.continuityPointer).toBeUndefined()
      expect(stored.authority?.activeTransitionId).toBeUndefined()
      expect(stored.decisions).toEqual([])
      expect(Boolean(stored.draft)).toBe(keepsDraft)
      expect(stored.targetState).toMatchObject({ hasCurrentSnapshot: false })
    }
  )

  test("F01/R2 exposes only the cancelled blocker draft to the owner, then removes that draft without changing public snapshots", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const stranger = t.withIdentity(STRANGER)
    const { ids } = await englishSite(t, owner)
    const about = ids.about!
    const attribution = await t.run(async (ctx) => {
      const state = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "en")
        )
        .unique()
      return (await ctx.db.get(state!.currentSnapshotId!))!.attribution
    })
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("pageLocalePublicationStates", {
        pageId: about,
        locale: "fr",
        draftGeneration: 1,
        publicGeneration: 0,
        releaseGeneration: 0,
        hasCurrentSnapshot: false,
        updatedAt: now,
      })
      await ctx.db.insert("pageLocaleDrafts", {
        pageId: about,
        locale: "fr",
        pageType: "landing-page",
        generation: 1,
        slug: "a-propos",
        content: { title: "Brouillon conserve", slices: [] },
        updatedBy: attribution,
        createdAt: now,
        updatedAt: now,
      } as never)
    })

    const transitionId = await startTransition(
      t,
      owner,
      "replace_content",
      "fr"
    )
    await drain(t)
    expect(await rowOf(t, transitionId, about)).toMatchObject({
      status: "blocked",
      blockerCode: "TARGET_LOCALE_HAS_RETAINED_CONTENT",
      target: { draftCreatedByTransition: false },
    })
    expect(
      await owner.query(api.cms.language.getRetainedTargetDraftRemedy, {
        pageId: about,
      })
    ).toBeNull()

    const open = await transitionOf(t, transitionId)
    await owner.mutation(api.cms.language.cancelLanguageTransition, {
      transitionId,
      expectedGeneration: open.generation,
      discardTargetDrafts: false,
    })
    await drain(t)

    const remedy = await owner.query(
      api.cms.language.getRetainedTargetDraftRemedy,
      { pageId: about }
    )
    expect(remedy).toEqual({
      transitionId,
      pageId: about,
      locale: "fr",
      draftGeneration: 1,
      lifecycleGeneration: 1,
    })
    expect(
      await stranger.query(api.cms.language.getRetainedTargetDraftRemedy, {
        pageId: about,
      })
    ).toBeNull()

    const before = await t.run(async (ctx) => ({
      snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
      current: await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "en")
        )
        .unique(),
    }))
    expect(
      await codeOf(
        stranger.mutation(api.cms.language.deleteRetainedTargetDraft, remedy!)
      )
    ).toBe("CMS_OWNER_REQUIRED")
    expect(
      await codeOf(
        owner.mutation(api.cms.language.deleteRetainedTargetDraft, {
          ...remedy!,
          draftGeneration: 0,
        })
      )
    ).toBe("PAGE_LOCALE_DRAFT_STALE")

    await owner.mutation(api.cms.language.deleteRetainedTargetDraft, remedy!)

    expect(
      await owner.query(api.cms.language.getRetainedTargetDraftRemedy, {
        pageId: about,
      })
    ).toBeNull()
    const after = await t.run(async (ctx) => ({
      snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
      current: await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "en")
        )
        .unique(),
      target: await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "fr")
        )
        .unique(),
      draft: await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "fr")
        )
        .unique(),
    }))
    expect(after.snapshots).toEqual(before.snapshots)
    expect(after.current).toEqual(before.current)
    expect(after.target).toMatchObject({
      hasCurrentSnapshot: false,
      publicGeneration: 0,
      draftGeneration: 2,
    })
    expect(after.draft).toBeNull()

    const retry = await startTransition(t, owner, "replace_content", "fr")
    await drain(t)
    expect(await rowOf(t, retry, about)).not.toMatchObject({
      blockerCode: "TARGET_LOCALE_HAS_RETAINED_CONTENT",
    })
  })

  test("P11c bounds a full carry-decision deletion page across all seven metrics", async () => {
    const { t, owner, transitionId } =
      await preparedPointedReplacementFixture(33)
    const open = await transitionOf(t, transitionId)
    const cancel = await owner.mutation(
      api.cms.language.cancelLanguageTransition,
      {
        transitionId,
        expectedGeneration: open.generation,
        discardTargetDrafts: false,
      }
    )
    await t.run((ctx) =>
      runLanguageTransitionStep(ctx, transitionId, cancel.generation)
    )

    const paginate = vi.spyOn(languageCarrySeam, "paginate")
    try {
      const used = await t.run(async (ctx) => {
        await runLanguageTransitionStep(ctx, transitionId, cancel.generation)
        return usedCarryMetrics(ctx)
      })
      expect(paginate).toHaveBeenCalledTimes(1)
      expect({
        databaseQueries: used.databaseQueries,
        documentsRead: used.documentsRead,
        documentsWritten: used.documentsWritten,
        functionsScheduled: used.functionsScheduled,
      }).toEqual({
        databaseQueries: 4,
        documentsRead: 68,
        documentsWritten: 33,
        functionsScheduled: 1,
      })
      expect(used.bytesRead).toBeLessThanOrEqual(4 * MIB)
      expect(used.bytesWritten).toBeLessThanOrEqual(MIB)
      expect(used.scheduledFunctionArgsBytes).toBeLessThanOrEqual(64 * KIB)

      const finalUsed = await t.run(async (ctx) => {
        await runLanguageTransitionStep(ctx, transitionId, cancel.generation)
        return usedCarryMetrics(ctx)
      })
      expect(paginate).toHaveBeenCalledTimes(2)
      expect({
        databaseQueries: finalUsed.databaseQueries,
        documentsRead: finalUsed.documentsRead,
        documentsWritten: finalUsed.documentsWritten,
        functionsScheduled: finalUsed.functionsScheduled,
      }).toEqual({
        databaseQueries: 5,
        documentsRead: 8,
        documentsWritten: 3,
        functionsScheduled: 0,
      })
      expect(finalUsed.bytesRead).toBeLessThanOrEqual(4 * MIB)
      expect(finalUsed.bytesWritten).toBeLessThanOrEqual(MIB)
      expect(finalUsed.scheduledFunctionArgsBytes).toBeLessThanOrEqual(64 * KIB)
    } finally {
      paginate.mockRestore()
    }
  })
})

describe("F09c F1 readiness and bounded activation", () => {
  test("rows 4, 18, 24, 27 and 29: only the owner commits the three-row language pointer and one revalidation", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const stranger = t.withIdentity(STRANGER)
    const { ids, id, ready } = await readyCorrection(t, owner)
    const about = ids.about!
    const targetBefore = await t.run((ctx) => ctx.db.query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", about).eq("locale", "fr")).unique())
    expect(targetBefore).toMatchObject({ pageType: "landing-page", publicSince: targetBefore!.currentPublishedAt })
    expect(await t.query(api.cms.pages.listRecentPublicRelationCards, {
      languageVersion: 1, pageType: "landing-page", locale: "fr", limit: 12,
    })).toEqual([])
    await owner.mutation(api.cms.userPreferences.setAdminLocale, {
      locale: "fr",
    })
    const preferencesBefore = await t.run((ctx) =>
      ctx.db.query("userPreferences").collect()
    )
    const args = await activationArgs(t, id)
    const before = await languageTables(t)

    await expect(
      stranger.mutation(api.cms.language.activateLanguageTransition, args)
    ).rejects.toThrow()
    expect(await languageTables(t)).toEqual(before)

    expect(
      await owner.mutation(api.cms.language.activateLanguageTransition, args)
    ).toEqual({ transitionId: id, version: 2, currentLocale: "fr" })
    const committed = await t.run(async (ctx) => ({
      settings: await ctx.db.query("siteSettings").unique(),
      authority: await ctx.db.query("siteLanguageAuthority").unique(),
      transition: await ctx.db.get(id),
      preferences: await ctx.db.query("userPreferences").collect(),
      sourceState: await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "en")
        )
        .unique(),
      targetState: await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", about).eq("locale", "fr")
        )
        .unique(),
    }))
    expect(committed.settings).toMatchObject({
      defaultLocale: "fr",
      enabledLocales: ["fr"],
    })
    expect(committed.authority).toMatchObject({
      version: 2,
      currentLocale: "fr",
      lastCommittedTransitionId: id,
    })
    expect(committed.authority!.activeTransitionId).toBeUndefined()
    expect(committed.transition).toMatchObject({
      phase: "committed",
      generation: ready.generation + 1,
      committedAuthorityVersion: 2,
    })
    expect(committed.sourceState?.hasCurrentSnapshot).toBe(true)
    expect(committed.targetState?.hasCurrentSnapshot).toBe(true)
    expect(committed.targetState?.publicSince).toBe(targetBefore!.publicSince)
    expect(await t.query(api.cms.pages.listRecentPublicRelationCards, {
      languageVersion: 2, pageType: "landing-page", locale: "fr", limit: 12,
    })).toContainEqual(expect.objectContaining({ pageId: about }))
    expect(committed.preferences).toEqual(preferencesBefore)
    expect(await publicProjection(t, about, "en")).toBeNull()
    expect(await publicProjection(t, about, "fr")).not.toBeNull()
    expect(
      await codeOf(saveDraft(t, owner, about, "en", "about", "retired source"))
    ).toBe("LOCALE_NOT_ENABLED")

    // A second activation is a losing compare-and-set with no fragment.
    const afterFirst = await languageTables(t)
    expect(
      await codeOf(
        owner.mutation(api.cms.language.activateLanguageTransition, args)
      )
    ).toBe("LANGUAGE_TRANSITION_NOT_OPEN")
    expect(await languageTables(t)).toEqual(afterFirst)

    await drain(t)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("revalidationAttempts")
          .withIndex("by_timestamp")
          .order("desc")
          .first()
      )
    ).toMatchObject({ target: "settings", pathCount: 3, tagCount: 3 })
  })

  test.each(["correct_label", "replace_content"] as const)(
    "row 3: the %s short path switches language without a candidate or snapshot",
    async (mode) => {
      const t = app()
      const owner = t.withIdentity(OWNER)
      await bootstrap(t, owner)
      const id = await startTransition(t, owner, mode, "fr")
      await drain(t)
      const ready = await confirmAndValidate(t, owner, id)
      expect(ready).toMatchObject({ phase: "ready", shortPath: true })

      await activate(t, owner, id)
      const stored = await t.run(async (ctx) => ({
        settings: await ctx.db.query("siteSettings").unique(),
        candidates: await ctx.db
          .query("pageLocalePublicationCandidates")
          .collect(),
        snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
      }))
      expect(stored.settings).toMatchObject({
        defaultLocale: "fr",
        enabledLocales: ["fr"],
      })
      expect(stored.candidates).toEqual([])
      expect(stored.snapshots).toEqual([])
    }
  )

  test("rows 20 and 29: every registered public reader refuses a stale release version", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids, id } = await readyCorrection(t, owner)
    const about = ids.about!
    await activate(t, owner, id)

    const staleReads: Array<() => Promise<unknown>> = [
      () =>
        t.query(api.cms.pages.getPublicPageById, {
          id: about,
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.getPublicByline, {
          authorPageId: about,
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.getSitemapIndex, {
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.getSitemapChild, {
          languageVersion: 1,
          manifestVersion: 0,
          locale: "fr",
          ordinal: 0,
        }),
      () =>
        t.query(api.cms.pages.getLocalizedPathsByIds, {
          ids: [about],
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.getPublicRelationCardsByIds, {
          ids: [about],
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.listRecentPublicRelationCards, {
          pageType: "page",
          limit: 1,
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.getLocalizedBreadcrumb, {
          pageId: about,
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.getPublicLocaleAlternates, {
          pageId: about,
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.getAllLocalizedPageUrls, {
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.resolveHistoricalPublishedPath, {
          path: "/about",
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.pages.resolveLocalizedPathQuery, {
          path: "/about",
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.menus.getWithResolvedLinks, {
          slug: "primary",
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.redirects.resolve, {
          path: "/old-about",
          locale: "fr",
          languageVersion: 1,
        }),
      () =>
        t.query(api.cms.redirects.listActiveKeys, {
          languageVersion: 1,
        }),
    ]

    for (const read of staleReads) {
      expect(await codeOf(read())).toBe("SITE_LANGUAGE_VERSION_CHANGED")
    }

    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        id: about,
        locale: "fr",
        languageVersion: 2,
      })
    ).resolves.not.toBeNull()
    await expect(
      t.query(api.cms.settings.getSiteConfig, {})
    ).resolves.toMatchObject({
      defaultLocale: "fr",
      enabledLocales: ["fr"],
      languageVersion: 2,
    })
  })

  // Order 12 P2 stored-D row "invalid stored Settings/backend result": the
  // shipped Settings writer refuses these shapes, so they can only exist as
  // stored data (import, manual edit, older bug). The public site-config
  // reader must refuse them with the integrity code, never guess a locale.
  test.each(
    (["current authority", "version 0"] as const).flatMap((install) =>
      (
        [
          ["default locale not enabled", { defaultLocale: "fr", enabledLocales: ["en"] }],
          ["duplicate enabled locale", { defaultLocale: "en", enabledLocales: ["en", "en"] }],
          ["no enabled locale", { defaultLocale: "en", enabledLocales: [] }],
        ] as const
      ).map(([label, patch]) => [install, label, patch] as const)
    )
  )(
    "stored invalid Settings (%s, %s) make the public site config refuse",
    async (install, _label, patch) => {
      const t = app(install === "version 0" ? "legacy" : "missing")
      const owner = t.withIdentity(OWNER)
      if (install === "version 0") {
        await t.run((ctx) =>
          ctx.db.insert("siteSettings", {
            siteName: "Version 0",
            siteUrl: "",
            defaultLocale: "en",
            enabledLocales: ["en"],
            updatedAt: 1,
          })
        )
      } else {
        await bootstrap(t, owner)
      }
      await expect(
        t.query(api.cms.settings.getSiteConfig, {})
      ).resolves.toMatchObject({ defaultLocale: "en", enabledLocales: ["en"] })
      await t.run(async (ctx) => {
        const settings = await ctx.db.query("siteSettings").unique()
        await ctx.db.patch("siteSettings", settings!._id, {
          defaultLocale: patch.defaultLocale,
          enabledLocales: [...patch.enabledLocales],
        })
      })
      expect(await codeOf(t.query(api.cms.settings.getSiteConfig, {}))).toBe(
        "SITE_LANGUAGE_AUTHORITY_INVALID"
      )
    }
  )
  test("row 21: a committed continuity route redirects only inside the target locale", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids, id } = await readyCorrection(t, owner)
    const about = ids.about!
    await activate(t, owner, id)
    await t.run((ctx) =>
      ctx.db.insert("siteLanguageTransitionRoutes", {
        transitionId: id,
        fromPath: "/old-about",
        pageId: about,
        origin: "source_current",
        createdAt: Date.now(),
      })
    )

    await expect(
      t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        path: "/about",
        locale: "fr",
        languageVersion: 2,
      })
    ).resolves.toMatchObject({ disposition: "current", pageId: about })
    await expect(
      t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        path: "/old-about",
        locale: "fr",
        languageVersion: 2,
      })
    ).resolves.toMatchObject({
      disposition: "historical_redirect",
      pageId: about,
      locale: "fr",
      destinationPath: "/about",
      statusCode: 307,
    })
    await expect(
      t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        path: "/old-about",
        locale: "en",
        languageVersion: 2,
      })
    ).resolves.toMatchObject({ disposition: "unclaimed" })
  })

  test("row 35: correction commits copied Menu text that resolves in the target language", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    await owner.mutation(api.cms.menus.createCanonical, { slug: "primary" })
    await owner.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      locale: "en",
      nav: [
        {
          id: "about",
          label: { en: "About" },
          target: { type: "internal", pageId: ids.about! },
        },
      ],
    })
    const id = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)
    await confirmAndValidate(t, owner, id)
    await activate(t, owner, id)

    await expect(
      t.query(api.cms.menus.getWithResolvedLinks, {
        slug: "primary",
        locale: "fr",
        languageVersion: 2,
      })
    ).resolves.toMatchObject({
      nav: [
        {
          id: "about",
          label: "About",
          target: { type: "internal", url: "/about" },
        },
      ],
    })
  })

  test.each(["edit", "publish", "withdraw"] as const)(
    "row 13: a source %s stales readiness, refuses old activation and resumes",
    async (operation) => {
      const t = app()
      const owner = t.withIdentity(OWNER)
      const { ids } = await englishSite(t, owner)
      const about = ids.about!
      if (operation === "publish") {
        await saveDraft(t, owner, about, "en", "about", "Republished source")
      }
      const id = await startTransition(t, owner, "correct_label", "fr")
      await drain(t)
      const ready = await confirmAndValidate(t, owner, id)
      const args = await activationArgs(t, id)

      if (operation === "edit") {
        const state = (await generations(t, about, "en")).state!
        await owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId: about,
          expectedLifecycleGeneration: 1,
          localized: {
            locale: "en",
            slug: "about",
            draft: {
              pageType: "landing-page",
              localized: { title: "Unpublished source edit" },
              slices: [],
            },
            expectedGeneration: state.draftGeneration,
          },
        })
      } else if (operation === "publish") {
        await publish(t, owner, about)
      } else {
        const state = (await generations(t, about, "en")).state!
        await owner.mutation(api.cms.publication.withdrawLocale, {
          pageId: about,
          locale: "en",
          expectedSnapshotId: state.currentSnapshotId!,
          expectedPublicGeneration: state.publicGeneration,
          expectedLifecycleGeneration: 1,
        })
      }
      const stale = await transitionOf(t, id)
      expect(stale).toMatchObject({
        phase: "preparing",
        sourcePublicSetVersion: ready.sourcePublicSetVersion + 1,
        unresolvedCount: 1,
      })
      expect(await rowOf(t, id, about)).toMatchObject({ status: "stale" })
      expect(
        await codeOf(
          owner.mutation(api.cms.language.activateLanguageTransition, args)
        )
      ).toBe("LANGUAGE_TRANSITION_STALE")

      if (operation === "withdraw") {
        const row = (await rowOf(t, id, about))!
        await owner.mutation(api.cms.language.setPageDisposition, {
          transitionId: id,
          pageId: about,
          disposition: "withdraw",
          expectedPageGeneration: row.generation,
        })
      } else {
        await owner.mutation(api.cms.language.continueLanguageTransition, {
          transitionId: id,
          expectedGeneration: stale.generation,
        })
        await drain(t)
      }
      const revalidated = await confirmAndValidate(t, owner, id)
      expect(revalidated.manifest?.readinessVersion).toBe(2)
      await activate(t, owner, id)
      expect((await transitionOf(t, id)).phase).toBe("committed")
    }
  )

  test("row 13: a manifest counter mismatch refuses and revalidation recovers", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { id } = await readyCorrection(t, owner)
    const args = await activationArgs(t, id)
    await t.run(async (ctx) => {
      const transition = await ctx.db.get(id)
      await ctx.db.patch(id, {
        sourcePublicSetVersion: transition!.sourcePublicSetVersion + 1,
      })
    })
    expect(
      await codeOf(
        owner.mutation(api.cms.language.activateLanguageTransition, args)
      )
    ).toBe("LANGUAGE_TRANSITION_STALE")
    expect((await transitionOf(t, id)).phase).toBe("ready")

    await owner.mutation(api.cms.language.validateLanguageTransition, {
      transitionId: id,
      expectedGeneration: args.expectedGeneration,
    })
    await drain(t)
    expect((await transitionOf(t, id)).manifest?.readinessVersion).toBe(2)
    await activate(t, owner, id)
  })

  test("row 14: changing a disposition invalidates readiness and can be prepared again", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids, id } = await readyCorrection(t, owner)
    const about = ids.about!
    const args = await activationArgs(t, id)
    let row = (await rowOf(t, id, about))!

    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId: id,
      pageId: about,
      disposition: "withdraw",
      expectedPageGeneration: row.generation,
    })
    expect(
      await codeOf(
        owner.mutation(api.cms.language.activateLanguageTransition, args)
      )
    ).toBe("LANGUAGE_TRANSITION_STALE")
    row = (await rowOf(t, id, about))!
    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId: id,
      pageId: about,
      disposition: "target",
      expectedPageGeneration: row.generation,
    })
    const transition = await transitionOf(t, id)
    await owner.mutation(api.cms.language.continueLanguageTransition, {
      transitionId: id,
      expectedGeneration: transition.generation,
    })
    await drain(t)
    await confirmAndValidate(t, owner, id)
    await activate(t, owner, id)
    expect((await transitionOf(t, id)).phase).toBe("committed")
  })

  test("rows 15 and 16: readiness blocks a withdrawn home and target ancestry that points to a withdrawal", async () => {
    const soleHomeCase = app()
    const soleHomeOwner = soleHomeCase.withIdentity(OWNER)
    const soleHomeId = await bootstrap(soleHomeCase, soleHomeOwner)
    await publish(soleHomeCase, soleHomeOwner, soleHomeId)
    const soleHomeTransition = await startTransition(
      soleHomeCase,
      soleHomeOwner,
      "correct_label",
      "fr"
    )
    await drain(soleHomeCase)
    const soleHomeRow = (await rowOf(
      soleHomeCase,
      soleHomeTransition,
      soleHomeId
    ))!
    await soleHomeOwner.mutation(api.cms.language.setPageDisposition, {
      transitionId: soleHomeTransition,
      pageId: soleHomeId,
      disposition: "withdraw",
      expectedPageGeneration: soleHomeRow.generation,
    })
    await confirmAndValidate(
      soleHomeCase,
      soleHomeOwner,
      soleHomeTransition
    )
    expect(
      await rowOf(soleHomeCase, soleHomeTransition, soleHomeId)
    ).toMatchObject({
      status: "blocked",
      blockerCode: "HOME_NOT_TARGET",
    })

    const homeCase = app()
    const homeOwner = homeCase.withIdentity(OWNER)
    const { homeId, id: homeTransition } = await readyCorrection(
      homeCase,
      homeOwner
    )
    const homeRow = (await rowOf(homeCase, homeTransition, homeId))!
    await homeOwner.mutation(api.cms.language.setPageDisposition, {
      transitionId: homeTransition,
      pageId: homeId,
      disposition: "withdraw",
      expectedPageGeneration: homeRow.generation,
    })
    await confirmAndValidate(homeCase, homeOwner, homeTransition)
    expect(await rowOf(homeCase, homeTransition, homeId)).toMatchObject({
      status: "blocked",
      blockerCode: "HOME_NOT_TARGET",
    })

    const ancestryCase = app()
    const ancestryOwner = ancestryCase.withIdentity(OWNER)
    const root = await bootstrap(ancestryCase, ancestryOwner)
    await publish(ancestryCase, ancestryOwner, root)
    const parent = await createPage(ancestryOwner, "parent")
    const child = await createPage(ancestryOwner, "child")
    await publish(ancestryCase, ancestryOwner, parent)
    await ancestryCase.run(async (ctx) => {
      const shared = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", child))
        .unique()
      await ctx.db.patch(shared!._id, { system: { parentId: parent } })
    })
    await publish(ancestryCase, ancestryOwner, child)
    const ancestryTransition = await startTransition(
      ancestryCase,
      ancestryOwner,
      "correct_label",
      "fr"
    )
    await drain(ancestryCase)
    const parentRow = (await rowOf(ancestryCase, ancestryTransition, parent))!
    // The normal command refuses this before it can become malformed because
    // the child holds an ancestry reference. Inject the impossible manifest
    // shape to prove validation itself still fails closed if storage drifts.
    await ancestryCase.run(async (ctx) => {
      const transition = await ctx.db.get(ancestryTransition)
      await ctx.db.patch(parentRow._id, {
        disposition: "withdraw",
        generation: parentRow.generation + 1,
      })
      await ctx.db.patch(ancestryTransition, {
        phase: "preparing",
        generation: transition!.generation + 1,
        preparedSetVersion: transition!.preparedSetVersion + 1,
        targetCount: transition!.targetCount - 1,
        withdrawCount: transition!.withdrawCount + 1,
      })
    })
    await confirmAndValidate(ancestryCase, ancestryOwner, ancestryTransition)
    expect(await rowOf(ancestryCase, ancestryTransition, child)).toMatchObject({
      status: "blocked",
      blockerCode: "TARGET_ANCESTRY_NOT_TARGET",
    })
  })

  test("row 7 activation: pending and held obligations are rechecked without a partial commit", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids, id } = await readyCorrection(t, owner)
    const about = ids.about!
    const args = await activationArgs(t, id)
    const state = (await generations(t, about, "en")).state!
    const snapshot = await t.run((ctx) => ctx.db.get(state.currentSnapshotId!))

    for (const status of ["pending", "held"] as const) {
      const releaseId = await t.run((ctx) =>
        ctx.db.insert("pageLocalePublicationReleases", {
          pageId: about,
          locale: "en",
          candidateId: snapshot!.candidateId,
          generation: 999,
          expectedPublicGeneration: state.publicGeneration,
          expectedLifecycleGeneration: 1,
          executeAt: Date.now() + 60_000,
          status,
          attribution: snapshot!.attribution,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        })
      )
      const before = await languageTables(t)
      expect(
        await codeOf(
          owner.mutation(api.cms.language.activateLanguageTransition, args)
        )
      ).toBe("LANGUAGE_TRANSITION_PENDING_PUBLICATION_OBLIGATIONS")
      expect(await languageTables(t)).toEqual(before)
      await t.run((ctx) => ctx.db.delete(releaseId))
    }
    await owner.mutation(api.cms.language.activateLanguageTransition, args)
    expect((await transitionOf(t, id)).phase).toBe("committed")
  })

  test("row 17: a 1,000-Page fixture leaves activation at a fixed read/write/schedule count", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { id } = await readyCorrection(t, owner)
    const args = await activationArgs(t, id)
    const sentinels = await t.run(async (ctx) => {
      let first: Id<"pages"> | null = null
      let last: Id<"pages"> | null = null
      for (let index = 0; index < 1_000; index += 1) {
        const pageId = await ctx.db.insert("pages", {
          slug: `private-${index}`,
          pageType: "landing-page",
          status: "draft",
          createdAt: index,
          updatedAt: index,
          createdBy: OWNER.tokenIdentifier,
          content: {},
        })
        first ??= pageId
        last = pageId
      }
      return { first: first!, last: last! }
    })

    const measured = await t.run(async (ctx) => {
      const result = await activateLanguageTransitionInTransaction(ctx, args)
      return {
        result,
        metrics: await ctx.meta.getTransactionMetrics(),
      }
    })
    expect(measured.result).toEqual({
      transitionId: id,
      version: 2,
      currentLocale: "fr",
    })
    expect(measured.metrics.documentsRead.used).toBeLessThanOrEqual(8)
    expect(measured.metrics.databaseQueries.used).toBeLessThanOrEqual(8)
    expect(measured.metrics.documentsWritten.used).toBe(3)
    expect(measured.metrics.functionsScheduled.used).toBe(1)
    expect(
      await t.run(async (ctx) => ({
        first: await ctx.db.get(sentinels.first),
        last: await ctx.db.get(sentinels.last),
      }))
    ).toMatchObject({
      first: { slug: "private-0" },
      last: { slug: "private-999" },
    })
  })

  test("row 19: a throw after the activation domain function rolls the whole commit back", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { id } = await readyCorrection(t, owner)
    const args = await activationArgs(t, id)
    const before = await languageTables(t)

    await expect(
      t.run(async (ctx) => {
        await activateLanguageTransitionInTransaction(ctx, args)
        throw new Error("abort after activation")
      })
    ).rejects.toThrow("abort after activation")
    expect(await languageTables(t)).toEqual(before)
    expect((await transitionOf(t, id)).phase).toBe("ready")
    await drain(t)
    expect(
      await t.run((ctx) => ctx.db.query("revalidationAttempts").collect())
    ).toEqual([])
  })

  test("rows 26 and 32: rollback reuses the compensated source and later retained targets need a disposition", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids, id: first } = await readyCorrection(t, owner)
    const about = ids.about!
    const enBefore = (await generations(t, about, "en")).state!
    await activate(t, owner, first)

    const newFrPage = await createPage(owner, "nouveau", "fr")
    await publish(t, owner, newFrPage, "fr")
    const firstState = await t.run(async (ctx) => ({
      settings: await ctx.db.query("siteSettings").unique(),
      authority: await ctx.db.query("siteLanguageAuthority").unique(),
    }))
    const rollback = await owner.mutation(
      api.cms.language.startLanguageTransition,
      {
        mode: "rollback",
        sourceLocale: "fr",
        targetLocale: "en",
        expectedSettingsUpdatedAt: firstState.settings!.updatedAt,
        expectedAuthorityVersion: firstState.authority!.version,
        compensatesTransitionId: first,
      }
    )
    await drain(t)
    expect(await rowOf(t, rollback, about)).toMatchObject({
      disposition: "target",
      status: "ready",
      target: { snapshotId: enBefore.currentSnapshotId },
    })
    const newRow = (await rowOf(t, rollback, newFrPage))!
    expect(newRow).toMatchObject({
      disposition: "undecided",
      status: "unready",
    })
    await owner.mutation(api.cms.language.setPageDisposition, {
      transitionId: rollback,
      pageId: newFrPage,
      disposition: "withdraw",
      expectedPageGeneration: newRow.generation,
    })
    await confirmAndValidate(t, owner, rollback)
    await activate(t, owner, rollback)
    expect(
      await t.run((ctx) => ctx.db.query("pagePublishedSnapshots").collect())
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ pageId: newFrPage, locale: "fr" }),
      ])
    )
    expect(await publicProjection(t, newFrPage, "fr")).toBeNull()

    const enState = (await generations(t, about, "en")).state!
    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: about,
      locale: "en",
      expectedSnapshotId: enState.currentSnapshotId!,
      expectedPublicGeneration: enState.publicGeneration,
      expectedLifecycleGeneration: 1,
    })
    const third = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)
    const retained = (await rowOf(t, third, about))!
    expect(retained).toMatchObject({
      kind: "retained_target",
      disposition: "undecided",
      status: "unready",
    })
    expect(
      await codeOf(
        owner.mutation(api.cms.language.validateLanguageTransition, {
          transitionId: third,
          expectedGeneration: (await transitionOf(t, third)).generation,
        })
      )
    ).toBe("LANGUAGE_TRANSITION_NOT_RESOLVED")
    for (const pageId of [about, newFrPage]) {
      const row = (await rowOf(t, third, pageId))!
      await owner.mutation(api.cms.language.setPageDisposition, {
        transitionId: third,
        pageId,
        disposition: "withdraw",
        expectedPageGeneration: row.generation,
      })
    }
    await confirmAndValidate(t, owner, third)
    await activate(t, owner, third)
    expect(await publicProjection(t, about, "fr")).toBeNull()
  })

  test("row 33: cancelling holds the authority slot and its cursor cannot withdraw another snapshot", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const { ids } = await englishSite(t, owner)
    const about = ids.about!
    const id = await startTransition(t, owner, "correct_label", "fr")
    await drain(t)
    const beforeCancel = await transitionOf(t, id)
    const row = (await rowOf(t, id, about))!
    const targetState = (await generations(t, about, "fr")).state!
    const recordedSnapshot = await t.run((ctx) =>
      ctx.db.get(targetState.currentSnapshotId!)
    )
    const replacementSnapshotId = await t.run(async (ctx) => {
      const {
        _id: _oldId,
        _creationTime: _oldTime,
        ...snapshot
      } = recordedSnapshot!
      void _oldId
      void _oldTime
      const replacement = await ctx.db.insert("pagePublishedSnapshots", {
        ...snapshot,
        generation: snapshot.generation + 1,
      })
      await ctx.db.patch(targetState._id, {
        currentSnapshotId: replacement,
        publicGeneration: targetState.publicGeneration + 1,
      })
      return replacement
    })

    const cancelled = await owner.mutation(
      api.cms.language.cancelLanguageTransition,
      {
        transitionId: id,
        expectedGeneration: beforeCancel.generation,
        discardTargetDrafts: true,
      }
    )
    expect((await transitionOf(t, id)).phase).toBe("cancelling")
    expect(await codeOf(startTransition(t, owner, "correct_label", "de"))).toBe(
      "LANGUAGE_TRANSITION_ALREADY_OPEN"
    )
    await t.mutation(internal.cms.language.stepLanguageTransition, {
      transitionId: id,
      generation: beforeCancel.generation,
    })
    expect((await transitionOf(t, id)).generation).toBe(cancelled.generation)
    expect((await generations(t, about, "fr")).state?.currentSnapshotId).toBe(
      replacementSnapshotId
    )

    await drain(t)
    expect((await transitionOf(t, id)).phase).toBe("cancelled")
    expect((await generations(t, about, "fr")).state?.currentSnapshotId).toBe(
      replacementSnapshotId
    )
    expect(row.target.snapshotId).not.toBe(replacementSnapshotId)
  })
})

// ─── M05 A5 / F09 2026-11-01: the site description per language ────────────
//
// Activation step 5's siteSettings patch first stores any legacy single
// description under the source language, then (correct_label, or the rollback
// of one) swaps the source and target values. replace_content, and the
// rollback of any other transition, keep every value under its own key.

async function seedDescriptions(
  t: T,
  fields: { siteDescription?: string; siteDescriptions?: Record<string, string> }
) {
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").unique())!
    await ctx.db.patch(settings._id, fields)
  })
}

async function storedDescriptions(t: T) {
  const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
  return {
    defaultLocale: settings!.defaultLocale,
    siteDescription: settings!.siteDescription,
    siteDescriptions: settings!.siteDescriptions,
  }
}

/**
 * Removes every Page (and its publication rows) so a language change has no
 * content to disposition. The description move does not depend on Pages, and
 * a rollback otherwise stops at the retained content the first change left.
 */
async function removeAllPages(t: T) {
  await t.run(async (ctx) => {
    for (const table of [
      "pageLocaleDrafts",
      "pageLocalePublicationStates",
      "pageSharedDrafts",
      "pagePublicationPageStates",
      "pages",
    ] as const) {
      for (const row of await ctx.db.query(table).collect()) {
        await ctx.db.delete(row._id)
      }
    }
    const settings = (await ctx.db.query("siteSettings").unique())!
    await ctx.db.patch(settings._id, { homePageId: undefined })
  })
}

async function runShortTransition(
  t: T,
  owner: Caller,
  mode: Mode,
  target: string
) {
  const id = await startTransition(t, owner, mode, target)
  await drain(t)
  await confirmAndValidate(t, owner, id)
  await activate(t, owner, id)
  return id
}

describe("M05 A5 site description across an F09 language change", () => {
  test("correct_label stores the legacy value under the source key, then moves it to the target", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)
    await seedDescriptions(t, { siteDescription: "Hello" })

    await runShortTransition(t, owner, "correct_label", "fr")

    expect(await storedDescriptions(t)).toEqual({
      defaultLocale: "fr",
      siteDescription: undefined,
      siteDescriptions: { fr: "Hello" },
    })
  })

  test("correct_label records descriptionSwapped on its transition; replace_content does not", async () => {
    for (const [mode, flag] of [
      ["correct_label", true],
      ["replace_content", undefined],
    ] as const) {
      const t = app()
      const owner = t.withIdentity(OWNER)
      await bootstrap(t, owner)
      const id = await runShortTransition(t, owner, mode, "fr")
      expect((await transitionOf(t, id)).descriptionSwapped).toBe(flag)
    }
  })

  test.each([
    [
      "a retained target value moves to the source key",
      { en: "Hello", fr: "Bonjour" },
      { en: "Bonjour", fr: "Hello" },
    ],
    [
      "an absent target stays absent",
      { en: "Hello" },
      { fr: "Hello" },
    ],
    [
      "an absent source stays absent",
      { fr: "Bonjour" },
      { en: "Bonjour" },
    ],
  ])("correct_label swaps the stored values: %s", async (_label, before, after) => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)
    await seedDescriptions(t, { siteDescriptions: before })

    await runShortTransition(t, owner, "correct_label", "fr")

    expect((await storedDescriptions(t)).siteDescriptions).toEqual(after)
  })

  test("a legacy value is stored under the source key and does not overwrite a stored one", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)
    await seedDescriptions(t, {
      siteDescription: "Legacy",
      siteDescriptions: { fr: "Bonjour" },
    })

    await runShortTransition(t, owner, "correct_label", "fr")

    // Legacy "Legacy" -> en, then the swap: en <-> fr.
    expect((await storedDescriptions(t)).siteDescriptions).toEqual({
      en: "Bonjour",
      fr: "Legacy",
    })
  })

  test("replace_content stores the legacy value under the source key and deletes nothing", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)
    await seedDescriptions(t, {
      siteDescription: "Hello",
      siteDescriptions: { fr: "Bonjour", de: "Hallo" },
    })

    await runShortTransition(t, owner, "replace_content", "fr")

    expect(await storedDescriptions(t)).toEqual({
      defaultLocale: "fr",
      siteDescription: undefined,
      siteDescriptions: { en: "Hello", fr: "Bonjour", de: "Hallo" },
    })
  })

  test("a change with no description anywhere writes no description field", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)

    await runShortTransition(t, owner, "correct_label", "fr")

    const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
    expect(settings).not.toHaveProperty("siteDescriptions")
    expect(settings).not.toHaveProperty("siteDescription")
  })

  async function rollbackOf(
    t: T,
    owner: Caller,
    committed: Id<"siteLanguageTransitions">
  ) {
    const state = await t.run(async (ctx) => ({
      settings: await ctx.db.query("siteSettings").unique(),
      authority: await ctx.db.query("siteLanguageAuthority").unique(),
    }))
    const id = await owner.mutation(api.cms.language.startLanguageTransition, {
      mode: "rollback",
      sourceLocale: state.settings!.defaultLocale,
      targetLocale: (await transitionOf(t, committed)).sourceLocale,
      expectedSettingsUpdatedAt: state.settings!.updatedAt,
      expectedAuthorityVersion: state.authority!.version,
      compensatesTransitionId: committed,
    })
    await drain(t)
    // Pages the rollback cannot resolve itself take the withdraw disposition.
    const rows = await t.run((ctx) =>
      ctx.db
        .query("siteLanguageTransitionPages")
        .withIndex("by_transitionId_and_pageId", (q) => q.eq("transitionId", id))
        .collect()
    )
    for (const row of rows.filter((r) => r.disposition === "undecided")) {
      await owner.mutation(api.cms.language.setPageDisposition, {
        transitionId: id,
        pageId: row.pageId,
        disposition: "withdraw",
        expectedPageGeneration: row.generation,
      })
    }
    await confirmAndValidate(t, owner, id)
    await activate(t, owner, id)
    return id
  }

  test("a rollback of a correct_label swaps the descriptions back", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)
    await removeAllPages(t)
    await seedDescriptions(t, { siteDescriptions: { en: "Hello", fr: "Bonjour" } })

    const first = await runShortTransition(t, owner, "correct_label", "fr")
    expect((await storedDescriptions(t)).siteDescriptions).toEqual({
      en: "Bonjour",
      fr: "Hello",
    })

    const rollback = await rollbackOf(t, owner, first)

    expect(await storedDescriptions(t)).toMatchObject({
      defaultLocale: "en",
      siteDescriptions: { en: "Hello", fr: "Bonjour" },
    })
    expect((await transitionOf(t, first)).descriptionSwapped).toBe(true)
    expect((await transitionOf(t, rollback)).descriptionSwapped).toBe(true)
  })

  test("a rollback of a replace_content keeps each value under its own key", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)
    await removeAllPages(t)
    await seedDescriptions(t, { siteDescriptions: { en: "Hello", fr: "Bonjour" } })

    const first = await runShortTransition(t, owner, "replace_content", "fr")
    const rollback = await rollbackOf(t, owner, first)

    expect(await storedDescriptions(t)).toMatchObject({
      defaultLocale: "en",
      siteDescriptions: { en: "Hello", fr: "Bonjour" },
    })
    expect((await transitionOf(t, rollback)).descriptionSwapped).toBeUndefined()
  })

  test("a rollback of a rollback of a correct_label ends where the relabel put the descriptions", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)
    await removeAllPages(t)
    await seedDescriptions(t, { siteDescriptions: { en: "Hello", fr: "Bonjour" } })

    const relabel = await runShortTransition(t, owner, "correct_label", "fr")
    const afterRelabel = { en: "Bonjour", fr: "Hello" }
    expect((await storedDescriptions(t)).siteDescriptions).toEqual(afterRelabel)

    const rollback = await rollbackOf(t, owner, relabel)
    expect((await storedDescriptions(t)).siteDescriptions).toEqual({
      en: "Hello",
      fr: "Bonjour",
    })

    const again = await rollbackOf(t, owner, rollback)
    expect(await storedDescriptions(t)).toMatchObject({
      defaultLocale: "fr",
      siteDescriptions: afterRelabel,
    })
    expect((await transitionOf(t, again)).descriptionSwapped).toBe(true)
  })

  test("a rollback reads the flag, not the compensated mode", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await bootstrap(t, owner)
    await removeAllPages(t)
    await seedDescriptions(t, { siteDescriptions: { en: "Hello", fr: "Bonjour" } })

    // A correct_label committed before the flag existed carries none.
    const first = await runShortTransition(t, owner, "correct_label", "fr")
    await t.run((ctx) => ctx.db.patch(first, { descriptionSwapped: undefined }))
    const afterRelabel = (await storedDescriptions(t)).siteDescriptions

    const rollback = await rollbackOf(t, owner, first)

    expect((await storedDescriptions(t)).siteDescriptions).toEqual(afterRelabel)
    expect((await transitionOf(t, rollback)).descriptionSwapped).toBeUndefined()
  })
})


test.each(["legacy", "columns"])("R1a F09 correction accepts %s placeholder panels without a page target or image", async shape => {
  const t = app(), owner = t.withIdentity(OWNER)
  await englishSite(t, owner)
  const blocks = [{ id: "r1-feature", kind: "featured" as const, heading: { en: "Feature" },
    ...(shape === "columns" ? { link: { label: { en: "Read" }, target: { type: "placeholder" as const } } } : { target: { type: "placeholder" as const } }) }]
  await owner.mutation(api.cms.menus.createCanonical, { slug: "primary" })
  await owner.mutation(api.cms.menus.saveCanonical, { slug: "primary", locale: "en", nav: [{ id: "r1-menu", label: { en: "Menu" }, target: { type: "placeholder" }, panel:
    shape === "columns" ? { layout: "columns", columns: [{ id: "col", blocks }], title: { en: "Explore" } } : { columns: 1, blocks }
  }] })
  const id = await startTransition(t, owner, "correct_label", "fr")
  await drain(t)
  await confirmAndValidate(t, owner, id)
  await activate(t, owner, id)
  const menu = await owner.query(api.cms.menus.getCanonical, { slug: "primary" })
  expect(menu!.nav[0]!.label).toEqual({ en: "Menu", fr: "Menu" })
  expect(await t.run(ctx => ctx.db.query("menuReferences").take(10))).toEqual([])
  const config = await owner.query(api.cms.settings.getSiteConfig, {})
  const result = await t.query(api.cms.menus.getWithResolvedLinks, { slug: "primary", locale: "fr", languageVersion: config.languageVersion })
  expect(result?.nav[0]?.target).toEqual({ type: "placeholder", url: "#" })
})

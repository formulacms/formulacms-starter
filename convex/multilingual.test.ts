/// <reference types="vite/client" />

import { expectLegacyPanel as legacyPanel } from "@/test-utils/menu-panel"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { ConvexError } from "convex/values"
import { api, internal } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import type { MutationCtx } from "./_generated/server"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import {
  installSyscallRecorder,
  normalizeIds,
  readJsonFixture,
  recordSyscalls,
} from "../convexSyscallRecorder"
import { commitModuleTransitionInTransaction } from "./cms/modules"
import { activateLanguageTransitionInTransaction } from "./cms/language"
import { runDefaultMigrationStep, runPreviewStep } from "./cms/multilingual"
import {
  LANGUAGE_LIFECYCLE_MANIFEST_BATCH,
  LANGUAGE_LIFECYCLE_NEW_DEFAULT_BATCH,
  LANGUAGE_LIFECYCLE_RETRY_DELAY_MS,
  planDefaultMigrationPaths,
  runCollectionStep,
  runCollectionSweepStep,
} from "./cms/languageLifecycle"
import type {
  CollectionArgs,
  CollectionStepResult,
  SweepSection,
} from "./lib/language/collection"
import crons from "./crons"
import { publishPreparedTargetLocale } from "./cms/publication"
import {
  addLanguageInTransaction,
  adoptMultilingualAuthorityInTransaction,
  type AddLanguageArgs,
  removeLanguageInTransaction,
  resolveMultilingualModuleReadiness,
  returnToSingleLanguageInTransaction,
} from "./lib/language/multilingual"
import {
  assertNoLanguageTransitionConflicts,
  assertOrdinaryLocale,
  assertPublicLanguageVersion,
  assertReleaseExecutionEligible,
  readOpenDefaultMigration,
  readOpenTransition,
  readPublicSiteLanguageState,
  readSiteLanguageState,
  recordSourcePublicChange,
  type ReleaseExecutionRow,
  resolveDraftLocaleEligibility,
} from "./lib/language/state"
import {
  readCurrentSnapshotProjection,
  readHiddenTargetSnapshotProjection,
} from "./lib/publishing/snapshots"
import {
  DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES,
  DISCLOSURE_CHAIN_EMPTY_DIGEST,
  DISCLOSURE_FIELD_MAX_BYTES,
  digestDisclosurePage,
  type DisclosureItem,
  type DisclosureSection,
} from "./lib/language/disclosure"
import {
  impactPreviewSeam,
  menuNodePathsWithLocaleText,
  recordImpactReviewInTransaction,
} from "./lib/language/impactPreview"
import {
  DEFAULT_MIGRATION_VALIDATION_BATCH,
  activateDefaultMigrationInTransaction,
  stepDefaultMigrationInTransaction,
  defaultMigrationSeam,
  menuNodePathsMissingRequiredText,
} from "./lib/language/defaultMigration"
import { requireInstallationOwner } from "./lib/access/policy"
import type { NavItem } from "./lib/menu"
import schema from "./schema"
import { readSlicePresentationCatalog } from "./lib/slices/presentations"
import { SUPPORTED_LOCALES } from "../lib/i18n/config"
import {
  scanIndexReaders,
  scanSourceUses,
  scanTableFieldWriters,
  scanTableWriters,
} from "../sourceOwnership"

/**
 * FR2e (D-7): inventory rows for files the starter does not ship (Search, AI,
 * the slice library, the private migrations runner) live in the private
 * `multilingual.sourceInventory.ts`. Source merges them, so its inventories
 * stay exact; the starter copy is exact for what it ships.
 */
type SourceOnlyInventory = {
  languageSourceInventory?: Record<string, number>
  freshnessWriterInventory?: Record<string, string>
  recordingCallSites?: readonly string[]
}
const SOURCE_ONLY: SourceOnlyInventory = (Object.values(
  import.meta.glob("./multilingual.sourceInventory.ts", {
    eager: true,
    import: "default",
  })
)[0] ?? {}) as SourceOnlyInventory

// M05 P1 module-off baseline (contract "Chunk ownership", P1 baseline
// ordering). Captured at HEAD f5759a0a, before any C1 edit to
// `convex/lib/language/state.ts`, a gate or a freshness writer. The fixture is
// the pre-C1 truth; P1 later requires the widened tree to reproduce it for
// S0, S1 and S2 with the `multilingual` module absent and disabled.
//
// The fixture was written with P1_BASELINE_WRITE=1 before C1's first edit.
// That path is now closed: a baseline regenerated after C1 starts would not
// satisfy P1, so setting the flag fails the test.
//
// Scope decisions recorded with the capture:
// - "Disabled" is a stored `cmsModuleState` row that does not enable
//   `multilingual`; "absent" is no row. No `multilingual` descriptor exists
//   pre-C1, so neither variant could come from `modules.commit` here. If C1
//   makes a disabled row read differently from this seeded shape, revisit.
// - Non-exported gates (`requireActiveTransition`,
//   `requireOpenTransitionById`) are observed through an exported caller.
// - The inventory's non-Convex rows (`proxy.ts` redirect URL, the admin
//   language screen) are outside this fixture; `proxy.test.ts` and
//   `language-transition.test.tsx` remain their regression evidence.
// - Every probe and operation runs in its own transaction(s) and records its
//   own reads, writes and schedules, one entry per call. Owner calls include
//   the harness's constant `cmsOwner.by_key` fixture read.

const FIXTURE_URL = new URL(
  "../fixtures/m05-p1-module-off-baseline.json",
  import.meta.url
)
const WRITE_BASELINE = process.env.P1_BASELINE_WRITE === "1"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "m05-p1-owner",
  tokenIdentifier: "https://convex.test|m05-p1-owner",
}
const FIXED_NOW = Date.UTC(2026, 8, 16, 12, 0, 0)
// A well-formed id that names no stored transition.
const MISSING_TRANSITION =
  "99999siteLanguageTransitions" as Id<"siteLanguageTransitions">
const MENU_SLUG = "p1-baseline"
const PROBE_LOCALES = ["en", "fr", "nl"] as const

type T = ReturnType<typeof convexTest>
type Caller = ReturnType<T["withIdentity"]>
type StateName = "S0" | "S1" | "S2"
type ModuleVariant = "absent" | "disabled"
type Outcome = { ok: unknown } | { error: string }
type Site = {
  t: T
  owner: Caller
  aboutId: Id<"pages">
  locales: string[]
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(FIXED_NOW)
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

async function outcome(run: () => Promise<unknown>): Promise<Outcome> {
  try {
    return { ok: normalizeIds((await run()) ?? null) }
  } catch (error) {
    if (error instanceof ConvexError) return { error: String(error.data) }
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function app(): T {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
  installSyscallRecorder()
  return t
}

async function drain(t: T) {
  await t.finishAllScheduledFunctions(vi.runAllTimers)
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

async function publishArgs(t: T, pageId: Id<"pages">, locale: string) {
  const { state, shared, page } = await generations(t, pageId, locale)
  return {
    pageId,
    locale,
    expectedDraftGeneration: state!.draftGeneration,
    expectedSharedDraftGeneration: shared!.generation,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
    expectedReleaseGeneration: state!.releaseGeneration,
  }
}

async function createPage(owner: Caller, slug: string, locales: string[]) {
  return owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    content: Object.fromEntries(
      locales.map((locale) => [
        locale,
        { title: `${slug} ${locale}`, slices: [] },
      ])
    ),
  })
}

/**
 * S1: the F09 bootstrap commits authority v1. S0 and S2: snapshot authority
 * with no authority row and one or two enabled locales (F09 rows 5 and 37).
 * Every site publishes a home and an `about` Page in each enabled locale and
 * owns one canonical menu.
 */
async function buildSite(
  state: StateName,
  variant: ModuleVariant,
  aboutPublicationTimes?: Record<string, number>
): Promise<Site> {
  const t = app()
  const owner = t.withIdentity(OWNER)
  const locales = state === "S2" ? ["en", "fr"] : ["en"]
  let homeId: Id<"pages">
  if (state === "S1") {
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "P1 site",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
    homeId = settings!.homePageId!
  } else {
    await owner.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    homeId = await createPage(owner, "home", locales)
  }
  const aboutId = await createPage(owner, "about", locales)
  if (state !== "S1") {
    await t.run((ctx) =>
      ctx.db.insert("siteSettings", {
        siteName: "P1 site",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: locales,
        homePageId: homeId,
        updatedAt: FIXED_NOW,
      })
    )
  }
  for (const pageId of [homeId, aboutId]) {
    for (const locale of locales) {
      const args = await publishArgs(t, pageId, locale)
      if (pageId === aboutId && aboutPublicationTimes) {
        const receipt = await owner.mutation(async (ctx) => {
          const now = Date.now()
          const result = await ctx.runMutation(
            api.cms.publication.publishLocale,
            args
          )
          expect(result.publishedAt).toBe(now)
          return { now }
        })
        aboutPublicationTimes[locale] = receipt.now
      } else {
        await owner.mutation(api.cms.publication.publishLocale, args)
      }
    }
  }
  await owner.mutation(api.cms.menus.createCanonical, { slug: MENU_SLUG })
  await drain(t)

  // Module variants: no owner configuration row at all, or a row that does
  // not enable `multilingual` (the stored shape after enable then disable).
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("cmsModuleState").collect()) {
      await ctx.db.delete(row._id)
    }
    if (variant === "disabled") {
      await ctx.db.insert("cmsModuleState", {
        key: "owner",
        configurationVersion: 2,
        enabledModules: [],
      })
    }
  })

  expect(
    await t.run(async (ctx) => ({
      settings: (await ctx.db.query("siteSettings").collect()).length,
      authority: (await ctx.db.query("siteLanguageAuthority").collect()).length,
      cutover: (await ctx.db.query("pagePublicationCutover").collect()).map(
        (row) => row.phase
      ),
    }))
  ).toEqual({
    settings: 1,
    authority: state === "S1" ? 1 : 0,
    cutover: ["snapshot_active"],
  })
  return { t, owner, aboutId, locales }
}

/** Non-zero row count per application table. */
async function census(t: T): Promise<Record<string, number>> {
  return t.run(async (ctx) => {
    const counts: Record<string, number> = {}
    for (const table of Object.keys(schema.tables).sort()) {
      const rows = await ctx.db
        .query(table as keyof typeof schema.tables)
        .collect()
      if (rows.length > 0) counts[table] = rows.length
    }
    return counts
  })
}

function censusDelta(
  before: Record<string, number>,
  after: Record<string, number>
): Record<string, number> {
  const delta: Record<string, number> = {}
  const tables = new Set([...Object.keys(before), ...Object.keys(after)])
  for (const table of [...tables].sort()) {
    const change = (after[table] ?? 0) - (before[table] ?? 0)
    if (change !== 0) delta[table] = change
  }
  return delta
}

/** Outcome, read set, write set and row-count delta of one operation. */
async function observed(t: T, run: () => Promise<unknown>) {
  const before = await census(t)
  const { result, sets } = await recordSyscalls(() => outcome(run))
  return {
    outcome: result,
    ...sets,
    rowDelta: censusDelta(before, await census(t)),
  }
}

/** One isolated transaction, so its read set belongs to the probe alone. */
function inRun(t: T, run: (ctx: MutationCtx) => Promise<unknown>) {
  return observed(t, () => t.run((ctx) => run(ctx)))
}

async function perLocale(
  t: T,
  run: (ctx: MutationCtx, locale: string) => Promise<unknown>
) {
  const results: Record<string, unknown> = {}
  for (const locale of PROBE_LOCALES) {
    results[locale] = await inRun(t, (ctx) => run(ctx, locale))
  }
  return results
}

/** Read-only inventory gates, in contract inventory order. */
async function gateResults(site: Site) {
  const { t, owner, aboutId } = site
  const { settings, authority } = await t.run(async (ctx) => ({
    settings: await ctx.db.query("siteSettings").unique(),
    authority: await ctx.db.query("siteLanguageAuthority").first(),
  }))

  return {
    classifySiteLanguageState: await inRun(t, (ctx) =>
      readSiteLanguageState(ctx)
    ),
    readPublicSiteLanguageState: await inRun(t, (ctx) =>
      readPublicSiteLanguageState(ctx)
    ),
    assertPublicLanguageVersion: {
      "0": await inRun(t, (ctx) => assertPublicLanguageVersion(ctx, 0)),
      "1": await inRun(t, (ctx) => assertPublicLanguageVersion(ctx, 1)),
    },
    readOpenTransition: await inRun(t, async (ctx) =>
      readOpenTransition(ctx, await readSiteLanguageState(ctx))
    ),
    assertOrdinaryLocale: await perLocale(t, (ctx, locale) =>
      assertOrdinaryLocale(ctx, locale)
    ),
    resolveDraftLocaleEligibility: await perLocale(t, (ctx, locale) =>
      resolveDraftLocaleEligibility(ctx, locale)
    ),
    assertNoLanguageTransitionConflicts: await inRun(t, (ctx) =>
      assertNoLanguageTransitionConflicts(ctx)
    ),
    getLanguageState: await observed(t, () =>
      owner.query(api.cms.language.getLanguageState, {})
    ),
    getSourcePublicationNotice: await observed(t, () =>
      owner.query(api.cms.language.getSourcePublicationNotice, {
        pageId: aboutId,
      })
    ),
    // `requireActiveTransition` (language.ts) is not exported; its observable
    // outcome is the refusal of an F09 command that calls it.
    requireActiveTransition: await observed(t, () =>
      owner.mutation(api.cms.language.continueLanguageTransition, {
        transitionId: MISSING_TRANSITION,
        expectedGeneration: 0,
      })
    ),
    activateLanguageTransitionInTransaction: await inRun(t, (ctx) =>
      activateLanguageTransitionInTransaction(ctx, {
        transitionId: MISSING_TRANSITION,
        expectedGeneration: 0,
        expectedAuthorityVersion: authority?.version ?? 0,
        expectedSettingsUpdatedAt: settings!.updatedAt,
        expectedReadinessVersion: 0,
      })
    ),
    // `requireOpenTransitionById` (publication.ts) is not exported either.
    requireOpenTransitionById: await inRun(t, (ctx) =>
      publishPreparedTargetLocale(ctx, {
        transitionId: MISSING_TRANSITION,
        pageId: aboutId,
        expectedTargetPublicGeneration: 0,
        expectedLifecycleGeneration: 0,
        expectedReleaseGeneration: 0,
        arm: "draft",
        expectedTargetDraftGeneration: 0,
        expectedSharedDraftGeneration: 0,
      })
    ),
    readCurrentSnapshotProjection: await perLocale(
      t,
      async (ctx, locale) =>
        (await readCurrentSnapshotProjection(ctx, aboutId, locale)) !== null
    ),
    readHiddenTargetSnapshotProjection: await perLocale(
      t,
      async (ctx, locale) =>
        (await readHiddenTargetSnapshotProjection(ctx, aboutId, locale)) !==
        null
    ),
    getSiteConfig: await observed(t, () =>
      t.query(api.cms.settings.getSiteConfig, {})
    ),
    modulesPreview: await observed(t, () =>
      owner.query(api.cms.modules.preview, { changes: [] })
    ),
  }
}

/** Gates that can write each run on a fresh site of the same shape. */
async function writingGateResults(state: StateName, variant: ModuleVariant) {
  const initialize = await buildSite(state, variant)
  const initializeSiteLanguageAuthority = await observed(initialize.t, () =>
    initialize.owner.mutation(
      api.cms.language.initializeSiteLanguageAuthority,
      {}
    )
  )
  await drain(initialize.t)

  const start = await buildSite(state, variant)
  const { settings, authority } = await start.t.run(async (ctx) => ({
    settings: await ctx.db.query("siteSettings").unique(),
    authority: await ctx.db.query("siteLanguageAuthority").first(),
  }))
  const startLanguageTransition = await observed(start.t, () =>
    start.owner.mutation(api.cms.language.startLanguageTransition, {
      mode: "correct_label",
      sourceLocale: "en",
      targetLocale: "nl",
      expectedSettingsUpdatedAt: settings!.updatedAt,
      expectedAuthorityVersion: authority?.version ?? 0,
    })
  )
  await drain(start.t)

  const resume = await buildSite(state, variant)
  const bootstrapInstallationResume = await observed(resume.t, () =>
    resume.owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "P1 site",
      timezone: "UTC",
      defaultLocale: "en",
    })
  )
  await drain(resume.t)

  // M2 exception 2 later permits one lifecycle intent per module toggle that
  // changes a `public.*` contribution; Redirects is the only such module today.
  const toggle = await buildSite(state, variant)
  const moduleVersion = async () =>
    (
      await toggle.t.run((ctx) =>
        ctx.db
          .query("cmsModuleState")
          .withIndex("by_key", (q) => q.eq("key", "owner"))
          .first()
      )
    )?.configurationVersion ?? 0
  const redirectsEnable = await observed(toggle.t, async () =>
    toggle.owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: await moduleVersion(),
      changes: [{ moduleId: "redirects", enabled: true }],
    })
  )
  await drain(toggle.t)
  const redirectsDisable = await observed(toggle.t, async () =>
    toggle.owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: await moduleVersion(),
      changes: [{ moduleId: "redirects", enabled: false }],
    })
  )
  await drain(toggle.t)

  const rename = await buildSite(state, variant)
  const updateSettings = await observed(rename.t, () =>
    rename.owner.mutation(api.cms.settings.updateSettings, {
      siteName: "P1 site renamed",
    })
  )
  await drain(rename.t)

  return {
    initializeSiteLanguageAuthority,
    startLanguageTransition,
    bootstrapInstallationResume,
    modulesCommit: { redirectsEnable, redirectsDisable },
    updateSettings,
  }
}

function localizedUrlMap(alternates: Array<{ locale: string; url: string }>) {
  return alternates.length > 0
    ? Object.fromEntries(alternates.map(({ locale, url }) => [locale, url]))
    : null
}

/**
 * The P1 operations: a public page read (the Convex reads the public layout,
 * page and proxy issue for one path, per enabled locale), a menu save, a
 * publish and a withdraw.
 */
async function operationResults(site: Site) {
  const { t, owner, aboutId, locales } = site
  const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})

  const publicPageRead: Record<string, unknown> = {}
  for (const locale of locales) {
    publicPageRead[locale] = await observed(t, async () => {
      const siteConfig = await t.query(api.cms.settings.getSiteConfig, {})
      const resolvedId = await t.query(
        api.cms.pages.resolveLocalizedPathQuery,
        { path: "about", locale, languageVersion }
      )
      return {
        siteConfig,
        resolvedId,
        page: resolvedId
          ? await t.query(api.cms.pages.getPublicPageById, {
              id: resolvedId,
              locale,
              languageVersion,
            })
          : null,
        // C5 replaced the capped URL map with the alternates reader; the
        // fixture's `{ locale: url } | null` outcome is derived from it.
        localizedUrls: localizedUrlMap(
          await t.query(api.cms.pages.getPublicLocaleAlternates, {
            pageId: aboutId,
            languageVersion,
          })
        ),
        menu: await t.query(api.cms.menus.getWithResolvedLinks, {
          slug: MENU_SLUG,
          locale,
          languageVersion,
        }),
        historical: await t.query(
          api.cms.pages.resolveHistoricalPublishedPath,
          { locale, path: "/missing", languageVersion }
        ),
        redirect: await t.query(api.cms.redirects.resolve, {
          path: "/missing",
          locale,
          languageVersion,
        }),
      }
    })
  }

  const menuSave = await observed(t, () =>
    owner.mutation(api.cms.menus.saveCanonical, {
      slug: MENU_SLUG,
      locale: "en",
      // New nodes carry default-language text only; other-language text on a
      // new node is refused by `validateCanonicalWrite`.
      nav: [
        {
          id: "about",
          label: { en: "About" },
          target: { type: "internal" as const, pageId: aboutId },
        },
      ],
    })
  )
  // Keep the receipt read outside the observed syscall sets. Check the exact
  // acknowledgement against the row selected independently by its slug.
  const savedMenu = await t.run((ctx) =>
    ctx.db
      .query("menus")
      .withIndex("by_slug", (q) => q.eq("slug", MENU_SLUG))
      .unique()
  )
  expect(savedMenu).not.toBeNull()
  const menuSaveUpdatedAt = savedMenu!.updatedAt
  expect(menuSave.outcome).toEqual({
    ok: normalizeIds({ id: savedMenu!._id, updatedAt: menuSaveUpdatedAt }),
  })
  await drain(t)

  const draft = await generations(t, aboutId, "en")
  await owner.mutation(api.cms.publication.saveLocaleDraft, {
    pageId: aboutId,
    locale: "en",
    slug: "about",
    draft: {
      pageType: "landing-page",
      localized: { title: "About, republished" },
      slices: [],
    } as never,
    expectedDraftGeneration: draft.state!.draftGeneration,
    expectedLifecycleGeneration: draft.page!.lifecycleGeneration,
  })
  await drain(t)
  const nextPublish = await publishArgs(t, aboutId, "en")
  let republishedAt: number | undefined
  const publish = await observed(t, () =>
    owner.mutation(async (ctx) => {
      republishedAt = Date.now()
      const result = await ctx.runMutation(
        api.cms.publication.publishLocale,
        nextPublish
      )
      expect(result.publishedAt).toBe(republishedAt)
      return result
    })
  )
  await drain(t)

  const published = await generations(t, aboutId, "en")
  const nextWithdraw = {
    pageId: aboutId,
    locale: "en",
    expectedSnapshotId: published.state!.currentSnapshotId!,
    expectedPublicGeneration: published.state!.publicGeneration,
    expectedLifecycleGeneration: published.page!.lifecycleGeneration,
  }
  const withdraw = await observed(t, () =>
    owner.mutation(api.cms.publication.withdrawLocale, nextWithdraw)
  )
  await drain(t)

  expect(republishedAt).toEqual(expect.any(Number))
  return {
    operations: { publicPageRead, menuSave, publish, withdraw },
    menuSaveUpdatedAt,
    republishedAt: republishedAt!,
  }
}

async function captureCase(state: StateName, variant: ModuleVariant) {
  const aboutPublicationTimes: Record<string, number> = {}
  const site = await buildSite(state, variant, aboutPublicationTimes)
  const initialCensus = await census(site.t)
  const gates = await gateResults(site)
  const { operations, menuSaveUpdatedAt, republishedAt } =
    await operationResults(site)
  return {
    captured: {
      initialCensus,
      gates: { ...gates, ...(await writingGateResults(state, variant)) },
      operations,
    },
    publicationClocks: { aboutPublicationTimes, republishedAt },
    menuSaveUpdatedAt,
  }
}

/** A difference M05 adds, each tied to the contract clause allowing it. */
type AllowedDelta = {
  /** Path to one observed operation or probe in a fixture case. */
  path: readonly string[]
  addReads?: readonly string[]
  /** Reads removed from the multiset, one occurrence per entry. */
  removeReads?: readonly string[]
  addWrites?: readonly string[]
  addRows?: Readonly<Record<string, number>>
  addCensus?: Readonly<Record<string, number>>
  /** Module-list entries appended to `outcome.ok.readiness`. */
  addModules?: readonly Record<string, unknown>[]
  reason: string
}

/** The `multilingual` descriptor as a module-off install reports it. */
const MULTILINGUAL_MODULE_OFF = {
  available: true,
  effective: false,
  enabled: false,
  moduleId: "multilingual",
  readiness: "ready",
  setup: "not_required",
}

/** C1.3: the new descriptor; its readiness provider reads nothing. */
function multilingualDescriptor(path: readonly string[]): AllowedDelta {
  return {
    path,
    addModules: [MULTILINGUAL_MODULE_OFF],
    reason: "M05 descriptor (always ready, no setup step)",
  }
}

const MODULE_STATE_READ =
  'query cmsModuleState.by_key [key Eq "owner"] asc +operators [{"limit":2}]'
const AUTHORITY_READ =
  'query siteLanguageAuthority.by_key [key Eq "site-language-v1"] asc +operators [{"limit":2}]'
const SETTINGS_READ =
  'query siteSettings full-scan asc +operators [{"limit":2}]'
const PAGE_ID = '"<id:pages>"'
const RELEASE_READ = "get pageLocalePublicationReleases"
const BY_RELEASE_READ = `query pagePublishedSnapshots.by_releaseId [releaseId Eq "<id:pageLocalePublicationReleases>"] asc +operators [{"limit":2}]`
const BY_CANDIDATE_READ = `query pagePublishedSnapshots.by_candidateId [candidateId Eq "<id:pageLocalePublicationCandidates>"] asc +operators [{"limit":2}]`
const bySnapshotGenerationRead = (locale: string) =>
  `query pagePublishedSnapshots.by_pageId_and_locale_and_generation [pageId Eq ${PAGE_ID}, locale Eq "${locale}", generation Eq 1] asc +operators [{"limit":2}]`

/**
 * M05 C5 (N11): `getPublicLocaleAlternates` replaces the capped URL map.
 * FR1.return-1 restores full current-snapshot and same-locale ancestry
 * eligibility. The fixture's public outcome stays equal; the exact read-set
 * change is recorded here, including the added verification reads.
 */
function publicAlternatesDelta(
  locale: string,
  enabledLocales: readonly string[]
): AllowedDelta {
  const byPageIdRead = `query pageLocalePublicationStates.by_pageId [pageId Eq ${PAGE_ID}] asc +operators [{"limit":2}]`
  const removeReads =
    enabledLocales.length === 1
      ? [
          RELEASE_READ,
          byPageIdRead,
          BY_CANDIDATE_READ,
          bySnapshotGenerationRead(enabledLocales[0]!),
          BY_RELEASE_READ,
          SETTINGS_READ,
        ]
      : [
          ...enabledLocales.flatMap((each) => [
            RELEASE_READ,
            BY_CANDIDATE_READ,
            BY_RELEASE_READ,
            bySnapshotGenerationRead(each),
          ]),
          "get pages",
          byPageIdRead,
          'query pagePublicationCutover.by_key [key Eq "published-snapshot-v1"] asc +operators [{"limit":2}]',
          `query pagePublicationPageStates.by_pageId [pageId Eq ${PAGE_ID}] asc +operators [{"limit":2}]`,
          AUTHORITY_READ,
          SETTINGS_READ,
          SETTINGS_READ,
          SETTINGS_READ,
        ]
  const addReads = [
    ...enabledLocales.flatMap((each) => [
      RELEASE_READ,
      BY_CANDIDATE_READ,
      bySnapshotGenerationRead(each),
      BY_RELEASE_READ,
      SETTINGS_READ,
    ]),
    ...(enabledLocales.length > 1
      ? [
          "get pages",
          `query pagePublicationPageStates.by_pageId [pageId Eq ${PAGE_ID}] asc +operators [{"limit":2}]`,
        ]
      : []),
  ]
  return {
    path: ["operations", "publicPageRead", locale],
    removeReads,
    addReads,
    reason:
      "M05 C5 N11: uncapped alternates with full current-snapshot and ancestry eligibility",
  }
}

/**
 * M05 C6 (integration matrix, "M05 + Menus"): `saveCanonical` refuses a
 * non-enabled locale except the F09 target during a transition. The gate is
 * `resolveDraftLocaleEligibility`: one authority read and one settings read
 * for an ordinary locale. The outcome and writes are unchanged.
 */
const MENU_SAVE_LOCALE_GATE_DELTA: AllowedDelta = {
  path: ["operations", "menuSave"],
  addReads: [AUTHORITY_READ, SETTINGS_READ],
  reason: "M05 C6: `saveCanonical` accepts only an enabled locale",
}

const MENU_SAVE_ACKNOWLEDGEMENT_DELTA = {
  previousOk: "<id:menus>",
  reason:
    "D1 #12: `saveCanonical` returns the stored acknowledgement `{ id, updatedAt }` instead of the bare id",
} as const

const EMAIL_PROVIDER_STATE_READ =
  'query emailProviderState.by_key [key Eq "owner"] asc +operators [{"limit":2}]'
const EMAIL_PROVIDER_MIGRATION_RECEIPT_READ =
  'query emailProviderMigrationReceipts.by_key [key Eq "smtp-retirement"] asc +operators [{"limit":2}]'
const INTENT_INSERT =
  "insert siteLanguageLifecycleIntents {attempts,capturedAuthorityVersion,createdAt,locales,operationId,operationKind,phase,status,updatedAt}"

function moduleToggleIntent(
  path: readonly string[],
  configurationVersion: number
): AllowedDelta {
  return {
    path,
    addReads: [
      AUTHORITY_READ,
      `query siteLanguageLifecycleIntents.by_operationId [operationId Eq "module_toggle:c${configurationVersion}"] asc +operators [{"limit":1}]`,
      SETTINGS_READ,
    ],
    addWrites: [INTENT_INSERT],
    addRows: { siteLanguageLifecycleIntents: 1 },
    reason: "M2 exception 2 / M17: one intent per public-module toggle",
  }
}

const OCCURRENCE_ACCOUNTING_REASON =
  "U1-DEV-1 occurrence accounting (derived-only)"
function occurrenceAccountingDeltas(state: string): AllowedDelta[] {
  return [
    {
      path: [],
      addCensus: {
        sliceOccurrenceCountState: 1,
        sliceOccurrenceSources: state === "S2" ? 12 : 8,
        ...(state === "S1" ? { sliceOccurrenceCounts: 9 } : {}),
      },
      reason: OCCURRENCE_ACCOUNTING_REASON,
    },
    {
      path: ["operations", "publish"],
      reason: OCCURRENCE_ACCOUNTING_REASON,
      addReads: [
        "get pageLocaleDrafts",
        "get pageLocalePublicationCandidates",
        "get pagePublishedSnapshots",
        "get sliceOccurrenceSources",
        "get sliceOccurrenceSources",
        'query pagePublicationSliceReferences.by_sourceKind_and_sourceId [sourceKind Eq "candidate", sourceId Eq "<id:pageLocalePublicationCandidates>"] asc +operators [{"limit":513}]',
        'query pagePublicationSliceReferences.by_sourceKind_and_sourceId [sourceKind Eq "current_public", sourceId Eq "<id:pagePublishedSnapshots>"] asc +operators [{"limit":513}]',
        'query pagePublicationSliceReferences.by_sourceKind_and_sourceId [sourceKind Eq "locale_draft", sourceId Eq "<id:pageLocaleDrafts>"] asc +operators [{"limit":513}]',
        'query sliceOccurrenceCountState.by_key [key Eq "slice-occurrences-v1"] asc +operators [{"limit":2}]',
        'query sliceOccurrenceCountState.by_key [key Eq "slice-occurrences-v1"] asc +operators [{"limit":2}]',
        'query sliceOccurrenceCountState.by_key [key Eq "slice-occurrences-v1"] asc +operators [{"limit":2}]',
        'query sliceOccurrenceSourceMembers.by_sourceId_and_occurrenceId [sourceId Eq "<id:sliceOccurrenceSources>"] asc +operators [{"limit":513}]',
        'query sliceOccurrenceSources.by_key [key Eq "pageLocaleDrafts:<id:pageLocaleDrafts>"] asc +operators [{"limit":2}]',
        'query sliceOccurrenceSources.by_key [key Eq "pageLocalePublicationCandidates:<id:pageLocalePublicationCandidates>"] asc +operators [{"limit":2}]',
        'query sliceOccurrenceSources.by_key [key Eq "pagePublishedSnapshots:<id:pagePublishedSnapshots>"] asc +operators [{"limit":2}]',
      ],
      addWrites: [
        "delete sliceOccurrenceSources",
        "insert sliceOccurrenceSources {epoch,fingerprint,invalidTypes,key,sourceId,table,unknownInvalid}",
        "insert sliceOccurrenceSources {epoch,fingerprint,invalidTypes,key,sourceId,table,unknownInvalid}",
        "patch sliceOccurrenceSources {epoch,fingerprint,invalidTypes,unknownInvalid}",
        "patch sliceOccurrenceSources {epoch,fingerprint,invalidTypes,unknownInvalid}",
      ],
      addRows: { sliceOccurrenceSources: 1 },
    },
  ]
}

/** Only the native ID segment of the two new accounting key reads is adapted. */
function normalizeOccurrenceKeyReads(value: unknown): unknown {
  if (typeof value === "string") {
    const source =
      /^(query sliceOccurrenceSources\.by_key \[key Eq ")(pages|pageStaging|pageLocaleDrafts|pageSharedDrafts|pageLocalePublicationCandidates|pagePublishedSnapshots):([^"]+)("\] asc \+operators \[\{"limit":2\}\])$/.exec(
        value
      )
    if (source) {
      const id = normalizeIds(source[3])
      return id === `<id:${source[2]}>`
        ? `${source[1]}${source[2]}:${id}${source[4]}`
        : value
    }
    const member =
      /^(query sliceOccurrenceSourceMembers\.by_sourceId_and_occurrenceId \[sourceId Eq ")([^"]+)("\] asc \+operators \[\{"limit":513\}\])$/.exec(
        value
      )
    if (member) {
      const id = normalizeIds(member[2])
      return id === "<id:sliceOccurrenceSources>"
        ? `${member[1]}${id}${member[3]}`
        : value
    }
    // The frozen fixture predates the indexed current-reference read; map the
    // new, narrower read back to the old by_targetId form it replaces. Only the
    // fixture's "en" locale maps, so a read in the wrong locale still differs.
    const indexedRefs =
      /^query pagePublicationDocumentReferences\.by_targetId_and_sourceKind_and_locale \[(targetId Eq "[^"]+"), sourceKind Eq "current_public", locale Eq "en"\] asc \+operators \[\{"limit":513\}\]$/.exec(
        value
      )
    if (indexedRefs)
      return `query pagePublicationDocumentReferences.by_targetId [${indexedRefs[1]}] asc +operators [{"limit":513}]`
    return value
  }
  if (Array.isArray(value)) return value.map(normalizeOccurrenceKeyReads)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        normalizeOccurrenceKeyReads(child),
      ])
    )
  return value
}

/** Audited core-address reads, still required with Multilingual absent/off. */
function uniqueAddressReadDeltas(state: string): AllowedDelta[] {
  const locales = state === "S2" ? ["en", "fr"] : ["en"]
  const range = (table: string, index: string, fields: string, limit: number) =>
    `query ${table}.${index} [${fields}] asc +operators [{"limit":${limit}}]`
  const deltas: AllowedDelta[] = []
  for (const request of locales) {
    const changes = [
      [
        "pageLocalePublicationStates",
        "by_locale_and_currentPath",
        `locale Eq "${request}", currentPath Eq "/about"`,
      ],
      [
        "pageLocalePublicationStates",
        "by_locale_and_currentPath",
        `locale Eq "${request}", currentPath Eq "/missing"`,
      ],
      [
        "pageHistoricalLocaleRoutes",
        "by_locale_and_fromPath",
        `locale Eq "${request}", fromPath Eq "/missing"`,
      ],
      ...locales
        .filter((locale) => locale !== request)
        .flatMap((locale) => [
          [
            "pageLocalePublicationStates",
            "by_locale_and_currentPath",
            `locale Eq "${locale}", currentPath Eq "/missing"`,
          ],
          [
            "pageHistoricalLocaleRoutes",
            "by_locale_and_fromPath",
            `locale Eq "${locale}", fromPath Eq "/missing"`,
          ],
        ]),
    ]
    for (const [table, index, fields] of changes)
      deltas.push({
        path: ["operations", "publicPageRead", request],
        removeReads: [range(table!, index!, fields!, 2)],
        addReads: [range(table!, index!, fields!, 101)],
        reason: `Unique address: public read ${table}.${index} counts live holders after lifecycle filtering, with a complete 100-row cap even when Multilingual is off`,
      })
  }
  for (const [table, index, fields] of [
    [
      "pageLocalePublicationStates",
      "by_locale_and_currentPath",
      'locale Eq "en", currentPath Eq "/about"',
    ],
    [
      "pageHistoricalLocaleRoutes",
      "by_locale_and_fromPath",
      'locale Eq "en", fromPath Eq "/about"',
    ],
  ])
    deltas.push({
      path: ["operations", "publish"],
      removeReads: [range(table!, index!, fields!, 2)],
      addReads: [range(table!, index!, fields!, 101)],
      reason: `Unique address: Publish checks the complete exact ${table}.${index} bucket before selection in single-language operation too`,
    })
  deltas.push({
    path: ["operations", "publish"],
    addReads: [
      range(
        "pageLocaleDrafts",
        "by_locale_and_slug",
        'locale Eq "en", slug Eq "about"',
        101
      ),
    ],
    reason:
      "Unique address: Publish refuses another page's saved future path from the bounded same-identifier draft bucket, independently of Multilingual",
  })
  for (const read of [
    "get pages",
    "get pagePublishedSnapshots",
    "get pageLocalePublicationCandidates",
    "get pageLocalePublicationReleases",
    `query pageLocaleDrafts.by_pageId_and_locale [pageId Eq ${PAGE_ID}, locale Eq "en"] asc +operators [{"limit":2}]`,
    `query pageSharedDrafts.by_pageId [pageId Eq ${PAGE_ID}] asc +operators [{"limit":2}]`,
    `query pagePublishedSnapshots.by_candidateId [candidateId Eq "<id:pageLocalePublicationCandidates>"] asc +operators [{"limit":2}]`,
    `query pagePublishedSnapshots.by_releaseId [releaseId Eq "<id:pageLocalePublicationReleases>"] asc +operators [{"limit":2}]`,
    `query pagePublishedSnapshots.by_pageId_and_locale_and_generation [pageId Eq ${PAGE_ID}, locale Eq "en", generation Eq 2] asc +operators [{"limit":2}]`,
  ])
    deltas.push({
      path: ["operations", "withdraw"],
      addReads: [read],
      reason: `Unique address: Withdraw validates the frozen draft-base future address and authoritative shared parent before clearing the live selection; required core read ${read} with Multilingual off`,
    })
  return deltas
}

/**
 * Every difference the post-C1 tree may show against the pre-C1 fixture. P1
 * compares check results everywhere, and exact read and write sets for the
 * classification probes and the four operations (M2). Only what is listed
 * here may appear; nothing may disappear.
 */
function allowedDeltas(key: string): AllowedDelta[] {
  const [state, variant] = key.split("/")
  // Seeded "disabled" rows start at configuration version 2.
  const version = variant === "disabled" ? 2 : 0
  return [
    {
      path: ["gates", "assertNoLanguageTransitionConflicts"],
      addReads: [MODULE_STATE_READ],
      reason: "M6 / F09 step 3: refuse while `multilingual` is enabled",
    },
    ...(state === "S1"
      ? [
          {
            path: ["gates", "startLanguageTransition"],
            addReads: [MODULE_STATE_READ],
            reason: "M6 / F09 step 3, reached by start on a current authority",
          },
        ]
      : []),
    moduleToggleIntent(
      ["gates", "modulesCommit", "redirectsEnable"],
      version + 1
    ),
    moduleToggleIntent(
      ["gates", "modulesCommit", "redirectsDisable"],
      version + 2
    ),
    ...[
      ["gates", "modulesPreview"],
      ["gates", "modulesCommit", "redirectsEnable"],
      ["gates", "modulesCommit", "redirectsDisable"],
    ].map((path) => ({
      path,
      addReads: [
        EMAIL_PROVIDER_MIGRATION_RECEIPT_READ,
        EMAIL_PROVIDER_STATE_READ,
        SETTINGS_READ,
      ],
      reason:
        "ADR-0054 required Email readiness checks bounded legacy and successor state",
    })),
    multilingualDescriptor(["gates", "modulesPreview"]),
    multilingualDescriptor(["gates", "modulesCommit", "redirectsEnable"]),
    multilingualDescriptor(["gates", "modulesCommit", "redirectsDisable"]),
    // S2a: the installed AI descriptor adds its off/setup fact and one bounded
    // settings read at each existing all-provider Modules probe (seat resume-2).
    ...[
      ["gates", "modulesPreview"],
      ["gates", "modulesCommit", "redirectsEnable"],
      ["gates", "modulesCommit", "redirectsDisable"],
    ].map((path) => ({
      path,
      addReads: ['query siteSettings full-scan asc +operators [{"limit":1}]'],
      addModules: [{
        available: true,
        effective: false,
        enabled: false,
        moduleId: "ai",
        readiness: "needs_setup",
        setup: "required",
      }],
      reason: "S2a AI descriptor/readiness (module off, missing provider keys)",
    })),
    ...(state === "S2"
      ? ["en", "fr"].map((locale) =>
          publicAlternatesDelta(locale, ["en", "fr"])
        )
      : [publicAlternatesDelta("en", ["en"])]),
    // U3: an unclaimed path also probes the other enabled languages for the
    // self-heal candidate (a current path, then F08 history, per language).
    ...(state === "S2"
      ? [
          ["en", "fr"],
          ["fr", "en"],
        ].map(([request, other]) => ({
          path: ["operations", "publicPageRead", request!],
          addReads: [
            `query pageHistoricalLocaleRoutes.by_locale_and_fromPath [locale Eq "${other}", fromPath Eq "/missing"] asc +operators [{"limit":2}]`,
            `query pageLocalePublicationStates.by_locale_and_currentPath [locale Eq "${other}", currentPath Eq "/missing"] asc +operators [{"limit":2}]`,
          ],
          reason: "U3 self-heal candidate probes the other enabled languages",
        }))
      : []),
    ...uniqueAddressReadDeltas(state!),
    MENU_SAVE_LOCALE_GATE_DELTA,
    ...occurrenceAccountingDeltas(state!),
  ]
}

const LOCALE_CATALOG_DELTA = {
  from: "de",
  to: "nl",
  reason:
    "FR1c2 removes German from the shipped catalog; Dutch preserves the fixture's supported third-locale probe",
} as const

function applyLocaleCatalogDelta(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(
      new RegExp(`\\b${LOCALE_CATALOG_DELTA.from}\\b`, "g"),
      LOCALE_CATALOG_DELTA.to
    )
  }
  if (Array.isArray(value)) return value.map(applyLocaleCatalogDelta)
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        applyLocaleCatalogDelta(key) as string,
        applyLocaleCatalogDelta(child),
      ])
    )
  }
  return value
}

async function expectedAfterC1(
  key: string,
  fixtureCase: unknown,
  publicationClocks: {
    aboutPublicationTimes: Record<string, number>
    republishedAt: number
  },
  menuSaveUpdatedAt: number
): Promise<unknown> {
  const expected = applyLocaleCatalogDelta(fixtureCase) as Record<
    string,
    unknown
  >
  // MG2 adds only the nullable Apply token to this unchanged empty preview.
  const previewGate = (
    expected.gates as Record<
      string,
      { outcome: { ok: Record<string, unknown> } }
    >
  ).modulesPreview
  previewGate.outcome.ok.multilingualCommandTokens = null
  for (const delta of allowedDeltas(key)) {
    let node: Record<string, unknown> = expected
    for (const segment of delta.path) {
      node = node[segment] as Record<string, unknown>
    }
    if (delta.addReads) {
      node.reads = [...(node.reads as string[]), ...delta.addReads].sort()
    }
    if (delta.removeReads) {
      const reads = [...(node.reads as string[])]
      for (const read of delta.removeReads) {
        const index = reads.indexOf(read)
        if (index === -1) throw new Error(`P1 delta removes absent ${read}`)
        reads.splice(index, 1)
      }
      node.reads = reads
    }
    if (delta.addWrites) {
      node.writes = [...(node.writes as string[]), ...delta.addWrites].sort()
    }
    if (delta.addModules) {
      const ok = (node.outcome as { ok: { readiness: unknown[] } }).ok
      ok.readiness = [...ok.readiness, ...delta.addModules]
    }
    if (delta.addCensus) {
      const census = { ...(node.initialCensus as Record<string, number>) }
      for (const [table, count] of Object.entries(delta.addCensus))
        census[table] = (census[table] ?? 0) + count
      node.initialCensus = Object.fromEntries(
        Object.entries(census).sort(([a], [b]) => a.localeCompare(b))
      )
    }
    if (delta.addRows) {
      const rows = { ...(node.rowDelta as Record<string, number>) }
      for (const [table, count] of Object.entries(delta.addRows)) {
        rows[table] = (rows[table] ?? 0) + count
      }
      node.rowDelta = Object.fromEntries(
        Object.entries(rows).sort(([a], [b]) => a.localeCompare(b))
      )
    }
  }
  // F08b adds derived listing keys to exactly the existing selection writes.
  // Keep the historical fixture immutable and assert the old write before
  // replacing its exact field set; no read or authorization delta is waived.
  const selectionWrites = expected.operations as Record<
    string,
    { writes: string[] }
  >
  for (const [operation, oldWrite, newWrite] of [
    [
      "publish",
      "patch pageLocalePublicationStates {currentPath,currentPublishedAt,currentReleaseId,currentSnapshotId,draftBaseSnapshotId,hasCurrentSnapshot,publicGeneration,releaseGeneration,updatedAt}",
      "patch pageLocalePublicationStates {currentPath,currentPublishedAt,currentReleaseId,currentSnapshotId,draftBaseSnapshotId,hasCurrentSnapshot,pageType,publicGeneration,publicSince,releaseGeneration,updatedAt}",
    ],
    [
      "withdraw",
      "patch pageLocalePublicationStates {currentPath,currentPublishedAt,currentReleaseId,currentSnapshotId,hasCurrentSnapshot,publicGeneration,updatedAt}",
      "patch pageLocalePublicationStates {currentPath,currentPublishedAt,currentReleaseId,currentSnapshotId,hasCurrentSnapshot,pageType,publicGeneration,publicSince,updatedAt}",
    ],
  ] as const) {
    expect(selectionWrites[operation]!.writes).toContain(oldWrite)
    selectionWrites[operation]!.writes = selectionWrites[operation]!.writes.map(
      (write) => (write === oldWrite ? newWrite : write)
    )
  }
  // Bootstrap initializes one counter per catalog presentation (staging.ts).
  // Source has nine; the five-Type starter has six, and no-Hero has four.
  // Adapt only S1's selection census; every other field stays exact.
  if (key.startsWith("S1/"))
    (expected.initialCensus as Record<string, number>).sliceOccurrenceCounts = (
      await readSlicePresentationCatalog()
    ).entries.length
  // convex-test pins Date to the transaction clock. Adapt only the initial
  // public Page scalar times and the republish result, using producer receipts
  // whose returned publishedAt was independently checked in that transaction.
  const operations = expected.operations as {
    publicPageRead: Record<
      string,
      { outcome: { ok: { page: { publishedAt: number; updatedAt: number } } } }
    >
    publish: { outcome: { ok: { publishedAt: number } } }
    menuSave: { outcome: { ok: unknown } }
  }
  for (const [locale, now] of Object.entries(
    publicationClocks.aboutPublicationTimes
  )) {
    const page = operations.publicPageRead[locale]!.outcome.ok.page
    expect(page.publishedAt).toBe(FIXED_NOW)
    expect(page.updatedAt).toBe(FIXED_NOW)
    page.publishedAt = now
    page.updatedAt = now
  }
  expect(operations.publish.outcome.ok.publishedAt).toBe(FIXED_NOW)
  operations.publish.outcome.ok.publishedAt = publicationClocks.republishedAt
  // D1 #12 changes only the result contract; preserve the fixture's same id
  // and use the producer receipt independently checked against storage.
  const previousMenuId = operations.menuSave.outcome.ok
  expect(previousMenuId, MENU_SAVE_ACKNOWLEDGEMENT_DELTA.reason).toBe(
    MENU_SAVE_ACKNOWLEDGEMENT_DELTA.previousOk
  )
  operations.menuSave.outcome.ok = {
    id: previousMenuId,
    updatedAt: menuSaveUpdatedAt,
  }
  return expected
}

describe("M05 P1 module-off baseline", () => {
  test.each(
    (["S0", "S1", "S2"] as const).flatMap((state) =>
      (["absent", "disabled"] as const).map(
        (variant) => [state, variant] as const
      )
    )
  )(
    "%s with the multilingual module %s matches the pre-C1 fixture",
    async (state, variant) => {
      // The fixture was captured at f5759a0a (commits bf24b998, 899b833f).
      // C1 has since edited the classifier, so it can never be regenerated.
      expect(WRITE_BASELINE).toBe(false)
      const { captured, publicationClocks, menuSaveUpdatedAt } =
        await captureCase(state, variant)
      const key = `${state}/${variant}`
      const fixture = readJsonFixture(FIXTURE_URL) as {
        cases: Record<string, unknown>
      }
      expect(fixture.cases[key]).toBeDefined()
      expect(normalizeOccurrenceKeyReads(normalizeIds(captured))).toEqual(
        await expectedAfterC1(
          key,
          fixture.cases[key],
          publicationClocks,
          menuSaveUpdatedAt
        )
      )
    },
    120_000
  )
})

// ─── P18 classifier inventory ──────────────────────────────────────────────
//
// Contract "Classifier, gate and consumer inventory" and "Gate call sites".
// The source-ownership test pins every consumer by file and enclosing
// function; the behaviour matrix runs each C1-owned Convex row under every
// state. Rows owned elsewhere: `proxy.ts` redirect URL (C3, continuity
// destination locale) and `language-transition.tsx` (C4).

const REPO_ROOT = new URL("..", import.meta.url).pathname

const LANGUAGE_CALLEES = [
  "classifySiteLanguageState",
  "readSiteLanguageState",
  "readPublicSiteLanguageState",
  "assertPublicLanguageVersion",
  "publicLocaleEligibility",
  "readAuthorityRows",
  "readMultilingualModuleEnabled",
  "readOpenTransition",
  "readOpenDefaultMigration",
  "assertOrdinaryLocale",
  "resolveDraftLocaleEligibility",
  "assertNoLanguageTransitionConflicts",
  "requireActiveTransition",
  "requireOpenTransitionById",
  "assertReleaseExecutionEligible",
] as const

const LANGUAGE_KINDS = [
  "invalid",
  "uninitialized",
  "multi_locale",
  "current",
  "multilingual",
  "unconfigured",
] as const

/**
 * `file#function#use` → count. A new consumer, a new call of a listed gate or
 * a new `.kind` comparison fails until it is added here with its inventory
 * behaviour.
 */
const LANGUAGE_SOURCE_INVENTORY: Record<string, number> = {
  // Admin language screen, including C4's multilingual state branch.
  "components/admin/language-transition.tsx#LanguageTransition#.kind": 4,
  // F09 commands and workers.
  "convex/cms/language.ts#activateLanguageTransitionInTransaction#.kind": 2,
  "convex/cms/language.ts#activateLanguageTransitionInTransaction#assertNoLanguageTransitionConflicts": 1,
  "convex/cms/language.ts#activateLanguageTransitionInTransaction#readSiteLanguageState": 1,
  "convex/cms/language.ts#cancelLanguageTransition#requireActiveTransition": 1,
  "convex/cms/language.ts#cancelStep#readAuthorityRows": 1,
  "convex/cms/language.ts#confirmTargetContent#requireActiveTransition": 1,
  "convex/cms/language.ts#confirmTransitionPreview#requireActiveTransition": 1,
  "convex/cms/language.ts#continueLanguageTransition#requireActiveTransition": 1,
  "convex/cms/language.ts#copySourceToTargetDraft#requireActiveTransition": 1,
  "convex/cms/language.ts#enumerateStep#readAuthorityRows": 1,
  "convex/cms/language.ts#getLanguageState#.kind": 2,
  "convex/cms/language.ts#getLanguageState#readOpenTransition": 1,
  "convex/cms/language.ts#getLanguageState#readSiteLanguageState": 1,
  "convex/cms/language.ts#getSourcePublicationNotice#readOpenTransition": 1,
  "convex/cms/language.ts#getSourcePublicationNotice#readSiteLanguageState": 1,
  "convex/cms/language.ts#initializeSiteLanguageAuthority#.kind": 3,
  "convex/cms/language.ts#initializeSiteLanguageAuthority#readSiteLanguageState": 1,
  "convex/cms/language.ts#insertInitialSiteLanguageAuthority#readAuthorityRows": 1,
  "convex/cms/language.ts#prepareTargetPage#requireActiveTransition": 1,
  "convex/cms/language.ts#readContinuityPointer#readAuthorityRows": 1,
  "convex/cms/language.ts#requireActiveTransition#.kind": 2,
  "convex/cms/language.ts#requireActiveTransition#readOpenTransition": 1,
  "convex/cms/language.ts#requireActiveTransition#readSiteLanguageState": 1,
  "convex/cms/language.ts#setPageDisposition#requireActiveTransition": 1,
  "convex/cms/language.ts#startLanguageTransition#.kind": 3,
  "convex/cms/language.ts#startLanguageTransition#assertNoLanguageTransitionConflicts": 1,
  "convex/cms/language.ts#startLanguageTransition#readSiteLanguageState": 1,
  "convex/cms/language.ts#validateLanguageTransition#requireActiveTransition": 1,
  "convex/cms/language.ts#validateStep#readAuthorityRows": 1,
  "convex/cms/languageLifecycle.ts#getLanguageLifecycleStatus#readAuthorityRows": 1,
  // F09 retained target. The F01 remedy is offered only in the `current`
  // state with no active transition (W89); adoption reads the one authority
  // row into its review digest, and preparation and the disposition decision
  // recheck transition conflicts before they act (W107).
  "convex/cms/language.ts#prepareTargetPage#assertNoLanguageTransitionConflicts": 1,
  "convex/cms/language.ts#readRetainedTargetDraftRemedy#.kind": 1,
  "convex/cms/language.ts#readRetainedTargetDraftRemedy#readSiteLanguageState": 1,
  "convex/cms/language.ts#readRetainedTargetState#readAuthorityRows": 1,
  "convex/cms/language.ts#setPageDisposition#assertNoLanguageTransitionConflicts": 1,
  // Version-pin consumers; menus also consumes Language-owned public facts.
  "convex/cms/menus.ts#getWithResolvedLinks#assertPublicLanguageVersion": 1,
  "convex/cms/menus.ts#getWithResolvedLinks#publicLocaleEligibility": 1,
  // M05 C6: menu text only for an enabled locale or the F09 target (P14).
  "convex/cms/menus.ts#saveCanonical#resolveDraftLocaleEligibility": 1,
  "convex/cms/pages.ts#getAllLocalizedPageUrls#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#getLocalizedBreadcrumb#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#getLocalizedPathsByIds#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#getPublicByline#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#getPublicHomeLocaleAlternates#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#getPublicLocaleAlternates#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#getPublicPageById#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#getPublicRelationCardsByIds#assertPublicLanguageVersion": 1,
  // C5a: the sitemap index and child replace `listPublishedForSitemap`.
  "convex/cms/pages.ts#getSitemapChild#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#getSitemapIndex#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#listRecentPublicRelationCards#assertPublicLanguageVersion": 1,
  "convex/cms/pages.ts#resolveLocalizedPathQuery#assertPublicLanguageVersion": 1,
  "convex/cms/redirects.ts#listActiveKeys#assertPublicLanguageVersion": 1,
  "convex/cms/redirects.ts#resolve#assertPublicLanguageVersion": 1,
  // Continuity resolver gate.
  "convex/cms/pages.ts#resolveHistoricalPublishedPath#.kind": 2,
  "convex/cms/pages.ts#resolveHistoricalPublishedPath#assertPublicLanguageVersion": 1,
  // Translate page: Start and the estimate check that the source and the
  // target are both languages of this site (two calls in `prepare`).
  "convex/cms/aiJobs.ts#prepare#assertOrdinaryLocale": 2,
  // Ordinary Publication gates.
  "convex/cms/preview.ts#createPreviewSession#assertOrdinaryLocale": 1,
  // Owner draft query accepts ordinary locales and preparable F09 targets.
  "convex/cms/publication.ts#addressAvailability#resolveDraftLocaleEligibility": 2,
  "convex/cms/publication.ts#deleteLocaleContent#assertOrdinaryLocale": 1,
  "convex/cms/publication.ts#discardLocaleDraft#resolveDraftLocaleEligibility": 1,
  "convex/cms/publication.ts#publishLocale#assertOrdinaryLocale": 1,
  "convex/cms/publication.ts#restoreSnapshotAsDraft#assertOrdinaryLocale": 1,
  "convex/cms/publication.ts#saveEditorDraft#assertOrdinaryLocale": 1,
  "convex/cms/publication.ts#saveLocaleDraft#resolveDraftLocaleEligibility": 1,
  "convex/cms/publication.ts#withdrawLocale#assertOrdinaryLocale": 1,
  // Hidden-target Publication gate.
  "convex/cms/publication.ts#createTransitionTargetDraft#requireOpenTransitionById": 1,
  "convex/cms/publication.ts#deleteTransitionTargetDraft#requireOpenTransitionById": 1,
  "convex/cms/publication.ts#publishPreparedTargetLocale#requireOpenTransitionById": 1,
  "convex/cms/publication.ts#requireOpenTransitionById#.kind": 2,
  "convex/cms/publication.ts#requireOpenTransitionById#readOpenTransition": 1,
  "convex/cms/publication.ts#requireOpenTransitionById#readSiteLanguageState": 1,
  "convex/cms/publication.ts#withdrawPreparedTargetLocale#requireOpenTransitionById": 1,
  // C5a: the sitemap builder compares the live language version (one row).
  "convex/cms/publication.ts#readLiveLanguageVersion#readAuthorityRows": 1,
  // Settings.
  "convex/cms/settings.ts#bootstrapInstallation#.kind": 2,
  "convex/cms/settings.ts#bootstrapInstallation#readSiteLanguageState": 1,
  "convex/cms/settings.ts#getPublicChrome#.kind": 1,
  "convex/cms/settings.ts#getPublicChrome#assertPublicLanguageVersion": 1,
  "convex/cms/settings.ts#getSiteConfig#.kind": 1,
  "convex/cms/settings.ts#getSiteConfig#readPublicSiteLanguageState": 1,
  // C5a: a sitemap child checks both public gates once per query.
  "convex/lib/publishing/snapshots.ts#createPublicSnapshotProjectionReader#.kind": 1,
  "convex/lib/publishing/snapshots.ts#createPublicSnapshotProjectionReader#readSiteLanguageState": 1,
  // C5: the navigation/SEO alternates reader gates its Page reads once.
  "convex/lib/publishing/snapshots.ts#readPublicSnapshotLocaleAlternates#.kind": 1,
  "convex/lib/publishing/snapshots.ts#readPublicSnapshotLocaleAlternates#readSiteLanguageState": 1,
  // C3c.2b: collection and its sweep read the pointer as a single row.
  "convex/lib/language/collection.ts#collectStepInTransaction#readAuthorityRows": 1,
  "convex/lib/language/collection.ts#sweepStepInTransaction#readAuthorityRows": 1,
  // The classifier and gate definitions.
  "convex/lib/language/state.ts#assertNoLanguageTransitionConflicts#readMultilingualModuleEnabled": 1,
  "convex/lib/language/state.ts#assertOrdinaryLocale#.kind": 3,
  "convex/lib/language/state.ts#assertOrdinaryLocale#readSiteLanguageState": 1,
  "convex/lib/language/state.ts#assertPublicLanguageVersion#readPublicSiteLanguageState": 1,
  "convex/lib/language/state.ts#assertReleaseExecutionEligible#.kind": 3,
  "convex/lib/language/state.ts#assertReleaseExecutionEligible#readSiteLanguageState": 1,
  "convex/lib/language/state.ts#readActiveTransitionForWrite#readAuthorityRows": 1,
  "convex/lib/language/state.ts#readOpenDefaultMigration#.kind": 1,
  "convex/lib/language/state.ts#readOpenTransition#.kind": 1,
  "convex/lib/language/state.ts#readPublicSiteLanguageState#.kind": 1,
  "convex/lib/language/state.ts#readPublicSiteLanguageState#readAuthorityRows": 1,
  "convex/lib/language/state.ts#readPublicSiteLanguageState#readSiteLanguageState": 1,
  "convex/lib/language/state.ts#readSiteLanguageState#classifySiteLanguageState": 1,
  "convex/lib/language/state.ts#readSiteLanguageState#readAuthorityRows": 1,
  "convex/lib/language/state.ts#readSiteLanguageState#readMultilingualModuleEnabled": 1,
  "convex/lib/language/state.ts#resolveDraftLocaleEligibility#.kind": 3,
  "convex/lib/language/state.ts#resolveDraftLocaleEligibility#readOpenTransition": 1,
  "convex/lib/language/state.ts#resolveDraftLocaleEligibility#readSiteLanguageState": 1,
  // M05 commands, lifecycle state and the `multilingual` toggle rules (C1.3).
  "convex/lib/language/multilingual.ts#commandTokensOf#.kind": 2,
  "convex/cms/multilingual.ts#adoptInTransaction#.kind": 1,
  "convex/cms/multilingual.ts#getMultilingualState#.kind": 6,
  // C3b: reports the open migration; a named migration that is not open is IX.
  "convex/cms/multilingual.ts#getMultilingualState#readOpenDefaultMigration": 1,
  "convex/cms/multilingual.ts#needsReviewToAddLanguage#.kind": 1,
  // B1: the shared conflict read picks the authority row for the continuity.
  "convex/cms/multilingual.ts#readAddressConflictsFor#.kind": 2,
  "convex/cms/multilingual.ts#previewAdoption#.kind": 1,
  // A4 combined commands: the shared entry read, the token reader for invalid
  // state, the addable-locale check and the two commands that branch on state.
  "convex/lib/language/multilingual.ts#readCommandEntry#.kind": 1,
  "convex/cms/multilingual.ts#readUnclassifiedCommandTokens#readAuthorityRows": 1,
  "convex/cms/multilingual.ts#removeLastExtraLanguage#.kind": 1,
  "convex/cms/multilingual.ts#requireAddableLocale#.kind": 1,
  "convex/cms/modules.ts#readApplyPlan#.kind": 1,
  "convex/cms/modules.ts#commit#.kind": 1,
  "convex/lib/language/multilingual.ts#addLanguageInTransaction#.kind": 2,
  // B1: the silent add repeats the same state and open-operation checks.
  "convex/lib/language/multilingual.ts#addLanguageSilentlyInTransaction#.kind": 2,
  "convex/lib/language/multilingual.ts#addLanguageSilentlyInTransaction#readOpenDefaultMigration": 1,
  "convex/lib/language/multilingual.ts#addLanguageInTransaction#readOpenDefaultMigration": 1,
  "convex/lib/language/multilingual.ts#adoptMultilingualAuthorityInTransaction#.kind": 1,
  "convex/lib/language/multilingual.ts#originOf#.kind": 3,
  "convex/lib/language/multilingual.ts#readMultilingualSnapshot#.kind": 2,
  "convex/lib/language/multilingual.ts#readMultilingualSnapshot#readMultilingualModuleEnabled": 1,
  "convex/lib/language/multilingual.ts#readMultilingualSnapshot#readOpenTransition": 1,
  "convex/lib/language/multilingual.ts#readMultilingualSnapshot#readSiteLanguageState": 1,
  "convex/lib/language/multilingual.ts#readMultilingualToggleBlockers#.kind": 2,
  "convex/lib/language/multilingual.ts#readMultilingualToggleBlockers#readOpenDefaultMigration": 1,
  "convex/lib/language/multilingual.ts#readMultilingualToggleBlockers#readOpenTransition": 1,
  "convex/lib/language/multilingual.ts#readMultilingualToggleBlockers#readSiteLanguageState": 1,
  "convex/lib/language/multilingual.ts#removeLanguageInTransaction#.kind": 2,
  "convex/lib/language/multilingual.ts#removeLanguageInTransaction#readOpenDefaultMigration": 1,
  "convex/lib/language/multilingual.ts#removeLanguageInTransaction#readSiteLanguageState": 1,
  "convex/lib/language/multilingual.ts#returnToSingleLanguageInTransaction#.kind": 2,
  "convex/lib/language/multilingual.ts#returnToSingleLanguageInTransaction#readOpenDefaultMigration": 1,
  "convex/lib/language/multilingual.ts#returnToSingleLanguageInTransaction#readSiteLanguageState": 1,
  "convex/lib/language/multilingual.ts#validateAdoption#.kind": 2,
  "convex/lib/language/multilingual.ts#validateAdoption#readOpenTransition": 1,
  "convex/lib/language/multilingual.ts#validateAdoption#readSiteLanguageState": 1,
  // M05 recording seam (C2b.1): one authority read, shared with F09's part.
  "convex/lib/language/freshness.ts#recordPublicChange#readAuthorityRows": 1,
  // M05 impact previews: D1 also classifies the default-locale freshness and
  // the prefix source reader/probe fail closed outside multilingual state.
  "convex/lib/language/impactPreview.ts#hasLocalePrefixShadow#.kind": 1,
  "convex/lib/language/impactPreview.ts#readLivePreviewState#.kind": 2,
  "convex/lib/language/impactPreview.ts#readLivePreviewState#readSiteLanguageState": 1,
  "convex/lib/language/impactPreview.ts#readSectionPage#.kind": 1,
  "convex/lib/language/impactPreview.ts#startImpactPreviewInTransaction#.kind": 2,
  // M05 C3b default migration: start refuses an open migration (M6); the
  // worker, listing and receipt read one live state of their own (≤ 6 reads)
  // and never refuse the migration they serve.
  "convex/lib/language/defaultMigration.ts#namesMigration#.kind": 1,
  "convex/lib/language/defaultMigration.ts#readLiveMigrationState#.kind": 1,
  "convex/lib/language/defaultMigration.ts#readLiveMigrationState#classifySiteLanguageState": 1,
  "convex/lib/language/defaultMigration.ts#readLiveMigrationState#readAuthorityRows": 1,
  "convex/lib/language/defaultMigration.ts#startDefaultMigrationInTransaction#.kind": 2,
  "convex/lib/language/defaultMigration.ts#startDefaultMigrationInTransaction#readOpenDefaultMigration": 1,
  // Routing U2: the silent default change classifies once and refuses an open migration.
  "convex/lib/language/defaultMigration.ts#setDefaultLanguageInTransaction#.kind": 2,
  "convex/lib/language/defaultMigration.ts#setDefaultLanguageInTransaction#readOpenDefaultMigration": 1,
  // C3c.1: cancel classifies once and cancels only the open migration.
  "convex/lib/language/defaultMigration.ts#cancelDefaultMigrationInTransaction#.kind": 2,
  "convex/lib/language/defaultMigration.ts#cancelDefaultMigrationInTransaction#readOpenDefaultMigration": 1,
  "convex/lib/language/defaultMigration.ts#cancelDefaultMigrationInTransaction#readSiteLanguageState": 1,
  // C3c.2a: activation classifies once through the live migration state, and
  // a missing migration classifies first so state refusals keep their order.
  "convex/lib/language/defaultMigration.ts#activateDefaultMigrationInTransaction#.kind": 4,
  "convex/lib/language/defaultMigration.ts#activateDefaultMigrationInTransaction#readOpenDefaultMigration": 1,
  "convex/lib/language/defaultMigration.ts#activateDefaultMigrationInTransaction#readSiteLanguageState": 1,
  // M05 C3a: the open default migration (M6) gates every other command.
  "convex/lib/language/impactPreview.ts#startImpactPreviewInTransaction#readOpenDefaultMigration": 1,
  // Snapshot projections.
  "convex/lib/publishing/snapshots.ts#readCurrentSnapshotProjection#.kind": 1,
  "convex/lib/publishing/snapshots.ts#readCurrentSnapshotProjection#readSiteLanguageState": 1,
  "convex/lib/publishing/snapshots.ts#readHiddenTargetSnapshotProjection#.kind": 1,
  "convex/lib/publishing/snapshots.ts#readHiddenTargetSnapshotProjection#readOpenTransition": 1,
  "convex/lib/publishing/snapshots.ts#readHiddenTargetSnapshotProjection#readSiteLanguageState": 1,
  ...SOURCE_ONLY.languageSourceInventory,
}

type InventoryState = "V0S" | "V0M" | "CUR" | "ML" | "INV"
const INVENTORY_STATES: readonly InventoryState[] = [
  "V0S",
  "V0M",
  "CUR",
  "ML",
  "INV",
]

async function enableMultilingualModule(t: T) {
  await t.run(async (ctx) => {
    for (const row of await ctx.db.query("cmsModuleState").collect()) {
      await ctx.db.delete(row._id)
    }
    await ctx.db.insert("cmsModuleState", {
      key: "owner",
      configurationVersion: 1,
      enabledModules: [{ moduleId: "multilingual", configVersion: 1 }],
    })
  })
}

/** Patch the S1 authority and settings mirror to a multilingual row. */
async function makeMultilingual(t: T, locales: string[]) {
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").unique())!
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(settings._id, { enabledLocales: locales })
    await ctx.db.patch(authority._id, {
      mode: "multilingual",
      enabledLocales: locales,
      version: authority.version + 1,
    })
  })
  await enableMultilingualModule(t)
}

/**
 * V0S = S0, V0M = S2, CUR = S1. ML is S1 adopted with `en` and `fr` (only `en`
 * published). INV is S1 with a duplicated authority row.
 */
async function inventorySite(state: InventoryState): Promise<Site> {
  if (state === "V0S") return buildSite("S0", "absent")
  if (state === "V0M") return buildSite("S2", "absent")
  const site = await buildSite("S1", "absent")
  if (state === "ML") {
    await makeMultilingual(site.t, ["en", "fr"])
    return { ...site, locales: ["en", "fr"] }
  }
  if (state === "INV") {
    await site.t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db
        .query("siteLanguageAuthority")
        .unique())!
      void _id
      void _creationTime
      await ctx.db.insert("siteLanguageAuthority", row)
    })
  }
  return site
}

async function authorityVersion(t: T): Promise<number> {
  return (
    (await t.run((ctx) => ctx.db.query("siteLanguageAuthority").first()))
      ?.version ?? 0
  )
}

type InventoryRow = {
  row: string
  probe: (site: Site) => Promise<unknown>
  expected: Record<InventoryState, unknown>
}

const ok = (value: unknown) => ({ ok: value })
const refused = (code: string) => ({ error: code })
const perProbeLocale = (en: unknown, fr: unknown, nl: unknown) => ({
  en,
  fr,
  nl,
})

async function localeProbe(
  site: Site,
  run: (ctx: MutationCtx, locale: string) => Promise<unknown>
) {
  const results: Record<string, Outcome> = {}
  for (const locale of PROBE_LOCALES) {
    results[locale] = await site.t.run((ctx) => outcome(() => run(ctx, locale)))
  }
  return results
}

const INVALID = refused("SITE_LANGUAGE_AUTHORITY_INVALID")
const ML_ENABLED = refused("LANGUAGE_TRANSITION_MULTILINGUAL_ENABLED")

const INVENTORY_ROWS_C13: readonly InventoryRow[] = [
  {
    // C2b.1d: `readLivePreviewState` classifies once; start and every step
    // share it. A step under any non-S4 state ends its preview stale.
    row: "multilingual.startLanguageImpactPreview",
    probe: ({ owner }) =>
      outcome(async () => {
        const { previewId } = await owner.mutation(
          api.cms.multilingual.startLanguageImpactPreview,
          { kind: "remove", locale: "fr" }
        )
        return typeof previewId
      }),
    expected: {
      V0S: refused("CMS_MODULE_DISABLED"),
      V0M: refused("CMS_MODULE_DISABLED"),
      CUR: refused("CMS_MODULE_DISABLED"),
      ML: ok("string"),
      INV: refused("CMS_MODULE_DISABLED"),
    },
  },
  {
    // C2b.2a: add classifies once through `readLivePreviewState`. The ML
    // fixture has nothing retained in `nl`, so the add is plain.
    row: "multilingual.addLanguage",
    probe: async ({ t, owner }) => {
      const tokens = {
        expectedAuthorityVersion: await authorityVersion(t),
        expectedModuleConfigurationVersion: await moduleConfigurationVersion(t),
      }
      return outcome(async () => {
        const result = await owner.mutation(api.cms.multilingual.addLanguage, {
          locale: "nl",
          ...tokens,
        })
        return result.operationKind
      })
    },
    expected: {
      V0S: refused("CMS_MODULE_DISABLED"),
      V0M: refused("CMS_MODULE_DISABLED"),
      CUR: refused("CMS_MODULE_DISABLED"),
      ML: ok("add"),
      INV: refused("CMS_MODULE_DISABLED"),
    },
  },
  {
    // C2b.2b: remove classifies before it reads the preview, so every state
    // but S4 refuses whatever preview it names. Outside S4 no preview can
    // start, so the probe names a stored one; the ML fixture removes `fr`.
    row: "multilingual.removeLanguage",
    probe: async (site) => {
      const { t, owner } = site
      const previewId: PreviewId = await startPreview(
        site,
        "remove",
        "fr"
      ).then(
        async (started) => {
          await runPreview(t, started)
          await reviewEveryPage(site, started)
          return started
        },
        () =>
          t.run(async (ctx) =>
            ctx.db.insert("siteLanguageImpactPreviews", {
              kind: "remove",
              locale: "fr",
              owner: {
                ownerId: (await ctx.db.query("cmsOwner").unique())!._id,
                tokenIdentifier: OWNER.tokenIdentifier,
              },
              captured: {
                authorityVersion: 1,
                moduleConfigurationVersion: 1,
                site: { routeClaimVersion: 0, publicationSetVersion: 0 },
                locale: { routeClaimVersion: 0, publicationSetVersion: 0 },
              },
              phase: "complete",
              cursorPhase: "menus",
              count: { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
              digest: DISCLOSURE_CHAIN_EMPTY_DIGEST,
              pageCount: 0,
              reviewedThroughOrdinal: -1,
              generation: 1,
              createdAt: FIXED_NOW,
              updatedAt: FIXED_NOW,
              expiresAt: FIXED_NOW + 60_000,
            })
          )
      )
      return outcome(
        async () =>
          (await removeLanguage(owner, await previewClaim(t, previewId))).locale
      )
    },
    expected: {
      V0S: refused("CMS_MODULE_DISABLED"),
      V0M: refused("CMS_MODULE_DISABLED"),
      CUR: refused("CMS_MODULE_DISABLED"),
      ML: ok("fr"),
      INV: refused("CMS_MODULE_DISABLED"),
    },
  },
  {
    // C2b.2c: delayed-work eligibility (contract Delayed work). It has no
    // runtime caller until M07, and reads module state only for a stored
    // multilingual row (M2 exception 3).
    row: "assertReleaseExecutionEligible",
    probe: async ({ t }) => {
      const version = await authorityVersion(t)
      const results: Record<string, Outcome> = {}
      let moduleRead = false
      for (const [name, row] of [
        ["en", { locale: "en", capturedLanguageVersion: version }],
        ["fr", { locale: "fr", capturedLanguageVersion: version }],
        ["nl", { locale: "nl", capturedLanguageVersion: version }],
        ["versionless", { locale: "en" }],
      ] as const) {
        const { result, sets } = await recordSyscalls(() =>
          t.run((ctx) =>
            outcome(() => assertReleaseExecutionEligible(ctx, row))
          )
        )
        expect(sets.writes).toEqual([])
        moduleRead ||= sets.reads.includes(MODULE_STATE_READ)
        results[name] = result
      }
      return { ...results, moduleRead }
    },
    expected: {
      V0S: {
        en: ok(null),
        fr: ok("LOCALE_NOT_ENABLED"),
        nl: ok("LOCALE_NOT_ENABLED"),
        versionless: ok("LANGUAGE_VERSION_CHANGED"),
        moduleRead: false,
      },
      V0M: {
        en: ok(null),
        fr: ok(null),
        nl: ok("LOCALE_NOT_ENABLED"),
        versionless: ok("LANGUAGE_VERSION_CHANGED"),
        moduleRead: false,
      },
      CUR: {
        en: ok(null),
        fr: ok("LOCALE_NOT_ENABLED"),
        nl: ok("LOCALE_NOT_ENABLED"),
        versionless: ok("LANGUAGE_VERSION_CHANGED"),
        moduleRead: false,
      },
      ML: {
        en: ok(null),
        fr: ok(null),
        nl: ok("LOCALE_NOT_ENABLED"),
        versionless: ok(null),
        moduleRead: true,
      },
      INV: {
        en: INVALID,
        fr: INVALID,
        nl: INVALID,
        versionless: INVALID,
        moduleRead: false,
      },
    },
  },
  {
    // C3a: the open default migration (M6). It reads the named row only when
    // a multilingual authority names one; no fixture state does, so each
    // returns null and reads nothing beyond its classification.
    row: "readOpenDefaultMigration",
    probe: async ({ t }) => {
      const classified = await recordSyscalls(() =>
        t.run(async (ctx) => (await readSiteLanguageState(ctx)).kind)
      )
      const gated = await recordSyscalls(() =>
        t.run((ctx) =>
          outcome(async () =>
            readOpenDefaultMigration(ctx, await readSiteLanguageState(ctx))
          )
        )
      )
      expect(gated.sets.writes).toEqual([])
      return {
        open: gated.result,
        extraReads: gated.sets.reads.filter(
          (read) => !classified.sets.reads.includes(read)
        ),
      }
    },
    expected: {
      V0S: { open: ok(null), extraReads: [] },
      V0M: { open: ok(null), extraReads: [] },
      CUR: { open: ok(null), extraReads: [] },
      ML: { open: ok(null), extraReads: [] },
      INV: { open: ok(null), extraReads: [] },
    },
  },
  {
    row: "modules.preview / modules.commit (multilingual toggle)",
    probe: async ({ t, owner }) => {
      const enabled = await t.run(async (ctx) =>
        (await ctx.db.query("cmsModuleState").first())?.enabledModules.some(
          (entry) => entry.moduleId === "multilingual"
        )
      )
      return outcome(async () => {
        const preview = await owner.query(api.cms.modules.preview, {
          changes: [{ moduleId: "multilingual", enabled: !enabled }],
        })
        return preview.blockers.map((blocker) => blocker.code)
      })
    },
    expected: {
      V0S: ok([]),
      V0M: ok([]),
      CUR: ok([]),
      ML: ok(["MULTILINGUAL_AUTHORITY_ACTIVE"]),
      INV: ok(["LANGUAGE_STATE_INVALID"]),
    },
  },
  {
    row: "multilingual.getMultilingualState",
    probe: ({ owner }) =>
      outcome(async () => {
        const state = await owner.query(
          api.cms.multilingual.getMultilingualState,
          {}
        )
        return { lifecycleState: state.lifecycleState, origin: state.origin }
      }),
    expected: {
      V0S: ok({ lifecycleState: "S0", origin: null }),
      V0M: ok({ lifecycleState: "S2", origin: null }),
      CUR: ok({ lifecycleState: "S1", origin: null }),
      ML: ok({ lifecycleState: "S4", origin: null }),
      INV: ok({ lifecycleState: "IX", origin: null }),
    },
  },
  {
    row: "multilingual.previewAdoption",
    probe: ({ owner }) =>
      outcome(async () => {
        const preview = await owner.query(
          api.cms.multilingual.previewAdoption,
          {}
        )
        return preview.canAdopt ? "can_adopt" : preview.blockerCode
      }),
    expected: {
      V0S: refused("CMS_MODULE_DISABLED"),
      V0M: refused("CMS_MODULE_DISABLED"),
      CUR: refused("CMS_MODULE_DISABLED"),
      ML: ok("MULTILINGUAL_ALREADY_ADOPTED"),
      INV: refused("CMS_MODULE_DISABLED"),
    },
  },
  {
    row: "multilingual.returnToSingleLanguage",
    probe: async ({ t, owner }) => {
      const version = await authorityVersion(t)
      return outcome(() =>
        owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
          expectedAuthorityVersion: version,
        })
      )
    },
    expected: {
      V0S: refused("CMS_MODULE_DISABLED"),
      V0M: refused("CMS_MODULE_DISABLED"),
      CUR: refused("CMS_MODULE_DISABLED"),
      ML: refused("LANGUAGE_MULTIPLE_LOCALES_ENABLED"),
      INV: refused("CMS_MODULE_DISABLED"),
    },
  },
]

const INVENTORY_ROWS: readonly InventoryRow[] = [
  {
    row: "publication.restoreSnapshotAsDraft",
    probe: async ({ t, owner, aboutId }) => {
      const state = await localeState(t, aboutId, "en")
      return outcome(async () => {
        const result = await owner.mutation(
          api.cms.publication.restoreSnapshotAsDraft,
          {
            ...(await publishArgs(t, aboutId, "en")),
            snapshotId: state.currentSnapshotId!,
          }
        )
        return result.draftGeneration === state.draftGeneration + 1
      })
    },
    expected: {
      V0S: ok(true),
      V0M: ok(true),
      CUR: ok(true),
      ML: ok(true),
      INV: INVALID,
    },
  },
  {
    row: "classifySiteLanguageState",
    probe: ({ t }) => t.run((ctx) => outcome(() => readSiteLanguageState(ctx))),
    expected: {
      V0S: ok({ kind: "uninitialized", version: 0, locale: "en" }),
      V0M: ok({ kind: "multi_locale", version: 0, locales: ["en", "fr"] }),
      CUR: ok({ kind: "current", version: 1, locale: "en" }),
      ML: ok({
        kind: "multilingual",
        version: 2,
        locale: "en",
        locales: ["en", "fr"],
      }),
      INV: ok({ kind: "invalid" }),
    },
  },
  {
    row: "readPublicSiteLanguageState / assertPublicLanguageVersion",
    probe: async ({ t }) => {
      const version = await authorityVersion(t)
      return t.run((ctx) =>
        outcome(async () => ({
          state: (await readPublicSiteLanguageState(ctx)).kind,
          pinned: (await assertPublicLanguageVersion(ctx, version)).version,
        }))
      )
    },
    expected: {
      V0S: ok({ state: "uninitialized", pinned: 0 }),
      V0M: ok({ state: "multi_locale", pinned: 0 }),
      CUR: ok({ state: "current", pinned: 1 }),
      ML: ok({ state: "multilingual", pinned: 2 }),
      INV: INVALID,
    },
  },
  {
    row: "readOpenTransition",
    probe: ({ t }) =>
      t.run((ctx) =>
        outcome(async () =>
          readOpenTransition(ctx, await readSiteLanguageState(ctx))
        )
      ),
    expected: {
      V0S: ok(null),
      V0M: ok(null),
      CUR: ok(null),
      ML: ok(null),
      INV: ok(null),
    },
  },
  {
    row: "assertOrdinaryLocale",
    probe: async (site) => {
      const results = await localeProbe(
        site,
        async (ctx, locale) => (await assertOrdinaryLocale(ctx, locale)).kind
      )
      return results
    },
    expected: {
      V0S: perProbeLocale(
        ok("uninitialized"),
        refused("LOCALE_NOT_ENABLED"),
        refused("LOCALE_NOT_ENABLED")
      ),
      V0M: perProbeLocale(
        ok("multi_locale"),
        ok("multi_locale"),
        refused("LOCALE_NOT_ENABLED")
      ),
      CUR: perProbeLocale(
        ok("current"),
        refused("LOCALE_NOT_ENABLED"),
        refused("LOCALE_NOT_ENABLED")
      ),
      ML: perProbeLocale(
        ok("multilingual"),
        ok("multilingual"),
        refused("LOCALE_NOT_ENABLED")
      ),
      INV: perProbeLocale(INVALID, INVALID, INVALID),
    },
  },
  {
    row: "resolveDraftLocaleEligibility",
    probe: (site) =>
      localeProbe(
        site,
        async (ctx, locale) =>
          (await resolveDraftLocaleEligibility(ctx, locale)).kind
      ),
    expected: {
      V0S: perProbeLocale(
        ok("ordinary"),
        refused("LOCALE_NOT_ENABLED"),
        refused("LOCALE_NOT_ENABLED")
      ),
      V0M: perProbeLocale(
        ok("ordinary"),
        ok("ordinary"),
        refused("LOCALE_NOT_ENABLED")
      ),
      CUR: perProbeLocale(
        ok("ordinary"),
        refused("LOCALE_NOT_ENABLED"),
        refused("LOCALE_NOT_ENABLED")
      ),
      ML: perProbeLocale(
        ok("ordinary"),
        ok("ordinary"),
        refused("LOCALE_NOT_ENABLED")
      ),
      INV: perProbeLocale(INVALID, INVALID, INVALID),
    },
  },
  {
    row: "assertNoLanguageTransitionConflicts",
    probe: ({ t }) =>
      t.run((ctx) => outcome(() => assertNoLanguageTransitionConflicts(ctx))),
    expected: {
      V0S: ok(null),
      V0M: ok(null),
      CUR: ok(null),
      ML: ML_ENABLED,
      INV: ok(null),
    },
  },
  {
    row: "readActiveTransitionForWrite / recordSourcePublicChange",
    probe: ({ t }) =>
      t.run((ctx) => outcome(() => recordSourcePublicChange(ctx))),
    expected: {
      V0S: ok(null),
      V0M: ok(null),
      CUR: ok(null),
      ML: ok(null),
      INV: INVALID,
    },
  },
  {
    row: "requireActiveTransition (continueLanguageTransition)",
    probe: ({ owner }) =>
      outcome(() =>
        owner.mutation(api.cms.language.continueLanguageTransition, {
          transitionId: MISSING_TRANSITION,
          expectedGeneration: 0,
        })
      ),
    expected: {
      V0S: INVALID,
      V0M: INVALID,
      CUR: refused("LANGUAGE_TRANSITION_NOT_OPEN"),
      ML: ML_ENABLED,
      INV: INVALID,
    },
  },
  {
    row: "initializeSiteLanguageAuthority",
    probe: ({ owner }) =>
      outcome(() =>
        owner.mutation(api.cms.language.initializeSiteLanguageAuthority, {})
      ),
    expected: {
      V0S: ok({ version: 1, currentLocale: "en" }),
      V0M: refused("LANGUAGE_MULTI_LOCALE_REQUIRES_L01_M05"),
      CUR: INVALID,
      ML: refused("MULTILINGUAL_ALREADY_ADOPTED"),
      INV: INVALID,
    },
  },
  {
    row: "getLanguageState",
    probe: ({ owner }) =>
      outcome(async () => {
        const state = await owner.query(api.cms.language.getLanguageState, {})
        return {
          kind: state.kind,
          version: state.version,
          currentLocale: state.currentLocale,
          enabledLocales: state.enabledLocales,
          transition: state.transition,
        }
      }),
    expected: {
      V0S: ok({
        kind: "uninitialized",
        version: 0,
        currentLocale: "en",
        enabledLocales: ["en"],
        transition: null,
      }),
      V0M: ok({
        kind: "multi_locale",
        version: 0,
        currentLocale: null,
        enabledLocales: ["en", "fr"],
        transition: null,
      }),
      CUR: ok({
        kind: "current",
        version: 1,
        currentLocale: "en",
        enabledLocales: ["en"],
        transition: null,
      }),
      ML: ok({
        kind: "multilingual",
        version: 2,
        currentLocale: "en",
        enabledLocales: ["en", "fr"],
        transition: null,
      }),
      INV: ok({
        kind: "invalid",
        version: null,
        currentLocale: null,
        enabledLocales: [],
        transition: null,
      }),
    },
  },
  {
    row: "getSourcePublicationNotice",
    probe: ({ owner, aboutId }) =>
      outcome(() =>
        owner.query(api.cms.language.getSourcePublicationNotice, {
          pageId: aboutId,
        })
      ),
    expected: {
      V0S: ok(null),
      V0M: ok(null),
      CUR: ok(null),
      ML: ok(null),
      INV: ok(null),
    },
  },
  {
    row: "startLanguageTransition",
    probe: async ({ t, owner }) => {
      const settings = await t.run((ctx) =>
        ctx.db.query("siteSettings").unique()
      )
      const version = await authorityVersion(t)
      return outcome(
        async () =>
          typeof (await owner.mutation(
            api.cms.language.startLanguageTransition,
            {
              mode: "correct_label",
              sourceLocale: "en",
              targetLocale: "nl",
              expectedSettingsUpdatedAt: settings!.updatedAt,
              expectedAuthorityVersion: version,
            }
          ))
      )
    },
    expected: {
      V0S: INVALID,
      V0M: refused("LANGUAGE_MULTI_LOCALE_REQUIRES_L01_M05"),
      CUR: ok("string"),
      ML: ML_ENABLED,
      INV: INVALID,
    },
  },
  {
    row: "activateLanguageTransitionInTransaction",
    probe: async ({ t }) => {
      const settings = await t.run((ctx) =>
        ctx.db.query("siteSettings").unique()
      )
      const version = await authorityVersion(t)
      return t.run((ctx) =>
        outcome(() =>
          activateLanguageTransitionInTransaction(ctx, {
            transitionId: MISSING_TRANSITION,
            expectedGeneration: 0,
            expectedAuthorityVersion: version,
            expectedSettingsUpdatedAt: settings!.updatedAt,
            expectedReadinessVersion: 0,
          })
        )
      )
    },
    expected: {
      V0S: INVALID,
      V0M: INVALID,
      CUR: refused("LANGUAGE_TRANSITION_NOT_OPEN"),
      ML: ML_ENABLED,
      INV: INVALID,
    },
  },
  {
    row: "requireOpenTransitionById (publishPreparedTargetLocale)",
    probe: ({ t, aboutId }) =>
      t.run((ctx) =>
        outcome(() =>
          publishPreparedTargetLocale(ctx, {
            transitionId: MISSING_TRANSITION,
            pageId: aboutId,
            expectedTargetPublicGeneration: 0,
            expectedLifecycleGeneration: 0,
            expectedReleaseGeneration: 0,
            arm: "draft",
            expectedTargetDraftGeneration: 0,
            expectedSharedDraftGeneration: 0,
          })
        )
      ),
    expected: {
      V0S: INVALID,
      V0M: INVALID,
      CUR: refused("LANGUAGE_TRANSITION_PHASE_INVALID"),
      ML: refused("LANGUAGE_TRANSITION_PHASE_INVALID"),
      INV: INVALID,
    },
  },
  {
    row: "readCurrentSnapshotProjection / readHiddenTargetSnapshotProjection",
    probe: (site) =>
      localeProbe(site, async (ctx, locale) => ({
        current:
          (await readCurrentSnapshotProjection(ctx, site.aboutId, locale)) !==
          null,
        hidden:
          (await readHiddenTargetSnapshotProjection(
            ctx,
            site.aboutId,
            locale
          )) !== null,
      })),
    expected: {
      V0S: perProbeLocale(
        ok({ current: true, hidden: false }),
        ok({ current: false, hidden: false }),
        ok({ current: false, hidden: false })
      ),
      V0M: perProbeLocale(
        ok({ current: true, hidden: false }),
        ok({ current: true, hidden: false }),
        ok({ current: false, hidden: false })
      ),
      CUR: perProbeLocale(
        ok({ current: true, hidden: false }),
        ok({ current: false, hidden: false }),
        ok({ current: false, hidden: false })
      ),
      // `fr` is enabled but has no selection yet.
      ML: perProbeLocale(
        ok({ current: true, hidden: false }),
        ok({ current: false, hidden: false }),
        ok({ current: false, hidden: false })
      ),
      INV: perProbeLocale(
        ok({ current: false, hidden: false }),
        ok({ current: false, hidden: false }),
        ok({ current: false, hidden: false })
      ),
    },
  },
  {
    row: "getSiteConfig",
    probe: ({ t }) =>
      outcome(async () => {
        const config = await t.query(api.cms.settings.getSiteConfig, {})
        return {
          defaultLocale: config.defaultLocale,
          enabledLocales: config.enabledLocales,
          languageVersion: config.languageVersion,
        }
      }),
    expected: {
      V0S: ok({
        defaultLocale: "en",
        enabledLocales: ["en"],
        languageVersion: 0,
      }),
      V0M: ok({
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        languageVersion: 0,
      }),
      CUR: ok({
        defaultLocale: "en",
        enabledLocales: ["en"],
        languageVersion: 1,
      }),
      ML: ok({
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        languageVersion: 2,
      }),
      INV: INVALID,
    },
  },
]

describe("M05 P18 classifier inventory", () => {
  test("every language-state consumer and gate call is inventoried by file and function", () => {
    const uses = scanSourceUses({
      root: REPO_ROOT,
      entries: ["convex", "lib", "app", "components", "hooks", "proxy.ts"],
      callees: LANGUAGE_CALLEES,
      kindLiterals: LANGUAGE_KINDS,
    })
    const counts: Record<string, number> = {}
    for (const use of uses) counts[use] = (counts[use] ?? 0) + 1
    expect(counts).toEqual(LANGUAGE_SOURCE_INVENTORY)
  }, 60_000)

  test.each(
    [...INVENTORY_ROWS, ...INVENTORY_ROWS_C13].flatMap((row) =>
      INVENTORY_STATES.map((state) => [row.row, state, row] as const)
    )
  )(
    "%s under %s behaves as inventoried",
    async (_name, state, row) => {
      const site = await inventorySite(state)
      expect(normalizeIds(await row.probe(site))).toMatchObject(
        row.expected[state] as object
      )
    },
    60_000
  )

  test("bootstrap resume refuses a multilingual authority", async () => {
    // A resumable bootstrap: settings and the unpublished home exist.
    const resume = async (multilingual: boolean) => {
      const t = app()
      const owner = t.withIdentity(OWNER)
      const args = { siteName: "P18", timezone: "UTC", defaultLocale: "en" }
      await owner.mutation(api.cms.settings.bootstrapInstallation, args)
      if (multilingual) await makeMultilingual(t, ["en"])
      return outcome(() =>
        owner.mutation(api.cms.settings.bootstrapInstallation, args)
      )
    }
    expect(await resume(false)).toMatchObject({ ok: { revision: 1 } })
    expect(await resume(true)).toEqual(
      refused("INSTALLATION_BOOTSTRAP_STATE_INVALID")
    )
  })

  test("a multilingual row needs every M1 condition, and a single row stays current", async () => {
    const classify = async (
      patch: (t: T) => Promise<void>
    ): Promise<string> => {
      const site = await buildSite("S1", "absent")
      await makeMultilingual(site.t, ["en", "fr"])
      await patch(site.t)
      return site.t.run(async (ctx) => (await readSiteLanguageState(ctx)).kind)
    }
    const authority = async (t: T, fields: Record<string, unknown>) =>
      t.run(async (ctx) => {
        const row = (await ctx.db.query("siteLanguageAuthority").unique())!
        await ctx.db.patch(row._id, fields)
      })
    const settings = async (t: T, fields: Record<string, unknown>) =>
      t.run(async (ctx) => {
        const row = (await ctx.db.query("siteSettings").unique())!
        await ctx.db.patch(row._id, fields)
      })

    expect(await classify(async () => {})).toBe("multilingual")
    expect(
      await classify((t) =>
        t.run(async (ctx) => {
          const row = (await ctx.db.query("cmsModuleState").unique())!
          await ctx.db.patch(row._id, { enabledModules: [] })
        })
      )
    ).toBe("invalid")
    expect(
      await classify((t) =>
        t.run(async (ctx) => {
          for (const row of await ctx.db.query("cmsModuleState").collect()) {
            await ctx.db.delete(row._id)
          }
        })
      )
    ).toBe("invalid")
    expect(
      await classify((t) =>
        t.run(async (ctx) => {
          await ctx.db.insert("cmsModuleState", {
            key: "owner",
            configurationVersion: 1,
            enabledModules: [{ moduleId: "multilingual", configVersion: 1 }],
          })
        })
      )
    ).toBe("invalid")
    expect(await classify((t) => settings(t, { enabledLocales: ["en"] }))).toBe(
      "invalid"
    )
    expect(
      await classify((t) =>
        settings(t, { enabledLocales: ["fr", "en"] }).then(() =>
          authority(t, { enabledLocales: ["fr", "en"] })
        )
      )
    ).toBe("multilingual")
    expect(await classify((t) => settings(t, { defaultLocale: "fr" }))).toBe(
      "invalid"
    )
    expect(
      await classify((t) =>
        settings(t, { enabledLocales: ["en", "xx"] }).then(() =>
          authority(t, { enabledLocales: ["en", "xx"] })
        )
      )
    ).toBe("invalid")
    expect(
      await classify((t) =>
        settings(t, { enabledLocales: ["fr"] }).then(() =>
          authority(t, { enabledLocales: ["fr"] })
        )
      )
    ).toBe("invalid")
    expect(await classify((t) => authority(t, { enabledLocales: [] }))).toBe(
      "invalid"
    )
    expect(await classify((t) => authority(t, { version: 0 }))).toBe("invalid")
    expect(
      await classify((t) =>
        authority(t, { activeTransitionId: MISSING_TRANSITION })
      )
    ).toBe("invalid")

    const single = async (fields: Record<string, unknown>) => {
      const site = await buildSite("S1", "absent")
      await authority(site.t, fields)
      return site.t.run(async (ctx) => (await readSiteLanguageState(ctx)).kind)
    }
    expect(await single({ mode: "single" })).toBe("current")
    expect(await single({ enabledLocales: ["en"] })).toBe("invalid")
    expect(await single({ mode: "single", enabledLocales: ["en"] })).toBe(
      "invalid"
    )
  })

  test("a raw multilingual row with the module disabled or missing classifies invalid after one module read", async () => {
    for (const variant of ["disabled", "absent"] as const) {
      const site = await buildSite("S1", variant)
      await site.t.run(async (ctx) => {
        const row = (await ctx.db.query("siteLanguageAuthority").unique())!
        await ctx.db.patch(row._id, {
          mode: "multilingual",
          enabledLocales: ["en"],
        })
      })
      const { result, sets } = await recordSyscalls(() =>
        site.t.run(async (ctx) => (await readSiteLanguageState(ctx)).kind)
      )
      expect(result).toBe("invalid")
      expect(sets.reads).toEqual([
        MODULE_STATE_READ,
        'query siteLanguageAuthority.by_key [key Eq "site-language-v1"] asc +operators [{"limit":2}]',
        'query siteSettings full-scan asc +operators [{"limit":2}]',
      ])
      expect(sets.writes).toEqual([])
    }
  })

  test("a current authority with the multilingual module enabled refuses F09 start (S3 from S1)", async () => {
    const site = await buildSite("S1", "absent")
    await enableMultilingualModule(site.t)
    expect(
      await site.t.run(async (ctx) => (await readSiteLanguageState(ctx)).kind)
    ).toBe("current")
    const settings = await site.t.run((ctx) =>
      ctx.db.query("siteSettings").unique()
    )
    expect(
      await outcome(() =>
        site.owner.mutation(api.cms.language.startLanguageTransition, {
          mode: "correct_label",
          sourceLocale: "en",
          targetLocale: "nl",
          expectedSettingsUpdatedAt: settings!.updatedAt,
          expectedAuthorityVersion: 1,
        })
      )
    ).toEqual(ML_ENABLED)
  })

  test("the continuity resolver serves F09 routes for the default language after adoption", async () => {
    const site = await buildSite("S1", "absent")
    const { t, aboutId } = site
    await t.run(async (ctx) => {
      const owner = (await ctx.db
        .query("cmsOwner")
        .withIndex("by_key", (q) => q.eq("key", "owner"))
        .unique())!
      const transitionId = await ctx.db.insert("siteLanguageTransitions", {
        mode: "correct_label",
        sourceLocale: "nl",
        targetLocale: "en",
        phase: "committed",
        generation: 1,
        startAuthorityVersion: 1,
        startSettingsUpdatedAt: FIXED_NOW,
        shortPath: false,
        sourcePublicSetVersion: 0,
        preparedSetVersion: 0,
        pageCount: 1,
        targetCount: 1,
        withdrawCount: 0,
        redirectCount: 0,
        unresolvedCount: 0,
        blockedCount: 0,
        targetDrafts: "retained",
        committedAt: FIXED_NOW,
        attribution: {
          kind: "owner",
          ownerId: owner._id,
          authId: owner.authId,
          tokenIdentifier: owner.tokenIdentifier,
        },
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      })
      await ctx.db.insert("siteLanguageTransitionRoutes", {
        transitionId,
        fromPath: "/ueber-uns",
        pageId: aboutId,
        origin: "source_current",
        createdAt: FIXED_NOW,
      })
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, {
        lastCommittedTransitionId: transitionId,
      })
    })
    await makeMultilingual(t, ["en", "fr"])
    const resolve = (locale: string) =>
      t.query(api.cms.pages.resolveHistoricalPublishedPath, {
        locale,
        path: "/ueber-uns",
        languageVersion: 2,
      })
    expect(await resolve("en")).toMatchObject({
      disposition: "historical_redirect",
      locale: "en",
      destinationPath: "/about",
    })
    expect(await resolve("fr")).toMatchObject({ disposition: "unclaimed" })
  })
})

// ─── P3 adoption and lifecycle, P2a owner-only, P9, P11a ───────────────────

async function moduleConfigurationVersion(t: T): Promise<number> {
  return (
    (await t.run((ctx) => ctx.db.query("cmsModuleState").first()))
      ?.configurationVersion ?? 0
  )
}

async function toggleMultilingual(
  site: Pick<Site, "t" | "owner">,
  enabled: boolean
) {
  const changes = [{ moduleId: "multilingual", enabled }]
  const preview = await site.owner.query(api.cms.modules.preview, { changes })
  return site.owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: await moduleConfigurationVersion(site.t),
    changes,
    multilingualCommandTokens: preview.multilingualCommandTokens,
  })
}

// Raw writer still refuses adopted authority; public Apply composes the safe return.
async function rawToggleMultilingual(
  site: Pick<Site, "t" | "owner">,
  enabled: boolean
) {
  const version = await moduleConfigurationVersion(site.t)
  return site.owner.mutation(async (ctx) => {
    await requireInstallationOwner(ctx)
    return commitModuleTransitionInTransaction(ctx, {
      expectedConfigurationVersion: version,
      changes: [{ moduleId: "multilingual", enabled }],
    })
  })
}

async function adopt(site: Pick<Site, "owner">) {
  const preview = await site.owner.query(
    api.cms.multilingual.previewAdoption,
    {}
  )
  if (!preview.canAdopt) throw new ConvexError(preview.blockerCode)
  const { canAdopt, defaultLocale, enabledLocales, ...tokens } = preview
  void canAdopt
  void defaultLocale
  void enabledLocales
  return site.owner.mutation(
    api.cms.multilingual.adoptMultilingualAuthority,
    tokens
  )
}

async function lifecycleOf(site: Pick<Site, "owner">) {
  const state = await site.owner.query(
    api.cms.multilingual.getMultilingualState,
    {}
  )
  return state.origin
    ? `${state.lifecycleState}(${state.origin})`
    : state.lifecycleState
}

/** Every public-facing row adoption must leave untouched (M9, M10). */
async function publicSurface(t: T) {
  return t.run(async (ctx) =>
    normalizeIds({
      settings: await ctx.db.query("siteSettings").collect(),
      states: await ctx.db.query("pageLocalePublicationStates").collect(),
      snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
      releases: await ctx.db.query("pageLocalePublicationReleases").collect(),
      historical: await ctx.db.query("pageHistoricalLocaleRoutes").collect(),
      redirects: await ctx.db.query("redirects").collect(),
    })
  )
}

async function intentsOf(t: T) {
  return t.run(async (ctx) =>
    (await ctx.db.query("siteLanguageLifecycleIntents").collect()).map(
      (intent) => ({
        operationId: intent.operationId,
        operationKind: intent.operationKind,
        locales: intent.locales,
        capturedAuthorityVersion: intent.capturedAuthorityVersion,
      })
    )
  )
}

async function everyRow(t: T) {
  return t.run(async (ctx) => {
    const rows: Record<string, unknown[]> = {}
    for (const table of Object.keys(schema.tables).sort()) {
      rows[table] = await ctx.db
        .query(table as keyof typeof schema.tables)
        .collect()
    }
    return rows
  })
}

async function refusalWritesNothing(t: T, run: () => Promise<unknown>) {
  const before = await everyRow(t)
  const result = await outcome(run)
  expect(await everyRow(t)).toEqual(before)
  return result
}

describe("M05 P3 adoption and lifecycle", () => {
  test.each(["S0", "S1", "S2"] as const)(
    "%s → S3 → S4 adopts without changing a URL, snapshot or locale",
    async (origin) => {
      const site = await buildSite(origin, "absent")
      const { t, locales } = site
      const config = await t.query(api.cms.settings.getSiteConfig, {})
      const read = async (languageVersion: number) =>
        Promise.all(
          locales.map(async (locale) => {
            const id = await t.query(api.cms.pages.resolveLocalizedPathQuery, {
              path: "about",
              locale,
              languageVersion,
            })
            return normalizeIds({
              id,
              page: id
                ? await t.query(api.cms.pages.getPublicPageById, {
                    id,
                    locale,
                    languageVersion,
                  })
                : null,
            })
          })
        )
      const beforeRead = await read(config.languageVersion)
      const beforeSurface = await publicSurface(t)

      expect(await lifecycleOf(site)).toBe(origin)
      await toggleMultilingual(site, true)
      expect(await lifecycleOf(site)).toBe(`S3(${origin})`)
      expect(await publicSurface(t)).toEqual(beforeSurface)

      const result = await adopt(site)
      const version = config.languageVersion + 1
      expect(result).toEqual({
        version,
        defaultLocale: "en",
        enabledLocales: locales,
      })
      expect(await lifecycleOf(site)).toBe("S4")
      // Settings, snapshots, routes, releases and rules are untouched;
      // version-0 multi-locale keeps every locale (never pruned).
      expect(await publicSurface(t)).toEqual(beforeSurface)
      const after = await t.query(api.cms.settings.getSiteConfig, {})
      expect(after).toEqual({ ...config, languageVersion: version })
      expect(await read(version)).toEqual(beforeRead)
      expect(await intentsOf(t)).toEqual([
        expect.objectContaining({ operationKind: "module_toggle" }),
        {
          operationId: `adopt:v${version}`,
          operationKind: "adopt",
          locales,
          capturedAuthorityVersion: version,
        },
      ])
      // An old-version reader retries rather than falling back.
      expect(
        await outcome(() =>
          t.query(api.cms.pages.resolveLocalizedPathQuery, {
            path: "about",
            locale: "en",
            languageVersion: config.languageVersion,
          })
        )
      ).toEqual(refused("SITE_LANGUAGE_VERSION_CHANGED"))
    }
  )

  test.each(["S0", "S1", "S2"] as const)(
    "S3(%s) → %s by disabling before adoption",
    async (origin) => {
      const site = await buildSite(origin, "absent")
      const authority = async () =>
        site.t.run((ctx) => ctx.db.query("siteLanguageAuthority").collect())
      const before = await authority()
      await toggleMultilingual(site, true)
      await toggleMultilingual(site, false)
      expect(await lifecycleOf(site)).toBe(origin)
      expect(await authority()).toEqual(before)
    }
  )

  test("S4 → S3(S1) → S1, then re-enable and re-adopt", async () => {
    const site = await buildSite("S1", "absent")
    await toggleMultilingual(site, true)
    await adopt(site)
    expect(await lifecycleOf(site)).toBe("S4")

    // The raw flag writer remains blocked; public Apply models a safe return.
    expect(
      await refusalWritesNothing(site.t, () =>
        rawToggleMultilingual(site, false)
      )
    ).toEqual(refused("CMS_MODULE_TRANSITION_BLOCKED"))
    expect(
      await site.owner.query(api.cms.modules.preview, {
        changes: [{ moduleId: "multilingual", enabled: false }],
      })
    ).toMatchObject({
      blockers: [],
    })

    const stale = await refusalWritesNothing(site.t, () =>
      site.owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
        expectedAuthorityVersion: 1,
      })
    )
    expect(stale).toEqual(refused("LANGUAGE_OPERATION_STALE"))
    expect(
      await site.owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
        expectedAuthorityVersion: 2,
      })
    ).toEqual({ version: 3, locale: "en" })
    expect(await lifecycleOf(site)).toBe("S3(S1)")
    expect(
      await site.t.run((ctx) => ctx.db.query("siteLanguageAuthority").unique())
    ).toMatchObject({ mode: "single", version: 3, currentLocale: "en" })
    expect(
      await site.t.run(async (ctx) =>
        Object.keys((await ctx.db.query("siteLanguageAuthority").unique())!)
      )
    ).not.toContain("enabledLocales")

    await toggleMultilingual(site, false)
    expect(await lifecycleOf(site)).toBe("S1")

    await toggleMultilingual(site, true)
    expect(await adopt(site)).toMatchObject({ version: 4 })
    expect(await lifecycleOf(site)).toBe("S4")
    expect(
      (await intentsOf(site.t)).map((intent) => intent.operationId)
    ).toEqual([
      "module_toggle:c1",
      "adopt:v2",
      "return_to_single:v3",
      "module_toggle:c2",
      "module_toggle:c3",
      "adopt:v4",
    ])
  })

  test("adoption refusals write nothing", async () => {
    const expectRefusal = async (
      site: Pick<Site, "t" | "owner">,
      code: string
    ) =>
      expect(
        await refusalWritesNothing(site.t, () =>
          site.owner.mutation(api.cms.multilingual.adoptMultilingualAuthority, {
            expectedSettingsUpdatedAt: FIXED_NOW,
            expectedModuleConfigurationVersion: 1,
            expectedAuthorityVersion: null,
          })
        )
      ).toEqual(refused(code))

    // Legacy epoch.
    {
      const t = convexTest({
        schema,
        modules,
        ownerIdentity: OWNER,
        publicationAuthority: "legacy",
      })
      installSyscallRecorder()
      const owner = t.withIdentity(OWNER)
      await owner.query(api.cms.language.getLanguageState, {})
      await t.run((ctx) =>
        ctx.db.insert("siteSettings", {
          siteName: "Legacy",
          siteUrl: "",
          defaultLocale: "en",
          enabledLocales: ["en"],
          updatedAt: FIXED_NOW,
        })
      )
      await enableMultilingualModule(t)
      await expectRefusal(
        { t, owner },
        "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY"
      )
    }
    // Module not enabled.
    await expectRefusal(
      await buildSite("S0", "disabled"),
      "CMS_MODULE_DISABLED"
    )
    // Duplicate authority (invalid state).
    {
      const site = await inventorySite("INV")
      await enableMultilingualModule(site.t)
      await expectRefusal(site, "SITE_LANGUAGE_AUTHORITY_INVALID")
    }
    // Settings that disagree with the authority (invalid state).
    {
      const site = await buildSite("S1", "absent")
      await site.t.run(async (ctx) => {
        const row = (await ctx.db.query("siteLanguageAuthority").unique())!
        await ctx.db.patch(row._id, { currentLocale: "fr" })
      })
      await enableMultilingualModule(site.t)
      await expectRefusal(site, "SITE_LANGUAGE_AUTHORITY_INVALID")
    }
    // Duplicate and unsupported locales.
    for (const [enabledLocales, code] of [
      [["en", "en"], "SITE_LANGUAGE_AUTHORITY_INVALID"],
      [["en", "xx"], "LOCALE_UNSUPPORTED"],
    ] as const) {
      const site = await buildSite("S2", "absent")
      await site.t.run(async (ctx) => {
        const row = (await ctx.db.query("siteSettings").unique())!
        await ctx.db.patch(row._id, { enabledLocales: [...enabledLocales] })
      })
      await enableMultilingualModule(site.t)
      await expectRefusal(site, code)
    }
    // Already adopted.
    {
      const site = await inventorySite("ML")
      await expectRefusal(site, "MULTILINGUAL_ALREADY_ADOPTED")
    }
    // Stale tokens.
    {
      const site = await buildSite("S0", "absent")
      await enableMultilingualModule(site.t)
      // Settings moved after the caller's preview.
      await site.t.run(async (ctx) => {
        const row = (await ctx.db.query("siteSettings").unique())!
        await ctx.db.patch(row._id, { updatedAt: FIXED_NOW + 1 })
      })
      await expectRefusal(site, "LANGUAGE_OPERATION_STALE")
    }
  })

  test.each(["open", "cancelling"] as const)(
    "an %s F09 transition refuses enable and adoption",
    async (phase) => {
      const site = await buildSite("S1", "absent")
      const settings = await site.t.run((ctx) =>
        ctx.db.query("siteSettings").unique()
      )
      const transitionId = await site.owner.mutation(
        api.cms.language.startLanguageTransition,
        {
          mode: "correct_label",
          sourceLocale: "en",
          targetLocale: "nl",
          expectedSettingsUpdatedAt: settings!.updatedAt,
          expectedAuthorityVersion: 1,
        }
      )
      if (phase === "cancelling") {
        await site.t.run((ctx) =>
          ctx.db.patch(transitionId, { phase: "cancelling" })
        )
      }
      expect(
        await site.owner.query(api.cms.modules.preview, {
          changes: [{ moduleId: "multilingual", enabled: true }],
        })
      ).toMatchObject({
        blockers: [
          {
            code: "LANGUAGE_OPERATION_OPEN",
            moduleId: "multilingual",
            kind: "language_transition",
          },
        ],
      })
      expect(
        await refusalWritesNothing(site.t, () => toggleMultilingual(site, true))
      ).toEqual(refused("CMS_MODULE_TRANSITION_BLOCKED"))

      // Module state seeded past the gate: adoption still refuses.
      await enableMultilingualModule(site.t)
      expect(
        await site.owner.query(api.cms.multilingual.previewAdoption, {})
      ).toEqual({ canAdopt: false, blockerCode: "LANGUAGE_TRANSITION_OPEN" })
      expect(
        await refusalWritesNothing(site.t, () =>
          site.owner.mutation(api.cms.multilingual.adoptMultilingualAuthority, {
            expectedSettingsUpdatedAt: settings!.updatedAt,
            expectedModuleConfigurationVersion: 1,
            expectedAuthorityVersion: 1,
          })
        )
      ).toEqual(refused("LANGUAGE_TRANSITION_OPEN"))
    }
  )

  test("enabling multilingual in invalid state refuses with the integrity code", async () => {
    const site = await inventorySite("INV")
    expect(
      await refusalWritesNothing(site.t, () => toggleMultilingual(site, true))
    ).toEqual(INVALID)
  })
})

describe("M05 P2a owner-only foundation", () => {
  test("only the current owner reaches M05 foundation commands and queries", async () => {
    const t = convexTest({ schema, modules, publicationAuthority: "missing" })
    installSyscallRecorder()
    const FORMER = OWNER
    const CURRENT = {
      subject: "m05-p2a-current",
      tokenIdentifier: "https://convex.test|m05-p2a-current",
    }
    const LEGACY_ADMIN = {
      subject: "m05-p2a-legacy-admin",
      tokenIdentifier: "https://convex.test|m05-p2a-legacy-admin",
    }
    await seedCommunityOwner(t, FORMER)
    const former = t.withIdentity(FORMER)
    await former.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "P2a",
      timezone: "UTC",
      defaultLocale: "en",
    })
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("roles", {
        authId: LEGACY_ADMIN.subject,
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("cmsMemberships", {
        authId: LEGACY_ADMIN.subject,
        tokenIdentifier: LEGACY_ADMIN.tokenIdentifier,
        role: "admin",
        status: "active",
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
        transitionId: "m05-p2a",
      })
      // The owner binding moves to a new identity; FORMER is now replaced.
      const owner = (await ctx.db.query("cmsOwner").unique())!
      await ctx.db.patch(owner._id, {
        authId: CURRENT.subject,
        tokenIdentifier: CURRENT.tokenIdentifier,
      })
    })
    vi.stubEnv("REVALIDATE_SECRET", "p2a-secret")
    vi.stubEnv("SITE_URL", "https://site.example.com")

    type Caller = Pick<ReturnType<T["withIdentity"]>, "query" | "mutation">
    const calls = async (caller: Caller) => {
      const settings = await t.run((ctx) =>
        ctx.db.query("siteSettings").unique()
      )
      const authority = await t.run((ctx) =>
        ctx.db.query("siteLanguageAuthority").unique()
      )
      return {
        getMultilingualState: () =>
          caller.query(api.cms.multilingual.getMultilingualState, {}),
        previewAdoption: () =>
          caller.query(api.cms.multilingual.previewAdoption, {}),
        modulesPreview: () =>
          caller.query(api.cms.modules.preview, {
            changes: [{ moduleId: "multilingual", enabled: true }],
          }),
        toggle: async () =>
          caller.mutation(api.cms.modules.commit, {
            expectedConfigurationVersion: await moduleConfigurationVersion(t),
            changes: [{ moduleId: "multilingual", enabled: true }],
          }),
        adopt: async () =>
          caller.mutation(api.cms.multilingual.adoptMultilingualAuthority, {
            expectedSettingsUpdatedAt: settings!.updatedAt,
            expectedModuleConfigurationVersion:
              await moduleConfigurationVersion(t),
            expectedAuthorityVersion: authority!.version,
          }),
        returnToSingle: async () =>
          caller.mutation(api.cms.multilingual.returnToSingleLanguage, {
            expectedAuthorityVersion: (await t.run((ctx) =>
              ctx.db.query("siteLanguageAuthority").unique()
            ))!.version,
          }),
        status: () =>
          caller.query(
            api.cms.languageLifecycle.getLanguageLifecycleStatus,
            {}
          ),
        requeue: () =>
          caller.mutation(
            api.cms.languageLifecycle.requeueUndeliveredLifecycleIntents,
            {}
          ),
      }
    }

    const denied = [
      t,
      t.withIdentity({
        subject: "m05-p2a-stranger",
        tokenIdentifier: "https://convex.test|m05-p2a-stranger",
      }),
      t.withIdentity(LEGACY_ADMIN),
      former,
    ]
    for (const caller of denied) {
      for (const [name, call] of Object.entries(await calls(caller))) {
        const before = await everyRow(t)
        const result = await outcome(call)
        expect({ name, denied: "error" in result }).toEqual({
          name,
          denied: true,
        })
        expect(await everyRow(t)).toEqual(before)
      }
    }

    const current = t.withIdentity(CURRENT)
    const ownerCalls = await calls(current)
    expect(await ownerCalls.getMultilingualState()).toMatchObject({
      lifecycleState: "S1",
    })
    expect(await ownerCalls.modulesPreview()).toMatchObject({ blockers: [] })
    await ownerCalls.toggle()
    expect(await ownerCalls.previewAdoption()).toMatchObject({ canAdopt: true })
    expect(await (await calls(current)).adopt()).toMatchObject({ version: 2 })
    expect(await ownerCalls.status()).toMatchObject({ updating: true })
    expect(await ownerCalls.requeue()).toEqual({
      requeued: 0,
      moreRemain: false,
    })
    expect(await ownerCalls.returnToSingle()).toMatchObject({ version: 3 })
    vi.unstubAllEnvs()
  })
})

describe("M05 P9 admin independence", () => {
  test.each([true, false])(
    "the admin language preference (set: %s) is untouched by every foundation command",
    async (setPreference) => {
      const site = await buildSite("S1", "absent")
      if (setPreference) {
        await site.owner.mutation(api.cms.userPreferences.setAdminLocale, {
          locale: "fr",
        })
      }
      const preferences = () =>
        site.t.run((ctx) => ctx.db.query("userPreferences").collect())
      const before = await preferences()
      expect(before).toHaveLength(setPreference ? 1 : 0)

      await toggleMultilingual(site, true)
      await adopt(site)
      await site.owner.query(api.cms.multilingual.getMultilingualState, {})
      await site.owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
        expectedAuthorityVersion: 2,
      })
      await toggleMultilingual(site, false)
      expect(await preferences()).toEqual(before)
    }
  )
})

describe("M05 P11a bounded foundation commits", () => {
  async function measuredSite(pageCount: number, locales: readonly string[]) {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(
      api.cms.publication.initializeEmptySnapshotAuthority,
      {}
    )
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", {
        siteName: "P11a",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: [...locales],
        updatedAt: FIXED_NOW,
      })
      for (let index = 0; index < pageCount; index += 1) {
        await ctx.db.insert("pages", {
          slug: `page-${index}`,
          pageType: "landing-page",
          status: "draft",
          createdAt: index,
          updatedAt: index,
          createdBy: OWNER.tokenIdentifier,
          content: {},
        })
      }
    })
    await enableMultilingualModule(t)
    return t
  }

  async function metricsOf(t: T, run: (ctx: MutationCtx) => Promise<unknown>) {
    return t.run(async (ctx) => {
      await run(ctx)
      const metrics = await ctx.meta.getTransactionMetrics()
      return {
        documentsRead: metrics.documentsRead.used,
        databaseQueries: metrics.databaseQueries.used,
        documentsWritten: metrics.documentsWritten.used,
        functionsScheduled: metrics.functionsScheduled.used,
      }
    })
  }

  test("adoption and return cost the same on a 1,000-page, 15-locale site as on a tiny one", async () => {
    const locales = [...SUPPORTED_LOCALES]
    expect(locales).toHaveLength(15)

    const adoptMetrics = async (pageCount: number) => {
      const t = await measuredSite(pageCount, locales)
      return metricsOf(t, (ctx) =>
        adoptMultilingualAuthorityInTransaction(ctx, {
          expectedSettingsUpdatedAt: FIXED_NOW,
          expectedModuleConfigurationVersion: 1,
          expectedAuthorityVersion: null,
        })
      )
    }
    const small = await adoptMetrics(2)
    const large = await adoptMetrics(1_000)
    expect(large).toEqual(small)
    expect(large.documentsWritten).toBe(2)
    expect(large.functionsScheduled).toBe(0)
    expect(large.databaseQueries).toBeLessThanOrEqual(10)
    expect(large.documentsRead).toBeLessThanOrEqual(10)

    const returnMetrics = async (pageCount: number) => {
      const t = await measuredSite(pageCount, ["en"])
      await t.run((ctx) =>
        adoptMultilingualAuthorityInTransaction(ctx, {
          expectedSettingsUpdatedAt: FIXED_NOW,
          expectedModuleConfigurationVersion: 1,
          expectedAuthorityVersion: null,
        })
      )
      return metricsOf(t, (ctx) => returnToSingleLanguageInTransaction(ctx, 1))
    }
    const smallReturn = await returnMetrics(2)
    const largeReturn = await returnMetrics(1_000)
    expect(largeReturn).toEqual(smallReturn)
    expect(largeReturn.documentsWritten).toBe(2)
    expect(largeReturn.functionsScheduled).toBe(0)
    expect(largeReturn.databaseQueries).toBeLessThanOrEqual(10)
  }, 120_000)
})

// ─── P23 staged index ──────────────────────────────────────────────────────
//
// Contract "Staged index rollout" (N13). C2a staged
// `pageLocalePublicationReleases.by_locale_and_status`; C2b's first deploy
// removed the flag before any reader landed. The guard still fails if the
// index is deleted, or re-staged while a production reader queries it.

describe("M05 P23 staged index", () => {
  const INDEX = "by_locale_and_status"
  const SOURCE_ENTRIES = [
    "convex",
    "lib",
    "app",
    "components",
    "hooks",
    "proxy.ts",
  ]

  test("the index is declared and no reader queries it while it is staged", () => {
    // `export()` is the framework's internal push payload; it is untyped.
    const exported = (schema as unknown as { export(): string }).export()
    const table = (
      JSON.parse(exported) as {
        tables: {
          tableName: string
          indexes: { indexDescriptor: string; fields: string[] }[]
          stagedDbIndexes: { indexDescriptor: string; fields: string[] }[]
        }[]
      }
    ).tables.find((t) => t.tableName === "pageLocalePublicationReleases")
    const staged = table?.stagedDbIndexes.find(
      (i) => i.indexDescriptor === INDEX
    )
    const live = table?.indexes.find((i) => i.indexDescriptor === INDEX)
    expect((staged ?? live)?.fields).toEqual(["locale", "status"])
    // C2b unstaged it: it must be live, not merely declared.
    expect(staged).toBeUndefined()
    expect(live?.fields).toEqual(["locale", "status"])

    // C2b.2b landed the first reader. Pinning the set keeps the scan honest:
    // a scanner that finds nothing, or an unlisted reader, fails here.
    const readers = scanIndexReaders({
      root: REPO_ROOT,
      entries: SOURCE_ENTRIES,
      indexName: INDEX,
    })
    expect(readers).toEqual([
      "convex/lib/language/defaultMigration.ts#activateDefaultMigrationInTransaction",
      "convex/lib/language/multilingual.ts#removeLanguageInTransaction",
    ])
  }, 60_000)

  test("the reader scan finds existing index readers", () => {
    expect(
      scanIndexReaders({
        root: REPO_ROOT,
        entries: SOURCE_ENTRIES,
        indexName: "by_pageId_and_locale_and_status",
      })
    ).not.toEqual([])
  }, 60_000)
})

// ─── P10a freshness closure and source ownership ───────────────────────────
//
// Contract "Freshness domains" and "Gate call sites" (C2b.1). The static half
// proves every writer of a traversed table either records through
// `recordPublicChange` or is a named exemption; the behavioural half proves
// each writer advances exactly its tabled scopes under a multilingual
// authority and nothing under CUR or V0.

const FRESHNESS_SOURCE_TABLES = [
  "pageLocalePublicationStates",
  "pageLocalePublicationReleases",
  "pageHistoricalLocaleRoutes",
  "redirects",
  "menus",
  "cmsModuleState",
] as const

const RETIREMENT_HOOKED = "retires through retireContinuityRowForClaim"
const PREPARED_TARGET_EXCLUSION =
  "F09 preparing target is never currentLocale; C3e owns post-activation collisions"
const SNAPSHOT_MIGRATION_EXCLUSION =
  "publication cutover is preparing, before snapshot authority can hold a pointer"
const CLEARING_WRITE = "clears a current route; creates no claim"

/** M05 P10b: every current or historical route-claim writer. */
const CLAIM_WRITER_INVENTORY: Record<string, string> = {
  "convex/cms/publication.ts#prepareSnapshotMigrationPage#insert#pageHistoricalLocaleRoutes":
    SNAPSHOT_MIGRATION_EXCLUSION,
  "convex/cms/publication.ts#prepareSnapshotMigrationPage#patch#pageLocalePublicationStates#currentPath":
    SNAPSHOT_MIGRATION_EXCLUSION,
  "convex/cms/publication.ts#publishLocale#insert#pageHistoricalLocaleRoutes":
    RETIREMENT_HOOKED,
  "convex/cms/publication.ts#publishLocale#patch#pageLocalePublicationStates#currentPath":
    RETIREMENT_HOOKED,
  "convex/cms/publication.ts#publishPreparedTargetLocale#insert#pageHistoricalLocaleRoutes":
    PREPARED_TARGET_EXCLUSION,
  "convex/cms/publication.ts#publishPreparedTargetLocale#patch#pageLocalePublicationStates#currentPath":
    PREPARED_TARGET_EXCLUSION,
  "convex/cms/publication.ts#transitionLifecycle#patch#pageLocalePublicationStates#currentPath":
    CLEARING_WRITE,
  "convex/cms/publication.ts#withdrawLocale#patch#pageLocalePublicationStates#currentPath":
    CLEARING_WRITE,
  "convex/cms/publication.ts#withdrawPreparedTargetLocale#patch#pageLocalePublicationStates#currentPath":
    CLEARING_WRITE,
}

describe("M05 P10b durable retirement source ownership", () => {
  test("every claim writer is hooked or excluded with its approved reason", () => {
    const historicalInserts = scanTableWriters({
      root: REPO_ROOT,
      entries: ["convex"],
      tables: ["pageHistoricalLocaleRoutes"],
    }).filter((writer) => writer.includes("#insert#"))
    const currentPathWrites = scanTableFieldWriters({
      root: REPO_ROOT,
      entries: ["convex"],
      table: "pageLocalePublicationStates",
      field: "currentPath",
    })
    expect([...historicalInserts, ...currentPathWrites].sort()).toEqual(
      Object.keys(CLAIM_WRITER_INVENTORY).sort()
    )

    const hooks = new Set(
      scanSourceUses({
        root: REPO_ROOT,
        entries: ["convex"],
        callees: ["retireContinuityRowForClaim"],
        kindLiterals: [],
      })
    )
    expect([...hooks]).toEqual([
      "convex/cms/publication.ts#publishLocale#retireContinuityRowForClaim",
      "convex/cms/publication.ts#transitionLifecycle#retireContinuityRowForClaim",
    ])
    for (const [writer, disposition] of Object.entries(
      CLAIM_WRITER_INVENTORY
    )) {
      if (disposition !== RETIREMENT_HOOKED) continue
      const [file, fn] = writer.split("#")
      expect(hooks).toContain(`${file}#${fn}#retireContinuityRowForClaim`)
    }
  })
})

const RECORDS = "records"
const F09_ONLY = "F09 transition writer; unreachable under multilingual (M6)"
const MIGRATION_EPOCH = "migration epoch (S9)"
const F09_REMEDY =
  "F09 retained-draft remedy; requires the current state, so unreachable under multilingual"

/** Every writer of a freshness source table, keyed `file#function#op#table`. */
const FRESHNESS_WRITER_INVENTORY: Record<string, string> = {
  "convex/cms/language.ts#copyMenuTextToTarget#patch#menus": F09_ONLY,
  "convex/cms/menus.ts#insertCanonicalMenu#insert#menus":
    "shared insert for createCanonical and saveCanonical; callers record once after insert",
  "convex/cms/menus.ts#remove#delete#menus": RECORDS,
  "convex/cms/menus.ts#restore#patch#menus": RECORDS,
  "convex/cms/menus.ts#saveCanonical#patch#menus": RECORDS,
  "convex/cms/menus.ts#softDelete#patch#menus": RECORDS,
  "convex/cms/modules.ts#commitModuleTransitionInTransaction#insert#cmsModuleState":
    RECORDS,
  "convex/cms/modules.ts#commitModuleTransitionInTransaction#patch#cmsModuleState":
    RECORDS,
  "convex/cms/pages.ts#remove#delete#redirects":
    "legacy publication epoch only; refuses under snapshot authority",
  "convex/cms/publication.ts#abortSnapshotMigrationPage#delete#pageHistoricalLocaleRoutes":
    MIGRATION_EPOCH,
  "convex/cms/publication.ts#abortSnapshotMigrationPage#delete#pageLocalePublicationReleases":
    MIGRATION_EPOCH,
  "convex/cms/publication.ts#abortSnapshotMigrationPage#delete#pageLocalePublicationStates":
    MIGRATION_EPOCH,
  "convex/cms/publication.ts#createTransitionTargetDraft#insert#pageLocalePublicationStates":
    F09_ONLY,
  "convex/cms/publication.ts#createTransitionTargetDraft#patch#pageLocalePublicationStates":
    F09_ONLY,
  "convex/cms/publication.ts#deleteCancelledRetainedTargetDraft#patch#pageLocalePublicationStates":
    F09_REMEDY,
  "convex/cms/publication.ts#deleteLocaleContent#patch#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#deleteTransitionTargetDraft#patch#pageLocalePublicationStates":
    F09_ONLY,
  "convex/cms/publication.ts#discardLocaleDraft#patch#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#initializeSuccessorPage#insert#pageLocalePublicationStates":
    "a new Page's first state rows carry no selection or route",
  "convex/cms/publication.ts#prepareSnapshotMigrationPage#insert#pageHistoricalLocaleRoutes":
    MIGRATION_EPOCH,
  "convex/cms/publication.ts#prepareSnapshotMigrationPage#insert#pageLocalePublicationReleases":
    MIGRATION_EPOCH,
  "convex/cms/publication.ts#prepareSnapshotMigrationPage#patch#pageLocalePublicationReleases":
    MIGRATION_EPOCH,
  "convex/cms/publication.ts#prepareSnapshotMigrationPage#patch#pageLocalePublicationStates":
    MIGRATION_EPOCH,
  "convex/cms/publication.ts#publishLocale#insert#pageHistoricalLocaleRoutes":
    RECORDS,
  "convex/cms/publication.ts#publishLocale#insert#pageLocalePublicationReleases":
    RECORDS,
  "convex/cms/publication.ts#publishLocale#patch#pageLocalePublicationReleases":
    RECORDS,
  "convex/cms/publication.ts#publishLocale#patch#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#publishPreparedTargetLocale#insert#pageHistoricalLocaleRoutes":
    F09_ONLY,
  "convex/cms/publication.ts#publishPreparedTargetLocale#insert#pageLocalePublicationReleases":
    F09_ONLY,
  "convex/cms/publication.ts#publishPreparedTargetLocale#insert#pageLocalePublicationStates":
    F09_ONLY,
  "convex/cms/publication.ts#publishPreparedTargetLocale#patch#pageLocalePublicationReleases":
    F09_ONLY,
  "convex/cms/publication.ts#publishPreparedTargetLocale#patch#pageLocalePublicationStates":
    F09_ONLY,
  "convex/cms/publication.ts#saveEditorDraft#insert#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#restoreSnapshotAsDraft#patch#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#saveEditorDraft#patch#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#saveLocaleDraft#insert#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#saveLocaleDraft#patch#pageLocalePublicationStates":
    RECORDS,
  // Released history and cleared selections record route_claims/publication_set;
  // restored uncontested arrivals retire continuity through the recording seam.
  "convex/cms/publication.ts#transitionLifecycle#patch#pageHistoricalLocaleRoutes":
    RECORDS,
  "convex/cms/publication.ts#transitionLifecycle#patch#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#transitionLifecycle#patch#pageLocalePublicationReleases":
    RECORDS,
  "convex/cms/publication.ts#withdrawLocale#patch#pageLocalePublicationStates":
    RECORDS,
  "convex/cms/publication.ts#withdrawPreparedTargetLocale#patch#pageLocalePublicationStates":
    F09_ONLY,
  "convex/cms/redirects.ts#create#insert#redirects": RECORDS,
  "convex/cms/redirects.ts#remove#delete#redirects": RECORDS,
  "convex/cms/publication.ts#backfillCurrentSnapshotIndexRow#patch#pageLocalePublicationStates":
    "derived listing keys only; no snapshot selection, content, route or address-freshness input changes",
  ...SOURCE_ONLY.freshnessWriterInventory,
}

/**
 * The recording call sites: the contract's gate call-site table plus the two
 * redirect writers C2 adds. `recordSourcePublicChange` has one production
 * caller, the seam itself.
 */
const RECORDING_CALL_SITES = [
  "convex/cms/aiSettings.ts#setAssistant#recordPublicChange",
  "convex/cms/aiSettings.ts#setProductionAiConfiguration#recordPublicChange",
  "convex/cms/aiSettings.ts#setSliceCreator#recordPublicChange",
  "convex/cms/sliceLibrary.ts#cleanupDeletedSliceTypeArchive#recordPublicChange",
  "convex/cms/sliceLibrary.ts#setSliceArchived#recordPublicChange",
  "convex/cms/contentTypes.ts#setContentTypeArchived#recordPublicChange",
  "convex/cms/menus.ts#createCanonical#recordPublicChange",
  "convex/cms/menus.ts#remove#recordPublicChange",
  "convex/cms/menus.ts#restore#recordPublicChange",
  "convex/cms/menus.ts#saveCanonical#recordPublicChange",
  "convex/cms/menus.ts#softDelete#recordPublicChange",
  "convex/cms/modules.ts#commitModuleTransitionInTransaction#recordPublicChange",
  "convex/cms/publication.ts#deleteLocaleContent#recordPublicChange",
  "convex/cms/publication.ts#discardLocaleDraft#recordPublicChange",
  "convex/cms/publication.ts#publishLocale#recordPublicChange",
  "convex/cms/publication.ts#restoreSnapshotAsDraft#recordPublicChange",
  "convex/cms/publication.ts#saveEditorDraft#recordPublicChange",
  "convex/cms/publication.ts#saveLocaleDraft#recordPublicChange",
  "convex/cms/publication.ts#transitionLifecycle#recordPublicChange",
  "convex/cms/publication.ts#withdrawLocale#recordPublicChange",
  "convex/cms/redirects.ts#create#recordPublicChange",
  "convex/cms/redirects.ts#remove#recordPublicChange",
  "convex/cms/settings.ts#setBrandingImage#recordPublicChange",
  "convex/cms/settings.ts#updateSettings#recordPublicChange",
  "convex/lib/language/freshness.ts#recordPublicChange#recordSourcePublicChange",
  ...(SOURCE_ONLY.recordingCallSites ?? []),
]

type FreshnessCounts = { A: number; B: number }
type FreshnessSnapshot = Record<string, FreshnessCounts>

/** Counters by scope; fails on a duplicated scope row (fail-closed reader). */
async function freshnessRows(t: T): Promise<FreshnessSnapshot> {
  return t.run(async (ctx) => {
    const rows: FreshnessSnapshot = {}
    for (const row of await ctx.db.query("siteLanguageFreshness").take(64)) {
      const scope = row.scope === "site" ? "site" : row.locale!
      if (rows[scope]) throw new Error(`duplicate freshness row: ${scope}`)
      rows[scope] = {
        A: row.routeClaimVersion,
        B: row.publicationSetVersion,
      }
    }
    return rows
  })
}

/** Exact counter deltas `run` produced, per scope that moved. */
async function advanced(t: T, run: () => Promise<unknown>) {
  const before = await freshnessRows(t)
  await run()
  await drain(t)
  const after = await freshnessRows(t)
  const moved: Record<string, FreshnessCounts> = {}
  for (const scope of new Set([
    ...Object.keys(before),
    ...Object.keys(after),
  ])) {
    const prior = before[scope] ?? { A: 0, B: 0 }
    const next = after[scope] ?? { A: 0, B: 0 }
    const delta = { A: next.A - prior.A, B: next.B - prior.B }
    if (delta.A !== 0 || delta.B !== 0) moved[scope] = delta
  }
  return moved
}

async function enableRedirects(t: T) {
  await t.run(async (ctx) => {
    const row = (await ctx.db
      .query("cmsModuleState")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique())!
    await ctx.db.patch(row._id, {
      enabledModules: [
        ...row.enabledModules,
        { moduleId: "redirects", configVersion: 1 },
      ],
    })
  })
}

async function localeState(t: T, pageId: Id<"pages">, locale: string) {
  return (await generations(t, pageId, locale)).state!
}

/**
 * Runs every tabled writer once on `site` and returns what each advanced.
 * The same script runs under ML, CUR and V0S.
 */
async function freshnessScript(site: Site) {
  const { t, owner, aboutId } = site
  const results: Record<string, Record<string, FreshnessCounts>> = {}
  const record = async (name: string, run: () => Promise<unknown>) => {
    results[name] = await advanced(t, run)
  }
  const page = async () => (await generations(t, aboutId, "en")).page!

  await record("settings.updateSettings", () =>
    owner.mutation(api.cms.settings.updateSettings, { siteName: "Renamed" })
  )
  const draft = await generations(t, aboutId, "en")
  await record("publication.saveLocaleDraft", () =>
    owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: aboutId,
      locale: "en",
      slug: "about",
      draft: {
        pageType: "landing-page",
        localized: { title: "About, again" },
        slices: [],
      } as never,
      expectedDraftGeneration: draft.state!.draftGeneration,
      expectedLifecycleGeneration: draft.page!.lifecycleGeneration,
    })
  )
  const publish = await publishArgs(t, aboutId, "en")
  await record("publication.publishLocale", () =>
    owner.mutation(api.cms.publication.publishLocale, publish)
  )
  const restored = await localeState(t, aboutId, "en")
  const restore = await publishArgs(t, aboutId, "en")
  await record("publication.restoreSnapshotAsDraft", () =>
    owner.mutation(api.cms.publication.restoreSnapshotAsDraft, {
      ...restore,
      snapshotId: restored.currentSnapshotId!,
    })
  )
  await record("publication.archivePage", async () =>
    owner.mutation(api.cms.publication.archivePage, {
      pageId: aboutId,
      expectedLifecycleGeneration: (await page()).lifecycleGeneration,
    })
  )
  await record("publication.restorePage", async () =>
    owner.mutation(api.cms.publication.restorePage, {
      pageId: aboutId,
      expectedLifecycleGeneration: (await page()).lifecycleGeneration,
    })
  )
  const selected = await localeState(t, aboutId, "en")
  await record("publication.withdrawLocale", async () =>
    owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: aboutId,
      locale: "en",
      expectedSnapshotId: selected.currentSnapshotId!,
      expectedPublicGeneration: selected.publicGeneration,
      expectedLifecycleGeneration: (await page()).lifecycleGeneration,
    })
  )
  // A withdrawn locale with a pending release: trashing cancels it, which is a
  // publication-set change for that locale only.
  await t.run(async (ctx) => {
    const state = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", aboutId).eq("locale", "en")
      )
      .unique())!
    const release = (await ctx.db
      .query("pageLocalePublicationReleases")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", aboutId).eq("locale", "en")
      )
      .first())!
    const { _id, _creationTime, publishedSnapshotId, publishedAt, ...rest } =
      release
    void _id
    void _creationTime
    void publishedSnapshotId
    void publishedAt
    void state
    await ctx.db.insert("pageLocalePublicationReleases", {
      ...rest,
      status: "pending",
    })
  })
  await record("publication.softDeletePage", async () =>
    owner.mutation(api.cms.publication.softDeletePage, {
      pageId: aboutId,
      expectedLifecycleGeneration: (await page()).lifecycleGeneration,
    })
  )

  await record("menus.saveCanonical default", () =>
    owner.mutation(api.cms.menus.saveCanonical, {
      slug: MENU_SLUG,
      locale: "en",
      nav: [
        {
          id: "external",
          label: { en: "Docs" },
          target: { type: "external" as const, url: "https://example.com" },
        },
      ],
    })
  )
  if (site.locales.includes("fr")) {
    await record("menus.saveCanonical locale text", () =>
      owner.mutation(api.cms.menus.saveCanonical, {
        slug: MENU_SLUG,
        locale: "fr",
        nav: [
          {
            id: "external",
            label: { en: "Docs", fr: "Documentation" },
            target: { type: "external" as const, url: "https://example.com" },
          },
        ],
      })
    )
  }
  const menuId = await t.run(
    async (ctx) =>
      (await ctx.db
        .query("menus")
        .withIndex("by_slug", (q) => q.eq("slug", MENU_SLUG))
        .unique())!._id
  )
  await record("menus.softDelete", () =>
    owner.mutation(api.cms.menus.softDelete, { id: menuId })
  )
  await record("menus.restore", () =>
    owner.mutation(api.cms.menus.restore, { id: menuId })
  )
  await record("menus.createCanonical", () =>
    owner.mutation(api.cms.menus.createCanonical, { slug: "p10a-second" })
  )

  await record("modules.commit redirects on", async () =>
    owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: await moduleConfigurationVersion(t),
      changes: [{ moduleId: "redirects", enabled: true }],
    })
  )
  let scopedRule: Id<"redirects"> | null = null
  await record("redirects.create scoped", async () => {
    scopedRule = await owner.mutation(api.cms.redirects.create, {
      fromPath: "/p10a-scoped",
      toPath: "/about",
      locale: "en",
      statusCode: 301,
    })
  })
  let siteRule: Id<"redirects"> | null = null
  await record("redirects.create unscoped", async () => {
    siteRule = await owner.mutation(api.cms.redirects.create, {
      fromPath: "/p10a-site",
      toPath: "/about",
      statusCode: 302,
    })
  })
  await record("redirects.remove scoped", () =>
    owner.mutation(api.cms.redirects.remove, { id: scopedRule! })
  )
  await record("redirects.remove unscoped", () =>
    owner.mutation(api.cms.redirects.remove, { id: siteRule! })
  )
  return results
}

describe("M05 P10a freshness closure and source ownership", () => {
  test("every writer of a traversed table records or is a named exemption", () => {
    const writers = scanTableWriters({
      root: REPO_ROOT,
      entries: ["convex"],
      tables: FRESHNESS_SOURCE_TABLES,
    })
    expect(writers).toEqual(Object.keys(FRESHNESS_WRITER_INVENTORY).sort())

    const calls = scanSourceUses({
      root: REPO_ROOT,
      entries: ["convex", "lib", "app", "components", "hooks", "proxy.ts"],
      callees: ["recordPublicChange", "recordSourcePublicChange"],
      kindLiterals: [],
    })
    expect([...new Set(calls)].sort()).toEqual([...RECORDING_CALL_SITES].sort())
    for (const [writer, disposition] of Object.entries(
      FRESHNESS_WRITER_INVENTORY
    )) {
      if (disposition !== RECORDS) continue
      const [file, fn] = writer.split("#")
      expect(calls).toContain(`${file}#${fn}#recordPublicChange`)
    }
  }, 120_000)

  test("under a multilingual authority each writer advances exactly its tabled scopes", async () => {
    const site = await inventorySite("ML")
    await enableRedirects(site.t)
    // Redirects starts enabled here, so turn it off first to toggle it on.
    await site.owner.mutation(api.cms.modules.commit, {
      expectedConfigurationVersion: await moduleConfigurationVersion(site.t),
      changes: [{ moduleId: "redirects", enabled: false }],
    })
    await drain(site.t)
    expect(await freshnessScript(site)).toEqual({
      "settings.updateSettings": {},
      "publication.saveLocaleDraft": {},
      "publication.publishLocale": { en: { A: 1, B: 1 } },
      "publication.restoreSnapshotAsDraft": {},
      "publication.archivePage": { en: { A: 1, B: 1 } },
      "publication.restorePage": { en: { A: 1, B: 1 } },
      "publication.withdrawLocale": { en: { A: 1, B: 1 } },
      "publication.softDeletePage": { en: { A: 0, B: 1 } },
      "menus.saveCanonical default": { site: { A: 0, B: 1 } },
      "menus.saveCanonical locale text": { fr: { A: 0, B: 1 } },
      "menus.softDelete": { site: { A: 0, B: 1 } },
      "menus.restore": { site: { A: 0, B: 1 } },
      "menus.createCanonical": { site: { A: 0, B: 1 } },
      "modules.commit redirects on": { site: { A: 1, B: 1 } },
      "redirects.create scoped": { en: { A: 1, B: 0 } },
      "redirects.create unscoped": { site: { A: 1, B: 0 } },
      "redirects.remove scoped": { en: { A: 1, B: 0 } },
      "redirects.remove unscoped": { site: { A: 1, B: 0 } },
    })
    // One lazily created row per scope that ever moved; no duplicate site row.
    expect(
      await site.t.run(async (ctx) =>
        (await ctx.db.query("siteLanguageFreshness").take(64))
          .map((row) => row.scope + ":" + (row.locale ?? ""))
          .sort()
      )
    ).toEqual(["locale:en", "locale:fr", "site:"])
  }, 120_000)

  test.each(["CUR", "V0S"] as const)(
    "under %s no writer creates or advances a freshness row",
    async (state) => {
      const site = await inventorySite(state)
      const results = await freshnessScript(site)
      for (const moved of Object.values(results)) expect(moved).toEqual({})
      expect(await freshnessRows(site.t)).toEqual({})
    },
    120_000
  )
})

// ─── M05 C2b.1d: sealed impact previews (P17 mechanics) ─────────────────────

type PreviewId = Id<"siteLanguageImpactPreviews">
type PreviewSite = Site & { frPageId: Id<"pages"> }

const KIB = 1024
/**
 * S4 with `en` and `fr`, Redirects effective, and one Page published in `fr`.
 * Volume rows are inserted directly before a preview starts, so they move no
 * captured counter.
 */
async function previewSite(): Promise<PreviewSite> {
  const site = await inventorySite("ML")
  await enableRedirects(site.t)
  const frPageId = await createPage(site.owner, "bonjour", ["en", "fr"])
  await site.owner.mutation(
    api.cms.publication.publishLocale,
    await publishArgs(site.t, frPageId, "fr")
  )
  await drain(site.t)
  return { ...site, frPageId }
}

/**
 * Clones the published `fr` selection onto a cloned Page per path (`null`:
 * non-routable), so every Page and locale keeps one state row.
 */
async function seedSelections(
  site: PreviewSite,
  paths: readonly (string | null)[]
): Promise<Id<"pages">[]> {
  return site.t.run(async (ctx) => {
    const template = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", site.frPageId).eq("locale", "fr")
      )
      .unique())!
    const { _id, _creationTime, currentPath, pageId, ...row } = template
    void _id
    void _creationTime
    void currentPath
    const {
      _id: pageDocId,
      _creationTime: pageCreationTime,
      ...page
    } = (await ctx.db.get(pageId))!
    void pageDocId
    void pageCreationTime
    const pageIds: Id<"pages">[] = []
    for (const [index, path] of paths.entries()) {
      const clone = await ctx.db.insert("pages", {
        ...page,
        slug: `clone-${index}`,
      } as never)
      await ctx.db.insert("pagePublicationPageStates", {
        pageId: clone,
        modelVersion: 1,
        lifecycleState: "active",
        lifecycleGeneration: 1,
        createdAt: FIXED_NOW,
        updatedAt: FIXED_NOW,
      })
      pageIds.push(clone)
      await ctx.db.insert("pageLocalePublicationStates", {
        ...row,
        pageId: clone,
        ...(path === null ? {} : { currentPath: path }),
      })
    }
    return pageIds
  })
}

async function seedHistoricalRoutes(
  site: PreviewSite,
  fromPaths: readonly string[]
) {
  await site.t.run(async (ctx) => {
    const state = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", site.frPageId).eq("locale", "fr")
      )
      .unique())!
    for (const fromPath of fromPaths) {
      await ctx.db.insert("pageHistoricalLocaleRoutes", {
        pageId: site.frPageId,
        locale: "fr",
        fromPath,
        createdFromSnapshotId: state.currentSnapshotId!,
        createdAt: FIXED_NOW,
      })
    }
  })
}

async function seedRedirects(
  site: PreviewSite,
  rules: readonly { fromPath: string; toPath?: string; locale?: string }[]
): Promise<Id<"redirects">[]> {
  return site.t.run(async (ctx) => {
    const ids: Id<"redirects">[] = []
    for (const rule of rules) {
      ids.push(
        await ctx.db.insert("redirects", {
          fromPath: rule.fromPath,
          ...(rule.toPath === undefined
            ? { toPageId: site.frPageId }
            : { toPath: rule.toPath }),
          ...(rule.locale === undefined ? {} : { locale: rule.locale }),
          statusCode: 301,
          createdAt: FIXED_NOW,
          updatedAt: FIXED_NOW,
          origin: "manual",
        })
      )
    }
    return ids
  })
}

/** A menu whose items each carry one link group of `links` links. */
function menuNav(
  items: number,
  links: number,
  locales: readonly string[],
  idPad = ""
): NavItem[] {
  const text = (value: string) =>
    Object.fromEntries(locales.map((locale) => [locale, value]))
  return Array.from({ length: items }, (_, item) => ({
    id: `item-${item}${idPad}`,
    label: text(`Item ${item}`),
    panel: {
      columns: 1 as const,
      blocks: [
        {
          id: `group-${item}${idPad}`,
          kind: "linkGroup" as const,
          heading: text(`Group ${item}`),
          links: Array.from({ length: links }, (_, link) => ({
            id: `link-${item}-${link}${idPad}`,
            label: text(`Link ${item}.${link}`),
            target: { type: "anchor" as const, anchor: "#top" },
          })),
        },
      ],
    },
  }))
}

async function seedMenu(
  site: PreviewSite,
  slug: string,
  nav: NavItem[],
  deleted = false
): Promise<Id<"menus">> {
  return site.t.run((ctx) =>
    ctx.db.insert("menus", {
      slug,
      nav,
      updatedAt: FIXED_NOW,
      ...(deleted ? { deletedAt: FIXED_NOW } : {}),
    })
  )
}

async function startPreview(
  site: Pick<Site, "owner">,
  kind: "remove" | "reveal" = "remove",
  locale = "fr"
): Promise<PreviewId> {
  return (
    await site.owner.mutation(api.cms.multilingual.startLanguageImpactPreview, {
      kind,
      locale,
    })
  ).previewId
}

async function previewRow(t: T, previewId: PreviewId) {
  return (await t.run((ctx) => ctx.db.get(previewId)))!
}

async function previewPages(t: T, previewId: PreviewId) {
  return t.run((ctx) =>
    ctx.db
      .query("siteLanguageDisclosurePages")
      .withIndex("by_previewId_and_ordinal", (q) =>
        q.eq("previewId", previewId)
      )
      .take(200)
  )
}

async function stepPreview(t: T, previewId: PreviewId, generation = 1) {
  await t.mutation(internal.cms.multilingual.stepLanguageImpactPreview, {
    previewId,
    generation,
  })
}

/**
 * Drives steps directly (scheduled continuations never fire under fake
 * timers) and records the paginated queries each step issued.
 */
async function runPreview(t: T, previewId: PreviewId) {
  const paginate = vi.spyOn(impactPreviewSeam, "paginate")
  const perStep: number[] = []
  try {
    for (let guard = 0; guard < 200; guard += 1) {
      if ((await previewRow(t, previewId)).phase !== "scanning") break
      const before = paginate.mock.calls.length
      await stepPreview(t, previewId)
      perStep.push(paginate.mock.calls.length - before)
    }
  } finally {
    paginate.mockRestore()
  }
  return { preview: await previewRow(t, previewId), perStep }
}

async function recomputedDigest(
  pages: readonly {
    generation: number
    ordinal: number
    section: DisclosureSection
    items: DisclosureItem[]
  }[],
  subjectId: string
) {
  let digest = DISCLOSURE_CHAIN_EMPTY_DIGEST
  for (const page of pages) {
    digest = await digestDisclosurePage({
      previousDigest: digest,
      subjectId,
      generation: page.generation,
      ordinal: page.ordinal,
      section: page.section,
      items: page.items,
    })
  }
  return digest
}

function storedPageBytes(page: Record<string, unknown>): number {
  const { _id, _creationTime, ...fields } = page
  void _id
  void _creationTime
  return new TextEncoder().encode(JSON.stringify(fields)).byteLength
}

describe("M05 P17 sealed preview mechanics", () => {
  test("C4 state summary exposes the current review and exact module version", async () => {
    const site = await previewSite()
    const previewId = await startPreview(site)

    expect(
      await site.owner.query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({
      lifecycleState: "S4",
      moduleConfigurationVersion: await moduleConfigurationVersion(site.t),
      latestPreviews: [
        {
          previewId,
          kind: "remove",
          locale: "fr",
          phase: "scanning",
          reviewedThroughOrdinal: -1,
          generation: 1,
        },
      ],
    })
  })

  test("a multi-page traversal of every section repeats and drops nothing", async () => {
    const site = await previewSite()
    const { t } = site
    await seedSelections(
      site,
      Array.from({ length: 19 }, (_, i) => `/fr/extra-${i}`)
    )
    // Many rows inserted by one mutation, most at the same `fromPath`.
    await seedHistoricalRoutes(site, [
      ...Array.from({ length: 30 }, () => "/same"),
      ...Array.from({ length: 5 }, (_, i) => `/old-${i}`),
    ])
    const frRules = await seedRedirects(site, [
      ...Array.from({ length: 11 }, (_, i) => ({
        fromPath: `/rule-${i}`,
        locale: "fr",
      })),
      { fromPath: "/external", toPath: "https://example.com/x", locale: "fr" },
    ])
    await seedRedirects(site, [
      { fromPath: "/en-only", toPath: "/about", locale: "en" },
      { fromPath: "/everywhere", toPath: "/about" },
    ])
    const bigNav = menuNav(3, 14, ["en", "fr"])
    const bigMenu = await seedMenu(site, "big", bigNav)
    await seedMenu(site, "deleted", menuNav(1, 2, ["en", "fr"]), true)
    await seedMenu(site, "english", menuNav(1, 2, ["en"]))

    const previewId = await startPreview(site)
    const { preview, perStep } = await runPreview(t, previewId)

    expect(preview.phase).toBe("complete")
    expect(preview.expiresAt).toBe(preview.completedAt! + 15 * 60 * 1000)
    // One paginated query per step at most; a resumed menu step issues none.
    expect(Math.max(...perStep)).toBe(1)
    expect(perStep).toContain(0)

    const pages = await previewPages(t, previewId)
    expect(pages.map((page) => page.ordinal)).toEqual(pages.map((_, i) => i))
    expect(pages.map((page) => [page.section, page.items.length])).toEqual([
      ["selections", 15],
      ["selections", 5],
      ["historical_routes", 21],
      ["historical_routes", 14],
      ["manual_rules", 9],
      ["manual_rules", 3],
      ["menus", 21],
      ["menus", 21],
      ["menus", 6],
    ])
    for (const page of pages) {
      expect(storedPageBytes(page)).toBeLessThanOrEqual(64 * KIB)
    }
    const items = pages.flatMap((page) => page.items)
    const bySection = (kind: DisclosureItem["kind"]) =>
      items.filter((item) => item.kind === kind)

    const bonjour = await localeState(t, site.frPageId, "fr")
    expect(
      bySection("selection")
        .map((item) => (item as { path: string }).path)
        .sort()
    ).toEqual(
      [
        bonjour.currentPath!,
        ...Array.from({ length: 19 }, (_, i) => `/fr/extra-${i}`),
      ].sort()
    )
    expect(
      new Set(
        bySection("selection").map((item) => (item as { title: string }).title)
      )
    ).toEqual(new Set(["bonjour fr"]))
    const historical = bySection("historical_route").map(
      (item) => (item as { fromPath: string }).fromPath
    )
    expect(historical.filter((path) => path === "/same")).toHaveLength(30)
    expect(historical.sort()).toEqual(
      [
        ...Array.from({ length: 30 }, () => "/same"),
        ...Array.from({ length: 5 }, (_, i) => `/old-${i}`),
      ].sort()
    )
    const rules = bySection("manual_rule") as Extract<
      DisclosureItem,
      { kind: "manual_rule" }
    >[]
    expect(rules.map((rule) => rule.ruleId).sort()).toEqual([...frRules].sort())
    expect(new Set(rules.map((rule) => rule.status))).toEqual(
      new Set(["silenced"])
    )
    expect(
      rules.find((rule) => rule.fromPath === "/external")!.destination
    ).toEqual({ kind: "external", url: "https://example.com/x" })
    expect(
      bySection("menu_node").map((item) => [
        (item as { menuId: string }).menuId,
        (item as { nodePath: string }).nodePath,
      ])
    ).toEqual(
      menuNodePathsWithLocaleText(bigNav, "fr").map((path) => [bigMenu, path])
    )
    expect(preview.count).toEqual({
      publicPages: 20,
      routes: 35,
      manualRules: 12,
      menus: 1,
    })
    expect(preview.pageCount).toBe(pages.length)
    expect(preview.digest).toBe(await recomputedDigest(pages, previewId))
    for (const page of pages) {
      expect(page.digest).toBe(
        await recomputedDigest(pages.slice(0, page.ordinal + 1), previewId)
      )
    }

    // The owner reads every page back in order with its stored digest.
    for (const page of pages) {
      expect(
        await site.owner.query(api.cms.multilingual.listLanguageImpact, {
          previewId,
          ordinal: page.ordinal,
        })
      ).toEqual({
        stale: false,
        ordinal: page.ordinal,
        pageCount: pages.length,
        section: page.section,
        items: page.items,
        digest: page.digest,
      })
    }
    expect(
      await outcome(() =>
        site.owner.query(api.cms.multilingual.listLanguageImpact, {
          previewId,
          ordinal: pages.length,
        })
      )
    ).toEqual(refused("LANGUAGE_PREVIEW_MISMATCH"))
  }, 120_000)

  test("a reveal preview lists manual rules as active and skips them while Redirects is off", async () => {
    const site = await previewSite()
    await seedRedirects(site, [{ fromPath: "/nl-rule", locale: "nl" }])
    await seedHistoricalRoutes(site, [])
    const withRedirects = await runPreview(
      site.t,
      await startPreview(site, "reveal", "nl")
    )
    const rules = (
      await previewPages(site.t, withRedirects.preview._id)
    ).flatMap((page) => page.items)
    expect(rules).toMatchObject([{ kind: "manual_rule", status: "active" }])

    await site.t.run(async (ctx) => {
      const row = (await ctx.db.query("cmsModuleState").unique())!
      await ctx.db.patch(row._id, {
        enabledModules: row.enabledModules.filter(
          (entry) => entry.moduleId !== "redirects"
        ),
      })
    })
    const without = await runPreview(
      site.t,
      await startPreview(site, "reveal", "nl")
    )
    expect(without.preview).toMatchObject({
      phase: "complete",
      pageCount: 0,
      digest: DISCLOSURE_CHAIN_EMPTY_DIGEST,
      count: { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
    })
    // The three original empty sections run before the D1 prefix walk's
    // current, historical and no-pointer continuity steps.
    expect(without.perStep).toHaveLength(6)
  }, 120_000)

  test("a publish in the previewed locale between batches ends the preview stale", async () => {
    const site = await previewSite()
    const { t, owner } = site
    await seedSelections(
      site,
      Array.from({ length: 20 }, (_, i) => `/fr/extra-${i}`)
    )
    const previewId = await startPreview(site)
    await stepPreview(t, previewId)
    expect(await previewRow(t, previewId)).toMatchObject({
      phase: "scanning",
      pageCount: 1,
    })

    // Another locale's change is not a captured scope (Delayed work).
    const about = await publishArgs(t, site.aboutId, "en")
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: site.aboutId,
      locale: "en",
      slug: "about",
      draft: {
        pageType: "landing-page",
        localized: { title: "About, again" },
        slices: [],
      } as never,
      expectedDraftGeneration: about.expectedDraftGeneration,
      expectedLifecycleGeneration: about.expectedLifecycleGeneration,
    })
    await owner.mutation(
      api.cms.publication.publishLocale,
      await publishArgs(t, site.aboutId, "en")
    )
    await stepPreview(t, previewId)
    expect(await previewRow(t, previewId)).toMatchObject({
      phase: "scanning",
      pageCount: 2,
    })

    const bonjour = await publishArgs(t, site.frPageId, "fr")
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: site.frPageId,
      locale: "fr",
      slug: "bonjour",
      draft: {
        pageType: "landing-page",
        localized: { title: "Bonjour, encore" },
        slices: [],
      } as never,
      expectedDraftGeneration: bonjour.expectedDraftGeneration,
      expectedLifecycleGeneration: bonjour.expectedLifecycleGeneration,
    })
    await owner.mutation(
      api.cms.publication.publishLocale,
      await publishArgs(t, site.frPageId, "fr")
    )
    const before = await previewRow(t, previewId)
    await stepPreview(t, previewId)
    const after = await previewRow(t, previewId)
    expect(after.phase).toBe("stale")
    expect({
      ...after,
      phase: before.phase,
      updatedAt: before.updatedAt,
    }).toEqual(before)
    expect(await previewPages(t, previewId)).toHaveLength(2)
    // Terminal: a later step is a no-op and the list refuses to show it.
    await stepPreview(t, previewId)
    expect(await previewRow(t, previewId)).toEqual(after)
    expect(
      await owner.query(api.cms.multilingual.listLanguageImpact, {
        previewId,
        ordinal: 0,
      })
    ).toEqual({ stale: true })
  }, 120_000)

  test("a completed preview expires fifteen minutes after completion", async () => {
    const site = await previewSite()
    const previewId = await startPreview(site)
    const { preview } = await runPreview(site.t, previewId)
    expect(preview.phase).toBe("complete")
    const list = () =>
      site.owner.query(api.cms.multilingual.listLanguageImpact, {
        previewId,
        ordinal: 0,
      })
    expect(await list()).toMatchObject({ stale: false })

    // Early delivery of the expiry is a no-op.
    await site.t.mutation(
      internal.cms.multilingual.expireLanguageImpactPreview,
      {
        previewId,
        generation: 1,
      }
    )
    expect((await previewRow(site.t, previewId)).phase).toBe("complete")

    await drain(site.t)
    const expired = await previewRow(site.t, previewId)
    expect(expired.phase).toBe("expired")
    expect(Date.now()).toBeGreaterThanOrEqual(preview.expiresAt!)
    expect(await list()).toEqual({ stale: true })
  }, 120_000)

  test("a newer preview replaces the live one in its slot only", async () => {
    const site = await previewSite()
    const { t } = site
    const first = await startPreview(site)
    await runPreview(t, first)
    const reveal = await startPreview(site, "reveal", "nl")
    const second = await startPreview(site)
    expect((await previewRow(t, first)).phase).toBe("stale")
    expect((await previewRow(t, second)).phase).toBe("scanning")
    expect((await previewRow(t, reveal)).phase).toBe("scanning")
    expect(
      await site.owner.query(api.cms.multilingual.listLanguageImpact, {
        previewId: first,
        ordinal: 0,
      })
    ).toEqual({ stale: true })

    // More than one live row in a slot fails closed and writes nothing.
    await t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db.get(second))!
      void _id
      void _creationTime
      await ctx.db.insert("siteLanguageImpactPreviews", {
        ...row,
        phase: "complete",
      })
    })
    expect(await refusalWritesNothing(t, () => startPreview(site))).toEqual(
      refused("LANGUAGE_PREVIEW_STATE_INVALID")
    )
  }, 120_000)

  test("start refuses outside S4 and for an ineligible locale, writing nothing", async () => {
    const site = await previewSite()
    const cases: [string, "remove" | "reveal", string][] = [
      ["LOCALE_IS_DEFAULT", "remove", "en"],
      ["LOCALE_NOT_ENABLED", "remove", "nl"],
      ["LOCALE_ALREADY_ENABLED", "reveal", "fr"],
      ["LOCALE_UNSUPPORTED", "reveal", "xx"],
    ]
    for (const [code, kind, locale] of cases) {
      expect(
        await refusalWritesNothing(site.t, () =>
          startPreview(site, kind, locale)
        )
      ).toEqual(refused(code))
    }
    const current = await inventorySite("CUR")
    await enableMultilingualModule(current.t)
    expect(
      await refusalWritesNothing(current.t, () =>
        startPreview(current, "reveal", "fr")
      )
    ).toEqual(refused("MULTILINGUAL_NOT_ADOPTED"))
    const invalid = await inventorySite("INV")
    await enableMultilingualModule(invalid.t)
    expect(
      await refusalWritesNothing(invalid.t, () =>
        startPreview(invalid, "reveal", "fr")
      )
    ).toEqual(refused("SITE_LANGUAGE_AUTHORITY_INVALID"))
  }, 120_000)

  test("every section's page-sized batch at its field maxima writes exactly one page within 64 KiB", async () => {
    const site = await previewSite()
    const { t, owner } = site
    const long = (bytes: number, char = "é") =>
      char.repeat(Math.ceil(bytes / new TextEncoder().encode(char).byteLength))
    // A published title far above its 1 KiB maximum.
    const longPageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "long",
      title: "long",
      content: {
        en: { title: "long en", slices: [] },
        fr: { title: long(8 * KIB), slices: [] },
      },
    })
    await owner.mutation(
      api.cms.publication.publishLocale,
      await publishArgs(t, longPageId, "fr")
    )
    await t.run(async (ctx) => {
      // Only the long Page is selected in `fr`, cloned to one full batch.
      const bonjour = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.frPageId).eq("locale", "fr")
        )
        .unique())!
      await ctx.db.delete(bonjour._id)
    })
    const longSite = { ...site, frPageId: longPageId }
    await seedSelections(
      longSite,
      Array.from({ length: 14 }, (_, i) => `/${i}${long(3 * KIB)}`)
    )
    await seedHistoricalRoutes(longSite, [
      ...Array.from({ length: 20 }, (_, i) => `/${i}${long(3 * KIB)}`),
      `/huge${long(100 * KIB, "a")}`,
    ])
    await seedRedirects(
      longSite,
      Array.from({ length: 9 }, (_, i) => ({
        fromPath: `/${i}${long(3 * KIB)}`,
        toPath: `https://example.com/${long(3 * KIB)}`,
        locale: "fr",
      }))
    )
    const pad = long(2 * KIB)
    await seedMenu(longSite, `menu${pad}`, menuNav(1, 20, ["fr"], pad))

    const previewId = await startPreview(site)
    const { preview } = await runPreview(t, previewId)
    expect(preview.phase).toBe("complete")
    const pages = await previewPages(t, previewId)
    expect(pages.map((page) => [page.section, page.items.length])).toEqual([
      ["selections", 15],
      ["historical_routes", 21],
      ["manual_rules", 9],
      ["menus", 21],
      ["menus", 1],
    ])
    const encoder = new TextEncoder()
    const bytes = (value: string) => encoder.encode(value).byteLength
    for (const page of pages) {
      expect(storedPageBytes(page)).toBeLessThanOrEqual(64 * KIB)
      for (const item of page.items) {
        expect(item.truncated).toBe(true)
        for (const [field, max] of Object.entries(DISCLOSURE_FIELD_MAX_BYTES)) {
          const value =
            (item as Record<string, unknown>)[field] ??
            ((item as { destination?: Record<string, unknown> }).destination ??
              {})[field]
          if (typeof value === "string") {
            expect(bytes(value)).toBeLessThanOrEqual(max)
          }
        }
      }
    }
    // The 100 KiB field was cut to its maximum and the cursor moved past it.
    expect(
      pages[1]!.items.some(
        (item) =>
          item.kind === "historical_route" &&
          item.fromPath.startsWith("/huge") &&
          bytes(item.fromPath) === DISCLOSURE_FIELD_MAX_BYTES.fromPath
      )
    ).toBe(true)
  }, 120_000)

  test("a selected non-routable snapshot uses its own arm", async () => {
    const site = await previewSite()
    const [clonedPageId] = await seedSelections(site, [null])
    const { preview } = await runPreview(site.t, await startPreview(site))
    const items = (await previewPages(site.t, preview._id)).flatMap(
      (page) => page.items
    )
    const nonRoutable = items.filter(
      (item) => item.kind === "selection_non_routable"
    )
    expect(nonRoutable).toEqual([
      {
        kind: "selection_non_routable",
        pageId: clonedPageId,
        title: "bonjour fr",
      },
    ])
    expect(preview.count.publicPages).toBe(2)
  }, 120_000)

  test("a SplitRequired page and a reserve crossing write nothing and retry at half size", async () => {
    const site = await previewSite()
    const { t } = site
    await seedSelections(
      site,
      Array.from({ length: 19 }, (_, i) => `/fr/extra-${i}`)
    )
    const realPaginate = impactPreviewSeam.paginate.bind(impactPreviewSeam)
    const realMetrics = impactPreviewSeam.metrics.bind(impactPreviewSeam)
    const previewId = await startPreview(site)
    const unchanged = async (run: () => Promise<void>) => {
      const before = await previewRow(t, previewId)
      await run()
      const after = await previewRow(t, previewId)
      expect(after.phase).toBe("scanning")
      expect({
        count: after.count,
        digest: after.digest,
        pageCount: after.pageCount,
        cursorPhase: after.cursorPhase,
      }).toEqual({
        count: before.count,
        digest: before.digest,
        pageCount: before.pageCount,
        cursorPhase: before.cursorPhase,
      })
      return after
    }

    const split = vi
      .spyOn(impactPreviewSeam, "paginate")
      .mockImplementationOnce(async (query, options) => ({
        ...(await realPaginate(query, options)),
        pageStatus: "SplitRequired" as const,
      }))
    await unchanged(() => stepPreview(t, previewId))
    split.mockRestore()
    expect(await previewPages(t, previewId)).toHaveLength(0)
    await stepPreview(t, previewId)
    expect(
      (await previewPages(t, previewId)).map((p) => p.items.length)
    ).toEqual([7])

    // A crossing after the third item of the next batch.
    let calls = 0
    const crossing = vi
      .spyOn(impactPreviewSeam, "metrics")
      .mockImplementation(async (ctx) => {
        const metrics = await realMetrics(ctx)
        calls += 1
        return calls === 4
          ? {
              ...metrics,
              bytesRead: { used: 5 * KIB * KIB, remaining: 11 * KIB * KIB },
            }
          : metrics
      })
    await unchanged(() => stepPreview(t, previewId))
    crossing.mockRestore()
    await stepPreview(t, previewId)
    // The halved batch resumes at the committed cursor: 7, then 6, then 7.
    await stepPreview(t, previewId)
    const { preview } = await runPreview(t, previewId)
    const selections = (await previewPages(t, previewId)).filter(
      (page) => page.section === "selections"
    )
    expect(selections.map((page) => page.items.length)).toEqual([7, 7, 6])
    expect(preview.count.publicPages).toBe(20)
    expect(
      new Set(
        selections.flatMap((page) =>
          page.items.map((item) => (item as { path: string }).path)
        )
      ).size
    ).toBe(20)
  }, 120_000)

  test.each(["split", "crossing"] as const)(
    "a %s at every size fails closed as stale at a page size of one",
    async (fault) => {
      const site = await previewSite()
      const { t } = site
      const realPaginate = impactPreviewSeam.paginate.bind(impactPreviewSeam)
      const realMetrics = impactPreviewSeam.metrics.bind(impactPreviewSeam)
      const spy =
        fault === "split"
          ? vi
              .spyOn(impactPreviewSeam, "paginate")
              .mockImplementation(async (query, options) => ({
                ...(await realPaginate(query, options)),
                pageStatus: "SplitRequired" as const,
              }))
          : vi
              .spyOn(impactPreviewSeam, "metrics")
              .mockImplementation(async (ctx) => ({
                ...(await realMetrics(ctx)),
                documentsRead: { used: 20_000, remaining: 12_000 },
              }))
      const previewId = await startPreview(site)
      const sizes: (number | undefined)[] = []
      try {
        while ((await previewRow(t, previewId)).phase === "scanning") {
          if (sizes.length > 16) throw new Error("preview did not fail closed")
          await stepPreview(t, previewId)
          const row = await previewRow(t, previewId)
          sizes.push(row.cursor ? JSON.parse(row.cursor).size : undefined)
        }
      } finally {
        spy.mockRestore()
      }
      expect(sizes).toEqual([7, 3, 1, 1])
      expect(await previewRow(t, previewId)).toMatchObject({
        phase: "stale",
        pageCount: 0,
        cursorPhase: "selections",
      })
      expect(await previewPages(t, previewId)).toHaveLength(0)
    },
    120_000
  )

  test("a menu split fails closed and a crossing inside a resumed menu halves its node batch", async () => {
    const site = await previewSite()
    const { t } = site
    const nav = menuNav(2, 20, ["fr"])
    await seedMenu(site, "nodes", nav)
    const realPaginate = impactPreviewSeam.paginate.bind(impactPreviewSeam)
    const realMetrics = impactPreviewSeam.metrics.bind(impactPreviewSeam)

    const toMenus = async (previewId: PreviewId) => {
      for (let guard = 0; ; guard += 1) {
        if ((await previewRow(t, previewId)).cursorPhase === "menus") break
        if (guard > 16) throw new Error("preview did not reach menus")
        await stepPreview(t, previewId)
      }
    }
    const split = await startPreview(site)
    await toMenus(split)
    const splitSpy = vi
      .spyOn(impactPreviewSeam, "paginate")
      .mockImplementation(async (query, options) => ({
        ...(await realPaginate(query, options)),
        pageStatus: "SplitRequired" as const,
      }))
    await stepPreview(t, split)
    splitSpy.mockRestore()
    expect((await previewRow(t, split)).phase).toBe("stale")

    const resumed = await startPreview(site)
    await toMenus(resumed)
    await stepPreview(t, resumed)
    const crossing = vi
      .spyOn(impactPreviewSeam, "metrics")
      .mockImplementationOnce(async (ctx) => ({
        ...(await realMetrics(ctx)),
        databaseQueries: { used: 3_000, remaining: 1_000 },
      }))
    await stepPreview(t, resumed)
    crossing.mockRestore()
    const { preview } = await runPreview(t, resumed)
    const pages = (await previewPages(t, resumed)).filter(
      (page) => page.section === "menus"
    )
    expect(pages.map((page) => page.items.length)).toEqual([21, 10, 13])
    expect(
      pages.flatMap((page) =>
        page.items.map((item) => (item as { nodePath: string }).nodePath)
      )
    ).toEqual(menuNodePathsWithLocaleText(nav, "fr"))
    expect(preview.count.menus).toBe(1)
  }, 120_000)

  test("a menu that loses nodes behind its node cursor fails closed as stale", async () => {
    const site = await previewSite()
    const { t } = site
    const menuId = await seedMenu(site, "nodes", menuNav(2, 20, ["fr"]))
    const previewId = await startPreview(site)
    for (let guard = 0; ; guard += 1) {
      const row = await previewRow(t, previewId)
      if (row.cursor && JSON.parse(row.cursor).menu) break
      if (guard > 16) throw new Error("preview did not enter the menu")
      await stepPreview(t, previewId)
    }
    // A direct patch bypasses `menus.saveCanonical`, so no counter moves; the
    // node cursor itself must refuse the shorter walk.
    await t.run((ctx) => ctx.db.patch(menuId, { nav: menuNav(1, 2, ["fr"]) }))
    const pagesBefore = await previewPages(t, previewId)
    await stepPreview(t, previewId)
    expect((await previewRow(t, previewId)).phase).toBe("stale")
    expect(await previewPages(t, previewId)).toEqual(pagesBefore)
  }, 120_000)

  test("an unchanged corpus rebuilds to the same pages, counts and chain", async () => {
    const site = await previewSite()
    await seedSelections(
      site,
      Array.from({ length: 16 }, (_, i) => `/x-${i}`)
    )
    await seedHistoricalRoutes(site, ["/a", "/a", "/b"])
    await seedMenu(site, "nav", menuNav(1, 3, ["en", "fr"]))
    const first = (await runPreview(site.t, await startPreview(site))).preview
    const second = (await runPreview(site.t, await startPreview(site))).preview
    expect((await previewRow(site.t, first._id)).phase).toBe("stale")
    const strip = (pages: Awaited<ReturnType<typeof previewPages>>) =>
      pages.map(({ ordinal, section, items, generation }) => ({
        ordinal,
        section,
        items,
        generation,
      }))
    const firstPages = strip(await previewPages(site.t, first._id))
    expect(strip(await previewPages(site.t, second._id))).toEqual(firstPages)
    expect(second.count).toEqual(first.count)
    expect(second.pageCount).toBe(first.pageCount)
    // The chain binds its subject, so the same corpus under the second id
    // reproduces the second digest exactly.
    expect(await recomputedDigest(firstPages, second._id)).toBe(second.digest)
    expect(await recomputedDigest(firstPages, first._id)).toBe(first.digest)
  }, 120_000)
})

// ─── M05 C2b.1e: review receipts and the preview halves of P2b, P11b, P12a
// and P15a ──────────────────────────────────────────────────────────────────
//
// C2b.1 owns the preview and receipt half of each row; C2b.2 adds the add,
// reveal and remove half (ledger "C2b is split"). A half row is green only
// when both halves are.

function recordReview(
  caller: Pick<Caller, "mutation">,
  previewId: PreviewId,
  ordinal: number,
  pageDigest: string
) {
  return caller.mutation(api.cms.multilingual.recordLanguageImpactReview, {
    previewId,
    ordinal,
    pageDigest,
  })
}

async function pageDigests(t: T, previewId: PreviewId) {
  return (await previewPages(t, previewId)).map((page) => page.digest)
}

function listPage(
  caller: Pick<Caller, "query">,
  previewId: PreviewId,
  ordinal: number
) {
  return caller.query(api.cms.multilingual.listLanguageImpact, {
    previewId,
    ordinal,
  })
}

/** Lists and records every page in order, as the UI does. */
async function reviewEveryPage(site: Pick<Site, "t" | "owner">, id: PreviewId) {
  const { pageCount } = await previewRow(site.t, id)
  for (let ordinal = 0; ordinal < pageCount; ordinal += 1) {
    const listed = await listPage(site.owner, id, ordinal)
    if (listed.stale) throw new Error(`page ${ordinal} listed stale`)
    expect(await recordReview(site.owner, id, ordinal, listed.digest)).toEqual({
      stale: false,
      reviewedThroughOrdinal: ordinal,
      pageCount,
    })
  }
  return previewRow(site.t, id)
}

/** Twenty extra `fr` selections, so a preview has two selection pages. */
async function twoPagePreviewSite(): Promise<PreviewSite> {
  const site = await previewSite()
  await seedSelections(
    site,
    Array.from({ length: 20 }, (_, i) => `/fr/extra-${i}`)
  )
  return site
}

const MISMATCH = refused("LANGUAGE_PREVIEW_MISMATCH")
const STALE = ok({ stale: true })

describe("M05 C2b.1e review receipts", () => {
  test("a receipt advances by exactly one stored page and refuses anything else, writing nothing", async () => {
    const site = await twoPagePreviewSite()
    const { t, owner } = site
    const previewId = await startPreview(site)
    expect(
      await refusalWritesNothing(t, () => recordReview(owner, previewId, 0, ""))
    ).toEqual(STALE)

    const { preview } = await runPreview(t, previewId)
    expect(preview).toMatchObject({
      phase: "complete",
      reviewedThroughOrdinal: -1,
    })
    expect(preview.pageCount).toBeGreaterThanOrEqual(2)
    const digests = await pageDigests(t, previewId)
    expect(preview.digest).toBe(digests.at(-1))

    const malformed: [string, number, string][] = [
      ["skips page 0", 1, digests[1]!],
      ["another page's digest", 0, digests[1]!],
      ["the terminal digest for page 0", 0, preview.digest],
      ["an unknown digest", 0, "0".repeat(64)],
      ["a negative ordinal", -1, digests[0]!],
      ["a fractional ordinal", 0.5, digests[0]!],
    ]
    for (const [name, ordinal, digest] of malformed) {
      expect({
        name,
        result: await refusalWritesNothing(t, () =>
          recordReview(owner, previewId, ordinal, digest)
        ),
      }).toEqual({ name, result: MISMATCH })
    }

    expect(await recordReview(owner, previewId, 0, digests[0]!)).toEqual({
      stale: false,
      reviewedThroughOrdinal: 0,
      pageCount: preview.pageCount,
    })
    // A replay of a recorded page does not advance again.
    expect(
      await refusalWritesNothing(t, () =>
        recordReview(owner, previewId, 0, digests[0]!)
      )
    ).toEqual(MISMATCH)
    for (let ordinal = 1; ordinal < preview.pageCount; ordinal += 1) {
      expect(
        await recordReview(owner, previewId, ordinal, digests[ordinal]!)
      ).toMatchObject({ stale: false, reviewedThroughOrdinal: ordinal })
    }
    expect(
      await refusalWritesNothing(t, () =>
        recordReview(owner, previewId, preview.pageCount, digests[0]!)
      )
    ).toEqual(MISMATCH)
    const reviewed = await previewRow(t, previewId)
    expect(reviewed).toEqual({
      ...preview,
      reviewedThroughOrdinal: preview.pageCount - 1,
      updatedAt: reviewed.updatedAt,
    })
  }, 120_000)

  test("a receipt past expiry, off `complete` or over a duplicated page records nothing", async () => {
    const site = await twoPagePreviewSite()
    const { t, owner } = site
    const previewId = await startPreview(site)
    await runPreview(t, previewId)
    const digests = await pageDigests(t, previewId)

    expect(await recordReview(owner, previewId, 0, digests[0]!)).toMatchObject({
      stale: false,
      reviewedThroughOrdinal: 0,
    })

    const duplicate = await t.run(async (ctx) => {
      const page = (await ctx.db
        .query("siteLanguageDisclosurePages")
        .withIndex("by_previewId_and_ordinal", (q) =>
          q.eq("previewId", previewId).eq("ordinal", 1)
        )
        .unique())!
      const { _id, _creationTime, ...row } = page
      void _id
      void _creationTime
      return ctx.db.insert("siteLanguageDisclosurePages", row)
    })
    expect(
      await refusalWritesNothing(t, () =>
        recordReview(owner, previewId, 1, digests[1]!)
      )
    ).toEqual(refused("LANGUAGE_PREVIEW_STATE_INVALID"))
    await t.run((ctx) => ctx.db.delete(duplicate))

    for (const phase of ["scanning", "stale", "expired", "consumed"] as const) {
      await t.run((ctx) => ctx.db.patch(previewId, { phase }))
      expect({
        phase,
        result: await refusalWritesNothing(t, () =>
          recordReview(owner, previewId, 1, digests[1]!)
        ),
      }).toEqual({ phase, result: STALE })
    }
    await t.run((ctx) => ctx.db.patch(previewId, { phase: "complete" }))
    expect(await recordReview(owner, previewId, 1, digests[1]!)).toMatchObject({
      stale: false,
      reviewedThroughOrdinal: 1,
    })

    // A separate preview exercises expiry without rewinding a backend whose
    // transactions have already committed at the expiry clock.
    const expiringSite = await twoPagePreviewSite()
    const expiringId = await startPreview(expiringSite)
    const { preview } = await runPreview(expiringSite.t, expiringId)
    const expiringDigests = await pageDigests(expiringSite.t, expiringId)
    vi.setSystemTime(preview.expiresAt! - 1)
    expect(
      await recordReview(expiringSite.owner, expiringId, 0, expiringDigests[0]!)
    ).toMatchObject({ stale: false, reviewedThroughOrdinal: 0 })
    // At `expiresAt`, before the scheduled flip: the listing cannot read the
    // clock and still shows the page, but the receipt is stale.
    vi.setSystemTime(preview.expiresAt!)
    expect(await listPage(expiringSite.owner, expiringId, 1)).toMatchObject({
      stale: false,
    })
    expect(
      await refusalWritesNothing(expiringSite.t, () =>
        recordReview(expiringSite.owner, expiringId, 1, expiringDigests[1]!)
      )
    ).toEqual(STALE)
  }, 120_000)
})

describe("M05 P2b owner-only previews and receipts (preview half)", () => {
  test("only the current owner starts, lists and records a receipt on its own preview", async () => {
    const site = await previewSite()
    const { t } = site
    const FORMER = {
      subject: "m05-p2b-former",
      tokenIdentifier: "https://convex.test|m05-p2b-former",
    }
    const CURRENT = {
      subject: "m05-p2b-current",
      tokenIdentifier: "https://convex.test|m05-p2b-current",
    }
    const LEGACY_ADMIN = {
      subject: "m05-p2b-legacy-admin",
      tokenIdentifier: "https://convex.test|m05-p2b-legacy-admin",
    }
    const bindOwner = (identity: typeof CURRENT) =>
      t.run(async (ctx) => {
        const owner = (await ctx.db.query("cmsOwner").unique())!
        await ctx.db.patch(owner._id, {
          authId: identity.subject,
          tokenIdentifier: identity.tokenIdentifier,
        })
      })
    // The harness re-seeds its fixture owner on every call, so the replaced
    // owner is a separate identity bound before its preview starts.
    await bindOwner(FORMER)
    const former = t.withIdentity(FORMER)
    const formerPreview = await startPreview({ owner: former })
    await runPreview(t, formerPreview)
    const [formerDigest] = await pageDigests(t, formerPreview)

    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("roles", {
        authId: LEGACY_ADMIN.subject,
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("cmsMemberships", {
        authId: LEGACY_ADMIN.subject,
        tokenIdentifier: LEGACY_ADMIN.tokenIdentifier,
        role: "admin",
        status: "active",
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
        transitionId: "m05-p2b",
      })
    })
    // The binding moves; FORMER is replaced and `formerPreview` stays its own.
    await bindOwner(CURRENT)
    const current = t.withIdentity(CURRENT)
    const currentPreview = await startPreview({ owner: current })
    await runPreview(t, currentPreview)
    const [currentDigest] = await pageDigests(t, currentPreview)

    type Caller = Pick<ReturnType<T["withIdentity"]>, "query" | "mutation">
    const calls = (caller: Caller) => ({
      start: () =>
        caller.mutation(api.cms.multilingual.startLanguageImpactPreview, {
          kind: "remove",
          locale: "fr",
        }),
      listCurrent: () => listPage(caller, currentPreview, 0),
      receiptCurrent: () =>
        recordReview(caller, currentPreview, 0, currentDigest!),
      listFormer: () => listPage(caller, formerPreview, 0),
      receiptFormer: () =>
        recordReview(caller, formerPreview, 0, formerDigest!),
    })
    const denied: [string, Caller, string][] = [
      ["unauthenticated", t, "UNAUTHENTICATED"],
      [
        "unrelated signed-in",
        t.withIdentity({
          subject: "m05-p2b-stranger",
          tokenIdentifier: "https://convex.test|m05-p2b-stranger",
        }),
        "CMS_OWNER_REQUIRED",
      ],
      [
        "role-only legacy Admin",
        t.withIdentity(LEGACY_ADMIN),
        "CMS_OWNER_REQUIRED",
      ],
      ["replaced former owner", former, "CMS_OWNER_REQUIRED"],
    ]
    for (const [identity, caller, code] of denied) {
      for (const [name, call] of Object.entries(calls(caller))) {
        expect({
          identity,
          name,
          result: await refusalWritesNothing(t, call),
        }).toEqual({ identity, name, result: refused(code) })
      }
    }

    // The current owner passes the owner gate, but the preview it names is
    // bound to another identity: a receipt or listing there refuses.
    const ownerCalls = calls(current)
    expect(await refusalWritesNothing(t, ownerCalls.listFormer)).toEqual(
      MISMATCH
    )
    expect(await refusalWritesNothing(t, ownerCalls.receiptFormer)).toEqual(
      MISMATCH
    )
    // Internal workers are not client-callable; called directly with either
    // preview they are no-ops outside `scanning` or at another generation.
    for (const previewId of [formerPreview, currentPreview]) {
      for (const generation of [1, 2]) {
        expect(
          await refusalWritesNothing(t, () =>
            t.mutation(internal.cms.multilingual.stepLanguageImpactPreview, {
              previewId,
              generation,
            })
          )
        ).toEqual(ok(null))
        expect(
          await refusalWritesNothing(t, () =>
            t.mutation(internal.cms.multilingual.expireLanguageImpactPreview, {
              previewId,
              generation,
            })
          )
        ).toEqual(ok(null))
      }
    }

    expect(await ownerCalls.listCurrent()).toMatchObject({ stale: false })
    expect(await ownerCalls.receiptCurrent()).toMatchObject({
      stale: false,
      reviewedThroughOrdinal: 0,
    })
    const { previewId: next } = await ownerCalls.start()
    expect((await previewRow(t, next)).owner.tokenIdentifier).toBe(
      CURRENT.tokenIdentifier
    )
    expect((await previewRow(t, currentPreview)).phase).toBe("stale")
    expect((await previewRow(t, formerPreview)).phase).toBe("complete")
  }, 120_000)
})

const MIB = KIB * KIB
const METRICS = [
  "databaseQueries",
  "documentsRead",
  "documentsWritten",
  "functionsScheduled",
  "bytesRead",
  "bytesWritten",
  "scheduledFunctionArgsBytes",
] as const
type Used = Record<(typeof METRICS)[number], number>

async function usedMetrics(ctx: MutationCtx): Promise<Used> {
  const metrics = await ctx.meta.getTransactionMetrics()
  return Object.fromEntries(
    METRICS.map((key) => [key, metrics[key].used])
  ) as Used
}

/**
 * P11a's scale: 16 enabled locales and, beyond `previewSite`'s own rows,
 * `pageCount` Pages selected in the previewed locale plus volume in every
 * other section.
 */
async function measuredPreviewSite(pageCount: number) {
  const site = await previewSite()
  const locales = [...SUPPORTED_LOCALES]
  expect(locales).toHaveLength(15)
  await site.t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").unique())!
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(settings._id, { enabledLocales: locales })
    await ctx.db.patch(authority._id, { enabledLocales: locales })
  })
  if (pageCount > 0) {
    await seedSelections(
      site,
      Array.from({ length: pageCount }, (_, i) => `/fr/page-${i}`)
    )
    await seedHistoricalRoutes(
      site,
      Array.from({ length: 50 }, (_, i) => `/fr/old-${i}`)
    )
    await seedRedirects(
      site,
      Array.from({ length: 20 }, (_, i) => ({
        fromPath: `/fr/rule-${i}`,
        locale: "fr",
      }))
    )
    await seedMenu(site, "wide", menuNav(10, 4, ["en", "fr"]))
  }
  return site
}

describe("M05 P11b bounded previews and receipts (preview half)", () => {
  test("every preview step on a 1,000-page, 15-locale site stays within its worker ceiling", async () => {
    const site = await measuredPreviewSite(1_000)
    const { t } = site
    const previewId = await startPreview(site)
    const steps: (Used & { section: string })[] = []
    for (let guard = 0; guard < 400; guard += 1) {
      const row = await previewRow(t, previewId)
      if (row.phase !== "scanning") break
      // Only the step and the metrics read share this transaction.
      const used = await t.run(async (ctx) => {
        await runPreviewStep(ctx, previewId, 1)
        return usedMetrics(ctx)
      })
      steps.push({ section: row.cursorPhase, ...used })
    }
    const preview = await previewRow(t, previewId)
    expect(preview.phase).toBe("complete")
    expect(preview.count).toMatchObject({
      publicPages: 1_001,
      routes: 50,
      manualRules: 20,
    })
    expect(new Set(steps.map((step) => step.section))).toEqual(
      new Set(["selections", "historical_routes", "manual_rules", "menus"])
    )

    const worst: Record<string, Used> = {}
    for (const { section, ...used } of steps) {
      const key = section === "selections" ? "selections" : "other"
      const prior = worst[key]
      worst[key] = prior
        ? (Object.fromEntries(
            METRICS.map((metric) => [
              metric,
              Math.max(prior[metric], used[metric]),
            ])
          ) as Used)
        : used
    }
    const common = {
      documentsWritten: 2,
      functionsScheduled: 1,
      bytesRead: 4 * MIB,
      bytesWritten: 1 * MIB,
      scheduledFunctionArgsBytes: 64 * KIB,
    }
    const ceilings: Record<string, Used> = {
      selections: { databaseQueries: 38, documentsRead: 52, ...common },
      other: { databaseQueries: 27, documentsRead: 47, ...common },
    }
    for (const [cell, used] of Object.entries(worst)) {
      for (const metric of METRICS) {
        expect({
          cell,
          metric,
          within: used[metric] <= ceilings[cell]![metric],
        }).toEqual({ cell, metric, within: true })
      }
    }
    // Every step wrote its page and the preview, and scheduled one function.
    expect(steps.every((step) => step.functionsScheduled === 1)).toBe(true)
  }, 300_000)

  test("a receipt costs the same on a 1,000-page, 15-locale site as on a tiny one", async () => {
    const receiptMetrics = async (pageCount: number) => {
      const site = await measuredPreviewSite(pageCount)
      const previewId = await startPreview(site)
      await runPreview(site.t, previewId)
      const digests = await pageDigests(site.t, previewId)
      const measure = (ordinal: number) =>
        site.t.withIdentity(OWNER).run(async (ctx) => {
          const owner = await requireInstallationOwner(ctx)
          const result = await recordImpactReviewInTransaction(
            ctx,
            owner,
            previewId,
            ordinal,
            digests[ordinal]!
          )
          expect(result).toMatchObject({
            stale: false,
            reviewedThroughOrdinal: ordinal,
          })
          return usedMetrics(ctx)
        })
      const first = await measure(0)
      for (let ordinal = 1; ordinal < digests.length - 1; ordinal += 1) {
        await recordReview(site.owner, previewId, ordinal, digests[ordinal]!)
      }
      const last =
        digests.length > 1 ? await measure(digests.length - 1) : first
      return { pages: digests.length, first, last }
    }
    const counts = ({
      databaseQueries,
      documentsRead,
      documentsWritten,
      functionsScheduled,
    }: Used) => ({
      databaseQueries,
      documentsRead,
      documentsWritten,
      functionsScheduled,
    })
    const small = await receiptMetrics(0)
    const large = await receiptMetrics(1_000)
    expect(large.pages).toBeGreaterThan(small.pages)
    expect(counts(large.first)).toEqual(counts(small.first))
    expect(counts(large.last)).toEqual(counts(small.first))
    for (const used of [small.first, large.first, large.last]) {
      expect(used.documentsWritten).toBe(1)
      expect(used.functionsScheduled).toBe(0)
      expect(used.databaseQueries).toBeLessThanOrEqual(10)
      expect(used.documentsRead).toBeLessThanOrEqual(10)
      expect(used.bytesRead).toBeLessThanOrEqual(4 * MIB)
      expect(used.bytesWritten).toBeLessThanOrEqual(1 * MIB)
    }
  }, 300_000)
})

type RaceWriter = {
  /** Runs before the preview starts; returns what `write` needs. */
  prepare?: (site: PreviewSite, run: number) => Promise<unknown>
  write: (site: PreviewSite, prepared: unknown, run: number) => Promise<unknown>
  stales: boolean
}

async function saveFrDraft(site: PreviewSite, slug: string, title: string) {
  const args = await publishArgs(site.t, site.frPageId, "fr")
  await site.owner.mutation(api.cms.publication.saveLocaleDraft, {
    pageId: site.frPageId,
    locale: "fr",
    slug,
    draft: {
      pageType: "landing-page",
      localized: { title },
      slices: [],
    } as never,
    expectedDraftGeneration: args.expectedDraftGeneration,
    expectedLifecycleGeneration: args.expectedLifecycleGeneration,
  })
}

async function publishFr(site: PreviewSite) {
  await site.owner.mutation(
    api.cms.publication.publishLocale,
    await publishArgs(site.t, site.frPageId, "fr")
  )
}

async function publishedFrPage(site: PreviewSite, slug: string) {
  const pageId = await createPage(site.owner, slug, ["en", "fr"])
  await site.owner.mutation(
    api.cms.publication.publishLocale,
    await publishArgs(site.t, pageId, "fr")
  )
  return pageId
}

async function withdrawFr(site: PreviewSite, pageId: Id<"pages">) {
  const { state, page } = await generations(site.t, pageId, "fr")
  await site.owner.mutation(api.cms.publication.withdrawLocale, {
    pageId,
    locale: "fr",
    expectedSnapshotId: state!.currentSnapshotId!,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
  })
}

const DOCS_NAV = (fr?: string, extra?: string): NavItem[] => [
  {
    id: "docs",
    label: fr === undefined ? { en: "Docs" } : { en: "Docs", fr },
    target: { type: "external" as const, url: "https://example.com" },
  },
  ...(extra === undefined
    ? []
    : [
        {
          id: extra,
          label: { en: extra },
          target: { type: "external" as const, url: "https://example.com" },
        },
      ]),
]

/** Contract P12a's writers; P10a pins the scopes each one advances. */
const RACE_WRITERS: Record<string, RaceWriter> = {
  publish: {
    prepare: (site, run) => saveFrDraft(site, "bonjour", `Bonjour ${run}`),
    write: (site) => publishFr(site),
    stales: true,
  },
  withdraw: {
    prepare: (site, run) => publishedFrPage(site, `withdrawn-${run}`),
    write: (site, pageId) => withdrawFr(site, pageId as Id<"pages">),
    stales: true,
  },
  "route change": {
    prepare: (site, run) => saveFrDraft(site, `bonjour-${run}`, "Bonjour"),
    write: (site) => publishFr(site),
    stales: true,
  },
  "redirect create": {
    write: (site, _prepared, run) =>
      site.owner.mutation(api.cms.redirects.create, {
        fromPath: `/p12a-${run}`,
        toPath: "/bonjour",
        locale: "fr",
        statusCode: 301,
      }),
    stales: true,
  },
  "redirect remove": {
    prepare: async (site, run) =>
      (
        await seedRedirects(site, [
          { fromPath: `/p12a-remove-${run}`, toPath: "/x", locale: "fr" },
        ])
      )[0],
    write: (site, id) =>
      site.owner.mutation(api.cms.redirects.remove, {
        id: id as Id<"redirects">,
      }),
    stales: true,
  },
  // A withdrawn locale with a pending release: trashing the Page cancels the
  // release, a publication-set change in that locale only (P10a).
  "release change": {
    prepare: async (site, run) => {
      const pageId = await publishedFrPage(site, `released-${run}`)
      await withdrawFr(site, pageId)
      await site.t.run(async (ctx) => {
        const release = (await ctx.db
          .query("pageLocalePublicationReleases")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", "fr")
          )
          .first())!
        const { _id, _creationTime, publishedSnapshotId, publishedAt, ...row } =
          release
        void _id
        void _creationTime
        void publishedSnapshotId
        void publishedAt
        await ctx.db.insert("pageLocalePublicationReleases", {
          ...row,
          status: "pending",
        })
      })
      return pageId
    },
    write: async (site, pageId) =>
      site.owner.mutation(api.cms.publication.softDeletePage, {
        pageId: pageId as Id<"pages">,
        expectedLifecycleGeneration: (await generations(
          site.t,
          pageId as Id<"pages">,
          "fr"
        ))!.page!.lifecycleGeneration,
      }),
    stales: true,
  },
  "menu text": {
    // Default text first, once: a later default save must keep `fr` text.
    prepare: async (site, run) =>
      run === 0 &&
      site.owner.mutation(api.cms.menus.saveCanonical, {
        slug: MENU_SLUG,
        locale: "en",
        nav: DOCS_NAV(),
      }),
    write: (site, _prepared, run) =>
      site.owner.mutation(api.cms.menus.saveCanonical, {
        slug: MENU_SLUG,
        locale: "fr",
        nav: DOCS_NAV(`Documentation ${run}`),
      }),
    stales: true,
  },
  "menu structure": {
    write: (site, _prepared, run) =>
      site.owner.mutation(api.cms.menus.saveCanonical, {
        slug: MENU_SLUG,
        locale: "en",
        nav: DOCS_NAV(undefined, `extra-${run}`),
      }),
    stales: true,
  },
  "module toggle": {
    write: async (site, _prepared, run) =>
      site.owner.mutation(api.cms.modules.commit, {
        expectedConfigurationVersion: await moduleConfigurationVersion(site.t),
        changes: [{ moduleId: "redirects", enabled: run % 2 === 1 }],
      }),
    stales: true,
  },
  // C2b.2a: a plain add of another language moves the authority version.
  add: {
    write: async (site, _prepared, run) =>
      site.owner.mutation(api.cms.multilingual.addLanguage, {
        locale: ["nl", "es", "it"][run]!,
        ...(await addTokens(site.t)),
      }),
    stales: true,
  },
  // C2b.2b: a real removal of another language, added before the preview.
  remove: {
    prepare: (site, run) => addLanguage(site, ["nl", "es", "it"][run]!),
    write: (site, _prepared, run) =>
      removeLocale(site, ["nl", "es", "it"][run]!),
    stales: true,
  },
  "content-type archive": {
    write: (site, _prepared, run) =>
      site.owner.mutation(api.cms.contentTypes.setContentTypeArchived, {
        type: "landing-page",
        archived: run % 2 === 0,
      }),
    stales: false,
  },
}

describe("M05 P12a preview races (preview half)", () => {
  test.each(Object.entries(RACE_WRITERS))(
    "%s in both serial orders against a preview and its review",
    async (_name, writer) => {
      const site = await twoPagePreviewSite()
      const { t, owner } = site
      let run = 0
      const prepare = () => writer.prepare?.(site, run)
      const write = (prepared: unknown) => writer.write(site, prepared, run++)

      // Review, then the writer.
      let prepared = await prepare()
      const reviewed = await startPreview(site)
      expect((await runPreview(t, reviewed)).preview.phase).toBe("complete")
      const digests = await pageDigests(t, reviewed)
      expect(await recordReview(owner, reviewed, 0, digests[0]!)).toMatchObject(
        { stale: false, reviewedThroughOrdinal: 0 }
      )
      await write(prepared)
      if (writer.stales) {
        expect(await listPage(owner, reviewed, 1)).toEqual({ stale: true })
        expect(
          await refusalWritesNothing(t, () =>
            recordReview(owner, reviewed, 1, digests[1]!)
          )
        ).toEqual(STALE)
        expect((await previewRow(t, reviewed)).reviewedThroughOrdinal).toBe(0)
      } else {
        expect(await listPage(owner, reviewed, 1)).toMatchObject({
          stale: false,
        })
        expect(
          await recordReview(owner, reviewed, 1, digests[1]!)
        ).toMatchObject({ stale: false, reviewedThroughOrdinal: 1 })
      }

      // A preview step, then the writer.
      prepared = await prepare()
      const scanning = await startPreview(site)
      await stepPreview(t, scanning)
      const mid = await previewRow(t, scanning)
      expect(mid).toMatchObject({ phase: "scanning", pageCount: 1 })
      await write(prepared)
      await stepPreview(t, scanning)
      const after = await previewRow(t, scanning)
      if (writer.stales) {
        expect(after).toEqual({
          ...mid,
          phase: "stale",
          updatedAt: after.updatedAt,
        })
        expect(await previewPages(t, scanning)).toHaveLength(1)
      } else {
        expect(after).toMatchObject({ phase: "scanning", pageCount: 2 })
      }

      // The writer, then a preview and a full review.
      prepared = await prepare()
      await write(prepared)
      const fresh = await startPreview(site)
      const { preview } = await runPreview(t, fresh)
      expect(preview.phase).toBe("complete")
      expect((await reviewEveryPage(site, fresh)).reviewedThroughOrdinal).toBe(
        preview.pageCount - 1
      )
    },
    120_000
  )
})

describe("M05 P15a delayed preview steps (preview half)", () => {
  test("a step with a stale generation is a no-op", async () => {
    const site = await twoPagePreviewSite()
    const { t } = site
    const previewId = await startPreview(site)
    await stepPreview(t, previewId)
    expect(
      await refusalWritesNothing(t, () => stepPreview(t, previewId, 2))
    ).toEqual(ok(null))
    await t.run((ctx) => ctx.db.patch(previewId, { generation: 2 }))
    expect(
      await refusalWritesNothing(t, () => stepPreview(t, previewId, 1))
    ).toEqual(ok(null))
    expect(await previewRow(t, previewId)).toMatchObject({
      phase: "scanning",
      pageCount: 1,
    })
  }, 120_000)

  test("an unresumable cursor ends the preview stale and changes no visibility", async () => {
    const site = await twoPagePreviewSite()
    const { t, owner } = site
    const previewId = await startPreview(site)
    await stepPreview(t, previewId)
    // Well-formed preview cursor JSON, so the step reaches `.paginate()`.
    await t.run((ctx) =>
      ctx.db.patch(previewId, {
        cursor: JSON.stringify({ page: "not-a-cursor" }),
      })
    )
    const before = await previewRow(t, previewId)
    const pages = await previewPages(t, previewId)
    const surface = await publicSurface(t)
    const paginate = vi.spyOn(impactPreviewSeam, "paginate")
    try {
      await stepPreview(t, previewId)
      expect(paginate).toHaveBeenCalledTimes(1)
    } finally {
      paginate.mockRestore()
    }
    const after = await previewRow(t, previewId)
    expect(after.phase).toBe("stale")
    expect({
      ...after,
      phase: before.phase,
      updatedAt: before.updatedAt,
    }).toEqual(before)
    expect(await previewPages(t, previewId)).toEqual(pages)
    expect(await publicSurface(t)).toEqual(surface)
    expect(await listPage(owner, previewId, 0)).toEqual({ stale: true })
    expect(
      await refusalWritesNothing(t, () =>
        recordReview(owner, previewId, 0, pages[0]!.digest)
      )
    ).toEqual(STALE)
  }, 120_000)
})

// ─── C2b.2a add and reveal ─────────────────────────────────────────────────
//
// Contract Sequences › Add and reveal; P4, P19b and the add and reveal halves
// of P2b, P11b and P12a. A retained language is built with `hideLocale`,
// which drops it from the authority and its settings mirror as a committed
// removal does and leaves every M9 row in place ("hideLocale parity" below).

type AddCaller = Pick<Caller, "mutation">
type PreviewClaim = Awaited<ReturnType<typeof previewClaim>>

async function addTokens(t: T) {
  return {
    expectedAuthorityVersion: await authorityVersion(t),
    expectedModuleConfigurationVersion: await moduleConfigurationVersion(t),
  }
}

/** The terminal digest and count the owner saw, as the UI submits them. */
async function previewClaim(t: T, previewId: PreviewId) {
  const { digest, count } = await previewRow(t, previewId)
  return { previewId, expectedDigest: digest, expectedCount: count }
}

async function addLanguage(
  site: Pick<Site, "t" | "owner">,
  locale: string,
  claim?: PreviewClaim,
  caller: AddCaller = site.owner
) {
  return caller.mutation(api.cms.multilingual.addLanguage, {
    locale,
    ...(await addTokens(site.t)),
    ...(claim ? { preview: claim } : {}),
  })
}

/**
 * A committed removal's authority and settings write, without its preview or
 * intent. C2b.2b's parity test proves every other table matches a real
 * `removeLanguage`.
 */
async function hideLocale(t: T, locale: string) {
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").unique())!
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    const enabledLocales = authority.enabledLocales!.filter(
      (enabled) => enabled !== locale
    )
    const now = Date.now()
    await ctx.db.patch(settings._id, { enabledLocales, updatedAt: now })
    await ctx.db.patch(authority._id, {
      enabledLocales,
      version: authority.version + 1,
      updatedAt: now,
    })
  })
}

type RetainedSite = PreviewSite & { nlPageId: Id<"pages">; nlPath: string }

/**
 * `previewSite` plus `nl`, added, published on one Page and hidden again, so
 * the Page's `nl` URL is retained but not public.
 */
async function retainedSite(): Promise<RetainedSite> {
  const site = await previewSite()
  expect(await addLanguage(site, "nl")).toMatchObject({ operationKind: "add" })
  const nlPageId = await createPage(site.owner, "willkommen", ["en", "nl"])
  await site.owner.mutation(
    api.cms.publication.publishLocale,
    await publishArgs(site.t, nlPageId, "nl")
  )
  await drain(site.t)
  const nlPath = (await localeState(site.t, nlPageId, "nl")).currentPath!
  await hideLocale(site.t, "nl")
  return { ...site, nlPageId, nlPath }
}

async function publicRead(t: T, locale: string, path: string) {
  const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
  const id = await t.query(api.cms.pages.resolveLocalizedPathQuery, {
    path,
    locale,
    languageVersion,
  })
  return {
    id,
    page: id
      ? await t.query(api.cms.pages.getPublicPageById, {
          id,
          locale,
          languageVersion,
        })
      : null,
  }
}

/** A completed `reveal` preview reviewed through its last page. */
async function reviewedReveal(
  site: Pick<Site, "t" | "owner">,
  locale = "nl"
): Promise<PreviewId> {
  const previewId = await startPreview(site, "reveal", locale)
  expect((await runPreview(site.t, previewId)).preview.phase).toBe("complete")
  await reviewEveryPage(site, previewId)
  return previewId
}

/** The tables add and reveal may write (contract Add and reveal; M9, M17). */
const ADD_WRITE_SET = [
  "siteLanguageAuthority",
  "siteSettings",
  "siteLanguageImpactPreviews",
  "siteLanguageLifecycleIntents",
]

async function rowsOutsideAddWriteSet(t: T) {
  const rows = await everyRow(t)
  for (const table of ADD_WRITE_SET) delete rows[table]
  return rows
}

const NOT_FOUND = { id: null, page: null }

describe("M05 P4 add and independent publish", () => {
  test("a plain add writes nothing else, and the new language is public only once published", async () => {
    const site = await buildSite("S1", "absent")
    const { t, owner } = site
    await toggleMultilingual(site, true)
    await adopt(site)
    const aboutEn = await publicRead(t, "en", "about")
    expect(aboutEn.id).toBe(site.aboutId)
    const rows = await rowsOutsideAddWriteSet(t)
    const version = await authorityVersion(t)

    expect(await addLanguage(site, "fr")).toEqual({
      version: version + 1,
      enabledLocales: ["en", "fr"],
      operationKind: "add",
    })
    expect(await rowsOutsideAddWriteSet(t)).toEqual(rows)
    expect(await lifecycleOf(site)).toBe("S4")
    expect(await t.query(api.cms.settings.getSiteConfig, {})).toMatchObject({
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      languageVersion: version + 1,
    })
    expect(await publicRead(t, "en", "about")).toEqual(aboutEn)
    expect(await publicRead(t, "fr", "about")).toEqual(NOT_FOUND)

    // `fr` is public only once published, and publishing it leaves `en` alone.
    const contactId = await createPage(owner, "contact", ["en", "fr"])
    const english = async () => ({
      about: await publicRead(t, "en", "about"),
      contact: await publicRead(t, "en", "contact"),
      aboutState: await localeState(t, site.aboutId, "en"),
      contactState: await localeState(t, contactId, "en"),
    })
    const englishBefore = await english()
    expect(englishBefore.contact).toEqual(NOT_FOUND)
    expect(await publicRead(t, "fr", "contact")).toEqual(NOT_FOUND)
    await owner.mutation(
      api.cms.publication.publishLocale,
      await publishArgs(t, contactId, "fr")
    )
    await drain(t)
    expect((await localeState(t, contactId, "fr")).currentPath).toBe("/contact")
    expect(await publicRead(t, "fr", "contact")).toMatchObject({
      id: contactId,
    })
    expect(await english()).toEqual(englishBefore)
  }, 120_000)

  test("unsupported, duplicate, stale and ineligible adds refuse and write nothing", async () => {
    const site = await previewSite()
    const { t } = site
    const tokens = await addTokens(t)
    const add =
      (locale: string, overrides: Partial<typeof tokens> = {}) =>
      () =>
        site.owner.mutation(api.cms.multilingual.addLanguage, {
          locale,
          ...tokens,
          ...overrides,
        })
    const refuses = async (run: () => Promise<unknown>, code: string) =>
      expect(await refusalWritesNothing(t, run)).toEqual(refused(code))

    await refuses(add("xx"), "LOCALE_UNSUPPORTED")
    await refuses(add("fr"), "LOCALE_ALREADY_ENABLED")
    await refuses(add("en"), "LOCALE_ALREADY_ENABLED")
    await refuses(
      add("nl", {
        expectedAuthorityVersion: tokens.expectedAuthorityVersion - 1,
      }),
      "LANGUAGE_OPERATION_STALE"
    )
    await refuses(
      add("nl", {
        expectedModuleConfigurationVersion:
          tokens.expectedModuleConfigurationVersion + 1,
      }),
      "LANGUAGE_OPERATION_STALE"
    )
    // A committed add replayed with its own tokens is stale; with fresh
    // tokens the language is already enabled.
    expect(await add("nl")()).toMatchObject({ operationKind: "add" })
    await refuses(add("nl"), "LANGUAGE_OPERATION_STALE")
    await refuses(() => addLanguage(site, "nl"), "LOCALE_ALREADY_ENABLED")
    // M4: outside snapshot authority.
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("pagePublicationCutover").unique())!
      await ctx.db.patch(row._id, { phase: "preparing" })
    })
    await refuses(
      () => addLanguage(site, "es"),
      "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY"
    )

    // S3(S1): enabled but not adopted.
    const s3 = await buildSite("S1", "absent")
    await toggleMultilingual(s3, true)
    expect(
      await refusalWritesNothing(s3.t, () => addLanguage(s3, "fr"))
    ).toEqual(refused("MULTILINGUAL_NOT_ADOPTED"))
  }, 120_000)

  test("a manual rule alone needs a reviewed reveal preview while Redirects is effective", async () => {
    const site = await previewSite()
    const { t } = site
    const [ruleId] = await seedRedirects(site, [
      { fromPath: "/angebot", toPath: "/bonjour", locale: "nl" },
    ])
    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl"))
    ).toEqual(refused("LANGUAGE_PREVIEW_REQUIRED"))

    const previewId = await startPreview(site, "reveal", "nl")
    const { preview } = await runPreview(t, previewId)
    expect(preview).toMatchObject({
      phase: "complete",
      pageCount: 1,
      count: { publicPages: 0, routes: 0, manualRules: 1, menus: 0 },
    })
    expect(
      (await previewPages(t, previewId)).flatMap((page) => page.items)
    ).toMatchObject([
      { kind: "manual_rule", ruleId, fromPath: "/angebot", status: "active" },
    ])
    const claim = await previewClaim(t, previewId)
    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl", claim))
    ).toEqual(refused("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE"))

    await reviewEveryPage(site, previewId)
    const rows = await rowsOutsideAddWriteSet(t)
    const version = await authorityVersion(t)
    expect(await addLanguage(site, "nl", claim)).toEqual({
      version: version + 1,
      enabledLocales: ["en", "fr", "nl"],
      operationKind: "reveal",
    })
    expect(await rowsOutsideAddWriteSet(t)).toEqual(rows)
    expect((await previewRow(t, previewId)).phase).toBe("consumed")
  }, 120_000)

  test("with Redirects not effective the rule is not public, so the add is plain and ignores a supplied preview", async () => {
    const site = await previewSite()
    const { t } = site
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("cmsModuleState").unique())!
      await ctx.db.patch(row._id, {
        enabledModules: row.enabledModules.filter(
          (entry) => entry.moduleId !== "redirects"
        ),
      })
    })
    await seedRedirects(site, [
      { fromPath: "/angebot", toPath: "/bonjour", locale: "nl" },
    ])
    // A preview supplied with nothing to reveal is not needed, not checked
    // and not consumed.
    const previewId = await startPreview(site, "reveal", "nl")
    await runPreview(t, previewId)
    const unused = await previewRow(t, previewId)
    const rows = await rowsOutsideAddWriteSet(t)
    expect(
      await addLanguage(site, "nl", {
        ...(await previewClaim(t, previewId)),
        expectedDigest: "not-the-digest",
      })
    ).toMatchObject({
      enabledLocales: ["en", "fr", "nl"],
      operationKind: "add",
    })
    expect(await rowsOutsideAddWriteSet(t)).toEqual(rows)
    expect(await previewRow(t, previewId)).toEqual(unused)
  }, 120_000)

  test("a retained selection returns from a reviewed reveal preview without republishing", async () => {
    const site = await retainedSite()
    const { t } = site
    expect(await publicRead(t, "nl", site.nlPath)).toEqual(NOT_FOUND)
    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl"))
    ).toEqual(refused("LANGUAGE_PREVIEW_REQUIRED"))

    const previewId = await reviewedReveal(site)
    expect((await previewRow(t, previewId)).count).toMatchObject({
      publicPages: 1,
    })
    const rows = await rowsOutsideAddWriteSet(t)
    expect(
      await addLanguage(site, "nl", await previewClaim(t, previewId))
    ).toMatchObject({
      enabledLocales: ["en", "fr", "nl"],
      operationKind: "reveal",
    })
    expect(await rowsOutsideAddWriteSet(t)).toEqual(rows)
    expect(await publicRead(t, "nl", site.nlPath)).toMatchObject({
      id: site.nlPageId,
    })
  }, 120_000)

  test("a reveal commits only from the caller's complete, unexpired, matching and fully reviewed preview", async () => {
    const site = await retainedSite()
    const { t } = site
    const refuses = async (claim: PreviewClaim, code: string) =>
      expect(
        await refusalWritesNothing(t, () => addLanguage(site, "nl", claim))
      ).toEqual(refused(code))

    // Complete but unreviewed; then scanning, which replaces it as stale.
    const unreviewed = await startPreview(site, "reveal", "nl")
    await runPreview(t, unreviewed)
    const unreviewedClaim = await previewClaim(t, unreviewed)
    await refuses(unreviewedClaim, "LANGUAGE_PREVIEW_REVIEW_INCOMPLETE")
    const reviewed = await startPreview(site, "reveal", "nl")
    await refuses(
      await previewClaim(t, reviewed),
      "LANGUAGE_PREVIEW_REVIEW_INCOMPLETE"
    )
    await refuses(unreviewedClaim, "LANGUAGE_OPERATION_STALE")

    await runPreview(t, reviewed)
    await reviewEveryPage(site, reviewed)
    const claim = await previewClaim(t, reviewed)
    // Another language's preview, another kind, digest or count.
    const other = await startPreview(site, "reveal", "es")
    await runPreview(t, other)
    await refuses(await previewClaim(t, other), "LANGUAGE_PREVIEW_MISMATCH")
    const otherKind = await startPreview(site, "remove", "fr")
    await runPreview(t, otherKind)
    await t.run((ctx) => ctx.db.patch(otherKind, { locale: "nl" }))
    await refuses(await previewClaim(t, otherKind), "LANGUAGE_PREVIEW_MISMATCH")
    await refuses(
      { ...claim, expectedDigest: "not-the-digest" },
      "LANGUAGE_PREVIEW_MISMATCH"
    )
    await refuses(
      {
        ...claim,
        expectedCount: {
          ...claim.expectedCount,
          publicPages: claim.expectedCount.publicPages + 1,
        },
      },
      "LANGUAGE_PREVIEW_MISMATCH"
    )
    // A consumed preview refuses although everything else still matches.
    await t.run((ctx) => ctx.db.patch(reviewed, { phase: "consumed" }))
    await refuses(claim, "LANGUAGE_OPERATION_STALE")
    await t.run((ctx) => ctx.db.patch(reviewed, { phase: "complete" }))
    // At `expiresAt`, before the expiry flip has run, and after it.
    const { expiresAt } = await previewRow(t, reviewed)
    vi.setSystemTime(expiresAt!)
    await refuses(claim, "LANGUAGE_OPERATION_STALE")
    await t.mutation(internal.cms.multilingual.expireLanguageImpactPreview, {
      previewId: reviewed,
      generation: 1,
    })
    expect((await previewRow(t, reviewed)).phase).toBe("expired")
    await refuses(claim, "LANGUAGE_OPERATION_STALE")

    // A fresh preview reviewed in full still commits.
    const fresh = await reviewedReveal(site)
    expect(
      await addLanguage(site, "nl", await previewClaim(t, fresh))
    ).toMatchObject({ operationKind: "reveal" })
  }, 120_000)

  test("a reveal after reviewing page one of two refuses as incomplete", async () => {
    const site = await twoPagePreviewSite()
    const { t, owner } = site
    await hideLocale(t, "fr")
    const previewId = await startPreview(site, "reveal", "fr")
    const { preview } = await runPreview(t, previewId)
    expect(preview.pageCount).toBeGreaterThanOrEqual(2)
    const digests = await pageDigests(t, previewId)
    await recordReview(owner, previewId, 0, digests[0]!)
    // The terminal digest and count, submitted after page one only.
    const claim = await previewClaim(t, previewId)
    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "fr", claim))
    ).toEqual(refused("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE"))
    for (let ordinal = 1; ordinal < digests.length; ordinal += 1) {
      await recordReview(owner, previewId, ordinal, digests[ordinal]!)
    }
    expect(await addLanguage(site, "fr", claim)).toMatchObject({
      enabledLocales: ["en", "fr"],
      operationKind: "reveal",
    })
  }, 120_000)
})

describe("M05 D1 add-language locale-prefix shadowing", () => {
  test("P11b walks every prefix source in bounded ordered pages", async () => {
    const site = await previewSite()
    const { t } = site
    await t.run(async (ctx) => {
      const template = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.aboutId).eq("locale", "en")
        )
        .unique())!
      const page = (await ctx.db.get(site.aboutId))!
      const {
        _id: stateId,
        _creationTime: stateCreatedAt,
        currentPath,
        pageId,
        ...state
      } = template
      void stateId
      void stateCreatedAt
      void currentPath
      void pageId
      const {
        _id: pageDocId,
        _creationTime: pageCreatedAt,
        ...pageFields
      } = page
      void pageDocId
      void pageCreatedAt
      for (let index = 0; index < 22; index += 1) {
        const clone = await ctx.db.insert("pages", {
          ...pageFields,
          slug: `d1-current-${index}`,
        } as never)
        await ctx.db.insert("pageLocalePublicationStates", {
          ...state,
          pageId: clone,
          currentPath: `/nl/current-${String(index).padStart(2, "0")}`,
        })
        await ctx.db.insert("pageHistoricalLocaleRoutes", {
          pageId: site.aboutId,
          locale: "en",
          fromPath: `/nl/historical-${String(index).padStart(2, "0")}`,
          createdFromSnapshotId: template.currentSnapshotId!,
          createdAt: FIXED_NOW,
        })
      }
    })
    await storePointedGeneration(
      site,
      Array.from({ length: 22 }, (_, index) => ({
        fromPath: `/nl/continuity-${String(index).padStart(2, "0")}`,
        pageId: site.aboutId,
        locale: "en",
      }))
    )
    await seedRedirects(
      site,
      Array.from({ length: 10 }, (_, index) => ({
        fromPath: `/nl/rule-${String(index).padStart(2, "0")}`,
        toPath: "/about",
        locale: "en",
      }))
    )

    const previewId = await startPreview(site, "reveal", "nl")
    const paginate = vi.spyOn(impactPreviewSeam, "paginate")
    const perStep: number[] = []
    const steps: Used[] = []
    try {
      for (let guard = 0; guard < 30; guard += 1) {
        if ((await previewRow(t, previewId)).phase !== "scanning") break
        const calls = paginate.mock.calls.length
        steps.push(
          await t.run(async (ctx) => {
            await runPreviewStep(ctx, previewId, 1)
            return usedMetrics(ctx)
          })
        )
        perStep.push(paginate.mock.calls.length - calls)
      }
    } finally {
      paginate.mockRestore()
    }

    expect(await previewRow(t, previewId)).toMatchObject({
      phase: "complete",
      count: { publicPages: 22, routes: 44, manualRules: 10, menus: 0 },
    })
    expect(perStep.every((calls) => calls <= 1)).toBe(true)
    const pages = await previewPages(t, previewId)
    const sourceOrder = pages.flatMap((page) =>
      page.items.map((item) =>
        item.kind === "locale_prefix_shadow" ? item.origin : item.kind
      )
    )
    expect([...new Set(sourceOrder)]).toEqual([
      "current",
      "historical",
      "default_migration",
      "manual_rule",
    ])
    expect(
      pages
        .map(
          (page) =>
            page.items.filter((item) => item.kind === "manual_rule").length
        )
        .filter((count) => count > 0)
    ).toEqual([9, 1])
    const worst = Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        Math.max(...steps.map((step) => step[metric])),
      ])
    ) as Used
    const ceilings: Used = {
      databaseQueries: 27,
      documentsRead: 47,
      documentsWritten: 2,
      functionsScheduled: 1,
      bytesRead: 4 * MIB,
      bytesWritten: 1 * MIB,
      scheduledFunctionArgsBytes: 64 * KIB,
    }
    for (const metric of METRICS) {
      expect({ metric, within: worst[metric] <= ceilings[metric] }).toEqual({
        metric,
        within: true,
      })
    }
    // Measured worst page: 9 queries, 27 documents read, 2 written, one
    // scheduled continuation, 10,809 bytes read, 3,876 bytes written and 66
    // scheduled-argument bytes.
  }, 300_000)

  test("a default-language Page under the new locale prefix requires reviewed disclosure", async () => {
    const site = await previewSite()
    const { t } = site
    await t.run(async (ctx) => {
      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.aboutId).eq("locale", "en")
        )
        .unique())!
      await ctx.db.patch(state._id, { currentPath: "/nl/contact" })
    })

    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl"))
    ).toEqual(refused("LANGUAGE_PREVIEW_REQUIRED"))

    const previewId = await startPreview(site, "reveal", "nl")
    const { preview } = await runPreview(t, previewId)
    expect(preview).toMatchObject({
      phase: "complete",
      count: { publicPages: 1, routes: 0, manualRules: 0, menus: 0 },
    })
    expect(
      (await previewPages(t, previewId)).flatMap((page) => page.items)
    ).toContainEqual({
      kind: "locale_prefix_shadow",
      pageId: site.aboutId,
      fromPath: "/nl/contact",
      origin: "current",
    })

    const claim = await previewClaim(t, previewId)
    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl", claim))
    ).toEqual(refused("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE"))
    await reviewEveryPage(site, previewId)
    expect(await addLanguage(site, "nl", claim)).toMatchObject({
      operationKind: "add",
    })
    expect((await previewRow(t, previewId)).phase).toBe("consumed")
  }, 120_000)

  test("a default-language historical route under the prefix is disclosed", async () => {
    const site = await previewSite()
    const { t } = site
    await t.run(async (ctx) => {
      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.aboutId).eq("locale", "en")
        )
        .unique())!
      await ctx.db.insert("pageHistoricalLocaleRoutes", {
        pageId: site.aboutId,
        locale: "en",
        fromPath: "/nl/old-about",
        createdFromSnapshotId: state.currentSnapshotId!,
        createdAt: FIXED_NOW,
      })
    })

    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl"))
    ).toEqual(refused("LANGUAGE_PREVIEW_REQUIRED"))
    const previewId = await startPreview(site, "reveal", "nl")
    const { preview } = await runPreview(t, previewId)
    expect(preview.count).toEqual({
      publicPages: 0,
      routes: 1,
      manualRules: 0,
      menus: 0,
    })
    expect(
      (await previewPages(t, previewId)).flatMap((page) => page.items)
    ).toContainEqual({
      kind: "locale_prefix_shadow",
      pageId: site.aboutId,
      fromPath: "/nl/old-about",
      origin: "historical",
    })

    await reviewEveryPage(site, previewId)
    expect(
      await addLanguage(site, "nl", await previewClaim(t, previewId))
    ).toMatchObject({ operationKind: "add" })
  }, 120_000)

  test("an effective default-language manual rule under the prefix is disclosed", async () => {
    const site = await previewSite()
    const { t } = site
    const [ruleId] = await seedRedirects(site, [
      { fromPath: "/nl/promo", toPath: "/about", locale: "en" },
    ])

    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl"))
    ).toEqual(refused("LANGUAGE_PREVIEW_REQUIRED"))
    const previewId = await startPreview(site, "reveal", "nl")
    const { preview } = await runPreview(t, previewId)
    expect(preview.count).toEqual({
      publicPages: 0,
      routes: 0,
      manualRules: 1,
      menus: 0,
    })
    expect(
      (await previewPages(t, previewId)).flatMap((page) => page.items)
    ).toContainEqual({
      kind: "manual_rule",
      ruleId,
      fromPath: "/nl/promo",
      destination: { kind: "path", toPath: "/about" },
      statusCode: 301,
      status: "shadowed",
    })

    await reviewEveryPage(site, previewId)
    expect(
      await addLanguage(site, "nl", await previewClaim(t, previewId))
    ).toMatchObject({ operationKind: "add" })
  }, 120_000)

  test("the pointed default-migration generation discloses only served prefix routes", async () => {
    const site = await previewSite()
    const { t } = site
    await storePointedGeneration(site, [
      { fromPath: "/nl/legacy", pageId: site.aboutId, locale: "en" },
      {
        fromPath: "/nl/shadowed",
        pageId: site.aboutId,
        locale: "en",
        shadow: "to_current",
      },
      {
        fromPath: "/nl/retired",
        pageId: site.aboutId,
        locale: "en",
        retiredAt: FIXED_NOW,
      },
    ])

    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl"))
    ).toEqual(refused("LANGUAGE_PREVIEW_REQUIRED"))
    const previewId = await startPreview(site, "reveal", "nl")
    const { preview } = await runPreview(t, previewId)
    expect(preview.count).toEqual({
      publicPages: 0,
      routes: 1,
      manualRules: 0,
      menus: 0,
    })
    expect(
      (await previewPages(t, previewId)).flatMap((page) => page.items)
    ).toEqual([
      {
        kind: "locale_prefix_shadow",
        pageId: site.aboutId,
        fromPath: "/nl/legacy",
        origin: "default_migration",
      },
    ])

    await reviewEveryPage(site, previewId)
    expect(
      await addLanguage(site, "nl", await previewClaim(t, previewId))
    ).toMatchObject({ operationKind: "add" })
  }, 120_000)

  test("F09 continuity is disclosed when no default-migration pointer exists", async () => {
    const site = await previewSite()
    const { t } = site
    await storeF09Continuity(site, "en", [
      { fromPath: "/nl/ueber-uns", pageId: site.aboutId },
    ])

    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl"))
    ).toEqual(refused("LANGUAGE_PREVIEW_REQUIRED"))
    const previewId = await startPreview(site, "reveal", "nl")
    const { preview } = await runPreview(t, previewId)
    expect(preview.count).toEqual({
      publicPages: 0,
      routes: 1,
      manualRules: 0,
      menus: 0,
    })
    expect(
      (await previewPages(t, previewId)).flatMap((page) => page.items)
    ).toEqual([
      {
        kind: "locale_prefix_shadow",
        pageId: site.aboutId,
        fromPath: "/nl/ueber-uns",
        origin: "language_transition",
      },
    ])

    await reviewEveryPage(site, previewId)
    expect(
      await addLanguage(site, "nl", await previewClaim(t, previewId))
    ).toMatchObject({ operationKind: "add" })
  }, 120_000)

  test("similarly named default-language paths do not reserve a locale prefix", async () => {
    const site = await previewSite()
    const { t } = site
    await t.run(async (ctx) => {
      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.aboutId).eq("locale", "en")
        )
        .unique())!
      await ctx.db.patch(state._id, { currentPath: "/deutsch" })
      await ctx.db.insert("pageHistoricalLocaleRoutes", {
        pageId: site.aboutId,
        locale: "en",
        fromPath: "/nl-offer",
        createdFromSnapshotId: state.currentSnapshotId!,
        createdAt: FIXED_NOW,
      })
    })

    expect(await addLanguage(site, "nl")).toMatchObject({
      enabledLocales: ["en", "fr", "nl"],
      operationKind: "add",
    })
  }, 120_000)

  test("creation numbers a reserved locale prefix before publication", async () => {
    const site = await previewSite()
    const pageId = await createPage(site.owner, "nl", ["en", "fr"])
    await site.owner.mutation(
      api.cms.publication.publishLocale,
      await publishArgs(site.t, pageId, "en")
    )
    expect((await localeState(site.t, pageId, "en")).currentPath).toBe("/nl-2")
  }, 120_000)

  test("an existing default-language locale-prefix claim may be republished in place", async () => {
    const site = await previewSite()
    await saveSlugDraft(site, site.aboutId, "en", "legacy-prefix")
    await site.t.run(async (ctx) => {
      const drafts = await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.aboutId).eq("locale", "en")
        )
        .take(2)
      if (drafts[0])
        await ctx.db.patch("pageLocaleDrafts", drafts[0]._id, { slug: "nl" })

      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.aboutId).eq("locale", "en")
        )
        .unique())!
      await ctx.db.patch(state._id, { currentPath: "/nl" })
    })

    expect(
      await site.owner.mutation(
        api.cms.publication.publishLocale,
        await publishArgs(site.t, site.aboutId, "en")
      )
    ).toMatchObject({ pageId: site.aboutId, locale: "en" })
    expect((await localeState(site.t, site.aboutId, "en")).currentPath).toBe(
      "/nl"
    )
  }, 120_000)

  test("a default-language route writer after review makes the add claim stale", async () => {
    const site = await previewSite()
    const { t } = site
    await t.run(async (ctx) => {
      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", site.aboutId).eq("locale", "en")
        )
        .unique())!
      await ctx.db.patch(state._id, { currentPath: "/nl/contact" })
    })
    const previewId = await startPreview(site, "reveal", "nl")
    await runPreview(t, previewId)
    await reviewEveryPage(site, previewId)
    const claim = await previewClaim(t, previewId)

    await site.owner.mutation(api.cms.redirects.create, {
      fromPath: "/nl/new-rule",
      toPath: "/about",
      locale: "en",
      statusCode: 301,
    })
    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "nl", claim))
    ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
  }, 120_000)
})

describe("M05 P19b lifecycle intents: add and reveal", () => {
  test("add and reveal each insert exactly one intent with their language", async () => {
    const site = await retainedSite()
    const { t } = site
    const before = await intentsOf(t)
    const added = await addLanguage(site, "es")
    const afterAdd = await intentsOf(t)
    expect(afterAdd.slice(0, before.length)).toEqual(before)
    expect(afterAdd.slice(before.length)).toEqual([
      {
        operationId: `add:v${added.version}`,
        operationKind: "add",
        locales: ["es"],
        capturedAuthorityVersion: added.version,
      },
    ])

    const previewId = await reviewedReveal(site)
    const afterPreview = await intentsOf(t)
    expect(afterPreview).toEqual(afterAdd)
    const revealed = await addLanguage(
      site,
      "nl",
      await previewClaim(t, previewId)
    )
    const afterReveal = await intentsOf(t)
    expect(afterReveal.slice(0, afterAdd.length)).toEqual(afterAdd)
    expect(afterReveal.slice(afterAdd.length)).toEqual([
      {
        operationId: `reveal:v${revealed.version}`,
        operationKind: "reveal",
        locales: ["nl"],
        capturedAuthorityVersion: revealed.version,
      },
    ])
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("siteLanguageLifecycleIntents")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", `reveal:v${revealed.version}`)
          )
          .take(2)
      )
    ).toMatchObject([
      { phase: "tags_and_layout", status: "pending", attempts: 0 },
    ])
  }, 120_000)
})

describe("M05 P2b owner-only add and reveal (command half)", () => {
  test("only the current owner adds and reveals, and only from its own preview", async () => {
    const site = await retainedSite()
    const { t } = site
    const FORMER = {
      subject: "m05-p2b-add-former",
      tokenIdentifier: "https://convex.test|m05-p2b-add-former",
    }
    const CURRENT = {
      subject: "m05-p2b-add-current",
      tokenIdentifier: "https://convex.test|m05-p2b-add-current",
    }
    const LEGACY_ADMIN = {
      subject: "m05-p2b-add-legacy-admin",
      tokenIdentifier: "https://convex.test|m05-p2b-add-legacy-admin",
    }
    const bindOwner = (identity: typeof CURRENT) =>
      t.run(async (ctx) => {
        const owner = (await ctx.db.query("cmsOwner").unique())!
        await ctx.db.patch(owner._id, {
          authId: identity.subject,
          tokenIdentifier: identity.tokenIdentifier,
        })
      })
    await bindOwner(FORMER)
    const former = t.withIdentity(FORMER)
    const formerPreview = await reviewedReveal({ t, owner: former })
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("roles", {
        authId: LEGACY_ADMIN.subject,
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("cmsMemberships", {
        authId: LEGACY_ADMIN.subject,
        tokenIdentifier: LEGACY_ADMIN.tokenIdentifier,
        role: "admin",
        status: "active",
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
        transitionId: "m05-p2b-add",
      })
    })
    await bindOwner(CURRENT)
    const current = t.withIdentity(CURRENT)
    const currentPreview = await reviewedReveal({ t, owner: current })
    const formerClaim = await previewClaim(t, formerPreview)
    const currentClaim = await previewClaim(t, currentPreview)

    const calls = (caller: AddCaller) => ({
      add: () => addLanguage(site, "es", undefined, caller),
      reveal: () => addLanguage(site, "nl", currentClaim, caller),
      revealFromFormer: () => addLanguage(site, "nl", formerClaim, caller),
    })
    const denied: [string, AddCaller, string][] = [
      ["unauthenticated", t, "UNAUTHENTICATED"],
      [
        "unrelated signed-in",
        t.withIdentity({
          subject: "m05-p2b-add-stranger",
          tokenIdentifier: "https://convex.test|m05-p2b-add-stranger",
        }),
        "CMS_OWNER_REQUIRED",
      ],
      [
        "role-only legacy Admin",
        t.withIdentity(LEGACY_ADMIN),
        "CMS_OWNER_REQUIRED",
      ],
      ["replaced former owner", former, "CMS_OWNER_REQUIRED"],
    ]
    for (const [identity, caller, code] of denied) {
      for (const [name, call] of Object.entries(calls(caller))) {
        expect({
          identity,
          name,
          result: await refusalWritesNothing(t, call),
        }).toEqual({ identity, name, result: refused(code) })
      }
    }

    // The current owner passes the owner gate, but a reveal naming another
    // identity's preview refuses.
    const ownerCalls = calls(current)
    expect(await refusalWritesNothing(t, ownerCalls.revealFromFormer)).toEqual(
      MISMATCH
    )
    expect(await ownerCalls.reveal()).toMatchObject({ operationKind: "reveal" })
    expect(await ownerCalls.add()).toMatchObject({ operationKind: "add" })
    expect((await previewRow(t, currentPreview)).phase).toBe("consumed")
    expect((await previewRow(t, formerPreview)).phase).toBe("complete")
  }, 120_000)
})

describe("M05 P11b bounded add and reveal commits (command half)", () => {
  test("add and reveal cost the same on a 1,000-page, 15-locale site as on a tiny one", async () => {
    const measure = (site: PreviewSite, args: AddLanguageArgs) =>
      site.t.withIdentity(OWNER).run(async (ctx) => {
        const owner = await requireInstallationOwner(ctx)
        const result = await addLanguageInTransaction(ctx, owner, args)
        return {
          operationKind: result.operationKind,
          used: await usedMetrics(ctx),
        }
      })
    const hidden = SUPPORTED_LOCALES[SUPPORTED_LOCALES.length - 1]
    expect(["en", "fr"]).not.toContain(hidden)

    // Plain add of a language with nothing retained.
    const addMetrics = async (pageCount: number) => {
      const site = await measuredPreviewSite(pageCount)
      await hideLocale(site.t, hidden)
      const { operationKind, used } = await measure(site, {
        locale: hidden,
        ...(await addTokens(site.t)),
      })
      expect(operationKind).toBe("add")
      return used
    }
    // Reveal of `fr` with every retained section, reviewed in full.
    const revealMetrics = async (pageCount: number) => {
      const site = await measuredPreviewSite(pageCount)
      // The large site retains 20 `fr` rules; one here gives both sites the
      // same probe results, so only page count differs.
      if (pageCount === 0) {
        await seedRedirects(site, [{ fromPath: "/fr/rule-0", locale: "fr" }])
      }
      await hideLocale(site.t, "fr")
      const previewId = await reviewedReveal(site, "fr")
      const { operationKind, used } = await measure(site, {
        locale: "fr",
        ...(await addTokens(site.t)),
        preview: await previewClaim(site.t, previewId),
      })
      expect(operationKind).toBe("reveal")
      return { used, pages: (await previewRow(site.t, previewId)).pageCount }
    }
    const counts = ({
      databaseQueries,
      documentsRead,
      documentsWritten,
      functionsScheduled,
    }: Used) => ({
      databaseQueries,
      documentsRead,
      documentsWritten,
      functionsScheduled,
    })

    const smallAdd = await addMetrics(0)
    const largeAdd = await addMetrics(1_000)
    expect(counts(largeAdd)).toEqual(counts(smallAdd))
    const smallReveal = await revealMetrics(0)
    const largeReveal = await revealMetrics(1_000)
    expect(largeReveal.pages).toBeGreaterThan(smallReveal.pages)
    expect(counts(largeReveal.used)).toEqual(counts(smallReveal.used))
    expect(counts(smallAdd)).toEqual({
      databaseQueries: 18,
      documentsRead: 8,
      documentsWritten: 3,
      functionsScheduled: 0,
    })
    expect(counts(smallReveal.used)).toEqual({
      databaseQueries: 19,
      documentsRead: 13,
      documentsWritten: 4,
      functionsScheduled: 0,
    })

    // Authority, settings and intent; a reveal also consumes its preview.
    expect(smallAdd.documentsWritten).toBe(3)
    expect(smallReveal.used.documentsWritten).toBe(4)
    for (const used of [
      smallAdd,
      largeAdd,
      smallReveal.used,
      largeReveal.used,
    ]) {
      expect(used.functionsScheduled).toBe(0)
      expect(used.databaseQueries).toBeLessThanOrEqual(20)
      expect(used.documentsRead).toBeLessThanOrEqual(16)
      expect(used.bytesRead).toBeLessThanOrEqual(4 * MIB)
      expect(used.bytesWritten).toBeLessThanOrEqual(1 * MIB)
    }
    // D1 adds a bounded prefix-existence probe to both paths and binds reveal
    // receipts to the default-locale freshness row, independent of site size.
  }, 600_000)
})

/** Writers that reach a hidden language's scope, the site or domain C. */
const REVEAL_RACE_WRITERS: Record<string, RaceWriter> = {
  "redirect create in the language": {
    write: (site, _prepared, run) =>
      site.owner.mutation(api.cms.redirects.create, {
        fromPath: `/p12a-nl-${run}`,
        toPath: "/x",
        locale: "nl",
        statusCode: 301,
      }),
    stales: true,
  },
  "redirect remove in the language": {
    prepare: async (site, run) =>
      (
        await seedRedirects(site, [
          { fromPath: `/p12a-nl-remove-${run}`, toPath: "/x", locale: "nl" },
        ])
      )[0],
    write: (site, id) =>
      site.owner.mutation(api.cms.redirects.remove, {
        id: id as Id<"redirects">,
      }),
    stales: true,
  },
  "unscoped redirect create": {
    write: (site, _prepared, run) =>
      site.owner.mutation(api.cms.redirects.create, {
        fromPath: `/p12a-site-${run}`,
        toPath: "/x",
        statusCode: 301,
      }),
    stales: true,
  },
  "menu structure": RACE_WRITERS["menu structure"]!,
  "module toggle": RACE_WRITERS["module toggle"]!,
  "add of another language": {
    write: async (site, _prepared, run) =>
      site.owner.mutation(api.cms.multilingual.addLanguage, {
        locale: ["es", "it"][run]!,
        ...(await addTokens(site.t)),
      }),
    stales: true,
  },
  "remove of another language": {
    prepare: (site, run) => addLanguage(site, ["es", "it"][run]!),
    write: (site, _prepared, run) => removeLocale(site, ["es", "it"][run]!),
    stales: true,
  },
  // Unrelated scopes: another language's publication and an authoring gate.
  "publish in another language": { ...RACE_WRITERS.publish!, stales: false },
  "content-type archive": RACE_WRITERS["content-type archive"]!,
}

describe("M05 P12a reveal commit races (command half)", () => {
  test.each(Object.entries(REVEAL_RACE_WRITERS))(
    "%s in both serial orders against a reviewed reveal",
    async (_name, writer) => {
      const site = await retainedSite()
      const { t } = site
      let run = 0
      const prepare = () => writer.prepare?.(site, run)
      const write = (prepared: unknown) => writer.write(site, prepared, run++)

      // Preview and full review, then the writer, then the commit.
      let prepared = await prepare()
      const reviewed = await reviewedReveal(site)
      const claim = await previewClaim(t, reviewed)
      await write(prepared)
      if (writer.stales) {
        expect(
          await refusalWritesNothing(t, () => addLanguage(site, "nl", claim))
        ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
        expect((await previewRow(t, reviewed)).phase).toBe("complete")
      } else {
        expect(await addLanguage(site, "nl", claim)).toMatchObject({
          operationKind: "reveal",
        })
        await hideLocale(t, "nl")
      }

      // The writer, then a preview, its full review and the commit.
      prepared = await prepare()
      await write(prepared)
      const fresh = await reviewedReveal(site)
      const committed = await addLanguage(
        site,
        "nl",
        await previewClaim(t, fresh)
      )
      expect(committed.operationKind).toBe("reveal")
      expect(committed.enabledLocales).toContain("nl")
      expect((await previewRow(t, fresh)).phase).toBe("consumed")
    },
    120_000
  )
})

// ─── C2b.2b remove ─────────────────────────────────────────────────────────
//
// Contract Sequences › Remove; P5, the remove case of P19b and the remove
// halves of P2b, P11b and P12a. `removeLanguage` names no locale: it removes
// the language of the submitted preview, and the preview holds every token.

type RemoveCaller = Pick<Caller, "mutation">

function removeLanguage(caller: RemoveCaller, claim: PreviewClaim) {
  return caller.mutation(api.cms.multilingual.removeLanguage, claim)
}

/** A completed `remove` preview reviewed through its last page. */
async function reviewedRemoval(
  site: Pick<Site, "t" | "owner">,
  locale = "fr"
): Promise<PreviewId> {
  const previewId = await startPreview(site, "remove", locale)
  expect((await runPreview(site.t, previewId)).preview.phase).toBe("complete")
  await reviewEveryPage(site, previewId)
  return previewId
}

/** A real removal: preview, full review and commit, as the owner does it. */
async function removeLocale(site: Pick<Site, "t" | "owner">, locale: string) {
  const previewId = await reviewedRemoval(site, locale)
  return removeLanguage(site.owner, await previewClaim(site.t, previewId))
}

/**
 * Clones the published `fr` release into `locale` with `status`. A direct
 * insert moves no freshness counter, so only the commit's probe can see it.
 */
async function seedRelease(
  site: PreviewSite,
  locale: string,
  status: "pending" | "held"
): Promise<Id<"pageLocalePublicationReleases">> {
  return site.t.run(async (ctx) => {
    const release = (await ctx.db
      .query("pageLocalePublicationReleases")
      .withIndex("by_pageId_and_locale_and_status", (q) =>
        q
          .eq("pageId", site.frPageId)
          .eq("locale", "fr")
          .eq("status", "published")
      )
      .first())!
    const { _id, _creationTime, publishedSnapshotId, publishedAt, ...row } =
      release
    void _id
    void _creationTime
    void publishedSnapshotId
    void publishedAt
    return ctx.db.insert("pageLocalePublicationReleases", {
      ...row,
      locale,
      status,
      ...(status === "held"
        ? { holdReason: "LOCALE_NOT_ENABLED", heldAt: FIXED_NOW }
        : {}),
    })
  })
}

/** Patches the authority and its mirror together without a new version. */
async function patchAuthorityInPlace(
  t: T,
  patch: { enabledLocales?: string[]; currentLocale?: string }
) {
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").unique())!
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(authority._id, patch)
    await ctx.db.patch(settings._id, {
      ...(patch.enabledLocales ? { enabledLocales: patch.enabledLocales } : {}),
      ...(patch.currentLocale ? { defaultLocale: patch.currentLocale } : {}),
    })
  })
}

async function resolveRule(t: T, path: string, locale: string) {
  const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
  return t.query(api.cms.redirects.resolve, { path, locale, languageVersion })
}

describe("M05 P5 remove", () => {
  test("a sealed, fully reviewed preview commits; the language's pages and rules stop answering and no M9 row changes", async () => {
    const site = await previewSite()
    const { t } = site
    const [ruleId] = await seedRedirects(site, [
      { fromPath: "/angebot", toPath: "/x", locale: "fr" },
    ])
    await seedRedirects(site, [
      { fromPath: "/offer", toPath: "/y", locale: "en" },
    ])
    const frPath = (await localeState(t, site.frPageId, "fr")).currentPath!
    expect(await publicRead(t, "fr", frPath)).toMatchObject({
      id: site.frPageId,
    })
    expect(await resolveRule(t, "/angebot", "fr")).toMatchObject({
      statusCode: 301,
    })
    const enBefore = await resolveRule(t, "/offer", "en")
    expect(enBefore).not.toBeNull()

    const previewId = await startPreview(site)
    const { preview } = await runPreview(t, previewId)
    expect(preview).toMatchObject({
      phase: "complete",
      count: { publicPages: 1, manualRules: 1 },
    })
    const items = (await previewPages(t, previewId)).flatMap(
      (page) => page.items
    )
    expect(items).toContainEqual(
      expect.objectContaining({ kind: "manual_rule", ruleId })
    )
    await reviewEveryPage(site, previewId)

    const rows = await rowsOutsideAddWriteSet(t)
    const version = await authorityVersion(t)
    expect(
      await removeLanguage(site.owner, await previewClaim(t, previewId))
    ).toEqual({ version: version + 1, enabledLocales: ["en"], locale: "fr" })
    // M9: every Page, draft, state, release, snapshot, route, menu and rule
    // row is unchanged byte for byte, including the silenced `fr` rule.
    expect(await rowsOutsideAddWriteSet(t)).toEqual(rows)
    expect((await previewRow(t, previewId)).phase).toBe("consumed")
    const [settings, authority] = await t.run(async (ctx) => [
      (await ctx.db.query("siteSettings").unique())!,
      (await ctx.db.query("siteLanguageAuthority").unique())!,
    ])
    expect(settings).toMatchObject({ enabledLocales: ["en"] })
    expect(authority).toMatchObject({
      mode: "multilingual",
      enabledLocales: ["en"],
      currentLocale: "en",
      version: version + 1,
    })

    // Not found, and the rule is silenced, not deleted; `en` is unchanged.
    expect(await publicRead(t, "fr", frPath)).toEqual(NOT_FOUND)
    expect(await resolveRule(t, "/angebot", "fr")).toBeNull()
    expect(await t.run((ctx) => ctx.db.get(ruleId!))).toMatchObject({
      locale: "fr",
      fromPath: "/angebot",
    })
    expect(await resolveRule(t, "/offer", "en")).toEqual(enBefore)
    // A retry with the consumed preview refuses and writes nothing.
    expect(
      await refusalWritesNothing(t, async () =>
        removeLanguage(site.owner, await previewClaim(t, previewId))
      )
    ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
  }, 120_000)

  test("a commit after page one of the review refuses as incomplete, and malformed receipts advance nothing", async () => {
    const site = await twoPagePreviewSite()
    const { t, owner } = site
    const previewId = await startPreview(site)
    // Scanning, then complete but unreviewed.
    const scanningClaim = await previewClaim(t, previewId)
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, scanningClaim))
    ).toEqual(refused("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE"))
    const { preview } = await runPreview(t, previewId)
    expect(preview.pageCount).toBeGreaterThanOrEqual(2)
    const claim = await previewClaim(t, previewId)
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE"))

    // Out of order and with the wrong digest: refused, nothing recorded.
    const digests = await pageDigests(t, previewId)
    expect(
      await refusalWritesNothing(t, () =>
        recordReview(owner, previewId, 1, digests[1]!)
      )
    ).toEqual(MISMATCH)
    expect(
      await refusalWritesNothing(t, () =>
        recordReview(owner, previewId, 0, digests[1]!)
      )
    ).toEqual(MISMATCH)
    expect(await recordReview(owner, previewId, 0, digests[0]!)).toMatchObject({
      stale: false,
      reviewedThroughOrdinal: 0,
    })
    // The terminal digest and count, submitted after page one only.
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE"))
    expect(
      await refusalWritesNothing(t, () =>
        recordReview(owner, previewId, 0, digests[0]!)
      )
    ).toEqual(MISMATCH)

    for (let ordinal = 1; ordinal < digests.length; ordinal += 1) {
      await recordReview(owner, previewId, ordinal, digests[ordinal]!)
    }
    expect(await removeLanguage(owner, claim)).toMatchObject({
      enabledLocales: ["en"],
      locale: "fr",
    })
  }, 120_000)

  test("a removal commits only from the caller's complete, unexpired, matching preview", async () => {
    const site = await previewSite()
    const { t, owner } = site
    const refuses = async (claim: PreviewClaim, code: string) =>
      expect(
        await refusalWritesNothing(t, () => removeLanguage(owner, claim))
      ).toEqual(refused(code))

    // A second live preview in the slot makes the first one stale.
    const replaced = await reviewedRemoval(site)
    const replacedClaim = await previewClaim(t, replaced)
    const reviewed = await reviewedRemoval(site)
    expect((await previewRow(t, replaced)).phase).toBe("stale")
    await refuses(replacedClaim, "LANGUAGE_OPERATION_STALE")
    const claim = await previewClaim(t, reviewed)

    // Missing, another owner's, another kind; another digest or count.
    const missing = await reviewedRemoval({ t, owner }, "fr")
    const missingClaim = await previewClaim(t, missing)
    await t.run((ctx) => ctx.db.delete(missing))
    await refuses(missingClaim, "LANGUAGE_PREVIEW_MISMATCH")
    const fresh = await reviewedRemoval(site)
    const freshClaim = await previewClaim(t, fresh)
    const foreign = await previewRow(t, fresh)
    await t.run((ctx) =>
      ctx.db.patch(fresh, {
        owner: { ...foreign.owner, tokenIdentifier: "https://convex.test|x" },
      })
    )
    await refuses(freshClaim, "LANGUAGE_PREVIEW_MISMATCH")
    await t.run((ctx) => ctx.db.patch(fresh, { owner: foreign.owner }))
    const reveal = await startPreview(site, "reveal", "nl")
    await runPreview(t, reveal)
    await t.run((ctx) => ctx.db.patch(reveal, { locale: "fr" }))
    await refuses(await previewClaim(t, reveal), "LANGUAGE_PREVIEW_MISMATCH")
    await refuses(
      { ...freshClaim, expectedDigest: "not-the-digest" },
      "LANGUAGE_PREVIEW_MISMATCH"
    )
    await refuses(
      {
        ...freshClaim,
        expectedCount: {
          ...freshClaim.expectedCount,
          manualRules: freshClaim.expectedCount.manualRules + 1,
        },
      },
      "LANGUAGE_PREVIEW_MISMATCH"
    )
    // Replaced by `fresh`, so `reviewed` is stale; so is a consumed preview.
    await refuses(claim, "LANGUAGE_OPERATION_STALE")
    await t.run((ctx) => ctx.db.patch(fresh, { phase: "consumed" }))
    await refuses(freshClaim, "LANGUAGE_OPERATION_STALE")
    await t.run((ctx) => ctx.db.patch(fresh, { phase: "complete" }))

    // A moved token after review.
    await site.owner.mutation(api.cms.redirects.create, {
      fromPath: "/p5-moved",
      toPath: "/x",
      locale: "fr",
      statusCode: 301,
    })
    await refuses(freshClaim, "LANGUAGE_OPERATION_STALE")

    // At `expiresAt`, before the expiry flip has run, and after it.
    const expiring = await reviewedRemoval(site)
    const expiringClaim = await previewClaim(t, expiring)
    const { expiresAt } = await previewRow(t, expiring)
    vi.setSystemTime(expiresAt!)
    await refuses(expiringClaim, "LANGUAGE_OPERATION_STALE")
    await t.mutation(internal.cms.multilingual.expireLanguageImpactPreview, {
      previewId: expiring,
      generation: 1,
    })
    expect((await previewRow(t, expiring)).phase).toBe("expired")
    await refuses(expiringClaim, "LANGUAGE_OPERATION_STALE")

    // A fresh preview reviewed in full still commits.
    const last = await reviewedRemoval(site)
    expect(
      await removeLanguage(owner, await previewClaim(t, last))
    ).toMatchObject({ locale: "fr" })
  }, 120_000)

  test("the default language is refused at start and at commit, and so is a language no longer enabled", async () => {
    const site = await previewSite()
    const { t, owner } = site
    expect(
      await refusalWritesNothing(t, () => startPreview(site, "remove", "en"))
    ).toEqual(refused("LOCALE_IS_DEFAULT"))

    // The tokens capture the authority version, so a real default change or
    // removal stales the preview first. These guards are reached only when
    // the authority changes in place, which is how they are constructed.
    const previewId = await reviewedRemoval(site)
    const claim = await previewClaim(t, previewId)
    await patchAuthorityInPlace(t, { currentLocale: "fr" })
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("LOCALE_IS_DEFAULT"))
    await patchAuthorityInPlace(t, { currentLocale: "en" })
    await patchAuthorityInPlace(t, { enabledLocales: ["en"] })
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("LOCALE_NOT_ENABLED"))
    await patchAuthorityInPlace(t, { enabledLocales: ["en", "fr"] })
    expect(await removeLanguage(owner, claim)).toMatchObject({ locale: "fr" })
  }, 120_000)

  test("a pending or held release in the language refuses; another language's pending release does not", async () => {
    const site = await previewSite()
    const { t, owner } = site
    const previewId = await reviewedRemoval(site)
    const claim = await previewClaim(t, previewId)
    const releaseId = await seedRelease(site, "fr", "pending")
    // The insert moved no counter: the preview still lists.
    expect(await listPage(owner, previewId, 0)).toMatchObject({ stale: false })
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("LANGUAGE_LOCALE_OBLIGATIONS_PRESENT"))
    await t.run((ctx) =>
      ctx.db.patch(releaseId, {
        status: "held",
        holdReason: "LOCALE_NOT_ENABLED",
        heldAt: FIXED_NOW,
      })
    )
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("LANGUAGE_LOCALE_OBLIGATIONS_PRESENT"))
    const heldId = await seedRelease(site, "fr", "held")
    await t.run((ctx) =>
      ctx.db.patch(releaseId, { status: "cancelled", cancelledAt: FIXED_NOW })
    )
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("LANGUAGE_LOCALE_OBLIGATIONS_PRESENT"))
    await t.run((ctx) =>
      ctx.db.patch(heldId, { status: "cancelled", cancelledAt: FIXED_NOW })
    )

    // Other languages' pending and held releases are unrelated: the default
    // language's, and one in a language that is not enabled.
    await seedRelease(site, "en", "pending")
    await seedRelease(site, "en", "held")
    await seedRelease(site, "nl", "pending")
    const rows = await rowsOutsideAddWriteSet(t)
    expect(await removeLanguage(owner, claim)).toMatchObject({ locale: "fr" })
    expect(await rowsOutsideAddWriteSet(t)).toEqual(rows)
  }, 120_000)

  test("remove refuses outside snapshot authority and outside S4", async () => {
    const site = await previewSite()
    const { t, owner } = site
    const claim = await previewClaim(t, await reviewedRemoval(site))
    const setCutoverPhase = (phase: "preparing" | "snapshot_active") =>
      t.run(async (ctx) => {
        const row = (await ctx.db.query("pagePublicationCutover").unique())!
        await ctx.db.patch(row._id, { phase })
      })
    await setCutoverPhase("preparing")
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY"))
    await setCutoverPhase("snapshot_active")

    // Committed, then returned to one language: S3(S1). State is checked
    // before the preview, so the consumed preview is not what refuses.
    await removeLanguage(owner, claim)
    await owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
      expectedAuthorityVersion: await authorityVersion(t),
    })
    expect(await lifecycleOf(site)).toBe("S3(S1)")
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("MULTILINGUAL_NOT_ADOPTED"))
    // Also when the named preview no longer exists.
    await t.run((ctx) => ctx.db.delete(claim.previewId))
    expect(
      await refusalWritesNothing(t, () => removeLanguage(owner, claim))
    ).toEqual(refused("MULTILINGUAL_NOT_ADOPTED"))
  }, 120_000)
})

describe("M05 P19b lifecycle intents: remove", () => {
  test("remove inserts exactly one intent with its language", async () => {
    const site = await previewSite()
    const { t } = site
    const before = await intentsOf(t)
    const previewId = await reviewedRemoval(site)
    expect(await intentsOf(t)).toEqual(before)
    const removed = await removeLanguage(
      site.owner,
      await previewClaim(t, previewId)
    )
    const after = await intentsOf(t)
    expect(after.slice(0, before.length)).toEqual(before)
    expect(after.slice(before.length)).toEqual([
      {
        operationId: `remove:v${removed.version}`,
        operationKind: "remove",
        locales: ["fr"],
        capturedAuthorityVersion: removed.version,
      },
    ])
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("siteLanguageLifecycleIntents")
          .withIndex("by_operationId", (q) =>
            q.eq("operationId", `remove:v${removed.version}`)
          )
          .take(2)
      )
    ).toMatchObject([
      { phase: "tags_and_layout", status: "pending", attempts: 0 },
    ])
  }, 120_000)
})

describe("M05 P2b owner-only remove (command half)", () => {
  test("only the current owner removes, and only from its own preview", async () => {
    const site = await previewSite()
    const { t } = site
    const FORMER = {
      subject: "m05-p2b-remove-former",
      tokenIdentifier: "https://convex.test|m05-p2b-remove-former",
    }
    const CURRENT = {
      subject: "m05-p2b-remove-current",
      tokenIdentifier: "https://convex.test|m05-p2b-remove-current",
    }
    const LEGACY_ADMIN = {
      subject: "m05-p2b-remove-legacy-admin",
      tokenIdentifier: "https://convex.test|m05-p2b-remove-legacy-admin",
    }
    const bindOwner = (identity: typeof CURRENT) =>
      t.run(async (ctx) => {
        const owner = (await ctx.db.query("cmsOwner").unique())!
        await ctx.db.patch(owner._id, {
          authId: identity.subject,
          tokenIdentifier: identity.tokenIdentifier,
        })
      })
    await bindOwner(FORMER)
    const former = t.withIdentity(FORMER)
    const formerPreview = await reviewedRemoval({ t, owner: former })
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("roles", {
        authId: LEGACY_ADMIN.subject,
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("cmsMemberships", {
        authId: LEGACY_ADMIN.subject,
        tokenIdentifier: LEGACY_ADMIN.tokenIdentifier,
        role: "admin",
        status: "active",
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
        transitionId: "m05-p2b-remove",
      })
    })
    await bindOwner(CURRENT)
    const current = t.withIdentity(CURRENT)
    const currentPreview = await reviewedRemoval({ t, owner: current })
    const formerClaim = await previewClaim(t, formerPreview)
    const currentClaim = await previewClaim(t, currentPreview)

    const calls = (caller: RemoveCaller) => ({
      remove: () => removeLanguage(caller, currentClaim),
      removeFromFormer: () => removeLanguage(caller, formerClaim),
    })
    const denied: [string, RemoveCaller, string][] = [
      ["unauthenticated", t, "UNAUTHENTICATED"],
      [
        "unrelated signed-in",
        t.withIdentity({
          subject: "m05-p2b-remove-stranger",
          tokenIdentifier: "https://convex.test|m05-p2b-remove-stranger",
        }),
        "CMS_OWNER_REQUIRED",
      ],
      [
        "role-only legacy Admin",
        t.withIdentity(LEGACY_ADMIN),
        "CMS_OWNER_REQUIRED",
      ],
      ["replaced former owner", former, "CMS_OWNER_REQUIRED"],
    ]
    for (const [identity, caller, code] of denied) {
      for (const [name, call] of Object.entries(calls(caller))) {
        expect({
          identity,
          name,
          result: await refusalWritesNothing(t, call),
        }).toEqual({ identity, name, result: refused(code) })
      }
    }

    // The current owner passes the owner gate, but a removal naming another
    // identity's preview refuses.
    const ownerCalls = calls(current)
    expect(await refusalWritesNothing(t, ownerCalls.removeFromFormer)).toEqual(
      MISMATCH
    )
    expect(await ownerCalls.remove()).toMatchObject({ locale: "fr" })
    expect((await previewRow(t, currentPreview)).phase).toBe("consumed")
    expect((await previewRow(t, formerPreview)).phase).toBe("complete")
  }, 120_000)
})

describe("M05 P11b bounded remove commits (command half)", () => {
  test("remove costs the same on a 1,000-page, 15-locale site as on a tiny one", async () => {
    const removeMetrics = async (pageCount: number) => {
      const site = await measuredPreviewSite(pageCount)
      const previewId = await reviewedRemoval(site, "fr")
      const claim = await previewClaim(site.t, previewId)
      const { locale, used } = await site.t
        .withIdentity(OWNER)
        .run(async (ctx) => {
          const owner = await requireInstallationOwner(ctx)
          const result = await removeLanguageInTransaction(ctx, owner, claim)
          return { locale: result.locale, used: await usedMetrics(ctx) }
        })
      expect(locale).toBe("fr")
      return { used, pages: (await previewRow(site.t, previewId)).pageCount }
    }
    const counts = ({
      databaseQueries,
      documentsRead,
      documentsWritten,
      functionsScheduled,
    }: Used) => ({
      databaseQueries,
      documentsRead,
      documentsWritten,
      functionsScheduled,
    })

    const small = await removeMetrics(0)
    const large = await removeMetrics(1_000)
    expect(large.pages).toBeGreaterThan(small.pages)
    expect(counts(large.used)).toEqual(counts(small.used))
    // Authority, settings, the consumed preview and the intent.
    expect(small.used.documentsWritten).toBe(4)
    for (const { used } of [small, large]) {
      expect(used.functionsScheduled).toBe(0)
      expect(used.databaseQueries).toBeLessThanOrEqual(20)
      expect(used.documentsRead).toBeLessThanOrEqual(20)
      expect(used.bytesRead).toBeLessThanOrEqual(4 * MIB)
      expect(used.bytesWritten).toBeLessThanOrEqual(1 * MIB)
    }
  }, 600_000)
})

describe("M05 P12a remove commit races (command half)", () => {
  test.each(Object.entries(RACE_WRITERS))(
    "%s in both serial orders against a reviewed removal",
    async (_name, writer) => {
      const site = await previewSite()
      const { t } = site
      let run = 0
      const prepare = () => writer.prepare?.(site, run)
      const write = (prepared: unknown) => writer.write(site, prepared, run++)

      // Preview and full review, then the writer, then the commit.
      let prepared = await prepare()
      const reviewed = await reviewedRemoval(site)
      const claim = await previewClaim(t, reviewed)
      await write(prepared)
      if (writer.stales) {
        expect(
          await refusalWritesNothing(t, () => removeLanguage(site.owner, claim))
        ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
        expect((await previewRow(t, reviewed)).phase).toBe("complete")
      } else {
        expect(await removeLanguage(site.owner, claim)).toMatchObject({
          locale: "fr",
        })
        // `fr` keeps its published Page, so only a reviewed reveal restores it.
        const reveal = await reviewedReveal(site, "fr")
        expect(
          await addLanguage(site, "fr", await previewClaim(t, reveal))
        ).toMatchObject({ operationKind: "reveal" })
      }

      // The writer, then a preview, its full review and the commit.
      prepared = await prepare()
      await write(prepared)
      const fresh = await reviewedRemoval(site)
      const committed = await removeLanguage(
        site.owner,
        await previewClaim(t, fresh)
      )
      expect(committed.locale).toBe("fr")
      expect(committed.enabledLocales).not.toContain("fr")
      expect((await previewRow(t, fresh)).phase).toBe("consumed")
    },
    120_000
  )
})

describe("M05 C2b.2b hideLocale parity", () => {
  test("a committed removal and hideLocale leave identical rows outside the preview and intent tables", async () => {
    const PREVIEW_AND_INTENT_TABLES = [
      "siteLanguageImpactPreviews",
      "siteLanguageDisclosurePages",
      "siteLanguageLifecycleIntents",
    ]
    const outside = async (t: T) => {
      const rows = await everyRow(t)
      for (const table of PREVIEW_AND_INTENT_TABLES) delete rows[table]
      return normalizeIds(rows)
    }
    vi.setSystemTime(FIXED_NOW)
    const removed = await previewSite()
    vi.setSystemTime(FIXED_NOW)
    const hidden = await previewSite()
    expect(await outside(removed.t)).toEqual(await outside(hidden.t))
    const previewId = await reviewedRemoval(removed, "fr")
    const claim = await previewClaim(removed.t, previewId)
    // A later clock, so an `updatedAt` either path fails to write shows.
    vi.setSystemTime(FIXED_NOW + 60_000)
    await removeLanguage(removed.owner, claim)
    await hideLocale(hidden.t, "fr")
    expect(await outside(removed.t)).toEqual(await outside(hidden.t))
  }, 120_000)
})

// ─── C2b.2c disable preservation and delayed work ──────────────────────────
//
// Contract Module enable and disable, Return to one language and Delayed
// work; P8 and the command half of P15a. The disable blockers are C1's, and
// `modules.commit` re-reads them. P8 proves retention through the exact write
// sets of return and disable (C2b.2c), and C3a stores a real
// `continuityPointer` and follows it across the whole trip (ledger C2b.2c
// Deferral).

/** Tables a removal, return, toggle, preview or reveal may write (M9). */
const M05_CONTROL_TABLES = [
  "cmsModuleState",
  "siteLanguageAuthority",
  "siteLanguageDisclosurePages",
  "siteLanguageImpactPreviews",
  "siteLanguageLifecycleIntents",
  "siteSettings",
]

async function rowsOutsideControlTables(t: T) {
  const rows = await everyRow(t)
  for (const table of M05_CONTROL_TABLES) delete rows[table]
  return rows
}

async function authorityRow(t: T) {
  return t.run(
    async (ctx) => (await ctx.db.query("siteLanguageAuthority").unique())!
  )
}

async function settingsRow(t: T) {
  return t.run(async (ctx) => (await ctx.db.query("siteSettings").unique())!)
}

const RETURN_AUTHORITY_PATCH =
  "patch siteLanguageAuthority {enabledLocales,mode,updatedAt,version}"
const MODULE_STATE_PATCH =
  "patch cmsModuleState {configurationVersion,enabledModules}"
const DISABLE_MULTILINGUAL = [{ moduleId: "multilingual", enabled: false }]

function previewDisable(site: Pick<Site, "owner">) {
  return site.owner.query(api.cms.modules.preview, {
    changes: DISABLE_MULTILINGUAL,
  })
}

function commitDisable(
  site: Pick<Site, "owner">,
  expectedConfigurationVersion: number,
  multilingualCommandTokens?: Tokens | null
) {
  return site.owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion,
    multilingualCommandTokens,
    changes: DISABLE_MULTILINGUAL,
  })
}

describe("M05 P8 disable and re-enable", () => {
  test.each(["S0", "S1", "S2"] as const)(
    "disable from S3(%s) returns to its origin and writes only module state and one intent",
    async (origin) => {
      const site = await buildSite(origin, "absent")
      await toggleMultilingual(site, true)
      expect(await lifecycleOf(site)).toBe(`S3(${origin})`)
      const before = await everyRow(site.t)
      const { result, sets } = await recordSyscalls(() =>
        toggleMultilingual(site, false)
      )
      expect(result).toMatchObject({ committed: true })
      expect(sets.writes).toEqual([INTENT_INSERT, MODULE_STATE_PATCH])
      expect(await lifecycleOf(site)).toBe(origin)
      const after = await everyRow(site.t)
      for (const table of ["cmsModuleState", "siteLanguageLifecycleIntents"]) {
        delete before[table]
        delete after[table]
      }
      expect(after).toEqual(before)
    },
    60_000
  )

  test("an authority adopted after preview makes its token stale before Apply", async () => {
    const site = await buildSite("S1", "absent")
    await toggleMultilingual(site, true)
    const preview = await previewDisable(site)
    expect(preview.blockers).toEqual([])
    await adopt(site)
    expect(
      await refusalWritesNothing(site.t, () =>
        commitDisable(
          site,
          preview.configurationVersion,
          preview.multilingualCommandTokens
        )
      )
    ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
    expect((await previewDisable(site)).blockers).toEqual([])
  }, 60_000)

  test.each(["open", "cancelling"] as const)(
    "an F09 transition (%s) named after the preview blocks the disable commit",
    async (phase) => {
      const site = await buildSite("S1", "absent")
      const transitionId = await site.owner.mutation(
        api.cms.language.startLanguageTransition,
        {
          mode: "correct_label",
          sourceLocale: "en",
          targetLocale: "nl",
          expectedSettingsUpdatedAt: (await settingsRow(site.t)).updatedAt,
          expectedAuthorityVersion: 1,
        }
      )
      if (phase === "cancelling") {
        await site.t.run((ctx) =>
          ctx.db.patch(transitionId, { phase: "cancelling" })
        )
      }
      // M6 keeps an open F09 transition and the enabled module apart, so the
      // state is constructed: the authority stops naming the transition, the
      // module is enabled, and the authority names it again after the preview.
      const nameTransition = (
        activeTransitionId: Id<"siteLanguageTransitions"> | undefined
      ) =>
        site.t.run(async (ctx) => {
          const row = (await ctx.db.query("siteLanguageAuthority").unique())!
          await ctx.db.patch(row._id, { activeTransitionId })
        })
      await nameTransition(undefined)
      await enableMultilingualModule(site.t)
      const preview = await previewDisable(site)
      expect(preview.blockers).toEqual([])
      await nameTransition(transitionId)
      expect(
        await refusalWritesNothing(site.t, () =>
          commitDisable(
            site,
            preview.configurationVersion,
            preview.multilingualCommandTokens
          )
        )
      ).toEqual(refused("CMS_MODULE_TRANSITION_BLOCKED"))
      expect((await previewDisable(site)).blockers).toEqual([
        {
          code: "LANGUAGE_OPERATION_OPEN",
          moduleId: "multilingual",
          kind: "language_transition",
        },
      ])
    },
    60_000
  )

  test("invalid language state after the preview refuses the disable commit with the integrity code", async () => {
    const site = await buildSite("S1", "absent")
    await toggleMultilingual(site, true)
    const preview = await previewDisable(site)
    expect(preview.blockers).toEqual([])
    await site.t.run(async (ctx) => {
      const { _id, _creationTime, ...row } = (await ctx.db
        .query("siteLanguageAuthority")
        .unique())!
      void _id
      void _creationTime
      await ctx.db.insert("siteLanguageAuthority", row)
    })
    expect(
      await refusalWritesNothing(site.t, () =>
        commitDisable(
          site,
          preview.configurationVersion,
          preview.multilingualCommandTokens
        )
      )
    ).toEqual(INVALID)
    expect((await previewDisable(site)).blockers).toEqual([
      { code: "LANGUAGE_STATE_INVALID", moduleId: "multilingual" },
    ])
  }, 60_000)

  test("after a real removal and return, disable keeps the authority, its continuity pointer and every M9 row, and a reviewed reveal brings the translation back without republishing", async () => {
    const site = await previewSite()
    const { t } = site
    const indexedBefore = await localeState(t, site.frPageId, "fr")
    expect(indexedBefore.pageType).toBeDefined()
    expect(indexedBefore.publicSince).toBe(indexedBefore.currentPublishedAt)
    const recent = async () =>
      t.query(api.cms.pages.listRecentPublicRelationCards, {
        languageVersion: await authorityVersion(t),
        pageType: indexedBefore.pageType!,
        locale: "fr",
        limit: 12,
      })
    const cardsBefore = await recent()
    expect(cardsBefore).toContainEqual(
      expect.objectContaining({ pageId: site.frPageId })
    )
    const frPath = (await localeState(t, site.frPageId, "fr")).currentPath!
    const frPublic = await publicRead(t, "fr", frPath)
    expect(frPublic).toMatchObject({ id: site.frPageId })
    const enPublic = await publicRead(t, "en", "about")
    expect(enPublic).toMatchObject({ id: site.aboutId })
    // A committed `nl → en` generation with its rows, pointed at by the
    // authority (C3a; no C3a command activates a migration).
    const pointer = await storeContinuityPointer(site)
    const pointed = async () =>
      expect((await authorityRow(t)).continuityPointer).toEqual(pointer)
    const outside = await rowsOutsideControlTables(t)
    expect(outside.siteDefaultLanguageMigrations).toHaveLength(1)
    expect(outside.siteDefaultLanguageRoutes).toHaveLength(2)

    await removeLocale(site, "fr")
    expect(await recent()).toEqual([])
    expect(await localeState(t, site.frPageId, "fr")).toEqual(indexedBefore)
    await pointed()
    expect(await publicRead(t, "fr", frPath)).toEqual(NOT_FOUND)
    expect(
      await refusalWritesNothing(t, () => rawToggleMultilingual(site, false))
    ).toEqual(refused("CMS_MODULE_TRANSITION_BLOCKED"))

    // Return: one authority patch naming four fields, so every other field,
    // `continuityPointer` included, survives (ledger C2b.2c).
    const beforeReturn = await authorityRow(t)
    const returned = await recordSyscalls(() =>
      site.owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
        expectedAuthorityVersion: beforeReturn.version,
      })
    )
    expect(returned.result).toEqual({
      version: beforeReturn.version + 1,
      locale: "en",
    })
    expect(returned.sets.writes).toEqual([
      INTENT_INSERT,
      RETURN_AUTHORITY_PATCH,
    ])
    const afterReturn = await authorityRow(t)
    expect(Object.keys(afterReturn).sort()).toEqual(
      Object.keys(beforeReturn)
        .filter((key) => key !== "enabledLocales")
        .sort()
    )
    expect(afterReturn).toMatchObject({
      _id: beforeReturn._id,
      currentLocale: "en",
      mode: "single",
      continuityPointer: pointer,
    })
    expect(await lifecycleOf(site)).toBe("S3(S1)")

    // Disable: module state and one intent; no authority, settings or M9 row.
    const settings = await settingsRow(t)
    const disabled = await recordSyscalls(() => toggleMultilingual(site, false))
    expect(disabled.result).toMatchObject({ committed: true })
    expect(disabled.sets.writes).toEqual([INTENT_INSERT, MODULE_STATE_PATCH])
    expect(await localeState(t, site.frPageId, "fr")).toEqual(indexedBefore)
    expect(await recent()).toEqual([])
    expect(await authorityRow(t)).toEqual(afterReturn)
    await pointed()
    expect(await settingsRow(t)).toEqual(settings)
    expect(await lifecycleOf(site)).toBe("S1")
    expect(await rowsOutsideControlTables(t)).toEqual(outside)
    expect(await publicRead(t, "fr", frPath)).toEqual(NOT_FOUND)
    expect(await publicRead(t, "en", "about")).toEqual(enPublic)

    // Re-enable and re-adopt restore one language; `fr` returns only through
    // a reviewed reveal, and its retained snapshot answers again.
    await toggleMultilingual(site, true)
    expect(await lifecycleOf(site)).toBe("S3(S1)")
    await pointed()
    expect(await adopt(site)).toMatchObject({ enabledLocales: ["en"] })
    await pointed()
    expect(
      await refusalWritesNothing(t, () => addLanguage(site, "fr"))
    ).toEqual(refused("LANGUAGE_PREVIEW_REQUIRED"))
    const revealId = await reviewedReveal(site, "fr")
    expect(
      await addLanguage(site, "fr", await previewClaim(t, revealId))
    ).toMatchObject({ operationKind: "reveal", enabledLocales: ["en", "fr"] })
    await pointed()
    expect(await recent()).toEqual(cardsBefore)
    expect(await localeState(t, site.frPageId, "fr")).toEqual(indexedBefore)
    expect(await publicRead(t, "fr", frPath)).toEqual(frPublic)
    expect(await rowsOutsideControlTables(t)).toEqual(outside)
    expect((await intentsOf(t)).map((intent) => intent.operationId)).toEqual([
      "remove:v3",
      "return_to_single:v4",
      "module_toggle:c2",
      "module_toggle:c3",
      "adopt:v5",
      "reveal:v6",
    ])
  }, 240_000)
})

const ELIGIBLE = ok(null)
const HELD_NOT_ENABLED = ok("LOCALE_NOT_ENABLED")
const HELD_VERSION_CHANGED = ok("LANGUAGE_VERSION_CHANGED")

/** The helper's verdict in its own transaction; it must write nothing. */
async function releaseEligibility(t: T, row: ReleaseExecutionRow) {
  const { result, sets } = await recordSyscalls(() =>
    t.run((ctx) => outcome(() => assertReleaseExecutionEligible(ctx, row)))
  )
  expect(sets.writes).toEqual([])
  return {
    verdict: result,
    readsModuleState: sets.reads.includes(MODULE_STATE_READ),
  }
}

async function verdict(t: T, locale: string, capturedLanguageVersion?: number) {
  return (
    await releaseEligibility(t, {
      locale,
      ...(capturedLanguageVersion === undefined
        ? {}
        : { capturedLanguageVersion }),
    })
  ).verdict
}

async function languageKind(t: T) {
  return t.run(async (ctx) => (await readSiteLanguageState(ctx)).kind)
}

describe("M05 P15a delayed releases (command half)", () => {
  test("under a multilingual authority a release is eligible exactly while its language is enabled", async () => {
    const site = await previewSite()
    const { t } = site
    const v = await authorityVersion(t)
    expect(await verdict(t, "fr", v)).toEqual(ELIGIBLE)
    expect(await verdict(t, "en", v)).toEqual(ELIGIBLE)
    expect(await verdict(t, "fr")).toEqual(ELIGIBLE)
    expect(await verdict(t, "nl", v)).toEqual(HELD_NOT_ENABLED)

    // Version changed by an unrelated add: ignored.
    await addLanguage(site, "nl")
    expect(await authorityVersion(t)).toBe(v + 1)
    expect(await verdict(t, "fr", v)).toEqual(ELIGIBLE)
    expect(await verdict(t, "nl", v)).toEqual(ELIGIBLE)

    // Removed: held; another language's removal leaves the rest eligible.
    await removeLocale(site, "fr")
    expect(await verdict(t, "fr", v)).toEqual(HELD_NOT_ENABLED)
    expect(await verdict(t, "fr", v + 2)).toEqual(HELD_NOT_ENABLED)
    expect(await verdict(t, "en", v)).toEqual(ELIGIBLE)
    expect(await verdict(t, "nl", v + 1)).toEqual(ELIGIBLE)

    // Default changed (built in place; default migration is C3): ignored.
    await patchAuthorityInPlace(t, { currentLocale: "nl" })
    expect(await languageKind(t)).toBe("multilingual")
    expect(await verdict(t, "en", v)).toEqual(ELIGIBLE)
    expect(await verdict(t, "nl", v)).toEqual(ELIGIBLE)
    expect(await verdict(t, "fr", v)).toEqual(HELD_NOT_ENABLED)
  }, 240_000)

  test("under a single authority a release is eligible only in the current language at its captured version", async () => {
    const site = await previewSite()
    const { t } = site
    await removeLocale(site, "fr")
    const v = await authorityVersion(t)
    await site.owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
      expectedAuthorityVersion: v,
    })
    const current = v + 1
    expect(await languageKind(t)).toBe("current")
    for (const moduleEnabled of [true, false]) {
      if (!moduleEnabled) await toggleMultilingual(site, false)
      expect(await lifecycleOf(site)).toBe(moduleEnabled ? "S3(S1)" : "S1")
      const enabled = await releaseEligibility(t, {
        locale: "en",
        capturedLanguageVersion: current,
      })
      expect(enabled).toEqual({ verdict: ELIGIBLE, readsModuleState: false })
      // Removed, also when the version changed: the language is reported.
      expect(await verdict(t, "fr", current)).toEqual(HELD_NOT_ENABLED)
      expect(await verdict(t, "fr", v)).toEqual(HELD_NOT_ENABLED)
      // Version changed: armed before the return, or never captured (M07).
      expect(await verdict(t, "en", v)).toEqual(HELD_VERSION_CHANGED)
      expect(await verdict(t, "en")).toEqual(HELD_VERSION_CHANGED)
    }

    // Default changed as an F09 activation writes it (built in place).
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(settings._id, {
        defaultLocale: "nl",
        enabledLocales: ["nl"],
      })
      await ctx.db.patch(authority._id, {
        currentLocale: "nl",
        version: current + 1,
      })
    })
    expect(await languageKind(t)).toBe("current")
    expect(await verdict(t, "en", current + 1)).toEqual(HELD_NOT_ENABLED)
    expect(await verdict(t, "nl", current)).toEqual(HELD_VERSION_CHANGED)
    expect(await verdict(t, "nl", current + 1)).toEqual(ELIGIBLE)
  }, 240_000)

  test("a pending release built in a removed language is held in every later state and changes no visibility", async () => {
    const site = await previewSite()
    const { t } = site
    const frPath = (await localeState(t, site.frPageId, "fr")).currentPath!
    await removeLocale(site, "fr")
    // Removal refuses an obligation in its language (P5), so it is built
    // after the removal, directly, as no writer creates one before M07.
    const releaseId = await seedRelease(site, "fr", "pending")
    const release = (await t.run((ctx) => ctx.db.get(releaseId)))!
    const row = {
      locale: release.locale,
      capturedLanguageVersion: await authorityVersion(t),
    }
    const outside = await rowsOutsideControlTables(t)
    const held = async (lifecycle: string) => {
      expect(await lifecycleOf(site)).toBe(lifecycle)
      expect((await releaseEligibility(t, row)).verdict).toEqual(
        HELD_NOT_ENABLED
      )
      expect(await t.run((ctx) => ctx.db.get(releaseId))).toEqual(release)
      expect(await outcome(() => publicRead(t, "fr", frPath))).toEqual(
        ok(NOT_FOUND)
      )
      expect(await rowsOutsideControlTables(t)).toEqual(outside)
    }
    await held("S4")
    await site.owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
      expectedAuthorityVersion: row.capturedLanguageVersion,
    })
    await held("S3(S1)")
    await toggleMultilingual(site, false)
    await held("S1")
  }, 240_000)
})

// ─── M05 C3a: migration schema, open-migration refusals, stored pointer ─────
// C3a declares the migration tables and the authority's
// `activeDefaultMigrationId` and `continuityPointer`. No C3a command starts or
// activates a migration (C3b, C3c), so every row below is constructed as those
// commands will write it (ledger C3a Limit).

type MigrationId = Id<"siteDefaultLanguageMigrations">
type MigrationPhase = Doc<"siteDefaultLanguageMigrations">["phase"]

const OPEN_MIGRATION_PHASES = ["enumerating", "validating", "ready"] as const
const OPERATION_OPEN = refused("LANGUAGE_OPERATION_OPEN")
const SNAPSHOT_AUTHORITY_REQUIRED = refused(
  "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY"
)
const NO_FRESHNESS = { routeClaimVersion: 0, publicationSetVersion: 0 }
const NO_MIGRATION_COUNTS = {
  rows: 0,
  shadowedByCurrent: 0,
  shadowedByHistorical: 0,
  manualRulesShadowed: 0,
  manualRulesShifted: 0,
  manualRulesUnprefixed: 0,
  carriedShadowedSkipped: 0,
  blockers: 0,
}

async function seedDefaultMigration(
  t: T,
  fields: { fromLocale: string; toLocale: string; phase: MigrationPhase }
): Promise<MigrationId> {
  return t.run(async (ctx) => {
    const owner = (await ctx.db.query("cmsOwner").unique())!
    const authority = await ctx.db.query("siteLanguageAuthority").unique()
    const moduleState = await ctx.db.query("cmsModuleState").unique()
    const now = Date.now()
    return ctx.db.insert("siteDefaultLanguageMigrations", {
      ...fields,
      generation: 1,
      captured: {
        authorityVersion: authority?.version ?? 0,
        moduleConfigurationVersion: moduleState?.configurationVersion ?? 0,
        site: NO_FRESHNESS,
        from: NO_FRESHNESS,
        to: NO_FRESHNESS,
      },
      counts: NO_MIGRATION_COUNTS,
      disclosurePageCount: 0,
      reviewedThroughOrdinal: -1,
      ...(fields.phase === "committed"
        ? { committedAt: now, committedAuthorityVersion: authority?.version }
        : {}),
      ...(fields.phase === "cancelled" ? { cancelledAt: now } : {}),
      attribution: {
        kind: "owner",
        ownerId: owner._id,
        authId: owner.authId,
        tokenIdentifier: owner.tokenIdentifier,
      },
      createdAt: now,
      updatedAt: now,
    })
  })
}

/** Names (or clears) the open migration in place; no token moves. */
async function nameDefaultMigration(
  t: T,
  migrationId: MigrationId | undefined
) {
  await t.run(async (ctx) => {
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(authority._id, { activeDefaultMigrationId: migrationId })
  })
}

/**
 * A committed `nl → en` generation as activation leaves it: one served row
 * for the About Page and one row shadowed at capture, with the authority
 * pointing at generation 1. Returns the stored pointer.
 */
async function storeContinuityPointer(site: Pick<Site, "t" | "aboutId">) {
  const { t } = site
  const migrationId = await seedDefaultMigration(t, {
    fromLocale: "nl",
    toLocale: "en",
    phase: "committed",
  })
  const pointer = { migrationId, generation: 1 }
  await t.run(async (ctx) => {
    const now = Date.now()
    const row = {
      migrationId,
      generation: 1,
      pageId: site.aboutId,
      locale: "nl",
      origin: "old_default_current" as const,
      createdAt: now,
    }
    await ctx.db.insert("siteDefaultLanguageRoutes", {
      ...row,
      fromPath: "/uber-uns",
    })
    await ctx.db.insert("siteDefaultLanguageRoutes", {
      ...row,
      fromPath: "/about",
      shadow: "to_current",
    })
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(authority._id, { continuityPointer: pointer })
  })
  return pointer
}

function returnToSingle(site: Pick<Site, "t" | "owner">) {
  return authorityVersion(site.t).then((expectedAuthorityVersion) =>
    site.owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
      expectedAuthorityVersion,
    })
  )
}

async function adoptWithLiveTokens(site: Pick<Site, "t" | "owner">) {
  const authority = await site.t.run((ctx) =>
    ctx.db.query("siteLanguageAuthority").unique()
  )
  return site.owner.mutation(api.cms.multilingual.adoptMultilingualAuthority, {
    expectedSettingsUpdatedAt: (await settingsRow(site.t)).updatedAt,
    expectedModuleConfigurationVersion: await moduleConfigurationVersion(
      site.t
    ),
    expectedAuthorityVersion: authority?.version ?? null,
  })
}

function setCutover(t: T, phase: "preparing" | "snapshot_active") {
  return t.run(async (ctx) => {
    const row = (await ctx.db.query("pagePublicationCutover").unique())!
    await ctx.db.patch(row._id, { phase })
  })
}

describe("M05 C3a default-migration authority", () => {
  test("the classifier accepts an open migration only on a multilingual row, and a continuity pointer in every mode", async () => {
    const kindWith = async (
      state: "ML" | "CUR",
      fields: (migrationId: MigrationId) => Record<string, unknown>
    ) => {
      const site = await inventorySite(state)
      const migrationId = await seedDefaultMigration(site.t, {
        fromLocale: "en",
        toLocale: "nl",
        phase: "enumerating",
      })
      await site.t.run(async (ctx) => {
        const row = (await ctx.db.query("siteLanguageAuthority").unique())!
        await ctx.db.patch(row._id, fields(migrationId))
      })
      return recordSyscalls(() => languageKind(site.t))
    }
    const open = (migrationId: MigrationId) => ({
      activeDefaultMigrationId: migrationId,
    })
    const pointed = (migrationId: MigrationId) => ({
      continuityPointer: { migrationId, generation: 1 },
    })

    expect((await kindWith("ML", open)).result).toBe("multilingual")
    expect((await kindWith("ML", pointed)).result).toBe("multilingual")
    expect((await kindWith("CUR", open)).result).toBe("invalid")
    expect(
      (await kindWith("CUR", (id) => ({ mode: "single", ...open(id) }))).result
    ).toBe("invalid")
    // M2: a pointer on a single row changes neither the kind nor the reads.
    const plain = await kindWith("CUR", () => ({}))
    const withPointer = await kindWith("CUR", pointed)
    const singleWithPointer = await kindWith("CUR", (id) => ({
      mode: "single",
      ...pointed(id),
    }))
    expect(plain.result).toBe("current")
    expect(withPointer.result).toBe("current")
    expect(singleWithPointer.result).toBe("current")
    expect(withPointer.sets.reads).toEqual(plain.sets.reads)
    expect(singleWithPointer.sets.reads).toEqual(plain.sets.reads)
  }, 60_000)

  test("an open default migration refuses add, remove, return and preview start, lists its disable blocker, and writes nothing", async () => {
    const site = await previewSite()
    const { t, owner } = site
    const claim = await previewClaim(t, await reviewedRemoval(site))
    const migrationId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "enumerating",
    })
    await nameDefaultMigration(t, migrationId)
    for (const phase of OPEN_MIGRATION_PHASES) {
      await t.run((ctx) => ctx.db.patch(migrationId, { phase }))
      expect(
        await refusalWritesNothing(t, () => addLanguage(site, "nl"))
      ).toEqual(OPERATION_OPEN)
      expect(
        await refusalWritesNothing(t, () => removeLanguage(owner, claim))
      ).toEqual(OPERATION_OPEN)
      // Ahead of the version and one-language checks (M6 before tokens).
      expect(await refusalWritesNothing(t, () => returnToSingle(site))).toEqual(
        OPERATION_OPEN
      )
      expect(
        await refusalWritesNothing(t, () => startPreview(site, "reveal", "nl"))
      ).toEqual(OPERATION_OPEN)
      expect(
        await refusalWritesNothing(t, () => adoptWithLiveTokens(site))
      ).toEqual(refused("MULTILINGUAL_ALREADY_ADOPTED"))
      expect((await previewDisable(site)).blockers).toEqual([
        {
          code: "MULTILINGUAL_AUTHORITY_ACTIVE",
          moduleId: "multilingual",
          locales: ["en", "fr"],
        },
        {
          code: "LANGUAGE_OPERATION_OPEN",
          moduleId: "multilingual",
          kind: "default_migration",
        },
      ])
      expect(
        await refusalWritesNothing(t, () => toggleMultilingual(site, false))
      ).toEqual(refused("CMS_MODULE_TRANSITION_BLOCKED"))
      expect(await lifecycleOf(site)).toBe("S4")
    }

    // Cancelled: the pointer is cleared, and the same reviewed removal commits.
    await t.run((ctx) =>
      ctx.db.patch(migrationId, { phase: "cancelled", cancelledAt: Date.now() })
    )
    await nameDefaultMigration(t, undefined)
    expect((await previewDisable(site)).blockers).toEqual([
      {
        code: "MULTILINGUAL_AUTHORITY_ACTIVE",
        moduleId: "multilingual",
        locales: ["en", "fr"],
      },
    ])
    expect(await removeLanguage(owner, claim)).toMatchObject({ locale: "fr" })
  }, 240_000)

  test("an authority naming a missing, closed or foreign migration is invalid state for every gated command", async () => {
    const site = await inventorySite("ML")
    const { t } = site
    const variants: Array<[string, () => Promise<MigrationId>]> = [
      [
        "committed",
        () =>
          seedDefaultMigration(t, {
            fromLocale: "en",
            toLocale: "fr",
            phase: "committed",
          }),
      ],
      [
        "cancelled",
        () =>
          seedDefaultMigration(t, {
            fromLocale: "en",
            toLocale: "fr",
            phase: "cancelled",
          }),
      ],
      [
        "from another language",
        () =>
          seedDefaultMigration(t, {
            fromLocale: "fr",
            toLocale: "nl",
            phase: "enumerating",
          }),
      ],
      [
        "missing",
        async () => {
          const id = await seedDefaultMigration(t, {
            fromLocale: "en",
            toLocale: "fr",
            phase: "enumerating",
          })
          await t.run((ctx) => ctx.db.delete(id))
          return id
        },
      ],
    ]
    for (const [variant, seed] of variants) {
      await nameDefaultMigration(t, await seed())
      const refusals = {
        variant,
        add: await refusalWritesNothing(t, () => addLanguage(site, "nl")),
        return: await refusalWritesNothing(t, () => returnToSingle(site)),
        start: await refusalWritesNothing(t, () =>
          startPreview(site, "reveal", "nl")
        ),
        disablePreview: await outcome(() => previewDisable(site)),
      }
      expect(refusals).toEqual({
        variant,
        add: INVALID,
        return: INVALID,
        start: INVALID,
        disablePreview: INVALID,
      })
      await nameDefaultMigration(t, undefined)
    }
    expect(await addLanguage(site, "nl")).toMatchObject({
      operationKind: "add",
    })
  }, 120_000)

  test("a single authority naming a default migration is invalid, so adoption and F09 start and activation refuse it", async () => {
    // F09 with the module off: an open transition, then the migration named.
    const s1 = await buildSite("S1", "absent")
    const settings = await settingsRow(s1.t)
    const transitionArgs = {
      mode: "correct_label" as const,
      sourceLocale: "en",
      targetLocale: "nl",
      expectedSettingsUpdatedAt: settings.updatedAt,
      expectedAuthorityVersion: 1,
    }
    const transitionId = await s1.owner.mutation(
      api.cms.language.startLanguageTransition,
      transitionArgs
    )
    const f09Migration = await seedDefaultMigration(s1.t, {
      fromLocale: "en",
      toLocale: "nl",
      phase: "enumerating",
    })
    await nameDefaultMigration(s1.t, f09Migration)
    expect(await languageKind(s1.t)).toBe("invalid")
    expect(
      await refusalWritesNothing(s1.t, () =>
        s1.owner.mutation(api.cms.language.activateLanguageTransition, {
          transitionId,
          expectedGeneration: 1,
          expectedAuthorityVersion: 1,
          expectedSettingsUpdatedAt: settings.updatedAt,
          expectedReadinessVersion: 1,
        })
      )
    ).toEqual(INVALID)
    await s1.t.run(async (ctx) => {
      const row = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(row._id, { activeTransitionId: undefined })
    })
    expect(
      await refusalWritesNothing(s1.t, () =>
        s1.owner.mutation(
          api.cms.language.startLanguageTransition,
          transitionArgs
        )
      )
    ).toEqual(INVALID)

    // S3(S1) naming a migration: IX, and adoption refuses.
    const s3 = await buildSite("S1", "absent")
    await toggleMultilingual(s3, true)
    const s3Migration = await seedDefaultMigration(s3.t, {
      fromLocale: "en",
      toLocale: "nl",
      phase: "enumerating",
    })
    await nameDefaultMigration(s3.t, s3Migration)
    expect(await lifecycleOf(s3)).toBe("IX")
    expect(
      await refusalWritesNothing(s3.t, () => adoptWithLiveTokens(s3))
    ).toEqual(INVALID)
    await nameDefaultMigration(s3.t, undefined)
    expect(await lifecycleOf(s3)).toBe("S3(S1)")
    expect(await adoptWithLiveTokens(s3)).toMatchObject({
      enabledLocales: ["en"],
    })
  }, 120_000)

  test("preview start requires snapshot authority before any other check", async () => {
    const site = await inventorySite("ML")
    const { t } = site
    await setCutover(t, "preparing")
    for (const [kind, locale] of [
      ["remove", "fr"],
      ["reveal", "nl"],
      ["reveal", "xx"],
      ["remove", "en"],
    ] as const) {
      expect(
        await refusalWritesNothing(t, () => startPreview(site, kind, locale))
      ).toEqual(SNAPSHOT_AUTHORITY_REQUIRED)
    }
    await setCutover(t, "snapshot_active")
    expect(await outcome(() => startPreview(site, "remove", "fr"))).toEqual({
      ok: expect.anything(),
    })

    // Not adopted (S3(S1)): M4 still answers first.
    const s3 = await buildSite("S1", "absent")
    await toggleMultilingual(s3, true)
    await setCutover(s3.t, "preparing")
    expect(
      await refusalWritesNothing(s3.t, () => startPreview(s3, "remove", "fr"))
    ).toEqual(SNAPSHOT_AUTHORITY_REQUIRED)
    await setCutover(s3.t, "snapshot_active")
    expect(await outcome(() => startPreview(s3, "remove", "fr"))).toEqual(
      refused("MULTILINGUAL_NOT_ADOPTED")
    )
  }, 60_000)
})

// ─── M05 C3b default migration: enumeration ────────────────────────────────
//
// Contract Default migration steps 1–3, `siteDefaultLanguageMigrations`,
// `siteDefaultLanguageRoutes`, M13, M14, M16, M23 and ledger C3b. Validation,
// activation, cancel, collection and the resolver are C3c and C3d, so P6, P16,
// P11c, P12b, P15b and P2c are proven here for their enumeration half only.

type MigrationSite = PreviewSite & {
  homeEnId: Id<"pages">
  homeFrId: Id<"pages">
}

/**
 * `previewSite` (S4 `en` default, `fr` enabled, Redirects effective) plus a
 * `fr` home selection at `/` named by `homePageId`, so start's home rule holds.
 * Rows are inserted directly, so no captured counter moves.
 */
async function migrationSite(): Promise<MigrationSite> {
  const site = await previewSite()
  const homeEnId = (await site.t.run((ctx) =>
    ctx.db.query("siteSettings").unique()
  ))!.homePageId!
  const [homeFrId] = await seedLocaleStates(site, "fr", ["/"])
  await site.t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").unique())!
    await ctx.db.patch(settings._id, { homePageId: homeFrId })
  })
  return { ...site, homeEnId, homeFrId: homeFrId! }
}

/** `seedSelections` for any locale: one cloned Page per current path. */
async function seedLocaleStates(
  site: PreviewSite,
  locale: string,
  paths: readonly string[]
): Promise<Id<"pages">[]> {
  const pageIds = await seedSelections(site, paths)
  await site.t.run(async (ctx) => {
    for (const pageId of pageIds) {
      const state = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "fr")
        )
        .unique())!
      await ctx.db.patch(state._id, { locale })
    }
  })
  return pageIds
}

async function seedLocaleHistorical(
  site: PreviewSite,
  locale: string,
  routes: readonly { pageId: Id<"pages">; fromPath: string }[]
) {
  await site.t.run(async (ctx) => {
    const state = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", site.frPageId).eq("locale", "fr")
      )
      .unique())!
    for (const route of routes) {
      await ctx.db.insert("pageHistoricalLocaleRoutes", {
        ...route,
        locale,
        createdFromSnapshotId: state.currentSnapshotId!,
        createdAt: FIXED_NOW,
      })
    }
  })
}

type PointedRow = {
  fromPath: string
  pageId: Id<"pages">
  locale: string
  shadow?: "to_current"
  retiredAt?: number
}

/** A committed earlier migration whose generation 1 the authority points at. */
async function storePointedGeneration(
  site: Pick<Site, "t">,
  rows: readonly PointedRow[]
) {
  const migrationId = await seedDefaultMigration(site.t, {
    fromLocale: "nl",
    toLocale: "en",
    phase: "committed",
  })
  await site.t.run(async (ctx) => {
    for (const row of rows) {
      await ctx.db.insert("siteDefaultLanguageRoutes", {
        migrationId,
        generation: 1,
        origin: "old_default_current",
        createdAt: FIXED_NOW,
        ...row,
      })
    }
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(authority._id, {
      continuityPointer: { migrationId, generation: 1 },
    })
  })
  return migrationId
}

async function migrationTokens(t: T) {
  return {
    expectedAuthorityVersion: await authorityVersion(t),
    expectedModuleConfigurationVersion: await moduleConfigurationVersion(t),
  }
}

async function startMigration(
  site: Pick<Site, "t" | "owner">,
  toLocale = "fr",
  caller: Pick<Caller, "mutation"> = site.owner
): Promise<MigrationId> {
  return (
    await caller.mutation(api.cms.multilingual.startDefaultLanguageMigration, {
      toLocale,
      ...(await migrationTokens(site.t)),
    })
  ).migrationId
}

async function migrationRow(t: T, migrationId: MigrationId) {
  return (await t.run((ctx) => ctx.db.get(migrationId)))!
}

async function stepMigration(
  t: T,
  migrationId: MigrationId,
  generation?: number
) {
  await t.mutation(internal.cms.multilingual.stepDefaultLanguageMigration, {
    migrationId,
    generation: generation ?? (await migrationRow(t, migrationId)).generation,
  })
}

/** Drives steps until enumeration ends; records paginated queries per step. */
async function runMigration(t: T, migrationId: MigrationId) {
  const paginate = vi.spyOn(defaultMigrationSeam, "paginate")
  const perStep: number[] = []
  try {
    for (let guard = 0; guard < 500; guard += 1) {
      if ((await migrationRow(t, migrationId)).phase !== "enumerating") break
      const before = paginate.mock.calls.length
      await stepMigration(t, migrationId)
      perStep.push(paginate.mock.calls.length - before)
    }
  } finally {
    paginate.mockRestore()
  }
  return { migration: await migrationRow(t, migrationId), perStep }
}

async function migrationRoutes(
  t: T,
  migrationId: MigrationId,
  generation: number
) {
  return t.run((ctx) =>
    ctx.db
      .query("siteDefaultLanguageRoutes")
      .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
        q.eq("migrationId", migrationId).eq("generation", generation)
      )
      .collect()
  )
}

async function migrationPages(
  t: T,
  migrationId: MigrationId,
  generation: number
) {
  return t.run((ctx) =>
    ctx.db
      .query("siteLanguageDisclosurePages")
      .withIndex("by_migrationId_and_generation_and_ordinal", (q) =>
        q.eq("migrationId", migrationId).eq("generation", generation)
      )
      .collect()
  )
}

function routeView(row: Doc<"siteDefaultLanguageRoutes">) {
  const { _id, _creationTime, migrationId, generation, createdAt, ...rest } =
    row
  void _id
  void _creationTime
  void migrationId
  void generation
  void createdAt
  return rest
}

/**
 * The P16 corpus. `en` current: `/`, `/about`, `/contact`, `/legacy`; `en`
 * history: `/old-about`, `/about` (the same Page, again) and `/moved`; `fr`
 * claims `/`, `/bonjour` and `/contact` currently and `/legacy` historically;
 * a pointed earlier generation with served, shadowed, retired and colliding
 * rows; manual rules in both scopes; and menus with and without `fr` text.
 */
async function enumerationCorpus() {
  const site = await migrationSite()
  const { t, aboutId, frPageId } = site
  const [contactEnId, legacyEnId] = await seedLocaleStates(site, "en", [
    "/contact",
    "/legacy",
  ])
  await seedLocaleHistorical(site, "en", [
    { pageId: aboutId, fromPath: "/old-about" },
    { pageId: aboutId, fromPath: "/about" },
    { pageId: contactEnId!, fromPath: "/moved" },
  ])
  const [contactFrId] = await seedLocaleStates(site, "fr", ["/contact"])
  await seedLocaleHistorical(site, "fr", [
    { pageId: frPageId, fromPath: "/legacy" },
  ])
  const pointedId = await storePointedGeneration(site, [
    { fromPath: "/uber-uns", pageId: aboutId, locale: "nl" },
    {
      fromPath: "/before-shadowed",
      pageId: aboutId,
      locale: "nl",
      shadow: "to_current",
    },
    {
      fromPath: "/before-retired",
      pageId: aboutId,
      locale: "nl",
      retiredAt: FIXED_NOW,
    },
    { fromPath: "/about", pageId: aboutId, locale: "nl" },
    { fromPath: "/fr-only", pageId: frPageId, locale: "fr" },
    { fromPath: "/bonjour", pageId: aboutId, locale: "nl" },
  ])
  const [enPromo, enAbout, frPromo, frAbout, frBonjour] = await seedRedirects(
    site,
    [
      { fromPath: "/promo", locale: "en" },
      { fromPath: "/about", locale: "en" },
      { fromPath: "/promo-fr", locale: "fr" },
      { fromPath: "/about", locale: "fr" },
      { fromPath: "/bonjour", locale: "fr" },
    ]
  )
  void enAbout
  void frBonjour
  const docsId = await seedMenu(site, "docs", menuNav(1, 2, ["en"]))
  await seedMenu(site, "translated", menuNav(1, 1, ["en", "fr"], "-t"))
  await seedMenu(site, "gone", menuNav(1, 1, ["en"], "-g"), true)
  return {
    ...site,
    t,
    contactEnId: contactEnId!,
    legacyEnId: legacyEnId!,
    contactFrId: contactFrId!,
    pointedId,
    rules: { enPromo: enPromo!, frPromo: frPromo!, frAbout: frAbout! },
    docsId,
  }
}

describe("M05 C3b start", () => {
  test("start refuses in order and writes nothing, then names generation 1 and schedules its step", async () => {
    const site = await migrationSite()
    const { t, owner } = site
    const tokens = await migrationTokens(t)
    const start = (args: Partial<typeof tokens & { toLocale: string }>) => () =>
      owner.mutation(api.cms.multilingual.startDefaultLanguageMigration, {
        toLocale: "fr",
        ...tokens,
        ...args,
      })
    expect(
      await refusalWritesNothing(
        t,
        start({ expectedAuthorityVersion: tokens.expectedAuthorityVersion + 1 })
      )
    ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
    expect(
      await refusalWritesNothing(
        t,
        start({
          expectedModuleConfigurationVersion:
            tokens.expectedModuleConfigurationVersion + 1,
        })
      )
    ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
    expect(await refusalWritesNothing(t, start({ toLocale: "xx" }))).toEqual(
      refused("LOCALE_UNSUPPORTED")
    )
    expect(await refusalWritesNothing(t, start({ toLocale: "nl" }))).toEqual(
      refused("LOCALE_NOT_ENABLED")
    )
    expect(await refusalWritesNothing(t, start({ toLocale: "en" }))).toEqual(
      refused("LOCALE_IS_DEFAULT")
    )

    // The home rule: `homePageId` without a current `fr` selection at `/`.
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { homePageId: site.homeEnId })
    })
    expect(await refusalWritesNothing(t, start({}))).toEqual(
      refused("DEFAULT_MIGRATION_TARGET_HOME_MISSING")
    )
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { homePageId: site.homeFrId })
    })

    // M4 comes before every other check.
    await setCutover(t, "preparing")
    expect(await refusalWritesNothing(t, start({ toLocale: "xx" }))).toEqual(
      refused("LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY")
    )
    await setCutover(t, "snapshot_active")

    const scheduledBefore = await t.run(
      async (ctx) =>
        (await ctx.db.system.query("_scheduled_functions").collect()).length
    )
    const migrationId = await startMigration(site)
    const migration = await migrationRow(t, migrationId)
    // C3a Limit: the writer's row is the fixture's shape plus its cursor phase.
    const fixtureId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "enumerating",
    })
    const fixture = await migrationRow(t, fixtureId)
    await t.run((ctx) => ctx.db.delete(fixtureId))
    expect(Object.keys(migration).sort()).toEqual(
      [...Object.keys(fixture), "cursorPhase"].sort()
    )
    const live = await t.run(async (ctx) => {
      const [site, from, to] = await Promise.all(
        [undefined, "en", "fr"].map(async (locale) => {
          const row = await ctx.db
            .query("siteLanguageFreshness")
            .withIndex("by_scope_and_locale", (q) =>
              locale === undefined
                ? q.eq("scope", "site").eq("locale", undefined)
                : q.eq("scope", "locale").eq("locale", locale)
            )
            .unique()
          return {
            routeClaimVersion: row?.routeClaimVersion ?? 0,
            publicationSetVersion: row?.publicationSetVersion ?? 0,
          }
        })
      )
      return { site, from, to }
    })
    expect(migration).toMatchObject({
      fromLocale: "en",
      toLocale: "fr",
      phase: "enumerating",
      generation: 1,
      cursorPhase: "old_default_current",
      captured: {
        authorityVersion: tokens.expectedAuthorityVersion,
        moduleConfigurationVersion: tokens.expectedModuleConfigurationVersion,
        ...live,
      },
      counts: NO_MIGRATION_COUNTS,
      disclosurePageCount: 0,
      reviewedThroughOrdinal: -1,
      attribution: { kind: "owner", tokenIdentifier: OWNER.tokenIdentifier },
    })
    expect(await authorityRow(t)).toMatchObject({
      activeDefaultMigrationId: migrationId,
      version: tokens.expectedAuthorityVersion,
    })
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect()
    )
    expect(scheduled.length - scheduledBefore).toBe(1)
    expect(scheduled.at(-1)).toMatchObject({
      name: "cms/multilingual:stepDefaultLanguageMigration",
      args: [{ migrationId, generation: 1 }],
    })

    // M6: start refuses the migration it just opened.
    expect(await refusalWritesNothing(t, start({}))).toEqual(
      refused("LANGUAGE_OPERATION_OPEN")
    )
  }, 120_000)

  test("getMultilingualState reports the open migration and its summary (C3a Deferral)", async () => {
    const site = await migrationSite()
    const { t, owner } = site
    expect(
      await owner.query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({ openOperation: null, defaultMigration: null })
    const migrationId = await startMigration(site)
    expect(
      await owner.query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({
      lifecycleState: "S4",
      openOperation: { kind: "default_migration", phase: "enumerating" },
      defaultMigration: {
        migrationId,
        fromLocale: "en",
        toLocale: "fr",
        phase: "enumerating",
        generation: 1,
        counts: NO_MIGRATION_COUNTS,
        disclosurePageCount: 0,
        reviewedThroughOrdinal: -1,
      },
    })
    await runMigration(t, migrationId)
    const done = await migrationRow(t, migrationId)
    expect(
      await owner.query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({
      openOperation: { kind: "default_migration", phase: "validating" },
      defaultMigration: {
        phase: "validating",
        counts: done.counts,
        disclosurePageCount: done.disclosurePageCount,
      },
    })
    // An authority naming a migration that is not open classifies IX here.
    await t.run((ctx) => ctx.db.patch(migrationId, { phase: "cancelled" }))
    expect(
      await owner.query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({
      lifecycleState: "IX",
      openOperation: null,
      defaultMigration: null,
    })
  }, 120_000)
})

describe("M05 P16 complete enumeration (enumeration half)", () => {
  test("every visible default-URL path becomes one row, served or disclosed as shadowed, in precedence order", async () => {
    const corpus = await enumerationCorpus()
    const { t, aboutId, frPageId } = corpus
    const migrationId = await startMigration(corpus)
    const { migration, perStep } = await runMigration(t, migrationId)
    expect(Math.max(...perStep)).toBe(1)
    expect(migration).toMatchObject({
      phase: "validating",
      cursorPhase: "validation",
      generation: 1,
    })
    expect(migration.cursor).toBeUndefined()

    const canonical = await t.run(async (ctx) =>
      (await ctx.db.query("menus").withIndex("by_slug").collect()).filter(
        (menu) => menu.deletedAt === undefined && menu.slug === MENU_SLUG
      )
    )
    const canonicalBlockers = canonical.flatMap((menu) =>
      menuNodePathsMissingRequiredText(menu.nav, "fr").map((nodePath) => ({
        kind: "menu_blocker" as const,
        menuId: menu._id,
        menuName: menu.slug,
        nodePath,
        code: "DEFAULT_MIGRATION_MENU_TEXT_MISSING" as const,
      }))
    )
    const docsBlockers = [
      "item-0",
      "item-0/group-0",
      "item-0/group-0/link-0-0",
      "item-0/group-0/link-0-1",
    ].map((nodePath) => ({
      kind: "menu_blocker" as const,
      menuId: corpus.docsId,
      menuName: "docs",
      nodePath,
      code: "DEFAULT_MIGRATION_MENU_TEXT_MISSING" as const,
    }))

    const rows = (await migrationRoutes(t, migrationId, 1)).map(routeView)
    expect(rows).toEqual([
      {
        fromPath: "/",
        pageId: corpus.homeEnId,
        locale: "en",
        origin: "old_default_current",
        shadow: "to_current",
        capturedPath: "/",
      },
      {
        fromPath: "/about",
        pageId: aboutId,
        locale: "en",
        origin: "old_default_current",
        manualRule: "shadowed",
        capturedPath: "/about",
      },
      {
        fromPath: "/bonjour",
        pageId: aboutId,
        locale: "nl",
        origin: "carried",
        shadow: "to_current",
      },
      {
        fromPath: "/contact",
        pageId: corpus.contactEnId,
        locale: "en",
        origin: "old_default_current",
        shadow: "to_current",
        capturedPath: "/contact",
      },
      {
        fromPath: "/fr-only",
        pageId: frPageId,
        locale: "fr",
        origin: "carried",
      },
      {
        fromPath: "/legacy",
        pageId: corpus.legacyEnId,
        locale: "en",
        origin: "old_default_current",
        shadow: "to_historical",
        capturedPath: "/legacy",
      },
      {
        fromPath: "/moved",
        pageId: corpus.contactEnId,
        locale: "en",
        origin: "old_default_historical",
      },
      {
        fromPath: "/old-about",
        pageId: aboutId,
        locale: "en",
        origin: "old_default_historical",
      },
      {
        fromPath: "/uber-uns",
        pageId: aboutId,
        locale: "nl",
        origin: "carried",
      },
    ])
    expect(migration.counts).toEqual({
      rows: 9,
      shadowedByCurrent: 3,
      shadowedByHistorical: 1,
      manualRulesShadowed: 1,
      manualRulesShifted: 1,
      manualRulesUnprefixed: 1,
      carriedShadowedSkipped: 3,
      blockers: docsBlockers.length + canonicalBlockers.length,
    })

    // M13, enumeration half: every path that resolves to `en` or to the
    // active continuity set before activation has exactly one row.
    const visible = await t.run(async (ctx) => {
      const current = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_locale_and_currentPath", (q) => q.eq("locale", "en"))
        .collect()
      const historical = await ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) => q.eq("locale", "en"))
        .collect()
      const pointed = await ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation", (q) =>
          q.eq("migrationId", corpus.pointedId).eq("generation", 1)
        )
        .collect()
      return [
        ...current.flatMap((row) => (row.currentPath ? [row.currentPath] : [])),
        ...historical.map((row) => row.fromPath),
        ...pointed
          .filter((row) => !row.shadow && row.retiredAt === undefined)
          .map((row) => row.fromPath),
      ]
    })
    expect(new Set(rows.map((row) => row.fromPath))).toEqual(new Set(visible))

    const pages = await migrationPages(t, migrationId, 1)
    const shadowed = (
      fromPath: string,
      pageId: Id<"pages">,
      destinationLocale: string,
      reason: "to_current" | "to_historical"
    ) => ({
      kind: "shadowed_row" as const,
      pageId,
      fromPath,
      destinationLocale,
      reason,
    })
    const rule = (
      ruleId: Id<"redirects">,
      fromPath: string,
      status: "shifted" | "shadowed",
      newVisiblePath?: string
    ) => ({
      kind: "manual_rule" as const,
      ruleId,
      fromPath,
      destination: { kind: "page" as const, pageId: frPageId },
      statusCode: 301 as const,
      status,
      ...(newVisiblePath === undefined ? {} : { newVisiblePath }),
    })
    const menuPages = [
      ...[docsBlockers, canonicalBlockers]
        .filter((items) => items.length > 0)
        .sort((a, b) => a[0]!.menuName.localeCompare(b[0]!.menuName))
        .map((items) => ({ section: "menus", items })),
    ]
    expect(
      pages.map(({ section, items, ordinal }) => ({ ordinal, section, items }))
    ).toEqual(
      [
        {
          section: "shadowed",
          items: [
            shadowed("/", corpus.homeEnId, "en", "to_current"),
            shadowed("/contact", corpus.contactEnId, "en", "to_current"),
            shadowed("/legacy", corpus.legacyEnId, "en", "to_historical"),
          ],
        },
        {
          section: "shadowed",
          items: [shadowed("/bonjour", aboutId, "nl", "to_current")],
        },
        {
          section: "manual_rule_shifts",
          items: [rule(corpus.rules.enPromo, "/promo", "shifted", "/en/promo")],
        },
        {
          section: "manual_rule_shifts",
          items: [
            rule(corpus.rules.frAbout, "/about", "shadowed"),
            rule(corpus.rules.frPromo, "/promo-fr", "shifted", "/promo-fr"),
          ],
        },
        ...menuPages,
      ].map((page, ordinal) => ({ ordinal, ...page }))
    )
    expect(migration.disclosurePageCount).toBe(pages.length)
    expect(migration.digest).toBe(await recomputedDigest(pages, migrationId))
    expect(migration.digest).toBe(pages.at(-1)!.digest)
  }, 120_000)
})

describe("M05 P6 default migration enumeration cases", () => {
  test("a path over the route-row maximum is a disclosed blocker, never a truncated row (residual 2.2)", async () => {
    const site = await migrationSite()
    const { t } = site
    const atMax = `/${"a".repeat(DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES - 1)}`
    const overMax = `/${"b".repeat(DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES)}`
    const [atMaxId, overMaxId] = await seedLocaleStates(site, "en", [
      atMax,
      overMax,
    ])
    const migrationId = await startMigration(site)
    const { migration } = await runMigration(t, migrationId)
    const rows = await migrationRoutes(t, migrationId, 1)
    expect(rows.map((row) => row.fromPath)).toContain(atMax)
    expect(rows.find((row) => row.pageId === overMaxId)).toBeUndefined()
    expect(rows.find((row) => row.pageId === atMaxId)?.fromPath).toBe(atMax)
    const blockerPages = (await migrationPages(t, migrationId, 1)).filter(
      (page) => page.items.some((item) => item.kind === "route_path_too_long")
    )
    // Route-phase blockers ride the route phase's `shadowed` page (ledger C3b).
    expect(blockerPages.map((page) => page.section)).toEqual(["shadowed"])
    const items = (await migrationPages(t, migrationId, 1)).flatMap(
      (page) => page.items
    )
    expect(items.filter((item) => item.kind === "route_path_too_long")).toEqual(
      [
        {
          kind: "route_path_too_long",
          pageId: overMaxId,
          fromPath: overMax.slice(0, DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES),
          origin: "old_default_current",
          code: "DEFAULT_MIGRATION_ROUTE_PATH_TOO_LONG",
          truncated: true,
        },
      ]
    )
    expect(migration.counts.blockers).toBe(
      1 + items.filter((item) => item.kind === "menu_blocker").length
    )
  }, 120_000)

  test("a multi-batch phase resumes at its cursor, and a crashed step leaves nothing behind", async () => {
    const site = await migrationSite()
    const { t } = site
    const paths = Array.from(
      { length: 50 },
      (_, i) => `/page-${String(i).padStart(2, "0")}`
    )
    // Every fifth path collides with a `fr` claim, so pages span batches.
    await seedLocaleStates(site, "en", paths)
    await seedLocaleStates(
      site,
      "fr",
      paths.filter((_, i) => i % 5 === 0)
    )
    const migrationId = await startMigration(site)
    await stepMigration(t, migrationId)
    const afterFirst = await migrationRow(t, migrationId)
    expect(afterFirst.cursorPhase).toBe("old_default_current")
    expect(afterFirst.cursor).toBeDefined()

    // A step whose transaction fails commits nothing; the next resumes.
    const before = await everyRow(t)
    await expect(
      t.run(async (ctx) => {
        await runDefaultMigrationStep(ctx, migrationId, 1)
        throw new Error("crash after the step")
      })
    ).rejects.toThrow("crash after the step")
    expect(await everyRow(t)).toEqual(before)

    const { migration } = await runMigration(t, migrationId)
    const rows = await migrationRoutes(t, migrationId, 1)
    const enPaths = rows
      .filter((row) => row.origin === "old_default_current")
      .map((row) => row.fromPath)
    expect(enPaths).toEqual(["/", "/about", ...paths].sort())
    expect(new Set(enPaths).size).toBe(enPaths.length)
    expect(migration.counts.shadowedByCurrent).toBe(11) // `/` and ten pages
    const pages = await migrationPages(t, migrationId, 1)
    // Disclosure pages follow bounded claim continuations, with every shadow disclosed exactly once.
    expect(
      pages.filter((page) => page.section === "shadowed").length
    ).toBeGreaterThan(0)
    expect(
      pages
        .flatMap((page) => page.items)
        .filter((item) => item.kind === "shadowed_row")
    ).toHaveLength(11)
    expect(migration.digest).toBe(await recomputedDigest(pages, migrationId))
  }, 120_000)

  test("a token change restarts under generation + 1 with fresh tokens, and the old generation is left intact (M14)", async () => {
    const site = await migrationSite()
    const { t, owner } = site
    await seedLocaleStates(
      site,
      "en",
      Array.from({ length: 30 }, (_, i) => `/p-${i}`)
    )
    await seedLocaleStates(site, "fr", ["/p-1"])
    const migrationId = await startMigration(site)
    await stepMigration(t, migrationId)
    const first = await migrationRow(t, migrationId)
    const firstRows = await migrationRoutes(t, migrationId, 1)
    const firstPages = await migrationPages(t, migrationId, 1)
    // Eight sparse candidates finish before the saved source page continues.
    expect(firstRows.length).toBe(8)
    expect(firstPages.length).toBe(1)

    await owner.mutation(api.cms.redirects.create, {
      fromPath: "/late",
      toPageId: site.frPageId,
      locale: "fr",
      statusCode: 301,
    })
    // A stale-generation step is a no-op even after the move.
    expect(
      await refusalWritesNothing(t, () => stepMigration(t, migrationId, 2))
    ).toEqual(ok(null))
    await stepMigration(t, migrationId)
    const restarted = await migrationRow(t, migrationId)
    // The restart schedules generation 2's first step.
    expect(
      (
        await t.run((ctx) =>
          ctx.db.system.query("_scheduled_functions").collect()
        )
      ).at(-1)
    ).toMatchObject({
      name: "cms/multilingual:stepDefaultLanguageMigration",
      args: [{ migrationId, generation: 2 }],
    })
    const live = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("siteLanguageFreshness")
        .withIndex("by_scope_and_locale", (q) =>
          q.eq("scope", "locale").eq("locale", "fr")
        )
        .unique()
      return row!.routeClaimVersion
    })
    expect(restarted).toMatchObject({
      phase: "enumerating",
      generation: 2,
      cursorPhase: "old_default_current",
      counts: NO_MIGRATION_COUNTS,
      disclosurePageCount: 0,
      reviewedThroughOrdinal: -1,
    })
    expect(restarted.cursor).toBeUndefined()
    expect(restarted.digest).toBeUndefined()
    expect(restarted.captured.to.routeClaimVersion).toBe(live)
    expect(restarted.captured.to.routeClaimVersion).toBeGreaterThan(
      first.captured.to.routeClaimVersion
    )
    // Generation 1 is untouched and never mixed into generation 2.
    expect(await migrationRoutes(t, migrationId, 1)).toEqual(firstRows)
    expect(await migrationPages(t, migrationId, 1)).toEqual(firstPages)
    expect(await migrationRoutes(t, migrationId, 2)).toEqual([])

    const { migration } = await runMigration(t, migrationId)
    expect(migration.generation).toBe(2)
    expect(
      (await migrationRoutes(t, migrationId, 2)).filter(
        (row) => row.origin === "old_default_current"
      ).length
    ).toBe(32)
    const items = (await migrationPages(t, migrationId, 2)).flatMap(
      (page) => page.items
    )
    expect(
      items.filter(
        (item) => item.kind === "manual_rule" && item.fromPath === "/late"
      )
    ).toHaveLength(1)
  }, 120_000)

  test("a restart after review resets the receipt, and an unresumable or unreadable cursor restarts too", async () => {
    const site = await migrationSite()
    const { t, owner } = site
    const migrationId = await startMigration(site)
    await runMigration(t, migrationId)
    const reviewed = await migrationRow(t, migrationId)
    expect(reviewed.disclosurePageCount).toBeGreaterThan(0)
    const [page] = await migrationPages(t, migrationId, 1)
    expect(
      await owner.mutation(api.cms.multilingual.recordDefaultMigrationReview, {
        migrationId,
        expectedGeneration: 1,
        ordinal: 0,
        pageDigest: page!.digest,
      })
    ).toMatchObject({ stale: false, reviewedThroughOrdinal: 0 })

    // A move while `validating`: the next step restarts and resets review.
    await owner.mutation(api.cms.redirects.create, {
      fromPath: "/late",
      toPageId: site.frPageId,
      locale: "en",
      statusCode: 301,
    })
    expect(
      await owner.mutation(
        api.cms.multilingual.continueDefaultLanguageMigration,
        { migrationId, expectedGeneration: 1 }
      )
    ).toEqual({ kind: "restarted", generation: 2 })
    expect(await migrationRow(t, migrationId)).toMatchObject({
      generation: 2,
      phase: "enumerating",
      reviewedThroughOrdinal: -1,
    })

    // A cursor the backend refuses restarts the generation.
    await stepMigration(t, migrationId)
    // Reach the next source-page boundary before injecting a backend cursor refusal.
    for (
      let drain = 0;
      drain < 20 &&
      JSON.parse((await migrationRow(t, migrationId)).cursor ?? "{}").claims;
      drain++
    )
      await stepMigration(t, migrationId)
    const refusedCursor = vi
      .spyOn(defaultMigrationSeam, "paginate")
      .mockRejectedValueOnce(new Error("InvalidCursor"))
    await stepMigration(t, migrationId)
    refusedCursor.mockRestore()
    expect(await migrationRow(t, migrationId)).toMatchObject({
      generation: 3,
      cursorPhase: "old_default_current",
    })
    // So does a stored cursor that no longer decodes.
    await t.run((ctx) => ctx.db.patch(migrationId, { cursor: "{not json" }))
    await stepMigration(t, migrationId)
    expect(await migrationRow(t, migrationId)).toMatchObject({
      generation: 4,
      phase: "enumerating",
    })
    const { migration } = await runMigration(t, migrationId)
    expect(migration).toMatchObject({ phase: "validating", generation: 4 })
  }, 120_000)
})

describe("M05 P15b delayed migration steps (step half)", () => {
  test("stale, terminal and unnamed migrations no-op; a split page or a reserve crossing halves; size one restarts", async () => {
    const site = await migrationSite()
    const { t } = site
    await seedLocaleStates(
      site,
      "en",
      Array.from({ length: 30 }, (_, i) => `/s-${i}`)
    )
    await seedLocaleStates(site, "fr", ["/s-3", "/s-17"])
    const migrationId = await startMigration(site)

    for (const generation of [0, 2]) {
      expect(
        await refusalWritesNothing(t, () =>
          stepMigration(t, migrationId, generation)
        )
      ).toEqual(ok(null))
    }
    // Not named by the authority: nothing to serve, nothing to restart.
    await nameDefaultMigration(t, undefined)
    expect(
      await refusalWritesNothing(t, () => stepMigration(t, migrationId))
    ).toEqual(ok(null))
    await nameDefaultMigration(t, migrationId)
    for (const phase of ["committed", "cancelled"] as const) {
      await t.run((ctx) => ctx.db.patch(migrationId, { phase }))
      expect(
        await refusalWritesNothing(t, () => stepMigration(t, migrationId))
      ).toEqual(ok(null))
    }
    await t.run((ctx) => ctx.db.patch(migrationId, { phase: "enumerating" }))

    const realPaginate =
      defaultMigrationSeam.paginate.bind(defaultMigrationSeam)
    const realMetrics = defaultMigrationSeam.metrics.bind(defaultMigrationSeam)
    const unchanged = async (run: () => Promise<void>, size: number) => {
      const before = await migrationRow(t, migrationId)
      const routes = await migrationRoutes(t, migrationId, 1)
      await run()
      const after = await migrationRow(t, migrationId)
      expect(await migrationRoutes(t, migrationId, 1)).toEqual(routes)
      expect(await migrationPages(t, migrationId, 1)).toHaveLength(0)
      expect({
        generation: after.generation,
        counts: after.counts,
        cursorPhase: after.cursorPhase,
        size: JSON.parse(after.cursor!).size,
      }).toEqual({
        generation: before.generation,
        counts: before.counts,
        cursorPhase: before.cursorPhase,
        size,
      })
    }

    const split = vi
      .spyOn(defaultMigrationSeam, "paginate")
      .mockImplementationOnce(async (query, options) => ({
        ...(await realPaginate(query, options)),
        pageStatus: "SplitRequired" as const,
      }))
    await unchanged(() => stepMigration(t, migrationId), 10)
    split.mockRestore()

    let calls = 0
    const crossing = vi
      .spyOn(defaultMigrationSeam, "metrics")
      .mockImplementation(async (ctx) => {
        const metrics = await realMetrics(ctx)
        calls += 1
        // The page check, then items 1–3; the third item crosses.
        if (calls !== 4) return metrics
        return {
          ...metrics,
          documentsRead: {
            used: metrics.documentsRead.used + 20_000,
            remaining: 1_000,
          },
        }
      })
    await unchanged(() => stepMigration(t, migrationId), 5)
    crossing.mockRestore()

    // A completed half-size page writes and restores the constant size.
    await stepMigration(t, migrationId)
    const resumed = await migrationRow(t, migrationId)
    // Five rows read; the pathless `bonjour` state yields no row.
    expect((await migrationRoutes(t, migrationId, 1)).length).toBe(4)
    expect(JSON.parse(resumed.cursor!).size).toBeUndefined()

    // At page size one a further split restarts the generation.
    await t.run((ctx) =>
      ctx.db.patch(migrationId, {
        cursor: JSON.stringify({ ...JSON.parse(resumed.cursor!), size: 1 }),
      })
    )
    const splitAtOne = vi
      .spyOn(defaultMigrationSeam, "paginate")
      .mockImplementationOnce(async (query, options) => ({
        ...(await realPaginate(query, options)),
        pageStatus: "SplitRequired" as const,
      }))
    await stepMigration(t, migrationId)
    splitAtOne.mockRestore()
    expect(await migrationRow(t, migrationId)).toMatchObject({
      generation: 2,
      cursorPhase: "old_default_current",
    })

    // So does a reserve crossing at page size one, in the same step.
    await stepMigration(t, migrationId)
    const second = await migrationRow(t, migrationId)
    await t.run((ctx) =>
      ctx.db.patch(migrationId, {
        cursor: JSON.stringify({ ...JSON.parse(second.cursor!), size: 1 }),
      })
    )
    const crossingAtOne = vi
      .spyOn(defaultMigrationSeam, "metrics")
      .mockImplementation(async (ctx) => {
        const metrics = await realMetrics(ctx)
        return {
          ...metrics,
          bytesRead: { used: 5 * MIB, remaining: 11 * MIB },
        }
      })
    await stepMigration(t, migrationId)
    crossingAtOne.mockRestore()
    expect(await migrationRow(t, migrationId)).toMatchObject({
      generation: 3,
      cursorPhase: "old_default_current",
    })
  }, 120_000)
})

/** F09's last committed transition into `targetLocale`, with its routes. */
async function storeF09Continuity(
  site: Pick<Site, "t">,
  targetLocale: string,
  routes: readonly { fromPath: string; pageId: Id<"pages"> }[]
) {
  await site.t.run(async (ctx) => {
    const owner = (await ctx.db
      .query("cmsOwner")
      .withIndex("by_key", (q) => q.eq("key", "owner"))
      .unique())!
    const transitionId = await ctx.db.insert("siteLanguageTransitions", {
      mode: "correct_label",
      sourceLocale: "nl",
      targetLocale,
      phase: "committed",
      generation: 1,
      startAuthorityVersion: 1,
      startSettingsUpdatedAt: FIXED_NOW,
      shortPath: false,
      sourcePublicSetVersion: 0,
      preparedSetVersion: 0,
      pageCount: 1,
      targetCount: 1,
      withdrawCount: 0,
      redirectCount: 0,
      unresolvedCount: 0,
      blockedCount: 0,
      targetDrafts: "retained",
      committedAt: FIXED_NOW,
      attribution: {
        kind: "owner",
        ownerId: owner._id,
        authId: owner.authId,
        tokenIdentifier: owner.tokenIdentifier,
      },
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
    for (const route of routes) {
      await ctx.db.insert("siteLanguageTransitionRoutes", {
        transitionId,
        ...route,
        origin: "source_current",
        createdAt: FIXED_NOW,
      })
    }
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(authority._id, {
      lastCommittedTransitionId: transitionId,
    })
  })
}

describe("M05 P16 F09 continuity carries into the first migration", () => {
  test("without a pointer, F09's routes carry in the default language after a verification step", async () => {
    const site = await migrationSite()
    const { t, aboutId } = site
    await storeF09Continuity(site, "en", [
      { fromPath: "/ueber-uns", pageId: aboutId },
      { fromPath: "/about", pageId: aboutId },
      { fromPath: "/bonjour", pageId: aboutId },
    ])
    const migrationId = await startMigration(site)
    // Drive to the carried phase, then prove the entry step reads no page.
    for (let guard = 0; guard < 20; guard += 1) {
      if ((await migrationRow(t, migrationId)).cursorPhase === "carried") break
      await stepMigration(t, migrationId)
    }
    const paginate = vi.spyOn(defaultMigrationSeam, "paginate")
    await stepMigration(t, migrationId)
    expect(paginate).not.toHaveBeenCalled()
    paginate.mockRestore()
    expect(JSON.parse((await migrationRow(t, migrationId)).cursor!)).toEqual({
      page: null,
      f09: true,
    })
    const { migration } = await runMigration(t, migrationId)
    const carried = (await migrationRoutes(t, migrationId, 1))
      .filter((row) => row.origin === "carried")
      .map(routeView)
    expect(carried).toEqual([
      {
        fromPath: "/bonjour",
        pageId: aboutId,
        locale: "en",
        origin: "carried",
        shadow: "to_current",
      },
      {
        fromPath: "/ueber-uns",
        pageId: aboutId,
        locale: "en",
        origin: "carried",
      },
    ])
    // `/about` is already the `en` current row: skipped and counted.
    expect(migration.counts.carriedShadowedSkipped).toBe(1)
  }, 120_000)

  test("an F09 transition whose target is not the default language fails closed", async () => {
    // Routing U2 (C7): this state follows a silent default change; the start
    // refuses up front and writes nothing instead of failing at `carried` and
    // leaving an open migration behind.
    const site = await migrationSite()
    const { t, aboutId } = site
    await storeF09Continuity(site, "fr", [
      { fromPath: "/ueber-uns", pageId: aboutId },
    ])
    expect(await refusalWritesNothing(t, () => startMigration(site))).toEqual(
      refused("DEFAULT_MIGRATION_SUPERSEDED")
    )
  }, 120_000)
})

function listMigrationPage(
  caller: Pick<Caller, "query">,
  migrationId: MigrationId,
  generation: number,
  ordinal: number
) {
  return caller.query(api.cms.multilingual.listDefaultMigrationDisclosure, {
    migrationId,
    generation,
    ordinal,
  })
}

function recordMigrationReview(
  caller: Pick<Caller, "mutation">,
  migrationId: MigrationId,
  expectedGeneration: number,
  ordinal: number,
  pageDigest: string
) {
  return caller.mutation(api.cms.multilingual.recordDefaultMigrationReview, {
    migrationId,
    expectedGeneration,
    ordinal,
    pageDigest,
  })
}

describe("M05 C3b migration disclosure listing and review receipts", () => {
  test("pages list only once enumerated, receipts advance one page in order, and any move is stale", async () => {
    const corpus = await enumerationCorpus()
    const { t, owner } = corpus
    const migrationId = await startMigration(corpus)
    await stepMigration(t, migrationId)
    // Still enumerating: nothing is reviewable yet.
    expect(await listMigrationPage(owner, migrationId, 1, 0)).toEqual({
      stale: true,
    })
    const early = (await migrationPages(t, migrationId, 1))[0]!
    expect(
      await refusalWritesNothing(t, () =>
        recordMigrationReview(owner, migrationId, 1, 0, early.digest)
      )
    ).toEqual(STALE)

    const { migration } = await runMigration(t, migrationId)
    const pages = await migrationPages(t, migrationId, 1)
    expect(await listMigrationPage(owner, migrationId, 1, 1)).toEqual({
      stale: false,
      ordinal: 1,
      pageCount: migration.disclosurePageCount,
      section: pages[1]!.section,
      items: pages[1]!.items,
      digest: pages[1]!.digest,
    })
    for (const ordinal of [-1, migration.disclosurePageCount, 0.5]) {
      expect(
        await outcome(() => listMigrationPage(owner, migrationId, 1, ordinal))
      ).toEqual(MISMATCH)
    }
    expect(await listMigrationPage(owner, migrationId, 2, 0)).toEqual({
      stale: true,
    })

    // Out of order, wrong digest and another generation.
    expect(
      await refusalWritesNothing(t, () =>
        recordMigrationReview(owner, migrationId, 1, 1, pages[1]!.digest)
      )
    ).toEqual(MISMATCH)
    expect(
      await refusalWritesNothing(t, () =>
        recordMigrationReview(owner, migrationId, 1, 0, pages[1]!.digest)
      )
    ).toEqual(MISMATCH)
    expect(
      await refusalWritesNothing(t, () =>
        recordMigrationReview(owner, migrationId, 2, 0, pages[0]!.digest)
      )
    ).toEqual(STALE)
    for (const [ordinal, page] of pages.entries()) {
      expect(
        await recordMigrationReview(owner, migrationId, 1, ordinal, page.digest)
      ).toEqual({
        stale: false,
        reviewedThroughOrdinal: ordinal,
        pageCount: pages.length,
      })
    }
    expect(
      await refusalWritesNothing(t, () =>
        recordMigrationReview(owner, migrationId, 1, pages.length, "x")
      )
    ).toEqual(MISMATCH)

    // A missing migration is malformed; a moved token is stale everywhere.
    await t.run((ctx) =>
      ctx.db.patch(migrationId, { reviewedThroughOrdinal: -1 })
    )
    await owner.mutation(api.cms.redirects.create, {
      fromPath: "/late",
      toPageId: corpus.frPageId,
      locale: "fr",
      statusCode: 301,
    })
    expect(await listMigrationPage(owner, migrationId, 1, 0)).toEqual({
      stale: true,
    })
    expect(
      await refusalWritesNothing(t, () =>
        recordMigrationReview(owner, migrationId, 1, 0, pages[0]!.digest)
      )
    ).toEqual(STALE)
  }, 120_000)

  test("route listing pages the generation with the shadowed, manual and all filters", async () => {
    const corpus = await enumerationCorpus()
    const { t, owner } = corpus
    const migrationId = await startMigration(corpus)
    await runMigration(t, migrationId)
    const all: string[] = []
    let cursor: string | null = null
    for (let guard = 0; guard < 10; guard += 1) {
      const result: {
        page: { fromPath: string }[]
        isDone: boolean
        continueCursor: string
      } = await owner.query(api.cms.multilingual.listDefaultLanguageRoutes, {
        migrationId,
        generation: 1,
        paginationOpts: { numItems: 4, cursor },
        filter: "all",
      })
      all.push(...result.page.map((row) => row.fromPath))
      if (result.isDone) break
      cursor = result.continueCursor
    }
    expect(all).toEqual(
      (await migrationRoutes(t, migrationId, 1)).map((row) => row.fromPath)
    )
    const filtered = async (filter: "shadowed" | "manual") =>
      (
        await owner.query(api.cms.multilingual.listDefaultLanguageRoutes, {
          migrationId,
          generation: 1,
          paginationOpts: { numItems: 50, cursor: null },
          filter,
        })
      ).page
    expect((await filtered("shadowed")).map((row) => row.fromPath)).toEqual([
      "/",
      "/bonjour",
      "/contact",
      "/legacy",
    ])
    expect(await filtered("manual")).toEqual([
      {
        fromPath: "/about",
        pageId: corpus.aboutId,
        locale: "en",
        origin: "old_default_current",
        manualRule: "shadowed",
        capturedPath: "/about",
      },
    ])
  }, 120_000)
})

describe("M05 P2c owner-only default migration (enumeration, validation and cancel)", () => {
  test("only the current owner starts, continues, lists, reviews and cancels; workers no-op elsewhere", async () => {
    const site = await migrationSite()
    const { t } = site
    const FORMER = {
      subject: "m05-p2c-former",
      tokenIdentifier: "https://convex.test|m05-p2c-former",
    }
    const CURRENT = {
      subject: "m05-p2c-current",
      tokenIdentifier: "https://convex.test|m05-p2c-current",
    }
    const LEGACY_ADMIN = {
      subject: "m05-p2c-legacy-admin",
      tokenIdentifier: "https://convex.test|m05-p2c-legacy-admin",
    }
    const bindOwner = (identity: typeof CURRENT) =>
      t.run(async (ctx) => {
        const owner = (await ctx.db.query("cmsOwner").unique())!
        await ctx.db.patch(owner._id, {
          authId: identity.subject,
          tokenIdentifier: identity.tokenIdentifier,
        })
      })
    await bindOwner(FORMER)
    const former = t.withIdentity(FORMER)
    const migrationId = await startMigration(site, "fr", former)
    await runMigration(t, migrationId)
    const [page] = await migrationPages(t, migrationId, 1)
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("roles", {
        authId: LEGACY_ADMIN.subject,
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("cmsMemberships", {
        authId: LEGACY_ADMIN.subject,
        tokenIdentifier: LEGACY_ADMIN.tokenIdentifier,
        role: "admin",
        status: "active",
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
        transitionId: "m05-p2c",
      })
    })
    await bindOwner(CURRENT)
    const current = t.withIdentity(CURRENT)

    type Caller = Pick<ReturnType<T["withIdentity"]>, "query" | "mutation">
    const calls = (caller: Caller) => ({
      start: async () =>
        caller.mutation(api.cms.multilingual.startDefaultLanguageMigration, {
          toLocale: "fr",
          ...(await migrationTokens(t)),
        }),
      continue: () =>
        caller.mutation(api.cms.multilingual.continueDefaultLanguageMigration, {
          migrationId,
          expectedGeneration: 1,
        }),
      listRoutes: () =>
        caller.query(api.cms.multilingual.listDefaultLanguageRoutes, {
          migrationId,
          generation: 1,
          paginationOpts: { numItems: 5, cursor: null },
          filter: "all",
        }),
      listDisclosure: () => listMigrationPage(caller, migrationId, 1, 0),
      receipt: () =>
        recordMigrationReview(caller, migrationId, 1, 0, page!.digest),
      cancel: () =>
        caller.mutation(api.cms.multilingual.cancelDefaultLanguageMigration, {
          migrationId,
          expectedGeneration: 1,
        }),
    })
    const denied: [string, Caller, string][] = [
      ["unauthenticated", t, "UNAUTHENTICATED"],
      [
        "unrelated signed-in",
        t.withIdentity({
          subject: "m05-p2c-stranger",
          tokenIdentifier: "https://convex.test|m05-p2c-stranger",
        }),
        "CMS_OWNER_REQUIRED",
      ],
      [
        "role-only legacy Admin",
        t.withIdentity(LEGACY_ADMIN),
        "CMS_OWNER_REQUIRED",
      ],
      ["replaced former owner", former, "CMS_OWNER_REQUIRED"],
    ]
    for (const [identity, caller, code] of denied) {
      for (const [name, call] of Object.entries(calls(caller))) {
        expect({
          identity,
          name,
          result: await refusalWritesNothing(t, call),
        }).toEqual({ identity, name, result: refused(code) })
      }
    }

    // Continuations with another migration or generation are no-ops.
    const otherId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "enumerating",
    })
    for (const [id, generation] of [
      [otherId, 1],
      [migrationId, 2],
      [migrationId, 0],
    ] as const) {
      expect(
        await refusalWritesNothing(t, () =>
          current.mutation(
            api.cms.multilingual.continueDefaultLanguageMigration,
            { migrationId: id, expectedGeneration: generation }
          )
        )
      ).toEqual(ok({ kind: "noop" }))
      expect(
        await refusalWritesNothing(t, () =>
          t.mutation(internal.cms.multilingual.stepDefaultLanguageMigration, {
            migrationId: id,
            generation,
          })
        )
      ).toEqual(ok(null))
    }

    // The current owner continues, lists and reviews the migration a former
    // owner started: it is the installation's, not an identity's (ledger C3b).
    const ownerCalls = calls(current)
    expect(await ownerCalls.continue()).toEqual({
      kind: "ready",
      generation: 1,
      readinessVersion: 1,
    })
    expect((await ownerCalls.listRoutes()).page.length).toBeGreaterThan(0)
    expect(await ownerCalls.listDisclosure()).toMatchObject({ stale: false })
    expect(await ownerCalls.receipt()).toMatchObject({
      stale: false,
      reviewedThroughOrdinal: 0,
    })
    expect(await outcome(ownerCalls.start)).toEqual(
      refused("LANGUAGE_OPERATION_OPEN")
    )
    expect(await outcome(ownerCalls.cancel)).toEqual(ok(null))
    expect((await migrationRow(t, migrationId)).phase).toBe("cancelled")
  }, 120_000)
})

type MigrationRaceWriter = {
  name: string
  write: (site: MigrationSite) => Promise<unknown>
}

const MIGRATION_RACE_WRITERS: MigrationRaceWriter[] = [
  {
    name: "redirects.create (fr)",
    write: (site) =>
      site.owner.mutation(api.cms.redirects.create, {
        fromPath: "/race-fr",
        toPageId: site.frPageId,
        locale: "fr",
        statusCode: 301,
      }),
  },
  {
    name: "redirects.create (en)",
    write: (site) =>
      site.owner.mutation(api.cms.redirects.create, {
        fromPath: "/race-en",
        toPageId: site.frPageId,
        locale: "en",
        statusCode: 301,
      }),
  },
  {
    name: "withdrawLocale (fr)",
    write: (site) => withdrawFr(site, site.frPageId),
  },
  {
    name: "menus.saveCanonical",
    write: async (site) =>
      site.owner.mutation(api.cms.menus.saveCanonical, {
        slug: MENU_SLUG,
        locale: "en",
        nav: DOCS_NAV(),
      }),
  },
]

describe("M05 P12b default migration races (enumeration half)", () => {
  test("a writer before or between enumeration steps restarts the generation; after enumeration it stales review", async () => {
    for (const writer of MIGRATION_RACE_WRITERS) {
      // Writer after start, before the first step.
      {
        const site = await migrationSite()
        const migrationId = await startMigration(site)
        await writer.write(site)
        await stepMigration(site.t, migrationId)
        expect({
          writer: writer.name,
          generation: (await migrationRow(site.t, migrationId)).generation,
        }).toEqual({ writer: writer.name, generation: 2 })
        const { migration } = await runMigration(site.t, migrationId)
        expect({ writer: writer.name, phase: migration.phase }).toEqual({
          writer: writer.name,
          phase: "validating",
        })
      }
      // Writer between steps, and writer after enumeration completed.
      {
        const site = await migrationSite()
        const migrationId = await startMigration(site)
        await stepMigration(site.t, migrationId)
        await writer.write(site)
        await stepMigration(site.t, migrationId)
        expect({
          writer: writer.name,
          generation: (await migrationRow(site.t, migrationId)).generation,
          rows: (await migrationRoutes(site.t, migrationId, 2)).length,
        }).toEqual({ writer: writer.name, generation: 2, rows: 0 })
        await runMigration(site.t, migrationId)
        // A repeated write of the same writer can refuse (the rule exists, the
        // Page is withdrawn), so the post-enumeration move is a fresh rule.
        await site.owner.mutation(api.cms.redirects.create, {
          fromPath: "/race-after",
          toPageId: site.frPageId,
          locale: "en",
          statusCode: 301,
        })
        const moved = await migrationRow(site.t, migrationId)
        const listing = await listMigrationPage(
          site.owner,
          migrationId,
          moved.generation,
          0
        )
        expect({ writer: writer.name, listing }).toEqual({
          writer: writer.name,
          listing: { stale: true },
        })
      }
    }
  }, 300_000)
})

describe("M05 P11c bounded default migration workers (enumeration cells)", () => {
  test("dense exact claim buckets continue within 92 queries and 112 documents, retaining archives", async () => {
    const site = await migrationSite(),
      { t } = site
    const source = await seedLocaleStates(site, "en", [
      "/dense-address",
      "/archive-target",
      "/archived-source",
    ])
    const trash = await seedLocaleStates(
      site,
      "fr",
      Array.from({ length: 100 }, () => "/dense-address")
    )
    const archivedTarget = (
      await seedLocaleStates(site, "fr", ["/archive-target"])
    )[0]!
    await seedLocaleHistorical(
      site,
      "fr",
      Array.from({ length: 100 }, () => ({
        pageId: site.frPageId,
        fromPath: "/dense-address",
      }))
    )
    await t.run(async (ctx) => {
      for (const pageId of [...trash, archivedTarget, source[2]!]) {
        const lifecycle = await ctx.db
          .query("pagePublicationPageStates")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique()
        await ctx.db.patch("pagePublicationPageStates", lifecycle!._id, {
          lifecycleState: trash.includes(pageId) ? "trashed" : "archived",
        })
      }
      for (const route of await ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) =>
          q.eq("locale", "fr").eq("fromPath", "/dense-address")
        )
        .take(101))
        await ctx.db.patch("pageHistoricalLocaleRoutes", route._id, {
          releasedAt: FIXED_NOW,
        })
    })
    const id = await startMigration(site)
    let sawContinuation = false
    let refusedDense = false
    for (let guard = 0; guard < 400; guard++) {
      const row = await migrationRow(t, id)
      if (row.phase !== "enumerating") break
      if (row.cursor && JSON.parse(row.cursor).claims?.scan?.seen >= 16)
        sawContinuation = true
      if (
        !refusedDense &&
        row.cursor &&
        JSON.parse(row.cursor).claims?.scan?.seen >= 16
      ) {
        const failed = vi
          .spyOn(defaultMigrationSeam, "paginate")
          .mockRejectedValueOnce(new Error("InvalidCursor"))
        try {
          await stepMigration(t, id)
        } finally {
          failed.mockRestore()
        }
        expect((await migrationRow(t, id)).generation).toBe(row.generation + 1)
        refusedDense = true
        continue
      }
      const used = await t.run(async (ctx) => {
        await stepDefaultMigrationInTransaction(ctx, id, row.generation)
        return usedMetrics(ctx)
      })
      expect(used.databaseQueries).toBeLessThanOrEqual(92)
      expect(used.documentsRead).toBeLessThanOrEqual(112)
    }
    expect((await migrationRow(t, id)).phase).toBe("validating")
    expect(sawContinuation).toBe(true)
    expect(refusedDense).toBe(true)
    const rows = await migrationRoutes(
      t,
      id,
      (await migrationRow(t, id)).generation
    )
    expect(rows.find((row) => row.fromPath === "/dense-address")).toMatchObject(
      { pageId: source[0] }
    )
    expect(
      rows.find((row) => row.fromPath === "/dense-address")?.shadow
    ).toBeUndefined()
    expect(
      rows.find((row) => row.fromPath === "/archive-target")
    ).toMatchObject({ shadow: "to_current" })
    expect(
      rows.find((row) => row.fromPath === "/archived-source")
    ).toMatchObject({ pageId: source[2] })
  }, 120_000)
  test("restoring withdrawn history records released claims and retires uncontested arrivals", async () => {
    const site = await migrationSite(),
      { t, owner, aboutId } = site
    const selected = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", aboutId).eq("locale", "en")
        )
        .unique()
    )
    await owner.mutation(api.cms.publication.withdrawLocale, {
      pageId: aboutId,
      locale: "en",
      expectedSnapshotId: selected!.currentSnapshotId!,
      expectedPublicGeneration: selected!.publicGeneration,
      expectedLifecycleGeneration: 1,
    })
    await owner.mutation(api.cms.publication.softDeletePage, {
      pageId: aboutId,
      expectedLifecycleGeneration: 1,
    })
    await seedLocaleStates(site, "en", ["/claimed-former"])
    await t.run(async (ctx) => {
      for (const fromPath of ["/claimed-former", "/free-former"])
        await ctx.db.insert("pageHistoricalLocaleRoutes", {
          pageId: aboutId,
          locale: "en",
          fromPath,
          createdFromSnapshotId: selected!.currentSnapshotId!,
          createdAt: FIXED_NOW,
        })
    })
    const pointer = await storePointedGeneration(site, [
      { fromPath: "/free-former", pageId: site.frPageId, locale: "fr" },
    ])
    void pointer
    const counters = () =>
      t.run((ctx) =>
        ctx.db
          .query("siteLanguageFreshness")
          .withIndex("by_scope_and_locale", (q) =>
            q.eq("scope", "locale").eq("locale", "en")
          )
          .unique()
      )
    const before = await counters()
    await owner.mutation(api.cms.publication.restoreSoftDeletedPage, {
      pageId: aboutId,
      expectedLifecycleGeneration: 2,
    })
    expect((await counters())!.routeClaimVersion).toBe(
      (before?.routeClaimVersion ?? 0) + 1
    )
    const history = await t.run((ctx) =>
      ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", aboutId).eq("locale", "en")
        )
        .take(100)
    )
    expect(
      history.find((row) => row.fromPath === "/claimed-former")?.releasedAt
    ).toEqual(expect.any(Number))
    const routes = await t.run((ctx) =>
      ctx.db.query("siteDefaultLanguageRoutes").collect()
    )
    expect(routes.find((row) => row.fromPath === "/free-former")).toMatchObject(
      { retiredReason: "to_historical", retiredAt: expect.any(Number) }
    )
  }, 120_000)
  test("every enumeration step stays within its phase's ceiling for all seven metrics", async () => {
    const site = await migrationSite()
    const { t, aboutId, frPageId } = site
    const locales = [...SUPPORTED_LOCALES]
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(settings._id, { enabledLocales: locales })
      await ctx.db.patch(authority._id, { enabledLocales: locales })
    })
    // Uncontested paths make every candidate cost all four point reads.
    await seedLocaleStates(
      site,
      "en",
      Array.from({ length: 120 }, (_, i) => `/current-${i}`)
    )
    await seedLocaleHistorical(
      site,
      "en",
      Array.from({ length: 60 }, (_, i) => ({
        pageId: aboutId,
        fromPath: `/old-${i}`,
      }))
    )
    // A dense pointed generation, with paths at the route-row maximum.
    const long = (i: number) =>
      `/${String(i).padStart(4, "0")}${"x".repeat(DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES - 5)}`
    await storePointedGeneration(
      site,
      Array.from({ length: 90 }, (_, i) => ({
        fromPath: long(i),
        pageId: frPageId,
        locale: "fr",
      }))
    )
    await seedRedirects(site, [
      ...Array.from({ length: 30 }, (_, i) => ({
        fromPath: `/rule-en-${i}`,
        locale: "en",
      })),
      ...Array.from({ length: 30 }, (_, i) => ({
        fromPath: `/rule-fr-${i}`,
        locale: "fr",
      })),
    ])
    // One menu with more than 50 missing `fr` labels: 10 × (5 + 2) = 70.
    await seedMenu(site, "wide", menuNav(10, 5, ["en"]))

    const migrationId = await startMigration(site)
    const steps: (Used & { phase: string })[] = []
    for (let guard = 0; guard < 400; guard += 1) {
      const row = await migrationRow(t, migrationId)
      if (row.phase !== "enumerating") break
      // Only the step and the metrics read share this transaction.
      const used = await t.run(async (ctx) => {
        await runDefaultMigrationStep(ctx, migrationId, row.generation)
        return usedMetrics(ctx)
      })
      steps.push({ phase: row.cursorPhase!, ...used })
    }
    const migration = await migrationRow(t, migrationId)
    expect(migration).toMatchObject({ phase: "validating", generation: 1 })
    expect(migration.counts).toMatchObject({
      rows: 2 + 120 + 60 + 90,
      manualRulesShifted: 30,
      manualRulesUnprefixed: 30,
    })
    expect(migration.counts.blockers).toBeGreaterThanOrEqual(70)
    expect(new Set(steps.map((step) => step.phase))).toEqual(
      new Set([
        "old_default_current",
        "old_default_historical",
        "carried",
        "old_default_manual_rules",
        "new_default_manual_rules",
        "menus",
      ])
    )

    const common = {
      functionsScheduled: 1,
      bytesRead: 4 * MIB,
      bytesWritten: 1 * MIB,
      scheduledFunctionArgsBytes: 64 * KIB,
    }
    const route = {
      databaseQueries: 92,
      documentsRead: 112,
      documentsWritten: 23,
      ...common,
    }
    const manual = {
      databaseQueries: 35,
      documentsRead: 43,
      documentsWritten: 2,
      ...common,
    }
    const ceilings: Record<string, Used> = {
      old_default_current: route,
      old_default_historical: route,
      carried: route,
      old_default_manual_rules: manual,
      new_default_manual_rules: manual,
      menus: {
        databaseQueries: 8,
        documentsRead: 8,
        documentsWritten: 2,
        ...common,
      },
    }
    const worst: Record<string, Used> = {}
    for (const { phase, ...used } of steps) {
      const prior = worst[phase]
      worst[phase] = prior
        ? (Object.fromEntries(
            METRICS.map((metric) => [
              metric,
              Math.max(prior[metric], used[metric]),
            ])
          ) as Used)
        : used
    }
    for (const [phase, used] of Object.entries(worst)) {
      for (const metric of METRICS) {
        expect({
          phase,
          metric,
          within: used[metric] <= ceilings[phase]![metric],
        }).toEqual({
          phase,
          metric,
          within: true,
        })
      }
    }
    // Exact buckets continue separately; retain the original query ceiling.
    expect(worst.old_default_current!.databaseQueries).toBeLessThanOrEqual(92)
    // A point read that finds nothing reads no document, so uncontested
    // candidates reach the query cell but not the document cell.
    // Measured (C3b): queries 92 / 92 / 92 / 17 / 35 / 8, documents read
    // 28 / 27 / 27 / 15 / 15 / 7, bytes read at most 55 KiB. The query cells
    // have no headroom, like the preview's selections step.
    expect(worst.menus!.databaseQueries).toBeLessThanOrEqual(8)
  }, 300_000)
})

describe("M05 P16 carried rows over target-scoped manual rules", () => {
  test("a served carried row at a path with an N-scoped rule marks the rule shadowed", async () => {
    const site = await migrationSite()
    const { t, aboutId } = site
    await storePointedGeneration(site, [
      { fromPath: "/kept", pageId: aboutId, locale: "nl" },
    ])
    const [keptRule] = await seedRedirects(site, [
      { fromPath: "/kept", locale: "fr" },
    ])
    const migrationId = await startMigration(site)
    const { migration } = await runMigration(t, migrationId)
    expect(
      (await migrationRoutes(t, migrationId, 1))
        .filter((row) => row.origin === "carried")
        .map(routeView)
    ).toEqual([
      {
        fromPath: "/kept",
        pageId: aboutId,
        locale: "nl",
        origin: "carried",
        manualRule: "shadowed",
      },
    ])
    expect(migration.counts).toMatchObject({
      manualRulesShadowed: 1,
      manualRulesUnprefixed: 0,
    })
    const ruleItems = (await migrationPages(t, migrationId, 1))
      .flatMap((page) => page.items)
      .filter((item) => item.kind === "manual_rule")
    expect(ruleItems).toEqual([
      {
        kind: "manual_rule",
        ruleId: keptRule,
        fromPath: "/kept",
        destination: { kind: "page", pageId: site.frPageId },
        statusCode: 301,
        status: "shadowed",
      },
    ])
  }, 120_000)
})

// ─── M05 C3c.1: validation and cancel ───────────────────────────────────────

async function scheduledSteps(t: T) {
  return t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect())
}

function continueMigration(
  site: Pick<Site, "owner">,
  migrationId: MigrationId,
  expectedGeneration: number
) {
  return site.owner.mutation(
    api.cms.multilingual.continueDefaultLanguageMigration,
    { migrationId, expectedGeneration }
  )
}

function cancelMigration(
  caller: Pick<Caller, "mutation">,
  migrationId: MigrationId,
  expectedGeneration: number
) {
  return caller.mutation(api.cms.multilingual.cancelDefaultLanguageMigration, {
    migrationId,
    expectedGeneration,
  })
}

/** Enumerates to `validating`; `paths` more `en` current routes first. */
async function validatingMigration(paths: readonly string[] = []) {
  const site = await migrationSite()
  if (paths.length > 0) await seedLocaleStates(site, "en", paths)
  const migrationId = await startMigration(site)
  const { migration } = await runMigration(site.t, migrationId)
  expect(migration.phase).toBe("validating")
  return { site, migrationId }
}

const MIGRATION_CANCEL_PATCH =
  "patch siteDefaultLanguageMigrations {cancelledAt,cursor,phase,updatedAt}"
const MIGRATION_AUTHORITY_CANCEL_PATCH =
  "patch siteLanguageAuthority {activeDefaultMigrationId,updatedAt}"

describe("M05 C3c.1 default migration validation", () => {
  test("enumeration schedules validation, which seals the manifest and sets ready; ready continues without writing", async () => {
    const site = await migrationSite()
    const { t, owner } = site
    const migrationId = await startMigration(site)
    // The step that enters `validating` schedules validation (ledger C3c.1).
    let entryScheduled = -1
    for (let guard = 0; guard < 100; guard += 1) {
      if ((await migrationRow(t, migrationId)).phase !== "enumerating") break
      const before = (await scheduledSteps(t)).length
      await stepMigration(t, migrationId)
      entryScheduled = (await scheduledSteps(t)).length - before
    }
    expect(entryScheduled).toBe(1)
    expect((await scheduledSteps(t)).at(-1)).toMatchObject({
      name: "cms/multilingual:stepDefaultLanguageMigration",
      args: [{ migrationId, generation: 1 }],
    })
    const validating = await migrationRow(t, migrationId)
    expect(validating).toMatchObject({
      phase: "validating",
      cursorPhase: "validation",
    })
    expect(validating.cursor).toBeUndefined()
    expect(validating.disclosurePageCount).toBeGreaterThan(0)

    const validationReceipt = await owner.mutation(async (ctx) => ({
      now: Date.now(),
      result: await ctx.runMutation(
        api.cms.multilingual.continueDefaultLanguageMigration,
        { migrationId, expectedGeneration: 1 }
      ),
    }))
    expect(validationReceipt.result).toEqual({
      kind: "ready",
      generation: 1,
      readinessVersion: 1,
    })
    const ready = await migrationRow(t, migrationId)
    expect(ready).toMatchObject({
      phase: "ready",
      cursorPhase: "validation",
      generation: 1,
      counts: validating.counts,
      digest: validating.digest,
      disclosurePageCount: validating.disclosurePageCount,
      reviewedThroughOrdinal: -1,
      manifest: {
        generation: 1,
        readinessVersion: 1,
        captured: validating.captured,
        counts: validating.counts,
        digest: validating.digest,
        validatedAt: validationReceipt.now,
      },
    })
    expect(ready.cursor).toBeUndefined()
    // Validation writes no route row, no page and no authority field.
    expect(await authorityRow(t)).toMatchObject({
      activeDefaultMigrationId: migrationId,
    })
    expect(
      await owner.query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({
      openOperation: { kind: "default_migration", phase: "ready" },
      defaultMigration: { phase: "ready", generation: 1 },
    })

    // A `ready` step with equal tokens reports readiness and writes nothing.
    const scheduledBefore = (await scheduledSteps(t)).length
    expect(
      await refusalWritesNothing(t, () =>
        continueMigration(site, migrationId, 1)
      )
    ).toEqual(ok({ kind: "ready", generation: 1, readinessVersion: 1 }))
    expect(
      await refusalWritesNothing(t, () => stepMigration(t, migrationId))
    ).toEqual(ok(null))
    expect((await scheduledSteps(t)).length).toBe(scheduledBefore)
    // Receipts still work on a `ready` generation.
    const [page] = await migrationPages(t, migrationId, 1)
    expect(
      await recordMigrationReview(owner, migrationId, 1, 0, page!.digest)
    ).toMatchObject({ stale: false, reviewedThroughOrdinal: 0 })

    // A generation with no disclosure page seals the empty chain digest.
    const second = await validatingMigration()
    await second.site.t.run((ctx) =>
      ctx.db.patch(second.migrationId, {
        digest: undefined,
        disclosurePageCount: 0,
      })
    )
    await stepMigration(second.site.t, second.migrationId)
    expect(
      (await migrationRow(second.site.t, second.migrationId)).manifest
    ).toMatchObject({ digest: DISCLOSURE_CHAIN_EMPTY_DIGEST })
  }, 120_000)

  test("blockers and a missing home stop validation and write nothing", async () => {
    // Menu blockers (the corpus's `docs` menu has no `fr` text).
    {
      const site = await enumerationCorpus()
      const { t } = site
      const migrationId = await startMigration(site)
      const { migration } = await runMigration(t, migrationId)
      expect(migration.counts.blockers).toBeGreaterThan(0)
      expect(
        await refusalWritesNothing(t, () =>
          continueMigration(site, migrationId, 1)
        )
      ).toEqual(ok({ kind: "blocked", blockers: migration.counts.blockers }))
      const scheduledBefore = (await scheduledSteps(t)).length
      expect(
        await refusalWritesNothing(t, () => stepMigration(t, migrationId))
      ).toEqual(ok(null))
      // A blocked migration is not rescheduled.
      expect((await scheduledSteps(t)).length).toBe(scheduledBefore)
    }
    // A `route_path_too_long` blocker (residual 2.2) blocks the same way.
    {
      const site = await migrationSite()
      const { t } = site
      await seedLocaleStates(site, "en", [
        `/${"x".repeat(DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES)}`,
      ])
      const migrationId = await startMigration(site)
      const { migration } = await runMigration(t, migrationId)
      expect(migration.counts.blockers).toBe(1)
      expect(
        await refusalWritesNothing(t, () =>
          continueMigration(site, migrationId, 1)
        )
      ).toEqual(ok({ kind: "blocked", blockers: 1 }))
    }
    // The home rule is re-checked live on the last validation page. A home
    // change moves no captured counter, so only this re-check sees it.
    {
      const { site, migrationId } = await validatingMigration()
      const { t, homeEnId, homeFrId } = site
      const setHome = (homePageId: Id<"pages">) =>
        t.run(async (ctx) => {
          const settings = (await ctx.db.query("siteSettings").unique())!
          await ctx.db.patch(settings._id, { homePageId })
        })
      await setHome(homeEnId)
      expect(
        await refusalWritesNothing(t, () =>
          continueMigration(site, migrationId, 1)
        )
      ).toEqual(
        ok({ kind: "blocked", code: "DEFAULT_MIGRATION_TARGET_HOME_MISSING" })
      )
      await setHome(homeFrId)
      expect(await continueMigration(site, migrationId, 1)).toMatchObject({
        kind: "ready",
      })
    }
  }, 120_000)

  test("validation pages the generation, halves or restarts like enumeration, and fails closed on an inconsistent generation", async () => {
    const extra = Array.from({ length: 150 }, (_, i) => `/v-${i}`)
    const { site, migrationId } = await validatingMigration(extra)
    const { t } = site
    const validating = await migrationRow(t, migrationId)
    const rows = validating.counts.rows
    expect(rows).toBeGreaterThan(2 * DEFAULT_MIGRATION_VALIDATION_BATCH)

    const paginate = vi.spyOn(defaultMigrationSeam, "paginate")
    try {
      await stepMigration(t, migrationId)
      let cursor = JSON.parse((await migrationRow(t, migrationId)).cursor!)
      expect(cursor.tally.rows).toBe(DEFAULT_MIGRATION_VALIDATION_BATCH)
      expect(typeof cursor.page).toBe("string")
      expect(typeof cursor.last).toBe("string")
      await stepMigration(t, migrationId)
      cursor = JSON.parse((await migrationRow(t, migrationId)).cursor!)
      expect(cursor.tally.rows).toBe(2 * DEFAULT_MIGRATION_VALIDATION_BATCH)
      expect(paginate).toHaveBeenCalledTimes(2)
    } finally {
      paginate.mockRestore()
    }
    const midway = await migrationRow(t, migrationId)
    expect(midway).toMatchObject({ phase: "validating", generation: 1 })

    const realPaginate =
      defaultMigrationSeam.paginate.bind(defaultMigrationSeam)
    const realMetrics = defaultMigrationSeam.metrics.bind(defaultMigrationSeam)
    const halvedTo = async (run: () => Promise<void>, size: number) => {
      const before = await migrationRow(t, migrationId)
      await run()
      const after = await migrationRow(t, migrationId)
      const { size: afterSize, ...afterCursor } = JSON.parse(after.cursor!)
      const { size: beforeSize, ...beforeCursor } = JSON.parse(before.cursor!)
      void beforeSize
      expect({
        phase: after.phase,
        generation: after.generation,
        cursor: afterCursor,
        size: afterSize,
      }).toEqual({
        phase: "validating",
        generation: 1,
        cursor: beforeCursor,
        size,
      })
    }
    const split = vi
      .spyOn(defaultMigrationSeam, "paginate")
      .mockImplementationOnce(async (query, options) => ({
        ...(await realPaginate(query, options)),
        pageStatus: "SplitRequired" as const,
      }))
    await halvedTo(() => stepMigration(t, migrationId), 32)
    split.mockRestore()
    let calls = 0
    const crossing = vi
      .spyOn(defaultMigrationSeam, "metrics")
      .mockImplementation(async (ctx) => {
        const metrics = await realMetrics(ctx)
        calls += 1
        // The page check, then items 1–2; the second item crosses.
        if (calls !== 3) return metrics
        return {
          ...metrics,
          bytesRead: { used: 5 * MIB, remaining: 11 * MIB },
        }
      })
    await halvedTo(() => stepMigration(t, migrationId), 16)
    crossing.mockRestore()

    // Half-size pages resume and the generation still validates in full.
    for (let guard = 0; guard < 40; guard += 1) {
      if ((await migrationRow(t, migrationId)).phase !== "validating") break
      await stepMigration(t, migrationId)
    }
    expect(await migrationRow(t, migrationId)).toMatchObject({
      phase: "ready",
      generation: 1,
      manifest: { generation: 1, readinessVersion: 1, counts: { rows } },
    })

    // A validation cursor that cannot be decoded restarts the generation.
    {
      const { site: other, migrationId: otherId } = await validatingMigration()
      for (const [cursor, generation] of [
        ["not json", 2],
        [JSON.stringify({ page: null }), 3],
        [JSON.stringify({ page: null, tally: { rows: -1 } }), 4],
      ] as const) {
        await other.t.run(async (ctx) => {
          const row = (await ctx.db.get(otherId))!
          if (row.phase !== "validating") {
            // Re-enumerate the restarted generation first.
            return
          }
          await ctx.db.patch(otherId, { cursor })
        })
        await stepMigration(other.t, otherId)
        expect(await migrationRow(other.t, otherId)).toMatchObject({
          phase: "enumerating",
          generation,
          reviewedThroughOrdinal: -1,
        })
        await runMigration(other.t, otherId)
      }
    }

    // A generation whose stored rows disagree with its counts fails closed.
    {
      const { site: other, migrationId: otherId } = await validatingMigration([
        "/c-1",
        "/c-2",
      ])
      const t2 = other.t
      const [first, second] = (await migrationRoutes(t2, otherId, 1)).filter(
        (row) => row.shadow === undefined
      )
      const corrupt = async (
        code: string,
        damage: (ctx: MutationCtx) => Promise<unknown>,
        repair: (ctx: MutationCtx) => Promise<unknown>
      ) => {
        await t2.run(async (ctx) => {
          await damage(ctx)
        })
        expect({
          code,
          result: await refusalWritesNothing(t2, () =>
            stepMigration(t2, otherId)
          ),
        }).toEqual({ code, result: refused(code) })
        await t2.run(async (ctx) => {
          await repair(ctx)
        })
      }
      await corrupt(
        "DEFAULT_MIGRATION_GENERATION_INCONSISTENT",
        (ctx) => ctx.db.delete(first!._id),
        (ctx) => {
          const { _id, _creationTime, ...row } = first!
          void _id
          void _creationTime
          return ctx.db.insert("siteDefaultLanguageRoutes", row)
        }
      )
      let duplicateId: Id<"siteDefaultLanguageRoutes"> | undefined
      await corrupt(
        "DEFAULT_MIGRATION_ROUTE_DUPLICATE",
        async (ctx) => {
          const { _id, _creationTime, ...row } = second!
          void _id
          void _creationTime
          duplicateId = await ctx.db.insert("siteDefaultLanguageRoutes", row)
        },
        (ctx) => ctx.db.delete(duplicateId!)
      )
      await corrupt(
        "DEFAULT_MIGRATION_GENERATION_INCONSISTENT",
        (ctx) => ctx.db.patch(second!._id, { shadow: "to_current" }),
        (ctx) => ctx.db.patch(second!._id, { shadow: undefined })
      )
      await corrupt(
        "DEFAULT_MIGRATION_GENERATION_INCONSISTENT",
        (ctx) =>
          ctx.db.patch(second!._id, {
            shadow: "to_historical",
            manualRule: undefined,
          }),
        (ctx) => ctx.db.patch(second!._id, { shadow: undefined })
      )
      await corrupt(
        "DEFAULT_MIGRATION_GENERATION_INCONSISTENT",
        (ctx) => ctx.db.patch(second!._id, { manualRule: "shadowed" }),
        (ctx) => ctx.db.patch(second!._id, { manualRule: undefined })
      )
      await corrupt(
        "DEFAULT_MIGRATION_GENERATION_INCONSISTENT",
        (ctx) =>
          ctx.db.patch(second!._id, {
            shadow: "to_current",
            manualRule: "shadowed",
          }),
        (ctx) =>
          ctx.db.patch(second!._id, {
            shadow: undefined,
            manualRule: undefined,
          })
      )
      // Repaired, it validates.
      await stepMigration(t2, otherId)
      expect((await migrationRow(t2, otherId)).phase).toBe("ready")
    }

    // A row both shadowed and marking a manual rule fails closed even when
    // every tally still matches: the mark moves from a served row to the
    // shadowed one.
    {
      const other = await migrationSite()
      const t3 = other.t
      await seedLocaleStates(other, "en", ["/marked"])
      await seedRedirects(other, [{ fromPath: "/marked", locale: "fr" }])
      const otherId = await startMigration(other)
      await runMigration(t3, otherId)
      const routes = await migrationRoutes(t3, otherId, 1)
      const marked = routes.find((row) => row.manualRule === "shadowed")!
      const shadowed = routes.find((row) => row.shadow !== undefined)!
      expect(marked.fromPath).toBe("/marked")
      await t3.run(async (ctx) => {
        await ctx.db.patch(marked._id, { manualRule: undefined })
        await ctx.db.patch(shadowed._id, { manualRule: "shadowed" })
      })
      expect(
        await refusalWritesNothing(t3, () => stepMigration(t3, otherId))
      ).toEqual(refused("DEFAULT_MIGRATION_GENERATION_INCONSISTENT"))
    }
  }, 300_000)
})

describe("M05 P6 default migration cancel", () => {
  test("cancel from each open phase writes only the migration and the authority, and changes no public state", async () => {
    for (const phase of ["enumerating", "validating", "ready"] as const) {
      const site = await migrationSite()
      const { t, owner } = site
      const migrationId = await startMigration(site)
      if (phase !== "enumerating") await runMigration(t, migrationId)
      if (phase === "ready") await stepMigration(t, migrationId)
      expect({
        phase,
        actual: (await migrationRow(t, migrationId)).phase,
      }).toEqual({ phase, actual: phase })
      const before = await everyRow(t)
      const authorityBefore = await authorityRow(t)
      const scheduledBefore = (await scheduledSteps(t)).length
      let cancelledAt: number | undefined
      const { result, sets } = await recordSyscalls(() =>
        outcome(() =>
          owner.mutation(async (ctx) => {
            cancelledAt = Date.now()
            return ctx.runMutation(
              api.cms.multilingual.cancelDefaultLanguageMigration,
              { migrationId, expectedGeneration: 1 }
            )
          })
        )
      )
      expect({ phase, result, writes: sets.writes }).toEqual({
        phase,
        result: ok(null),
        writes: [
          MIGRATION_CANCEL_PATCH,
          MIGRATION_AUTHORITY_CANCEL_PATCH,
          "schedule cms/languageLifecycle:collectDefaultLanguageRoutes",
        ],
      })
      const after = await everyRow(t)
      for (const table of [
        "siteDefaultLanguageMigrations",
        "siteLanguageAuthority",
      ]) {
        delete before[table]
        delete after[table]
      }
      // Every other row, including settings, freshness, route rows, pages and
      // Publication, is unchanged.
      expect({ phase, after }).toEqual({ phase, after: before })
      const { activeDefaultMigrationId, updatedAt, ...authorityRest } =
        authorityBefore
      void activeDefaultMigrationId
      void updatedAt
      const authorityAfter = await authorityRow(t)
      expect(authorityAfter.activeDefaultMigrationId).toBeUndefined()
      expect(authorityAfter).toMatchObject(authorityRest)
      const cancelled = await migrationRow(t, migrationId)
      expect(cancelledAt).toEqual(expect.any(Number))
      expect(cancelled).toMatchObject({
        phase: "cancelled",
        cancelledAt,
        generation: 1,
      })
      expect(cancelled.cursor).toBeUndefined()
      // Cancel schedules exactly one collection and no continuation (ledger
      // C3c.2b; closes the C3c.1 Deferral).
      const scheduledAfter = await scheduledSteps(t)
      expect({ phase, added: scheduledAfter.length - scheduledBefore }).toEqual(
        { phase, added: 1 }
      )
      expect(scheduledAfter.at(-1)).toMatchObject({
        name: "cms/languageLifecycle:collectDefaultLanguageRoutes",
        args: [{ migrationId }],
      })

      // The migration is closed everywhere: state, steps, owner calls.
      expect(
        await owner.query(api.cms.multilingual.getMultilingualState, {})
      ).toMatchObject({
        lifecycleState: "S4",
        openOperation: null,
        defaultMigration: null,
      })
      expect(
        await refusalWritesNothing(t, () => stepMigration(t, migrationId))
      ).toEqual(ok(null))
      expect(
        await refusalWritesNothing(t, () =>
          continueMigration(site, migrationId, 1)
        )
      ).toEqual(ok({ kind: "noop" }))
      expect(await listMigrationPage(owner, migrationId, 1, 0)).toEqual({
        stale: true,
      })
      // A new migration can start at once.
      const nextId = await startMigration(site)
      expect(nextId).not.toBe(migrationId)
    }
  }, 120_000)

  test("cancel refuses in order and writes nothing", async () => {
    const site = await migrationSite()
    const { t, owner } = site
    const migrationId = await startMigration(site)
    await runMigration(t, migrationId)
    const cancel =
      (id: MigrationId, generation = 1) =>
      () =>
        cancelMigration(owner, id, generation)

    const goneId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "enumerating",
    })
    await t.run((ctx) => ctx.db.delete(goneId))
    expect(await refusalWritesNothing(t, cancel(goneId))).toEqual(
      refused("LANGUAGE_PREVIEW_MISMATCH")
    )
    // Another generation, then migrations that are not the open one.
    for (const generation of [0, 2]) {
      expect(
        await refusalWritesNothing(t, cancel(migrationId, generation))
      ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
    }
    for (const phase of [
      "enumerating",
      "validating",
      "ready",
      "committed",
      "cancelled",
    ] as const) {
      const otherId = await seedDefaultMigration(t, {
        fromLocale: "en",
        toLocale: "fr",
        phase,
      })
      expect({
        phase,
        result: await refusalWritesNothing(t, cancel(otherId)),
      }).toEqual({ phase, result: refused("LANGUAGE_OPERATION_STALE") })
    }
    // An authority naming a closed migration is invalid state.
    await t.run((ctx) => ctx.db.patch(migrationId, { phase: "committed" }))
    expect(await refusalWritesNothing(t, cancel(migrationId))).toEqual(
      refused("SITE_LANGUAGE_AUTHORITY_INVALID")
    )
    await t.run((ctx) => ctx.db.patch(migrationId, { phase: "validating" }))
    // So is a single authority naming a migration (C3a).
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { mode: "single" })
    })
    expect(await refusalWritesNothing(t, cancel(migrationId))).toEqual(
      refused("SITE_LANGUAGE_AUTHORITY_INVALID")
    )
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { mode: "multilingual" })
    })
    // Outside a multilingual authority there is nothing to cancel.
    for (const state of ["V0S", "CUR"] as const) {
      const other = await inventorySite(state)
      const id = await seedDefaultMigration(other.t, {
        fromLocale: "en",
        toLocale: "fr",
        phase: "enumerating",
      })
      expect({
        state,
        result: await refusalWritesNothing(other.t, () =>
          cancelMigration(other.owner, id, 1)
        ),
      }).toEqual({ state, result: refused("CMS_MODULE_DISABLED") })
    }
    // The open migration still cancels.
    expect(await outcome(cancel(migrationId))).toEqual(ok(null))
    expect(await outcome(cancel(migrationId))).toEqual(
      refused("LANGUAGE_OPERATION_STALE")
    )
  }, 120_000)
})

describe("M05 P12b default migration races (validation order)", () => {
  test("a writer before validation, between its pages, or after ready restarts the generation; readiness never repeats", async () => {
    const extra = Array.from(
      { length: DEFAULT_MIGRATION_VALIDATION_BATCH + 6 },
      (_, i) => `/r-${i}`
    )
    const readied: string[] = []
    for (const writer of MIGRATION_RACE_WRITERS) {
      // Writer after enumeration, before validation.
      {
        const { site, migrationId } = await validatingMigration()
        await writer.write(site)
        expect({
          writer: writer.name,
          result: await continueMigration(site, migrationId, 1),
        }).toEqual({
          writer: writer.name,
          result: { kind: "restarted", generation: 2 },
        })
        expect(
          (await migrationRow(site.t, migrationId)).manifest
        ).toBeUndefined()
      }
      // Writer between validation pages.
      {
        const { site, migrationId } = await validatingMigration(extra)
        await stepMigration(site.t, migrationId)
        expect(
          JSON.parse((await migrationRow(site.t, migrationId)).cursor!).tally
            .rows
        ).toBe(DEFAULT_MIGRATION_VALIDATION_BATCH)
        await writer.write(site)
        await stepMigration(site.t, migrationId)
        expect({
          writer: writer.name,
          migration: await migrationRow(site.t, migrationId),
        }).toMatchObject({
          writer: writer.name,
          migration: { phase: "enumerating", generation: 2 },
        })
      }
      // Writer after `ready`, and after a partial review.
      {
        const { site, migrationId } = await validatingMigration()
        const { t, owner } = site
        await stepMigration(t, migrationId)
        const [page] = await migrationPages(t, migrationId, 1)
        await recordMigrationReview(owner, migrationId, 1, 0, page!.digest)
        await writer.write(site)
        expect({
          writer: writer.name,
          result: await continueMigration(site, migrationId, 1),
        }).toEqual({
          writer: writer.name,
          result: { kind: "restarted", generation: 2 },
        })
        const restarted = await migrationRow(t, migrationId)
        expect(restarted).toMatchObject({
          phase: "enumerating",
          reviewedThroughOrdinal: -1,
          manifest: { generation: 1, readinessVersion: 1 },
        })
        const { migration } = await runMigration(t, migrationId)
        // A writer can add a blocker (a menu without `fr` text), which then
        // stops generation 2's validation instead.
        expect({
          writer: writer.name,
          result: await continueMigration(site, migrationId, 2),
        }).toEqual({
          writer: writer.name,
          result:
            migration.counts.blockers > 0
              ? { kind: "blocked", blockers: migration.counts.blockers }
              : { kind: "ready", generation: 2, readinessVersion: 2 },
        })
        if (migration.counts.blockers === 0) readied.push(writer.name)
      }
    }
    expect(readied).toEqual([
      "redirects.create (fr)",
      "redirects.create (en)",
      "withdrawLocale (fr)",
    ])
  }, 300_000)
})

describe("M05 P11c bounded default migration workers (validation cell)", () => {
  test("every validation step stays within the validation ceiling for all seven metrics", async () => {
    const site = await migrationSite()
    const { t } = site
    // Paths at the route-row maximum make every row as large as it can be.
    const long = (i: number) =>
      `/${String(i).padStart(4, "0")}${"v".repeat(DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES - 5)}`
    await seedLocaleStates(
      site,
      "en",
      Array.from({ length: 200 }, (_, i) => long(i))
    )
    const migrationId = await startMigration(site)
    await runMigration(t, migrationId)
    expect(await migrationRow(t, migrationId)).toMatchObject({
      phase: "validating",
      counts: { blockers: 0 },
    })

    const paginate = vi.spyOn(defaultMigrationSeam, "paginate")
    const steps: (Used & { paginated: number })[] = []
    try {
      for (let guard = 0; guard < 20; guard += 1) {
        const row = await migrationRow(t, migrationId)
        if (row.phase !== "validating") break
        const before = paginate.mock.calls.length
        const used = await t.run(async (ctx) => {
          await runDefaultMigrationStep(ctx, migrationId, row.generation)
          return usedMetrics(ctx)
        })
        steps.push({ ...used, paginated: paginate.mock.calls.length - before })
      }
    } finally {
      paginate.mockRestore()
    }
    expect(await migrationRow(t, migrationId)).toMatchObject({
      phase: "ready",
      generation: 1,
    })
    expect(steps.length).toBe(
      Math.ceil(202 / DEFAULT_MIGRATION_VALIDATION_BATCH)
    )
    const ceiling: Used = {
      databaseQueries: 135,
      documentsRead: 198,
      documentsWritten: 2,
      functionsScheduled: 1,
      bytesRead: 4 * MIB,
      bytesWritten: 1 * MIB,
      scheduledFunctionArgsBytes: 64 * KIB,
    }
    for (const [index, step] of steps.entries()) {
      expect({ index, paginated: step.paginated }).toEqual({
        index,
        paginated: 1,
      })
      for (const metric of METRICS) {
        expect({
          index,
          metric,
          within: step[metric] <= ceiling[metric],
        }).toEqual({ index, metric, within: true })
      }
    }
    const worst = Object.fromEntries(
      METRICS.map((metric) => [
        metric,
        Math.max(...steps.map((step) => step[metric])),
      ])
    ) as Used
    // Measured (C3c.1): no per-row point read, so the cell is respected with
    // wide headroom. Full pages: 8 queries, 70 documents read, 1 written,
    // ≤ 290 KiB read; the last page adds the two home-rule reads (10 queries,
    // 18 documents) and schedules nothing.
    expect(worst.databaseQueries).toBeLessThanOrEqual(10)
    expect(worst.documentsRead).toBeLessThanOrEqual(
      DEFAULT_MIGRATION_VALIDATION_BATCH + 10
    )
    expect(worst.documentsWritten).toBe(1)
  }, 300_000)
})

// ─── M05 C3c.2a: activation ─────────────────────────────────────────────────
//
// Contract Default migration step 5, M12, M15, M16, M17 and the ledger C3c.2a
// Interpretation (refusal order) and Gap (lifecycle delivery).

type ActivationArgs = {
  migrationId: MigrationId
  expectedGeneration: number
  expectedReadinessVersion: number
  expectedAuthorityVersion: number
}

async function activationArgs(
  t: T,
  migrationId: MigrationId
): Promise<ActivationArgs> {
  const row = await migrationRow(t, migrationId)
  return {
    migrationId,
    expectedGeneration: row.generation,
    expectedReadinessVersion: row.manifest?.readinessVersion ?? 0,
    expectedAuthorityVersion: await authorityVersion(t),
  }
}

function activateMigration(
  caller: Pick<Caller, "mutation">,
  args: ActivationArgs
) {
  return caller.mutation(
    api.cms.multilingual.activateDefaultLanguageMigration,
    args
  )
}

/** Records a receipt over every disclosure page of the current generation. */
async function reviewMigration(
  t: T,
  caller: Pick<Caller, "mutation">,
  migrationId: MigrationId
) {
  const { generation } = await migrationRow(t, migrationId)
  const pages = await migrationPages(t, migrationId, generation)
  for (const page of pages) {
    await recordMigrationReview(
      caller,
      migrationId,
      generation,
      page.ordinal,
      page.digest
    )
  }
  return pages.length
}

/** Steps validation until `ready`. */
async function validateMigration(t: T, migrationId: MigrationId) {
  for (let guard = 0; guard < 50; guard += 1) {
    if ((await migrationRow(t, migrationId)).phase !== "validating") break
    await stepMigration(t, migrationId)
  }
  expect((await migrationRow(t, migrationId)).phase).toBe("ready")
}

/** Enumerated, validated and fully reviewed: activation's preconditions. */
async function readyMigration(paths: readonly string[] = []) {
  const { site, migrationId } = await validatingMigration(paths)
  await validateMigration(site.t, migrationId)
  const pageCount = await reviewMigration(site.t, site.owner, migrationId)
  expect(pageCount).toBeGreaterThan(0)
  return { site, migrationId, pageCount }
}

async function lifecycleIntentRows(t: T) {
  return t.run((ctx) => ctx.db.query("siteLanguageLifecycleIntents").take(100))
}

const MIGRATION_ACTIVATE_WRITES = [
  "insert siteLanguageLifecycleIntents {attempts,capturedAuthorityVersion,createdAt,generation,locales,migrationId,operationId,operationKind,phase,status,updatedAt}",
  "patch siteDefaultLanguageMigrations {committedAt,committedAuthorityVersion,phase,updatedAt}",
  "patch siteLanguageAuthority {activeDefaultMigrationId,continuityPointer,currentLocale,updatedAt,version}",
  "patch siteSettings {defaultLocale,updatedAt}",
]

describe("M05 P6 default migration activation", () => {
  test("a validated, reviewed generation activates with four writes, no route row, and one intent; the loser of a second activation writes nothing", async () => {
    const { site, migrationId } = await readyMigration()
    const { t, owner } = site
    const args = await activationArgs(t, migrationId)
    expect(args).toMatchObject({
      expectedGeneration: 1,
      expectedReadinessVersion: 1,
    })
    const version = args.expectedAuthorityVersion + 1
    const before = await everyRow(t)
    const authorityBefore = await authorityRow(t)
    const settingsBefore = await settingsRow(t)
    const migrationBefore = await migrationRow(t, migrationId)
    const intentsBefore = await lifecycleIntentRows(t)
    const scheduledBefore = (await scheduledSteps(t)).length

    let activatedAt: number | undefined
    const { result, sets } = await recordSyscalls(() =>
      outcome(() =>
        owner.mutation(async (ctx) => {
          activatedAt = Date.now()
          return ctx.runMutation(
            api.cms.multilingual.activateDefaultLanguageMigration,
            args
          )
        })
      )
    )
    expect({ result, writes: sets.writes }).toEqual({
      result: ok({ version, locale: "fr" }),
      writes: MIGRATION_ACTIVATE_WRITES,
    })

    // M12: route rows, disclosure pages, freshness and Publication are
    // untouched; only the four control tables change.
    const after = await everyRow(t)
    for (const table of [
      "siteDefaultLanguageMigrations",
      "siteLanguageAuthority",
      "siteSettings",
      "siteLanguageLifecycleIntents",
    ]) {
      delete before[table]
      delete after[table]
    }
    expect(after).toEqual(before)

    const authority = await authorityRow(t)
    expect(activatedAt).toEqual(expect.any(Number))
    const expectedAuthority = {
      ...authorityBefore,
      currentLocale: "fr",
      version,
      continuityPointer: { migrationId, generation: 1 },
      updatedAt: activatedAt,
    }
    delete expectedAuthority.activeDefaultMigrationId
    expect(authority).toEqual(expectedAuthority)
    expect(await settingsRow(t)).toEqual({
      ...settingsBefore,
      defaultLocale: "fr",
      enabledLocales: ["en", "fr"],
      updatedAt: activatedAt,
    })
    expect(await migrationRow(t, migrationId)).toEqual({
      ...migrationBefore,
      phase: "committed",
      committedAt: activatedAt,
      committedAuthorityVersion: version,
      updatedAt: activatedAt,
    })
    const intents = await lifecycleIntentRows(t)
    expect(intents.length).toBe(intentsBefore.length + 1)
    const added = intents.filter(
      (row) => !intentsBefore.some((old) => old._id === row._id)
    )
    expect(added).toMatchObject([
      {
        operationId: `default_migration:v${version}`,
        operationKind: "default_migration",
        locales: ["en", "fr"],
        migrationId,
        generation: 1,
        capturedAuthorityVersion: version,
        phase: "tags_and_layout",
        status: "pending",
        attempts: 0,
      },
    ])
    expect((await scheduledSteps(t)).length).toBe(scheduledBefore)
    expect(
      await owner.query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({
      lifecycleState: "S4",
      version,
      defaultLocale: "fr",
      enabledLocales: ["en", "fr"],
      openOperation: null,
      defaultMigration: null,
    })

    // A competing activation with the same expectations, or with the new
    // authority version, fails the compare-and-set and writes nothing.
    for (const claim of [
      args,
      { ...args, expectedAuthorityVersion: version },
    ]) {
      expect(
        await refusalWritesNothing(t, () => activateMigration(owner, claim))
      ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
    }
    // The committed migration is closed to steps, continue and cancel.
    expect(
      await refusalWritesNothing(t, () => stepMigration(t, migrationId))
    ).toEqual(ok(null))
    expect(
      await refusalWritesNothing(t, () =>
        continueMigration(site, migrationId, 1)
      )
    ).toEqual(ok({ kind: "noop" }))
    expect(
      await refusalWritesNothing(t, () =>
        cancelMigration(owner, migrationId, 1)
      )
    ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
  }, 120_000)

  test("activation refuses in the recorded order and writes nothing", async () => {
    const { site, migrationId, pageCount } = await readyMigration()
    const { t, owner, homeEnId, homeFrId } = site
    const args = await activationArgs(t, migrationId)
    const activate =
      (claim: ActivationArgs = args) =>
      () =>
        activateMigration(owner, claim)
    const patchMigration = (
      fields: Partial<Doc<"siteDefaultLanguageMigrations">>
    ) => t.run((ctx) => ctx.db.patch(migrationId, fields))
    const setHome = (pageId: Id<"pages">) =>
      t.run(async (ctx) => {
        const settings = (await ctx.db.query("siteSettings").unique())!
        await ctx.db.patch(settings._id, { homePageId: pageId })
      })
    const migration = await migrationRow(t, migrationId)
    const manifest = migration.manifest!

    // Snapshot authority first, even for a missing migration.
    const goneId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "enumerating",
    })
    await t.run((ctx) => ctx.db.delete(goneId))
    await setCutover(t, "preparing")
    for (const claim of [args, { ...args, migrationId: goneId }]) {
      expect(await refusalWritesNothing(t, activate(claim))).toEqual(
        SNAPSHOT_AUTHORITY_REQUIRED
      )
    }
    await setCutover(t, "snapshot_active")

    // State before the migration: a missing migration under invalid state is
    // invalid, and outside a multilingual authority it is not adopted.
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { mode: "single" })
    })
    for (const claim of [args, { ...args, migrationId: goneId }]) {
      expect(await refusalWritesNothing(t, activate(claim))).toEqual(
        refused("SITE_LANGUAGE_AUTHORITY_INVALID")
      )
    }
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { mode: "multilingual" })
    })
    for (const state of ["V0S", "CUR"] as const) {
      const other = await inventorySite(state)
      const id = await seedDefaultMigration(other.t, {
        fromLocale: "en",
        toLocale: "fr",
        phase: "ready",
      })
      await other.t.run((ctx) => ctx.db.delete(id))
      const seeded = await seedDefaultMigration(other.t, {
        fromLocale: "en",
        toLocale: "fr",
        phase: "ready",
      })
      for (const target of [id, seeded]) {
        expect({
          state,
          result: await refusalWritesNothing(other.t, () =>
            activateMigration(other.owner, { ...args, migrationId: target })
          ),
        }).toEqual({ state, result: refused("CMS_MODULE_DISABLED") })
      }
    }
    expect(
      await refusalWritesNothing(t, activate({ ...args, migrationId: goneId }))
    ).toEqual(refused("LANGUAGE_PREVIEW_MISMATCH"))

    // Not the open migration, in every phase; the open one's target no longer
    // enabled; an authority naming a closed migration is invalid state.
    for (const phase of [
      "enumerating",
      "validating",
      "ready",
      "committed",
      "cancelled",
    ] as const) {
      const otherId = await seedDefaultMigration(t, {
        fromLocale: "en",
        toLocale: "fr",
        phase,
      })
      expect({
        phase,
        result: await refusalWritesNothing(
          t,
          activate({ ...args, migrationId: otherId })
        ),
      }).toEqual({ phase, result: refused("LANGUAGE_OPERATION_STALE") })
    }
    await patchAuthorityInPlace(t, { enabledLocales: ["en", "nl"] })
    expect(await refusalWritesNothing(t, activate())).toEqual(
      refused("LANGUAGE_OPERATION_STALE")
    )
    await patchAuthorityInPlace(t, { enabledLocales: ["en", "fr"] })
    await patchMigration({ phase: "committed" })
    expect(await refusalWritesNothing(t, activate())).toEqual(
      refused("SITE_LANGUAGE_AUTHORITY_INVALID")
    )
    await patchMigration({ phase: "ready" })

    // The compare-and-set, each alone and each ahead of a missing review.
    await patchMigration({ reviewedThroughOrdinal: -1 })
    const stale: [string, () => Promise<unknown>][] = [
      [
        "authority version",
        activate({
          ...args,
          expectedAuthorityVersion: args.expectedAuthorityVersion - 1,
        }),
      ],
      [
        "authority version +1",
        activate({
          ...args,
          expectedAuthorityVersion: args.expectedAuthorityVersion + 1,
        }),
      ],
      ["generation 0", activate({ ...args, expectedGeneration: 0 })],
      ["generation 2", activate({ ...args, expectedGeneration: 2 })],
      ["readiness 0", activate({ ...args, expectedReadinessVersion: 0 })],
      ["readiness 2", activate({ ...args, expectedReadinessVersion: 2 })],
    ]
    for (const [name, run] of stale) {
      expect({ name, result: await refusalWritesNothing(t, run) }).toEqual({
        name,
        result: refused("LANGUAGE_OPERATION_STALE"),
      })
    }
    const corrupt: [string, Partial<Doc<"siteDefaultLanguageMigrations">>][] = [
      ["validating", { phase: "validating" }],
      ["no manifest", { manifest: undefined }],
      ["manifest generation", { manifest: { ...manifest, generation: 2 } }],
      // Live tokens still equal the manifest; only the capture differs.
      [
        "capture differs from manifest",
        {
          captured: {
            ...migration.captured,
            site: {
              ...migration.captured.site,
              routeClaimVersion: migration.captured.site.routeClaimVersion + 1,
            },
          },
        },
      ],
      // The capture still equals live tokens; only the manifest differs.
      [
        "manifest differs from live",
        {
          manifest: {
            ...manifest,
            captured: {
              ...manifest.captured,
              to: {
                ...manifest.captured.to,
                publicationSetVersion:
                  manifest.captured.to.publicationSetVersion + 1,
              },
            },
          },
        },
      ],
    ]
    for (const [name, fields] of corrupt) {
      await patchMigration(fields)
      expect({
        name,
        result: await refusalWritesNothing(t, activate()),
      }).toEqual({ name, result: refused("LANGUAGE_OPERATION_STALE") })
      await patchMigration({
        phase: "ready",
        manifest,
        captured: migration.captured,
      })
    }

    // Review before the home rule; a receipt one page short is incomplete.
    await setHome(homeEnId)
    for (const through of [-1, pageCount - 2]) {
      await patchMigration({ reviewedThroughOrdinal: through })
      expect({
        through,
        result: await refusalWritesNothing(t, activate()),
      }).toEqual({
        through,
        result: refused("DEFAULT_MIGRATION_REVIEW_INCOMPLETE"),
      })
    }
    await patchMigration({ reviewedThroughOrdinal: pageCount - 1 })

    // The home rule before obligations.
    const enPending = await seedRelease(site, "en", "pending")
    expect(await refusalWritesNothing(t, activate())).toEqual(
      refused("DEFAULT_MIGRATION_TARGET_HOME_MISSING")
    )
    await t.run((ctx) => ctx.db.delete(enPending))
    expect(await refusalWritesNothing(t, activate())).toEqual(
      refused("DEFAULT_MIGRATION_TARGET_HOME_MISSING")
    )
    await setHome(homeFrId)

    // `pending` and `held` in the old and the new default each refuse.
    for (const locale of ["en", "fr"]) {
      for (const status of ["pending", "held"] as const) {
        const releaseId = await seedRelease(site, locale, status)
        expect({
          locale,
          status,
          result: await refusalWritesNothing(t, activate()),
        }).toEqual({
          locale,
          status,
          result: refused("LANGUAGE_LOCALE_OBLIGATIONS_PRESENT"),
        })
        await t.run((ctx) => ctx.db.delete(releaseId))
      }
    }
    // Another language's obligations do not block, and nothing above left a
    // write behind: the same claim now activates.
    await seedRelease(site, "nl", "pending")
    await seedRelease(site, "nl", "held")
    expect(await outcome(activate())).toEqual(
      ok({ version: args.expectedAuthorityVersion + 1, locale: "fr" })
    )
  }, 300_000)

  test("the receipt must reach the last disclosure page, and a generation with none needs no receipt", async () => {
    const { site, migrationId } = await readyMigration()
    const { t, owner } = site
    const args = await activationArgs(t, migrationId)
    // Constructed in place: activation reads the count, not the pages, and no
    // counter captures it.
    for (const [count, through, result] of [
      [2, 0, refused("DEFAULT_MIGRATION_REVIEW_INCOMPLETE")],
      [2, -1, refused("DEFAULT_MIGRATION_REVIEW_INCOMPLETE")],
      [3, 1, refused("DEFAULT_MIGRATION_REVIEW_INCOMPLETE")],
    ] as const) {
      await t.run((ctx) =>
        ctx.db.patch(migrationId, {
          disclosurePageCount: count,
          reviewedThroughOrdinal: through,
        })
      )
      expect({
        count,
        through,
        result: await refusalWritesNothing(t, () =>
          activateMigration(owner, args)
        ),
      }).toEqual({ count, through, result })
    }
    await t.run((ctx) =>
      ctx.db.patch(migrationId, {
        disclosurePageCount: 0,
        reviewedThroughOrdinal: -1,
      })
    )
    expect(await outcome(() => activateMigration(owner, args))).toEqual(
      ok({ version: args.expectedAuthorityVersion + 1, locale: "fr" })
    )
  }, 120_000)

  test("a first publication in another language between validation and activation, with no new-default home, refuses the home rule live", async () => {
    const { site, migrationId } = await validatingMigration()
    const { t, owner, homeEnId, homeFrId } = site
    // Nothing is current anywhere at validation, so the home rule holds
    // without a new-default home. Rows change in place; no counter moves.
    const current = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
          q.eq("hasCurrentSnapshot", true)
        )
        .collect()
      for (const row of rows) {
        await ctx.db.patch(row._id, { hasCurrentSnapshot: false })
      }
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { homePageId: homeEnId })
      return rows.map((row) => row._id)
    })
    expect(current.length).toBeGreaterThan(0)
    await validateMigration(t, migrationId)
    await reviewMigration(t, owner, migrationId)
    const args = await activationArgs(t, migrationId)

    // A first publication in `nl`, a real writer, moves only `nl` counters.
    await patchAuthorityInPlace(t, { enabledLocales: ["en", "fr", "nl"] })
    const nlPageId = await createPage(owner, "hallo", ["en", "fr", "nl"])
    await owner.mutation(
      api.cms.publication.publishLocale,
      await publishArgs(t, nlPageId, "nl")
    )
    expect(
      await t.run(async (ctx) =>
        (
          await ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_hasCurrentSnapshot_and_locale", (q) =>
              q.eq("hasCurrentSnapshot", true)
            )
            .collect()
        ).map((row) => row.locale)
      )
    ).toEqual(["nl"])
    expect(
      await refusalWritesNothing(t, () => activateMigration(owner, args))
    ).toEqual(refused("DEFAULT_MIGRATION_TARGET_HOME_MISSING"))
    expect((await migrationRow(t, migrationId)).phase).toBe("ready")

    // The tokens never moved: restoring the `fr` home lets the same claim in.
    await t.run(async (ctx) => {
      const home = (await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", homeFrId).eq("locale", "fr")
        )
        .unique())!
      await ctx.db.patch(home._id, { hasCurrentSnapshot: true })
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { homePageId: homeFrId })
    })
    expect(await outcome(() => activateMigration(owner, args))).toEqual(
      ok({ version: args.expectedAuthorityVersion + 1, locale: "fr" })
    )
  }, 120_000)
})

describe("M05 P12b default migration races (activation order)", () => {
  test("a writer before activation refuses it and the next step restarts; a writer after activation leaves it committed", async () => {
    for (const writer of MIGRATION_RACE_WRITERS) {
      {
        const { site, migrationId } = await readyMigration()
        const args = await activationArgs(site.t, migrationId)
        await writer.write(site)
        expect({
          writer: writer.name,
          result: await refusalWritesNothing(site.t, () =>
            activateMigration(site.owner, args)
          ),
        }).toEqual({
          writer: writer.name,
          result: refused("LANGUAGE_OPERATION_STALE"),
        })
        expect(await continueMigration(site, migrationId, 1)).toEqual({
          kind: "restarted",
          generation: 2,
        })
      }
      {
        const { site, migrationId } = await readyMigration()
        const args = await activationArgs(site.t, migrationId)
        await activateMigration(site.owner, args)
        const authority = await authorityRow(site.t)
        await outcome(() => writer.write(site))
        expect({
          writer: writer.name,
          phase: (await migrationRow(site.t, migrationId)).phase,
          pointer: (await authorityRow(site.t)).continuityPointer,
          locale: (await authorityRow(site.t)).currentLocale,
        }).toEqual({
          writer: writer.name,
          phase: "committed",
          pointer: authority.continuityPointer,
          locale: "fr",
        })
      }
    }
  }, 300_000)
})

describe("M05 P2c owner-only default migration (activation)", () => {
  test("only the current owner activates; every other identity writes nothing", async () => {
    const site = await migrationSite()
    const { t } = site
    const FORMER = {
      subject: "m05-p2c-act-former",
      tokenIdentifier: "https://convex.test|m05-p2c-act-former",
    }
    const CURRENT = {
      subject: "m05-p2c-act-current",
      tokenIdentifier: "https://convex.test|m05-p2c-act-current",
    }
    const LEGACY_ADMIN = {
      subject: "m05-p2c-act-legacy-admin",
      tokenIdentifier: "https://convex.test|m05-p2c-act-legacy-admin",
    }
    const bindOwner = (identity: typeof CURRENT) =>
      t.run(async (ctx) => {
        const owner = (await ctx.db.query("cmsOwner").unique())!
        await ctx.db.patch(owner._id, {
          authId: identity.subject,
          tokenIdentifier: identity.tokenIdentifier,
        })
      })
    await bindOwner(FORMER)
    const former = t.withIdentity(FORMER)
    const migrationId = await startMigration(site, "fr", former)
    await runMigration(t, migrationId)
    await validateMigration(t, migrationId)
    await reviewMigration(t, former, migrationId)
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("roles", {
        authId: LEGACY_ADMIN.subject,
        role: "admin",
        assignedAt: now,
      })
      await ctx.db.insert("cmsMemberships", {
        authId: LEGACY_ADMIN.subject,
        tokenIdentifier: LEGACY_ADMIN.tokenIdentifier,
        role: "admin",
        status: "active",
        createdAt: now,
        activatedAt: now,
        updatedAt: now,
        transitionId: "m05-p2c-act",
      })
    })
    await bindOwner(CURRENT)
    const args = await activationArgs(t, migrationId)
    const denied: [string, Pick<Caller, "mutation">, string][] = [
      ["unauthenticated", t, "UNAUTHENTICATED"],
      [
        "unrelated signed-in",
        t.withIdentity({
          subject: "m05-p2c-act-stranger",
          tokenIdentifier: "https://convex.test|m05-p2c-act-stranger",
        }),
        "CMS_OWNER_REQUIRED",
      ],
      [
        "role-only legacy Admin",
        t.withIdentity(LEGACY_ADMIN),
        "CMS_OWNER_REQUIRED",
      ],
      ["replaced former owner", former, "CMS_OWNER_REQUIRED"],
    ]
    for (const [identity, caller, code] of denied) {
      expect({
        identity,
        result: await refusalWritesNothing(t, () =>
          activateMigration(caller, args)
        ),
      }).toEqual({ identity, result: refused(code) })
    }
    // The installation's migration, reviewed by a former owner, is the
    // current owner's to activate (ledger C3b).
    expect(
      await outcome(() => activateMigration(t.withIdentity(CURRENT), args))
    ).toEqual(ok({ version: args.expectedAuthorityVersion + 1, locale: "fr" }))
  }, 120_000)
})

describe("M05 P11c bounded default migration activation", () => {
  test("activation costs the same on a 200-row generation as on a small one", async () => {
    const activationMetrics = async (paths: readonly string[]) => {
      const { site, migrationId, pageCount } = await readyMigration(paths)
      const args = await activationArgs(site.t, migrationId)
      const { rows } = await migrationRow(site.t, migrationId).then((row) => ({
        rows: row.counts.rows,
      }))
      const used = await site.t.withIdentity(OWNER).run(async (ctx) => {
        await requireInstallationOwner(ctx)
        await activateDefaultMigrationInTransaction(ctx, args)
        return usedMetrics(ctx)
      })
      return { used, rows, pageCount }
    }
    const counts = ({
      databaseQueries,
      documentsRead,
      documentsWritten,
      functionsScheduled,
    }: Used) => ({
      databaseQueries,
      documentsRead,
      documentsWritten,
      functionsScheduled,
    })
    const small = await activationMetrics([])
    const large = await activationMetrics(
      Array.from({ length: 200 }, (_, i) => `/p11c-${i}`)
    )
    expect(large.rows).toBeGreaterThan(small.rows + 190)
    expect(counts(large.used)).toEqual(counts(small.used))
    // Authority, settings, the migration and the intent.
    expect(small.used.documentsWritten).toBe(4)
    for (const { used } of [small, large]) {
      expect(used.functionsScheduled).toBe(0)
      expect(used.databaseQueries).toBeLessThanOrEqual(30)
      expect(used.documentsRead).toBeLessThanOrEqual(30)
      expect(used.bytesRead).toBeLessThanOrEqual(4 * MIB)
      expect(used.bytesWritten).toBeLessThanOrEqual(1 * MIB)
    }
    // Measured (C3c.2a): 17 queries, 13 documents read, 4 written, 0
    // scheduled, 7,525 bytes read and 2,529 written on both sites. It is a
    // command, so this is a derived bound, not a tabled ceiling (P11b).
  }, 600_000)
})

// ─── C3c.2b: collection ─────────────────────────────────────────────────────

type GenerationSpec = {
  generation: number
  rows: number
  pages: number
  path?: string
}

/** Route rows and disclosure pages per generation of one migration. */
async function seedGenerations(
  t: T,
  migrationId: MigrationId,
  specs: readonly GenerationSpec[],
  pathBytes = 0
) {
  await t.run(async (ctx) => {
    const pageId = (await ctx.db.query("pages").first())!._id
    for (const spec of specs) {
      const prefix = spec.path ?? `/g${spec.generation}-`
      for (let i = 0; i < spec.rows; i += 1) {
        const base = `${prefix}${String(i).padStart(4, "0")}`
        await ctx.db.insert("siteDefaultLanguageRoutes", {
          migrationId,
          generation: spec.generation,
          fromPath: base + "x".repeat(Math.max(0, pathBytes - base.length)),
          ...(pathBytes > 0
            ? { capturedPath: "/" + "y".repeat(pathBytes - 1) }
            : {}),
          pageId,
          locale: "en",
          origin: "old_default_current",
          createdAt: FIXED_NOW,
        })
      }
      for (let ordinal = 0; ordinal < spec.pages; ordinal += 1) {
        await ctx.db.insert("siteLanguageDisclosurePages", {
          migrationId,
          generation: spec.generation,
          ordinal,
          section: "shadowed",
          items: collectionItems(pageId, pathBytes),
          digest: `digest-${spec.generation}-${ordinal}`,
          createdAt: FIXED_NOW,
        })
      }
    }
  })
}

function collectionItems(pageId: Id<"pages">, pathBytes: number) {
  // At the 2 KiB maximum, 29 items fill a page to about 62 KiB.
  const count = pathBytes > 0 ? 29 : 1
  return Array.from({ length: count }, (_, i) => ({
    kind: "shadowed_row" as const,
    pageId,
    fromPath: `/item-${i}` + "z".repeat(Math.max(0, pathBytes - 10)),
    destinationLocale: "fr",
    reason: "to_current" as const,
  }))
}

async function seedPreviewPages(
  t: T,
  phase: Doc<"siteLanguageImpactPreviews">["phase"],
  pages: number
) {
  return t.run(async (ctx) => {
    const previewId = await ctx.db.insert("siteLanguageImpactPreviews", {
      kind: "remove",
      locale: "fr",
      owner: {
        ownerId: (await ctx.db.query("cmsOwner").unique())!._id,
        tokenIdentifier: OWNER.tokenIdentifier,
      },
      captured: {
        authorityVersion: 1,
        moduleConfigurationVersion: 1,
        site: { routeClaimVersion: 0, publicationSetVersion: 0 },
        locale: { routeClaimVersion: 0, publicationSetVersion: 0 },
      },
      phase,
      cursorPhase: "menus",
      count: { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
      digest: DISCLOSURE_CHAIN_EMPTY_DIGEST,
      pageCount: pages,
      reviewedThroughOrdinal: -1,
      generation: 1,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
    const pageId = (await ctx.db.query("pages").first())!._id
    for (let ordinal = 0; ordinal < pages; ordinal += 1) {
      await ctx.db.insert("siteLanguageDisclosurePages", {
        previewId,
        generation: 1,
        ordinal,
        section: "selections",
        items: [
          { kind: "selection", pageId, path: `/p-${ordinal}`, title: "t" },
        ],
        digest: `preview-${ordinal}`,
        createdAt: FIXED_NOW,
      })
    }
    return previewId
  })
}

/** Rows and pages of one migration, as `generation → [rows, pages]`. */
async function collectionShape(t: T, migrationId: MigrationId) {
  return t.run(async (ctx) => {
    const shape: Record<number, [number, number]> = {}
    const rows = await ctx.db
      .query("siteDefaultLanguageRoutes")
      .withIndex("by_migrationId_and_generation", (q) =>
        q.eq("migrationId", migrationId)
      )
      .collect()
    const pages = await ctx.db
      .query("siteLanguageDisclosurePages")
      .withIndex("by_migrationId_and_generation_and_ordinal", (q) =>
        q.eq("migrationId", migrationId)
      )
      .collect()
    for (const row of rows) {
      shape[row.generation] ??= [0, 0]
      shape[row.generation]![0] += 1
    }
    for (const page of pages) {
      shape[page.generation] ??= [0, 0]
      shape[page.generation]![1] += 1
    }
    return shape
  })
}

async function previewPageCount(
  t: T,
  previewId: Id<"siteLanguageImpactPreviews">
) {
  return t.run(
    async (ctx) =>
      (
        await ctx.db
          .query("siteLanguageDisclosurePages")
          .withIndex("by_previewId_and_ordinal", (q) =>
            q.eq("previewId", previewId)
          )
          .collect()
      ).length
  )
}

function collectStep(t: T, args: CollectionArgs) {
  return t.run((ctx) => runCollectionStep(ctx, args))
}

/** Follows `continue` to the end; returns every step's result. */
async function drainCollection(t: T, args: CollectionArgs) {
  const results: CollectionStepResult[] = []
  let next: CollectionArgs | null = args
  for (let guard = 0; next && guard < 100; guard += 1) {
    const result: CollectionStepResult = await collectStep(t, next)
    results.push(result)
    next = result.kind === "continue" ? result.next : null
  }
  expect(results.at(-1)?.kind).not.toBe("continue")
  return results
}

async function setPointer(
  t: T,
  pointer: { migrationId: MigrationId; generation: number } | undefined
) {
  await t.run(async (ctx) => {
    const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
    await ctx.db.patch(authority._id, { continuityPointer: pointer })
  })
}

async function setMigration(
  t: T,
  migrationId: MigrationId,
  fields: Partial<Doc<"siteDefaultLanguageMigrations">>
) {
  await t.run((ctx) => ctx.db.patch(migrationId, fields))
}

describe("M05 P15b default migration collection", () => {
  test("cancel schedules collection, which deletes every generation of the cancelled migration in bounded steps and nothing else", async () => {
    const { site, migrationId } = await validatingMigration(["/a", "/b"])
    const { t, owner } = site
    const retainedId = await seedDefaultMigration(t, {
      fromLocale: "nl",
      toLocale: "en",
      phase: "committed",
    })
    await seedGenerations(t, retainedId, [{ generation: 1, rows: 3, pages: 2 }])
    await setPointer(t, { migrationId: retainedId, generation: 1 })
    const real = await collectionShape(t, migrationId)
    expect(real[1]![0]).toBeGreaterThan(0)
    expect(real[1]![1]).toBeGreaterThan(0)
    // Two more generations, one of them larger than two route batches.
    await seedGenerations(t, migrationId, [
      { generation: 0, rows: 300, pages: 20 },
    ])
    await cancelMigration(owner, migrationId, 1)
    const scheduled = (await scheduledSteps(t)).at(-1)!
    expect(scheduled).toMatchObject({
      name: "cms/languageLifecycle:collectDefaultLanguageRoutes",
      args: [{ migrationId }],
    })
    const retainedBefore = await everyRow(t)

    const deletedPerStep: number[] = []
    let next: CollectionArgs | null = scheduled.args[0] as CollectionArgs
    for (let guard = 0; next && guard < 100; guard += 1) {
      const before = await collectionShape(t, migrationId)
      const result: CollectionStepResult = await collectStep(t, next)
      const after = await collectionShape(t, migrationId)
      const total = (shape: typeof before) =>
        Object.values(shape).reduce((sum, [r, p]) => sum + r + p, 0)
      deletedPerStep.push(total(before) - total(after))
      next = result.kind === "continue" ? result.next : null
    }
    expect(await collectionShape(t, migrationId)).toEqual({})
    const routeTotal = 300 + real[1]![0]
    const pageTotal = 20 + real[1]![1]
    expect(deletedPerStep.slice(0, 3)).toEqual([127, 127, routeTotal - 254])
    expect(deletedPerStep.slice(3)).toEqual(
      pageTotal >= 16
        ? [16, pageTotal - 16, ...(pageTotal === 32 ? [0] : [])]
        : [pageTotal]
    )
    // Only the cancelled migration's rows and pages went away; the migration
    // row itself and every other row stay.
    const after = await everyRow(t)
    const own = (row: unknown) =>
      (row as { migrationId?: string }).migrationId === migrationId
    expect(after.siteDefaultLanguageRoutes).toEqual(
      retainedBefore.siteDefaultLanguageRoutes!.filter((row) => !own(row))
    )
    expect(after.siteLanguageDisclosurePages).toEqual(
      retainedBefore.siteLanguageDisclosurePages!.filter((row) => !own(row))
    )
    for (const table of [
      "siteDefaultLanguageRoutes",
      "siteLanguageDisclosurePages",
    ]) {
      delete after[table]
      delete retainedBefore[table]
    }
    expect(after).toEqual(retainedBefore)
    expect(await collectionShape(t, retainedId)).toEqual({ 1: [3, 2] })
    expect((await migrationRow(t, migrationId)).phase).toBe("cancelled")
  }, 120_000)

  test("a committed migration keeps the generation it activated, also after the pointer moves; earlier generations are collected", async () => {
    const { t } = await migrationSite()
    const migrationId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "committed",
    })
    await setMigration(t, migrationId, { generation: 3 })
    await seedGenerations(t, migrationId, [
      { generation: 1, rows: 5, pages: 2 },
      { generation: 2, rows: 4, pages: 1 },
      { generation: 3, rows: 6, pages: 3 },
    ])
    await setPointer(t, { migrationId, generation: 3 })
    const retained = async () =>
      t.run(async (ctx) => [
        await ctx.db
          .query("siteDefaultLanguageRoutes")
          .withIndex("by_migrationId_and_generation", (q) =>
            q.eq("migrationId", migrationId).eq("generation", 3)
          )
          .collect(),
        await ctx.db
          .query("siteLanguageDisclosurePages")
          .withIndex("by_migrationId_and_generation_and_ordinal", (q) =>
            q.eq("migrationId", migrationId).eq("generation", 3)
          )
          .collect(),
      ])
    const before = await retained()

    expect(await drainCollection(t, { migrationId })).toEqual([
      { kind: "continue", next: { migrationId, section: "pages" } },
      { kind: "done", deleted: 3 },
    ])
    expect(await collectionShape(t, migrationId)).toEqual({ 3: [6, 3] })
    expect(await retained()).toEqual(before)

    // A later migration moves the pointer: the activated generation stays
    // evidence (M12).
    const laterId = await seedDefaultMigration(t, {
      fromLocale: "fr",
      toLocale: "en",
      phase: "committed",
    })
    await setPointer(t, { migrationId: laterId, generation: 1 })
    expect(await drainCollection(t, { migrationId })).toEqual([
      { kind: "continue", next: { migrationId, section: "pages" } },
      { kind: "done", deleted: 0 },
    ])
    expect(await retained()).toEqual(before)
  })

  test("an open migration keeps its current generation and loses the earlier ones", async () => {
    for (const phase of OPEN_MIGRATION_PHASES) {
      const { t } = await migrationSite()
      const migrationId = await seedDefaultMigration(t, {
        fromLocale: "en",
        toLocale: "fr",
        phase,
      })
      await setMigration(t, migrationId, { generation: 2 })
      await seedGenerations(t, migrationId, [
        { generation: 1, rows: 2, pages: 1 },
        { generation: 2, rows: 3, pages: 2 },
      ])
      await drainCollection(t, { migrationId })
      expect({ phase, shape: await collectionShape(t, migrationId) }).toEqual({
        phase,
        shape: { 2: [3, 2] },
      })
    }
  })

  test("collection stops and deletes nothing on a pointer it cannot trust, a missing authority or two authorities; a missing subject is a no-op", async () => {
    const cases: {
      name: string
      phase: MigrationPhase
      generation: number
      pointer?: number
      authorities?: 0 | 2
      expected: CollectionStepResult
    }[] = [
      {
        name: "pointer names a cancelled migration",
        phase: "cancelled",
        generation: 1,
        pointer: 1,
        expected: { kind: "stopped", reason: "pointed" },
      },
      {
        name: "pointer names a ready migration",
        phase: "ready",
        generation: 2,
        pointer: 1,
        expected: { kind: "stopped", reason: "pointed" },
      },
      {
        name: "pointer names another generation of a committed migration",
        phase: "committed",
        generation: 2,
        pointer: 1,
        expected: { kind: "stopped", reason: "pointed" },
      },
      {
        name: "no authority",
        phase: "cancelled",
        generation: 1,
        authorities: 0,
        expected: { kind: "stopped", reason: "authority_invalid" },
      },
      {
        name: "two authorities",
        phase: "cancelled",
        generation: 1,
        authorities: 2,
        expected: { kind: "stopped", reason: "authority_invalid" },
      },
    ]
    for (const c of cases) {
      const { t } = await migrationSite()
      const migrationId = await seedDefaultMigration(t, {
        fromLocale: "en",
        toLocale: "fr",
        phase: c.phase,
      })
      await setMigration(t, migrationId, { generation: c.generation })
      await seedGenerations(t, migrationId, [
        { generation: 1, rows: 2, pages: 1 },
      ])
      if (c.pointer !== undefined) {
        await setPointer(t, { migrationId, generation: c.pointer })
      }
      if (c.authorities !== undefined) {
        await t.run(async (ctx) => {
          const authority = (await ctx.db
            .query("siteLanguageAuthority")
            .unique())!
          if (c.authorities === 0) await ctx.db.delete(authority._id)
          else {
            const { _id, _creationTime, ...copy } = authority
            void _id
            void _creationTime
            await ctx.db.insert("siteLanguageAuthority", copy)
          }
        })
      }
      const before = await everyRow(t)
      const scheduledBefore = (await scheduledSteps(t)).length
      expect({
        name: c.name,
        result: await collectStep(t, { migrationId }),
      }).toEqual({ name: c.name, result: c.expected })
      expect({ name: c.name, rows: await everyRow(t) }).toEqual({
        name: c.name,
        rows: before,
      })
      expect((await scheduledSteps(t)).length).toBe(scheduledBefore)
    }

    const { t } = await migrationSite()
    const goneId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "cancelled",
    })
    await seedGenerations(t, goneId, [{ generation: 1, rows: 2, pages: 1 }])
    await t.run((ctx) => ctx.db.delete(goneId))
    const goneBefore = await everyRow(t)
    expect(await collectStep(t, { migrationId: goneId })).toEqual({
      kind: "noop",
    })
    const previewId = await seedPreviewPages(t, "stale", 1)
    await t.run(async (ctx) => {
      for (const page of await ctx.db
        .query("siteLanguageDisclosurePages")
        .withIndex("by_previewId_and_ordinal", (q) =>
          q.eq("previewId", previewId)
        )
        .collect()) {
        await ctx.db.delete(page._id)
      }
      await ctx.db.delete(previewId)
    })
    expect(await collectStep(t, { previewId })).toEqual({ kind: "noop" })
    expect(await everyRow(t)).toEqual(goneBefore)
    await expect(
      t.mutation(
        internal.cms.languageLifecycle.collectDefaultLanguageRoutes,
        {}
      )
    ).rejects.toThrow("LANGUAGE_COLLECTION_SUBJECT_INVALID")
    await expect(
      t.mutation(internal.cms.languageLifecycle.collectDefaultLanguageRoutes, {
        migrationId: goneId,
        previewId,
      })
    ).rejects.toThrow("LANGUAGE_COLLECTION_SUBJECT_INVALID")
  })

  test("the preview arm deletes pages of stale and expired previews only", async () => {
    const { t } = await migrationSite()
    const ids = {} as Record<
      Doc<"siteLanguageImpactPreviews">["phase"],
      Id<"siteLanguageImpactPreviews">
    >
    for (const phase of [
      "scanning",
      "complete",
      "consumed",
      "stale",
      "expired",
    ] as const) {
      ids[phase] = await seedPreviewPages(t, phase, 20)
    }
    // Past its expiry time, a complete preview waits for its scheduled flip.
    await t.run((ctx) =>
      ctx.db.patch(ids.complete, { expiresAt: FIXED_NOW - 1 })
    )
    for (const phase of ["scanning", "complete", "consumed"] as const) {
      expect(await drainCollection(t, { previewId: ids[phase] })).toEqual([
        { kind: "noop" },
      ])
      expect({ phase, pages: await previewPageCount(t, ids[phase]) }).toEqual({
        phase,
        pages: 20,
      })
    }
    for (const phase of ["stale", "expired"] as const) {
      expect(await drainCollection(t, { previewId: ids[phase] })).toEqual([
        { kind: "continue", next: { previewId: ids[phase], limit: 16 } },
        { kind: "done", deleted: 4 },
      ])
      expect({ phase, pages: await previewPageCount(t, ids[phase]) }).toEqual({
        phase,
        pages: 0,
      })
    }
    // The preview rows themselves stay.
    expect(
      await t.run(async (ctx) => (await ctx.db.get(ids.stale))?.phase)
    ).toBe("stale")
  })

  test("a reserve crossing deletes nothing and retries at half the batch, and stops at a batch of one", async () => {
    const { t } = await migrationSite()
    const migrationId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "cancelled",
    })
    await seedGenerations(t, migrationId, [
      { generation: 1, rows: 10, pages: 3 },
    ])
    const previewId = await seedPreviewPages(t, "stale", 3)
    const spy = vi
      .spyOn(defaultMigrationSeam, "metrics")
      .mockImplementation(async (ctx) => {
        const metrics = await ctx.meta.getTransactionMetrics()
        return { ...metrics, bytesRead: { used: 5 * MIB, remaining: 11 * MIB } }
      })
    try {
      const before = await everyRow(t)
      expect(await collectStep(t, { migrationId })).toEqual({
        kind: "continue",
        next: { migrationId, section: "routes", limit: 63 },
      })
      expect(
        await collectStep(t, { migrationId, section: "pages", limit: 5 })
      ).toEqual({
        kind: "continue",
        next: { migrationId, section: "pages", limit: 2 },
      })
      expect(await collectStep(t, { previewId })).toEqual({
        kind: "continue",
        next: { previewId, limit: 8 },
      })
      expect(await collectStep(t, { migrationId, limit: 1 })).toEqual({
        kind: "stopped",
        reason: "reserve",
      })
      expect(await everyRow(t)).toEqual(before)
    } finally {
      spy.mockRestore()
    }
    // A halved batch resumes from the head of the same range.
    expect(
      await collectStep(t, { migrationId, section: "routes", limit: 4 })
    ).toEqual({
      kind: "continue",
      next: { migrationId, section: "routes", limit: 4 },
    })
    expect(await collectionShape(t, migrationId)).toEqual({ 1: [6, 3] })
  })

  test("the nightly sweep is a registered cron that pages subjects and schedules collection only where something is collectable", async () => {
    expect(
      (crons as unknown as { crons: Record<string, unknown> }).crons[
        "language continuity collection sweep"
      ]
    ).toEqual({
      name: "cms/languageLifecycle:sweepDefaultLanguageCollection",
      args: [{}],
      schedule: { type: "cron", cron: "45 3 * * *" },
    })

    const { t } = await migrationSite()
    const seed = async (
      phase: MigrationPhase,
      generation: number,
      specs: GenerationSpec[]
    ) => {
      const id = await seedDefaultMigration(t, {
        fromLocale: "en",
        toLocale: "fr",
        phase,
      })
      await setMigration(t, id, { generation })
      await seedGenerations(t, id, specs)
      return id
    }
    const cancelled: MigrationId[] = []
    for (let i = 0; i < 17; i += 1) {
      cancelled.push(
        await seed("cancelled", 1, [{ generation: 1, rows: 1, pages: 0 }])
      )
    }
    const pagesOnly = await seed("cancelled", 1, [
      { generation: 1, rows: 0, pages: 2 },
    ])
    const pointed = await seed("committed", 2, [
      { generation: 2, rows: 3, pages: 1 },
    ])
    const earlier = await seed("committed", 2, [
      { generation: 1, rows: 1, pages: 1 },
      { generation: 2, rows: 2, pages: 1 },
    ])
    const restarted = await seed("ready", 3, [
      { generation: 2, rows: 1, pages: 0 },
      { generation: 3, rows: 1, pages: 1 },
    ])
    const clean = await seed("cancelled", 1, [])
    await setPointer(t, { migrationId: pointed, generation: 2 })
    const stale = await seedPreviewPages(t, "stale", 2)
    const expired = await seedPreviewPages(t, "expired", 1)
    const expiredEmpty = await seedPreviewPages(t, "expired", 0)
    const complete = await seedPreviewPages(t, "complete", 2)

    const subjects: CollectionArgs[] = []
    const scheduledPerStep: number[] = []
    const sections: string[] = []
    let next: { section: SweepSection; cursor: string | null } | null = {
      section: "migrations",
      cursor: null,
    }
    for (let guard = 0; next && guard < 20; guard += 1) {
      const current: { section: SweepSection; cursor: string | null } = next
      sections.push(current.section)
      const before = (await scheduledSteps(t)).length
      const result = await t.run((ctx) =>
        runCollectionSweepStep(ctx, current.section, current.cursor)
      )
      scheduledPerStep.push((await scheduledSteps(t)).length - before)
      expect(result.subjects.length).toBeLessThanOrEqual(16)
      subjects.push(...result.subjects)
      next = result.next
    }
    expect(next).toBeNull()
    expect(sections).toEqual([
      "migrations",
      "migrations",
      "stale_previews",
      "expired_previews",
    ])
    expect(Math.max(...scheduledPerStep)).toBeLessThanOrEqual(17)
    expect(scheduledPerStep.at(-1)).toBe(1)
    const key = (subject: CollectionArgs) =>
      "migrationId" in subject ? subject.migrationId : subject.previewId
    expect(subjects.map(key).sort()).toEqual(
      [...cancelled, pagesOnly, earlier, restarted, stale, expired].sort()
    )
    void clean
    void expiredEmpty
    void complete

    for (const subject of subjects) await drainCollection(t, subject)
    for (const id of [...cancelled, pagesOnly]) {
      expect(await collectionShape(t, id)).toEqual({})
    }
    expect(await collectionShape(t, pointed)).toEqual({ 2: [3, 1] })
    expect(await collectionShape(t, earlier)).toEqual({ 2: [2, 1] })
    expect(await collectionShape(t, restarted)).toEqual({ 3: [1, 1] })
    expect(await previewPageCount(t, stale)).toBe(0)
    expect(await previewPageCount(t, expired)).toBe(0)
    expect(await previewPageCount(t, complete)).toBe(2)

    // A pointer the collector would stop on is not dispatched.
    await setPointer(t, { migrationId: cancelled[0]!, generation: 1 })
    await seedGenerations(t, cancelled[0]!, [
      { generation: 1, rows: 1, pages: 0 },
    ])
    const again = await t.run((ctx) =>
      runCollectionSweepStep(ctx, "migrations", null)
    )
    expect(again.subjects).toEqual([])
    // The cron entry point starts at the first section.
    const before = (await scheduledSteps(t)).length
    await t.mutation(
      internal.cms.languageLifecycle.sweepDefaultLanguageCollection,
      {}
    )
    expect((await scheduledSteps(t)).at(-1)).toMatchObject({
      name: "cms/languageLifecycle:sweepDefaultLanguageCollection",
    })
    expect((await scheduledSteps(t)).length).toBe(before + 1)
  }, 120_000)
})

describe("M05 P11c bounded default migration workers (collection cell)", () => {
  // Ceilings row `collectDefaultLanguageRoutes`, with the owner's 3 queries
  // and the batches of ledger C3c.2b.
  const CELL = {
    databaseQueries: 3,
    documentsRead: 257,
    documentsWritten: 256,
    functionsScheduled: 1,
    bytesRead: 4 * MIB,
    bytesWritten: 1 * MIB,
    scheduledFunctionArgsBytes: 64 * KIB,
  }

  async function measure(t: T, args: CollectionArgs) {
    return t.run(async (ctx) => {
      await runCollectionStep(ctx, args)
      return usedMetrics(ctx)
    })
  }

  test("route, migration page and preview page steps stay within every metric of the collection cell at the field maxima", async () => {
    const { t } = await migrationSite()
    const migrationId = await seedDefaultMigration(t, {
      fromLocale: "en",
      toLocale: "fr",
      phase: "cancelled",
    })
    await seedGenerations(
      t,
      migrationId,
      [{ generation: 1, rows: 300, pages: 20 }],
      DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES
    )
    const routes = await measure(t, { migrationId })
    const pages = await measure(t, { migrationId, section: "pages" })
    const previewId = await seedPreviewPages(t, "expired", 40)
    const preview = await measure(t, { previewId })

    for (const [name, used] of Object.entries({ routes, pages, preview })) {
      for (const key of METRICS) {
        expect({ name, key, within: used[key] <= CELL[key] }).toEqual({
          name,
          key,
          within: true,
        })
      }
    }
    // A full route step reads the migration, the authority, 127 rows and
    // re-reads each row it deletes: 256 documents. A 128-row batch would read
    // 258 and fail the cell.
    expect(routes).toMatchObject({
      databaseQueries: 3,
      documentsRead: 256,
      documentsWritten: 127,
      functionsScheduled: 1,
      bytesWritten: 0,
    })
    expect(pages).toMatchObject({
      databaseQueries: 3,
      documentsRead: 34,
      documentsWritten: 16,
      functionsScheduled: 1,
    })
    expect(pages.bytesRead).toBeGreaterThan(1.5 * MIB)
    expect(preview).toMatchObject({
      databaseQueries: 2,
      documentsRead: 33,
      documentsWritten: 16,
      functionsScheduled: 1,
    })
  }, 120_000)

  test("a sweep step is bounded by its page of subjects", async () => {
    const { t } = await migrationSite()
    for (let i = 0; i < 20; i += 1) {
      const id = await seedDefaultMigration(t, {
        fromLocale: "en",
        toLocale: "fr",
        phase: "cancelled",
      })
      // Pages only: each subject spends both probes.
      await seedGenerations(t, id, [{ generation: 1, rows: 0, pages: 1 }])
    }
    const used = await t.run(async (ctx) => {
      await runCollectionSweepStep(ctx, "migrations", null)
      return usedMetrics(ctx)
    })
    // No ceiling row: a command bound (ledger C3c.2b Limit). One paginated
    // query, one authority read and two probes per subject.
    expect(used).toMatchObject({
      databaseQueries: 34,
      documentsWritten: 0,
      functionsScheduled: 17,
    })
    expect(used.documentsRead).toBeLessThanOrEqual(1 + 16 + 16)
  }, 120_000)
})

// ─── C3c.2b-2: lifecycle path phases (P19c) ──────────────────────────────────

const P19C_ORIGIN = "https://site.example.com"
const P19C_LAYOUT = "/(public)/[locale]"
const P19C_TAGS = ["cms:pages", "cms:menus", "cms:settings"]

type PostedBody = {
  paths?: string[]
  layoutPaths?: string[]
  tags?: string[]
}

function lifecycleFetch(failOnCall?: number) {
  let call = 0
  const fetchMock = vi.fn<
    (url: string, init: RequestInit) => Promise<Response>
  >(async () => {
    call += 1
    return new Response(null, { status: call === failOnCall ? 500 : 204 })
  })
  vi.stubGlobal("fetch", fetchMock)
  return fetchMock
}

function postedBodies(
  fetchMock: ReturnType<typeof lifecycleFetch>
): PostedBody[] {
  return fetchMock.mock.calls.map(
    ([, init]) => JSON.parse(String(init.body)) as PostedBody
  )
}

const drainLifecycle = (t: T) =>
  t.action(internal.cms.languageLifecycle.drainLanguageLifecycleIntents, {})

function prefixedPath(locale: string, path: string) {
  return path === "/" ? `/${locale}` : `/${locale}${path}`
}

function chunks<V>(items: readonly V[], size: number): V[][] {
  const result: V[][] = []
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size))
  }
  return result
}

async function migrationIntent(t: T) {
  const rows = (await lifecycleIntentRows(t)).filter(
    (row) => row.operationKind === "default_migration"
  )
  expect(rows).toHaveLength(1)
  return rows[0]!
}

/** The `manifest_paths` posts for a generation: `p`, `/<D>p`, `/<N>p` per row. */
async function expectedManifestPosts(
  t: T,
  migrationId: MigrationId,
  generation: number,
  [from, to]: readonly [string, string]
) {
  const rows = await t.run((ctx) =>
    ctx.db
      .query("siteDefaultLanguageRoutes")
      .withIndex("by_migrationId_and_generation", (q) =>
        q.eq("migrationId", migrationId).eq("generation", generation)
      )
      .take(1000)
  )
  return chunks(rows, LANGUAGE_LIFECYCLE_MANIFEST_BATCH).map((page) =>
    page.flatMap((row) => [
      row.fromPath,
      prefixedPath(from, row.fromPath),
      prefixedPath(to, row.fromPath),
    ])
  )
}

/** The `new_default_paths` posts: `/<N><currentPath>` in index order. */
async function expectedNewDefaultPosts(t: T, locale: string) {
  const states = await t.run((ctx) =>
    ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_locale_and_currentPath", (q) => q.eq("locale", locale))
      .take(1000)
  )
  return chunks(states, LANGUAGE_LIFECYCLE_NEW_DEFAULT_BATCH)
    .map((page) =>
      page.flatMap((state) =>
        state.currentPath === undefined
          ? []
          : [prefixedPath(locale, state.currentPath)]
      )
    )
    .filter((paths) => paths.length > 0)
}

/**
 * An activated `en → fr` migration whose generation 1 is dense (150 extra
 * rows, one shadowed, one retired and one carried to `nl`), with a generation 2 that must never be
 * posted, and `fr` current paths over three pages plus states without a path.
 */
async function activatedPathSite() {
  const { site, migrationId } = await readyMigration(["/about", "/contact"])
  const { t, owner } = site
  await activateMigration(owner, await activationArgs(t, migrationId))
  await seedGenerations(t, migrationId, [
    { generation: 1, rows: 150, pages: 0, path: "/dense-" },
    { generation: 2, rows: 3, pages: 0, path: "/other-" },
  ])
  await t.run(async (ctx) => {
    const dense = await ctx.db
      .query("siteDefaultLanguageRoutes")
      .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
        q
          .eq("migrationId", migrationId)
          .eq("generation", 1)
          .gte("fromPath", "/dense-")
      )
      .take(3)
    await ctx.db.patch(dense[0]!._id, { shadow: "to_current" })
    await ctx.db.patch(dense[1]!._id, {
      retiredAt: FIXED_NOW,
      retiredReason: "to_historical",
    })
    // A carried row's destination is neither the old nor the new default.
    await ctx.db.patch(dense[2]!._id, { locale: "nl", origin: "carried" })
  })
  await seedSelections(site, [null, null])
  await seedLocaleStates(
    site,
    "fr",
    Array.from({ length: 300 }, (_, i) => `/fr-${String(i).padStart(3, "0")}`)
  )
  const manifest = await expectedManifestPosts(t, migrationId, 1, ["en", "fr"])
  const newDefault = await expectedNewDefaultPosts(t, "fr")
  expect(manifest.length).toBeGreaterThanOrEqual(4)
  expect(newDefault.length).toBeGreaterThanOrEqual(3)
  return { site, t, owner, migrationId, manifest, newDefault }
}

describe("M05 P19c default migration lifecycle path phases", () => {
  beforeEach(() => {
    vi.stubEnv("REVALIDATE_SECRET", "p19c-secret")
    vi.stubEnv("SITE_URL", P19C_ORIGIN)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
  })

  test("activation's intent pages its generation, then the new default's current paths, and is delivered only after both", async () => {
    const { t, owner, migrationId, manifest, newDefault } =
      await activatedPathSite()
    const intent = await migrationIntent(t)
    expect(intent).toMatchObject({
      locales: ["en", "fr"],
      migrationId,
      generation: 1,
      phase: "tags_and_layout",
      status: "pending",
    })
    // Normative batches: three paths per row and one per state, ≤ 128 posted.
    expect(LANGUAGE_LIFECYCLE_MANIFEST_BATCH).toBe(42)
    expect(LANGUAGE_LIFECYCLE_NEW_DEFAULT_BATCH).toBe(128)
    const fetchMock = lifecycleFetch()

    // One claim runs eight steps: tags, roots and six path pages.
    await drainLifecycle(t)
    const afterFirst = await migrationIntent(t)
    expect(afterFirst).toMatchObject({
      status: "pending",
      phase: "new_default_paths",
      origin: P19C_ORIGIN,
    })
    expect(afterFirst.cursor).toBeDefined()
    expect(
      await owner.query(api.cms.languageLifecycle.getLanguageLifecycleStatus, {
        operationId: intent.operationId,
      })
    ).toMatchObject({ updating: true })

    await drainLifecycle(t)
    const delivered = await migrationIntent(t)
    expect(delivered).toMatchObject({ status: "delivered", phase: "complete" })
    expect(delivered.cursor).toBeUndefined()

    const bodies = postedBodies(fetchMock)
    expect(bodies).toEqual([
      { layoutPaths: [P19C_LAYOUT], tags: P19C_TAGS },
      // `roots` reads live settings: `fr` is now the unprefixed default.
      { paths: ["/", "/en"] },
      ...manifest.map((paths) => ({ paths })),
      ...newDefault.map((paths) => ({ paths })),
    ])
    for (const body of bodies) {
      expect(body.paths?.length ?? 0).toBeLessThanOrEqual(128)
    }
    expect(manifest[0]).toHaveLength(126)
    const manifestPaths = new Set(manifest.flat())
    // Shadowed and retired rows are posted; another generation never is.
    // The carried row is prefixed with `en` and `fr`, never its own `nl`.
    for (const path of ["/dense-0000", "/dense-0001", "/dense-0002"]) {
      expect(manifestPaths.has(path)).toBe(true)
      expect(manifestPaths.has(`/en${path}`)).toBe(true)
      expect(manifestPaths.has(`/fr${path}`)).toBe(true)
    }
    expect([...manifestPaths].some((path) => path.includes("/other-"))).toBe(
      false
    )
    expect(manifestPaths.has("/nl/dense-0002")).toBe(false)
    // The home page's `fr` path posts the locale root, never `/fr/`.
    expect(newDefault.flat()).toContain("/fr")
    expect(newDefault.flat()).not.toContain("/fr/")
    expect(newDefault.flat()).toContain("/fr/fr-299")
  }, 120_000)

  test("a failed post resumes the same phase from its cursor after the retry delay", async () => {
    const { t, manifest, newDefault } = await activatedPathSite()
    // Calls: tags, roots, manifest page 1, then manifest page 2 fails.
    const fetchMock = lifecycleFetch(4)
    await drainLifecycle(t)
    const failed = await migrationIntent(t)
    expect(failed).toMatchObject({
      status: "failed",
      phase: "manifest_paths",
      lastErrorCode: "REVALIDATION_HTTP_ERROR",
    })
    expect(failed.cursor).toBeDefined()

    vi.advanceTimersByTime(LANGUAGE_LIFECYCLE_RETRY_DELAY_MS + 1)
    for (let guard = 0; guard < 4; guard += 1) {
      if ((await migrationIntent(t)).status === "delivered") break
      await drainLifecycle(t)
    }
    expect(await migrationIntent(t)).toMatchObject({ status: "delivered" })
    expect(postedBodies(fetchMock)).toEqual([
      { layoutPaths: [P19C_LAYOUT], tags: P19C_TAGS },
      { paths: ["/", "/en"] },
      { paths: manifest[0] },
      { paths: manifest[1] },
      // The retry starts at the failed page, not at the phase or intent start.
      ...manifest.slice(1).map((paths) => ({ paths })),
      ...newDefault.map((paths) => ({ paths })),
    ])
  }, 120_000)

  test("an unresumable cursor restarts only its phase, posting nothing for the restart, with the intent's locales and generation", async () => {
    const { t, migrationId, manifest, newDefault } = await activatedPathSite()
    // A later pointer must not move what this intent posts.
    await setPointer(t, { migrationId, generation: 2 })
    const intent = await migrationIntent(t)
    for (const phase of ["manifest_paths", "new_default_paths"] as const) {
      await t.run((ctx) =>
        ctx.db.patch(intent._id, {
          phase,
          cursor: "not-a-cursor",
          origin: P19C_ORIGIN,
          status: "pending",
        })
      )
      const fetchMock = lifecycleFetch()
      for (let guard = 0; guard < 4; guard += 1) {
        if ((await migrationIntent(t)).status === "delivered") break
        await drainLifecycle(t)
      }
      expect(await migrationIntent(t)).toMatchObject({
        status: "delivered",
        phase: "complete",
      })
      expect(postedBodies(fetchMock)).toEqual(
        phase === "manifest_paths"
          ? [...manifest, ...newDefault].map((paths) => ({ paths }))
          : newDefault.map((paths) => ({ paths }))
      )
      vi.unstubAllGlobals()
    }

    // The locales are the intent's own: an earlier `nl → it` intent keeps its
    // prefixes, and `it` has no current path, so its second phase posts nothing.
    await t.run((ctx) =>
      ctx.db.patch(intent._id, {
        locales: ["nl", "it"],
        phase: "manifest_paths",
        cursor: undefined,
        status: "pending",
      })
    )
    const fetchMock = lifecycleFetch()
    await drainLifecycle(t)
    expect(await migrationIntent(t)).toMatchObject({ status: "delivered" })
    expect(postedBodies(fetchMock)).toEqual(
      (await expectedManifestPosts(t, migrationId, 1, ["nl", "it"])).map(
        (paths) => ({ paths })
      )
    )
    expect(await expectedNewDefaultPosts(t, "it")).toEqual([])
  }, 120_000)

  test("the plan query reads one intent and one page (ledger C3c.2b-2 Gap: a derived bound)", async () => {
    const { t, migrationId } = await activatedPathSite()
    // A full page of rows at the 2 KiB path maximum, in a generation of its own.
    await seedGenerations(
      t,
      migrationId,
      [{ generation: 7, rows: 50, pages: 0, path: "/max-" }],
      2048
    )
    const intentId = (await migrationIntent(t))._id
    const measure = (phase: "manifest_paths" | "new_default_paths") =>
      t.run(async (ctx) => {
        const intent = (await ctx.db.get(intentId))!
        const step = await planDefaultMigrationPaths(
          ctx,
          { ...intent, generation: 7 },
          { phase, cursor: null, origin: P19C_ORIGIN }
        )
        return { paths: step!.paths.length, used: await usedMetrics(ctx) }
      })
    const manifest = await measure("manifest_paths")
    const newDefault = await measure("new_default_paths")
    expect(manifest.paths).toBe(126)
    expect(newDefault.paths).toBeLessThanOrEqual(128)
    for (const [{ used }, documents] of [
      [manifest, 1 + LANGUAGE_LIFECYCLE_MANIFEST_BATCH],
      [newDefault, 1 + LANGUAGE_LIFECYCLE_NEW_DEFAULT_BATCH],
    ] as const) {
      expect(used).toMatchObject({
        databaseQueries: 2,
        documentsRead: documents,
        documentsWritten: 0,
        bytesWritten: 0,
        functionsScheduled: 0,
      })
      // Measured about 179 KiB for routes and 49 KiB for states.
      expect(used.bytesRead).toBeLessThan(256 * 1024)
    }
  }, 120_000)
})

// ─── M05 C3d.1: the resolver's pointer branch ──────────────────────────────
//
// Contract Default migration Resolution and its proxy paragraph, M2 exception
// 1, M11, M12, M24 ("Resolution treats a retired row as absent") and the
// ledger C3d.1 Interpretations. Retirement by a later claim is C3d.2, so a
// retired row is constructed here by patching `retiredAt`.

const UNCLAIMED = { authority: "snapshot_active", disposition: "unclaimed" }
const UNAVAILABLE = {
  authority: "snapshot_active",
  disposition: "historical_unavailable",
}

async function resolveAt(
  t: T,
  languageVersion: number,
  locale: string,
  path: string
) {
  return t.query(api.cms.pages.resolveHistoricalPublishedPath, {
    locale,
    path,
    languageVersion,
  })
}

async function resolvePath(t: T, locale: string, path: string) {
  const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
  return resolveAt(t, languageVersion, locale, path)
}

/** The redirect the resolver returns for a live `(pageId, locale)` selection. */
async function redirectTo(
  t: T,
  pageId: Id<"pages">,
  locale: string,
  destinationPath: string
) {
  const state = await localeState(t, pageId, locale)
  return {
    authority: "snapshot_active",
    disposition: "historical_redirect",
    pageId,
    locale,
    snapshotId: state.currentSnapshotId,
    publicGeneration: state.publicGeneration,
    destinationPath,
    statusCode: 307,
  }
}

async function publishPage(
  site: Pick<Site, "t" | "owner">,
  pageId: Id<"pages">,
  locale: string
) {
  await site.owner.mutation(
    api.cms.publication.publishLocale,
    await publishArgs(site.t, pageId, locale)
  )
  await drain(site.t)
}

async function saveSlugDraft(
  site: Pick<Site, "t" | "owner">,
  pageId: Id<"pages">,
  locale: string,
  slug: string
) {
  const draft = await generations(site.t, pageId, locale)
  await site.owner.mutation(api.cms.publication.saveLocaleDraft, {
    pageId,
    locale,
    slug,
    draft: {
      pageType: "landing-page",
      localized: { title: `${slug} ${locale}` },
      slices: [],
    } as never,
    expectedDraftGeneration: draft.state!.draftGeneration,
    expectedLifecycleGeneration: draft.page!.lifecycleGeneration,
  })
}

/** Saves `slug` as the locale's draft and publishes it (an F08 path change). */
async function publishSlug(
  site: Pick<Site, "t" | "owner">,
  pageId: Id<"pages">,
  locale: string,
  slug: string
) {
  await saveSlugDraft(site, pageId, locale, slug)
  await publishPage(site, pageId, locale)
}

async function withdrawPublished(
  site: Pick<Site, "t" | "owner">,
  pageId: Id<"pages">,
  locale: string
) {
  const { state, page } = await generations(site.t, pageId, locale)
  await site.owner.mutation(api.cms.publication.withdrawLocale, {
    pageId,
    locale,
    expectedSnapshotId: state!.currentSnapshotId!,
    expectedPublicGeneration: state!.publicGeneration,
    expectedLifecycleGeneration: page!.lifecycleGeneration,
  })
  await drain(site.t)
}

/** Enumerates, validates, reviews and activates a migration to `toLocale`. */
async function migrateAndActivate(
  site: Pick<Site, "t" | "owner">,
  toLocale: string
) {
  const { t, owner } = site
  const migrationId = await startMigration(site, toLocale)
  expect((await runMigration(t, migrationId)).migration.phase).toBe(
    "validating"
  )
  await validateMigration(t, migrationId)
  await reviewMigration(t, owner, migrationId)
  expect(
    await outcome(async () => {
      await activateMigration(owner, await activationArgs(t, migrationId))
      return "activated"
    })
  ).toEqual(ok("activated"))
  return migrationId
}

async function routesByPath(
  t: T,
  migrationId: MigrationId,
  generation: number
) {
  return new Map(
    (await migrationRoutes(t, migrationId, generation)).map((row) => [
      row.fromPath,
      row,
    ])
  )
}

/**
 * `migrationSite` (`en` default, `fr` enabled) over real publications:
 * `/contact` (`en` only), `/same` (`en` and `fr`), `/moved-old` (an `en` F08
 * historical route to `/moved-new`), `/legacy` (`en` current, and an `fr` F08
 * historical route to `/legacy-fr`) and `/about` (`en`).
 */
async function resolverCorpus() {
  const site = await migrationSite()
  const { owner } = site
  const contactId = await createPage(owner, "contact", ["en", "fr"])
  await publishPage(site, contactId, "en")
  const sameId = await createPage(owner, "same", ["en", "fr"])
  await publishPage(site, sameId, "en")
  await publishPage(site, sameId, "fr")
  const movedId = await createPage(owner, "moved-old", ["en"])
  await publishPage(site, movedId, "en")
  await publishSlug(site, movedId, "en", "moved-new")
  const legacyId = await createPage(owner, "legacy", ["en", "fr"])
  await publishPage(site, legacyId, "en")
  await publishPage(site, legacyId, "fr")
  await publishSlug(site, legacyId, "fr", "legacy-fr")
  return { ...site, contactId, sameId, movedId, legacyId }
}

describe("M05 P6 default migration resolution", () => {
  test("after en → fr an old default URL 308s to the en page, fr claims outrank it, and shadowed or retired rows are never served", async () => {
    const site = await resolverCorpus()
    const { t, aboutId, contactId, sameId, movedId } = site
    const migrationId = await migrateAndActivate(site, "fr")
    expect(await authorityRow(t)).toMatchObject({
      currentLocale: "fr",
      continuityPointer: { migrationId, generation: 1 },
    })
    const rows = await routesByPath(t, migrationId, 1)
    expect(routeView(rows.get("/contact")!)).toEqual({
      fromPath: "/contact",
      pageId: contactId,
      locale: "en",
      origin: "old_default_current",
      capturedPath: "/contact",
    })
    expect(routeView(rows.get("/same")!)).toMatchObject({
      pageId: sameId,
      locale: "en",
      shadow: "to_current",
    })
    expect(routeView(rows.get("/moved-old")!)).toEqual({
      fromPath: "/moved-old",
      pageId: movedId,
      locale: "en",
      origin: "old_default_historical",
    })

    // `/contact` answers with the en page, whose URL `/en/contact` is served
    // directly (the proxy prefix comes from the returned locale).
    expect(await resolvePath(t, "fr", "/contact")).toEqual(
      await redirectTo(t, contactId, "en", "/contact")
    )
    expect(await resolvePath(t, "en", "/contact")).toMatchObject({
      disposition: "current",
      pageId: contactId,
      locale: "en",
    })
    // An en F08 historical route keeps its en destination.
    expect(await resolvePath(t, "fr", "/moved-old")).toEqual(
      await redirectTo(t, movedId, "en", "/moved-new")
    )
    // The stated exception: the fr claim at `/same` is served by fr.
    expect(await resolvePath(t, "fr", "/same")).toMatchObject({
      disposition: "current",
      pageId: sameId,
      locale: "fr",
    })

    // A shadowed row stays unserved after the fr claim that shadowed it is
    // withdrawn: resolve returns no redirect, only a deferred self-heal
    // candidate (the same page in en). The proxy tries manual rules first,
    // then sends `/same` with a 307 to `/en/same`.
    await withdrawPublished(site, sameId, "fr")
    expect(await resolvePath(t, "fr", "/same")).toEqual({
      ...UNCLAIMED,
      selfHeal: expect.objectContaining({
        pageId: sameId,
        locale: "en",
        destinationPath: "/same",
      }),
    })

    // fr publishes over `/contact` after activation: the current route wins.
    // Withdrawing it before any F08 history exists leaves the retired
    // continuity row absent, so the old en redirect never returns.
    await publishPage(site, contactId, "fr")
    expect(await resolvePath(t, "fr", "/contact")).toMatchObject({
      disposition: "current",
      pageId: contactId,
      locale: "fr",
    })
    const firstRetirement = (await routesByPath(t, migrationId, 1)).get(
      "/contact"
    )!
    expect(firstRetirement).toMatchObject({ retiredReason: "to_current" })
    await withdrawPublished(site, contactId, "fr")
    // U3: unclaimed, with the en page as the deferred self-heal candidate.
    expect(await resolvePath(t, "fr", "/contact")).toEqual({
      ...UNCLAIMED,
      selfHeal: expect.objectContaining({ pageId: contactId, locale: "en" }),
    })

    // A later fr publication and path change still creates normal same-locale
    // F08 history, which outranks the absent continuity row.
    await publishSlug(site, contactId, "fr", "contact")
    await publishSlug(site, contactId, "fr", "contact-fr")
    expect(await resolvePath(t, "fr", "/contact")).toEqual(
      await redirectTo(t, contactId, "fr", "/contact-fr")
    )
    expect(
      (await routesByPath(t, migrationId, 1)).get("/contact")
    ).toMatchObject({
      retiredAt: firstRetirement.retiredAt,
      retiredReason: "to_current",
    })

    // A retired row is absent although its destination is still served.
    expect(await resolvePath(t, "fr", "/about")).toEqual(
      await redirectTo(t, aboutId, "en", "/about")
    )
    await t.run((ctx) =>
      ctx.db.patch(rows.get("/about")!._id, {
        retiredAt: FIXED_NOW,
        retiredReason: "to_current",
      })
    )
    // U3: unclaimed, with the en page as the deferred self-heal candidate.
    expect(await resolvePath(t, "fr", "/about")).toEqual({
      ...UNCLAIMED,
      selfHeal: expect.objectContaining({ pageId: aboutId, locale: "en" }),
    })

    // A served row whose destination is withdrawn is claimed but unavailable;
    // once retired it is absent again.
    await withdrawPublished(site, movedId, "en")
    expect(await resolvePath(t, "fr", "/moved-old")).toEqual(UNAVAILABLE)
    await t.run((ctx) =>
      ctx.db.patch(rows.get("/moved-old")!._id, {
        retiredAt: FIXED_NOW,
        retiredReason: "to_historical",
      })
    )
    expect(await resolvePath(t, "fr", "/moved-old")).toEqual(UNCLAIMED)
  }, 180_000)

  test("en → fr → en forms no loop: every redirect lands on a URL served directly, and the first generation's rows are carried or skipped", async () => {
    const site = await resolverCorpus()
    const { t, contactId, frPageId } = site
    const firstId = await migrateAndActivate(site, "fr")
    // The reverse needs an en home at `/` (start's home rule).
    await t.run(async (ctx) => {
      const settings = (await ctx.db.query("siteSettings").unique())!
      await ctx.db.patch(settings._id, { homePageId: site.homeEnId })
    })
    const reverseId = await migrateAndActivate(site, "en")
    expect(await authorityRow(t)).toMatchObject({
      currentLocale: "en",
      continuityPointer: { migrationId: reverseId, generation: 1 },
    })
    expect(
      (await migrationRow(t, reverseId)).counts.carriedShadowedSkipped
    ).toBeGreaterThan(0)

    const paths = new Set(
      [
        ...(await migrationRoutes(t, firstId, 1)),
        ...(await migrationRoutes(t, reverseId, 1)),
      ].map((row) => row.fromPath)
    )
    const hops: unknown[] = []
    for (const path of paths) {
      const first = await resolvePath(t, "en", path)
      if (
        first.authority !== "snapshot_active" ||
        first.disposition !== "historical_redirect"
      ) {
        continue
      }
      const second = await resolvePath(t, first.locale, first.destinationPath)
      hops.push({ path, second })
      expect({ path, second }).toMatchObject({
        path,
        second: {
          disposition: "current",
          pageId: first.pageId,
          locale: first.locale,
        },
      })
    }
    expect(hops.length).toBeGreaterThan(0)
    // The first generation's `/contact` row is outranked by en again, and
    // fr's `/bonjour`, captured by the reverse, redirects to the fr page.
    expect(await resolvePath(t, "en", "/contact")).toMatchObject({
      disposition: "current",
      pageId: contactId,
    })
    expect(await resolvePath(t, "en", "/bonjour")).toEqual(
      await redirectTo(t, frPageId, "fr", "/bonjour")
    )
  }, 300_000)
})

describe("M05 P10b durable retirement", () => {
  test("a default-locale path change retires its new current and old historical claims with one lookup and at most one patch each", async () => {
    const site = await previewSite()
    const { t, aboutId } = site
    const migrationId = await storePointedGeneration(site, [
      { fromPath: "/claimed", pageId: aboutId, locale: "en" },
      { fromPath: "/about", pageId: aboutId, locale: "en" },
    ])
    await saveSlugDraft(site, aboutId, "en", "claimed")
    const args = await publishArgs(t, aboutId, "en")
    const published = await recordSyscalls(() =>
      site.owner.mutation(api.cms.publication.publishLocale, args)
    )
    await drain(t)

    const rows = await routesByPath(t, migrationId, 1)
    expect(rows.get("/claimed")).toMatchObject({
      retiredAt: published.result.publishedAt,
      retiredReason: "to_current",
    })
    expect(rows.get("/about")).toMatchObject({
      retiredAt: published.result.publishedAt,
      retiredReason: "to_historical",
    })
    const continuityReads = readsOfTables(published.sets.reads, [
      "siteDefaultLanguageRoutes",
    ])
    expect(continuityReads).toHaveLength(2)
    for (const read of continuityReads) {
      expect(read).toMatch(
        /by_migrationId_and_generation_and_fromPath.*"limit":2/
      )
    }
    expect(
      published.sets.writes.filter((write) =>
        write.startsWith("patch siteDefaultLanguageRoutes ")
      )
    ).toEqual([
      "patch siteDefaultLanguageRoutes {retiredAt,retiredReason}",
      "patch siteDefaultLanguageRoutes {retiredAt,retiredReason}",
    ])
  }, 120_000)

  test("a same-path republish creates no route claim and performs no continuity lookup", async () => {
    const site = await previewSite()
    const { t, aboutId } = site
    const migrationId = await storePointedGeneration(site, [
      { fromPath: "/about", pageId: aboutId, locale: "en" },
    ])
    await saveSlugDraft(site, aboutId, "en", "about")
    const args = await publishArgs(t, aboutId, "en")
    const published = await recordSyscalls(() =>
      site.owner.mutation(api.cms.publication.publishLocale, args)
    )
    await drain(t)

    expect(
      readsOfTables(published.sets.reads, ["siteDefaultLanguageRoutes"])
    ).toEqual([])
    const row = (await routesByPath(t, migrationId, 1)).get("/about")!
    expect([row.retiredAt, row.retiredReason]).toEqual([undefined, undefined])
  }, 120_000)

  test("a non-default-locale current or historical claim neither reads nor retires the pointed row", async () => {
    const site = await previewSite()
    const { t, aboutId, frPageId } = site
    const migrationId = await storePointedGeneration(site, [
      { fromPath: "/fr-claim", pageId: aboutId, locale: "en" },
    ])
    await saveSlugDraft(site, frPageId, "fr", "fr-claim")
    const args = await publishArgs(t, frPageId, "fr")
    const published = await recordSyscalls(() =>
      site.owner.mutation(api.cms.publication.publishLocale, args)
    )
    await drain(t)

    expect(
      readsOfTables(published.sets.reads, ["siteDefaultLanguageRoutes"])
    ).toEqual([])
    expect(
      published.sets.writes.filter((write) =>
        write.startsWith("patch siteDefaultLanguageRoutes ")
      )
    ).toEqual([])
    const row = (await routesByPath(t, migrationId, 1)).get("/fr-claim")!
    expect([row.retiredAt, row.retiredReason]).toEqual([undefined, undefined])
    expect(await resolvePath(t, "en", "/fr-claim")).toEqual(
      await redirectTo(t, aboutId, "en", "/about")
    )
  }, 120_000)

  test("after return to one language and module disable, publish then withdraw cannot revive the pointed redirect", async () => {
    const site = await buildSite("S1", "absent")
    const { t, aboutId } = site
    await makeMultilingual(t, ["en"])
    const migrationId = await storePointedGeneration(site, [
      { fromPath: "/after-disable", pageId: aboutId, locale: "en" },
    ])
    expect(await outcome(() => returnToSingle(site))).toMatchObject({
      ok: expect.anything(),
    })
    expect(await outcome(() => toggleMultilingual(site, false))).toMatchObject({
      ok: expect.anything(),
    })
    expect(await languageKind(t)).toBe("current")

    await publishSlug(site, aboutId, "en", "after-disable")
    expect(
      (await routesByPath(t, migrationId, 1)).get("/after-disable")
    ).toMatchObject({ retiredReason: "to_current" })
    await withdrawPublished(site, aboutId, "en")
    expect(await resolvePath(t, "en", "/after-disable")).toEqual(UNCLAIMED)
  }, 120_000)

  test("shadowed and duplicate rows are never patched or returned to service", async () => {
    const site = await previewSite()
    const { t, aboutId } = site
    const migrationId = await storePointedGeneration(site, [
      {
        fromPath: "/shadowed-claim",
        pageId: aboutId,
        locale: "en",
        shadow: "to_current",
      },
      { fromPath: "/duplicate-claim", pageId: aboutId, locale: "en" },
      { fromPath: "/duplicate-claim", pageId: aboutId, locale: "en" },
    ])

    await publishSlug(site, aboutId, "en", "shadowed-claim")
    await withdrawPublished(site, aboutId, "en")
    const shadowed = (await migrationRoutes(t, migrationId, 1)).find(
      (row) => row.fromPath === "/shadowed-claim"
    )!
    expect([shadowed.shadow, shadowed.retiredAt]).toEqual([
      "to_current",
      undefined,
    ])
    expect(await resolvePath(t, "en", "/shadowed-claim")).toEqual(UNCLAIMED)

    await publishSlug(site, aboutId, "en", "duplicate-claim")
    await withdrawPublished(site, aboutId, "en")
    const duplicates = (await migrationRoutes(t, migrationId, 1)).filter(
      (row) => row.fromPath === "/duplicate-claim"
    )
    expect(duplicates).toHaveLength(2)
    expect(duplicates.map((row) => row.retiredAt)).toEqual([
      undefined,
      undefined,
    ])
    expect(await resolvePath(t, "en", "/duplicate-claim")).toEqual(UNAVAILABLE)
  }, 120_000)
})

describe("M05 P16 complete enumeration (post-activation half)", () => {
  test("every default-URL path that resolved before activation resolves after it to the same Page and original language, or is disclosed as shadowed; F09 URLs survive adoption and the first migration", async () => {
    const site = await resolverCorpus()
    const { t, aboutId, legacyId, sameId } = site
    await storeF09Continuity(site, "en", [
      { fromPath: "/ueber-uns", pageId: aboutId },
    ])
    // An archived Page keeps its en path, but nothing serves it.
    const archivedId = await createPage(site.owner, "archived", ["en"])
    await publishPage(site, archivedId, "en")
    await site.owner.mutation(api.cms.publication.archivePage, {
      pageId: archivedId,
      expectedLifecycleGeneration: (await generations(t, archivedId, "en"))
        .page!.lifecycleGeneration,
    })
    const visible = await t.run(async (ctx) => {
      const current = await ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_locale_and_currentPath", (q) => q.eq("locale", "en"))
        .collect()
      const historical = await ctx.db
        .query("pageHistoricalLocaleRoutes")
        .withIndex("by_locale_and_fromPath", (q) => q.eq("locale", "en"))
        .collect()
      const f09 = await ctx.db.query("siteLanguageTransitionRoutes").collect()
      return [
        ...current.flatMap((row) => (row.currentPath ? [row.currentPath] : [])),
        ...historical.map((row) => row.fromPath),
        ...f09.map((row) => row.fromPath),
      ]
    })
    const before = new Map<string, Awaited<ReturnType<typeof resolvePath>>>()
    for (const path of visible)
      before.set(path, await resolvePath(t, "en", path))
    const served = [...before].filter(
      ([, result]) =>
        result.authority === "snapshot_active" &&
        (result.disposition === "current" ||
          result.disposition === "historical_redirect")
    )
    // Only the archived Page and the en home fail before activation:
    // `migrationSite` names a cloned fr selection as `homePageId`, so the en
    // home's projection is refused.
    expect(
      [...before.keys()].filter(
        (path) => !served.some(([servedPath]) => servedPath === path)
      )
    ).toEqual(["/", "/archived"])
    // F09 continuity survives adoption.
    expect(before.get("/ueber-uns")).toMatchObject({
      disposition: "historical_redirect",
      pageId: aboutId,
      locale: "en",
      destinationPath: "/about",
    })

    const migrationId = await migrateAndActivate(site, "fr")
    const rows = await routesByPath(t, migrationId, 1)
    const disclosed = (await migrationPages(t, migrationId, 1)).flatMap(
      (page) =>
        page.items.flatMap((item) =>
          item.kind === "shadowed_row" ? [item.fromPath] : []
        )
    )
    const shadowed: string[] = []
    for (const [path, old] of served) {
      if (
        old.authority !== "snapshot_active" ||
        (old.disposition !== "current" &&
          old.disposition !== "historical_redirect")
      ) {
        continue
      }
      const row = rows.get(path)
      expect({ path, row: row !== undefined }).toEqual({ path, row: true })
      const now = await resolvePath(t, "fr", path)
      if (row!.shadow) {
        shadowed.push(path)
        expect(disclosed).toContain(path)
        expect({ path, now }).toMatchObject({ path, now: { locale: "fr" } })
        continue
      }
      expect({ path, now }).toEqual({
        path,
        now: {
          ...old,
          disposition: "historical_redirect",
          destinationPath:
            old.disposition === "current" ? path : old.destinationPath,
          statusCode: 307,
        },
      })
    }
    expect(shadowed.sort()).toEqual(["/legacy", "/same"])
    expect(await resolvePath(t, "fr", "/legacy")).toEqual(
      await redirectTo(t, legacyId, "fr", "/legacy-fr")
    )
    expect(await resolvePath(t, "fr", "/same")).toMatchObject({
      disposition: "current",
      pageId: sameId,
    })
    // F09 continuity survives the first migration.
    expect(await resolvePath(t, "fr", "/ueber-uns")).toEqual(
      await redirectTo(t, aboutId, "en", "/about")
    )
    // The archived Page's row is claimed but never redirects to an unserved
    // Page; restored, it answers with the same en Page.
    expect(routeView(rows.get("/archived")!)).toMatchObject({
      pageId: archivedId,
      locale: "en",
    })
    expect(rows.get("/archived")!.shadow).toBeUndefined()
    // Only the Page lifecycle refuses: the en selection is still current and
    // en is still enabled, so the projection gate alone makes it unavailable.
    expect(await localeState(t, archivedId, "en")).toMatchObject({
      hasCurrentSnapshot: true,
      currentPath: "/archived",
    })
    expect((await settingsRow(t)).enabledLocales).toContain("en")
    expect(await resolvePath(t, "fr", "/archived")).toEqual(UNAVAILABLE)
    await site.owner.mutation(api.cms.publication.restorePage, {
      pageId: archivedId,
      expectedLifecycleGeneration: (await generations(t, archivedId, "en"))
        .page!.lifecycleGeneration,
    })
    expect(await resolvePath(t, "fr", "/archived")).toEqual(
      await redirectTo(t, archivedId, "en", "/archived")
    )
  }, 180_000)
})

/** Reads of the named tables (`query <table>.<index> …` or `get <table>`). */
function readsOfTables(reads: readonly string[], tables: readonly string[]) {
  return reads.filter((read) =>
    tables.includes(read.split(" ")[1]!.split(".")[0]!)
  )
}

/** Read descriptors in `withReads` that `withoutReads` does not issue. */
function readsAdded(withReads: readonly string[], withoutReads: string[]) {
  const remaining = [...withoutReads]
  return withReads.filter((read) => {
    const index = remaining.indexOf(read)
    if (index === -1) return true
    remaining.splice(index, 1)
    return false
  })
}

describe("M05 C3d.1 resolver pointer branch", () => {
  test("under a multilingual authority only the pointed generation answers, only in the default URL space, and F09 routes are never read", async () => {
    const site = await previewSite()
    const { t, aboutId, frPageId } = site
    await storeF09Continuity(site, "en", [
      { fromPath: "/ueber-uns", pageId: aboutId },
      { fromPath: "/in-both", pageId: frPageId },
    ])
    const migrationId = await storePointedGeneration(site, [
      { fromPath: "/in-both", pageId: aboutId, locale: "en" },
      { fromPath: "/old-about", pageId: aboutId, locale: "en" },
      { fromPath: "/bonjour-old", pageId: frPageId, locale: "fr" },
      { fromPath: "/unpublished-nl", pageId: aboutId, locale: "nl" },
      { fromPath: "/twice", pageId: aboutId, locale: "en" },
      { fromPath: "/twice", pageId: aboutId, locale: "en" },
      {
        fromPath: "/shadowed",
        pageId: aboutId,
        locale: "en",
        shadow: "to_current",
      },
      {
        fromPath: "/retired",
        pageId: aboutId,
        locale: "en",
        retiredAt: FIXED_NOW,
      },
    ])
    // A generation the pointer does not name, including a path it shares.
    await t.run(async (ctx) => {
      for (const fromPath of ["/old-about", "/gen-two"]) {
        await ctx.db.insert("siteDefaultLanguageRoutes", {
          migrationId,
          generation: 2,
          fromPath,
          pageId: frPageId,
          locale: "fr",
          origin: "old_default_current",
          createdAt: FIXED_NOW,
        })
      }
    })
    const { languageVersion } = await t.query(
      api.cms.settings.getSiteConfig,
      {}
    )
    const resolve = (locale: string, path: string) =>
      recordSyscalls(() => resolveAt(t, languageVersion, locale, path))

    expect((await resolve("en", "/old-about")).result).toEqual(
      await redirectTo(t, aboutId, "en", "/about")
    )
    // The destination is revalidated and returned in the row's locale.
    expect((await resolve("en", "/bonjour-old")).result).toEqual(
      await redirectTo(t, frPageId, "fr", "/bonjour")
    )
    // A pointed row outranks F09's route at the same path, and a path only
    // F09 holds is unclaimed: F09 routes and the migration are never read.
    const inBoth = await resolve("en", "/in-both")
    expect(inBoth.result).toEqual(await redirectTo(t, aboutId, "en", "/about"))
    const f09Only = await resolve("en", "/ueber-uns")
    expect(f09Only.result).toEqual(UNCLAIMED)
    for (const { sets } of [inBoth, f09Only]) {
      expect(
        readsOfTables(sets.reads, [
          "siteLanguageTransitionRoutes",
          "siteLanguageTransitions",
          "siteDefaultLanguageMigrations",
        ])
      ).toEqual([])
    }
    expect((await resolve("en", "/gen-two")).result).toEqual(UNCLAIMED)
    expect((await resolve("en", "/twice")).result).toEqual(UNAVAILABLE)
    expect((await resolve("en", "/shadowed")).result).toEqual(UNCLAIMED)
    expect((await resolve("en", "/retired")).result).toEqual(UNCLAIMED)
    // U3 (D3a): a row in a language that is not enabled still resolves to
    // the same Page in the request language when it is current there.
    expect((await resolve("en", "/unpublished-nl")).result).toEqual(
      await redirectTo(t, aboutId, "en", "/about")
    )
    // Outside the default URL space the continuity set is not consulted.
    const outside = await resolve("fr", "/old-about")
    expect(outside.result).toEqual(UNCLAIMED)
    expect(
      readsOfTables(outside.sets.reads, ["siteDefaultLanguageRoutes"])
    ).toEqual([])
    // A pointer at a generation with no rows reads as absent.
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, {
        continuityPointer: { migrationId, generation: 7 },
      })
    })
    expect((await resolve("en", "/old-about")).result).toEqual(UNCLAIMED)
    // A destination whose selection is still published but whose language is
    // no longer enabled fails the projection gate alone.
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, {
        continuityPointer: { migrationId, generation: 1 },
      })
    })
    expect(await resolvePath(t, "en", "/bonjour-old")).toEqual(
      await redirectTo(t, frPageId, "fr", "/bonjour")
    )
    await makeMultilingual(t, ["en"])
    expect((await localeState(t, frPageId, "fr")).hasCurrentSnapshot).toBe(true)
    expect(await resolvePath(t, "en", "/bonjour-old")).toEqual(UNAVAILABLE)
  }, 120_000)

  test("after a return to one language and module disable the pointer still resolves (M2 exception 1), and a miss adds exactly one read", async () => {
    const site = await buildSite("S1", "absent")
    const { t, aboutId } = site
    await makeMultilingual(t, ["en"])
    const migrationId = await storePointedGeneration(site, [
      { fromPath: "/old-about", pageId: aboutId, locale: "en" },
      { fromPath: "/uber-uns", pageId: aboutId, locale: "nl" },
      {
        fromPath: "/shadowed",
        pageId: aboutId,
        locale: "en",
        shadow: "to_current",
      },
      {
        fromPath: "/retired",
        pageId: aboutId,
        locale: "en",
        retiredAt: FIXED_NOW,
      },
    ])
    expect(await outcome(() => returnToSingle(site))).toMatchObject({
      ok: expect.anything(),
    })
    expect(await outcome(() => toggleMultilingual(site, false))).toMatchObject({
      ok: expect.anything(),
    })
    expect(await languageKind(t)).toBe("current")
    expect((await authorityRow(t)).continuityPointer).toEqual({
      migrationId,
      generation: 1,
    })
    const { languageVersion } = await t.query(
      api.cms.settings.getSiteConfig,
      {}
    )
    const resolve = (path: string) =>
      recordSyscalls(() => resolveAt(t, languageVersion, "en", path))

    expect((await resolve("/old-about")).result).toEqual(
      await redirectTo(t, aboutId, "en", "/about")
    )
    // U3 (D3a): `nl` is not enabled under the sole-language authority; the
    // row resolves to the Page in the request language.
    expect((await resolve("/uber-uns")).result).toEqual(
      await redirectTo(t, aboutId, "en", "/about")
    )
    expect((await resolve("/shadowed")).result).toEqual(UNCLAIMED)
    expect((await resolve("/retired")).result).toEqual(UNCLAIMED)

    const withPointer = await resolve("/missing")
    await t.run(async (ctx) => {
      const authority = (await ctx.db.query("siteLanguageAuthority").unique())!
      await ctx.db.patch(authority._id, { continuityPointer: undefined })
    })
    const withoutPointer = await resolve("/missing")
    expect([withPointer.result, withoutPointer.result]).toEqual([
      UNCLAIMED,
      UNCLAIMED,
    ])
    const added = readsAdded(withPointer.sets.reads, withoutPointer.sets.reads)
    expect(added).toHaveLength(1)
    expect(added[0]).toMatch(
      /siteDefaultLanguageRoutes.*by_migrationId_and_generation_and_fromPath/
    )
    expect(
      readsAdded(withoutPointer.sets.reads, withPointer.sets.reads)
    ).toEqual([])
  }, 120_000)
})

// ─── M05 C6 (FR1d): Menus present, Search absent (P14) ──────────────────────
// Contract integration matrix, row "M05 + Menus", and the owner decision of
// 2026-09-15: a node whose required label is missing in the requested locale
// is omitted with its subtree, optional text disappears field by field, and
// hrefs keep the same-locale rule. `saveCanonical` refuses a non-enabled
// locale except the F09 target during a transition. Search is excluded from
// this candidate (D-11), so every case here is Search-absent. Each case runs
// with an English and a non-English default.

const P14_MENU = "p14-primary"
const P14_DEFAULTS = ["en", "nl"] as const

type MenuReadSite = Pick<Site, "t" | "owner">

/** Text for each locale, marked with its locale so any leak is visible. */
function marked(locales: readonly string[], value: string) {
  return Object.fromEntries(
    locales.map((locale) => [locale, `${locale}:${value}`])
  )
}

async function readMenu(t: T, locale: string, slug = P14_MENU) {
  const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
  return t.query(api.cms.menus.getWithResolvedLinks, {
    slug,
    locale,
    languageVersion,
  })
}

async function saveMenu(
  site: MenuReadSite,
  locale: string,
  nav: NavItem[],
  slug = P14_MENU
) {
  return site.owner.mutation(api.cms.menus.saveCanonical, {
    slug,
    locale,
    nav,
  })
}

/** Fails when a string authored for `locale` appears anywhere in `value`. */
function expectNoTextFrom(value: unknown, locale: string) {
  expect(JSON.stringify(value)).not.toContain(`"${locale}:`)
}

type P14Site = MenuReadSite & {
  defaultLocale: string
  aboutId: Id<"pages">
  defaultOnlyId: Id<"pages">
  aboutPath: string
  defaultOnlyPath: string
}

/**
 * An adopted multilingual site with `defaultLocale` and `fr`: `about` is
 * published in both, `default-only` in the default only, and one canonical
 * menu exists with no nodes.
 */
async function p14Site(defaultLocale: string): Promise<P14Site> {
  const t = app()
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "P14 site",
    timezone: "UTC",
    defaultLocale,
  })
  await makeMultilingual(t, [defaultLocale, "fr"])
  const aboutId = await createPage(owner, "about", [defaultLocale, "fr"])
  const defaultOnlyId = await createPage(owner, "default-only", [defaultLocale])
  for (const [pageId, locale] of [
    [aboutId, defaultLocale],
    [aboutId, "fr"],
    [defaultOnlyId, defaultLocale],
  ] as const) {
    await owner.mutation(
      api.cms.publication.publishLocale,
      await publishArgs(t, pageId, locale)
    )
  }
  await owner.mutation(api.cms.menus.createCanonical, { slug: P14_MENU })
  await drain(t)
  return {
    t,
    owner,
    defaultLocale,
    aboutId,
    defaultOnlyId,
    aboutPath: (await localeState(t, aboutId, defaultLocale)).currentPath!,
    defaultOnlyPath: (await localeState(t, defaultOnlyId, defaultLocale))
      .currentPath!,
  }
}

/**
 * Every node kind, authored in the default language. `withFr` adds the `fr`
 * text the owner saved; nodes it leaves out have no `fr` text at all.
 */
function p14Nav(site: P14Site, withFr: boolean): NavItem[] {
  const D = [site.defaultLocale]
  const both = withFr ? [site.defaultLocale, "fr"] : D
  const blankFr = (value: string) =>
    withFr ? { ...marked(D, value), fr: "   " } : marked(D, value)
  const emptyAltFr = withFr ? { ...marked(D, "Alt"), fr: "" } : marked(D, "Alt")
  const about = { type: "internal" as const, pageId: site.aboutId }
  const defaultOnly = { type: "internal" as const, pageId: site.defaultOnlyId }
  return [
    {
      id: "full",
      label: marked(both, "Full"),
      target: about,
      panel: {
        columns: 3,
        blocks: [
          {
            id: "group",
            kind: "linkGroup",
            heading: marked(D, "Group"),
            links: [
              {
                id: "link-kept",
                label: marked(both, "Kept link"),
                description: marked(D, "Kept description"),
                target: about,
              },
              {
                id: "link-missing",
                label: marked(D, "Missing link"),
                target: defaultOnly,
              },
              { id: "link-blank", label: blankFr("Blank link"), target: about },
            ],
          },
          {
            id: "featured-kept",
            kind: "featured",
            image: { url: "https://example.test/a.png", alt: emptyAltFr },
            heading: marked(both, "Featured"),
            description: marked(both, "Featured description"),
            target: { type: "external", url: "https://example.test/" },
          },
          {
            id: "featured-no-alt",
            kind: "featured",
            image: {
              url: "https://example.test/b.png",
              alt: marked(D, "No alt"),
            },
            heading: marked(both, "No alt heading"),
            target: about,
          },
          {
            id: "featured-no-heading",
            kind: "featured",
            image: {
              url: "https://example.test/c.png",
              alt: marked(both, "Alt"),
            },
            heading: marked(D, "No heading"),
            target: about,
          },
          {
            id: "list",
            kind: "dynamicList",
            heading: marked(both, "List"),
            source: { pageType: "landing-page", limit: 3 },
            seeAll: {
              label: marked(D, "See all"),
              target: { type: "anchor", anchor: "#all" },
            },
          },
        ],
        footer: {
          blocks: [
            {
              id: "footer-group",
              kind: "linkGroup",
              links: [
                {
                  id: "footer-link",
                  label: marked(D, "Footer link"),
                  target: about,
                },
              ],
            },
          ],
        },
      },
    },
    {
      id: "missing",
      label: marked(D, "Missing"),
      panel: {
        columns: 1,
        blocks: [
          {
            id: "missing-group",
            kind: "linkGroup",
            heading: marked(both, "Child heading"),
            links: [
              {
                id: "missing-child",
                label: marked(both, "Child"),
                target: about,
              },
            ],
          },
        ],
      },
    },
    { id: "hrefs", label: marked(both, "Hrefs"), target: defaultOnly },
  ]
}

/** Default save first (new nodes carry default text only), then `fr`. */
async function seedP14Menu(site: P14Site) {
  await saveMenu(site, site.defaultLocale, p14Nav(site, false))
  await saveMenu(site, "fr", p14Nav(site, true))
  await drain(site.t)
}

describe("M05 P14 Menus present, Search absent (C6)", () => {
  for (const defaultLocale of P14_DEFAULTS) {
    test(`default ${defaultLocale}: an untranslated node is omitted with its subtree, optional text drops field by field, and hrefs stay same-locale`, async () => {
      const site = await p14Site(defaultLocale)
      await seedP14Menu(site)
      const D = defaultLocale
      const aboutFr = `/fr${site.aboutPath}`

      const fr = await readMenu(site.t, "fr")
      expect(fr).toEqual({
        slug: P14_MENU,
        nav: [
          {
            id: "full",
            label: "fr:Full",
            target: { type: "internal", url: aboutFr },
            panel: {
              columns: 3,
              blocks: [
                {
                  id: "group",
                  kind: "linkGroup",
                  links: [
                    {
                      id: "link-kept",
                      label: "fr:Kept link",
                      target: { type: "internal", url: aboutFr },
                    },
                  ],
                },
                {
                  id: "featured-kept",
                  kind: "featured",
                  image: { url: "https://example.test/a.png", alt: "" },
                  heading: "fr:Featured",
                  description: "fr:Featured description",
                  target: { type: "external", url: "https://example.test/" },
                },
                {
                  id: "list",
                  kind: "dynamicList",
                  heading: "fr:List",
                  source: { pageType: "landing-page", limit: 3 },
                },
              ],
              footer: {
                blocks: [{ id: "footer-group", kind: "linkGroup", links: [] }],
              },
            },
          },
          // `default-only` has no `fr` selection: the node keeps its label
          // and gets no URL; no default-language URL is substituted.
          { id: "hrefs", label: "fr:Hrefs", target: { type: "internal" } },
        ],
      })
      expectNoTextFrom(fr, D)

      // The default language keeps every node, with only its own text.
      const home = await readMenu(site.t, D)
      expectNoTextFrom(home, "fr")
      const ids = (value: unknown) =>
        JSON.stringify(value).match(/"id":"[^"]+"/g)
      expect(ids(home)).toEqual(ids(p14Nav(site, true)))
      expect(home!.nav.map((item) => [item.label, item.target])).toEqual([
        [`${D}:Full`, { type: "internal", url: site.aboutPath }],
        [`${D}:Missing`, undefined],
        [`${D}:Hrefs`, { type: "internal", url: site.defaultOnlyPath }],
      ])
    })

    test(`default ${defaultLocale}: saveCanonical refuses a non-enabled locale and writes nothing; add and remove change which locales it accepts and reads`, async () => {
      const site = await p14Site(defaultLocale)
      await seedP14Menu(site)
      const withIt = (nav: NavItem[]) =>
        nav.map((item) =>
          item.id === "full"
            ? { ...item, label: { ...item.label, it: "it:Full" } }
            : item
        )

      expect(
        await refusalWritesNothing(site.t, () =>
          saveMenu(site, "it", withIt(p14Nav(site, true)))
        )
      ).toEqual({ error: "LOCALE_NOT_ENABLED" })

      // Add: the new language accepts text, and reads only its own text.
      expect(await addLanguage(site, "it")).toMatchObject({
        operationKind: "add",
      })
      expect(await readMenu(site.t, "it")).toEqual({ slug: P14_MENU, nav: [] })
      await saveMenu(site, "it", withIt(p14Nav(site, true)))
      const it = await readMenu(site.t, "it")
      expect(it!.nav.map((item) => item.label)).toEqual(["it:Full"])
      // A dynamic list has no required label, so only its optional heading
      // and its see-all link (whose label is required) drop.
      expect(legacyPanel(it!.nav[0]!.panel!).blocks).toEqual([
        { id: "group", kind: "linkGroup", links: [] },
        {
          id: "list",
          kind: "dynamicList",
          source: { pageType: "landing-page", limit: 3 },
        },
      ])
      expectNoTextFrom(it, defaultLocale)
      expectNoTextFrom(it, "fr")

      // Remove: the removed language is neither accepted nor read, and the
      // default and remaining languages are unchanged.
      const frBefore = await readMenu(site.t, "fr")
      const defaultBefore = await readMenu(site.t, defaultLocale)
      await removeLocale(site, "it")
      expect(await readMenu(site.t, "it")).toEqual({ slug: P14_MENU, nav: [] })
      expect(
        await refusalWritesNothing(site.t, () =>
          saveMenu(site, "it", withIt(p14Nav(site, true)))
        )
      ).toEqual({ error: "LOCALE_NOT_ENABLED" })
      expect(await readMenu(site.t, "fr")).toEqual(frBefore)
      expect(await readMenu(site.t, defaultLocale)).toEqual(defaultBefore)
    }, 60_000)

    test(`default ${defaultLocale}: under the F09 single-language authority only the current language is accepted`, async () => {
      const t = app()
      const owner = t.withIdentity(OWNER)
      await owner.mutation(api.cms.settings.bootstrapInstallation, {
        siteName: "P14 F09 site",
        timezone: "UTC",
        defaultLocale,
      })
      await owner.mutation(api.cms.menus.createCanonical, { slug: P14_MENU })
      const other = defaultLocale === "en" ? "nl" : "en"
      const nav: NavItem[] = [{ id: "a", label: marked([defaultLocale], "A") }]
      await saveMenu({ t, owner }, defaultLocale, nav)
      expect(
        await refusalWritesNothing(t, () =>
          saveMenu({ t, owner }, other, [
            { id: "a", label: { ...nav[0]!.label, [other]: "x" } },
          ])
        )
      ).toEqual({ error: "LOCALE_NOT_ENABLED" })
    })
  }

  test("default change en → fr: after activation the new non-English default reads every node, and `en` omits nodes without `en` text", async () => {
    const site = await migrationSite()
    const { t } = site
    const both = ["en", "fr"]
    await site.owner.mutation(api.cms.menus.createCanonical, {
      slug: P14_MENU,
    })
    const nav = (locales: readonly string[]): NavItem[] => [
      {
        id: "shared",
        label: marked(locales, "Shared"),
        target: { type: "anchor", anchor: "#shared" },
        panel: {
          columns: 1,
          blocks: [
            {
              id: "shared-group",
              kind: "linkGroup",
              heading: marked(locales, "Heading"),
              links: [
                {
                  id: "shared-link",
                  label: marked(locales, "Link"),
                  description: marked(["en"], "Old-default description"),
                  target: { type: "anchor", anchor: "#link" },
                },
              ],
            },
          ],
        },
      },
    ]
    await saveMenu(site, "en", nav(["en"]))
    await saveMenu(site, "fr", nav(both))
    await drain(t)

    const migrationId = await startMigration(site)
    expect((await runMigration(t, migrationId)).migration.phase).toBe(
      "validating"
    )
    await validateMigration(t, migrationId)
    await reviewMigration(t, site.owner, migrationId)
    expect(
      await activateMigration(site.owner, await activationArgs(t, migrationId))
    ).toMatchObject({ locale: "fr" })

    // A node added under the new default carries `fr` text only.
    const [shared] = nav(both)
    const added: NavItem = {
      id: "added",
      label: marked(["fr"], "Added"),
      target: { type: "anchor", anchor: "#added" },
    }
    await saveMenu(site, "fr", [shared!, added])
    await drain(t)

    const fr = await readMenu(t, "fr")
    expect(fr!.nav.map((item) => item.label)).toEqual(["fr:Shared", "fr:Added"])
    expect(legacyPanel(fr!.nav[0]!.panel!).blocks).toEqual([
      {
        id: "shared-group",
        kind: "linkGroup",
        heading: "fr:Heading",
        links: [
          {
            id: "shared-link",
            label: "fr:Link",
            target: { type: "anchor", url: "#link" },
          },
        ],
      },
    ])
    expectNoTextFrom(fr, "en")

    const en = await readMenu(t, "en")
    expect(en!.nav.map((item) => item.label)).toEqual(["en:Shared"])
    expect(legacyPanel(en!.nav[0]!.panel!).blocks[0]).toMatchObject({
      links: [{ id: "shared-link", description: "en:Old-default description" }],
    })
    expectNoTextFrom(en, "fr")
  }, 120_000)
})

// ─── M05 A5: the site description per language ─────────────────────────────

async function storedSiteDescriptions(t: T) {
  const settings = await settingsRow(t)
  return {
    defaultLocale: settings.defaultLocale,
    siteDescription: settings.siteDescription,
    siteDescriptions: settings.siteDescriptions,
  }
}

async function seedSiteDescriptions(
  t: T,
  fields: {
    siteDescription?: string
    siteDescriptions?: Record<string, string>
  }
) {
  await t.run(async (ctx) => {
    const settings = (await ctx.db.query("siteSettings").unique())!
    await ctx.db.patch(settings._id, fields)
  })
}

async function multilingualSite() {
  const site = await buildSite("S1", "absent")
  await makeMultilingual(site.t, ["en", "fr"])
  return site
}

function publicDescription(t: T, locale: string, languageVersion: number) {
  return t
    .query(api.cms.settings.getPublicChrome, { locale, languageVersion })
    .then((chrome) => chrome.siteDescription)
}

describe("M05 A5 site description per language", () => {
  test("the first per-language write stores the legacy value under the outgoing default, once", async () => {
    const { t, owner } = await multilingualSite()
    await seedSiteDescriptions(t, { siteDescription: "Hello" })

    await owner.mutation(api.cms.settings.updateSettings, {
      siteDescriptions: { fr: "Bonjour" },
    })
    expect(await storedSiteDescriptions(t)).toEqual({
      defaultLocale: "en",
      siteDescription: undefined,
      siteDescriptions: { en: "Hello", fr: "Bonjour" },
    })

    // A later write keeps the stored text; the legacy field is gone for good.
    await owner.mutation(api.cms.settings.updateSettings, {
      siteDescriptions: { fr: "Salut" },
    })
    expect(await storedSiteDescriptions(t)).toEqual({
      defaultLocale: "en",
      siteDescription: undefined,
      siteDescriptions: { en: "Hello", fr: "Salut" },
    })
  })

  test("a write merges: empty text clears one language and keeps the others, including a removed language", async () => {
    const { t, owner } = await multilingualSite()
    await seedSiteDescriptions(t, {
      siteDescriptions: { en: "Hello", fr: "Bonjour", de: "Hallo" },
    })

    await owner.mutation(api.cms.settings.updateSettings, {
      siteDescriptions: { fr: "  " },
    })
    expect((await storedSiteDescriptions(t)).siteDescriptions).toEqual({
      en: "Hello",
      de: "Hallo",
    })

    await owner.mutation(api.cms.settings.updateSettings, {
      siteDescriptions: { en: "" },
    })
    await owner.mutation(api.cms.settings.updateSettings, {
      siteDescription: "",
    })
    expect((await storedSiteDescriptions(t)).siteDescriptions).toEqual({
      de: "Hallo",
    })
  })

  test("a description-only save schedules the public-site settings refresh", async () => {
    const { t, owner } = await multilingualSite()
    const refreshes = async () =>
      (await scheduledSteps(t)).filter((step) =>
        step.name.includes("revalidateSettings")
      )
    const before = (await refreshes()).length
    await owner.mutation(api.cms.settings.updateSettings, {
      siteDescriptions: { fr: "Bonjour" },
    })
    expect((await refreshes()).length).toBe(before + 1)
    // A save that changes no routing field and no description schedules nothing.
    await owner.mutation(api.cms.settings.updateSettings, {
      siteName: "Renamed",
    })
    expect((await refreshes()).length).toBe(before + 1)
  })

  test("the single-value argument writes the default language", async () => {
    const { t, owner } = await multilingualSite()
    await owner.mutation(api.cms.settings.updateSettings, {
      siteDescription: "Hello",
    })
    expect(await storedSiteDescriptions(t)).toEqual({
      defaultLocale: "en",
      siteDescription: undefined,
      siteDescriptions: { en: "Hello" },
    })
  })

  test("a description for a language that is not enabled is refused and nothing is written", async () => {
    const { t, owner } = await multilingualSite()
    await seedSiteDescriptions(t, { siteDescription: "Hello" })
    const error = await owner
      .mutation(api.cms.settings.updateSettings, {
        siteDescriptions: { fr: "Bonjour", de: "Hallo" },
      })
      .then(
        () => undefined,
        (caught: unknown) => caught
      )
    // The code only: the admin shows plain words through the caught-error list.
    expect(error).toBeInstanceOf(ConvexError)
    expect((error as ConvexError<{ code: string }>).data).toEqual({
      code: "SITE_DESCRIPTION_LOCALE_NOT_ENABLED",
    })
    expect(await storedSiteDescriptions(t)).toEqual({
      defaultLocale: "en",
      siteDescription: "Hello",
      siteDescriptions: undefined,
    })
  })

  test("a write that touches no description leaves the legacy value where it is", async () => {
    const { t, owner } = await multilingualSite()
    await seedSiteDescriptions(t, { siteDescription: "Hello" })
    await owner.mutation(api.cms.settings.updateSettings, {
      siteName: "Renamed",
    })
    expect(await storedSiteDescriptions(t)).toEqual({
      defaultLocale: "en",
      siteDescription: "Hello",
      siteDescriptions: undefined,
    })
  })

  test("the public read answers for one enabled language only, pinned to the version", async () => {
    const { t, owner } = await multilingualSite()
    await seedSiteDescriptions(t, {
      siteDescriptions: { en: "Hello", fr: "Bonjour", de: "Hallo" },
    })
    const version = await authorityVersion(t)

    expect(await publicDescription(t, "en", version)).toBe("Hello")
    expect(await publicDescription(t, "fr", version)).toBe("Bonjour")
    // Stored, but not an enabled language: never served.
    expect(await publicDescription(t, "de", version)).toBeUndefined()
    expect(
      (await t.query(api.cms.settings.getPublicChrome, {})).siteDescription
    ).toBeUndefined()

    expect(
      await outcome(() => publicDescription(t, "en", version + 1))
    ).toEqual({ error: "SITE_LANGUAGE_VERSION_CHANGED" })

    // The legacy value stands in for the default language alone.
    await seedSiteDescriptions(t, {
      siteDescription: "Legacy",
      siteDescriptions: undefined,
    })
    expect(await publicDescription(t, "en", version)).toBe("Legacy")
    expect(await publicDescription(t, "fr", version)).toBeUndefined()

    // An empty or cleared language emits nothing, never another's text.
    await owner.mutation(api.cms.settings.updateSettings, {
      siteDescriptions: { en: "Hello" },
    })
    expect(await publicDescription(t, "fr", version)).toBeUndefined()
  })

  test("the make-default commit stores the legacy value under the outgoing default, so the change never relabels it", async () => {
    const { site, migrationId } = await readyMigration()
    const { t, owner } = site
    await seedSiteDescriptions(t, { siteDescription: "Hello" })

    const { version } = await activateMigration(
      owner,
      await activationArgs(t, migrationId)
    )

    expect(await storedSiteDescriptions(t)).toEqual({
      defaultLocale: "fr",
      siteDescription: undefined,
      siteDescriptions: { en: "Hello" },
    })
    expect(await publicDescription(t, "fr", version)).toBeUndefined()
    expect(await publicDescription(t, "en", version)).toBe("Hello")
  })

  test("setup stores the description under the chosen language and a resumed setup still matches", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    const args = {
      siteName: "Setup site",
      timezone: "UTC",
      defaultLocale: "fr",
      siteDescription: "Bonjour",
    }
    await owner.mutation(api.cms.settings.bootstrapInstallation, args)
    expect(await storedSiteDescriptions(t)).toEqual({
      defaultLocale: "fr",
      siteDescription: undefined,
      siteDescriptions: { fr: "Bonjour" },
    })
    await expect(
      owner.mutation(api.cms.settings.bootstrapInstallation, args)
    ).resolves.toMatchObject({ phase: "snapshot_active" })
    expect(
      await outcome(() =>
        owner.mutation(api.cms.settings.bootstrapInstallation, {
          ...args,
          siteDescription: "Different",
        })
      )
    ).toEqual({ error: "INSTALLATION_ALREADY_BOOTSTRAPPED" })
  })
})

// ─── A4 combined language commands (L2a) ────────────────────────────────────
//
// `addSiteLanguage`, `prepareLanguageReview`, `removeLastExtraLanguage`,
// `modules.commit`, `needsReviewToAddLanguage` and the
// `commandTokens` field. Each combined command is one transaction over the
// existing helpers; these tests prove the composition (state matrix, entry
// tokens, rollback, intents, owner-only), not Convex's transaction semantics.

type CommandStateName = "S0" | "S1" | "S2" | "S3x" | "S3r" | "S4one"

async function commandTokens(site: Pick<Site, "owner">) {
  return (await site.owner.query(api.cms.multilingual.getMultilingualState, {}))
    .commandTokens
}

type Tokens = Awaited<ReturnType<typeof commandTokens>>

function entryArgs(tokens: Tokens) {
  return {
    expectedSettingsUpdatedAt: tokens.settingsUpdatedAt!,
    expectedModuleConfigurationVersion: tokens.moduleConfigurationVersion,
    expectedAuthorityVersion: tokens.authorityVersion,
  }
}

async function addSite(
  site: Pick<Site, "owner">,
  locale: string,
  tokens: Tokens,
  claim?: PreviewClaim
) {
  return site.owner.mutation(api.cms.multilingual.addSiteLanguage, {
    locale,
    ...entryArgs(tokens),
    ...(claim ? { preview: claim } : {}),
  })
}

function prepareReview(
  site: Pick<Site, "owner">,
  locale: string,
  tokens: Tokens
) {
  return site.owner.mutation(api.cms.multilingual.prepareLanguageReview, {
    locale,
    ...entryArgs(tokens),
  })
}

function prepareChange(site: Pick<Site, "owner">, tokens: Tokens) {
  return site.owner.mutation(
    api.cms.multilingual.prepareLanguageChange,
    entryArgs(tokens)
  )
}

async function applyModulesDisable(
  site: Pick<Site, "owner">,
  tokens: Pick<Tokens, "authorityVersion" | "moduleConfigurationVersion">
) {
  const state = await site.owner.query(
    api.cms.multilingual.getMultilingualState,
    {}
  )
  const result = await site.owner.mutation(api.cms.modules.commit, {
    expectedConfigurationVersion: tokens.moduleConfigurationVersion,
    changes: [{ moduleId: "multilingual", enabled: false }],
    multilingualCommandTokens: {
      ...state.commandTokens,
      authorityVersion: tokens.authorityVersion,
      moduleConfigurationVersion: tokens.moduleConfigurationVersion,
    },
  })
  const after = await site.owner.query(
    api.cms.multilingual.getMultilingualState,
    {}
  )
  return {
    authorityVersion: after.commandTokens.authorityVersion,
    moduleConfigurationVersion: result.configurationVersion,
    locale: after.defaultLocale,
  }
}

/** One site per starting state; `S4one` is a prepared one-language S4. */
async function commandSite(state: CommandStateName): Promise<Site> {
  if (state === "S0" || state === "S1" || state === "S2") {
    return buildSite(state, "absent")
  }
  const site = await buildSite(state === "S3x" ? "S0" : "S1", "absent")
  if (state === "S3x") {
    await toggleMultilingual(site, true)
  } else if (state === "S3r") {
    await toggleMultilingual(site, true)
    await adopt(site)
    await site.owner.mutation(api.cms.multilingual.returnToSingleLanguage, {
      expectedAuthorityVersion: await authorityVersion(site.t),
    })
  } else {
    await toggleMultilingual(site, true)
    await prepareReview(site, "nl", await commandTokens(site))
  }
  return site
}

/**
 * The site as the owner has it after switching Multilingual on in Modules:
 * the only way the module turns on now (owner 2026-11-05).
 */
async function onSite(state: CommandStateName): Promise<Site> {
  const site = await commandSite(state)
  if (!(await moduleEnabledNow(site.t))) await toggleMultilingual(site, true)
  return site
}

/** Clones a published `en` state row into `locale` at `path` (no counter moves). */
async function seedStateRow(
  site: Site,
  from: { locale: string; to: string; path: string }
) {
  await site.t.run(async (ctx) => {
    const template = (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", site.aboutId).eq("locale", from.locale)
      )
      .unique())!
    const { _id, _creationTime, currentPath, pageId, locale, ...row } = template
    void _id
    void _creationTime
    void currentPath
    void pageId
    void locale
    const {
      _id: pageDocId,
      _creationTime: pageCreatedAt,
      ...page
    } = (await ctx.db.get(site.aboutId))!
    void pageDocId
    void pageCreatedAt
    const clone = await ctx.db.insert("pages", {
      ...page,
      slug: `a4-${from.to}-${from.path.replace(/\W/g, "")}`,
    } as never)
    await ctx.db.insert("pagePublicationPageStates", {
      pageId: clone,
      modelVersion: 1,
      lifecycleState: "active",
      lifecycleGeneration: 1,
      createdAt: FIXED_NOW,
      updatedAt: FIXED_NOW,
    })
    await ctx.db.insert("pageLocalePublicationStates", {
      ...row,
      pageId: clone,
      locale: from.to,
      currentPath: from.path,
    })
  })
}

const seedDefaultShadow = (site: Site, prefix: string) =>
  seedStateRow(site, { locale: "en", to: "en", path: `/${prefix}/taken` })
const seedHiddenSelection = (site: Site, locale: string) =>
  seedStateRow(site, { locale: "en", to: locale, path: `/${locale}-page` })

async function newIntents(t: T, run: () => Promise<unknown>) {
  const before = new Set((await intentsOf(t)).map((i) => i.operationId))
  await run()
  return (await intentsOf(t)).filter((i) => !before.has(i.operationId))
}

async function moduleEnabledNow(t: T) {
  return t.run(
    async (ctx) =>
      (await ctx.db.query("cmsModuleState").first())?.enabledModules.some(
        (entry) => entry.moduleId === "multilingual"
      ) ?? false
  )
}

describe("M05 A4 command tokens", () => {
  test("report null for no authority row and no settings, never 0", async () => {
    const reported: Record<string, unknown> = {}
    for (const state of ["S0", "S1", "S2", "S3x", "S4one"] as const) {
      const site = await commandSite(state)
      const tokens = await commandTokens(site)
      reported[state] = {
        authority: tokens.authorityVersion,
        settings: typeof tokens.settingsUpdatedAt,
        module: tokens.moduleConfigurationVersion,
      }
    }
    expect(reported).toEqual({
      S0: { authority: null, settings: "number", module: 0 },
      S1: { authority: 1, settings: "number", module: 0 },
      S2: { authority: null, settings: "number", module: 0 },
      S3x: { authority: null, settings: "number", module: 1 },
      S4one: { authority: 2, settings: "number", module: 1 },
    })
  })

  test("invalid language state still reports what is readable", async () => {
    const site = await inventorySite("INV")
    const state = await site.owner.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    expect(state.lifecycleState).toBe("IX")
    expect(state.commandTokens).toMatchObject({
      settingsUpdatedAt: expect.any(Number),
      authorityVersion: null,
    })
  })
})

describe("M05 A4 needsReviewToAddLanguage", () => {
  test("a plain add needs no review in any enabled, unadopted state", async () => {
    for (const state of ["S0", "S1", "S2", "S3x"] as const) {
      const site = await onSite(state)
      expect({
        state,
        result: await site.owner.query(
          api.cms.multilingual.needsReviewToAddLanguage,
          { locale: "nl" }
        ),
      }).toEqual({
        state,
        result: {
          needsReview: false,
          reasons: [],
          conflicts: [],
          moreConflicts: false,
        },
      })
    }
  })

  test("a default-language address under the new prefix is reported on enabled unadopted sites and by S4", async () => {
    for (const state of ["S0", "S1", "S2", "S3x", "S4one"] as const) {
      const site = await onSite(state)
      await seedDefaultShadow(site, "nl")
      expect({
        state,
        result: await site.owner.query(
          api.cms.multilingual.needsReviewToAddLanguage,
          { locale: "nl" }
        ),
      }).toEqual({
        state,
        result: {
          needsReview: false,
          reasons: [],
          conflicts: [
            expect.objectContaining({
              kind: "page",
              publicPath: expect.stringMatching(/^\/nl(\/|$)/),
              pageId: expect.any(String),
            }),
          ],
          moreConflicts: false,
        },
      })
    }
  })

  test("pages kept in the language are not a conflict and need no review", async () => {
    const site = await onSite("S1")
    await seedHiddenSelection(site, "nl")
    expect(
      await site.owner.query(api.cms.multilingual.needsReviewToAddLanguage, {
        locale: "nl",
      })
    ).toEqual({
      needsReview: false,
      reasons: [],
      conflicts: [],
      moreConflicts: false,
    })
  })

  test("it refuses a locale that cannot be added and invalid state, and writes nothing", async () => {
    const site = await onSite("S1")
    expect(
      await outcome(() =>
        site.owner.query(api.cms.multilingual.needsReviewToAddLanguage, {
          locale: "en",
        })
      )
    ).toEqual(refused("LOCALE_ALREADY_ENABLED"))
    expect(
      await outcome(() =>
        site.owner.query(api.cms.multilingual.needsReviewToAddLanguage, {
          locale: "xx",
        })
      )
    ).toEqual(refused("LOCALE_UNSUPPORTED"))
    const broken = await inventorySite("INV")
    await enableMultilingualModule(broken.t)
    expect(
      await outcome(() =>
        broken.owner.query(api.cms.multilingual.needsReviewToAddLanguage, {
          locale: "nl",
        })
      )
    ).toEqual(refused("SITE_LANGUAGE_AUTHORITY_INVALID"))
  })
})

describe("M05 A4 addSiteLanguage", () => {
  const CASES: {
    state: CommandStateName
    locales: string[]
    steps: string[]
  }[] = [
    { state: "S0", locales: ["en", "nl"], steps: ["adopt", "add"] },
    { state: "S1", locales: ["en", "nl"], steps: ["adopt", "add"] },
    {
      state: "S2",
      locales: ["en", "fr", "nl"],
      steps: ["adopt", "add"],
    },
    { state: "S3x", locales: ["en", "nl"], steps: ["adopt", "add"] },
    { state: "S3r", locales: ["en", "nl"], steps: ["adopt", "add"] },
    { state: "S4one", locales: ["en", "nl"], steps: ["add"] },
  ]

  test.each(CASES)(
    "with Multilingual on, from $state it lands in S4 with $locales and one intent per step",
    async ({ state, locales, steps }) => {
      const site = await onSite(state)
      const tokens = await commandTokens(site)
      const result = { value: null as unknown }
      const intents = await newIntents(site.t, async () => {
        result.value = await addSite(site, "nl", tokens)
      })
      const after = await commandTokens(site)
      expect(result.value).toEqual({
        ok: true,
        authorityVersion: after.authorityVersion,
        moduleConfigurationVersion: after.moduleConfigurationVersion,
        settingsUpdatedAt: after.settingsUpdatedAt,
        defaultLocale: "en",
        enabledLocales: locales,
        operationKind: "add",
      })
      expect(await lifecycleOf(site)).toBe("S4")
      expect(await moduleEnabledNow(site.t)).toBe(true)

      // One intent per underlying step, each with its own id and version.
      let config = tokens.moduleConfigurationVersion
      let version = tokens.authorityVersion ?? 0
      const expected = steps.map((step) => {
        if (step === "toggle") {
          config += 1
          return {
            operationId: `module_toggle:c${config}`,
            kind: "module_toggle",
          }
        }
        version += 1
        return {
          operationId: `${step === "adopt" ? "adopt" : "add"}:v${version}`,
          kind: step === "adopt" ? "adopt" : "add",
          captured: version,
        }
      })
      expect(
        intents
          .map((intent) => ({
            operationId: intent.operationId,
            kind: intent.operationKind,
            ...(intent.operationKind === "module_toggle"
              ? {}
              : { captured: intent.capturedAuthorityVersion }),
          }))
          .sort((a, b) => a.operationId.localeCompare(b.operationId))
      ).toEqual(
        expected.sort((a, b) => a.operationId.localeCompare(b.operationId))
      )
      expect(after.moduleConfigurationVersion).toBe(config)
      expect(after.authorityVersion).toBe(version)
    },
    60_000
  )

  test("S2 adoption keeps every language and publishes nothing", async () => {
    const site = await onSite("S2")
    const surface = await publicSurface(site.t)
    await addSite(site, "nl", await commandTokens(site))
    const state = await site.owner.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    expect(state.enabledLocales).toEqual(["en", "fr", "nl"])
    const withoutSettings = (value: unknown) => {
      const { settings, ...rest } = value as Record<string, unknown>
      void settings
      return rest
    }
    expect(withoutSettings(await publicSurface(site.t))).toEqual(
      withoutSettings(surface)
    )
  })

  test("invalid language state refuses with no write in every command", async () => {
    const site = await inventorySite("INV")
    await enableMultilingualModule(site.t)
    const tokens = await commandTokens(site)
    for (const run of [
      () => addSite(site, "nl", tokens),
      () => prepareReview(site, "nl", tokens),
      () => applyModulesDisable(site, tokens),
    ]) {
      expect(await refusalWritesNothing(site.t, run)).toEqual(
        refused("SITE_LANGUAGE_AUTHORITY_INVALID")
      )
    }
  })

  test("a stale token refuses with zero committed writes, even where its step is skipped", async () => {
    const wrong: Array<[keyof ReturnType<typeof entryArgs>, number]> = [
      ["expectedSettingsUpdatedAt", 1],
      ["expectedAuthorityVersion", 1],
      ["expectedModuleConfigurationVersion", 1],
    ]
    for (const state of ["S0", "S1", "S2", "S3x", "S3r", "S4one"] as const) {
      const site = await onSite(state)
      const tokens = await commandTokens(site)
      for (const [field, bump] of wrong) {
        const args = entryArgs(tokens)
        const moduleOff = !(await moduleEnabledNow(site.t))
        const code =
          field === "expectedModuleConfigurationVersion" && moduleOff
            ? "CMS_MODULE_CONFIGURATION_STALE"
            : "LANGUAGE_OPERATION_STALE"
        const bumped = { ...args, [field]: (args[field] ?? 0) + bump }
        for (const [name, run] of [
          [
            "addSiteLanguage",
            () =>
              site.owner.mutation(api.cms.multilingual.addSiteLanguage, {
                locale: "nl",
                ...bumped,
              }),
          ],
          [
            "prepareLanguageReview",
            () =>
              site.owner.mutation(api.cms.multilingual.prepareLanguageReview, {
                locale: "nl",
                ...bumped,
              }),
          ],
        ] as const) {
          // addSiteLanguage reports a stale token as a structured result
          // (Convex application results); the prepare command still throws.
          const expected =
            name === "addSiteLanguage"
              ? { ok: { ok: false, code: "SITE_LANGUAGE_VERSION_CHANGED" } }
              : refused(code)
          expect({
            state,
            field,
            name,
            result: await refusalWritesNothing(site.t, run),
          }).toEqual({ state, field, name, result: expected })
        }
      }
    }
  }, 120_000)

  test("an address conflict returns a structured result before any write, module and authority untouched", async () => {
    for (const [state, seed] of [
      ["S0", (s: Site) => seedDefaultShadow(s, "nl")],
      ["S1", (s: Site) => seedDefaultShadow(s, "nl")],
      ["S2", (s: Site) => seedDefaultShadow(s, "nl")],
      ["S3x", (s: Site) => seedDefaultShadow(s, "nl")],
    ] as const) {
      const site = await onSite(state)
      await seed(site)
      const tokens = await commandTokens(site)
      const moduleBefore = await moduleEnabledNow(site.t)
      const result = await refusalWritesNothing(site.t, () =>
        addSite(site, "nl", tokens)
      )
      expect({ state, result }).toEqual({
        state,
        result: {
          ok: {
            ok: false,
            code: "LANGUAGE_ADDRESS_CONFLICT",
            conflicts: [
              {
                kind: "page",
                publicPath: expect.stringMatching(/^\/nl(\/|$)/),
                pageId: expect.any(String),
              },
            ],
            moreConflicts: false,
          },
        },
      })
      expect(await moduleEnabledNow(site.t)).toBe(moduleBefore)
      expect(await commandTokens(site)).toEqual(tokens)
    }
  }, 120_000)

  test("a re-added language with kept pages comes back as a reveal with no preview", async () => {
    const site = await onSite("S1")
    await seedHiddenSelection(site, "nl")
    const previewsBefore = await site.t.run((ctx) =>
      ctx.db.query("siteLanguageImpactPreviews").collect()
    )
    const result = await addSite(site, "nl", await commandTokens(site))
    expect(result).toMatchObject({
      ok: true,
      enabledLocales: ["en", "nl"],
      operationKind: "reveal",
    })
    expect(
      await site.t.run((ctx) =>
        ctx.db.query("siteLanguageImpactPreviews").collect()
      )
    ).toEqual(previewsBefore)
    expect(
      (await intentsOf(site.t)).map((intent) => intent.operationId)
    ).toContain(
      `reveal:v${(result as { authorityVersion: number }).authorityVersion}`
    )
  }, 120_000)

  test("a supplied preview is ignored: not required, not consumed", async () => {
    const site = await onSite("S1")
    await seedHiddenSelection(site, "nl")
    await prepareReview(site, "nl", await commandTokens(site))
    const previewId = await reviewedReveal(site, "nl")
    const result = await addSite(
      site,
      "nl",
      await commandTokens(site),
      await previewClaim(site.t, previewId)
    )
    expect(result).toMatchObject({ ok: true, operationKind: "reveal" })
    expect((await previewRow(site.t, previewId)).phase).not.toBe("consumed")
  }, 120_000)

  test("a bounded conflict list: ten shown, the rest flagged", async () => {
    const site = await onSite("S1")
    for (let index = 0; index < 12; index += 1) {
      await seedStateRow(site, {
        locale: "en",
        to: "en",
        path: `/nl/seite-${index}`,
      })
    }
    const advisory = await site.owner.query(
      api.cms.multilingual.needsReviewToAddLanguage,
      { locale: "nl" }
    )
    expect(advisory.conflicts).toHaveLength(10)
    expect(advisory.moreConflicts).toBe(true)
  }, 120_000)

  test("a locale that cannot be added refuses with no write", async () => {
    const site = await onSite("S1")
    const tokens = await commandTokens(site)
    expect(
      await refusalWritesNothing(site.t, () => addSite(site, "xx", tokens))
    ).toEqual(refused("LOCALE_UNSUPPORTED"))
    expect(
      await refusalWritesNothing(site.t, () => addSite(site, "en", tokens))
    ).toEqual(refused("LOCALE_ALREADY_ENABLED"))
  })
})

describe("M05 A4 prepareLanguageReview and cancel", () => {
  test("from one language it adopts only; cancelling returns and disables with prepare's tokens", async () => {
    for (const state of ["S0", "S1"] as const) {
      const site = await onSite(state)
      const before = await commandTokens(site)
      const intents = await newIntents(site.t, async () => {
        const prepared = await prepareReview(site, "nl", before)
        expect(prepared).toMatchObject({
          defaultLocale: "en",
          enabledLocales: ["en"],
          cancelReturnsToOneLanguage: true,
        })
        expect(await lifecycleOf(site)).toBe("S4")
        expect(
          await applyModulesDisable(site, {
            authorityVersion: prepared.authorityVersion,
            moduleConfigurationVersion: prepared.moduleConfigurationVersion,
          })
        ).toMatchObject({ locale: "en" })
      })
      expect(intents.map((intent) => intent.operationKind).sort()).toEqual(
        ["adopt", "module_toggle", "return_to_single"].sort()
      )
      // Back in one language with the module off: S1 (an authority row stays).
      expect(await lifecycleOf(site)).toBe("S1")
      expect(await moduleEnabledNow(site.t)).toBe(false)
    }
  }, 120_000)

  test("from S2 every language stays and cancel must not return", async () => {
    const site = await onSite("S2")
    const prepared = await prepareReview(site, "nl", await commandTokens(site))
    expect(prepared).toMatchObject({
      enabledLocales: ["en", "fr"],
      cancelReturnsToOneLanguage: false,
    })
    expect(await lifecycleOf(site)).toBe("S4")
    expect(
      await outcome(() =>
        applyModulesDisable(site, {
          authorityVersion: prepared.authorityVersion,
          moduleConfigurationVersion: prepared.moduleConfigurationVersion,
        })
      )
    ).toEqual(refused("CMS_MODULE_TRANSITION_BLOCKED"))
  })

  test("an abandoned one-language S4 still accepts a reviewed add", async () => {
    const site = await onSite("S1")
    await seedDefaultShadow(site, "nl")
    await prepareReview(site, "nl", await commandTokens(site))
    const previewId = await reviewedReveal(site, "nl")
    expect(
      await addLanguage(site, "nl", await previewClaim(site.t, previewId))
    ).toMatchObject({ enabledLocales: ["en", "nl"] })
  }, 120_000)

  test("preparing an adopted site changes nothing", async () => {
    const site = await commandSite("S4one")
    const before = await commandTokens(site)
    const rows = await everyRow(site.t)
    expect(await prepareReview(site, "nl", before)).toMatchObject({
      authorityVersion: before.authorityVersion,
      moduleConfigurationVersion: before.moduleConfigurationVersion,
      cancelReturnsToOneLanguage: true,
    })
    expect(await everyRow(site.t)).toEqual(rows)
  })
})

describe("M05 A4 prepareLanguageChange (amendment 1)", () => {
  /** S3 with several languages: S2 plus the `multilingual` toggle on. */
  async function multiLanguageS3(): Promise<Site> {
    const site = await buildSite("S2", "absent")
    await toggleMultilingual(site, true)
    return site
  }

  const CASES: {
    name: string
    build: () => Promise<Site>
    locales: string[]
    steps: string[]
  }[] = [
    {
      name: "S0",
      build: () => onSite("S0"),
      locales: ["en"],
      steps: ["adopt"],
    },
    {
      name: "S1",
      build: () => onSite("S1"),
      locales: ["en"],
      steps: ["adopt"],
    },
    {
      name: "S2",
      build: () => onSite("S2"),
      locales: ["en", "fr"],
      steps: ["adopt"],
    },
    {
      name: "S3(x) with one language",
      build: () => commandSite("S3x"),
      locales: ["en"],
      steps: ["adopt"],
    },
    {
      name: "S3(x) with several languages",
      build: multiLanguageS3,
      locales: ["en", "fr"],
      steps: ["adopt"],
    },
    {
      name: "S3 returned and still enabled",
      build: () => commandSite("S3r"),
      locales: ["en"],
      steps: ["adopt"],
    },
  ]

  test.each(CASES)(
    "from $name with Multilingual on it adopts only, keeps $locales and writes one intent per step",
    async ({ build, locales, steps }) => {
      const site = await build()
      const tokens = await commandTokens(site)
      const result = { value: null as unknown }
      const intents = await newIntents(site.t, async () => {
        result.value = await prepareChange(site, tokens)
      })
      const after = await commandTokens(site)
      expect(result.value).toEqual({
        authorityVersion: after.authorityVersion,
        moduleConfigurationVersion: after.moduleConfigurationVersion,
        settingsUpdatedAt: after.settingsUpdatedAt,
        defaultLocale: "en",
        enabledLocales: locales,
      })
      expect(await lifecycleOf(site)).toBe("S4")
      expect(await moduleEnabledNow(site.t)).toBe(true)
      let config = tokens.moduleConfigurationVersion
      let version = tokens.authorityVersion ?? 0
      const expected = steps.map((step) => {
        if (step === "toggle") {
          config += 1
          return {
            operationId: `module_toggle:c${config}`,
            kind: "module_toggle",
          }
        }
        version += 1
        return { operationId: `adopt:v${version}`, kind: "adopt" }
      })
      expect(
        intents
          .map((intent) => ({
            operationId: intent.operationId,
            kind: intent.operationKind,
          }))
          .sort((a, b) => a.operationId.localeCompare(b.operationId))
      ).toEqual(
        expected.sort((a, b) => a.operationId.localeCompare(b.operationId))
      )
      expect(after.moduleConfigurationVersion).toBe(config)
      expect(after.authorityVersion).toBe(version)
    },
    60_000
  )

  test("S2 adoption publishes nothing and keeps the public surface", async () => {
    const site = await onSite("S2")
    const surface = await publicSurface(site.t)
    await prepareChange(site, await commandTokens(site))
    const withoutSettings = (value: unknown) => {
      const { settings, ...rest } = value as Record<string, unknown>
      void settings
      return rest
    }
    expect(withoutSettings(await publicSurface(site.t))).toEqual(
      withoutSettings(surface)
    )
  })

  test("an adopted and enabled site is a no-write success with unchanged tokens", async () => {
    const site = await commandSite("S4one")
    const before = await commandTokens(site)
    const rows = await everyRow(site.t)
    expect(await prepareChange(site, before)).toEqual({
      authorityVersion: before.authorityVersion,
      moduleConfigurationVersion: before.moduleConfigurationVersion,
      settingsUpdatedAt: before.settingsUpdatedAt,
      defaultLocale: "en",
      enabledLocales: ["en"],
    })
    expect(await everyRow(site.t)).toEqual(rows)
    expect(await commandTokens(site)).toEqual(before)
  })

  test("invalid language state refuses SITE_LANGUAGE_AUTHORITY_INVALID with no write", async () => {
    const site = await inventorySite("INV")
    await enableMultilingualModule(site.t)
    const tokens = await commandTokens(site)
    expect(
      await refusalWritesNothing(site.t, () => prepareChange(site, tokens))
    ).toEqual(refused("SITE_LANGUAGE_AUTHORITY_INVALID"))
  })

  test("a stale token refuses with zero committed writes, even where its step is skipped", async () => {
    const wrong = [
      "expectedSettingsUpdatedAt",
      "expectedAuthorityVersion",
      "expectedModuleConfigurationVersion",
    ] as const
    const sites: Array<[string, () => Promise<Site>]> = [
      ["S0", () => onSite("S0")],
      ["S1", () => onSite("S1")],
      ["S2", () => onSite("S2")],
      ["S3x", () => commandSite("S3x")],
      ["S3multi", multiLanguageS3],
      ["S3r", () => commandSite("S3r")],
      ["S4one", () => commandSite("S4one")],
    ]
    for (const [state, build] of sites) {
      const site = await build()
      const tokens = await commandTokens(site)
      const moduleOff = !(await moduleEnabledNow(site.t))
      for (const field of wrong) {
        const args = entryArgs(tokens)
        const code =
          field === "expectedModuleConfigurationVersion" && moduleOff
            ? "CMS_MODULE_CONFIGURATION_STALE"
            : "LANGUAGE_OPERATION_STALE"
        expect({
          state,
          field,
          result: await refusalWritesNothing(site.t, () =>
            site.owner.mutation(api.cms.multilingual.prepareLanguageChange, {
              ...args,
              [field]: (args[field] ?? 0) + 1,
            })
          ),
        }).toEqual({ state, field, result: refused(code) })
      }
    }
  }, 120_000)

  test("after it, a multi-language S2 or S3 site removes its last extra language", async () => {
    for (const build of [() => onSite("S2"), multiLanguageS3]) {
      const site = await build()
      // Before: removal cannot start on an unadopted site.
      expect(await outcome(() => startPreview(site, "remove", "fr"))).toEqual(
        refused("MULTILINGUAL_NOT_ADOPTED")
      )
      await prepareChange(site, await commandTokens(site))
      const previewId = await reviewedRemoval(site, "fr")
      const result = await site.owner.mutation(
        api.cms.multilingual.removeLastExtraLanguage,
        await previewClaim(site.t, previewId)
      )
      expect(result).toMatchObject({ locale: "en", removedLocale: "fr" })
      // Back to one language; the module stays on (owner 2026-11-05).
      expect(await lifecycleOf(site)).toBe("S3(S1)")
      expect(await moduleEnabledNow(site.t)).toBe(true)
    }
  }, 120_000)

  test("after it, removeLanguage and the default-migration start run without MULTILINGUAL_NOT_ADOPTED", async () => {
    const removal = await onSite("S2")
    await prepareChange(removal, await commandTokens(removal))
    const previewId = await reviewedRemoval(removal, "fr")
    await expect(
      removeLanguage(removal.owner, await previewClaim(removal.t, previewId))
    ).resolves.toMatchObject({ locale: "fr", enabledLocales: ["en"] })
    expect(await lifecycleOf(removal)).toBe("S4")

    const migration = await multiLanguageS3()
    expect(await outcome(() => startMigration(migration, "fr"))).toEqual(
      refused("MULTILINGUAL_NOT_ADOPTED")
    )
    await prepareChange(migration, await commandTokens(migration))
    const migrationId = await startMigration(migration, "fr")
    expect((await migrationRow(migration.t, migrationId)).phase).toBe(
      "enumerating"
    )
  }, 120_000)
})

describe("M05 A4 off-module continuity pointer", () => {
  test("a one-language S1 that keeps a continuity pointer answers the prefix probe for a re-added language", async () => {
    // The way an owner gets there: two languages (en default), make fr the
    // default, remove en, return and disable.
    const { site, migrationId } = await readyMigration()
    const { t, owner } = site
    await activateMigration(owner, await activationArgs(t, migrationId))
    await removeLocale(site, "en")
    const tokens = await commandTokens(site)
    await applyModulesDisable(site, tokens)

    expect(await lifecycleOf(site)).toBe("S1")
    expect(await moduleEnabledNow(t)).toBe(false)
    const authority = await authorityRow(t)
    expect(authority.continuityPointer).toEqual({
      migrationId,
      generation: 1,
    })
    const state = await owner.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    expect(state.enabledLocales).toEqual(["fr"])

    // The advisory is optional work: enable it before probing retained state.
    await toggleMultilingual(site, true)
    // The pointer branch runs and finds no route under `/en` (the pointed
    // rows are the old `/fr` prefix), so the only reason is the reveal of
    // the pages removal kept for en; the add needs a reviewed preview.
    expect(
      await owner.query(api.cms.multilingual.needsReviewToAddLanguage, {
        locale: "en",
      })
    ).toEqual({
      needsReview: false,
      reasons: [],
      conflicts: [],
      moreConflicts: false,
    })
    // The reveal alone no longer needs a preview: the add commits once the
    // owner has switched Multilingual back on in Modules.
    await toggleMultilingual(site, true)
    expect(await addSite(site, "en", await commandTokens(site))).toMatchObject({
      ok: true,
      operationKind: "reveal",
    })

    // A route row under the pointer at `/nl/...` is what the branch looks
    // for: seeded with the existing pointed-generation helper on a fresh
    // S1 pointer site, the query and the add both see it.
    const pointed = await readyMigration()
    await activateMigration(
      pointed.site.owner,
      await activationArgs(pointed.site.t, pointed.migrationId)
    )
    await removeLocale(pointed.site, "en")
    await applyModulesDisable(pointed.site, await commandTokens(pointed.site))
    await toggleMultilingual(pointed.site, true)
    await pointed.site.t.run(async (ctx) => {
      const row = (await ctx.db
        .query("siteDefaultLanguageRoutes")
        .withIndex("by_migrationId_and_generation_and_fromPath", (q) =>
          q.eq("migrationId", pointed.migrationId).eq("generation", 1)
        )
        .first())!
      const { _id, _creationTime, fromPath, ...rest } = row
      void _id
      void _creationTime
      void fromPath
      await ctx.db.insert("siteDefaultLanguageRoutes", {
        ...rest,
        fromPath: "/nl/zz",
      })
    })
    expect(
      await pointed.site.owner.query(
        api.cms.multilingual.needsReviewToAddLanguage,
        { locale: "nl" }
      )
    ).toMatchObject({
      needsReview: false,
      conflicts: [{ kind: "former_address", publicPath: "/nl/zz" }],
    })
    expect(
      await refusalWritesNothing(pointed.site.t, async () =>
        addSite(pointed.site, "nl", await commandTokens(pointed.site))
      )
    ).toMatchObject({
      ok: { ok: false, code: "LANGUAGE_ADDRESS_CONFLICT" },
    })
  }, 180_000)
})

describe("M05 A4 removeLastExtraLanguage", () => {
  test("two languages and a reviewed preview end in one language with the module still on", async () => {
    const site = await previewSite()
    const previewId = await reviewedRemoval(site, "fr")
    const before = await commandTokens(site)
    const claim = await previewClaim(site.t, previewId)
    const result = { value: null as unknown }
    const intents = await newIntents(site.t, async () => {
      result.value = await site.owner.mutation(
        api.cms.multilingual.removeLastExtraLanguage,
        claim
      )
    })
    expect(result.value).toEqual({
      authorityVersion: before.authorityVersion! + 2,
      moduleConfigurationVersion: before.moduleConfigurationVersion,
      locale: "en",
      removedLocale: "fr",
    })
    expect(await lifecycleOf(site)).toBe("S3(S1)")
    expect(await moduleEnabledNow(site.t)).toBe(true)
    expect((await commandTokens(site)).moduleConfigurationVersion).toBe(
      before.moduleConfigurationVersion
    )
    expect((await previewRow(site.t, previewId)).phase).toBe("consumed")
    expect(
      intents
        .map((intent) => ({
          id: intent.operationId,
          kind: intent.operationKind,
          captured: intent.capturedAuthorityVersion,
        }))
        .sort((a, b) => a.id.localeCompare(b.id))
    ).toEqual(
      [
        {
          id: `remove:v${before.authorityVersion! + 1}`,
          kind: "remove",
          captured: before.authorityVersion! + 1,
        },
        {
          id: `return_to_single:v${before.authorityVersion! + 2}`,
          kind: "return_to_single",
          captured: before.authorityVersion! + 2,
        },
      ].sort((a, b) => a.id.localeCompare(b.id))
    )
  }, 120_000)

  test("three languages refuse LANGUAGE_NOT_LAST_EXTRA", async () => {
    const site = await previewSite()
    await addLanguage(site, "nl")
    const previewId = await reviewedRemoval(site, "fr")
    const claim = await previewClaim(site.t, previewId)
    expect(
      await refusalWritesNothing(site.t, () =>
        site.owner.mutation(api.cms.multilingual.removeLastExtraLanguage, claim)
      )
    ).toEqual(refused("LANGUAGE_NOT_LAST_EXTRA"))
  }, 120_000)

  test("a preview whose tokens moved refuses stale and consumes nothing", async () => {
    const site = await previewSite()
    const previewId = await reviewedRemoval(site, "fr")
    const claim = await previewClaim(site.t, previewId)
    // Another change bumps the module configuration version after review.
    await site.t.run(async (ctx) => {
      const row = (await ctx.db.query("cmsModuleState").first())!
      await ctx.db.patch(row._id, {
        configurationVersion: row.configurationVersion + 1,
      })
    })
    expect(
      await refusalWritesNothing(site.t, () =>
        site.owner.mutation(api.cms.multilingual.removeLastExtraLanguage, claim)
      )
    ).toEqual(refused("LANGUAGE_OPERATION_STALE"))
    expect((await previewRow(site.t, previewId)).phase).toBe("complete")
  }, 120_000)

  test("an unreviewed preview refuses and consumes nothing", async () => {
    const site = await previewSite()
    const previewId = await startPreview(site, "remove", "fr")
    expect((await runPreview(site.t, previewId)).preview.phase).toBe("complete")
    const claim = await previewClaim(site.t, previewId)
    expect(
      await refusalWritesNothing(site.t, () =>
        site.owner.mutation(api.cms.multilingual.removeLastExtraLanguage, claim)
      )
    ).toEqual(refused("LANGUAGE_PREVIEW_REVIEW_INCOMPLETE"))
  }, 120_000)

  test("it never changes the module: a configuration version at its limit does not matter", async () => {
    const site = await previewSite()
    await site.t.run(async (ctx) => {
      const row = (await ctx.db.query("cmsModuleState").first())!
      await ctx.db.patch(row._id, {
        configurationVersion: Number.MAX_SAFE_INTEGER,
      })
    })
    const previewId = await reviewedRemoval(site, "fr")
    const claim = await previewClaim(site.t, previewId)
    expect(
      await site.owner.mutation(
        api.cms.multilingual.removeLastExtraLanguage,
        claim
      )
    ).toMatchObject({
      moduleConfigurationVersion: Number.MAX_SAFE_INTEGER,
      removedLocale: "fr",
    })
    expect(await moduleEnabledNow(site.t)).toBe(true)
  }, 120_000)
})

describe("Modules Apply return and disable", () => {
  test("adopted with one language returns and disables", async () => {
    const site = await commandSite("S4one")
    const before = await commandTokens(site)
    const result = { value: null as unknown }
    const intents = await newIntents(site.t, async () => {
      result.value = await applyModulesDisable(site, before)
    })
    expect(result.value).toEqual({
      authorityVersion: before.authorityVersion! + 1,
      moduleConfigurationVersion: before.moduleConfigurationVersion + 1,
      locale: "en",
    })
    expect(intents.map((intent) => intent.operationId).sort()).toEqual(
      [
        `return_to_single:v${before.authorityVersion! + 1}`,
        `module_toggle:c${before.moduleConfigurationVersion + 1}`,
      ].sort()
    )
    expect(await lifecycleOf(site)).toBe("S1")
  })

  test("returned but still enabled, or enabled and never adopted, only disables", async () => {
    for (const state of ["S3r", "S3x"] as const) {
      const site = await commandSite(state)
      const before = await commandTokens(site)
      const intents = await newIntents(site.t, () =>
        applyModulesDisable(site, before)
      )
      expect(intents.map((intent) => intent.operationKind)).toEqual([
        "module_toggle",
      ])
      expect(await moduleEnabledNow(site.t)).toBe(false)
      expect((await commandTokens(site)).authorityVersion).toBe(
        before.authorityVersion
      )
    }
  })

  test("already off is a no-op success; S0 gets no authority row here", async () => {
    for (const state of ["S0", "S1", "S2"] as const) {
      const site = await commandSite(state)
      const before = await commandTokens(site)
      const rows = await everyRow(site.t)
      expect(await applyModulesDisable(site, before)).toEqual({
        authorityVersion: before.authorityVersion,
        moduleConfigurationVersion: before.moduleConfigurationVersion,
        locale: "en",
      })
      expect(await everyRow(site.t)).toEqual(rows)
    }
  })

  test("a stale token refuses with no write, even when every step is skipped", async () => {
    for (const state of ["S3x", "S3r", "S4one"] as const) {
      const site = await commandSite(state)
      const before = await commandTokens(site)
      const moduleOn = await moduleEnabledNow(site.t)
      expect({
        state,
        authority: await refusalWritesNothing(site.t, () =>
          applyModulesDisable(site, {
            ...before,
            authorityVersion: (before.authorityVersion ?? 0) + 1,
          })
        ),
        module: await refusalWritesNothing(site.t, () =>
          applyModulesDisable(site, {
            ...before,
            moduleConfigurationVersion: before.moduleConfigurationVersion + 1,
          })
        ),
      }).toEqual({
        state,
        authority: refused("LANGUAGE_OPERATION_STALE"),
        module: refused(
          moduleOn
            ? "CMS_MODULE_CONFIGURATION_STALE"
            : "LANGUAGE_OPERATION_STALE"
        ),
      })
    }
  }, 120_000)

  test("two languages refuse and keep everything", async () => {
    const site = await previewSite()
    const tokens = await commandTokens(site)
    expect(
      await refusalWritesNothing(site.t, () =>
        applyModulesDisable(site, tokens)
      )
    ).toEqual(refused("CMS_MODULE_TRANSITION_BLOCKED"))
  }, 120_000)
})

describe("Multilingual is switched only in Modules (owner 2026-11-05)", () => {
  test("readiness: Multilingual reports ready and not required in every state (display only)", async () => {
    const sites = [
      ...(await Promise.all(
        (["S0", "S1", "S2"] as const).map((state) => commandSite(state))
      )),
      await onSite("S0"),
      await previewSite(),
    ]
    for (const site of sites) {
      expect(await resolveMultilingualModuleReadiness()).toEqual({
        readiness: "ready",
        setup: "not_required",
      })
      const preview = await site.owner.query(api.cms.modules.preview, {
        changes: [],
      })
      expect(
        preview.readiness.find((entry) => entry.moduleId === "multilingual")
      ).toMatchObject({ readiness: "ready", setup: "not_required" })
    }
  }, 120_000)

  test("S1: add, prepare-review and prepare-change refuse with the module off and write nothing", async () => {
    for (const state of ["S0", "S1", "S2"] as const) {
      const site = await commandSite(state)
      expect(await moduleEnabledNow(site.t)).toBe(false)
      const tokens = await commandTokens(site)
      for (const [name, run] of [
        ["addSiteLanguage", () => addSite(site, "nl", tokens)],
        ["prepareLanguageReview", () => prepareReview(site, "nl", tokens)],
        ["prepareLanguageChange", () => prepareChange(site, tokens)],
      ] as const) {
        expect({
          state,
          name,
          result: await refusalWritesNothing(site.t, run),
        }).toEqual({
          state,
          name,
          result: refused("CMS_MODULE_DISABLED"),
        })
      }
      expect(await moduleEnabledNow(site.t)).toBe(false)
    }
  }, 120_000)

  test("S2: add with the module on but not adopted adopts only and leaves the module as it was", async () => {
    const adoptedAlready = await previewSite()
    const adoptedBefore = await commandTokens(adoptedAlready)
    const addOnlyIntents = await newIntents(adoptedAlready.t, async () => {
      await addSite(adoptedAlready, "nl", adoptedBefore)
    })
    expect(addOnlyIntents.map((i) => i.operationKind).sort()).toEqual(["add"])
    expect(await moduleEnabledNow(adoptedAlready.t)).toBe(true)
    expect(
      (await commandTokens(adoptedAlready)).moduleConfigurationVersion
    ).toBe(adoptedBefore.moduleConfigurationVersion)
    const unadopted = await onSite("S0")
    const tokens = await commandTokens(unadopted)
    const adoptedIntents = await newIntents(unadopted.t, async () => {
      await addSite(unadopted, "nl", tokens)
    })
    expect(adoptedIntents.map((i) => i.operationKind).sort()).toEqual([
      "add",
      "adopt",
    ])
    expect((await commandTokens(unadopted)).moduleConfigurationVersion).toBe(
      tokens.moduleConfigurationVersion
    )
  }, 120_000)

  test("S3: removing the last extra language keeps the module on", async () => {
    const site = await previewSite()
    const before = await commandTokens(site)
    const previewId = await reviewedRemoval(site, "fr")
    await site.owner.mutation(
      api.cms.multilingual.removeLastExtraLanguage,
      await previewClaim(site.t, previewId)
    )
    expect(await moduleEnabledNow(site.t)).toBe(true)
    expect((await commandTokens(site)).moduleConfigurationVersion).toBe(
      before.moduleConfigurationVersion
    )
    expect(
      (await site.owner.query(api.cms.multilingual.getMultilingualState, {}))
        .enabledLocales
    ).toEqual(["en"])
  }, 120_000)

  test("S4: Modules switches Multilingual off with one language that is not adopted", async () => {
    for (const state of ["S3x", "S3r"] as const) {
      const site = await commandSite(state)
      expect(await moduleEnabledNow(site.t)).toBe(true)
      await toggleMultilingual(site, false)
      expect({ state, on: await moduleEnabledNow(site.t) }).toEqual({
        state,
        on: false,
      })
    }
  }, 120_000)

  test("S5: Modules refuses to switch Multilingual off while two or more languages are adopted", async () => {
    const site = await previewSite()
    expect(
      await refusalWritesNothing(site.t, () => toggleMultilingual(site, false))
    ).toEqual(refused("CMS_MODULE_TRANSITION_BLOCKED"))
    expect(
      await site.owner.query(api.cms.modules.preview, {
        changes: [{ moduleId: "multilingual", enabled: false }],
      })
    ).toMatchObject({
      blockers: [
        {
          code: "MULTILINGUAL_AUTHORITY_ACTIVE",
          moduleId: "multilingual",
          locales: ["en", "fr"],
        },
      ],
    })
    expect(await moduleEnabledNow(site.t)).toBe(true)
  }, 120_000)

  test("S5b: adopted with one language, Modules turns Multilingual off through return-and-disable and keeps the language", async () => {
    const site = await commandSite("S4one")
    expect(await lifecycleOf(site)).toBe("S4")
    expect(await moduleEnabledNow(site.t)).toBe(true)
    const preview = await site.owner.query(api.cms.modules.preview, {
      changes: [{ moduleId: "multilingual", enabled: false }],
    })
    expect(preview.blockers).toEqual([])
    expect(preview.multilingualCommandTokens?.authorityVersion).toBe(2)
    await applyModulesDisable(site, await commandTokens(site))
    expect(await moduleEnabledNow(site.t)).toBe(false)
    expect(await lifecycleOf(site)).toBe("S1")
    expect(
      (await site.owner.query(api.cms.multilingual.getMultilingualState, {}))
        .enabledLocales
    ).toEqual(["en"])
  }, 120_000)

  test("S6: Modules switches Multilingual on without adopting or changing a language", async () => {
    const site = await commandSite("S1")
    const before = await commandTokens(site)
    const intents = await newIntents(site.t, async () => {
      await toggleMultilingual(site, true)
    })
    expect(intents.map((i) => i.operationKind)).toEqual(["module_toggle"])
    expect(await moduleEnabledNow(site.t)).toBe(true)
    expect((await commandTokens(site)).authorityVersion).toBe(
      before.authorityVersion
    )
    expect(
      (await site.owner.query(api.cms.multilingual.getMultilingualState, {}))
        .enabledLocales
    ).toEqual(["en"])
  }, 120_000)

  test("guard: no Languages-page mutation changes the module's enabled state", async () => {
    const site = await previewSite()
    const enabled = () => moduleEnabledNow(site.t)
    expect(await enabled()).toBe(true)
    // Add (three languages), Set default (accepted or refused, never a
    // module change), Remove, then Remove the last extra.
    await addSite(site, "nl", await commandTokens(site))
    expect(await enabled()).toBe(true)
    const tokens = await commandTokens(site)
    await outcome(() =>
      site.owner.mutation(api.cms.multilingual.setDefaultLanguage, {
        toLocale: "nl",
        expectedAuthorityVersion: tokens.authorityVersion!,
        expectedModuleConfigurationVersion: tokens.moduleConfigurationVersion,
      })
    )
    expect(await enabled()).toBe(true)
    const { defaultLocale } = await site.owner.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    const nonDefault = ["en", "fr", "nl"].filter(
      (code) => code !== defaultLocale
    )
    await removeLocale(site, nonDefault[0]!)
    expect(await enabled()).toBe(true)
    const previewId = await reviewedRemoval(site, nonDefault[1]!)
    await site.owner.mutation(
      api.cms.multilingual.removeLastExtraLanguage,
      await previewClaim(site.t, previewId)
    )
    expect(await enabled()).toBe(true)
    // Once the module is off, every Languages-page command refuses and the
    // module stays off.
    await toggleMultilingual(site, false)
    const off = await commandTokens(site)
    for (const run of [
      () => addSite(site, "nl", off),
      () => prepareChange(site, off),
    ]) {
      expect(await refusalWritesNothing(site.t, run)).toEqual(
        refused("CMS_MODULE_DISABLED")
      )
    }
    expect(await enabled()).toBe(false)
  }, 180_000)
})

describe("M05 A4 owner-only (P2a)", () => {
  test("unauthenticated, unrelated and replaced-owner callers are denied with no write", async () => {
    const site = await buildSite("S1", "absent")
    const tokens = await commandTokens(site)
    const claim = {
      previewId: "99999siteLanguageImpactPreviews" as PreviewId,
      expectedDigest: "0".repeat(64),
      expectedCount: { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
    }
    const CURRENT = {
      subject: "a4-current",
      tokenIdentifier: "https://convex.test|a4-current",
    }
    await site.t.run(async (ctx) => {
      const owner = (await ctx.db.query("cmsOwner").unique())!
      await ctx.db.patch(owner._id, {
        authId: CURRENT.subject,
        tokenIdentifier: CURRENT.tokenIdentifier,
      })
    })
    const calls = (caller: Pick<Caller, "query" | "mutation">) => ({
      needsReviewToAddLanguage: () =>
        caller.query(api.cms.multilingual.needsReviewToAddLanguage, {
          locale: "nl",
        }),
      addSiteLanguage: () =>
        caller.mutation(api.cms.multilingual.addSiteLanguage, {
          locale: "nl",
          ...entryArgs(tokens),
        }),
      prepareLanguageReview: () =>
        caller.mutation(api.cms.multilingual.prepareLanguageReview, {
          locale: "nl",
          ...entryArgs(tokens),
        }),
      prepareLanguageChange: () =>
        caller.mutation(
          api.cms.multilingual.prepareLanguageChange,
          entryArgs(tokens)
        ),
      removeLastExtraLanguage: () =>
        caller.mutation(api.cms.multilingual.removeLastExtraLanguage, claim),
      modulesCommit: () =>
        caller.mutation(api.cms.modules.commit, {
          expectedConfigurationVersion: tokens.moduleConfigurationVersion,
          changes: [{ moduleId: "multilingual", enabled: false }],
          multilingualCommandTokens: tokens,
        }),
    })
    const denied = [
      site.t,
      site.t.withIdentity({
        subject: "a4-stranger",
        tokenIdentifier: "https://convex.test|a4-stranger",
      }),
      site.t.withIdentity(OWNER),
    ]
    for (const caller of denied) {
      for (const [name, call] of Object.entries(calls(caller))) {
        const before = await everyRow(site.t)
        const result = await outcome(call)
        expect({ name, denied: "error" in result }).toEqual({
          name,
          denied: true,
        })
        expect(await everyRow(site.t)).toEqual(before)
      }
    }
    expect(
      await site.t
        .withIdentity(CURRENT)
        .query(api.cms.multilingual.getMultilingualState, {})
    ).toMatchObject({ moduleEnabled: false, enabledLocales: ["en"] })
  })
})

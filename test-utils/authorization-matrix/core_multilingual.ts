import { expect } from "vitest"
import { api, internal } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import {
  defineRow, MATRIX_STATES, OWNER, setupModuleLanguageState,
  setupSnapshotActiveS4, stateLabel,
  type AuthorizationRow, type CallTarget, type FunctionKind, type MatrixState,
  type Outcome, type Site,
} from "./harness"

type Fixture = {
  previewId: Id<"siteLanguageImpactPreviews">
  migrationId: Id<"siteDefaultLanguageMigrations">
  previewDigest?: string
  previewCount?: { publicPages: number; routes: number; manualRules: number; menus: number }
  reviewDigest?: string
  generation?: number
  readinessVersion?: number
}

const denials = {
  signedOut: { error: "UNAUTHENTICATED" },
  unrelated: { error: "CMS_OWNER_REQUIRED" },
  former: { error: "CMS_OWNER_REQUIRED" },
} as const

/** Well-formed absent IDs permit a legacy authority check without fake open journeys. */
async function setupLegacy(t: Site, state: MatrixState): Promise<Fixture> {
  await setupModuleLanguageState(t, state)
  return t.run(async (ctx) => {
    const owner = await ctx.db.query("cmsOwner").unique()
    if (!owner) throw new Error("owner fixture missing")
    const pair = { routeClaimVersion: 0, publicationSetVersion: 0 }
    const attribution = {
      kind: "owner" as const, ownerId: owner._id,
      authId: owner.authId, tokenIdentifier: owner.tokenIdentifier,
    }
    const previewId = await ctx.db.insert("siteLanguageImpactPreviews", {
      kind: "remove", locale: "fr",
      owner: { ownerId: owner._id, tokenIdentifier: owner.tokenIdentifier },
      captured: { authorityVersion: 1, moduleConfigurationVersion: 1,
        site: pair, locale: pair },
      phase: "expired", cursorPhase: "selections",
      count: { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
      digest: "absent", pageCount: 0, reviewedThroughOrdinal: -1,
      generation: 1, createdAt: 1, updatedAt: 1,
    })
    const migrationId = await ctx.db.insert("siteDefaultLanguageMigrations", {
      fromLocale: "en", toLocale: "fr", phase: "cancelled", generation: 1,
      captured: { authorityVersion: 1, moduleConfigurationVersion: 1,
        site: pair, from: pair, to: pair },
      counts: { rows: 0, shadowedByCurrent: 0, shadowedByHistorical: 0,
        manualRulesShadowed: 0, manualRulesShifted: 0,
        manualRulesUnprefixed: 0, carriedShadowedSkipped: 0, blockers: 0 },
      disclosurePageCount: 0, reviewedThroughOrdinal: -1,
      attribution, createdAt: 1, updatedAt: 1,
    })
    await ctx.db.delete(previewId)
    await ctx.db.delete(migrationId)
    return { previewId, migrationId }
  })
}

async function setupS4(t: Site, redirects: "off" | "on"): Promise<Fixture> {
  await setupSnapshotActiveS4(t, redirects)
  const owner = t.withIdentity(OWNER)
  const homeId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page", status: "draft", slug: "home",
    title: "Matrix home", content: {
      en: { title: "Matrix home", slices: [] },
      fr: { title: "Accueil matrice", slices: [] },
    },
  })
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("siteSettings").unique()
    await ctx.db.patch(settings!._id, { homePageId: homeId })
  })
  for (const locale of ["en", "fr"] as const) {
    await owner.mutation(api.cms.publication.publishLocale, {
      pageId: homeId, locale, expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1, expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1, expectedReleaseGeneration: 0,
    })
  }
  const previewId = (await owner.mutation(api.cms.multilingual.startLanguageImpactPreview, {
    kind: "remove", locale: "fr",
  })).previewId
  const migrationId = await t.run(async (ctx) => {
    const ownerRow = await ctx.db.query("cmsOwner").unique()
    if (!ownerRow) throw new Error("owner fixture missing")
    const pair = { routeClaimVersion: 0, publicationSetVersion: 0 }
    const id = await ctx.db.insert("siteDefaultLanguageMigrations", {
      fromLocale: "en", toLocale: "fr", phase: "cancelled", generation: 1,
      captured: { authorityVersion: 1, moduleConfigurationVersion: 1,
        site: pair, from: pair, to: pair },
      counts: { rows: 0, shadowedByCurrent: 0, shadowedByHistorical: 0,
        manualRulesShadowed: 0, manualRulesShifted: 0,
        manualRulesUnprefixed: 0, carriedShadowedSkipped: 0, blockers: 0 },
      disclosurePageCount: 0, reviewedThroughOrdinal: -1,
      attribution: { kind: "owner", ownerId: ownerRow._id,
        authId: ownerRow.authId, tokenIdentifier: ownerRow.tokenIdentifier },
      createdAt: 1, updatedAt: 1,
    })
    await ctx.db.delete(id)
    return id
  })
  return { previewId, migrationId }
}

async function completePreview(t: Site, fixture: Fixture): Promise<Fixture> {
  for (let attempt = 0; attempt < 32; attempt += 1) {
    const row = await t.run((ctx) => ctx.db.get(fixture.previewId))
    if (row?.phase === "complete") {
      return { ...fixture, previewDigest: row.digest, previewCount: row.count }
    }
    if (row?.phase !== "scanning") throw new Error(`preview phase ${row?.phase}`)
    await t.mutation(internal.cms.multilingual.stepLanguageImpactPreview, {
      previewId: fixture.previewId, generation: 1,
    })
  }
  throw new Error("preview did not complete")
}

async function setupCompletePreview(t: Site, redirects: "off" | "on") {
  return completePreview(t, await setupS4(t, redirects))
}

async function setupReviewablePreview(t: Site, redirects: "off" | "on") {
  const fixture = await setupCompletePreview(t, redirects)
  const first = await t.withIdentity(OWNER).query(api.cms.multilingual.listLanguageImpact, {
    previewId: fixture.previewId, ordinal: 0,
  })
  if (first.stale) throw new Error("preview has no reviewable page")
  return { ...fixture, reviewDigest: first.digest }
}

async function setupReviewedPreview(t: Site, redirects: "off" | "on") {
  const fixture = await setupCompletePreview(t, redirects)
  const owner = t.withIdentity(OWNER)
  const row = await t.run((ctx) => ctx.db.get(fixture.previewId))
  if (!row) throw new Error("preview missing")
  for (let ordinal = 0; ordinal < row.pageCount; ordinal += 1) {
    const page = await owner.query(api.cms.multilingual.listLanguageImpact, {
      previewId: fixture.previewId, ordinal,
    })
    if (page.stale) throw new Error("preview disclosure stale")
    await owner.mutation(api.cms.multilingual.recordLanguageImpactReview, {
      previewId: fixture.previewId, ordinal, pageDigest: page.digest,
    })
  }
  return fixture
}

async function setupMigration(t: Site, redirects: "off" | "on") {
  const fixture = await setupS4(t, redirects)
  const migrationId = (await t.withIdentity(OWNER).mutation(
    api.cms.multilingual.startDefaultLanguageMigration,
    { toLocale: "fr", expectedAuthorityVersion: 1,
      expectedModuleConfigurationVersion: 1 },
  )).migrationId
  return { ...fixture, migrationId }
}

async function setupReadyMigration(t: Site, redirects: "off" | "on") {
  const fixture = await setupMigration(t, redirects)
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const row = await t.run((ctx) => ctx.db.get(fixture.migrationId))
    if (row?.phase === "ready") {
      return { ...fixture, generation: row.generation,
        readinessVersion: row.manifest?.readinessVersion }
    }
    if (!row || (row.phase !== "enumerating" && row.phase !== "validating")) {
      throw new Error(`migration phase ${row?.phase}`)
    }
    await t.withIdentity(OWNER).mutation(api.cms.multilingual.continueDefaultLanguageMigration, {
      migrationId: fixture.migrationId, expectedGeneration: row.generation,
    })
  }
  throw new Error("migration did not become ready")
}

async function setupReviewableMigration(t: Site, redirects: "off" | "on") {
  const fixture = await setupReadyMigration(t, redirects)
  const first = await t.withIdentity(OWNER).query(api.cms.multilingual.listDefaultMigrationDisclosure, {
    migrationId: fixture.migrationId, generation: fixture.generation!, ordinal: 0,
  })
  if (first.stale) throw new Error("migration has no reviewable page")
  return { ...fixture, reviewDigest: first.digest }
}

async function setupReviewedMigration(t: Site, redirects: "off" | "on") {
  const fixture = await setupReadyMigration(t, redirects)
  const row = await t.run((ctx) => ctx.db.get(fixture.migrationId))
  if (!row) throw new Error("migration missing")
  const owner = t.withIdentity(OWNER)
  for (let ordinal = 0; ordinal < row.disclosurePageCount; ordinal += 1) {
    const page = await owner.query(api.cms.multilingual.listDefaultMigrationDisclosure, {
      migrationId: fixture.migrationId, generation: row.generation, ordinal,
    })
    if (page.stale) throw new Error("migration disclosure stale")
    await owner.mutation(api.cms.multilingual.recordDefaultMigrationReview, {
      migrationId: fixture.migrationId, expectedGeneration: row.generation,
      ordinal, pageDigest: page.digest,
    })
  }
  return fixture
}

const row = (
  name: string, kind: FunctionKind,
  call: (actor: CallTarget, fixture: Fixture) => Promise<unknown>,
  legacyOwner: Outcome, snapshotOwner: Outcome,
  snapshotSetup: (t: Site, redirects: "off" | "on") => Promise<Fixture> = setupS4,
): AuthorizationRow => defineRow({
  name, kind,
  requiredScenarioLabels: ["snapshot-S4/redirects-off", "snapshot-S4/redirects-on"],
  scenarios: [
    ...MATRIX_STATES.map((state) => ({
      label: stateLabel(state), setup: (t: Site) => setupLegacy(t, state), call,
      outcomes: { ...denials, owner: state.language === "F09" ? { error: "CMS_MODULE_DISABLED" } : legacyOwner }, readOnly: kind === "query",
    })),
    ...(["off", "on"] as const).map((redirects) => ({
      label: `snapshot-S4/redirects-${redirects}`,
      setup: (t: Site) => snapshotSetup(t, redirects), call,
      outcomes: { ...denials, owner: snapshotOwner }, readOnly: kind === "query",
    })),
  ],
})

export const coreMultilingualRows: AuthorizationRow[] = [
  row("cms/multilingual:startDefaultLanguageMigration", "mutation",
    (actor) => actor.mutation(api.cms.multilingual.startDefaultLanguageMigration, {
      toLocale: "fr", expectedAuthorityVersion: 1,
      expectedModuleConfigurationVersion: 1,
    }),
    { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" },
    { check: (value) => expect(value).toMatchObject({ migrationId: expect.any(String) }) }),
  // Routing U2: owner-only silent default change; the S4 fixture publishes the
  // home in English and French, so the owner's change succeeds.
  row("cms/multilingual:setDefaultLanguage", "mutation",
    (actor) => actor.mutation(api.cms.multilingual.setDefaultLanguage, {
      toLocale: "fr", expectedAuthorityVersion: 1,
      expectedModuleConfigurationVersion: 1,
    }),
    { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" },
    { check: (value) => expect(value).toEqual({ ok: true, authorityVersion: 2 }) }),
  row("cms/multilingual:continueDefaultLanguageMigration", "mutation",
    (actor, fixture) => actor.mutation(api.cms.multilingual.continueDefaultLanguageMigration, {
      migrationId: fixture.migrationId, expectedGeneration: 1,
    }),
    { value: { kind: "noop" } },
    { value: { kind: "continue", generation: 1 } },
    setupMigration),
  row("cms/multilingual:listDefaultLanguageRoutes", "query",
    (actor, fixture) => actor.query(api.cms.multilingual.listDefaultLanguageRoutes, {
      migrationId: fixture.migrationId, generation: 1,
      paginationOpts: { numItems: 10, cursor: null }, filter: "all",
    }),
    { error: "LANGUAGE_PREVIEW_MISMATCH" },
    { check: (value) => expect(value).toMatchObject({ page: expect.arrayContaining([expect.objectContaining({ fromPath: "/" })]) }) },
    setupReadyMigration),
  row("cms/multilingual:listDefaultMigrationDisclosure", "query",
    (actor, fixture) => actor.query(api.cms.multilingual.listDefaultMigrationDisclosure, {
      migrationId: fixture.migrationId, generation: fixture.generation ?? 1, ordinal: 0,
    }),
    { error: "LANGUAGE_PREVIEW_MISMATCH" },
    { check: (value) => expect(value).toMatchObject({ stale: false, ordinal: 0, digest: expect.any(String) }) },
    setupReviewableMigration),
  row("cms/multilingual:recordDefaultMigrationReview", "mutation",
    (actor, fixture) => actor.mutation(api.cms.multilingual.recordDefaultMigrationReview, {
      migrationId: fixture.migrationId, expectedGeneration: fixture.generation ?? 1,
      ordinal: 0, pageDigest: fixture.reviewDigest ?? "absent",
    }),
    { error: "LANGUAGE_PREVIEW_MISMATCH" },
    { check: (value) => expect(value).toMatchObject({ stale: false, reviewedThroughOrdinal: 0 }) },
    setupReviewableMigration),
  row("cms/multilingual:activateDefaultLanguageMigration", "mutation",
    (actor, fixture) => actor.mutation(api.cms.multilingual.activateDefaultLanguageMigration, {
      migrationId: fixture.migrationId, expectedGeneration: fixture.generation ?? 1,
      expectedReadinessVersion: fixture.readinessVersion ?? 0,
      expectedAuthorityVersion: 1,
    }),
    { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" },
    { value: { version: 2, locale: "fr" } },
    setupReviewedMigration),
  row("cms/multilingual:cancelDefaultLanguageMigration", "mutation",
    (actor, fixture) => actor.mutation(api.cms.multilingual.cancelDefaultLanguageMigration, {
      migrationId: fixture.migrationId, expectedGeneration: 1,
    }),
    { error: "LANGUAGE_PREVIEW_MISMATCH" },
    { value: null }, setupMigration),
  row("cms/multilingual:listLanguageImpact", "query",
    (actor, fixture) => actor.query(api.cms.multilingual.listLanguageImpact, {
      previewId: fixture.previewId, ordinal: 0,
    }),
    { error: "LANGUAGE_PREVIEW_MISMATCH" },
    { check: (value) => expect(value).toMatchObject({ stale: false, ordinal: 0, digest: expect.any(String) }) },
    setupReviewablePreview),
  row("cms/multilingual:recordLanguageImpactReview", "mutation",
    (actor, fixture) => actor.mutation(api.cms.multilingual.recordLanguageImpactReview, {
      previewId: fixture.previewId, ordinal: 0,
      pageDigest: fixture.reviewDigest ?? "absent",
    }),
    { error: "LANGUAGE_PREVIEW_MISMATCH" },
    { check: (value) => expect(value).toMatchObject({ stale: false, reviewedThroughOrdinal: 0 }) },
    setupReviewablePreview),
  row("cms/multilingual:removeLanguage", "mutation",
    (actor, fixture) => actor.mutation(api.cms.multilingual.removeLanguage, {
      previewId: fixture.previewId,
      expectedDigest: fixture.previewDigest ?? "absent",
      expectedCount: fixture.previewCount ?? { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
    }),
    { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" },
    { value: { version: 2, enabledLocales: ["en"], locale: "fr" } },
    setupReviewedPreview),
  // A4 combined language commands: the same owner-only identity cases.
  row("cms/multilingual:needsReviewToAddLanguage", "query",
    (actor) => actor.query(api.cms.multilingual.needsReviewToAddLanguage, { locale: "nl" }),
    { value: { needsReview: false, reasons: [], conflicts: [], moreConflicts: false } },
    { value: { needsReview: false, reasons: [], conflicts: [], moreConflicts: false } }),
  row("cms/multilingual:addSiteLanguage", "mutation",
    (actor) => actor.mutation(api.cms.multilingual.addSiteLanguage, {
      locale: "nl", expectedSettingsUpdatedAt: 1,
      expectedModuleConfigurationVersion: 1, expectedAuthorityVersion: 1,
    }),
    { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" },
    { check: (value) => expect(value).toMatchObject({
      authorityVersion: 2, moduleConfigurationVersion: 1, defaultLocale: "en",
      enabledLocales: ["en", "fr", "nl"], operationKind: "add",
    }) }),
  row("cms/multilingual:prepareLanguageReview", "mutation",
    (actor) => actor.mutation(api.cms.multilingual.prepareLanguageReview, {
      locale: "nl", expectedSettingsUpdatedAt: 1,
      expectedModuleConfigurationVersion: 1, expectedAuthorityVersion: 1,
    }),
    { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" },
    { check: (value) => expect(value).toMatchObject({
      authorityVersion: 1, moduleConfigurationVersion: 1,
      enabledLocales: ["en", "fr"], cancelReturnsToOneLanguage: false,
    }) }),
  row("cms/multilingual:prepareLanguageChange", "mutation",
    (actor) => actor.mutation(api.cms.multilingual.prepareLanguageChange, {
      expectedSettingsUpdatedAt: 1,
      expectedModuleConfigurationVersion: 1, expectedAuthorityVersion: 1,
    }),
    { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" },
    { check: (value) => expect(value).toMatchObject({
      authorityVersion: 1, moduleConfigurationVersion: 1,
      enabledLocales: ["en", "fr"],
    }) }),
  row("cms/multilingual:removeLastExtraLanguage", "mutation",
    (actor, fixture) => actor.mutation(api.cms.multilingual.removeLastExtraLanguage, {
      previewId: fixture.previewId,
      expectedDigest: fixture.previewDigest ?? "absent",
      expectedCount: fixture.previewCount ?? { publicPages: 0, routes: 0, manualRules: 0, menus: 0 },
    }),
    { error: "LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY" },
    { value: { authorityVersion: 3, moduleConfigurationVersion: 1, locale: "en", removedLocale: "fr" } },
    setupReviewedPreview),
]

import { expect, vi } from "vitest"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { makeFunctionReference } from "convex/server"
import { api } from "../../convex/_generated/api"
import type { Id } from "../../convex/_generated/dataModel"
import { readSlicePresentationCatalog } from "../../convex/lib/slices/presentations"
import { LEGACY_SNAPSHOT_MIGRATION_INSTALLED } from "../../convex/lib/publishing/legacyMigration"
import {
  defineRow,
  MATRIX_STATES,
  OWNER,
  setupSnapshotActiveS4,
  setupModuleLanguageState,
  stateLabel,
  type AuthorizationRow,
  type CallTarget,
  type FunctionKind,
  type MatrixState,
  type Outcome,
  type Site,
} from "./harness"

/**
 * These optional function modules are omitted by the Community projection.
 * Literal references let the same shipped suite compile after projection;
 * the central test independently discovers registrations before selecting rows.
 */
const optional = {
  formSubmissions: {
    submitContact: makeFunctionReference<"mutation">(
      "cms/formSubmissions:submitContact"
    ),
    listForAdmin: makeFunctionReference<"query">(
      "cms/formSubmissions:listForAdmin"
    ),
    listForAdminPaginated: makeFunctionReference<"query">(
      "cms/formSubmissions:listForAdminPaginated"
    ),
    getForAdmin: makeFunctionReference<"query">(
      "cms/formSubmissions:getForAdmin"
    ),
    markRead: makeFunctionReference<"mutation">("cms/formSubmissions:markRead"),
    getCounts: makeFunctionReference<"query">("cms/formSubmissions:getCounts"),
  },
  search: {
    searchPages: makeFunctionReference<"query">("cms/search:searchPages"),
    searchPublishedPages: makeFunctionReference<"query">(
      "cms/search:searchPublishedPages"
    ),
    searchMedia: makeFunctionReference<"query">("cms/search:searchMedia"),
  },
  pageHistory: {
    listRevisions: makeFunctionReference<"query">(
      "cms/pageHistory:listRevisions"
    ),
    restoreRevisionAsDraft: makeFunctionReference<"mutation">(
      "cms/pageHistory:restoreRevisionAsDraft"
    ),
  },
  sliceLibrary: {
    setSliceArchived: makeFunctionReference<"mutation">(
      "cms/sliceLibrary:setSliceArchived"
    ),
    cleanupDeletedSliceTypeArchive: makeFunctionReference<"mutation">(
      "cms/sliceLibrary:cleanupDeletedSliceTypeArchive"
    ),
    assertSliceTypeRetirementAllowed: makeFunctionReference<"query">(
      "cms/sliceLibrary:assertSliceTypeRetirementAllowed"
    ),
    getSliceUsageSummary: makeFunctionReference<"query">(
      "cms/sliceLibrary:getSliceUsageSummary"
    ),
    getSlicePresentationUsageSummary: makeFunctionReference<"query">(
      "cms/sliceLibrary:getSlicePresentationUsageSummary"
    ),
  },
}

type ContentFixture = {
  pageId: Id<"pages">
  authorId: Id<"pages">
  mediaId: Id<"media">
  storageId: Id<"_storage">
  menuId: Id<"menus">
  tagId: Id<"tags">
  submissionId: Id<"formSubmissions">
  revisionId?: Id<"pageRevisions">
  languageVersion: number
}

async function setupContent(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const { languageVersion } = await setupModuleLanguageState(t, state)
  return seedContentDocuments(t, languageVersion)
}

async function setupSnapshotS4Content(
  t: Site,
  redirects: "off" | "on"
): Promise<ContentFixture> {
  const { languageVersion } = await setupSnapshotActiveS4(t, redirects)
  return seedRevision(t, await seedContentDocuments(t, languageVersion))
}

async function seedContentDocuments(
  t: Site,
  languageVersion: number
): Promise<ContentFixture> {
  const seeded = await t.run(async (ctx) => {
    const pageId = await ctx.db.insert("pages", {
      pageType: "page",
      slug: "matrix-page",
      status: "published",
      content: {
        en: { title: "Matrix Page", slices: [] },
        fr: { title: "Page matrice", slices: [] },
      },
      createdAt: 1,
      updatedAt: 1,
      publishedAt: 1,
    })
    const authorId = await ctx.db.insert("pages", {
      pageType: "author",
      slug: "matrix-author",
      status: "published",
      name: "Matrix Author",
      content: {
        en: { title: "Matrix Author", roleTitle: "Editor", slices: [] },
        fr: { title: "Auteur matrice", roleTitle: "Rédacteur", slices: [] },
      },
      createdAt: 1,
      updatedAt: 1,
      publishedAt: 1,
    })
    await ctx.db.insert("pageSearch", {
      pageId,
      locale: "en",
      status: "published",
      title: "Matrix Page",
      slug: "matrix-page",
      text: "Matrix Page searchable content",
      updatedAt: 1,
    })
    const storageId = await ctx.storage.store(
      new Blob(["matrix image"], { type: "image/png" })
    )
    const mediaId = await ctx.db.insert("media", {
      filename: "matrix.png",
      storageId,
      url: "https://example.test/matrix.png",
      size: 12,
      mimeType: "image/png",
      uploadedAt: 1,
    })
    const menuId = await ctx.db.insert("menus", {
      slug: "main",
      nav: [],
      updatedAt: 1,
    })
    const tagId = await ctx.db.insert("tags", {
      slug: "matrix",
      label: "Matrix",
      createdAt: 1,
    })
    const submissionId = await ctx.db.insert("formSubmissions", {
      form: "contact",
      payload: {
        name: "Matrix",
        email: "matrix@example.test",
        message: "Matrix message",
      },
      notifyStatus: "pending",
      notifyAttempts: 0,
      schemaVersion: 1,
      createdAt: 1,
    })
    return { pageId, authorId, mediaId, storageId, menuId, tagId, submissionId }
  })
  return { ...seeded, languageVersion }
}

async function setupArchivedPage(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupContent(t, state)
  await t.run((ctx) => ctx.db.patch(fixture.pageId, { status: "archived" }))
  return fixture
}

async function setupDeletedPage(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupArchivedPage(t, state)
  await t.run((ctx) => ctx.db.patch(fixture.pageId, { deletedAt: 2 }))
  return fixture
}

async function setupDeletedMenu(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupContent(t, state)
  await t.run((ctx) => ctx.db.patch(fixture.menuId, { deletedAt: 2 }))
  return fixture
}

async function setupDeletedMedia(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupContent(t, state)
  await t.run((ctx) => ctx.db.patch(fixture.mediaId, { deletedAt: 2 }))
  return fixture
}

async function setupFolder(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupContent(t, state)
  await t.run((ctx) =>
    ctx.db.insert("folders", { name: "matrix-folder", createdAt: 1 })
  )
  return fixture
}

async function setupLockedPage(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupContent(t, state)
  await t.run((ctx) =>
    ctx.db.insert("pageEditorLocks", {
      pageId: fixture.pageId,
      userId: OWNER.tokenIdentifier,
      acquiredAt: Date.now(),
      lastActiveAt: Date.now(),
      updatedAt: Date.now(),
    })
  )
  return fixture
}

async function setupStagedPage(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupLockedPage(t, state)
  await t.withIdentity(OWNER).mutation(api.cms.pages.updateDraft, {
    pageId: fixture.pageId,
    slug: "matrix-staged",
  })
  return fixture
}

async function setupRevision(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  return seedRevision(t, await setupContent(t, state))
}

async function setupMeasuredMedia(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupContent(t, state)
  await t.run((ctx) => ctx.db.patch(fixture.mediaId, { width: 1, height: 1 }))
  return fixture
}

async function seedRevision(
  t: Site,
  fixture: ContentFixture
): Promise<ContentFixture> {
  const revisionId = await t.run((ctx) =>
    ctx.db.insert("pageRevisions", {
      pageId: fixture.pageId,
      revisionNumber: 1,
      createdAt: 1,
      reason: "publish",
      status: "published",
      slug: "matrix-page",
      pageType: "page",
      contentJson: JSON.stringify({
        en: { title: "Archived Matrix", slices: [] },
      }),
      metadata: { title: "Archived Matrix", locales: ["en"], summary: [] },
    })
  )
  return { ...fixture, revisionId }
}

type SuccessorFixture = {
  pageId: Id<"pages">
  sessionToken?: string
  snapshotId?: Id<"pagePublishedSnapshots">
}

async function setupSuccessorPage(
  t: Site,
  redirects: "off" | "on"
): Promise<SuccessorFixture> {
  await setupSnapshotActiveS4(t, redirects)
  const owner = t.withIdentity(OWNER)
  const homePageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("siteSettings").unique()
    await ctx.db.patch(settings!._id, { homePageId })
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "snapshot-matrix",
    title: "Snapshot Matrix",
    content: {
      en: { title: "Snapshot Matrix", slices: [] },
      fr: { title: "Matrice", slices: [] },
    },
  })
  return { pageId }
}

async function setupSuccessorSession(
  t: Site,
  redirects: "off" | "on"
): Promise<SuccessorFixture> {
  const fixture = await setupSuccessorPage(t, redirects)
  const session = await t
    .withIdentity(OWNER)
    .mutation(api.cms.preview.createPreviewSession, {
      pageId: fixture.pageId,
      locale: "en",
    })
  return { ...fixture, sessionToken: session.sessionToken }
}

async function setupSuccessorPublished(
  t: Site,
  redirects: "off" | "on"
): Promise<SuccessorFixture> {
  const fixture = await setupSuccessorPage(t, redirects)
  const published = await t
    .withIdentity(OWNER)
    .mutation(api.cms.publication.publishLocale, {
      pageId: fixture.pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
  return { ...fixture, snapshotId: published.snapshotId }
}

async function setupSuccessorArchived(
  t: Site,
  redirects: "off" | "on"
): Promise<SuccessorFixture> {
  const fixture = await setupSuccessorPage(t, redirects)
  await t.withIdentity(OWNER).mutation(api.cms.publication.archivePage, {
    pageId: fixture.pageId,
    expectedLifecycleGeneration: 1,
  })
  return fixture
}

async function setupSuccessorTrashed(
  t: Site,
  redirects: "off" | "on"
): Promise<SuccessorFixture> {
  const fixture = await setupSuccessorPage(t, redirects)
  await t.withIdentity(OWNER).mutation(api.cms.publication.softDeletePage, {
    pageId: fixture.pageId,
    expectedLifecycleGeneration: 1,
  })
  return fixture
}

async function setupLegacySnapshotReference(
  t: Site,
  state: MatrixState
): Promise<SuccessorFixture> {
  const fixture = await setupContent(t, state)
  const snapshotId = await t.run(async (ctx) => {
    const attribution = {
      kind: "migration" as const,
      migrationRunId: "matrix-history",
    }
    const candidateId = await ctx.db.insert("pageLocalePublicationCandidates", {
      pageId: fixture.pageId,
      locale: "en",
      pageType: "page",
      sourceDraftGeneration: 1,
      sourceSharedDraftGeneration: 1,
      sourcePublicGeneration: 0,
      sourceLifecycleGeneration: 1,
      attribution,
      formatVersion: 1,
      payloadJson: "{}",
      payloadBytes: 2,
      digest: "matrix-history",
      createdAt: 1,
    })
    const releaseId = await ctx.db.insert("pageLocalePublicationReleases", {
      pageId: fixture.pageId,
      locale: "en",
      candidateId,
      generation: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      executeAt: 1,
      status: "published",
      attribution,
      createdAt: 1,
      updatedAt: 1,
    })
    const snapshotId = await ctx.db.insert("pagePublishedSnapshots", {
      pageId: fixture.pageId,
      locale: "en",
      generation: 1,
      candidateId,
      candidateDigest: "matrix-history",
      sourceDraftGeneration: 1,
      sourceSharedDraftGeneration: 1,
      sourcePublicGeneration: 0,
      sourceLifecycleGeneration: 1,
      releaseId,
      publishedAt: 1,
      attribution,
    })
    // The legacy epoch has no selected snapshot. Keep a valid, absent ID for
    // the handler's authority-first argument path without retaining artifacts.
    await ctx.db.delete(snapshotId)
    await ctx.db.delete(releaseId)
    await ctx.db.delete(candidateId)
    return snapshotId
  })
  return { pageId: fixture.pageId, snapshotId }
}

const successorOnly = (
  name: string,
  kind: FunctionKind,
  call: (actor: CallTarget, fixture: SuccessorFixture) => Promise<unknown>,
  owner: Outcome,
  setup: (
    t: Site,
    redirects: "off" | "on"
  ) => Promise<SuccessorFixture> = setupSuccessorPage,
  legacyAuthFirst = false,
  legacySetup: (
    t: Site,
    state: MatrixState
  ) => Promise<SuccessorFixture> = setupContent
): AuthorizationRow =>
  defineRow({
    name,
    kind,
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => legacySetup(t, state),
        call,
        outcomes: {
          owner: { error: "PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED" },
          signedOut: {
            error: legacyAuthFirst
              ? "UNAUTHENTICATED"
              : "PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED",
          },
          unrelated: {
            error: legacyAuthFirst
              ? "CMS_OWNER_REQUIRED"
              : "PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED",
          },
          former: {
            error: legacyAuthFirst
              ? "CMS_OWNER_REQUIRED"
              : "PUBLISHED_SNAPSHOT_AUTHORITY_REQUIRED",
          },
        },
        readOnly: kind === "query",
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setup(t, redirects),
        call,
        outcomes: {
          owner,
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
        readOnly: kind === "query",
      })),
    ],
  })

const ownerOnly = (
  name: string,
  kind: FunctionKind,
  call: (actor: CallTarget, fixture: ContentFixture) => Promise<unknown>,
  owner: Outcome,
  setup: (
    t: Site,
    state: MatrixState
  ) => Promise<ContentFixture> = setupContent,
  after?: (t: Site, fixture: ContentFixture) => Promise<void>
): AuthorizationRow =>
  defineRow({
    name,
    kind,
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setup(t, state),
        call,
        outcomes: {
          owner,
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
        after,
      })),
      ...(["off", "on"] as const).flatMap((redirects) => {
        const error = snapshotOwnerRefusals[name]
        if (!error) return []
        return [
          {
            label: `snapshot-S4/redirects-${redirects}`,
            setup: (t: Site) => setupSnapshotS4Content(t, redirects),
            call,
            outcomes: {
              owner: { error },
              signedOut: {
                error:
                  name === "cms/pages:updateDraft" ? error : "UNAUTHENTICATED",
              },
              unrelated: {
                error:
                  name === "cms/pages:updateDraft"
                    ? error
                    : "CMS_OWNER_REQUIRED",
              },
              former: {
                error:
                  name === "cms/pages:updateDraft"
                    ? error
                    : "CMS_OWNER_REQUIRED",
              },
            },
          },
        ]
      }),
    ],
  })

const snapshotOwnerRefusals: Record<string, string> = {
  "cms/pages:isSlugAvailable": "PUBLISHED_SNAPSHOT_USE_PUBLISH_LOCALE",
  "cms/pages:list": "SNAPSHOT_ADMIN_PROJECTION_REQUIRED",
  "cms/pages:listPaginated": "SNAPSHOT_ADMIN_PROJECTION_REQUIRED",
  "cms/pages:duplicate":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.duplicate:use successor publication commands",
  "cms/pages:update":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.update:use successor publication commands",
  "cms/pages:softDelete":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.softDelete:use successor publication commands",
  "cms/pages:restore":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.restore:use successor publication commands",
  "cms/pages:remove": "PERMANENT_PAGE_PURGE_NOT_IMPLEMENTED",
  "cms/pages:backfillMediaReferences":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.backfillMediaReferences:use successor publication commands",
  "cms/pages:updateDraft":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.updateDraft:use successor publication commands",
  "cms/pages:publish":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.publish:use successor publication commands",
  "cms/pages:discardDraft":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.discardDraft:use successor publication commands",
  "cms/pageHistory:restoreRevisionAsDraft":
    "LEGACY_PUBLICATION_WRITER_DISABLED:pages.restoreRevisionAsDraft:use successor publication commands",
}

const allActors = (
  name: string,
  kind: FunctionKind,
  call: (actor: CallTarget, fixture: ContentFixture) => Promise<unknown>,
  outcome: Outcome
): AuthorizationRow =>
  defineRow({
    name,
    kind,
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupContent(t, state),
      call,
      outcomes: {
        owner: outcome,
        signedOut: outcome,
        unrelated: outcome,
        former: outcome,
      },
    })),
  })

const publicByState = (
  name: string,
  call: (actor: CallTarget, fixture: ContentFixture) => Promise<unknown>,
  outcome: (state: MatrixState) => Outcome
): AuthorizationRow =>
  defineRow({
    name,
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupContent(t, state),
      call,
      outcomes: {
        owner: outcome(state),
        signedOut: outcome(state),
        unrelated: outcome(state),
        former: outcome(state),
      },
      readOnly: true,
    })),
  })

/** These historical full-document readers intentionally mask denial as absence. */
const maskedRead = (
  name: string,
  call: (actor: CallTarget, fixture: ContentFixture) => Promise<unknown>,
  owner: Outcome,
  absent: unknown
): AuthorizationRow =>
  defineRow({
    name,
    kind: "query",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupContent(t, state),
      call,
      outcomes: {
        owner,
        signedOut: { value: absent },
        unrelated: { value: absent },
        former: { value: absent },
      },
      readOnly: true,
    })),
  })

type MigrationStage =
  "legacy" | "home" | "normalized" | "begun" | "scanned" | "prepared" | "ready"
type MigrationFixture = { pageId: Id<"pages">; closureDigest?: string }
const MIGRATION_RUN = "matrix-migration"

async function setupLegacyMigration(
  t: Site,
  state: MatrixState,
  stage: MigrationStage
): Promise<MigrationFixture> {
  await setupModuleLanguageState(t, state)
  const owner = t.withIdentity(OWNER)
  const pageId = LEGACY_SNAPSHOT_MIGRATION_INSTALLED
    ? await owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "published",
        slug: "home",
        title: "Migration home",
        content: { en: { title: "Migration home", slices: [] } },
      })
    : await t.run((ctx) =>
        ctx.db.insert("pages", {
          pageType: "landing-page",
          status: "published",
          slug: "home",
          content: { en: { title: "Migration home", slices: [] } },
          createdAt: 1,
          updatedAt: 1,
          publishedAt: 1,
        })
      )
  if (!LEGACY_SNAPSHOT_MIGRATION_INSTALLED || stage === "legacy")
    return { pageId }
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("siteSettings").unique()
    await ctx.db.patch(settings!._id, { homePageId: pageId })
  })
  if (stage === "home") return { pageId }
  await owner.mutation(api.cms.publication.normalizeLegacyHomeIdentity, {
    expectedSettingsUpdatedAt: 1,
  })
  if (stage === "normalized") return { pageId }
  await owner.mutation(api.cms.publication.beginSnapshotMigration, {
    migrationRunId: MIGRATION_RUN,
    expectedRevision: 1,
  })
  if (stage === "begun") return { pageId }
  const scanned = await owner.mutation(
    api.cms.publication.scanSnapshotMigrationSources,
    {
      migrationRunId: MIGRATION_RUN,
      expectedRevision: 2,
    }
  )
  if (!scanned.isDone) throw new Error("one-page migration scan did not finish")
  if (stage === "scanned") return { pageId }
  await owner.mutation(api.cms.publication.prepareSnapshotMigrationPage, {
    migrationRunId: MIGRATION_RUN,
    pageId,
  })
  if (stage === "prepared") return { pageId }
  const ready = await owner.mutation(
    api.cms.publication.finalizeSnapshotMigration,
    {
      migrationRunId: MIGRATION_RUN,
      expectedRevision: 2,
    }
  )
  if (!ready.isDone || !ready.closureDigest)
    throw new Error("migration closure did not finish")
  return { pageId, closureDigest: ready.closureDigest }
}

async function setupSnapshotMigrationGuard(
  t: Site,
  redirects: "off" | "on"
): Promise<MigrationFixture> {
  await setupSnapshotActiveS4(t, redirects)
  const pageId = await t.withIdentity(OWNER).mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "snapshot-home",
    title: "Snapshot home",
    content: { en: { title: "Snapshot home", slices: [] } },
  })
  return { pageId }
}

const migrationRow = (
  name: string,
  stage: MigrationStage,
  call: (actor: CallTarget, fixture: MigrationFixture) => Promise<unknown>,
  sourceSuccess: (fixture: MigrationFixture) => Outcome,
  sourceS4Error: string
): AuthorizationRow =>
  defineRow({
    name,
    kind: "mutation",
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupLegacyMigration(t, state, stage),
        call,
        outcomes: (fixture: MigrationFixture) =>
          LEGACY_SNAPSHOT_MIGRATION_INSTALLED
            ? {
                owner: sourceSuccess(fixture),
                signedOut: { error: "UNAUTHENTICATED" },
                unrelated: { error: "CMS_OWNER_REQUIRED" },
                former: { error: "CMS_OWNER_REQUIRED" },
              }
            : {
                owner: { error: "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED" },
                signedOut: { error: "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED" },
                unrelated: { error: "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED" },
                former: { error: "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED" },
              },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotMigrationGuard(t, redirects),
        call,
        outcomes: LEGACY_SNAPSHOT_MIGRATION_INSTALLED
          ? {
              owner: { error: sourceS4Error },
              signedOut: { error: "UNAUTHENTICATED" },
              unrelated: { error: "CMS_OWNER_REQUIRED" },
              former: { error: "CMS_OWNER_REQUIRED" },
            }
          : {
              owner: { error: "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED" },
              signedOut: { error: "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED" },
              unrelated: { error: "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED" },
              former: { error: "LEGACY_SNAPSHOT_MIGRATION_NOT_INSTALLED" },
            },
      })),
    ],
  })

const migrationRows: AuthorizationRow[] = [
  migrationRow(
    "cms/publication:initializeLegacySnapshotAuthority",
    "legacy",
    (actor) =>
      actor.mutation(api.cms.publication.initializeLegacySnapshotAuthority, {}),
    () => ({ value: { phase: "legacy", revision: 1 } }),
    "PUBLISHED_SNAPSHOT_CUTOVER_ALREADY_INITIALIZED"
  ),
  migrationRow(
    "cms/publication:normalizeLegacyHomeIdentity",
    "home",
    (actor) =>
      actor.mutation(api.cms.publication.normalizeLegacyHomeIdentity, {
        expectedSettingsUpdatedAt: 1,
      }),
    (fixture) => ({
      check: (value) =>
        expect(value).toMatchObject({
          homePageId: fixture.pageId,
          settingsUpdatedAt: expect.any(Number),
        }),
    }),
    "LEGACY_PUBLICATION_WRITER_DISABLED:publication.normalizeLegacyHomeIdentity:use successor publication commands"
  ),
  migrationRow(
    "cms/publication:beginSnapshotMigration",
    "normalized",
    (actor) =>
      actor.mutation(api.cms.publication.beginSnapshotMigration, {
        migrationRunId: MIGRATION_RUN,
        expectedRevision: 1,
      }),
    () => ({
      value: {
        migrationRunId: MIGRATION_RUN,
        expectedPageCount: 0,
        revision: 2,
      },
    }),
    "PUBLISHED_SNAPSHOT_CUTOVER_STALE"
  ),
  migrationRow(
    "cms/publication:scanSnapshotMigrationSources",
    "begun",
    (actor) =>
      actor.mutation(api.cms.publication.scanSnapshotMigrationSources, {
        migrationRunId: MIGRATION_RUN,
        expectedRevision: 2,
      }),
    () => ({ value: { scanned: 1, expectedPageCount: 1, isDone: true } }),
    "PUBLISHED_SNAPSHOT_CUTOVER_STALE"
  ),
  migrationRow(
    "cms/publication:prepareSnapshotMigrationPage",
    "scanned",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.prepareSnapshotMigrationPage, {
        migrationRunId: MIGRATION_RUN,
        pageId: fixture.pageId,
      }),
    (fixture) => ({ value: { pageId: fixture.pageId, prepared: true } }),
    "PUBLISHED_SNAPSHOT_MIGRATION_NOT_PREPARING"
  ),
  migrationRow(
    "cms/publication:finalizeSnapshotMigration",
    "prepared",
    (actor) =>
      actor.mutation(api.cms.publication.finalizeSnapshotMigration, {
        migrationRunId: MIGRATION_RUN,
        expectedRevision: 2,
      }),
    () => ({
      check: (value) =>
        expect(value).toMatchObject({
          phase: "ready",
          isDone: true,
          revision: 2,
          closureDigest: expect.any(String),
        }),
    }),
    "PUBLISHED_SNAPSHOT_CUTOVER_STALE"
  ),
  migrationRow(
    "cms/publication:activateSnapshotAuthority",
    "ready",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.activateSnapshotAuthority, {
        migrationRunId: MIGRATION_RUN,
        expectedRevision: 2,
        expectedClosureDigest: fixture.closureDigest ?? "absent",
      }),
    () => ({ value: { phase: "snapshot_active", revision: 3 } }),
    "PUBLISHED_SNAPSHOT_CUTOVER_STALE"
  ),
  migrationRow(
    "cms/publication:abortSnapshotMigrationPage",
    "prepared",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.abortSnapshotMigrationPage, {
        migrationRunId: MIGRATION_RUN,
        pageId: fixture.pageId,
      }),
    (fixture) => ({ value: { pageId: fixture.pageId, removed: true } }),
    "PUBLICATION_MIGRATION_ABORT_FORBIDDEN"
  ),
  migrationRow(
    "cms/publication:finishSnapshotMigrationAbort",
    "begun",
    (actor) =>
      actor.mutation(api.cms.publication.finishSnapshotMigrationAbort, {
        migrationRunId: MIGRATION_RUN,
        expectedRevision: 2,
      }),
    () => ({ value: { phase: "legacy", revision: 3 } }),
    "PUBLICATION_MIGRATION_ABORT_FORBIDDEN"
  ),
]

export const contentRows: AuthorizationRow[] = [
  ownerOnly(
    "cms/sliceLibrary:getSlicePresentationUsageSummary",
    "query",
    (actor) =>
      actor.query(optional.sliceLibrary.getSlicePresentationUsageSummary, {
        type: "hero-with-image",
        presentationIds: ["centered"],
      }),
    { value: { status: "unavailable" } }
  ),
  ...migrationRows,
  successorOnly(
    "cms/publication:listSnapshotHistory",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.publication.listSnapshotHistory, {
        pageId: fixture.pageId,
        locale: "en",
      }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({
            generation: 1,
            payloadJson: expect.any(String),
            unavailablePaths: [],
          }),
        ]),
    },
    setupSuccessorPublished
  ),
  successorOnly(
    "cms/publication:restoreSnapshotAsDraft",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.restoreSnapshotAsDraft, {
        pageId: fixture.pageId,
        locale: "en",
        snapshotId: fixture.snapshotId!,
        expectedDraftGeneration: 1,
        expectedSharedDraftGeneration: 1,
        expectedLifecycleGeneration: 1,
        expectedPublicGeneration: 1,
        expectedReleaseGeneration: 1,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          locale: "en",
          draftGeneration: 2,
          sharedDraftGeneration: 2,
        }),
    },
    setupSuccessorPublished,
    false,
    setupLegacySnapshotReference
  ),
  successorOnly(
    "cms/preview:createPreviewSession",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.preview.createPreviewSession, {
        pageId: fixture.pageId,
        locale: "en",
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          requestedLocale: "en",
          sessionToken: expect.any(String),
        }),
    }
  ),
  defineRow({
    name: "cms/preview:getPreviewPage",
    kind: "mutation",
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupContent(t, state),
        call: (actor: CallTarget, fixture: SuccessorFixture) =>
          actor.mutation(api.cms.preview.getPreviewPage, {
            pageId: fixture.pageId,
            locale: "en",
          }),
        outcomes: {
          owner: { value: null },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSuccessorSession(t, redirects),
        call: (actor: CallTarget, fixture: SuccessorFixture) =>
          actor.mutation(api.cms.preview.getPreviewPage, {
            pageId: fixture.pageId,
            locale: "en",
            sessionToken: fixture.sessionToken,
          }),
        outcomes: {
          owner: {
            check: (value: unknown) =>
              expect(value).toMatchObject({
                page: { slug: "snapshot-matrix" },
                requestedLocale: "en",
                renderLocale: "en",
                isFallback: false,
              }),
          },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
      })),
    ],
  }),
  defineRow({
    name: "cms/preview:resolvePreviewPath",
    kind: "mutation",
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: (t: Site) => setupContent(t, state),
        call: (actor: CallTarget) =>
          actor.mutation(api.cms.preview.resolvePreviewPath, {
            path: "/snapshot-matrix",
            locale: "en",
          }),
        outcomes: {
          owner: { value: null },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSuccessorSession(t, redirects),
        call: (actor: CallTarget, fixture: SuccessorFixture) =>
          actor.mutation(api.cms.preview.resolvePreviewPath, {
            path: "/snapshot-matrix",
            locale: "en",
            sessionToken: fixture.sessionToken,
          }),
        outcomes: (fixture: SuccessorFixture) => ({
          owner: {
            value: {
              pageId: fixture.pageId,
              renderLocale: "en",
              isFallback: false,
            },
          },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        }),
      })),
    ],
  }),
  successorOnly(
    "cms/publication:listAdminPages",
    "query",
    (actor) =>
      actor.query(api.cms.publication.listAdminPages, {
        paginationOpts: { numItems: 10, cursor: null },
        scope: "content",
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          page: expect.arrayContaining([
            expect.objectContaining({ slug: "snapshot-matrix" }),
          ]),
          isDone: true,
        }),
    },
    setupSuccessorPage,
    true
  ),
  defineRow({
    name: "cms/publication:initializeEmptySnapshotAuthority",
    kind: "mutation",
    scenarios: [
      ...MATRIX_STATES.map((state) => ({
        label: stateLabel(state),
        setup: async (t: Site) => {
          await setupModuleLanguageState(t, state)
          await t.run(async (ctx) => {
            const cutover = await ctx.db
              .query("pagePublicationCutover")
              .unique()
            await ctx.db.delete(cutover!._id)
          })
          return {}
        },
        call: (actor: CallTarget) =>
          actor.mutation(
            api.cms.publication.initializeEmptySnapshotAuthority,
            {}
          ),
        outcomes: {
          owner: { value: { phase: "snapshot_active", revision: 1 } },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
      })),
      ...(["off", "on"] as const).map((redirects) => ({
        label: `snapshot-S4/redirects-${redirects}`,
        setup: (t: Site) => setupSnapshotActiveS4(t, redirects),
        call: (actor: CallTarget) =>
          actor.mutation(
            api.cms.publication.initializeEmptySnapshotAuthority,
            {}
          ),
        outcomes: {
          owner: { value: { phase: "snapshot_active", revision: 2 } },
          signedOut: { error: "UNAUTHENTICATED" },
          unrelated: { error: "CMS_OWNER_REQUIRED" },
          former: { error: "CMS_OWNER_REQUIRED" },
        },
      })),
    ],
  }),
  successorOnly(
    "cms/publication:addressAvailability",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.publication.addressAvailability, {
        pageId: fixture.pageId,
        locale: "en",
        slug: "snapshot-matrix-free",
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          parentChanged: false,
          entries: [
            expect.objectContaining({
              locale: "en",
              check: expect.objectContaining({ kind: "free" }),
            }),
          ],
        }),
    },
    setupSuccessorPage,
    true
  ),
  successorOnly(
    "cms/publication:saveSharedDraft",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.saveSharedDraft, {
        pageId: fixture.pageId,
        expectedSharedDraftGeneration: 1,
        expectedLifecycleGeneration: 1,
        template: "matrix-template",
      }),
    { check: (value) => expect(value).toMatchObject({ generation: 2 }) }
  ),
  successorOnly(
    "cms/publication:saveLocaleDraft",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.saveLocaleDraft, {
        pageId: fixture.pageId,
        locale: "en",
        slug: "snapshot-matrix-edited",
        draft: {
          pageType: "landing-page",
          localized: { title: "Snapshot Matrix Edited" },
          slices: [],
        },
        expectedDraftGeneration: 1,
        expectedLifecycleGeneration: 1,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ locale: "en", generation: 2 }),
    }
  ),
  successorOnly(
    "cms/publication:saveEditorDraft",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.saveEditorDraft, {
        pageId: fixture.pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug: "snapshot-matrix-edited",
          expectedGeneration: 1,
          draft: {
            pageType: "landing-page",
            localized: { title: "Snapshot Matrix Edited" },
            slices: [],
          },
        },
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ locale: "en", draftGeneration: 2 }),
    }
  ),
  successorOnly(
    "cms/publication:discardLocaleDraft",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.discardLocaleDraft, {
        pageId: fixture.pageId,
        locale: "en",
        expectedDraftGeneration: 1,
        expectedLifecycleGeneration: 1,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ locale: "en", generation: 2 }),
    }
  ),
  successorOnly(
    "cms/publication:deleteLocaleContent",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.deleteLocaleContent, {
        pageId: fixture.pageId,
        locale: "fr",
        expectedDraftGeneration: 1,
        expectedPublicGeneration: 0,
        expectedLifecycleGeneration: 1,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ locale: "fr", generation: 2 }),
    }
  ),
  successorOnly(
    "cms/publication:publishLocale",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.publishLocale, {
        pageId: fixture.pageId,
        locale: "en",
        expectedDraftGeneration: 1,
        expectedSharedDraftGeneration: 1,
        expectedPublicGeneration: 0,
        expectedLifecycleGeneration: 1,
        expectedReleaseGeneration: 0,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          locale: "en",
          publicGeneration: 1,
          snapshotId: expect.any(String),
        }),
    }
  ),
  successorOnly(
    "cms/publication:withdrawLocale",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.withdrawLocale, {
        pageId: fixture.pageId,
        locale: "en",
        expectedSnapshotId: fixture.snapshotId!,
        expectedPublicGeneration: 1,
        expectedLifecycleGeneration: 1,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ locale: "en", publicGeneration: 2 }),
    },
    setupSuccessorPublished,
    false,
    setupLegacySnapshotReference
  ),
  successorOnly(
    "cms/publication:archivePage",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.archivePage, {
        pageId: fixture.pageId,
        expectedLifecycleGeneration: 1,
      }),
    {
      check: (value) => expect(value).toMatchObject({ lifecycleGeneration: 2 }),
    }
  ),
  successorOnly(
    "cms/publication:restorePage",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.restorePage, {
        pageId: fixture.pageId,
        expectedLifecycleGeneration: 2,
      }),
    {
      check: (value) => expect(value).toMatchObject({ lifecycleGeneration: 3 }),
    },
    setupSuccessorArchived
  ),
  successorOnly(
    "cms/publication:softDeletePage",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.softDeletePage, {
        pageId: fixture.pageId,
        expectedLifecycleGeneration: 1,
      }),
    {
      check: (value) => expect(value).toMatchObject({ lifecycleGeneration: 2 }),
    },
    setupSuccessorPage,
    true
  ),
  successorOnly(
    "cms/publication:restoreSoftDeletedPage",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.restoreSoftDeletedPage, {
        pageId: fixture.pageId,
        expectedLifecycleGeneration: 2,
      }),
    {
      check: (value) => expect(value).toMatchObject({ lifecycleGeneration: 3 }),
    },
    setupSuccessorTrashed
  ),
  ownerOnly(
    "cms/media:backfillImageDimensions",
    "action",
    (actor) => actor.action(api.cms.media.backfillImageDimensions, {}),
    {
      check: (value) =>
        expect(value).toMatchObject({
          scanned: 1,
          measured: 0,
          skipped: 0,
          failures: [],
          isDone: true,
        }),
    },
    setupMeasuredMedia
  ),
  defineRow({
    name: "cms/media:importFromUrl",
    kind: "action",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: async (t: Site) => {
        const fixture = await setupContent(t, state)
        rateLimiterTest.register(t)
        const png = Uint8Array.from(
          atob(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lWQAAAAASUVORK5CYII="
          ),
          (char) => char.charCodeAt(0)
        )
        vi.stubGlobal(
          "fetch",
          vi.fn(
            async () =>
              new Response(png, {
                status: 200,
                headers: {
                  "content-type": "image/png",
                  "content-length": String(png.byteLength),
                },
              })
          )
        )
        return fixture
      },
      call: (actor: CallTarget) =>
        actor.action(api.cms.media.importFromUrl, {
          url: "https://images.example.test/imported.png",
        }),
      outcomes: {
        owner: {
          check: (value: unknown) => expect(value).toEqual(expect.any(String)),
        },
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      after: async (t: Site) => {
        expect(await t.run((ctx) => ctx.db.query("media").collect())).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ filename: "imported.png" }),
          ])
        )
      },
      teardown: async () => {
        vi.unstubAllGlobals()
      },
    })),
  }),
  ownerOnly(
    "cms/pages:initializeBoundedPilotEnvelope",
    "mutation",
    (actor) => actor.mutation(api.cms.pages.initializeBoundedPilotEnvelope, {}),
    {
      check: (value) =>
        expect(value).toMatchObject({
          withinEnvelope: true,
          totalPagesBelowCap: true,
          publishedPagesBelowCap: true,
        }),
    }
  ),
  ownerOnly(
    "cms/pages:updateDraft",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.updateDraft, {
        pageId: fixture.pageId,
        slug: "matrix-new-draft",
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ updatedAt: expect.any(Number) }),
    },
    setupLockedPage,
    async (t, fixture) => {
      expect(
        await t.run((ctx) =>
          ctx.db
            .query("pageStaging")
            .withIndex("by_pageId", (q) => q.eq("pageId", fixture.pageId))
            .first()
        )
      ).toMatchObject({ slug: "matrix-new-draft" })
    }
  ),
  ownerOnly(
    "cms/pages:publish",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.publish, { pageId: fixture.pageId }),
    {
      check: (value) =>
        expect(value).toMatchObject({ updatedAt: expect.any(Number) }),
    },
    setupStagedPage,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.pageId))).toMatchObject({
        slug: "matrix-staged",
      })
    }
  ),
  ownerOnly(
    "cms/pages:discardDraft",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.discardDraft, { pageId: fixture.pageId }),
    { value: null },
    setupStagedPage,
    async (t, fixture) => {
      expect(
        await t.run((ctx) =>
          ctx.db
            .query("pageStaging")
            .withIndex("by_pageId", (q) => q.eq("pageId", fixture.pageId))
            .first()
        )
      ).toBeNull()
    }
  ),
  ownerOnly(
    "cms/pageHistory:restoreRevisionAsDraft",
    "mutation",
    (actor, fixture) =>
      actor.mutation(optional.pageHistory.restoreRevisionAsDraft, {
        revisionId: fixture.revisionId!,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ updatedAt: expect.any(Number) }),
    },
    setupRevision,
    async (t, fixture) => {
      expect(
        await t.run((ctx) =>
          ctx.db
            .query("pageStaging")
            .withIndex("by_pageId", (q) => q.eq("pageId", fixture.pageId))
            .first()
        )
      ).toMatchObject({ content: { en: { title: "Archived Matrix" } } })
    }
  ),
  ownerOnly(
    "cms/pages:create",
    "mutation",
    (actor) =>
      actor.mutation(api.cms.pages.create, {
        pageType: "page",
        status: "draft",
        title: "New Matrix Page",
        slug: "new-matrix-page",
      }),
    { check: (value) => expect(value).toEqual(expect.any(String)) },
    setupContent,
    async (t) => {
      expect(await t.run((ctx) => ctx.db.query("pages").collect())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: "new-matrix-page" }),
        ])
      )
    }
  ),
  ownerOnly(
    "cms/pages:duplicate",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.duplicate, {
        id: fixture.pageId,
        title: "Matrix Copy",
      }),
    { check: (value) => expect(value).toEqual(expect.any(String)) },
    setupContent,
    async (t) => {
      expect(await t.run((ctx) => ctx.db.query("pages").collect())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ slug: "matrix-page-copy" }),
        ])
      )
    }
  ),
  ownerOnly(
    "cms/pages:update",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.update, {
        id: fixture.pageId,
        slug: "matrix-updated",
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ updatedAt: expect.any(Number) }),
    },
    setupContent,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.pageId))).toMatchObject({
        slug: "matrix-updated",
      })
    }
  ),
  ownerOnly(
    "cms/pages:softDelete",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.softDelete, { id: fixture.pageId }),
    { value: null },
    setupArchivedPage,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.pageId))).toMatchObject({
        deletedAt: expect.any(Number),
      })
    }
  ),
  ownerOnly(
    "cms/pages:restore",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.restore, { id: fixture.pageId }),
    { value: null },
    setupDeletedPage,
    async (t, fixture) => {
      expect(
        await t.run((ctx) => ctx.db.get(fixture.pageId))
      ).not.toHaveProperty("deletedAt")
    }
  ),
  ownerOnly(
    "cms/pages:remove",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.remove, { id: fixture.pageId }),
    { value: null },
    setupDeletedPage,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.pageId))).toBeNull()
    }
  ),
  ownerOnly(
    "cms/pages:backfillMediaReferences",
    "mutation",
    (actor) => actor.mutation(api.cms.pages.backfillMediaReferences, {}),
    {
      check: (value) =>
        expect(value).toMatchObject({
          pagesScanned: 2,
          pagesRefreshed: 2,
          isDone: true,
        }),
    }
  ),
  ownerOnly(
    "cms/pages:touchPagePresence",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.touchPagePresence, {
        pageId: fixture.pageId,
      }),
    { value: null },
    setupContent,
    async (t) => {
      expect(
        await t.run((ctx) => ctx.db.query("pagePresence").collect())
      ).toHaveLength(1)
    }
  ),
  ownerOnly(
    "cms/pages:leavePagePresence",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.leavePagePresence, {
        pageId: fixture.pageId,
      }),
    { value: null },
    setupContent
  ),
  ownerOnly(
    "cms/pages:acquirePageEditorLock",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.acquirePageEditorLock, {
        pageId: fixture.pageId,
      }),
    { check: (value) => expect(value).toMatchObject({ status: "acquired" }) }
  ),
  ownerOnly(
    "cms/pages:releasePageEditorLock",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.releasePageEditorLock, {
        pageId: fixture.pageId,
      }),
    { value: null }
  ),
  ownerOnly(
    "cms/pages:heartbeatPageEditor",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.heartbeatPageEditor, {
        pageId: fixture.pageId,
      }),
    { check: (value) => expect(value).toMatchObject({ status: "acquired" }) }
  ),
  ownerOnly(
    "cms/media:create",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.media.create, {
        filename: "created.png",
        storageId: fixture.storageId,
        size: 12,
        mimeType: "image/png",
      }),
    { check: (value) => expect(value).toEqual(expect.any(String)) },
    setupContent,
    async (t) => {
      expect(await t.run((ctx) => ctx.db.query("media").collect())).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ filename: "created.png" }),
        ])
      )
    }
  ),
  ownerOnly(
    "cms/media:update",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.media.update, {
        id: fixture.mediaId,
        folder: "matrix-folder",
      }),
    { value: null },
    setupContent,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.mediaId))).toMatchObject({
        folder: "matrix-folder",
      })
    }
  ),
  ownerOnly(
    "cms/media:softDelete",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.media.softDelete, { id: fixture.mediaId }),
    { value: null },
    setupContent,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.mediaId))).toMatchObject({
        deletedAt: expect.any(Number),
      })
    }
  ),
  ownerOnly(
    "cms/media:restore",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.media.restore, { id: fixture.mediaId }),
    { value: null },
    setupDeletedMedia,
    async (t, fixture) => {
      expect(
        await t.run((ctx) => ctx.db.get(fixture.mediaId))
      ).not.toHaveProperty("deletedAt")
    }
  ),
  ownerOnly(
    "cms/media:remove",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.media.remove, { id: fixture.mediaId }),
    { value: null },
    setupContent,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.mediaId))).toBeNull()
    }
  ),
  ownerOnly(
    "cms/media:createFolder",
    "mutation",
    (actor) =>
      actor.mutation(api.cms.media.createFolder, { name: "matrix-folder" }),
    { value: { name: "matrix-folder" } },
    setupContent,
    async (t) => {
      expect(await t.run((ctx) => ctx.db.query("folders").collect())).toEqual([
        expect.objectContaining({ name: "matrix-folder" }),
      ])
    }
  ),
  ownerOnly(
    "cms/media:deleteFolder",
    "mutation",
    (actor) =>
      actor.mutation(api.cms.media.deleteFolder, { name: "matrix-folder" }),
    { value: { success: true, count: 0 } },
    setupFolder,
    async (t) => {
      expect(
        await t.run((ctx) => ctx.db.query("folders").collect())
      ).toHaveLength(0)
    }
  ),
  ownerOnly(
    "cms/menus:restore",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.menus.restore, { id: fixture.menuId }),
    { value: null },
    setupDeletedMenu,
    async (t, fixture) => {
      expect(
        await t.run((ctx) => ctx.db.get(fixture.menuId))
      ).not.toHaveProperty("deletedAt")
    }
  ),
  ownerOnly(
    "cms/sliceLibrary:assertSliceTypeRetirementAllowed",
    "query",
    (actor) =>
      actor.query(optional.sliceLibrary.assertSliceTypeRetirementAllowed, {
        type: "hero-agency",
      }),
    { value: null }
  ),
  allActors(
    "cms/formSubmissions:submitContact",
    "mutation",
    (actor) =>
      actor.mutation(optional.formSubmissions.submitContact, {
        name: "Matrix",
        email: "matrix@example.test",
        message: "Matrix message",
        company_url: "filled-honeypot",
      }),
    { value: { ok: true, throttled: false } }
  ),
  allActors(
    "cms/pages:getPublicPageById",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getPublicPageById, {
        id: fixture.pageId,
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          pageType: "page",
          content: { en: { title: "Matrix Page" } },
        }),
    }
  ),
  allActors(
    "cms/pages:getPublicByline",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getPublicByline, {
        authorPageId: fixture.authorId,
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    { value: { name: "Matrix Author", roleTitle: "Editor", avatarUrl: null } }
  ),
  publicByState(
    "cms/pages:getSitemapIndex",
    (actor, fixture) =>
      actor.query(api.cms.pages.getSitemapIndex, {
        languageVersion: fixture.languageVersion,
      }),
    (state) => ({
      value: {
        manifestVersion: 0,
        locales: (state.language === "M05" ? ["en", "fr"] : ["en"]).map(
          (locale) => ({ locale, partitions: 1 })
        ),
      },
    })
  ),
  allActors(
    "cms/pages:getSitemapChild",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getSitemapChild, {
        languageVersion: fixture.languageVersion,
        manifestVersion: 0,
        locale: "en",
        ordinal: 0,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          status: "ok",
          entries: expect.any(Array),
        }),
    }
  ),
  allActors(
    "cms/pages:getBoundedPilotEnvelope",
    "query",
    (actor) => actor.query(api.cms.pages.getBoundedPilotEnvelope, {}),
    {
      check: (value) =>
        expect(value).toMatchObject({
          withinEnvelope: true,
          totalPagesBelowCap: true,
          publishedPagesBelowCap: true,
        }),
    }
  ),
  publicByState(
    "cms/pages:getLocalizedPathsByIds",
    (actor, fixture) =>
      actor.query(api.cms.pages.getLocalizedPathsByIds, {
        ids: [fixture.pageId],
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    () => ({
      check: (value) =>
        expect(Object.values(value as Record<string, string>)).toEqual([
          "/matrix-page",
        ]),
    })
  ),
  allActors(
    "cms/pages:getPublicRelationCardsByIds",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getPublicRelationCardsByIds, {
        ids: [fixture.pageId],
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    {
      check: (value) =>
        expect(Object.values(value as Record<string, unknown>)).toEqual([
          expect.objectContaining({
            title: "Matrix Page",
            href: "/matrix-page",
          }),
        ]),
    }
  ),
  allActors(
    "cms/pages:listRecentPublicRelationCards",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.listRecentPublicRelationCards, {
        pageType: "page",
        limit: 5,
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({
            title: "Matrix Page",
            href: "/matrix-page",
          }),
        ]),
    }
  ),
  allActors(
    "cms/pages:getLocalizedBreadcrumb",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getLocalizedBreadcrumb, {
        pageId: fixture.pageId,
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    { value: [{ name: "Matrix Page", url: "/matrix-page" }] }
  ),
  publicByState(
    "cms/pages:getPublicLocaleAlternates",
    (actor, fixture) =>
      actor.query(api.cms.pages.getPublicLocaleAlternates, {
        pageId: fixture.pageId,
        languageVersion: fixture.languageVersion,
      }),
    (state) => ({
      value:
        state.language === "M05"
          ? [
              { locale: "en", url: "/matrix-page", indexable: true },
              { locale: "fr", url: "/fr/matrix-page", indexable: true },
            ]
          : [{ locale: "en", url: "/matrix-page", indexable: true }],
    })
  ),
  allActors(
    "cms/pages:getPublicHomeLocaleAlternates",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getPublicHomeLocaleAlternates, {
        languageVersion: fixture.languageVersion,
      }),
    { value: [] }
  ),
  publicByState(
    "cms/pages:getAllLocalizedPageUrls",
    (actor, fixture) =>
      actor.query(api.cms.pages.getAllLocalizedPageUrls, {
        languageVersion: fixture.languageVersion,
      }),
    (state) => ({
      check: (value) => {
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ locale: "en", url: "/matrix-page" }),
          ])
        )
        expect(value).toHaveLength(state.language === "M05" ? 4 : 2)
      },
    })
  ),
  allActors(
    "cms/pages:resolveHistoricalPublishedPath",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.resolveHistoricalPublishedPath, {
        locale: "en",
        path: "/matrix-page",
        languageVersion: fixture.languageVersion,
      }),
    { value: { authority: "legacy" } }
  ),
  allActors(
    "cms/pages:resolveLocalizedPathQuery",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.resolveLocalizedPathQuery, {
        path: "/matrix-page",
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    { check: (value) => expect(value).toEqual(expect.any(String)) }
  ),
  allActors(
    "cms/menus:getWithResolvedLinks",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.menus.getWithResolvedLinks, {
        slug: "main",
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    { value: { slug: "main", nav: [] } }
  ),
  allActors(
    "cms/search:searchPublishedPages",
    "query",
    (actor, fixture) =>
      actor.query(optional.search.searchPublishedPages, {
        query: "Matrix",
        locale: "en",
        languageVersion: fixture.languageVersion,
      }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({ title: "Matrix Page" }),
        ]),
    }
  ),
  maskedRead(
    "cms/pages:getById",
    (actor, fixture) =>
      actor.query(api.cms.pages.getById, { id: fixture.pageId }),
    { check: (value) => expect(value).toMatchObject({ slug: "matrix-page" }) },
    null
  ),
  maskedRead(
    "cms/pages:getPublishedById",
    (actor, fixture) =>
      actor.query(api.cms.pages.getPublishedById, { id: fixture.pageId }),
    { check: (value) => expect(value).toMatchObject({ slug: "matrix-page" }) },
    null
  ),
  maskedRead(
    "cms/pages:getForEdit",
    (actor, fixture) =>
      actor.query(api.cms.pages.getForEdit, { id: fixture.pageId }),
    {
      check: (value) =>
        expect(value).toMatchObject({ page: { slug: "matrix-page" } }),
    },
    null
  ),
  maskedRead(
    "cms/pages:getBySlug",
    (actor) => actor.query(api.cms.pages.getBySlug, { slug: "matrix-page" }),
    { check: (value) => expect(value).toMatchObject({ slug: "matrix-page" }) },
    null
  ),
  maskedRead(
    "cms/pages:getByIds",
    (actor, fixture) =>
      actor.query(api.cms.pages.getByIds, { ids: [fixture.pageId] }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({ slug: "matrix-page" }),
        ]),
    },
    []
  ),
  maskedRead(
    "cms/pages:getBreadcrumb",
    (actor, fixture) =>
      actor.query(api.cms.pages.getBreadcrumb, { pageId: fixture.pageId }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({ title: "Matrix Page" }),
        ]),
    },
    []
  ),
  maskedRead(
    "cms/pages:getLocalizedPageUrls",
    (actor, fixture) =>
      actor.query(api.cms.pages.getLocalizedPageUrls, {
        pageId: fixture.pageId,
      }),
    { check: (value) => expect(value).toMatchObject({ en: "/matrix-page" }) },
    null
  ),
  ownerOnly(
    "cms/pages:getStagedPreviewById",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getStagedPreviewById, { id: fixture.pageId }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          page: { slug: "matrix-page" },
          hasStaging: false,
        }),
    }
  ),
  ownerOnly(
    "cms/pages:getPrePublishChecklist",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getPrePublishChecklist, {
        pageId: fixture.pageId,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          defaultLocale: "en",
          enabledLocales: expect.arrayContaining(["en"]),
          blockers: expect.any(Array),
          warnings: expect.any(Array),
        }),
    }
  ),
  ownerOnly(
    "cms/pages:listActiveEditors",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.listActiveEditors, { pageId: fixture.pageId }),
    { value: [] }
  ),
  ownerOnly(
    "cms/pages:getPageEditorLock",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getPageEditorLock, { pageId: fixture.pageId }),
    { value: { status: "available", lock: null, isMine: false } }
  ),
  ownerOnly(
    "cms/pages:isSlugAvailable",
    "query",
    (actor) =>
      actor.query(api.cms.pages.isSlugAvailable, { slug: "matrix-new" }),
    { value: { available: true, slug: "matrix-new" } }
  ),
  ownerOnly(
    "cms/pages:list",
    "query",
    (actor) => actor.query(api.cms.pages.list, {}),
    {
      check: (value) =>
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ slug: "matrix-page" }),
          ])
        ),
    }
  ),
  ownerOnly(
    "cms/pages:listSummaries",
    "query",
    (actor) => actor.query(api.cms.pages.listSummaries, {}),
    {
      check: (value) =>
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ slug: "matrix-page" }),
          ])
        ),
    }
  ),
  ownerOnly(
    "cms/pages:listPaginated",
    "query",
    (actor) =>
      actor.query(api.cms.pages.listPaginated, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          page: expect.arrayContaining([
            expect.objectContaining({ slug: "matrix-page" }),
          ]),
        }),
    }
  ),
  ownerOnly(
    "cms/pages:listLinkablePages",
    "query",
    (actor) => actor.query(api.cms.pages.listLinkablePages, { locale: "en" }),
    {
      check: (value) =>
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ slug: "matrix-page" }),
          ])
        ),
    }
  ),
  ownerOnly(
    "cms/pages:getLinkablePageSelection",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getLinkablePageSelection, {
        pageId: fixture.pageId,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          status: "available",
          page: { slug: "matrix-page" },
        }),
    }
  ),
  ownerOnly(
    "cms/pages:deleteImpact",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.deleteImpact, { id: fixture.pageId }),
    { value: { children: [], redirects: 0, menus: [] } }
  ),
  ownerOnly(
    "cms/pages:listByPageType",
    "query",
    (actor) => actor.query(api.cms.pages.listByPageType, { pageType: "page" }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({ slug: "matrix-page" }),
        ]),
    }
  ),
  ownerOnly(
    "cms/pages:listRelationCandidates",
    "query",
    (actor) =>
      actor.query(api.cms.pages.listRelationCandidates, {
        pageTypes: ["page"],
      }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({ slug: "matrix-page" }),
        ]),
    }
  ),
  ownerOnly(
    "cms/pages:getRelationCardsByIds",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.pages.getRelationCardsByIds, {
        ids: [fixture.pageId],
        locale: "en",
      }),
    {
      check: (value) =>
        expect(Object.values(value as Record<string, unknown>)).toEqual([
          expect.objectContaining({ title: "Matrix Page" }),
        ]),
    }
  ),
  ownerOnly(
    "cms/publication:getAdminAuthority",
    "query",
    (actor) => actor.query(api.cms.publication.getAdminAuthority, {}),
    { value: "legacy" }
  ),
  ownerOnly(
    "cms/pageHistory:listRevisions",
    "query",
    (actor, fixture) =>
      actor.query(optional.pageHistory.listRevisions, {
        pageId: fixture.pageId,
      }),
    { value: [] }
  ),
  ownerOnly(
    "cms/media:getById",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.media.getById, { id: fixture.mediaId }),
    {
      check: (value) => expect(value).toMatchObject({ filename: "matrix.png" }),
    }
  ),
  ownerOnly(
    "cms/media:getByName",
    "query",
    (actor) => actor.query(api.cms.media.getByName, { name: "matrix.png" }),
    {
      check: (value) => expect(value).toMatchObject({ filename: "matrix.png" }),
    }
  ),
  ownerOnly(
    "cms/media:list",
    "query",
    (actor) => actor.query(api.cms.media.list, {}),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({ filename: "matrix.png" }),
        ]),
    }
  ),
  ownerOnly(
    "cms/media:listPaginated",
    "query",
    (actor) =>
      actor.query(api.cms.media.listPaginated, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          page: [expect.objectContaining({ filename: "matrix.png" })],
        }),
    }
  ),
  ownerOnly(
    "cms/media:listFolders",
    "query",
    (actor) => actor.query(api.cms.media.listFolders, {}),
    { value: [] }
  ),
  ownerOnly(
    "cms/media:usage",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.media.usage, { id: fixture.mediaId }),
    { value: { settings: [], pages: [] } }
  ),
  ownerOnly(
    "cms/media:generateUploadUrl",
    "mutation",
    (actor) => actor.mutation(api.cms.media.generateUploadUrl, {}),
    {
      check: (value) =>
        expect(value).toEqual(expect.stringContaining("upload")),
    }
  ),
  allActors(
    "cms/media:getStorageUrls",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.media.getStorageUrls, {
        storageIds: [fixture.storageId],
      }),
    {
      check: (value) =>
        expect(Object.values(value as Record<string, string>)).toEqual([
          expect.stringContaining("storage"),
        ]),
    }
  ),
  ownerOnly(
    "cms/tags:list",
    "query",
    (actor) => actor.query(api.cms.tags.list, {}),
    {
      check: (value) =>
        expect(value).toEqual([expect.objectContaining({ slug: "matrix" })]),
    }
  ),
  ownerOnly(
    "cms/tags:rename",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.tags.rename, {
        id: fixture.tagId,
        label: "Renamed",
      }),
    { value: null }
  ),
  ownerOnly(
    "cms/contentTypes:getContentTypeUsage",
    "query",
    (actor) => actor.query(api.cms.contentTypes.getContentTypeUsage, {}),
    {
      check: (value) =>
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ type: "page", count: 1 }),
          ])
        ),
    }
  ),
  ownerOnly(
    "cms/contentTypes:getArchivedContentTypes",
    "query",
    (actor) => actor.query(api.cms.contentTypes.getArchivedContentTypes, {}),
    { value: [] }
  ),
  ownerOnly(
    "cms/contentTypes:setContentTypeArchived",
    "mutation",
    (actor) =>
      actor.mutation(api.cms.contentTypes.setContentTypeArchived, {
        type: "page",
        archived: true,
      }),
    { value: ["page"] }
  ),
  ownerOnly(
    "cms/slices:getPresentationCatalog",
    "query",
    (actor) => actor.query(api.cms.slices.getPresentationCatalog, {}),
    {
      check: (value) =>
        expect(value).toMatchObject({
          version: "slice-presentations-v1",
          revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          installedTypes: expect.arrayContaining(["hero-with-image"]),
          entries: expect.arrayContaining([
            expect.objectContaining({ type: "hero-with-image", id: "default" }),
          ]),
        }),
    }
  ),
  ownerOnly(
    "cms/slices:setPresentationArchived",
    "mutation",
    async (actor) =>
      actor.mutation(api.cms.slices.setPresentationArchived, {
        type: "hero-with-image",
        presentationId: "centered",
        archived: true,
        expectedCatalogRevision: (await readSlicePresentationCatalog())
          .revision,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          entries: expect.arrayContaining([
            expect.objectContaining({
              type: "hero-with-image",
              id: "centered",
              state: "archived",
            }),
          ]),
        }),
    },
    async (t, state) => {
      const fixture = await setupContent(t, state)
      await t.run(async (ctx) => {
        const settings = await ctx.db.query("siteSettings").unique()
        if (!settings) throw new Error("Matrix settings fixture missing")
        await ctx.db.patch(settings._id, { onboardingCompletedAt: 1 })
      })
      return fixture
    },
    async (t) => {
      const membership = await t.run(
        async (ctx) =>
          (await ctx.db.query("siteSettings").unique())
            ?.archivedSlicePresentationsV1
      )
      expect(membership).toEqual([
        { type: "hero-with-image", presentationId: "centered" },
      ])
    }
  ),
  ownerOnly(
    "cms/slices:getSliceAuthoringState",
    "query",
    (actor) => actor.query(api.cms.slices.getSliceAuthoringState, {}),
    {
      check: (value) =>
        expect(value).toMatchObject({
          settingsId: expect.any(String),
          contracts: expect.any(String),
          archivedTypes: [],
          registeredTypes: expect.arrayContaining(["hero-with-image"]),
          installedTypes: expect.arrayContaining(["hero-with-image"]),
        }),
    }
  ),
  ownerOnly(
    "cms/slices:getArchivedSliceTypes",
    "query",
    (actor) => actor.query(api.cms.slices.getArchivedSliceTypes, {}),
    { value: [] }
  ),
  ownerOnly(
    "cms/sliceLibrary:setSliceArchived",
    "mutation",
    (actor) =>
      actor.mutation(optional.sliceLibrary.setSliceArchived, {
        type: "hero-agency",
        archived: true,
      }),
    { check: (value) => expect(value).toEqual(["hero-agency"]) }
  ),
  ownerOnly(
    "cms/sliceLibrary:cleanupDeletedSliceTypeArchive",
    "mutation",
    (actor) =>
      actor.mutation(optional.sliceLibrary.cleanupDeletedSliceTypeArchive, {
        type: "retired",
      }),
    { value: [] }
  ),
  ownerOnly(
    "cms/sliceLibrary:getSliceUsageSummary",
    "query",
    (actor) =>
      actor.query(optional.sliceLibrary.getSliceUsageSummary, {
        type: "hero-agency",
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ pageCount: 0, usageCount: 0 }),
    }
  ),
  ownerOnly(
    "cms/relations:searchTargets",
    "query",
    (actor) =>
      actor.query(api.cms.relations.searchTargets, {
        pageTypes: ["page"],
        locale: "en",
      }),
    {
      check: (value) =>
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ title: "Matrix Page" }),
          ])
        ),
    }
  ),
  ownerOnly(
    "cms/relations:getReferenceCard",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.relations.getReferenceCard, {
        id: fixture.pageId,
        locale: "en",
      }),
    { check: (value) => expect(value).toMatchObject({ title: "Matrix Page" }) }
  ),
  ownerOnly(
    "cms/search:searchPages",
    "query",
    (actor) => actor.query(optional.search.searchPages, { query: "Matrix" }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({ slug: "matrix-page" }),
        ]),
    }
  ),
  ownerOnly(
    "cms/search:searchMedia",
    "query",
    (actor) => actor.query(optional.search.searchMedia, { query: "matrix" }),
    {
      check: (value) =>
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ filename: "matrix.png" }),
          ])
        ),
    }
  ),
  ownerOnly(
    "cms/menus:getCanonical",
    "query",
    (actor) => actor.query(api.cms.menus.getCanonical, { slug: "main" }),
    { value: { slug: "main", nav: [], updatedAt: 1 } }
  ),
  ownerOnly(
    "cms/menus:countMenuTextMissing",
    "query",
    (actor) =>
      actor.query(api.cms.menus.countMenuTextMissing, { locales: ["en"] }),
    { value: { en: 0 } }
  ),
  ownerOnly(
    "cms/menus:listSlugs",
    "query",
    (actor) => actor.query(api.cms.menus.listSlugs, {}),
    { value: ["main"] }
  ),
  ownerOnly(
    "cms/menus:saveCanonical",
    "mutation",
    (actor) =>
      actor.mutation(api.cms.menus.saveCanonical, {
        slug: "main",
        locale: "en",
        nav: [],
      }),
    {
      check: (value) =>
        expect(value).toEqual({
          id: expect.any(String),
          updatedAt: expect.any(Number),
        }),
    }
  ),
  ownerOnly(
    "cms/menus:createCanonical",
    "mutation",
    (actor) =>
      actor.mutation(api.cms.menus.createCanonical, { slug: "footer" }),
    { check: (value) => expect(value).toEqual(expect.any(String)) }
  ),
  ownerOnly(
    "cms/menus:softDelete",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.menus.softDelete, { id: fixture.menuId }),
    { value: null }
  ),
  ownerOnly(
    "cms/menus:remove",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.menus.remove, { id: fixture.menuId }),
    { value: null }
  ),
  ownerOnly(
    "cms/formSubmissions:listForAdmin",
    "query",
    (actor) => actor.query(optional.formSubmissions.listForAdmin, {}),
    {
      check: (value) =>
        expect(value).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              payload: expect.objectContaining({ name: "Matrix" }),
            }),
          ])
        ),
    }
  ),
  ownerOnly(
    "cms/formSubmissions:listForAdminPaginated",
    "query",
    (actor) =>
      actor.query(optional.formSubmissions.listForAdminPaginated, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          page: [
            expect.objectContaining({
              payload: expect.objectContaining({ name: "Matrix" }),
            }),
          ],
        }),
    }
  ),
  ownerOnly(
    "cms/formSubmissions:getForAdmin",
    "query",
    (actor, fixture) =>
      actor.query(optional.formSubmissions.getForAdmin, {
        id: fixture.submissionId,
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({ payload: { name: "Matrix" } }),
    }
  ),
  ownerOnly(
    "cms/formSubmissions:markRead",
    "mutation",
    (actor, fixture) =>
      actor.mutation(optional.formSubmissions.markRead, {
        id: fixture.submissionId,
        read: true,
      }),
    { value: null }
  ),
  ownerOnly(
    "cms/formSubmissions:getCounts",
    "query",
    (actor) => actor.query(optional.formSubmissions.getCounts, {}),
    { value: { total: 1, unread: 1, failed: 0 } }
  ),
]

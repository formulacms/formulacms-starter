import { isActiveContentType } from "../../convex/lib/contentTypes"
import { expect, vi } from "vitest"
import rateLimiterTest from "@convex-dev/rate-limiter/test"
import { makeFunctionReference } from "convex/server"
import { api } from "../../convex/_generated/api"
import { finishMediaUsageBackfill } from "../media-usage-backfill"
import type { Id } from "../../convex/_generated/dataModel"
import { readBlockPresentationCatalog } from "../../convex/lib/blocks/presentations"
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
  blockLibrary: {
    setBlockArchived: makeFunctionReference<"mutation">(
      "cms/blockLibrary:setBlockArchived"
    ),
    cleanupDeletedBlockTypeArchive: makeFunctionReference<"mutation">(
      "cms/blockLibrary:cleanupDeletedBlockTypeArchive"
    ),
    assertBlockTypeRetirementAllowed: makeFunctionReference<"query">(
      "cms/blockLibrary:assertBlockTypeRetirementAllowed"
    ),
    getBlockUsageSummary: makeFunctionReference<"query">(
      "cms/blockLibrary:getBlockUsageSummary"
    ),
    getBlockPresentationUsageSummary: makeFunctionReference<"query">(
      "cms/blockLibrary:getBlockPresentationUsageSummary"
    ),
  },
}

type ContentFixture = {
  pageId: Id<"pages">
  authorId: Id<"pages"> | null
  mediaId: Id<"media">
  storageId: Id<"_storage">
  menuId: Id<"menus">
  tagId: Id<"tags">
  submissionId: Id<"formSubmissions">
  languageVersion: number
}

async function setupContent(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const { languageVersion } = await setupModuleLanguageState(t, state)
  return seedContentDocuments(
    t,
    languageVersion,
    state.language === "M05" ? ["en", "fr"] : ["en"]
  )
}

/** One published Page and, when active, one published Author, created and published by the
 * owner commands, so every reader sees the rows a real site holds. */
async function seedPublishedContentPages(
  t: Site,
  locales: readonly ("en" | "fr")[]
): Promise<{ pageId: Id<"pages">; authorId: Id<"pages"> | null }> {
  const owner = t.withIdentity(OWNER)
  // Publishing needs the site's Home page. It stays a draft here.
  const homePageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", blocks: [] } },
  })
  await t.run(async (ctx) => {
    const settings = await ctx.db.query("siteSettings").unique()
    await ctx.db.patch(settings!._id, { homePageId })
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "page",
    status: "draft",
    slug: "matrix-page",
    title: "Matrix Page",
    content: {
      en: { title: "Matrix Page", blocks: [] },
      ...(locales.includes("fr")
        ? { fr: { title: "Page matrice", blocks: [] } }
        : {}),
    },
  })
  let authorId: Id<"pages"> | null = null
  if (isActiveContentType("author")) {
    authorId = await owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      slug: "matrix-author",
      title: "Matrix Author",
      name: "Matrix Author",
      content: {
        en: { title: "Matrix Author", blocks: [] },
        ...(locales.includes("fr")
          ? { fr: { title: "Auteur matrice", blocks: [] } }
          : {}),
      },
    })
    // The Author's role title is a language field the create command does not take.
    for (const locale of locales) {
      await owner.mutation(api.cms.publication.saveLocaleDraft, {
        pageId: authorId,
        locale,
        slug: "matrix-author",
        draft: {
          pageType: "author",
          localized: {
            title: locale === "fr" ? "Auteur matrice" : "Matrix Author",
            roleTitle: locale === "fr" ? "Rédacteur" : "Editor",
          },
          blocks: [],
        },
        expectedDraftGeneration: 1,
        expectedLifecycleGeneration: 1,
      })
    }
  }
  for (const id of authorId ? [pageId, authorId] : [pageId]) {
    for (const locale of locales) {
      await owner.mutation(api.cms.publication.publishLocale, {
        pageId: id,
        locale,
        expectedDraftGeneration: id === authorId ? 2 : 1,
        expectedSharedDraftGeneration: 1,
        expectedPublicGeneration: 0,
        expectedLifecycleGeneration: 1,
        expectedReleaseGeneration: 0,
      })
    }
  }
  return { pageId, authorId }
}

async function seedContentDocuments(
  t: Site,
  languageVersion: number,
  locales: readonly ("en" | "fr")[]
): Promise<ContentFixture> {
  const { pageId, authorId } = await seedPublishedContentPages(t, locales)
  const seeded = await t.run(async (ctx) => {
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
    return { mediaId, storageId, menuId, tagId, submissionId }
  })
  return { pageId, authorId, ...seeded, languageVersion }
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

/** A trashed, unused file with the rich-text usage backfill finished. */
async function setupPurgeableMedia(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupDeletedMedia(t, state)
  await finishMediaUsageBackfill(t as never)
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

async function setupMeasuredMedia(
  t: Site,
  state: MatrixState
): Promise<ContentFixture> {
  const fixture = await setupContent(t, state)
  await t.run((ctx) => ctx.db.patch(fixture.mediaId, { width: 1, height: 1 }))
  return fixture
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
    content: { en: { title: "Home", blocks: [] } },
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
      en: { title: "Snapshot Matrix", blocks: [] },
      fr: { title: "Matrice", blocks: [] },
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

async function setupSuccessorTrashedDrained(
  t: Site,
  redirects: "off" | "on"
): Promise<SuccessorFixture> {
  const fixture = await setupSuccessorTrashed(t, redirects)
  // The revalidation drain is a cron the matrix does not run.
  await t.run(async (ctx) => {
    for (const row of await ctx.db
      .query("pagePublicationRevalidationIntents")
      .collect())
      await ctx.db.patch("pagePublicationRevalidationIntents", row._id, {
        status: "complete",
        phase: "complete",
      })
  })
  return fixture
}

const successorOnly = (
  name: string,
  kind: FunctionKind,
  call: (actor: CallTarget, fixture: SuccessorFixture) => Promise<unknown>,
  owner: Outcome,
  setup: (
    t: Site,
    redirects: "off" | "on"
  ) => Promise<SuccessorFixture> = setupSuccessorPage
): AuthorizationRow =>
  defineRow({
    name,
    kind,
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setup(t, state.redirects),
      call,
      outcomes: {
        owner,
        signedOut: { error: "UNAUTHENTICATED" },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      readOnly: kind === "query",
    })),
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
    ],
  })

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

export const contentRows: AuthorizationRow[] = [
  ownerOnly(
    "cms/blockLibrary:getBlockPresentationUsageSummary",
    "query",
    (actor) =>
      actor.query(optional.blockLibrary.getBlockPresentationUsageSummary, {
        type: "hero-with-image",
        presentationIds: ["centered"],
      }),
    { value: { status: "unavailable" } }
  ),
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
    setupSuccessorPublished
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
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupSuccessorSession(t, state.redirects),
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
  }),
  defineRow({
    name: "cms/preview:resolvePreviewPath",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupSuccessorSession(t, state.redirects),
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
    setupSuccessorPage
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
    setupSuccessorPage
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
          blocks: [],
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
            blocks: [],
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
    setupSuccessorPublished
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
    setupSuccessorPage
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
  successorOnly(
    "cms/publication:pagePurgeImpact",
    "query",
    (actor, fixture) =>
      actor.query(api.cms.publication.pagePurgeImpact, {
        pageIds: [fixture.pageId],
      }),
    {
      check: (value) =>
        expect(value).toEqual([
          { pageId: expect.any(String), canPurge: true, redirects: 0 },
        ]),
    },
    setupSuccessorTrashedDrained
  ),
  successorOnly(
    "cms/publication:purgeTrashedPages",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.publication.purgeTrashedPages, {
        items: [{ pageId: fixture.pageId, expectedLifecycleGeneration: 2 }],
      }),
    {
      check: (value) =>
        expect(value).toEqual([
          { pageId: expect.any(String), status: "started" },
        ]),
    },
    setupSuccessorTrashedDrained
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
  defineRow({
    name: "cms/pages:leavePagePresence",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupContent(t, state),
      call: (actor: CallTarget, fixture: ContentFixture) =>
        actor.mutation(api.cms.pages.leavePagePresence, { pageId: fixture.pageId }),
      outcomes: {
        owner: { value: null },
        // Late editor teardown acknowledges an ended session without writes.
        signedOut: { value: null },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      // This fixture has no leases. Even successful no-ops must preserve all
      // writable tables; the pages seam tests separately prove own-row removal.
      readOnly: true,
    })),
  }),
  ownerOnly(
    "cms/pages:acquirePageEditorLock",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.pages.acquirePageEditorLock, {
        pageId: fixture.pageId,
      }),
    { check: (value) => expect(value).toMatchObject({ status: "acquired" }) }
  ),
  defineRow({
    name: "cms/pages:releasePageEditorLock",
    kind: "mutation",
    scenarios: MATRIX_STATES.map((state) => ({
      label: stateLabel(state),
      setup: (t: Site) => setupContent(t, state),
      call: (actor: CallTarget, fixture: ContentFixture) =>
        actor.mutation(api.cms.pages.releasePageEditorLock, { pageId: fixture.pageId }),
      outcomes: {
        owner: { value: null },
        // Late editor teardown acknowledges an ended session without writes.
        signedOut: { value: null },
        unrelated: { error: "CMS_OWNER_REQUIRED" },
        former: { error: "CMS_OWNER_REQUIRED" },
      },
      // This fixture has no leases. Even successful no-ops must preserve all
      // writable tables; the pages seam tests separately prove own-row removal.
      readOnly: true,
    })),
  }),
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
    setupPurgeableMedia,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.mediaId))).toBeNull()
    }
  ),
  ownerOnly(
    "cms/media:purgeTrashedMedia",
    "mutation",
    (actor, fixture) =>
      actor.mutation(api.cms.media.purgeTrashedMedia, {
        ids: [fixture.mediaId],
      }),
    {
      check: (value) =>
        expect(value).toEqual([
          expect.objectContaining({ status: "purged" }),
        ]),
    },
    setupPurgeableMedia,
    async (t, fixture) => {
      expect(await t.run((ctx) => ctx.db.get(fixture.mediaId))).toBeNull()
    }
  ),
  ownerOnly(
    "cms/media:listTrashed",
    "query",
    (actor) =>
      actor.query(api.cms.media.listTrashed, {
        paginationOpts: { numItems: 10, cursor: null },
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          page: [expect.objectContaining({ filename: "matrix.png" })],
        }),
    },
    setupDeletedMedia
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
    "cms/blockLibrary:assertBlockTypeRetirementAllowed",
    "query",
    (actor) =>
      actor.query(optional.blockLibrary.assertBlockTypeRetirementAllowed, {
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
    (actor, fixture) => {
      if (!fixture.authorId) throw new Error("Author fixture requires an active Author type")
      return actor.query(api.cms.pages.getPublicByline, {
        authorPageId: fixture.authorId,
        locale: "en",
        languageVersion: fixture.languageVersion,
      })
    },
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
        expect(value).toHaveLength(
          (isActiveContentType("author") ? 2 : 1) * (state.language === "M05" ? 2 : 1)
        )
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
    {
      check: (value) =>
        expect(value).toMatchObject({
          authority: "snapshot_active",
          disposition: "current",
          locale: "en",
        }),
    }
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
    // The published search reads rows only on the old publication path.
    { value: [] }
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
    // This reader resolves cards from the retained Pages rows, which hold no
    // published content on the snapshot path, so the owner's card is null.
    {
      check: (value) =>
        expect(Object.values(value as Record<string, unknown>)).toEqual([null]),
    }
  ),
  ownerOnly(
    "cms/publication:getAdminAuthority",
    "query",
    (actor) => actor.query(api.cms.publication.getAdminAuthority, {}),
    { value: "snapshot_active" }
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
    "cms/contentTypes:getUntranslatedContentTypes",
    "query",
    (actor) =>
      actor.query(api.cms.contentTypes.getUntranslatedContentTypes, {}),
    { value: [] }
  ),
  ownerOnly(
    "cms/contentTypes:setContentTypeTranslation",
    "mutation",
    (actor) =>
      actor.mutation(api.cms.contentTypes.setContentTypeTranslation, {
        pageType: "page",
        translated: true,
      }),
    { value: [] }
  ),
  ownerOnly(
    "cms/contentTypes:getContentTypeTranslationImpact",
    "query",
    (actor) =>
      actor.query(api.cms.contentTypes.getContentTypeTranslationImpact, {
        pageType: "page",
      }),
    {
      check: (value) =>
        expect(value).toMatchObject({
          hiddenVersions: { count: expect.any(Number) },
          linkingPages: { count: expect.any(Number) },
          childPages: { count: expect.any(Number) },
        }),
    }
  ),
  ownerOnly(
    "cms/blocks:getPresentationCatalog",
    "query",
    (actor) => actor.query(api.cms.blocks.getPresentationCatalog, {}),
    {
      check: (value) =>
        expect(value).toMatchObject({
          version: "block-presentations-v1",
          revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
          installedTypes: expect.arrayContaining(["hero-with-image"]),
          entries: expect.arrayContaining([
            expect.objectContaining({ type: "hero-with-image", id: "default" }),
          ]),
        }),
    }
  ),
  ownerOnly(
    "cms/blocks:setPresentationArchived",
    "mutation",
    async (actor) =>
      actor.mutation(api.cms.blocks.setPresentationArchived, {
        type: "hero-with-image",
        presentationId: "centered",
        archived: true,
        expectedCatalogRevision: (await readBlockPresentationCatalog())
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
            ?.archivedBlockPresentationsV1
      )
      expect(membership).toEqual([
        { type: "hero-with-image", presentationId: "centered" },
      ])
    }
  ),
  ownerOnly(
    "cms/blocks:getBlockAuthoringState",
    "query",
    (actor) => actor.query(api.cms.blocks.getBlockAuthoringState, {}),
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
    "cms/blocks:getArchivedBlockTypes",
    "query",
    (actor) => actor.query(api.cms.blocks.getArchivedBlockTypes, {}),
    { value: [] }
  ),
  ownerOnly(
    "cms/blockLibrary:setBlockArchived",
    "mutation",
    (actor) =>
      actor.mutation(optional.blockLibrary.setBlockArchived, {
        type: "hero-agency",
        archived: true,
      }),
    { check: (value) => expect(value).toEqual(["hero-agency"]) }
  ),
  ownerOnly(
    "cms/blockLibrary:cleanupDeletedBlockTypeArchive",
    "mutation",
    (actor) =>
      actor.mutation(optional.blockLibrary.cleanupDeletedBlockTypeArchive, {
        type: "retired",
      }),
    { value: [] }
  ),
  ownerOnly(
    "cms/blockLibrary:getBlockUsageSummary",
    "query",
    (actor) =>
      actor.query(optional.blockLibrary.getBlockUsageSummary, {
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
    // The admin search reads rows only on the old publication path.
    { value: [] }
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

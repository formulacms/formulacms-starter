/// <reference types="vite/client" />

import { sliceProfile } from "@/test-utils/slice-profile"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { readFileSync } from "node:fs"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { enableRedirectsForTest } from "../redirectsTestHelpers"
import schema from "./schema"
import { heroWithImageDef } from "./lib/slices/heroWithImage"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "f08a-corrective-owner",
  tokenIdentifier: "https://convex.test|f08a-corrective-owner",
}

const bodySlice = (id: string, text: string) => ({
  id,
  type: "rich-text-body" as const,
  enabled: true,
  primary: {
    body: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    }),
  },
})

function app() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
    publicationAuthority: "missing",
  })
}

async function activeFixture() {
  const t = app()
  const owner = t.withIdentity(OWNER)
  await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
  const homeId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "home",
    title: "Home",
    content: { en: { title: "Home", slices: [] } },
  })
  const pageId = await owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug: "café",
    title: "Café",
    content: {
      en: { title: "Café ☕", slices: [] },
      fr: { title: "Café français", slices: [] },
    },
  })
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "Corrective",
      siteUrl: "",
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      homePageId: homeId,
      updatedAt: Date.now(),
    })
  })
  return { t, owner, pageId, homeId }
}

async function publishEn(
  owner: ReturnType<ReturnType<typeof convexTest>["withIdentity"]>,
  pageId: Id<"pages">,
  expectedSharedDraftGeneration = 1
) {
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: 1,
    expectedSharedDraftGeneration,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 0,
  })
}

describe("F08a corrective authority and ownership proof", () => {
  test.each(["mediaId", "storageId"] as const)(
    "primary link by %s survives editor saves, publication and clearing the draft",
    sliceProfile(["hero-with-image"]),
    async (identity) => {
      const { t, owner, pageId } = await activeFixture()
      const media = await t.run(async (ctx) => {
        const storageId = await ctx.storage.store(new Blob(["retained bytes"]))
        const mediaId = await ctx.db.insert("media", {
          filename: "download.pdf",
          storageId,
          url: "https://example.test/download.pdf",
          size: 14,
          mimeType: "application/pdf",
          uploadedAt: Date.now(),
        })
        return { mediaId, storageId }
      })
      const slice = {
        id: "primary-download",
        type: "hero-with-image" as const,
        enabled: true,
        primary: {
          ...heroWithImageDef.preview.primary,
          eyebrowLink: { type: "media" as const, [identity]: media[identity] },
        },
        items: [],
      }
      const save = (generation: number, slices: (typeof slice)[]) =>
        owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId,
          expectedLifecycleGeneration: 1,
          localized: {
            locale: "en",
            slug: "download",
            expectedGeneration: generation,
            draft: {
              pageType: "landing-page",
              localized: { title: "Download" },
              slices,
            },
          },
        })
      const refs = () =>
        t.run((ctx) =>
          ctx.db
            .query("pagePublicationMediaReferences")
            .withIndex("by_mediaId", (q) => q.eq("mediaId", media.mediaId))
            .take(20)
        )
      const draft = (locale: string) =>
        t.run((ctx) =>
          ctx.db
            .query("pageLocaleDrafts")
            .withIndex("by_pageId_and_locale", (q) =>
              q.eq("pageId", pageId).eq("locale", locale)
            )
            .unique()
        )
      const frenchBefore = await draft("fr")
      await save(1, [slice])
      expect(await refs()).toEqual([
        expect.objectContaining({
          sourceKind: "locale_draft",
          locale: "en",
          mediaId: media.mediaId,
          storageId: media.storageId,
          sourcePath: "content.en.slices[0].primary.eyebrowLink",
        }),
      ])
      const saved = await draft("en")
      await save(2, [slice])
      expect(saved).toMatchObject({ content: { slices: [slice] } })
      expect((await draft("en"))?.content).toEqual(saved?.content)
      expect(await refs()).toHaveLength(1)
      expect(await draft("fr")).toEqual(frenchBefore)
      await expect(
        owner.mutation(api.cms.media.softDelete, { id: media.mediaId })
      ).rejects.toThrow("MEDIA_SOFT_DELETE_REFERENCED")
      await expect(
        owner.mutation(api.cms.media.remove, { id: media.mediaId })
      ).rejects.toThrow("retained")

      const published = await owner.mutation(
        api.cms.publication.publishLocale,
        {
          pageId,
          locale: "en",
          expectedDraftGeneration: 3,
          expectedSharedDraftGeneration: 1,
          expectedPublicGeneration: 0,
          expectedLifecycleGeneration: 1,
          expectedReleaseGeneration: 0,
        }
      )
      expect(await refs()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            sourceKind: "candidate",
            sourceId: published.candidateId,
          }),
          expect.objectContaining({
            sourceKind: "current_public",
            sourceId: published.snapshotId,
          }),
        ])
      )
      const snapshot = await t.run((ctx) => ctx.db.get(published.snapshotId))
      await save(3, [])
      expect(
        (await refs()).some((ref) => ref.sourceKind === "locale_draft")
      ).toBe(false)
      expect(
        await t.run((ctx) =>
          ctx.db.get("pagePublishedSnapshots", published.snapshotId)
        )
      ).toEqual(snapshot)
      await expect(
        owner.mutation(api.cms.media.softDelete, { id: media.mediaId })
      ).rejects.toThrow("MEDIA_SOFT_DELETE_REFERENCED")
      await expect(
        owner.mutation(api.cms.media.remove, { id: media.mediaId })
      ).rejects.toThrow("retained")
      expect(
        await t.run(async (ctx) =>
          (await ctx.storage.get(media.storageId))?.text()
        )
      ).toBe("retained bytes")
      expect(
        (await t.run((ctx) => ctx.db.get("media", media.mediaId)))?.deletedAt
      ).toBeUndefined()

      // A primary link must also enter publication's validate-before-write seam.
      const brokenMediaId = await t.run(async (ctx) => {
        const storageId = await ctx.storage.store(new Blob(["missing"]))
        const mediaId = await ctx.db.insert("media", {
          filename: "missing.pdf",
          storageId,
          url: "https://example.test/missing.pdf",
          size: 7,
          mimeType: "application/pdf",
          uploadedAt: Date.now(),
        })
        await ctx.storage.delete(storageId)
        return mediaId
      })
      const beforeRefusal = await draft("en")
      const refsBeforeRefusal = await refs()
      await expect(
        save(4, [
          {
            ...slice,
            primary: {
              ...slice.primary,
              eyebrowLink: { type: "media", mediaId: brokenMediaId },
            },
          },
        ])
      ).rejects.toThrow("PUBLICATION_MEDIA_STORAGE_MISSING")
      expect(await draft("en")).toEqual(beforeRefusal)
      expect(await refs()).toEqual(refsBeforeRefusal)
      expect(
        await t.run((ctx) =>
          ctx.db.get("pagePublishedSnapshots", published.snapshotId)
        )
      ).toEqual(snapshot)
      expect(await draft("fr")).toEqual(frenchBefore)
    }
  )

  test("real Next.js onboarding and editor consumers call successor commands", () => {
    const setup = readFileSync(
      new URL("../components/setup/setup-wizard.tsx", import.meta.url),
      "utf8"
    )
    const editor = readFileSync(
      new URL("../components/admin/page-editor.tsx", import.meta.url),
      "utf8"
    )
    const route = readFileSync(
      new URL(
        "../app/(core)/admin/(authenticated)/pages/[id]/page.tsx",
        import.meta.url
      ),
      "utf8"
    )
    const pagesList = readFileSync(
      new URL("../components/admin/pages-list-client.tsx", import.meta.url),
      "utf8"
    )
    const archive = readFileSync(
      new URL("../components/admin/archive-list.tsx", import.meta.url),
      "utf8"
    )
    const trash = readFileSync(
      new URL("../components/admin/trash-list.tsx", import.meta.url),
      "utf8"
    )
    const redirects = readFileSync(
      new URL(
        "../app/(core)/admin/(authenticated)/redirects/redirects-manager.tsx",
        import.meta.url
      ),
      "utf8"
    )
    expect(setup).toContain("api.cms.settings.bootstrapInstallation")
    expect(setup).toContain("bootstrapInstallation({")
    for (const command of [
      "saveEditorDraft",
      "publishLocale",
      "discardLocaleDraft",
      "withdrawLocale",
      "archivePage",
      "restorePage",
      "softDeletePage",
    ]) {
      expect(editor).toContain(`api.cms.publication.${command}`)
    }
    expect(route).toContain("publication={view.publication}")
    expect(pagesList).toContain("api.cms.publication.listAdminPages")
    expect(pagesList).toContain('publicationAuthority === "legacy"')
    expect(archive).toContain("api.cms.publication.listAdminPages")
    expect(archive).toContain("api.cms.publication.restorePage")
    expect(trash).toContain("api.cms.publication.listAdminPages")
    expect(trash).toContain("api.cms.publication.restoreSoftDeletedPage")
    expect(redirects).toContain("api.cms.pages.listSummaries")
    expect(redirects).toContain("api.cms.pages.getAllLocalizedPageUrls")
    expect(redirects).not.toContain("api.cms.pages.list(")
  })

  test("clean bootstrap reaches onboarding authoring and explicit home publication", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Successor site",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const configured = await t.query(api.cms.settings.getSiteConfig, {})
    expect(configured.homePageId).not.toBeNull()
    const homeId = configured.homePageId!
    expect(await t.run((ctx) => ctx.db.get(homeId))).toMatchObject({
      status: "draft",
      pageType: "landing-page",
      slug: "home",
    })
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", homeId).eq("locale", "en")
          )
          .unique()
      )
    ).toMatchObject({ generation: 1, content: { title: "Successor site" } })
    const published = await publishEn(owner, homeId)
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 1,
        id: homeId,
        locale: "en",
      })
    ).toMatchObject({
      _id: homeId,
      content: { en: { title: "Successor site" } },
    })
    expect(
      await t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 1,
        path: "/",
        locale: "en",
      })
    ).toBe(homeId)
    expect(published.publicGeneration).toBe(1)
    await expect(
      owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "published",
        title: "Bypass",
      })
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_USE_PUBLISH_LOCALE")
    await expect(
      owner.mutation(api.cms.pages.update, {
        id: homeId,
        title: "Legacy mutation",
      })
    ).rejects.toThrow("LEGACY_PUBLICATION_WRITER_DISABLED")
    await expect(
      owner.mutation(api.cms.pages.updateDraft, {
        pageId: homeId,
      })
    ).rejects.toThrow("LEGACY_PUBLICATION_WRITER_DISABLED")
    await expect(
      owner.mutation(api.cms.pages.publish, {
        pageId: homeId,
      })
    ).rejects.toThrow("LEGACY_PUBLICATION_WRITER_DISABLED")
    await expect(
      owner.mutation(api.cms.pages.duplicate, {
        id: homeId,
        title: "Legacy duplicate",
      })
    ).rejects.toThrow("LEGACY_PUBLICATION_WRITER_DISABLED")
  })

  test("bootstrap is owner-only, atomic, exactly idempotent, and disables the deferred wizard", async () => {
    const unauthorized = app()
    await expect(
      unauthorized.mutation(api.cms.settings.bootstrapInstallation, {
        siteName: "No owner",
        timezone: "UTC",
        defaultLocale: "en",
      })
    ).rejects.toThrow("UNAUTHENTICATED")
    expect(
      await unauthorized.run(async (ctx) => ({
        cutover: await ctx.db.query("pagePublicationCutover").collect(),
        pages: await ctx.db.query("pages").collect(),
        settings: await ctx.db.query("siteSettings").collect(),
      }))
    ).toEqual({ cutover: [], pages: [], settings: [] })

    const retained = app()
    const retainedOwner = retained.withIdentity(OWNER)
    await retained.run((ctx) =>
      ctx.db.insert("menus", {
        slug: "primary",
        nav: [],
        updatedAt: Date.now(),
      })
    )
    await expect(
      retainedOwner.mutation(api.cms.settings.bootstrapInstallation, {
        siteName: "Retained",
        timezone: "UTC",
        defaultLocale: "fr",
      })
    ).rejects.toThrow("INSTALLATION_BOOTSTRAP_REQUIRES_EMPTY_SETUP")
    expect(
      await retained.run(async (ctx) => ({
        cutover: await ctx.db.query("pagePublicationCutover").collect(),
        pages: await ctx.db.query("pages").collect(),
        menuCount: (await ctx.db.query("menus").collect()).length,
      }))
    ).toEqual({ cutover: [], pages: [], menuCount: 1 })

    const duplicateSettings = app()
    const duplicateSettingsOwner = duplicateSettings.withIdentity(OWNER)
    await duplicateSettings.run(async (ctx) => {
      for (const siteName of ["First", "Second"]) {
        await ctx.db.insert("siteSettings", {
          siteName,
          siteUrl: "",
          defaultLocale: "en",
          enabledLocales: ["en"],
          updatedAt: Date.now(),
        })
      }
    })
    await expect(
      duplicateSettingsOwner.mutation(api.cms.settings.bootstrapInstallation, {
        siteName: "Duplicate",
        timezone: "UTC",
        defaultLocale: "en",
      })
    ).rejects.toThrow("INSTALLATION_BOOTSTRAP_STATE_INVALID")
    expect(
      await duplicateSettings.run(async (ctx) => ({
        cutover: await ctx.db.query("pagePublicationCutover").collect(),
        pages: await ctx.db.query("pages").collect(),
      }))
    ).toEqual({ cutover: [], pages: [] })

    const t = app()
    const owner = t.withIdentity(OWNER)
    const first = await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Atomic site",
      siteUrl: "https://example.test/",
      timezone: "America/Toronto",
      defaultLocale: "fr",
    })
    const retry = await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Atomic site",
      siteUrl: "https://example.test/",
      timezone: "America/Toronto",
      defaultLocale: "fr",
    })
    expect(retry).toEqual(first)
    expect(
      await t.run(async (ctx) => ({
        cutovers: (await ctx.db.query("pagePublicationCutover").collect())
          .length,
        pages: (await ctx.db.query("pages").collect()).length,
        pageStates: (await ctx.db.query("pagePublicationPageStates").collect())
          .length,
        sharedDrafts: (await ctx.db.query("pageSharedDrafts").collect()).length,
        localeDrafts: (await ctx.db.query("pageLocaleDrafts").collect()).length,
        localeStates: (
          await ctx.db.query("pageLocalePublicationStates").collect()
        ).length,
      }))
    ).toEqual({
      cutovers: 1,
      pages: 1,
      pageStates: 1,
      sharedDrafts: 1,
      localeDrafts: 1,
      localeStates: 1,
    })
    await expect(
      owner.mutation(api.cms.settings.bootstrapInstallation, {
        siteName: "Different site",
        timezone: "America/Toronto",
        defaultLocale: "fr",
      })
    ).rejects.toThrow("INSTALLATION_ALREADY_BOOTSTRAPPED")
    await expect(
      owner.mutation(api.cms.settings.markOnboardingStep, {
        step: "locales",
      })
    ).rejects.toThrow("SNAPSHOT_ONBOARDING_WIZARD_DEFERRED")
    await expect(
      owner.mutation(api.cms.settings.completeOnboarding, {
        siteName: "Atomic site",
        timezone: "America/Toronto",
        defaultLocale: "fr",
        enabledLocales: ["fr"],
      })
    ).rejects.toThrow("SNAPSHOT_ONBOARDING_WIZARD_DEFERRED")
  })

  test("the real editor command saves locale and hierarchy atomically with independent clocks", async () => {
    const { t, owner, pageId } = await activeFixture()
    const parentId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "parent",
      title: "Parent",
      content: { en: { title: "Parent", slices: [] } },
    })
    const combined = await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      shared: { expectedGeneration: 1, parentId },
      localized: {
        locale: "en",
        slug: "atomic-edit",
        expectedGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: "Atomic edit" },
          slices: [],
        },
      },
    })
    expect(combined).toMatchObject({
      pageId,
      locale: "en",
      draftGeneration: 2,
      sharedDraftGeneration: 2,
    })

    const sharedOnly = await owner.mutation(
      api.cms.publication.saveEditorDraft,
      {
        pageId,
        expectedLifecycleGeneration: 1,
        shared: { expectedGeneration: 2, seo: { noIndex: true } },
      }
    )
    expect(sharedOnly).toMatchObject({ sharedDraftGeneration: 3 })
    expect(sharedOnly).not.toHaveProperty("draftGeneration")

    const localizedOnly = await owner.mutation(
      api.cms.publication.saveEditorDraft,
      {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug: "locale-only",
          expectedGeneration: 2,
          draft: {
            pageType: "landing-page",
            localized: { title: "Locale only" },
            slices: [],
          },
        },
      }
    )
    expect(localizedOnly).toMatchObject({ draftGeneration: 3 })
    expect(localizedOnly).not.toHaveProperty("sharedDraftGeneration")

    const beforeFailure = await t.run(async (ctx) => ({
      shared: await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique(),
      locale: await ctx.db
        .query("pageLocaleDrafts")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique(),
      refs: await ctx.db
        .query("pagePublicationDocumentReferences")
        .withIndex("by_pageId_and_sourceKind", (q) =>
          q.eq("pageId", pageId).eq("sourceKind", "shared_draft")
        )
        .collect(),
    }))
    await expect(
      owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        shared: { expectedGeneration: 3, clearParent: true },
        localized: {
          locale: "en",
          slug: "must-roll-back",
          expectedGeneration: 2,
          draft: {
            pageType: "landing-page",
            localized: { title: "Must roll back" },
            slices: [],
          },
        },
      })
    ).rejects.toThrow("PAGE_LOCALE_DRAFT_STALE")
    expect(
      await t.run(async (ctx) => ({
        shared: await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique(),
        locale: await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", "en")
          )
          .unique(),
        refs: await ctx.db
          .query("pagePublicationDocumentReferences")
          .withIndex("by_pageId_and_sourceKind", (q) =>
            q.eq("pageId", pageId).eq("sourceKind", "shared_draft")
          )
          .collect(),
      }))
    ).toEqual(beforeFailure)

    await expect(
      owner.mutation(api.cms.publication.archivePage, {
        pageId,
        expectedLifecycleGeneration: 99,
      })
    ).rejects.toThrow("PAGE_PUBLICATION_LIFECYCLE_STALE")
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pagePublicationPageStates")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique()
      )
    ).toMatchObject({ lifecycleState: "active", lifecycleGeneration: 1 })
  })

  test("admin editor read model exposes successor generations and mutable locale drafts", async () => {
    const { owner, pageId } = await activeFixture()
    expect(
      await owner.query(api.cms.pages.getForEdit, { id: pageId })
    ).toMatchObject({
      page: { _id: pageId, content: { en: { title: "Café ☕" } } },
      hasStaging: true,
      publication: {
        authority: "snapshot_active",
        lifecycleGeneration: 1,
        sharedDraftGeneration: 1,
        locales: expect.arrayContaining([
          expect.objectContaining({ locale: "en", draftGeneration: 1 }),
        ]),
      },
    })
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId,
      locale: "en",
      slug: "edited",
      draft: {
        pageType: "landing-page",
        localized: { title: "Edited" },
        slices: [],
      },
      expectedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
    })
    expect(
      await owner.query(api.cms.pages.getForEdit, { id: pageId })
    ).toMatchObject({
      page: { slug: "edited", content: { en: { title: "Edited" } } },
      publication: {
        locales: expect.arrayContaining([
          expect.objectContaining({ locale: "en", draftGeneration: 2 }),
        ]),
      },
    })
  })

  test(
    "retained admin preview reads current drafts and never overlays legacy staging",
    sliceProfile(["rich-text-body"]),
    async () => {
      const { t, owner, pageId, homeId } = await activeFixture()
      await publishEn(owner, pageId)
      const opened = await owner.query(api.cms.pages.getForEdit, { id: pageId })
      const generation = opened!.publication!.locales.find(
        (row) => row.locale === "en"
      )!.draftGeneration
      await owner.mutation(api.cms.publication.saveLocaleDraft, {
        pageId,
        locale: "en",
        slug: "current-draft",
        draft: {
          pageType: "landing-page",
          localized: { title: "Current Working Draft" },
          slices: [bodySlice("current", "Current draft copy")],
        },
        expectedDraftGeneration: generation,
        expectedLifecycleGeneration: 1,
      })
      await t.run(async (ctx) => {
        await ctx.db.patch("pages", pageId, {
          parentId: homeId,
          content: { en: { title: "Retained legacy Page", slices: [] } },
        })
        await ctx.db.insert("pageStaging", {
          pageId,
          pageType: "landing-page",
          slug: "legacy-staging",
          updatedAt: 999,
          content: { en: { title: "Retained legacy staging", slices: [] } },
        })
      })
      const publicBefore = await t.run((ctx) =>
        ctx.db.query("pagePublishedSnapshots").collect()
      )
      const expected = await owner.query(api.cms.pages.getForEdit, {
        id: pageId,
      })
      const preview = await owner.query(api.cms.pages.getStagedPreviewById, {
        id: pageId,
      })
      expect(preview).toMatchObject({
        page: {
          slug: "current-draft",
          content: { en: { title: "Current Working Draft" } },
        },
        hasStaging: true,
      })
      expect(preview!.page).toEqual(expected!.page)
      expect(preview!.page.parentId).toBeUndefined()
      expect(preview!.stagingUpdatedAt).toBeUndefined()
      await expect(
        t.query(api.cms.pages.getStagedPreviewById, { id: pageId })
      ).rejects.toThrow()
      await expect(
        t
          .withIdentity({
            subject: "other",
            tokenIdentifier: "https://convex.test|other",
          })
          .query(api.cms.pages.getStagedPreviewById, { id: pageId })
      ).rejects.toThrow()
      expect(
        await t.run((ctx) => ctx.db.query("pagePublishedSnapshots").collect())
      ).toEqual(publicBefore)
    }
  )

  // FR2b: the Search half of this case moved to convex/search.boundaries.test.ts.
  test("legacy lists close while successor admin lifecycle projections remain usable", async () => {
    const { owner, pageId } = await activeFixture()

    await expect(owner.query(api.cms.pages.list, {})).rejects.toThrow(
      "SNAPSHOT_ADMIN_PROJECTION_REQUIRED"
    )
    await expect(
      owner.query(api.cms.pages.listPaginated, {
        paginationOpts: { numItems: 10, cursor: null },
      })
    ).rejects.toThrow("SNAPSHOT_ADMIN_PROJECTION_REQUIRED")

    expect(await owner.query(api.cms.pages.listSummaries, {})).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          _id: pageId,
          localizedTitles: expect.objectContaining({ en: "Café ☕" }),
          status: "draft",
        }),
      ])
    )
    expect(
      await owner.query(api.cms.publication.listAdminPages, {
        paginationOpts: { numItems: 10, cursor: null },
        scope: "content",
      })
    ).toMatchObject({
      page: expect.arrayContaining([
        expect.objectContaining({
          _id: pageId,
          lifecycleState: "active",
          lifecycleGeneration: 1,
        }),
      ]),
    })

    await owner.mutation(api.cms.publication.archivePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    expect(
      await owner.query(api.cms.publication.listAdminPages, {
        paginationOpts: { numItems: 10, cursor: null },
        scope: "archive",
      })
    ).toMatchObject({
      page: [
        expect.objectContaining({
          _id: pageId,
          lifecycleState: "archived",
          lifecycleGeneration: 2,
        }),
      ],
    })

    await owner.mutation(api.cms.publication.softDeletePage, {
      pageId,
      expectedLifecycleGeneration: 2,
    })
    expect(
      await owner.query(api.cms.publication.listAdminPages, {
        paginationOpts: { numItems: 10, cursor: null },
        scope: "trash",
      })
    ).toMatchObject({
      page: [
        expect.objectContaining({
          _id: pageId,
          lifecycleState: "trashed",
          restoreLifecycleState: "archived",
          lifecycleGeneration: 3,
        }),
      ],
    })
    const content = await owner.query(api.cms.publication.listAdminPages, {
      paginationOpts: { numItems: 10, cursor: null },
      scope: "content",
    })
    expect(content.page.some((row) => row._id === pageId)).toBe(false)
  })

  test("missing authority fails closed and the real empty bootstrap rejects retained Page data", async () => {
    const t = app()
    const owner = t.withIdentity(OWNER)
    await expect(
      owner.mutation(api.cms.settings.markOnboardingStep, {
        step: "account",
      })
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    expect(
      await t.run(async (ctx) => ({
        settings: await ctx.db.query("siteSettings").collect(),
        media: await ctx.db.query("media").collect(),
        menus: await ctx.db.query("menus").collect(),
      }))
    ).toEqual({ settings: [], media: [], menus: [] })
    await enableRedirectsForTest(owner)
    await t.run(async (ctx) => {
      const now = Date.now()
      await ctx.db.insert("menus", { slug: "primary", nav: [], updatedAt: now })
      await ctx.db.insert("redirects", {
        fromPath: "/legacy",
        toPath: "/leak",
        statusCode: 301,
        createdAt: now,
        updatedAt: now,
      })
    })
    expect(
      await t.query(api.cms.menus.getWithResolvedLinks, {
        languageVersion: 0,
        slug: "primary",
        locale: "en",
      })
    ).toBeNull()
    expect(
      await t.query(api.cms.redirects.resolve, {
        languageVersion: 0,
        path: "/legacy",
        locale: "en",
      })
    ).toBeNull()
    await expect(
      t.query(api.cms.pages.resolveLocalizedPathQuery, {
        languageVersion: 0,
        path: "/legacy",
        locale: "en",
        // @ts-expect-error — the public contract deliberately has no draft switch.
        includeDrafts: true,
      })
    ).rejects.toThrow()
    expect(await t.query(api.cms.settings.getSiteConfig, {})).toMatchObject({
      enabledLocales: [],
      homePageId: null,
    })
    await expect(
      owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        title: "Blocked",
      })
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_CUTOVER_INVALID")
    await t.run(async (ctx) => {
      await ctx.db.insert("pages", {
        slug: "legacy",
        pageType: "landing-page",
        status: "draft",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        content: {},
      })
    })
    await expect(
      owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
    ).rejects.toThrow("PUBLISHED_SNAPSHOT_CUTOVER_REQUIRES_MIGRATION")
  })

  test("candidate is exact canonical UTF-8 SHA-256 and lifecycle restores the same pointer", async () => {
    const { t, owner, pageId } = await activeFixture()
    const published = await publishEn(owner, pageId)
    const candidate = await t.run((ctx) => ctx.db.get(published.candidateId))
    expect(candidate).not.toBeNull()
    const parsed = JSON.parse(candidate!.payloadJson)
    expect(Object.keys(parsed).sort()).toEqual([
      "locale",
      "localized",
      "page",
      "route",
      "shared",
    ])
    expect(parsed).not.toHaveProperty("publicPage")
    expect(parsed).not.toHaveProperty("path")
    expect(candidate!.payloadBytes).toBe(
      new TextEncoder().encode(candidate!.payloadJson).byteLength
    )
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(candidate!.payloadJson)
    )
    const expectedDigest = `sha256:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`
    expect(candidate!.digest).toBe(expectedDigest)
    const pointerBefore = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
    )
    await owner.mutation(api.cms.publication.archivePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toBeNull()
    await owner.mutation(api.cms.publication.restorePage, {
      pageId,
      expectedLifecycleGeneration: 2,
    })
    const restored = await t.query(api.cms.pages.getPublicPageById, {
      languageVersion: 0,
      id: pageId,
      locale: "en",
    })
    expect(
      (restored?.content.en as { title?: string } | undefined)?.title
    ).toBe("Café ☕")
    await owner.mutation(api.cms.publication.softDeletePage, {
      pageId,
      expectedLifecycleGeneration: 3,
    })
    expect(
      await t.query(api.cms.pages.getPublicPageById, {
        languageVersion: 0,
        id: pageId,
        locale: "en",
      })
    ).toBeNull()
    await owner.mutation(api.cms.publication.restoreSoftDeletedPage, {
      pageId,
      expectedLifecycleGeneration: 4,
    })
    const pointerAfter = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
    )
    expect(pointerAfter?.currentSnapshotId).toBe(
      pointerBefore?.currentSnapshotId
    )
  })

  test("draft/candidate/current media ownership validates storage and blocks permanent deletion", async () => {
    const { t, owner, pageId } = await activeFixture()
    const media = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob(["image"], { type: "image/png" })
      )
      const mediaId = await ctx.db.insert("media", {
        filename: "owned.png",
        storageId,
        url: "https://example.test/owned.png",
        size: 5,
        mimeType: "image/png",
        uploadedAt: Date.now(),
      })
      return { mediaId, storageId }
    })
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
      cardImageMediaId: media.mediaId,
    })
    const sharedRefs = await t.run((ctx) =>
      ctx.db
        .query("pagePublicationMediaReferences")
        .withIndex("by_mediaId", (q) => q.eq("mediaId", media.mediaId))
        .collect()
    )
    expect(sharedRefs).toEqual([
      expect.objectContaining({
        sourceKind: "shared_draft",
        sourceGeneration: 2,
      }),
    ])
    await expect(
      owner.mutation(api.cms.media.remove, { id: media.mediaId })
    ).rejects.toThrow("retained")
    const published = await publishEn(owner, pageId, 2)
    const refs = await t.run((ctx) =>
      ctx.db
        .query("pagePublicationMediaReferences")
        .withIndex("by_mediaId", (q) => q.eq("mediaId", media.mediaId))
        .collect()
    )
    expect(
      refs.some(
        (ref) =>
          ref.sourceKind === "candidate" &&
          ref.sourceId === published.candidateId
      )
    ).toBe(true)
    expect(
      refs.some(
        (ref) =>
          ref.sourceKind === "current_public" &&
          ref.sourceId === published.snapshotId
      )
    ).toBe(true)
    await expect(
      owner.mutation(api.cms.pages.remove, { id: pageId })
    ).rejects.toThrow("PERMANENT_PAGE_PURGE_NOT_IMPLEMENTED")

    expect(
      await t.query(api.cms.pages.getPublicRelationCardsByIds, {
        languageVersion: 0,
        ids: [pageId],
        locale: "en",
      })
    ).toMatchObject({ [pageId]: { image: { url: expect.any(String) } } })
    expect(
      await t.query(api.cms.pages.listRecentPublicRelationCards, {
        languageVersion: 0,
        pageType: "landing-page",
        locale: "en",
        limit: 12,
      })
    ).toContainEqual(
      expect.objectContaining({
        pageId,
        image: { url: expect.any(String) },
      })
    )
    await t.run((ctx) => ctx.db.delete(media.mediaId))
    expect(
      await t.query(api.cms.pages.getPublicRelationCardsByIds, {
        languageVersion: 0,
        ids: [pageId],
        locale: "en",
      })
    ).toEqual({
      [pageId]: expect.not.objectContaining({ image: expect.anything() }),
    })

    const broken = await t.run(async (ctx) => {
      const storageId = await ctx.storage.store(
        new Blob(["broken"], { type: "image/png" })
      )
      const mediaId = await ctx.db.insert("media", {
        filename: "broken.png",
        storageId,
        url: "https://example.test/broken.png",
        size: 6,
        mimeType: "image/png",
        uploadedAt: Date.now(),
      })
      await ctx.storage.delete(storageId)
      return mediaId
    })
    await expect(
      owner.mutation(api.cms.publication.saveSharedDraft, {
        pageId,
        expectedSharedDraftGeneration: 2,
        expectedLifecycleGeneration: 1,
        cardImageMediaId: broken,
      })
    ).rejects.toThrow("PUBLICATION_MEDIA_STORAGE_MISSING")
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique()
      )
    ).toMatchObject({
      generation: 2,
      system: { cardImageMediaId: media.mediaId },
    })
  })

  test(
    "document references own every source arm and failed same-locale capture rolls back",
    sliceProfile(["rich-text-body"]),
    async () => {
      const { t, owner } = await activeFixture()
      const authorId = await owner.mutation(api.cms.pages.create, {
        pageType: "author",
        status: "draft",
        slug: "ada",
        title: "Ada",
        name: "Ada",
        content: { en: { title: "Ada", slices: [] } },
      })
      const postId = await owner.mutation(api.cms.pages.create, {
        pageType: "post",
        status: "draft",
        slug: "proof",
        title: "Proof",
        authorIds: [authorId],
        content: {
          en: {
            title: "Proof",
            slices: [bodySlice("proof-en", "English proof")],
          },
          fr: {
            title: "Preuve",
            slices: [bodySlice("proof-fr", "Preuve française")],
          },
        },
      })
      expect(
        await t.run((ctx) =>
          ctx.db
            .query("pagePublicationDocumentReferences")
            .withIndex("by_targetId", (q) => q.eq("targetId", authorId))
            .collect()
        )
      ).toEqual([
        expect.objectContaining({ pageId: postId, sourceKind: "shared_draft" }),
      ])

      await publishEn(owner, authorId)
      const enPublish = await publishEn(owner, postId)
      const enRefs = await t.run((ctx) =>
        ctx.db
          .query("pagePublicationDocumentReferences")
          .withIndex("by_targetId", (q) => q.eq("targetId", authorId))
          .collect()
      )
      expect(enRefs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            pageId: postId,
            locale: "en",
            sourceKind: "candidate",
            sourceId: enPublish.candidateId,
            targetLocale: "en",
          }),
          expect.objectContaining({
            pageId: postId,
            locale: "en",
            sourceKind: "current_public",
            sourceId: enPublish.snapshotId,
            targetLocale: "en",
          }),
        ])
      )

      const enChecklist = await owner.query(
        api.cms.pages.getPrePublishChecklist,
        { pageId: postId, locale: "en" }
      )
      expect(
        enChecklist.blockers.filter((item) =>
          item.field?.startsWith("authorIds")
        )
      ).toHaveLength(0)

      const frChecklist = await owner.query(
        api.cms.pages.getPrePublishChecklist,
        { pageId: postId, locale: "fr" }
      )
      expect(frChecklist.canPublish).toBe(false)
      expect(
        frChecklist.blockers.filter((item) =>
          item.field?.startsWith("authorIds")
        )
      ).toEqual([
        expect.objectContaining({
          code: "archived_relation_target",
          severity: "blocker",
          message: expect.stringContaining("FR"),
        }),
      ])

      const before = await t.run(async (ctx) => ({
        candidates: await ctx.db
          .query("pageLocalePublicationCandidates")
          .withIndex("by_pageId_and_locale_and_createdAt", (q) =>
            q.eq("pageId", postId).eq("locale", "fr")
          )
          .collect(),
        releases: await ctx.db
          .query("pageLocalePublicationReleases")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", postId).eq("locale", "fr")
          )
          .collect(),
        snapshots: await ctx.db
          .query("pagePublishedSnapshots")
          .withIndex("by_pageId_and_locale_and_generation", (q) =>
            q.eq("pageId", postId).eq("locale", "fr")
          )
          .collect(),
        localeState: await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", postId).eq("locale", "fr")
          )
          .unique(),
      }))
      await expect(
        owner.mutation(api.cms.publication.publishLocale, {
          pageId: postId,
          locale: "fr",
          expectedDraftGeneration: 1,
          expectedSharedDraftGeneration: 1,
          expectedPublicGeneration: 0,
          expectedLifecycleGeneration: 1,
          expectedReleaseGeneration: 0,
        })
      ).rejects.toThrow("PUBLICATION_REFERENCE_TARGET_LOCALE_UNAVAILABLE")
      const after = await t.run(async (ctx) => ({
        candidates: await ctx.db
          .query("pageLocalePublicationCandidates")
          .withIndex("by_pageId_and_locale_and_createdAt", (q) =>
            q.eq("pageId", postId).eq("locale", "fr")
          )
          .collect(),
        releases: await ctx.db
          .query("pageLocalePublicationReleases")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", postId).eq("locale", "fr")
          )
          .collect(),
        snapshots: await ctx.db
          .query("pagePublishedSnapshots")
          .withIndex("by_pageId_and_locale_and_generation", (q) =>
            q.eq("pageId", postId).eq("locale", "fr")
          )
          .collect(),
        localeState: await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", postId).eq("locale", "fr")
          )
          .unique(),
      }))
      expect(after).toEqual(before)
    }
  )

  test("preview tokens are owner, Page, locale, path, and expiry bound", async () => {
    const { t, owner, pageId, homeId } = await activeFixture()
    await publishEn(owner, pageId)
    expect(
      await t.run((ctx) =>
        ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", "en")
          )
          .collect()
      )
    ).toEqual([])
    const session = await owner.mutation(api.cms.preview.createPreviewSession, {
      pageId,
      locale: "en",
      ttlMs: 1_000,
    })
    await expect(
      owner.mutation(api.cms.preview.getPreviewPage, {
        sessionToken: session.sessionToken,
        pageId: homeId,
        locale: "en",
      })
    ).rejects.toThrow("PREVIEW_SESSION_OWNER_MISMATCH")
    await expect(
      owner.mutation(api.cms.preview.getPreviewPage, {
        sessionToken: session.sessionToken,
        pageId,
        locale: "fr",
      })
    ).rejects.toThrow("PREVIEW_SESSION_OWNER_MISMATCH")
    expect(
      await owner.mutation(api.cms.preview.getPreviewPage, {
        sessionToken: session.sessionToken,
        pageId,
        locale: "en",
      })
    ).toMatchObject({
      page: {
        _id: pageId,
        slug: "café",
        content: { en: { title: "Café ☕" } },
      },
      requestedLocale: "en",
      renderLocale: "en",
      isFallback: false,
    })
    expect(
      await owner.mutation(api.cms.preview.resolvePreviewPath, {
        sessionToken: session.sessionToken,
        locale: "en",
        path: "/not-café",
      })
    ).toBeNull()
    expect(
      await owner.mutation(api.cms.preview.resolvePreviewPath, {
        sessionToken: session.sessionToken,
        locale: "en",
        path: "/café",
      })
    ).toMatchObject({ pageId, renderLocale: "en", isFallback: false })
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("pagePublicationPreviewSessions")
        .withIndex("by_sessionToken", (q) =>
          q.eq("sessionToken", session.sessionToken)
        )
        .unique()
      if (row) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 })
    })
    await expect(
      owner.mutation(api.cms.preview.getPreviewPage, {
        sessionToken: session.sessionToken,
      })
    ).rejects.toThrow("PREVIEW_SESSION_INVALID")
  })
})

// CVX-REPRO-1: every assertion crosses the shipped mutation boundary.
type ReproApp = ReturnType<typeof app>
type ReproOwner = ReturnType<ReproApp["withIdentity"]>
async function reproClocks(t: ReproApp, pageId: Id<"pages">, locale = "en") {
  return t.run(async (ctx) => ({
    state: (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique())!,
    shared: (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!,
  }))
}
async function reproPublish(
  t: ReproApp,
  owner: ReproOwner,
  pageId: Id<"pages">,
  locale = "en"
) {
  const { state, shared } = await reproClocks(t, pageId, locale)
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration: state.draftGeneration,
    expectedSharedDraftGeneration: shared.generation,
    expectedPublicGeneration: state.publicGeneration,
    expectedReleaseGeneration: state.releaseGeneration,
    expectedLifecycleGeneration: 1,
  })
}
async function reproCreate(owner: ReproOwner, slug: string) {
  return owner.mutation(api.cms.pages.create, {
    pageType: "landing-page",
    status: "draft",
    slug,
    title: slug,
    content: { en: { title: slug, slices: [] } },
  })
}
async function reproStage(
  t: ReproApp,
  owner: ReproOwner,
  pageId: Id<"pages">,
  parentId?: Id<"pages">,
  locale = "en",
  slug = "edited"
) {
  const { state, shared } = await reproClocks(t, pageId, locale)
  return owner.mutation(api.cms.publication.saveEditorDraft, {
    pageId,
    expectedLifecycleGeneration: 1,
    ...(parentId
      ? { shared: { expectedGeneration: shared.generation, parentId } }
      : {}),
    localized: {
      locale,
      slug,
      expectedGeneration: state?.draftGeneration ?? 0,
      draft: {
        pageType: "landing-page",
        localized: { title: "Edited" },
        slices: [bodySlice("body", "[plain] <text> {value}")],
      },
    },
  })
}
async function reproRows(t: ReproApp) {
  return t.run(async (ctx) => ({
    states: await ctx.db.query("pageLocalePublicationStates").collect(),
    snapshots: await ctx.db.query("pagePublishedSnapshots").collect(),
    candidates: await ctx.db.query("pageLocalePublicationCandidates").collect(),
    releases: await ctx.db.query("pageLocalePublicationReleases").collect(),
    history: await ctx.db.query("pageHistoricalLocaleRoutes").collect(),
    drafts: await ctx.db.query("pageLocaleDrafts").collect(),
    refs: await ctx.db.query("pagePublicationDocumentReferences").collect(),
    mediaRefs: await ctx.db.query("pagePublicationMediaReferences").collect(),
    sliceRefs: await ctx.db.query("pagePublicationSliceReferences").collect(),
    intents: await ctx.db.query("pagePublicationRevalidationIntents").collect(),
    shared: await ctx.db.query("pageSharedDrafts").collect(),
  }))
}

describe("CVX-REPRO-1 ordinary publication", () => {
  test.each(["self", "child", "grandchild"] as const)(
    "F02 refuses %s parent atomically",
    sliceProfile(["rich-text-body"]),
    async (kind) => {
      const { t, owner, pageId } = await activeFixture()
      await reproPublish(t, owner, pageId)
      const child = await reproCreate(owner, "child")
      await reproStage(t, owner, child, pageId, "en", "child")
      await reproPublish(t, owner, child)
      const grandchild = await reproCreate(owner, "grandchild")
      await reproStage(t, owner, grandchild, child, "en", "grandchild")
      await reproPublish(t, owner, grandchild)
      const parentId =
        kind === "self" ? pageId : kind === "child" ? child : grandchild
      if (kind === "self") {
        const beforeSave = await reproRows(t)
        await expect(reproStage(t, owner, pageId, parentId)).rejects.toThrow(
          "PAGE_ANCESTRY_CYCLE"
        )
        expect(await reproRows(t)).toEqual(beforeSave)
        return
      }
      await reproStage(t, owner, pageId, parentId)
      const before = await reproRows(t)
      const projections = await Promise.all(
        [pageId, child, grandchild].map((id) =>
          t.query(api.cms.pages.getPublicPageById, {
            id,
            locale: "en",
            languageVersion: 0,
          })
        )
      )
      expect(projections.every(Boolean)).toBe(true)
      await expect(reproPublish(t, owner, pageId)).rejects.toThrow(
        "PAGE_ANCESTRY_CYCLE"
      )
      expect(await reproRows(t)).toEqual(before)
      expect(
        await Promise.all(
          [pageId, child, grandchild].map((id) =>
            t.query(api.cms.pages.getPublicPageById, {
              id,
              locale: "en",
              languageVersion: 0,
            })
          )
        )
      ).toEqual(projections)
    }
  )

  test(
    "F02 valid reparent and unchanged parent still publish",
    sliceProfile(["rich-text-body"]),
    async () => {
      const { t, owner, pageId } = await activeFixture()
      const parent = await reproCreate(owner, "parent")
      await reproPublish(t, owner, parent)
      await reproStage(t, owner, pageId, parent, "en", "child")
      await reproPublish(t, owner, pageId)
      await reproStage(t, owner, pageId, undefined, "en", "child")
      await reproPublish(t, owner, pageId)
      expect((await reproClocks(t, pageId)).state.currentPath).toBe(
        "/parent/child"
      )
      expect(
        await t.query(api.cms.pages.getPublicPageById, {
          id: pageId,
          locale: "en",
          languageVersion: 0,
        })
      ).not.toBeNull()
    }
  )

  for (const profileRow of [
    "seo",
    "descriptor",
    "parent",
    "combined",
  ] as const) {
    test.each([profileRow])(
      "F03 publishes %s edit with immutable base and other locale",
      sliceProfile(profileRow === "descriptor" ? [] : ["rich-text-body"]),
      async (kind) => {
        const { t, owner, pageId: landing } = await activeFixture()
        const pageId =
          kind === "descriptor"
            ? await owner.mutation(api.cms.pages.create, {
                pageType: "author",
                status: "draft",
                slug: "author",
                title: "Author",
                name: "Before",
                content: {
                  en: { title: "Author", slices: [] },
                  fr: { title: "Auteur", slices: [] },
                },
              })
            : landing
        if (kind !== "descriptor")
          await reproStage(t, owner, pageId, undefined, "en", "café")
        await reproPublish(t, owner, pageId)
        await reproPublish(t, owner, pageId, "fr")
        const englishPublic = await t.query(api.cms.pages.getPublicPageById, {
          id: pageId,
          locale: "en",
          languageVersion: 0,
        })
        const frenchPublic = await t.query(api.cms.pages.getPublicPageById, {
          id: pageId,
          locale: "fr",
          languageVersion: 0,
        })
        const before = await reproRows(t)
        const english = (await reproClocks(t, pageId)).state
        const french = (await reproClocks(t, pageId, "fr")).state
        const parentId =
          kind === "parent" ? await reproCreate(owner, "parent") : undefined
        if (parentId) await reproPublish(t, owner, parentId)
        const { shared } = await reproClocks(t, pageId)
        await owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId,
          expectedLifecycleGeneration: 1,
          shared: {
            expectedGeneration: shared.generation,
            ...(kind === "descriptor"
              ? { sharedFieldsJson: JSON.stringify({ name: "After" }) }
              : kind === "parent"
                ? { parentId }
                : { seo: { noIndex: true } }),
          },
          ...(kind === "combined"
            ? {
                localized: {
                  locale: "en",
                  slug: "café",
                  expectedGeneration: english.draftGeneration,
                  draft: {
                    pageType: "landing-page" as const,
                    localized: { title: "Changed" },
                    slices: [],
                  },
                },
              }
            : {}),
        })
        expect((await reproClocks(t, pageId, "fr")).state).toEqual(french)
        // Stale generation must not be accepted by reconstruction/restaging.
        const clocks = await reproClocks(t, pageId)
        const saved = await reproRows(t)
        expect(
          await t.query(api.cms.pages.getPublicPageById, {
            id: pageId,
            locale: "en",
            languageVersion: 0,
          })
        ).toEqual(englishPublic)
        await expect(
          owner.mutation(api.cms.publication.publishLocale, {
            pageId,
            locale: "en",
            expectedDraftGeneration: clocks.state.draftGeneration,
            expectedSharedDraftGeneration: clocks.shared.generation - 1,
            expectedPublicGeneration: english.publicGeneration,
            expectedReleaseGeneration: english.releaseGeneration,
            expectedLifecycleGeneration: 1,
          })
        ).rejects.toThrow("PAGE_SHARED_DRAFT_STALE")
        expect(await reproRows(t)).toEqual(saved)
        await expect(
          owner.mutation(api.cms.publication.publishLocale, {
            pageId,
            locale: "en",
            expectedDraftGeneration: clocks.state.draftGeneration - 1,
            expectedSharedDraftGeneration: clocks.shared.generation,
            expectedPublicGeneration: english.publicGeneration,
            expectedReleaseGeneration: english.releaseGeneration,
            expectedLifecycleGeneration: 1,
          })
        ).rejects.toThrow("PAGE_LOCALE_PUBLICATION_STALE")
        expect(await reproRows(t)).toEqual(saved)
        const published = await reproPublish(t, owner, pageId)
        const after = await reproRows(t)
        for (const snapshot of before.snapshots)
          expect(after.snapshots).toContainEqual(snapshot)
        for (const candidate of before.candidates)
          expect(after.candidates).toContainEqual(candidate)
        expect((await reproClocks(t, pageId, "fr")).state).toEqual(french)
        expect(
          await t.query(api.cms.pages.getPublicPageById, {
            id: pageId,
            locale: "fr",
            languageVersion: 0,
          })
        ).toEqual(frenchPublic)
        expect(
          await t.query(api.cms.pages.getPublicPageById, {
            id: pageId,
            locale: "en",
            languageVersion: 0,
          })
        ).not.toBeNull()
        const snapshot = after.snapshots.find(
          (row) => row._id === published.snapshotId
        )!
        const candidate = after.candidates.find(
          (row) => row._id === snapshot.candidateId
        )!
        const payload = JSON.parse(candidate.payloadJson)
        if (kind === "descriptor")
          expect(payload.shared.descriptor.name).toBe("After")
        else if (kind === "parent")
          expect(payload.shared.system.parentId).toBe(parentId)
        else expect(payload.shared.system.seo).toEqual({ noIndex: true })
        const baseSnapshot = before.snapshots.find(
          (row) => row._id === english.currentSnapshotId
        )!
        const base = JSON.parse(
          before.candidates.find((row) => row._id === baseSnapshot.candidateId)!
            .payloadJson
        )
        if (kind !== "combined")
          expect(payload.localized).toEqual(base.localized)
        else expect(payload.localized.content.title).toBe("Changed")
        expect(
          after.drafts.filter(
            (row) => row.pageId === pageId && row.locale === "en"
          )
        ).toEqual([])
      }
    )
  }
  test("F03 saveSharedDraft sibling publishes reconstructed localized content", async () => {
    const { t, owner, pageId } = await activeFixture()
    await reproPublish(t, owner, pageId)
    const base = await reproRows(t)
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
      seo: { noIndex: true },
    })
    await reproPublish(t, owner, pageId)
    const after = await reproRows(t)
    expect(
      after.candidates.map((row) => JSON.parse(row.payloadJson).localized)
    ).toEqual([
      JSON.parse(base.candidates[0]!.payloadJson).localized,
      JSON.parse(base.candidates[0]!.payloadJson).localized,
    ])
  })

  test.each(["missing", "corrupt", "wrong-page"] as const)(
    "F03 refuses %s base atomically",
    async (kind) => {
      const { t, owner, pageId } = await activeFixture()
      const published = await reproPublish(t, owner, pageId)
      await t.run(async (ctx) => {
        const { state } = await (async () => ({
          state: (await ctx.db
            .query("pageLocalePublicationStates")
            .withIndex("by_pageId_and_locale", (q) =>
              q.eq("pageId", pageId).eq("locale", "en")
            )
            .unique())!,
        }))()
        if (kind === "missing")
          await ctx.db.patch(state._id, { draftBaseSnapshotId: undefined })
        else {
          const snapshot = (await ctx.db.get(published.snapshotId))!
          if (kind === "wrong-page")
            await ctx.db.patch(snapshot._id, {
              pageId: (await ctx.db.query("siteSettings").unique())!
                .homePageId!,
            })
          else await ctx.db.patch(snapshot.candidateId, { payloadJson: "{}" })
        }
      })
      const before = await reproRows(t)
      await expect(reproPublish(t, owner, pageId)).rejects.toThrow(
        kind === "missing"
          ? "PAGE_LOCALE_DRAFT_STALE"
          : "PUBLISHED_SNAPSHOT_INTEGRITY_INVALID"
      )
      expect(await reproRows(t)).toEqual(before)
    }
  )
})

// Hidden target selection uses language.prepareTargetPage, not the exported
// helper directly. Set up/confirm the same draft and generation contracts as UI.
describe("CVX-REPRO-1 prepared publication siblings", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())
  async function fixture() {
    const t = app(),
      owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Repro",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const settings = (await t.run((ctx) =>
      ctx.db.query("siteSettings").unique()
    ))!
    await reproPublish(t, owner, settings.homePageId!)
    const a = await reproCreate(owner, "a"),
      b = await reproCreate(owner, "b")
    await reproPublish(t, owner, a)
    await reproPublish(t, owner, b)
    const authority = (await t.run((ctx) =>
      ctx.db.query("siteLanguageAuthority").unique()
    ))!
    const transitionId = await owner.mutation(
      api.cms.language.startLanguageTransition,
      {
        mode: "replace_content",
        sourceLocale: "en",
        targetLocale: "fr",
        expectedSettingsUpdatedAt: settings.updatedAt,
        expectedAuthorityVersion: authority.version,
      }
    )
    await t.finishAllScheduledFunctions(vi.runAllTimers)
    async function prepare(
      pageId: Id<"pages">,
      slug: string,
      parentId?: Id<"pages">
    ) {
      const row = (await t.run((ctx) =>
        ctx.db
          .query("siteLanguageTransitionPages")
          .withIndex("by_transitionId_and_pageId", (q) =>
            q.eq("transitionId", transitionId).eq("pageId", pageId)
          )
          .unique()
      ))!
      if (row.disposition !== "target")
        await owner.mutation(api.cms.language.setPageDisposition, {
          transitionId,
          pageId,
          disposition: "target",
          expectedPageGeneration: row.generation,
        })
      const initial = await reproClocks(t, pageId, "fr")
      if (parentId)
        await owner.mutation(api.cms.publication.saveSharedDraft, {
          pageId,
          expectedSharedDraftGeneration: initial.shared.generation,
          expectedLifecycleGeneration: 1,
          parentId,
        })
      await owner.mutation(api.cms.publication.saveLocaleDraft, {
        pageId,
        locale: "fr",
        slug,
        expectedDraftGeneration: initial.state?.draftGeneration ?? 0,
        expectedLifecycleGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: "Prepared" },
          slices: [],
        },
      })
      const clocks = await reproClocks(t, pageId, "fr")
      const currentRow = (await t.run((ctx) =>
        ctx.db
          .query("siteLanguageTransitionPages")
          .withIndex("by_transitionId_and_pageId", (q) =>
            q.eq("transitionId", transitionId).eq("pageId", pageId)
          )
          .unique()
      ))!
      const confirmed = await owner.mutation(
        api.cms.language.confirmTargetContent,
        {
          transitionId,
          pageId,
          expectedTargetDraftGeneration: clocks.state.draftGeneration,
          expectedSharedDraftGeneration: clocks.shared.generation,
          expectedPageGeneration: currentRow.generation,
        }
      )
      const beforeCapture = await reproRows(t)
      try {
        return await owner.mutation(api.cms.language.prepareTargetPage, {
          transitionId,
          pageId,
          expectedPageGeneration: confirmed.generation,
        })
      } catch (error) {
        expect(await reproRows(t)).toEqual(beforeCapture)
        throw error
      }
    }
    return { t, owner, a, b, prepare }
  }
  test.each(["self", "descendant"] as const)(
    "F02 prepared refuses %s parent atomically",
    async (kind) => {
      const { t, a, b, prepare } = await fixture()
      await prepare(a, "a")
      await prepare(b, "b", a)
      // Save/confirm occur before capture; compare the transaction's state after refusal.
      const before = await reproRows(t)
      await expect(prepare(a, "a", kind === "self" ? a : b)).rejects.toThrow(
        "PAGE_ANCESTRY_CYCLE"
      )
      const after = await reproRows(t)
      expect(after.snapshots).toEqual(before.snapshots)
      expect(after.candidates).toEqual(before.candidates)
      expect(after.history).toEqual(before.history)
      expect(
        after.states.map((row) => [
          row._id,
          row.currentSnapshotId,
          row.publicGeneration,
        ])
      ).toEqual(
        before.states.map((row) => [
          row._id,
          row.currentSnapshotId,
          row.publicGeneration,
        ])
      )
    }
  )
  test("F04 prepared reuses its historical reservation on repeated departure", async () => {
    const { t, a, b, prepare } = await fixture()
    await prepare(a, "a")
    await prepare(a, "b")
    await prepare(a, "a")
    const reclaimed = await reproClocks(t, a, "fr")
    expect(reclaimed.state.currentPath).toBe("/a")
    await prepare(a, "c")
    const history = (await reproRows(t)).history.filter(
      (row) => row.locale === "fr" && row.fromPath === "/a"
    )
    expect(history).toHaveLength(1)
    expect(history[0]!.pageId).toBe(a)
    await expect(prepare(b, "a")).rejects.toThrow(
      "PUBLISHED_LOCALE_ROUTE_RESERVED"
    )
  })
})

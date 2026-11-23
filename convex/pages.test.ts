import { expectLegacyPanel as legacyPanel } from "@/test-utils/menu-panel"
import { mergeLocale, projectLocale, withAuthoredAlt } from "@/lib/admin/menu/locale-projection"
import type { NavItem } from "./lib/menu"
import { createSampleBlock } from "@/convex/lib/blocks/sample"
/// <reference types="vite/client" />
import { blockProfile } from "@/test-utils/block-profile"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { expect, test, describe, vi } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import type { Block } from "./lib/blocks"
import { CONTENT_TYPES, isActiveContentType } from "./lib/contentTypes"
import schema from "./schema"

import migrationsTest from "@convex-dev/migrations/test"
import { ID_BATCH_MAX } from "./lib/pages/types"

const canonicalBody = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        ...(text ? { content: [{ type: "text", text }] } : {}),
      },
    ],
  })

const modules = import.meta.glob("./**/*.ts")

const TEST_USER = {
  subject: "test-user",
  tokenIdentifier: "test-user",
  name: "Test User",
  email: "test@example.com",
}

function pageTest() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: TEST_USER,
  })
}

const postActive = isActiveContentType("post")
const authorActive = isActiveContentType("author")
/**
 * `skip: false` inside a block profile wins over `test.runIf`, so a test that
 * also needs an installed content type combines both conditions here.
 */
function whenActive<T extends { skip: boolean }>(profile: T, active: boolean): T {
  return { ...profile, skip: profile.skip || !active }
}

/**
 * A fresh site through the real installation command: the owner, a published
 * Home page slot, one language, or two when `extraLocale` turns Multilingual
 * on and adds it (the same steps the admin takes).
 */
async function bootstrappedSite(defaultLocale = "en", extraLocale?: string) {
  const t = pageTest()
  const owner = t.withIdentity(TEST_USER)
  await owner.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "Site",
    timezone: "UTC",
    defaultLocale,
  })
  if (extraLocale) {
    const changes = [{ moduleId: "multilingual", enabled: true }]
    const preview = await owner.query(api.cms.modules.preview, { changes })
    await owner.mutation(api.cms.modules.commit, {
      changes,
      expectedConfigurationVersion: preview.configurationVersion,
    })
    const { commandTokens } = await owner.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    if (commandTokens.settingsUpdatedAt === null)
      throw new Error("Missing bootstrapped settings")
    const added = await owner.mutation(api.cms.multilingual.addSiteLanguage, {
      locale: extraLocale,
      expectedSettingsUpdatedAt: commandTokens.settingsUpdatedAt,
      expectedModuleConfigurationVersion:
        commandTokens.moduleConfigurationVersion,
      expectedAuthorityVersion: commandTokens.authorityVersion,
    })
    expect(added.ok).toBe(true)
  }
  const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
  return { t, owner, languageVersion }
}
type BootstrappedSite = Awaited<ReturnType<typeof bootstrappedSite>>

/** First publication of one language of a freshly created page. */
function publishFirst(
  owner: BootstrappedSite["owner"],
  pageId: Id<"pages">,
  locale = "en",
  expectedDraftGeneration = 1
) {
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 0,
  })
}

/** Publish one language with the generations the page has right now. */
async function publishNow(
  t: BootstrappedSite["t"],
  owner: BootstrappedSite["owner"],
  pageId: Id<"pages">,
  locale = "en"
) {
  const g = await t.run(async (ctx) => ({
    locale: (await ctx.db
      .query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) =>
        q.eq("pageId", pageId).eq("locale", locale)
      )
      .unique())!,
    page: (await ctx.db
      .query("pagePublicationPageStates")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!,
    shared: (await ctx.db
      .query("pageSharedDrafts")
      .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
      .unique())!,
  }))
  return owner.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale,
    expectedDraftGeneration: g.locale.draftGeneration,
    expectedSharedDraftGeneration: g.shared.generation,
    expectedPublicGeneration: g.locale.publicGeneration,
    expectedLifecycleGeneration: g.page.lifecycleGeneration,
    expectedReleaseGeneration: g.locale.releaseGeneration,
  })
}

/** Insert raw page rows that only count against the pilot envelope. */
async function insertPilotFixturePages(
  t: ReturnType<typeof convexTest>,
  options: {
    start: number
    count: number
    status: "draft" | "published"
  }
): Promise<Id<"pages">[]> {
  return t.run(async (ctx) => {
    const now = Date.now()
    const ids: Id<"pages">[] = []
    for (let offset = 0; offset < options.count; offset += 1) {
      const index = options.start + offset
      ids.push(
        await ctx.db.insert("pages", {
          slug: `pilot-fixture-${index}`,
          pageType: "page",
          status: options.status,
          createdAt: now,
          updatedAt: now,
          ...(options.status === "published" ? { publishedAt: now } : {}),
          content: {
            en: { title: `Pilot fixture ${index}`, blocks: [] },
          },
        })
      )
    }
    return ids
  })
}

describe("pages — bounded pilot envelope", () => {
  test("signals the 80% capacity warning before the 499-page maximum", blockProfile([]), async () => {
    const t = pageTest()
    await insertPilotFixturePages(t, {
      start: 0,
      count: 399,
      status: "published",
    })

    await expect(
      t.query(api.cms.pages.getBoundedPilotEnvelope, {})
    ).resolves.toEqual({
      withinEnvelope: true,
      totalPagesBelowCap: true,
      publishedPagesBelowCap: true,
      totalPagesAtOrAboveWarningThreshold: false,
      publishedPagesAtOrAboveWarningThreshold: false,
    })

    await insertPilotFixturePages(t, {
      start: 399,
      count: 1,
      status: "published",
    })

    await expect(
      t.query(api.cms.pages.getBoundedPilotEnvelope, {})
    ).resolves.toEqual({
      withinEnvelope: true,
      totalPagesBelowCap: true,
      publishedPagesBelowCap: true,
      totalPagesAtOrAboveWarningThreshold: true,
      publishedPagesAtOrAboveWarningThreshold: true,
    })
  })

  test("reports the exact 500-row sentinel without exposing catalog counts", blockProfile([]), async () => {
    const t = pageTest()
    await insertPilotFixturePages(t, {
      start: 0,
      count: 499,
      status: "published",
    })

    await expect(
      t.query(api.cms.pages.getBoundedPilotEnvelope, {})
    ).resolves.toEqual({
      withinEnvelope: true,
      totalPagesBelowCap: true,
      publishedPagesBelowCap: true,
      totalPagesAtOrAboveWarningThreshold: true,
      publishedPagesAtOrAboveWarningThreshold: true,
    })

    await insertPilotFixturePages(t, {
      start: 499,
      count: 1,
      status: "published",
    })
    await expect(
      t.query(api.cms.pages.getBoundedPilotEnvelope, {})
    ).resolves.toEqual({
      withinEnvelope: false,
      totalPagesBelowCap: false,
      publishedPagesBelowCap: false,
      totalPagesAtOrAboveWarningThreshold: true,
      publishedPagesAtOrAboveWarningThreshold: true,
    })
  })

  test("ordinary creation cannot make a bounded read reach 500 rows", blockProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    // The Home page the installation creates is the 498th row.
    await asUser.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Pilot",
      timezone: "UTC",
      defaultLocale: "en",
    })
    await insertPilotFixturePages(t, {
      start: 0,
      count: 497,
      status: "draft",
    })
    // The raw rows bypass the write counter; the next create measures again.
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query("pilotEnvelope").take(2))
        await ctx.db.delete("pilotEnvelope", row._id)
    })

    await expect(
      asUser.mutation(api.cms.pages.create, {
        slug: "pilot-row-499",
        pageType: "page",
        status: "draft",
        title: "Row 499",
      })
    ).resolves.toBeDefined()
    await expect(
      asUser.mutation(api.cms.pages.create, {
        slug: "pilot-row-500",
        pageType: "page",
        status: "draft",
        title: "Row 500",
      })
    ).rejects.toThrow(/Bounded pilot envelope reached.*499 pages/)
  })

})

describe("pages — public read boundaries", () => {
  test("public page projection is exact, locale-strict, and excludes private system fields", blockProfile([]), async () => {
    const t = pageTest()
    const asUser = t.withIdentity(TEST_USER)
    await asUser.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Projection",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const pageId = await asUser.mutation(api.cms.pages.create, {
      slug: "projection-boundary",
      pageType: "page",
      status: "draft",
      template: "internal-template",
      showOnHomepage: true,
      displayMode: "both",
      cardExcerpt: "private card copy",
      seo: {
        metaTitle: "Public metadata",
        noIndex: true,
        focusKeyword: "private keyword",
        keywords: ["private", "taxonomy"],
        canonicalUrl: "https://private.example.test/override",
        seoScore: 100,
      },
      content: {
        en: {
          title: "Public English title",
          metaTitle: "Public English meta",
          metaDescription: "Public English description",
          blocks: [],
        },
      },
    })
    await asUser.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })

    const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
    const projection = await t.query(api.cms.pages.getPublicPageById, {
      languageVersion,
      id: pageId,
      locale: "en",
    })
    expect(Object.keys(projection ?? {}).sort()).toEqual([
      "_id",
      "content",
      "pageType",
      "publishedAt",
      "seo",
      "updatedAt",
    ])
    expect(projection).toMatchObject({
      _id: pageId,
      pageType: "page",
      content: {
        en: {
          title: "Public English title",
          metaTitle: "Public English meta",
          metaDescription: "Public English description",
          blocks: [],
        },
      },
    })
    const serialized = JSON.stringify(projection)
    for (const privateValue of [
      "internal-template",
      "private card copy",
      "private keyword",
      "private.example.test",
    ]) {
      expect(serialized).not.toContain(privateValue)
    }
    // A language the site does not publish is never served.
    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion,
        id: pageId,
        locale: "fr",
      })
    ).resolves.toBeNull()
  })
})

describe("pages — relation cards", () => {
  test("projects published pages and hides drafts unless preview is enabled", whenActive(blockProfile(["hero-agency"]), postActive), async () => {
    const { t, owner, languageVersion } = await bootstrappedSite()

    const publishedId = await owner.mutation(api.cms.pages.create, {
      slug: "published-post",
      pageType: "post",
      status: "draft",
      title: "Published Post",
      cardExcerpt: "Published excerpt",
      content: {
        en: {
          title: "Published Post",
          blocks: [createSampleBlock("hero-agency")],
        },
      },
    })
    await publishFirst(owner, publishedId)
    const draftId = await owner.mutation(api.cms.pages.create, {
      slug: "draft-post",
      pageType: "post",
      status: "draft",
      title: "Draft Post",
      content: { en: { title: "Draft Post", blocks: [] } },
    })

    const publicCards = await t.query(
      api.cms.pages.getPublicRelationCardsByIds,
      { languageVersion, ids: [publishedId, draftId], locale: "en" }
    )
    expect(publicCards[publishedId]?.title).toBe("Published Post")
    expect(publicCards[publishedId]).not.toHaveProperty("excerpt")
    expect(publicCards[draftId]).toBeNull()

    await expect(
      t.query(api.cms.pages.getRelationCardsByIds, {
        ids: [draftId],
        locale: "en",
        includeDrafts: true,
      })
    ).rejects.toThrow("UNAUTHENTICATED")

    const previewCards = await owner.query(
      api.cms.pages.getRelationCardsByIds,
      {
        ids: [draftId],
        locale: "en",
        includeDrafts: true,
      }
    )
    // Preview resolves the draft that the public reader hides. (It still reads
    // the page row, not the working draft, so only the row's own title is
    // checked here; see the 0.5.1 report.)
    expect(previewCards[draftId]).toMatchObject({
      pageId: draftId,
      pageType: "post",
    })
  })

  test("recent public relation cards are bounded, newest-first, and locale-strict", whenActive(blockProfile([]), postActive), async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      const { t, owner, languageVersion } = await bootstrappedSite("en", "fr")
      let clock = 1_000_000
      for (const page of [
        { slug: "old", en: "Old", fr: "Ancien" },
        { slug: "middle", en: "Middle", fr: "Milieu" },
        { slug: "new", en: "New", fr: undefined },
      ]) {
        const pageId = await owner.mutation(api.cms.pages.create, {
          slug: page.slug,
          pageType: "post",
          status: "draft",
          title: page.en,
          content: { en: { title: page.en, blocks: [] } },
        })
        if (page.fr)
          await owner.mutation(api.cms.publication.saveLocaleDraft, {
            pageId,
            locale: "fr",
            slug: page.slug,
            expectedDraftGeneration: 0,
            expectedLifecycleGeneration: 1,
            draft: {
              pageType: "post",
              localized: { title: page.fr },
              blocks: [],
            },
          })
        clock += 1000
        vi.setSystemTime(clock)
        await publishFirst(owner, pageId, "en")
        if (page.fr) await publishFirst(owner, pageId, "fr")
      }

      const recent = (locale: string, limit: number) =>
        t.query(api.cms.pages.listRecentPublicRelationCards, {
          languageVersion,
          pageType: "post",
          limit,
          locale,
        })
      await expect(recent("en", 2)).resolves.toMatchObject([
        { title: "New" },
        { title: "Middle" },
      ])
      await expect(recent("fr", 3)).resolves.toMatchObject([
        { title: "Milieu" },
        { title: "Ancien" },
      ])
      await expect(recent("de", 3)).resolves.toEqual([])
      await expect(recent("en", 13)).rejects.toThrow(/integer.*1.*12/i)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("pages — localized ancestry", () => {
  test("changing a parent's FR slug moves the descendant's public path once the descendant is published again", blockProfile([]), async () => {
    const { t, owner, languageVersion } = await bootstrappedSite("en", "fr")

    const newPage = async (
      slug: string,
      frSlug: string,
      parentId?: Id<"pages">
    ) => {
      const pageId = await owner.mutation(api.cms.pages.create, {
        slug,
        pageType: "page",
        status: "draft",
        title: slug,
        content: { en: { title: slug, blocks: [] } },
      })
      await owner.mutation(api.cms.publication.saveLocaleDraft, {
        pageId,
        locale: "fr",
        slug: frSlug,
        expectedDraftGeneration: 0,
        expectedLifecycleGeneration: 1,
        draft: { pageType: "page", localized: { title: frSlug }, blocks: [] },
      })
      if (parentId)
        await owner.mutation(api.cms.publication.saveEditorDraft, {
          pageId,
          expectedLifecycleGeneration: 1,
          shared: { expectedGeneration: 1, parentId },
        })
      await publishNow(t, owner, pageId, "en")
      await publishNow(t, owner, pageId, "fr")
      return pageId
    }
    const parentId = await newPage("my-products", "produits")
    const childId = await newPage("product-1", "produit-1", parentId)
    const pathsOf = (locale: string) =>
      t.query(api.cms.pages.getLocalizedPathsByIds, {
        languageVersion,
        ids: [childId],
        locale,
      })
    expect((await pathsOf("fr"))[childId]).toBe("/fr/produits/produit-1")

    // Give the PARENT a new French slug and republish French: the child's
    // French path follows it, and English is unaffected.
    const frDraft = await t.run(async (ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", parentId).eq("locale", "fr")
        )
        .unique()
    )
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId: parentId,
      expectedLifecycleGeneration: 1,
      localized: {
        locale: "fr",
        slug: "mes-produits",
        expectedGeneration: frDraft!.draftGeneration,
        draft: {
          pageType: "page",
          localized: { title: "Mes produits" },
          blocks: [],
        },
      },
    })
    await publishNow(t, owner, parentId, "fr")
    // A published child captures its ancestry when it is published, so the
    // child's French draft is published again to pick up the parent's new slug.
    await publishNow(t, owner, childId, "fr")

    expect((await pathsOf("fr"))[childId]).toBe("/fr/mes-produits/produit-1")
    expect((await pathsOf("en"))[childId]).toBe("/my-products/product-1")
  })
})

describe("pages — pre-publish checklist", () => {
  const heroAgency = (title: string, enabled = true): Block => ({
    id: "hero-1",
    type: "hero-agency",
    enabled,
    primary: {
      eyebrow: "Agency",
      title,
      description: canonicalBody("Copy"),
    },
    items: [],
  })
  const heroWithImage = (alt: string): Block => ({
    id: "hero-1",
    type: "hero-with-image",
    enabled: true,
    primary: {
      eyebrow: "Launch",
      eyebrowLink: { type: "none" },
      title: "Image page",
      description: canonicalBody("Copy"),
      image: { url: "https://example.com/image.jpg", alt },
    },
    items: [],
  })
  async function checklistFor(
    pageType: "landing-page" | "post",
    title: string,
    blocks: Block[]
  ) {
    const { owner } = await bootstrappedSite()
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType,
      status: "draft",
      slug: "checklist-page",
      title,
      content: { en: { title, blocks } },
    })
    return owner.query(api.cms.pages.getPrePublishChecklist, { pageId })
  }
  const codes = (items: { code: string }[]) => items.map((item) => item.code)

  // Each case: the blocks a page carries, the profile they need, and the
  // codes the checklist must report.
  const landingCases: {
    name: string
    types: string[]
    title: string
    blocks: () => Block[]
    blockers?: string[]
    blockersInclude?: string[]
    warnings?: string[]
    warningsInclude?: string[]
    warningsExclude?: string[]
  }[] = [
    {
      name: "a title with no content sections only warns about content and search metadata",
      types: [],
      title: "Title only",
      blocks: (): Block[] => [],
      blockers: [],
      warnings: [
        "missing_default_locale_content",
        "missing_seo_title",
        "missing_seo_description",
      ],
    },
    {
      name: "a content section removes the missing-content warning",
      types: ["hero-agency"],
      title: "With content",
      blocks: (): Block[] => [heroAgency("With content")],
      blockers: [],
      warningsExclude: ["missing_default_locale_content"],
    },
    {
      name: "an enabled block with a missing required field blocks",
      types: ["hero-agency"],
      title: "Incomplete block",
      blocks: (): Block[] => [heroAgency("")],
      blockersInclude: ["missing_required_block_field"],
    },
    {
      name: "a real block image without alt text blocks",
      types: ["hero-with-image"],
      title: "Image page",
      blocks: (): Block[] => [heroWithImage("")],
      blockersInclude: ["missing_image_alt_text"],
    },
  ]
  for (const c of landingCases) {
    test(`landing page: ${c.name}`, blockProfile(c.types), async () => {
      const checklist = await checklistFor("landing-page", c.title, c.blocks())
      if (c.blockers) expect(codes(checklist.blockers)).toEqual(c.blockers)
      if (c.blockersInclude)
        for (const code of c.blockersInclude)
          expect(codes(checklist.blockers)).toContain(code)
      if (c.warnings) expect(codes(checklist.warnings)).toEqual(c.warnings)
      for (const code of c.warningsInclude ?? [])
        expect(codes(checklist.warnings)).toContain(code)
      for (const code of c.warningsExclude ?? [])
        expect(codes(checklist.warnings)).not.toContain(code)
      expect(checklist.canPublish).toBe(
        codes(checklist.blockers).length === 0
      )
    })
  }

  test("a block link to a page that is not published blocks", blockProfile(["hero-agency"]), async () => {
    const { owner } = await bootstrappedSite()
    const targetId = await owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug: "draft-target",
      title: "Draft target",
      content: { en: { title: "Draft target", blocks: [] } },
    })
    const block = heroAgency("Linked page")
    if (block.type !== "hero-agency") throw new Error("Expected Hero Agency")
    block.items = [
      {
        label: "Read more",
        link: { type: "internal", pageId: targetId },
        withIcon: false,
        enabled: true,
      },
    ]
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "linked-page",
      title: "Linked page",
      content: { en: { title: "Linked page", blocks: [block] } },
    })
    const checklist = await owner.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })
    expect(checklist.canPublish).toBe(false)
    expect(codes(checklist.blockers)).toContain("archived_relation_target")
  })

  test("a page type that requires body content blocks an empty body but a landing page only warns", whenActive(blockProfile([]), postActive), async () => {
    const post = await checklistFor("post", "Empty post", [])
    expect(post.canPublish).toBe(false)
    expect(
      post.blockers.find(
        (item) => item.code === "missing_required_field" && item.field === "body"
      )
    ).toBeDefined()
    // The strict blocker replaces the soft warning entirely.
    expect(codes(post.warnings)).not.toContain("missing_default_locale_content")
    const landing = await checklistFor("landing-page", "Empty landing", [])
    expect(codes(landing.warnings)).toContain("missing_default_locale_content")
    expect(
      landing.blockers.find((item) => item.field === "body")
    ).toBeUndefined()
  })

  test("only an enabled block satisfies a required body", whenActive(blockProfile(["hero-agency"]), postActive), async () => {
    const disabledOnly = await checklistFor("post", "Disabled-only post", [
      heroAgency("Disabled", false),
    ])
    expect(
      disabledOnly.blockers.find(
        (item) => item.code === "missing_required_field" && item.field === "body"
      )
    ).toBeDefined()
    const filled = await checklistFor("post", "Filled post", [
      heroAgency("Filled"),
    ])
    expect(
      filled.blockers.find(
        (item) => item.code === "missing_required_field" && item.field === "body"
      )
    ).toBeUndefined()
  })

  test("a language with no draft yet has no checklist", blockProfile([]), async () => {
    const { owner } = await bootstrappedSite("en", "fr")
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "english-only",
      title: "English only",
      content: { en: { title: "English only", blocks: [] } },
    })
    await expect(
      owner.query(api.cms.pages.getPrePublishChecklist, {
        pageId,
        locale: "fr",
      })
    ).rejects.toThrow("PAGE_LOCALE_DRAFT_REQUIRED")
  })

  test("checks the unpublished working draft of a published page", blockProfile(["hero-agency"]), async () => {
    const { t, owner } = await bootstrappedSite()
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "published-title",
      title: "Published title",
      content: {
        en: { title: "Published title", blocks: [heroAgency("Published title")] },
      },
    })
    await publishNow(t, owner, pageId, "en")
    const state = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
    )
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      localized: {
        locale: "en",
        slug: "published-title",
        expectedGeneration: state!.draftGeneration,
        draft: { pageType: "landing-page", localized: { title: "" }, blocks: [] },
      },
    })
    const checklist = await owner.query(api.cms.pages.getPrePublishChecklist, {
      pageId,
    })
    expect(codes(checklist.blockers)).toContain("missing_default_locale_title")
    // The public page is still the published title until Publish runs.
    const { languageVersion } = await t.query(api.cms.settings.getSiteConfig, {})
    await expect(
      t.query(api.cms.pages.getPublicPageById, {
        languageVersion,
        id: pageId,
        locale: "en",
      })
    ).resolves.toMatchObject({ content: { en: { title: "Published title" } } })
    await owner.mutation(api.cms.publication.discardLocaleDraft, {
      pageId,
      locale: "en",
      expectedDraftGeneration: state!.draftGeneration + 1,
      expectedLifecycleGeneration: 1,
    })
    // No working row remains: both editor and checklist must use the verified
    // frozen base, rather than confusing it with an untranslated language.
    const frozenEditor = await owner.query(api.cms.pages.getForEdit, { id: pageId })
    expect(frozenEditor).toMatchObject({
      hasStaging: false,
      page: { content: { en: { title: "Published title" } } },
    })
    const frozenChecklist = await owner.query(api.cms.pages.getPrePublishChecklist, {
      pageId, locale: "en",
    })
    expect(frozenChecklist.canPublish).toBe(true)
  })
})

describe("pages — owner presence and locks", () => {
  test("heartbeat refreshes one row per user", blockProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Refresh presence",
    })

    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })
    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })

    const editors = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors).toHaveLength(1)
    // Convex Auth tokens carry no email (ADR-0056); the label returns in B1b.
    expect(editors[0].email).toBeUndefined()
  })

  test("active editors expire quickly by heartbeat age", blockProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Expire presence",
    })
    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })

    const active = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(active).toHaveLength(1)

    const expired = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
      now: active[0].lastActiveAt + 46_000,
    })
    expect(expired).toEqual([])
  })

  test.each([
    ["presence", api.cms.pages.leavePagePresence],
    ["lock", api.cms.pages.releasePageEditorLock],
  ] as const)(
    "signed-out %s cleanup is a no-op; authenticated cleanup stays owner-scoped",
    blockProfile([]),
    async (_kind, cleanup) => {
      const t = pageTest()
      const owner = t.withIdentity(TEST_USER)
      const pageId = await owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        title: "Cleanup boundary",
      })
      await owner.mutation(api.cms.pages.heartbeatPageEditor, { pageId })
      const foreign = await t.run(async (ctx) => {
        const now = Date.now()
        return {
          presence: await ctx.db.insert("pagePresence", {
            pageId,
            userId: "previous-owner",
            lastActiveAt: now,
            updatedAt: now,
          }),
          lock: await ctx.db.insert("pageEditorLocks", {
            pageId,
            userId: "previous-owner",
            acquiredAt: now,
            lastActiveAt: now,
            updatedAt: now,
          }),
        }
      })
      const snapshot = () =>
        t.run(async (ctx) => ({
          page: await ctx.db.get("pages", pageId),
          presence: await ctx.db.query("pagePresence").collect(),
          locks: await ctx.db.query("pageEditorLocks").collect(),
          shared: await ctx.db.query("pageSharedDrafts").collect(),
          localized: await ctx.db.query("pageLocaleDrafts").collect(),
        }))
      const before = await snapshot()
      await expect(t.mutation(cleanup, { pageId })).resolves.toBeNull()
      expect(await snapshot()).toEqual(before)
      await expect(
        t
          .withIdentity({ subject: "unrelated-owner" })
          .mutation(cleanup, { pageId })
      ).rejects.toThrow("CMS_OWNER_REQUIRED")
      expect(await snapshot()).toEqual(before)
      await expect(owner.mutation(cleanup, { pageId })).resolves.toBeNull()
      const after = await snapshot()
      expect(after.page).toEqual(before.page)
      expect(after.shared).toEqual(before.shared)
      expect(after.localized).toEqual(before.localized)
      if (_kind === "presence") {
        expect(after.presence.map((row) => row._id)).toEqual([foreign.presence])
        expect(after.locks).toEqual(before.locks)
      } else {
        expect(after.locks.map((row) => row._id)).toEqual([foreign.lock])
        expect(after.presence).toEqual(before.presence)
      }
    }
  )

  test("leaving the editor removes the user's presence", blockProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Leave presence",
    })
    await asOwner.mutation(api.cms.pages.touchPagePresence, { pageId })
    await asOwner.mutation(api.cms.pages.leavePagePresence, { pageId })

    const editors = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors).toEqual([])
  })

  // The editor beats ONE mutation, not two. Each beat reads the whole page
  // document to permission-check, and `pages` rows carry every block body for
  // every locale — so merging halves the database I/O of an open editor tab,
  // which is the tightest Convex free-plan limit.
  test("one heartbeat establishes both presence and the lock", blockProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Merged heartbeat",
    })

    await expect(
      asOwner.mutation(api.cms.pages.heartbeatPageEditor, { pageId })
    ).resolves.toMatchObject({
      status: "acquired",
      lock: expect.objectContaining({ userId: TEST_USER.subject }),
    })

    const editors = await asOwner.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors.map((editor) => editor.email)).toEqual([undefined])

    await expect(
      asOwner.query(api.cms.pages.getPageEditorLock, { pageId })
    ).resolves.toMatchObject({ status: "locked", isMine: true })
  })

  test("soft lock can be acquired and refreshed by the owner", blockProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Acquire lock",
    })

    await expect(
      asOwner.mutation(api.cms.pages.acquirePageEditorLock, { pageId })
    ).resolves.toMatchObject({
      status: "acquired",
      lock: expect.objectContaining({ userId: TEST_USER.subject }),
    })
    await expect(
      asOwner.query(api.cms.pages.getPageEditorLock, { pageId })
    ).resolves.toMatchObject({
      status: "locked",
      isMine: true,
      lock: expect.objectContaining({ userId: TEST_USER.subject }),
    })

    await asOwner.mutation(api.cms.pages.acquirePageEditorLock, { pageId })
    const lock = await asOwner.query(api.cms.pages.getPageEditorLock, {
      pageId,
    })
    expect(lock.status).toBe("locked")
    expect(lock.lock?.email).toBeUndefined()
  })

  test("soft lock expires by last active time", blockProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Expire lock",
    })
    await asOwner.mutation(api.cms.pages.acquirePageEditorLock, { pageId })

    const current = await asOwner.query(api.cms.pages.getPageEditorLock, {
      pageId,
    })
    expect(current.status).toBe("locked")
    expect(
      await asOwner.query(api.cms.pages.getPageEditorLock, {
        pageId,
        now: (current.lock?.lastActiveAt ?? 0) + 91_000,
      })
    ).toEqual({ status: "available", lock: null, isMine: false })
  })

  test("releasing a soft lock clears only the owner lock", blockProfile([]), async () => {
    const t = pageTest()
    const asOwner = t.withIdentity(TEST_USER)

    const pageId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Release lock",
    })
    await asOwner.mutation(api.cms.pages.acquirePageEditorLock, { pageId })
    await asOwner.mutation(api.cms.pages.releasePageEditorLock, { pageId })

    await expect(
      asOwner.query(api.cms.pages.getPageEditorLock, { pageId })
    ).resolves.toEqual({ status: "available", lock: null, isMine: false })
  })
})

// Frozen Team collaboration evidence; re-home under T01/T02 without
// weakening it into Community owner-only assertions. Each of these three
// needs a second concurrent editor identity, which fresh Community — one
// durable owner, no members — cannot produce.
describe.skip("pages — multi-editor presence", () => {
  const EDITOR_A = {
    subject: "editor-a",
    name: "Alex Editor",
    email: "alex@example.com",
  }
  const EDITOR_B = {
    subject: "editor-b",
    name: "Blair Editor",
    email: "blair@example.com",
  }

  test("heartbeat lists active editors for a page", async () => {
    const t = pageTest()
    const asAlex = t.withIdentity(EDITOR_A)
    const asBlair = t.withIdentity(EDITOR_B)

    const pageId = await asAlex.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Presence",
    })

    await asAlex.mutation(api.cms.pages.touchPagePresence, { pageId })
    await asBlair.mutation(api.cms.pages.touchPagePresence, { pageId })

    const editors = await asAlex.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors.map((editor) => editor.email).sort()).toEqual([
      "alex@example.com",
      "blair@example.com",
    ])
  })

  test("a heartbeat never steals another editor's lock", async () => {
    const t = pageTest()
    const asAlex = t.withIdentity(EDITOR_A)
    const asBlair = t.withIdentity(EDITOR_B)

    const pageId = await asAlex.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Heartbeat never forces",
    })

    await asAlex.mutation(api.cms.pages.heartbeatPageEditor, { pageId })

    // Blair's heartbeat must report blocked, not take over — displacing an
    // editor is an explicit action routed through `acquirePageEditorLock`.
    await expect(
      asBlair.mutation(api.cms.pages.heartbeatPageEditor, { pageId })
    ).resolves.toMatchObject({
      status: "blocked",
      lock: { email: "alex@example.com" },
    })

    // Blair still registers as present even though the lock was refused.
    const editors = await asBlair.query(api.cms.pages.listActiveEditors, {
      pageId,
    })
    expect(editors.map((editor) => editor.email).sort()).toEqual([
      "alex@example.com",
      "blair@example.com",
    ])
  })

  test("soft lock blocks another editor until takeover", async () => {
    const t = pageTest()
    const asAlex = t.withIdentity(EDITOR_A)
    const asBlair = t.withIdentity(EDITOR_B)

    const pageId = await asAlex.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Takeover lock",
    })
    await asAlex.mutation(api.cms.pages.acquirePageEditorLock, { pageId })

    await expect(
      asBlair.mutation(api.cms.pages.acquirePageEditorLock, { pageId })
    ).resolves.toMatchObject({
      status: "blocked",
      lock: { email: "alex@example.com" },
    })

    await expect(
      asBlair.mutation(api.cms.pages.acquirePageEditorLock, {
        pageId,
        force: true,
      })
    ).resolves.toMatchObject({
      status: "acquired",
      lock: { email: "blair@example.com" },
    })
    await expect(
      asBlair.query(api.cms.pages.getPageEditorLock, { pageId })
    ).resolves.toMatchObject({
      status: "locked",
      isMine: true,
      lock: { email: "blair@example.com" },
    })
  })
})

function legacyIdentityHeroBlock(id: string, title: string): Block {
  return {
    id,
    type: "hero-agency",
    enabled: true,
    primary: { eyebrow: "Agency", title, description: canonicalBody("Copy") },
    items: [],
  }
}

function identityHeroBlock(id: string, title: string): Block {
  const raw = legacyIdentityHeroBlock(id, title)
  return {
    ...raw,
    primary: { ...raw.primary, description: canonicalBody("Copy") },
  } as Block
}

const INVALID_BLOCK_IDENTITY_ERROR =
  "Each block on a page must have its own non-empty ID. Refresh the editor and save again."

describe("pages — sibling Block identity", () => {
  async function draftPage(site: BootstrappedSite) {
    return site.owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "identity-page",
      title: "Identity",
      content: { en: { title: "Identity", blocks: [] } },
    })
  }
  const saveEnglish = (
    site: BootstrappedSite,
    pageId: Id<"pages">,
    blocks: Block[]
  ) =>
    site.owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      localized: {
        locale: "en",
        slug: "identity-page",
        expectedGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: "Identity" },
          blocks,
        },
      },
    })

  test("allows the same Block ID in independent locale lists", blockProfile(["hero-agency"]), async () => {
    const site = await bootstrappedSite("en", "fr")
    const localizedBlock = identityHeroBlock("locale-local", "Localized")
    const pageId = await draftPage(site)
    await saveEnglish(site, pageId, [localizedBlock])

    await expect(
      site.owner.mutation(api.cms.publication.saveLocaleDraft, {
        pageId,
        locale: "fr",
        slug: "identity-page",
        expectedDraftGeneration: 0,
        expectedLifecycleGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: "Français" },
          blocks: [localizedBlock],
        },
      })
    ).resolves.toBeDefined()
  })

  test("rejects duplicate sibling Block IDs on create and on save", blockProfile(["hero-agency"]), async () => {
    const site = await bootstrappedSite()
    const duplicateBlock = identityHeroBlock("duplicate-block", "Duplicate")

    await expect(
      site.owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        title: "Duplicate blocks",
        content: {
          en: {
            title: "Duplicate blocks",
            blocks: [duplicateBlock, duplicateBlock],
          },
        },
      })
    ).rejects.toThrow(INVALID_BLOCK_IDENTITY_ERROR)

    const pageId = await draftPage(site)
    await expect(
      saveEnglish(site, pageId, [duplicateBlock, duplicateBlock])
    ).rejects.toThrow(INVALID_BLOCK_IDENTITY_ERROR)
  })

  test("rejects empty sibling Block IDs on the live editor save path", blockProfile(["hero-agency"]), async () => {
    const site = await bootstrappedSite()
    const pageId = await draftPage(site)

    await expect(
      saveEnglish(site, pageId, [identityHeroBlock("   ", "Editor identity")])
    ).rejects.toThrow(INVALID_BLOCK_IDENTITY_ERROR)
  })
})

/**
 * C7 rerouted the byline projection through the central
 * `resolveReferenceCardForDoc` resolver + a new author `imageMediaId` on
 * `ReferenceCard`. The pre-C7 856-test baseline never exercised
 * `getPublicByline` directly; the browser was the only gate on the projection
 * shape and the "draft author never leaks through a published post" invariant
 * (ADR-0037 §4). These tests turn that browser gate into a deterministic one.
 */
describe("pages — getPublicByline (C7)", () => {
  async function newAuthor(
    site: BootstrappedSite,
    locales: Record<string, { title: string; roleTitle?: string }>,
    slug = "jean-dupont"
  ) {
    const [defaultLocale] = Object.keys(locales)
    const { title, roleTitle } = locales[defaultLocale!]!
    const pageId = await site.owner.mutation(api.cms.pages.create, {
      slug,
      pageType: "author",
      status: "draft",
      name: "Jean Dupont",
      title,
      defaultLocale,
      content: { [defaultLocale!]: { title, blocks: [] } },
    })
    if (roleTitle)
      await site.owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: defaultLocale!,
          slug,
          expectedGeneration: 1,
          draft: {
            pageType: "author",
            localized: { title, roleTitle },
            blocks: [],
          },
        },
      })
    return pageId
  }
  const byline = (site: BootstrappedSite, id: Id<"pages">, locale: string) =>
    site.t.query(api.cms.pages.getPublicByline, {
      languageVersion: site.languageVersion,
      authorPageId: id,
      locale,
    })

  test("published author with locale roleTitle → {name, roleTitle, avatarUrl}", whenActive(blockProfile([]), authorActive), async () => {
    const site = await bootstrappedSite()
    const authorId = await newAuthor(site, {
      en: { title: "Jean Dupont", roleTitle: "Senior Editor" },
    })
    await publishNow(site.t, site.owner, authorId)
    expect(await byline(site, authorId, "en")).toEqual({
      name: "Jean Dupont",
      roleTitle: "Senior Editor",
      avatarUrl: null,
    })
  })

  test("[locale] roleTitle missing stays absent instead of borrowing another locale", whenActive(blockProfile([]), authorActive), async () => {
    const site = await bootstrappedSite("fr", "en")
    const authorId = await newAuthor(site, {
      fr: { title: "Jean Dupont", roleTitle: "Rédacteur en chef" },
    })
    await site.owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: authorId,
      locale: "en",
      slug: "jean-dupont",
      expectedDraftGeneration: 0,
      expectedLifecycleGeneration: 1,
      draft: {
        pageType: "author",
        localized: { title: "Jean Dupont" },
        blocks: [],
      },
    })
    await publishNow(site.t, site.owner, authorId, "fr")
    await publishNow(site.t, site.owner, authorId, "en")
    const result = await byline(site, authorId, "en")
    expect(result?.name).toBe("Jean Dupont")
    expect(result?.roleTitle).toBeUndefined()
    expect(result?.avatarUrl).toBeNull()
  })

  test("draft author → null (no draft leaks through a published post's byline)", whenActive(blockProfile([]), authorActive), async () => {
    const site = await bootstrappedSite()
    const authorId = await newAuthor(site, {
      en: { title: "Draft Author" },
    }, "draft-author")
    expect(await byline(site, authorId, "en")).toBeNull()
  })

  test("soft-deleted author → null", whenActive(blockProfile([]), authorActive), async () => {
    const site = await bootstrappedSite()
    const authorId = await newAuthor(site, {
      en: { title: "Trashed Author" },
    }, "trashed-author")
    await publishNow(site.t, site.owner, authorId)
    expect(await byline(site, authorId, "en")).not.toBeNull()
    await site.owner.mutation(api.cms.publication.archivePage, {
      pageId: authorId,
      expectedLifecycleGeneration: 1,
    })
    await site.owner.mutation(api.cms.publication.softDeletePage, {
      pageId: authorId,
      expectedLifecycleGeneration: 2,
    })
    expect(await byline(site, authorId, "en")).toBeNull()
  })

  test("non-author target → null", blockProfile([]), async () => {
    const site = await bootstrappedSite()
    const pageId = await site.owner.mutation(api.cms.pages.create, {
      slug: "not-an-author",
      pageType: "page",
      status: "draft",
      title: "Not An Author",
      content: { en: { title: "Not An Author", blocks: [] } },
    })
    await publishNow(site.t, site.owner, pageId)
    expect(await byline(site, pageId, "en")).toBeNull()
  })
})

describe("pages — descriptor-shaped save (C8)", () => {
  async function newAuthor(site: BootstrappedSite, name: string, slug: string) {
    return site.owner.mutation(api.cms.pages.create, {
      pageType: "author",
      status: "draft",
      slug,
      title: name,
      name,
      content: { en: { title: name, blocks: [] } },
    })
  }
  const sharedGeneration = (site: BootstrappedSite, pageId: Id<"pages">) =>
    site.t.run(async (ctx) => {
      const row = await ctx.db
        .query("pageSharedDrafts")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      return row!.generation
    })
  async function saveShared(
    site: BootstrappedSite,
    pageId: Id<"pages">,
    fields: { sharedFieldsJson?: string; authorIds?: Id<"pages">[] }
  ) {
    return site.owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration: await sharedGeneration(site, pageId),
      expectedLifecycleGeneration: 1,
      ...fields,
    })
  }
  const edited = async (site: BootstrappedSite, pageId: Id<"pages">) =>
    (await site.owner.query(api.cms.pages.getForEdit, { id: pageId }))!.page as
      unknown as {
        name?: string
        socials?: { platform: string; url: string }[]
        content?: Record<string, { roleTitle?: string }>
      }

  test("a draft written for a different page type is refused and nothing is stored", blockProfile([]), async () => {
    const site = await bootstrappedSite()
    const pageId = await site.owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "typed-page",
      title: "Typed page",
      content: { en: { title: "Typed page", blocks: [] } },
    })
    await expect(
      site.owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug: "typed-page",
          expectedGeneration: 1,
          draft: {
            pageType: "page",
            localized: { title: "Wrong type" },
            blocks: [],
          },
        },
      })
    ).rejects.toThrow("PAGE_TYPE_MISMATCH")
    const states = await site.t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", pageId).eq("locale", "en")
        )
        .unique()
    )
    expect(states?.draftGeneration).toBe(1)
  })

  test("a shared field the page type does not have is refused", blockProfile([]), async () => {
    const site = await bootstrappedSite()
    const pageId = await site.owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "shared-page",
      title: "Shared page",
      content: { en: { title: "Shared page", blocks: [] } },
    })
    await expect(
      saveShared(site, pageId, {
        sharedFieldsJson: JSON.stringify({ notAField: "x" }),
      })
    ).rejects.toThrow("SHARED_FIELD_INVALID")
    expect(await sharedGeneration(site, pageId)).toBe(1)
  })

  test("clearing an optional localized field round-trips (author roleTitle: '' → omitted from the draft)", whenActive(blockProfile([]), authorActive), async () => {
    const site = await bootstrappedSite()
    const authorId = await newAuthor(site, "Ada Lovelace", "ada-lovelace")
    const saveRoleTitle = (roleTitle: string, expectedGeneration: number) =>
      site.owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId: authorId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug: "ada-lovelace",
          expectedGeneration,
          draft: {
            pageType: "author",
            localized: { title: "Ada Lovelace", roleTitle },
            blocks: [],
          },
        },
      })
    await saveRoleTitle("Mathematician", 1)
    expect((await edited(site, authorId)).content?.en?.roleTitle).toBe(
      "Mathematician"
    )

    // An empty string clears the field. The draft may keep the empty text,
    // but the published language content never carries it.
    await saveRoleTitle("", 2)
    expect((await edited(site, authorId)).content?.en?.roleTitle).toBeFalsy()
    await publishNow(site.t, site.owner, authorId)
    const byline = await site.t.query(api.cms.pages.getPublicByline, {
      languageVersion: site.languageVersion,
      authorPageId: authorId,
      locale: "en",
    })
    expect(byline).toMatchObject({ name: "Ada Lovelace" })
    expect(byline?.roleTitle).toBeUndefined()
  })

  test("author name and socials save through the shared draft, and an empty list clears the socials", whenActive(blockProfile([]), authorActive), async () => {
    const site = await bootstrappedSite()
    const authorId = await newAuthor(site, "Original", "original")
    await saveShared(site, authorId, {
      sharedFieldsJson: JSON.stringify({
        name: "Renamed via save",
        socials: [{ platform: "GitHub", url: "https://github.com/x" }],
      }),
    })
    const saved = await edited(site, authorId)
    expect(saved.name).toBe("Renamed via save")
    expect(saved.socials).toMatchObject([
      { platform: "GitHub", url: "https://github.com/x" },
    ])

    await saveShared(site, authorId, {
      sharedFieldsJson: JSON.stringify({ socials: [] }),
    })
    expect((await edited(site, authorId)).socials ?? []).toEqual([])
  })

  test("post byline add-then-clear-then-add lifecycle keeps the stored references honest", whenActive(blockProfile([]), postActive && authorActive), async () => {
    const site = await bootstrappedSite()
    const author1 = await newAuthor(site, "Author One", "author-one")
    const author2 = await newAuthor(site, "Author Two", "author-two")
    const postId = await site.owner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      slug: "live-post",
      title: "Live post",
      content: { en: { title: "Live post", blocks: [] } },
    })
    const sharedRefs = () =>
      site.t.run((ctx) =>
        ctx.db
          .query("pagePublicationDocumentReferences")
          .withIndex("by_pageId_and_sourceKind", (q) =>
            q.eq("pageId", postId).eq("sourceKind", "shared_draft")
          )
          .collect()
      )
    expect(await sharedRefs()).toHaveLength(0)

    // Add a byline: one reference to author one.
    await saveShared(site, postId, { authorIds: [author1] })
    const afterAdd = await sharedRefs()
    expect(afterAdd).toHaveLength(1)
    expect(afterAdd[0]!.targetId).toBe(author1)

    // Clear it: no reference left.
    await saveShared(site, postId, { authorIds: [] })
    expect(await sharedRefs()).toHaveLength(0)

    // Add a different byline: one reference to author two.
    await saveShared(site, postId, { authorIds: [author2] })
    const afterReadd = await sharedRefs()
    expect(afterReadd).toHaveLength(1)
    expect(afterReadd[0]!.targetId).toBe(author2)
  })
})

/**
 * Plan 029 C9b — descriptor row-level shared-field archival on
 * `pageRevisions.sharedFieldsJson`, drift-tolerant reader, null-as-clear
 * restore. ADR-0029 heterogeneous-by-design: legacy revisions with the
 * field absent restore safely.
 */

test.each([0, -1, 13, 1.5])("snapshot recent cards reject invalid limit %s before index reads", blockProfile([]), async (limit) => {
  const t = pageTest()
  await t.run(async (ctx) => {
    const authority = await ctx.db.query("pagePublicationCutover").unique()
    if (authority) await ctx.db.patch("pagePublicationCutover", authority._id, { phase: "snapshot_active" })
  })
  await expect(t.query(api.cms.pages.listRecentPublicRelationCards, {
    languageVersion: 0, pageType: "post", locale: "en", limit,
  })).rejects.toThrow("integer from 1 to 12")
})

test("a menu link to the home page renders / and /fr", blockProfile([]), async () => {
  const { t, owner, languageVersion } = await bootstrappedSite("en", "fr")
  const config = await owner.query(api.cms.settings.getSiteConfig, {})
  const homeId = config.homePageId!
  expect(homeId).toBeTruthy()

  for (const [locale, slug] of [
    ["en", "home"],
    ["fr", "accueil"],
  ] as const) {
    const state = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", homeId).eq("locale", locale)
        )
        .unique()
    )
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: homeId,
      locale,
      slug,
      expectedDraftGeneration: state?.draftGeneration ?? 0,
      expectedLifecycleGeneration: 1,
      draft: {
        pageType: "landing-page",
        localized: { title: locale === "en" ? "Home" : "Accueil" },
        blocks: [],
      },
    })
    await publishNow(t, owner, homeId, locale)
  }

  const nav = [
    {
      id: "home",
      label: { en: "Home", fr: "Accueil" },
      target: { type: "internal" as const, pageId: homeId },
    },
  ]
  await owner.mutation(api.cms.menus.saveCanonical, {
    slug: "primary",
    locale: "en",
    nav: [{ ...nav[0]!, label: { en: "Home" } }],
  })
  await owner.mutation(api.cms.menus.saveCanonical, {
    slug: "primary",
    locale: "fr",
    nav,
  })

  for (const [locale, href] of [
    ["en", "/"],
    ["fr", "/fr"],
  ] as const) {
    const menu = await t.query(api.cms.menus.getWithResolvedLinks, {
      slug: "primary",
      locale,
      languageVersion,
    })
    expect(menu?.nav).toHaveLength(1)
    expect(menu?.nav[0]?.target).toEqual({ type: "internal", url: href })
  }
})

test("a French-default site menu links home to / and English home to /en", blockProfile([]), async () => {
  const { t, owner, languageVersion } = await bootstrappedSite("fr", "en")
  const config = await owner.query(api.cms.settings.getSiteConfig, {})
  const homeId = config.homePageId!
  expect(homeId).toBeTruthy()

  for (const [locale, slug] of [
    ["fr", "accueil"],
    ["en", "home"],
  ] as const) {
    const state = await t.run((ctx) =>
      ctx.db
        .query("pageLocalePublicationStates")
        .withIndex("by_pageId_and_locale", (q) =>
          q.eq("pageId", homeId).eq("locale", locale)
        )
        .unique()
    )
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: homeId,
      locale,
      slug,
      expectedDraftGeneration: state?.draftGeneration ?? 0,
      expectedLifecycleGeneration: 1,
      draft: {
        pageType: "landing-page",
        localized: { title: locale === "en" ? "Home" : "Accueil" },
        blocks: [],
      },
    })
    await publishNow(t, owner, homeId, locale)
  }

  const nav = [
    {
      id: "home",
      label: { en: "Home", fr: "Accueil" },
      target: { type: "internal" as const, pageId: homeId },
    },
  ]
  await owner.mutation(api.cms.menus.saveCanonical, {
    slug: "primary",
    locale: "fr",
    nav: [{ ...nav[0]!, label: { fr: "Accueil" } }],
  })
  await owner.mutation(api.cms.menus.saveCanonical, {
    slug: "primary",
    locale: "en",
    nav,
  })

  for (const [locale, href] of [
    ["fr", "/"],
    ["en", "/en"],
  ] as const) {
    const menu = await t.query(api.cms.menus.getWithResolvedLinks, {
      slug: "primary",
      locale,
      languageVersion,
    })
    expect(menu?.nav).toHaveLength(1)
    expect(menu?.nav[0]?.target).toEqual({ type: "internal", url: href })
  }
})

// Round A: exercise the same successor and menu writers as a fresh FR site.
// The explicit-admin harness establishes only the authenticated owner binding;
// publication authority and language setup below are ordinary UI commands.
describe("menu picker successor writer seam", () => {
  async function pickerSite() {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: TEST_USER,
      publicationAuthority: "missing",
      transactionLimits: { databaseQueries: 2048, documentsRead: 32000, bytesRead: 16 * 1024 * 1024 },
    })
    const owner = t.withIdentity(TEST_USER)
    await owner.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Menu picker",
      timezone: "UTC",
      defaultLocale: "fr",
    })
    const changes = [{ moduleId: "multilingual", enabled: true }]
    const preview = await owner.query(api.cms.modules.preview, { changes })
    await owner.mutation(api.cms.modules.commit, {
      changes,
      expectedConfigurationVersion: preview.configurationVersion,
    })
    const { commandTokens } = await owner.query(
      api.cms.multilingual.getMultilingualState,
      {}
    )
    if (commandTokens.settingsUpdatedAt === null) throw new Error("Missing bootstrapped settings")
    const added = await owner.mutation(api.cms.multilingual.addSiteLanguage, {
      locale: "en",
      expectedSettingsUpdatedAt: commandTokens.settingsUpdatedAt,
      expectedModuleConfigurationVersion:
        commandTokens.moduleConfigurationVersion,
      expectedAuthorityVersion: commandTokens.authorityVersion,
    })
    expect(added.ok).toBe(true)
    return { t, owner }
  }
  type PickerSite = Awaited<ReturnType<typeof pickerSite>>
  async function newPage(
    owner: PickerSite["owner"],
    slug: string,
    english = true
  ) {
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      defaultLocale: "fr",
      slug,
      title: "Initial FR",
    })
    await owner.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      localized: {
        locale: "fr",
        slug,
        expectedGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: `Titre ${slug}` },
          blocks: [],
        },
      },
    })
    if (english)
      await owner.mutation(api.cms.publication.saveLocaleDraft, {
        pageId,
        locale: "en",
        slug: `english-${slug}`,
        expectedDraftGeneration: 0,
        expectedLifecycleGeneration: 1,
        draft: {
          pageType: "landing-page",
          localized: { title: `English ${slug}` },
          blocks: [],
        },
      })
    return pageId
  }
  const publishFr = (owner: PickerSite["owner"], pageId: Id<"pages">) =>
    owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "fr",
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })

  test.each(["fr", "en"])("link picker paths include localized ancestry and keep home words: %s", async (locale) => {
    const { t, owner } = await pickerSite()
    const parentId = await newPage(owner, "parent")
    for (const lang of ["fr", "en"]) await publishNow(t, owner, parentId, lang)
    const pageId = await newPage(owner, "child")
    await owner.mutation(api.cms.publication.saveSharedDraft, {
      pageId,
      expectedSharedDraftGeneration: 1,
      expectedLifecycleGeneration: 1,
      parentId,
    })
    const path = locale === "fr" ? "/parent/child" : "/english-parent/english-child"
    const draftRows = await owner.query(api.cms.pages.listLinkablePages, { locale })
    expect(draftRows.find((row) => row._id === pageId)).toHaveProperty("path", path)
    await publishNow(t, owner, pageId, locale)
    const publishedRows = await owner.query(api.cms.pages.listLinkablePages, { locale, includeDrafts: false })
    expect(publishedRows.find((row) => row._id === pageId)).toHaveProperty("path", path)
    // Published addresses remain authoritative when a Working Draft is renamed.
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId, locale, slug: "new-child",
      expectedDraftGeneration: locale === "fr" ? 2 : 1,
      expectedLifecycleGeneration: 1,
      draft: { pageType: "landing-page", localized: { title: "Renamed child" }, blocks: [] },
    })
    const renamedRows = await owner.query(api.cms.pages.listLinkablePages, { locale, search: path })
    expect(renamedRows.find((row) => row._id === pageId)).toHaveProperty("path", path)
    const settings = await t.run((ctx) => ctx.db.query("siteSettings").unique())
    const homeId = settings!.homePageId!
    const homeState = await t.run((ctx) => ctx.db.query("pageLocalePublicationStates")
      .withIndex("by_pageId_and_locale", (q) => q.eq("pageId", homeId).eq("locale", locale))
      .unique())
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId: homeId, locale, slug: locale === "fr" ? "accueil" : "home",
      expectedDraftGeneration: homeState?.draftGeneration ?? 0, expectedLifecycleGeneration: 1,
      draft: { pageType: "landing-page", localized: { title: "Home" }, blocks: [] },
    })
    await publishNow(t, owner, homeId, locale)
    const homeRows = await owner.query(api.cms.pages.listLinkablePages, { locale })
    expect(homeRows.find((row) => row._id === homeId)).toHaveProperty("path", locale === "fr" ? "/accueil" : "/home")
  })

  test.runIf(isActiveContentType("author"))("link picker paths include the content type prefix in both locales", async () => {
    const { t, owner } = await pickerSite()
    const pageId = await owner.mutation(api.cms.pages.create, {
      pageType: "author", status: "draft", slug: "ada", title: "Ada", name: "Ada", defaultLocale: "fr",
      content: { fr: { title: "Ada", blocks: [] }, en: { title: "Ada EN", blocks: [] } },
    })
    await owner.mutation(api.cms.publication.saveLocaleDraft, {
      pageId, locale: "en", slug: "ada-en", expectedDraftGeneration: 1, expectedLifecycleGeneration: 1,
      draft: { pageType: "author", localized: { title: "Ada EN" }, blocks: [] },
    })
    for (const locale of ["fr", "en"]) {
      const path = locale === "fr" ? "/authors/ada" : "/authors/ada-en"
      const draftRows = await owner.query(api.cms.pages.listLinkablePages, { locale })
      expect(draftRows.find((row) => row._id === pageId)).toHaveProperty("path", path)
      await publishNow(t, owner, pageId, locale)
      const publishedRows = await owner.query(api.cms.pages.listLinkablePages, { locale, includeDrafts: false })
      expect(publishedRows.find((row) => row._id === pageId)).toHaveProperty("path", path)
    }
  })

  for (const incomplete of ["blank-title"] as const) {
    test.each(["list", "selection"] as const)(
      `picker_keeps_page_when_one_locale_draft_is_blank: ${incomplete} %s`,
      async (endpoint) => {
        const { owner } = await pickerSite()
        const pageId = await newPage(owner, "fr-published", false)
        await publishFr(owner, pageId)
        await owner.mutation(api.cms.publication.saveLocaleDraft, {
          pageId,
          locale: "en",
          slug: "english-draft",
          expectedDraftGeneration: 0,
          expectedLifecycleGeneration: 1,
          draft: {
            pageType: "landing-page",
            localized: { title: "   " },
            blocks: [],
          },
        })
        const rows = endpoint === "list"
          ? await owner.query(api.cms.pages.listLinkablePages, { locale: "fr" })
          : await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
              .then((result) => result.status === "available" ? [result.page] : [])
        const row = rows.find((candidate) => candidate._id === pageId)
        expect(row).toBeDefined()
        expect(row!.localizedTitles).toEqual({ fr: "Titre fr-published" })
        expect(row!.localizedSlugs).toEqual({ fr: "fr-published" })
        expect(row!.localePublicationStates).toEqual({ fr: "published", en: "draft" })
      }
    )
  }

  test.each(["fr", "en"])(
    "picker_from_real_successor_drafts: %s list, search, selection and public resolution",
    async (locale) => {
      const { t, owner } = await pickerSite()
      const pageId = await newPage(owner, "cible")
      await publishFr(owner, pageId)
      const other = await newPage(owner, "sans-traduction", false)
      for (const endpoint of ["list", "selection"] as const) {
        const rows =
          endpoint === "list"
            ? await owner.query(api.cms.pages.listLinkablePages, {
                locale,
                limit: 100,
              })
            : await owner
                .query(api.cms.pages.getLinkablePageSelection, { pageId })
                .then((r) => (r.status === "available" ? [r.page] : []))
        const row = rows.find((r) => r._id === pageId)!
        expect(row).toMatchObject({
          slug: "cible",
          localizedSlugs: { en: "english-cible" },
          localizedTitles: { fr: "Titre cible", en: "English cible" },
          localePublicationStates: { fr: "published", en: "draft" },
        })
      }
      for (const search of [
        locale === "fr" ? "Titre cible" : "English cible",
        locale === "fr" ? "cible" : "english-cible",
      ]) {
        expect(
          (
            await owner.query(api.cms.pages.listLinkablePages, {
              locale,
              search,
            })
          ).map((r) => r._id)
        ).toContain(pageId)
      }
      const published = await owner.query(api.cms.pages.listLinkablePages, {
        locale,
        includeDrafts: false,
      })
      expect(published.some((r) => r._id === pageId)).toBe(locale === "fr")
      expect(
        (
          await owner.query(api.cms.pages.listLinkablePages, { locale: "en" })
        ).some((r) => r._id === other)
      ).toBe(false)
      await owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "fr",
          slug: "cible-modifiee",
          expectedGeneration: 2,
          draft: {
            pageType: "landing-page",
            localized: { title: "Titre modifié" },
            blocks: [],
          },
        },
      })
      expect(
        await owner.query(api.cms.pages.listLinkablePages, {
          locale: "fr",
          includeDrafts: false,
          search: "modifié",
        })
      ).toEqual([
        expect.objectContaining({
          _id: pageId,
          localePublicationStates: { fr: "published", en: "draft" },
        }),
      ])
      const nav = [
        {
          id: "target",
          label: { fr: "Cible", en: "Target" },
          target: { type: "internal" as const, pageId },
        },
      ]
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "fr",
        nav: [{ ...nav[0]!, label: { fr: "Cible" } }],
      })
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav,
      })
      expect(
        (await owner.query(api.cms.menus.getCanonical, { slug: "primary" }))
          ?.nav
      ).toEqual(nav)
      const config = await owner.query(api.cms.settings.getSiteConfig, {})
      const resolved = await t.query(api.cms.menus.getWithResolvedLinks, {
        slug: "primary",
        locale,
        languageVersion: config.languageVersion,
      })
      expect(resolved?.nav[0]?.target).toEqual(
        locale === "fr"
          ? { type: "internal", url: "/cible" }
          : { type: "internal" }
      )
      // Discard is a real editor command: now title/slug must come from verified frozen fallback.
      await owner.mutation(api.cms.publication.discardLocaleDraft, {
        pageId,
        locale: "fr",
        expectedDraftGeneration: 3,
        expectedLifecycleGeneration: 1,
      })
      const selected = await owner.query(
        api.cms.pages.getLinkablePageSelection,
        { pageId }
      )
      expect(selected).toMatchObject({
        status: "available",
        page: { localizedTitles: { fr: "Titre cible" }, slug: "cible" },
      })
      expect(
        await owner.query(api.cms.pages.listLinkablePages, {
          locale: "fr",
          search: "Titre cible",
        })
      ).toEqual([expect.objectContaining({ _id: pageId })])
    }
  )

  test("picker lifecycle, type and permission exclusions; archived selection metadata survives", async () => {
    const { owner, t } = await pickerSite()
    const pageId = await newPage(owner, "archive")
    await owner.mutation(api.cms.publication.archivePage, {
      pageId,
      expectedLifecycleGeneration: 1,
    })
    expect(
      await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).toMatchObject({
      status: "available",
      page: { status: "archived", localizedTitles: { fr: "Titre archive" } },
    })
    expect(
      (
        await owner.query(api.cms.pages.listLinkablePages, { locale: "fr" })
      ).some((r) => r._id === pageId)
    ).toBe(false)
    await owner.mutation(api.cms.publication.softDeletePage, {
      pageId,
      expectedLifecycleGeneration: 2,
    })
    expect(
      await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).toEqual({ status: "missing" })
    expect(
      (
        await owner.query(api.cms.pages.listLinkablePages, { locale: "fr" })
      ).some((r) => r._id === pageId)
    ).toBe(false)
    await expect(
      owner.mutation(api.cms.pages.create, {
        pageType: "testimonial",
        status: "draft",
        slug: "excluded",
        title: "Hidden",
      })
    ).rejects.toThrow(/not active/)
    await expect(
      t
        .withIdentity({ subject: "unrelated" })
        .query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).rejects.toThrow(/CMS_OWNER_REQUIRED/)
  })

  test("100 two-locale frozen projections fit the picker query budget", async () => {
    const { owner } = await pickerSite()
    let pageId!: Id<"pages">
    for (let i = 0; i < 100; i++) {
      pageId = await newPage(owner, `budget-${i}`)
      await publishFr(owner, pageId)
      await owner.mutation(api.cms.publication.publishLocale, {
        pageId, locale: "en", expectedDraftGeneration: 1, expectedSharedDraftGeneration: 1,
        expectedPublicGeneration: 0, expectedLifecycleGeneration: 1, expectedReleaseGeneration: 0,
      })
      for (const locale of ["fr", "en"]) await owner.mutation(api.cms.publication.discardLocaleDraft, {
        pageId, locale, expectedDraftGeneration: locale === "fr" ? 2 : 1, expectedLifecycleGeneration: 1,
      })
    }
    // Each transaction is constrained to half the provider's index-range cap.
    const published = await owner.query(api.cms.pages.listLinkablePages, { locale: "fr", includeDrafts: false, limit: 100 })
    expect(published).toHaveLength(100)
    expect(published.every((row) => row.localePublicationStates.fr === "published" && row.localePublicationStates.en === "published")).toBe(true)
    expect(await owner.query(api.cms.pages.listLinkablePages, { limit: 100 })).toHaveLength(100)
    expect(await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })).toMatchObject({ status: "available", page: { localePublicationStates: { fr: "published", en: "published" } } })
  }, 120_000)

  test("catalogExclusionFixture withholds all selected metadata for a now-hidden type", async () => {
    const { owner } = await pickerSite()
    const pageId = await newPage(owner, "catalog-excluded")
    // Model a curated release hiding a previously stored type. Only the
    // catalog dependency changes; every stored row still came from UI writers.
    const index = CONTENT_TYPES.indexOf("landing-page")
    expect(index).toBeGreaterThanOrEqual(0)
    CONTENT_TYPES.splice(index, 1)
    try {
      expect(await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })).toEqual({ status: "unavailable" })
      expect(await owner.query(api.cms.pages.listLinkablePages, { locale: "fr" })).toEqual([])
    } finally { CONTENT_TYPES.splice(index, 0, "landing-page") }
  })

  test("selected IDs resolve beyond both the 100-row and former 400-candidate windows", async () => {
    const { owner } = await pickerSite()
    let pageId!: Id<"pages">
    for (let i = 0; i < 401; i++) {
      pageId = await owner.mutation(api.cms.pages.create, {
        pageType: "landing-page",
        status: "draft",
        defaultLocale: "fr",
        slug: `window-${i}`,
        title: `Window ${i}`,
      })
    }
    expect(
      (
        await owner.query(api.cms.pages.listLinkablePages, {
          locale: "fr",
          limit: 100,
        })
      ).some((r) => r._id === pageId)
    ).toBe(false)
    expect(
      await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).toMatchObject({
      status: "available",
      page: { localizedTitles: { fr: "Window 400" } },
    })
  }, 120_000)

  test("both endpoints reject invalid authority and selection never falls back to legacy content", async () => {
    const { owner, t } = await pickerSite()
    const pageId = await newPage(owner, "missing-state")
    // Fault injection only deletes authority metadata, never content/drafts/snapshots.
    await t.run(async (ctx) => {
      const state = await ctx.db
        .query("pagePublicationPageStates")
        .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
        .unique()
      await ctx.db.delete("pagePublicationPageStates", state!._id)
    })
    expect(
      await owner.query(api.cms.pages.getLinkablePageSelection, { pageId })
    ).toEqual({ status: "unavailable" })
    await t.run(async (ctx) => {
      const authority = await ctx.db.query("pagePublicationCutover").unique()
      await ctx.db.delete("pagePublicationCutover", authority!._id)
    })
    for (const call of [
      () => owner.query(api.cms.pages.listLinkablePages, { locale: "fr" }),
      () => owner.query(api.cms.pages.getLinkablePageSelection, { pageId }),
    ])
      await expect(call()).rejects.toThrow(/PUBLISHED_SNAPSHOT_CUTOVER_INVALID/)
  })

  test.each(["existing-empty", "copy-empty", "missing", "cleared", "typed-cleared"] as const)(
    "decorative_alt_survives_secondary_save_and_copy through real saveCanonical: %s",
    async (mode) => {
      const { t, owner } = await pickerSite()
      const featured = (
        id: string
      ): Extract<
        Extract<NonNullable<NavItem["panel"]>, { columns: number }>["sections"][number],
        { kind: "featured" }
      > => ({
        id,
        kind: "featured",
        heading: { fr: "Titre" },
        image: { url: "https://example.com/image.jpg", alt: { fr: "" } },
        target: { type: "external", url: "https://example.com/feature" },
      })
      const nav: NavItem[] = [
        {
          id: "features",
          label: { fr: "Images" },
          panel: {
            columns: 1,
            sections: [featured("main")],
            footer: { sections: [featured("footer")] },
          },
        },
      ]
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "fr",
        nav,
      })
      const translation = projectLocale(
        nav,
        mode === "existing-empty" || mode === "cleared" ? "fr" : "en",
        "fr"
      )
      translation[0]!.label = "Images EN"
      for (const section of [
        ...legacyPanel(translation[0]!.panel!).sections,
        ...translation[0]!.panel!.footer!.sections,
      ]) {
        section.heading = "Heading"
        if (mode === "cleared" && section.kind === "featured")
          section.image!.alt = "Authored"
        if (mode === "typed-cleared" && section.kind === "featured") {
          Object.assign(section, withAuthoredAlt(section, "Typed before first EN save"))
          Object.assign(section, withAuthoredAlt(section, ""))
        }
      }
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: mergeLocale(nav, "en", translation),
      })
      const loaded = (await owner.query(api.cms.menus.getCanonical, {
        slug: "primary",
      }))!.nav
      const edited = projectLocale(
        loaded,
        mode === "copy-empty" ? "fr" : "en",
        "fr"
      )
      edited[0]!.label = "An unrelated EN edit"
      for (const section of [
        ...legacyPanel(edited[0]!.panel!).sections,
        ...edited[0]!.panel!.footer!.sections,
      ]) {
        if (mode === "cleared" && section.kind === "featured")
          section.image!.alt = ""
      }
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: mergeLocale(loaded, "en", edited),
      })
      const reloaded = (await owner.query(api.cms.menus.getCanonical, {
        slug: "primary",
      }))!.nav
      await owner.mutation(api.cms.menus.saveCanonical, {
        slug: "primary",
        locale: "en",
        nav: mergeLocale(reloaded, "en", projectLocale(reloaded, "en", "fr")),
      })
      const persisted = (await owner.query(api.cms.menus.getCanonical, {
        slug: "primary",
      }))!.nav
      for (const section of [
        ...legacyPanel(persisted[0]!.panel!).sections,
        ...persisted[0]!.panel!.footer!.sections,
      ]) {
        if (section.kind !== "featured") throw new Error("Expected featured")
        expect(Object.hasOwn(section.image!.alt, "en")).toBe(mode !== "missing")
        expect(section.image!.alt.fr).toBe("")
        if (mode !== "missing") expect(section.image!.alt.en).toBe("")
      }
      const config = await owner.query(api.cms.settings.getSiteConfig, {})
      const result = await t.query(api.cms.menus.getWithResolvedLinks, {
        slug: "primary",
        locale: "en",
        languageVersion: config.languageVersion,
      })
      expect(legacyPanel(result?.nav[0]?.panel).sections).toHaveLength(
        mode === "missing" ? 0 : 1
      )
      expect(result?.nav[0]?.panel?.footer?.sections).toHaveLength(
        mode === "missing" ? 0 : 1
      )
    }
  )
  describe("relation pickers read titles and states from snapshots", () => {
    const renameFr = (
      owner: PickerSite["owner"],
      pageId: Id<"pages">,
      title: string,
      pageType: "landing-page" | "author" = "landing-page",
      expectedGeneration = 2
    ) =>
      owner.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "fr",
          slug: "renamed",
          expectedGeneration,
          draft: { pageType, localized: { title }, blocks: [] },
        },
      })

    test("listRelationCandidates returns snapshot titles, states and honours includeDrafts, types, limit and permissions", async () => {
      const { t, owner } = await pickerSite()
      const draftOnly = await newPage(owner, "brouillon", false)
      const published = await newPage(owner, "cible")
      await publishFr(owner, published)

      const all = await owner.query(api.cms.pages.listRelationCandidates, {
        pageTypes: ["landing-page"],
        includeDrafts: true,
      })
      expect(all.find((row) => row._id === draftOnly)).toMatchObject({
        slug: "brouillon",
        localizedTitles: { fr: "Titre brouillon" },
        localePublicationStates: { fr: "draft" },
        status: "draft",
        pageType: "landing-page",
      })
      expect(all.find((row) => row._id === published)).toMatchObject({
        localizedTitles: { fr: "Titre cible", en: "English cible" },
        localePublicationStates: { fr: "published", en: "draft" },
        status: "published",
      })

      // Before the fix this was empty: it selected by the stale `pages.status`.
      const onlyPublished = await owner.query(
        api.cms.pages.listRelationCandidates,
        { pageTypes: ["landing-page"], includeDrafts: false }
      )
      expect(onlyPublished.map((row) => row._id)).toEqual([published])

      await renameFr(owner, draftOnly, "Titre renommé")
      const renamed = await owner.query(api.cms.pages.listRelationCandidates, {
        pageTypes: ["landing-page"],
        includeDrafts: true,
      })
      expect(renamed.find((row) => row._id === draftOnly)?.localizedTitles).toEqual({
        fr: "Titre renommé",
      })

      expect(
        await owner.query(api.cms.pages.listRelationCandidates, {
          pageTypes: ["page"],
          includeDrafts: true,
        })
      ).toEqual([])
      expect(
        await owner.query(api.cms.pages.listRelationCandidates, {
          pageTypes: ["landing-page"],
          includeDrafts: true,
          limit: 1,
        })
      ).toHaveLength(1)
      expect(
        await owner.query(api.cms.pages.listRelationCandidates, {
          pageTypes: ["landing-page"],
          includeDrafts: true,
          tag: "news",
        })
      ).toEqual([])
      await expect(
        t.withIdentity({ subject: "unrelated" }).query(
          api.cms.pages.listRelationCandidates,
          { pageTypes: ["landing-page"], includeDrafts: true }
        )
      ).rejects.toThrow(/CMS_OWNER_REQUIRED/)
    })

    test("listRelationCandidates leaves archived and trashed pages out", async () => {
      const { owner } = await pickerSite()
      const archived = await newPage(owner, "archive", false)
      const trashed = await newPage(owner, "corbeille", false)
      await owner.mutation(api.cms.publication.archivePage, {
        pageId: archived,
        expectedLifecycleGeneration: 1,
      })
      await owner.mutation(api.cms.publication.softDeletePage, {
        pageId: trashed,
        expectedLifecycleGeneration: 1,
      })
      const ids = (
        await owner.query(api.cms.pages.listRelationCandidates, {
          pageTypes: ["landing-page"],
          includeDrafts: true,
        })
      ).map((row) => row._id)
      expect(ids).not.toContain(archived)
      expect(ids).not.toContain(trashed)
    })

    test("searchTargets and getReferenceCard take title and state from the snapshot row", async () => {
      const { owner } = await pickerSite()
      const draftOnly = await newPage(owner, "brouillon", false)
      const published = await newPage(owner, "cible", false)
      await publishFr(owner, published)

      const found = await owner.query(api.cms.relations.searchTargets, {
        pageTypes: ["landing-page"],
        locale: "fr",
        search: "titre cible",
      })
      expect(found).toHaveLength(1)
      expect(found[0]).toMatchObject({ id: published, title: "Titre cible" })
      expect(found[0]!.href).toBeDefined()
      expect(found[0]!.titleFallback).toBeUndefined()

      const draftCard = await owner.query(api.cms.relations.getReferenceCard, {
        id: draftOnly,
        locale: "fr",
      })
      expect(draftCard).toMatchObject({ id: draftOnly, title: "Titre brouillon" })
      expect(draftCard?.href).toBeUndefined()

      await renameFr(owner, draftOnly, "Titre renommé")
      expect(
        (
          await owner.query(api.cms.relations.searchTargets, {
            pageTypes: ["landing-page"],
            locale: "fr",
            search: "renommé",
          })
        ).map((card) => card.id)
      ).toEqual([draftOnly])
      expect(
        (
          await owner.query(api.cms.relations.searchTargets, {
            pageTypes: ["landing-page"],
            locale: "fr",
            search: "brouillon",
          })
        ).length
      ).toBe(0)
      // A language without text shows the translatable fallback, not a stale title.
      expect(
        await owner.query(api.cms.relations.getReferenceCard, {
          id: draftOnly,
          locale: "en",
        })
      ).toMatchObject({ titleFallback: "untitled" })
    })

    test.runIf(authorActive)("an author card shows the current name after a rename", async () => {
      const { owner } = await pickerSite()
      const authorId = await owner.mutation(api.cms.pages.create, {
        pageType: "author",
        status: "draft",
        defaultLocale: "fr",
        slug: "ada",
        title: "Ada",
      })
      await renameFr(owner, authorId, "Ada Lovelace", "author", 1)
      expect(
        await owner.query(api.cms.relations.getReferenceCard, {
          id: authorId,
          locale: "fr",
        })
      ).toMatchObject({ id: authorId, type: "author", title: "Ada Lovelace" })
      expect(
        (
          await owner.query(api.cms.relations.searchTargets, {
            pageTypes: ["author"],
            locale: "fr",
            search: "lovelace",
          })
        ).map((card) => card.title)
      ).toEqual(["Ada Lovelace"])
    })

    test("100 two-locale candidates fit the picker query budget", async () => {
      const { owner } = await pickerSite()
      for (let i = 0; i < 100; i++) await newPage(owner, `budget-${i}`)
      const rows = await owner.query(api.cms.pages.listRelationCandidates, {
        pageTypes: ["landing-page"],
        includeDrafts: true,
        limit: 100,
      })
      expect(rows).toHaveLength(100)
      expect(rows.every((row) => row.localizedTitles.fr && row.localizedTitles.en)).toBe(true)
    }, 120_000)
  })
})

// VISITOR-LIMITS (0.5.1): one anonymous call to an id-batch query does bounded
// work. ID_BATCH_MAX ids per call; the site's own readers split longer lists.
describe("pages — id batch limits", () => {
  const OWNER = {
    subject: "id-batch-owner",
    tokenIdentifier: "id-batch-owner",
    name: "Id Batch Owner",
    email: "owner@example.com",
  }

  async function snapshotSite() {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: OWNER,
      publicationAuthority: "missing",
    })
    migrationsTest.register(t)
    const owner = t.withIdentity(OWNER)
    await owner.mutation(api.cms.publication.initializeEmptySnapshotAuthority, {})
    const homePageId = await owner.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "home",
      title: "Home",
      content: { en: { title: "Home", blocks: [] } },
    })
    await t.run(async (ctx) => {
      await ctx.db.insert("siteSettings", {
        siteName: "Id batch",
        siteUrl: "",
        defaultLocale: "en",
        enabledLocales: ["en"],
        homePageId,
        updatedAt: Date.now(),
      })
    })
    return { t, owner }
  }
  type Site = Awaited<ReturnType<typeof snapshotSite>>

  /** Raw page rows: valid `pages` ids that are not publicly readable. */
  async function insertPageRows(t: Site["t"], count: number) {
    return t.run(async (ctx) => {
      const now = Date.now()
      const ids: Id<"pages">[] = []
      for (let index = 0; index < count; index += 1) {
        ids.push(
          await ctx.db.insert("pages", {
            slug: `id-batch-${index}`,
            pageType: "page",
            status: "published",
            createdAt: now,
            updatedAt: now,
            publishedAt: now,
            content: { en: { title: `Id batch ${index}`, blocks: [] } },
          })
        )
      }
      return ids
    })
  }

  async function createPublished(
    site: Site,
    slug: string,
    parentId?: Id<"pages">
  ) {
    const pageId = await site.owner.mutation(api.cms.pages.create, {
      pageType: "page",
      status: "draft",
      slug,
      title: slug,
      content: { en: { title: slug, blocks: [] } },
      ...(parentId ? { parentId } : {}),
    })
    if (parentId) {
      await site.t.run(async (ctx) => {
        const shared = await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .unique()
        if (shared && shared.system?.parentId !== parentId) {
          await ctx.db.patch("pageSharedDrafts", shared._id, {
            system: { ...(shared.system ?? {}), parentId },
          })
        }
      })
    }
    await site.owner.mutation(api.cms.publication.publishLocale, {
      pageId,
      locale: "en",
      expectedDraftGeneration: 1,
      expectedSharedDraftGeneration: 1,
      expectedPublicGeneration: 0,
      expectedLifecycleGeneration: 1,
      expectedReleaseGeneration: 0,
    })
    return pageId
  }

  const publicArgs = (ids: Id<"pages">[]) => ({
    languageVersion: 0,
    ids,
    locale: "en",
  })

  test("the cap is 50", () => {
    expect(ID_BATCH_MAX).toBe(50)
  })

  describe.each([
    ["getLocalizedPathsByIds", api.cms.pages.getLocalizedPathsByIds],
    ["getPublicRelationCardsByIds", api.cms.pages.getPublicRelationCardsByIds],
  ] as const)("%s (anonymous)", (_name, query) => {
    test("50 distinct ids resolve", async () => {
      const { t } = await snapshotSite()
      const ids = await insertPageRows(t, 51)
      await expect(
        t.query(query, publicArgs(ids.slice(0, 50)))
      ).resolves.toBeTypeOf("object")
    })

    test("51 distinct ids reject with TOO_MANY_IDS", async () => {
      const { t } = await snapshotSite()
      const ids = await insertPageRows(t, 51)
      await expect(t.query(query, publicArgs(ids))).rejects.toThrow(
        /TOO_MANY_IDS/
      )
    })

    test("51 copies of one id reject with TOO_MANY_IDS", async () => {
      const { t } = await snapshotSite()
      const [id] = await insertPageRows(t, 1)
      const copies = Array.from({ length: 51 }, () => id!)
      await expect(t.query(query, publicArgs(copies))).rejects.toThrow(
        /TOO_MANY_IDS/
      )
    })
  })

  describe("getRelationCardsByIds", () => {
    test("the owner resolves 50 ids and 51 reject with TOO_MANY_IDS", async () => {
      const site = await snapshotSite()
      const ids = await insertPageRows(site.t, 51)
      await expect(
        site.owner.query(api.cms.pages.getRelationCardsByIds, {
          ids: ids.slice(0, 50),
          locale: "en",
        })
      ).resolves.toBeTypeOf("object")
      await expect(
        site.owner.query(api.cms.pages.getRelationCardsByIds, {
          ids,
          locale: "en",
        })
      ).rejects.toThrow(/TOO_MANY_IDS/)
    })

    test("an anonymous caller gets the auth error, not the size error", async () => {
      const { t } = await snapshotSite()
      const ids = await insertPageRows(t, 51)
      await expect(
        t.query(api.cms.pages.getRelationCardsByIds, { ids, locale: "en" })
      ).rejects.toThrow(/UNAUTHENTICATED/)
    })
  })

  test("getLocalizedPathsByIds returns nested snapshot paths, once per duplicate id", async () => {
    const site = await snapshotSite()
    const parentId = await createPublished(site, "parent")
    const childId = await createPublished(site, "child", parentId)
    const paths = await site.t.query(
      api.cms.pages.getLocalizedPathsByIds,
      publicArgs([childId, parentId, childId, parentId, childId])
    )
    expect(paths).toEqual({
      [parentId]: "/parent",
      [childId]: "/parent/child",
    })
  })

  test("getLocalizedPathsByIds resolves 40 depth-3 pages, each with its own chain, in one call", { timeout: 60_000 }, async () => {
    const site = await snapshotSite()
    const leaves: Id<"pages">[] = []
    const expected: Record<string, string> = {}
    for (let chain = 0; chain < 40; chain += 1) {
      const g3 = await createPublished(site, `c${chain}-great-grandparent`)
      const g2 = await createPublished(site, `c${chain}-grandparent`, g3)
      const g1 = await createPublished(site, `c${chain}-parent`, g2)
      const leaf = await createPublished(site, `c${chain}-leaf`, g1)
      leaves.push(leaf)
      expected[leaf] =
        `/c${chain}-great-grandparent/c${chain}-grandparent/c${chain}-parent/c${chain}-leaf`
    }
    const paths = await site.t.query(
      api.cms.pages.getLocalizedPathsByIds,
      publicArgs(leaves)
    )
    expect(paths).toEqual(expected)
  })
})

/// <reference types="vite/client" />
import { convexTestWithAuth as convexTest } from "../test-utils/convexAuthFixtures"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import { seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import { isActiveContentType } from "./lib/contentTypes"

const modules = import.meta.glob("./**/*.ts")
/** The one durable Community owner; both identity fields are explicit. */
const OWNER = {
  subject: "u-1",
  tokenIdentifier: "u-1",
  name: "Owner",
  email: "a@x.com",
}

/**
 * Plan 029 C10 task 15 regression: `postContentType.referenceCard()` has
 * returned a `featured` flag since an earlier C10 task, but the shared
 * `referenceCardValidator` behind `getReferenceCard` / `searchTargets`
 * didn't declare the key — every post resolved through these queries had
 * `featured` silently stripped by Convex's return-validator shape check,
 * so no client (present or future) could ever see it.
 */
describe.runIf(isActiveContentType("post"))("reference-card queries surface post.featured", () => {
  test("getReferenceCard includes featured:true for a featured post", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    const asOwner = t.withIdentity(OWNER)

    const now = Date.now()
    const postId = await t.run(async (ctx) =>
      ctx.db.insert("pages", {
        slug: "featured-post",
        pageType: "post",
        status: "published",
        content: { en: { title: "Featured Post", blocks: [] } },
        localizedSlugs: { en: "featured-post" },
        featured: true,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
    )

    const card = await asOwner.query(api.cms.relations.getReferenceCard, {
      id: postId,
      locale: "en",
    })
    expect(card?.featured).toBe(true)
  })

  test("searchTargets includes featured:true for a featured post", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    const asOwner = t.withIdentity(OWNER)

    const now = Date.now()
    await t.run(async (ctx) =>
      ctx.db.insert("pages", {
        slug: "featured-post-2",
        pageType: "post",
        status: "published",
        content: { en: { title: "Another Featured Post", blocks: [] } },
        localizedSlugs: { en: "featured-post-2" },
        featured: true,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
    )

    const cards = await asOwner.query(api.cms.relations.searchTargets, {
      pageTypes: ["post"],
      locale: "en",
      limit: 10,
    })
    expect(cards.length).toBe(1)
    expect(cards[0]?.featured).toBe(true)
  })

  test("a non-featured post resolves featured:false, not omitted", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    const asOwner = t.withIdentity(OWNER)

    const now = Date.now()
    const postId = await t.run(async (ctx) =>
      ctx.db.insert("pages", {
        slug: "plain-post",
        pageType: "post",
        status: "published",
        content: { en: { title: "Plain Post", blocks: [] } },
        localizedSlugs: { en: "plain-post" },
        featured: false,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
    )

    const card = await asOwner.query(api.cms.relations.getReferenceCard, {
      id: postId,
      locale: "en",
    })
    expect(card?.featured).toBe(false)
  })
})

describe("listRelationCandidates under legacy authority", () => {
  test("returns picker rows built from the stored page content", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    const asOwner = t.withIdentity(OWNER)

    const now = Date.now()
    const insert = (slug: string, status: "published" | "draft", title: string) =>
      t.run(async (ctx) =>
        ctx.db.insert("pages", {
          slug,
          pageType: "page",
          status,
          content: { en: { title, blocks: [] } },
          localizedSlugs: { en: slug },
          createdAt: now,
          updatedAt: now,
        })
      )
    const livePage = await insert("live-page", "published", "Live Page")
    const draftPage = await insert("draft-page", "draft", "Draft Page")

    const published = await asOwner.query(
      api.cms.pages.listRelationCandidates,
      { pageTypes: ["page"], includeDrafts: false }
    )
    expect(published).toEqual([
      expect.objectContaining({
        _id: livePage,
        slug: "live-page",
        localizedTitles: { en: "Live Page" },
        localePublicationStates: { en: "published" },
        status: "published",
        pageType: "page",
      }),
    ])
    const all = await asOwner.query(api.cms.pages.listRelationCandidates, {
      pageTypes: ["page"],
      includeDrafts: true,
    })
    expect(all.map((row) => row._id).sort()).toEqual([livePage, draftPage].sort())
  })
})

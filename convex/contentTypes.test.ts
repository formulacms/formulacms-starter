/// <reference types="vite/client" />

import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import { CONTENT_TYPES } from "./lib/contentTypes"
import schema from "./schema"
import { convexTest, seedCommunityOwner } from "../convexTestWithExplicitAdmin"

const modules = import.meta.glob("./**/*.ts")

/** The one durable Community owner; both identity fields are explicit. */
const OWNER = {
  subject: "owner-1",
  tokenIdentifier: "https://convex.test|owner-1",
  email: "owner@example.com",
}

/** Signed in, but bound to neither owner field — Community's only other tier. */
const UNRELATED = {
  subject: "unrelated-1",
  tokenIdentifier: "https://convex.test|unrelated-1",
  email: "unrelated@example.com",
}

async function seedSiteSettings(
  t: ReturnType<typeof convexTest>,
  archivedContentTypes: string[] = []
) {
  await t.run(async (ctx) => {
    await ctx.db.insert("siteSettings", {
      siteName: "Test site",
      siteUrl: "https://example.test",
      defaultLocale: "en",
      enabledLocales: ["en"],
      archivedContentTypes,
      updatedAt: Date.now(),
    })
  })
}

describe("Content Type usage", () => {
  test("returns every active type and caps usage at 25 rows", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    const asOwner = t.withIdentity(OWNER)

    for (let index = 1; index <= 26; index += 1) {
      await asOwner.mutation(api.cms.pages.create, {
        pageType: "post",
        status: "draft",
        title: `Usage post ${index}`,
      })
    }

    const usage = await asOwner.query(
      api.cms.contentTypes.getContentTypeUsage,
      {}
    )
    // Every active type, in registry order. Spelled from the registry rather
    // than a literal list: a generated starter curates a subset, and this
    // query's contract is "all of them", not "these six".
    expect(usage.map((item) => item.type)).toEqual([...CONTENT_TYPES])
    expect(usage.find((item) => item.type === "post")).toEqual({
      type: "post",
      count: 25,
      capped: true,
    })
    expect(
      usage.every((item) => item.type !== "post" || item.count <= 25)
    ).toBe(true)
  })

  test("does not expose the usage catalog to a non-owner identity", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)

    await expect(
      t
        .withIdentity(UNRELATED)
        .query(api.cms.contentTypes.getContentTypeUsage, {})
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

  // Frozen Team role evidence; re-home under T01/T02 without weakening it
  // into Community owner-only assertions. Community has no viewer tier, so
  // `nav.content-types:view` has no Community authority to deny.
  test.skip("does not expose the usage catalog to viewers", async () => {
    const t = convexTest(schema, modules)
    const asViewer = t.withIdentity({
      subject: "viewer-1",
      email: "viewer@example.com",
    })

    await expect(
      asViewer.query(api.cms.contentTypes.getContentTypeUsage, {})
    ).rejects.toThrow(/UNAUTHORIZED.*nav\.content-types:view/)
  })
})

describe("Content Type archive lifecycle", () => {
  test("requires authentication to read archive metadata", async () => {
    const t = convexTest(schema, modules)
    await seedSiteSettings(t, ["post"])

    await expect(
      t.query(api.cms.contentTypes.getArchivedContentTypes, {})
    ).rejects.toThrow(/unauthenticated/i)
  })

  test("normalizes archive state and blocks create and duplicate until restored", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    await seedSiteSettings(t, ["page", "page", "not-active"])
    const asOwner = t.withIdentity(OWNER)

    const postId = await asOwner.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Existing post",
    })
    await expect(
      asOwner.query(api.cms.contentTypes.getArchivedContentTypes, {})
    ).resolves.toEqual(["page"])
    await expect(
      asOwner.mutation(api.cms.contentTypes.setContentTypeArchived, {
        type: "post",
        archived: true,
      })
    ).resolves.toEqual(["page", "post"])

    await expect(
      asOwner.mutation(api.cms.pages.create, {
        pageType: "post",
        status: "draft",
        title: "Blocked post",
      })
    ).rejects.toThrow(/archived/i)
    await expect(
      asOwner.mutation(api.cms.pages.duplicate, {
        id: postId,
        title: "Blocked duplicate",
      })
    ).rejects.toThrow(/archived/i)

    await expect(
      asOwner.mutation(api.cms.pages.update, {
        id: postId,
        title: "Existing post updated",
      })
    ).resolves.toBeDefined()
    await expect(
      asOwner.mutation(api.cms.contentTypes.setContentTypeArchived, {
        type: "post",
        archived: false,
      })
    ).resolves.toEqual(["page"])
    await expect(
      asOwner.mutation(api.cms.pages.create, {
        pageType: "post",
        status: "draft",
        title: "Restored post",
      })
    ).resolves.toBeDefined()
  })

  test("keeps archive mutation restricted to the owner", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    await seedSiteSettings(t)

    await expect(
      t
        .withIdentity(UNRELATED)
        .mutation(api.cms.contentTypes.setContentTypeArchived, {
          type: "post",
          archived: true,
        })
    ).rejects.toThrow("CMS_OWNER_REQUIRED")
  })

  // Frozen Team role evidence; re-home under T01/T02 without weakening it
  // into Community owner-only assertions. Community grants no `settings:update`
  // permission array, so an editor tier cannot be denied one.
  test.skip("keeps archive mutation restricted to settings administrators", async () => {
    const t = convexTest(schema, modules)
    await seedSiteSettings(t)
    const asEditor = t.withIdentity({
      subject: "editor-1",
      email: "editor@example.com",
    })

    await expect(
      asEditor.mutation(api.cms.contentTypes.setContentTypeArchived, {
        type: "post",
        archived: true,
      })
    ).rejects.toThrow(/UNAUTHORIZED.*settings:update/)
  })

  test("rejects unknown content types before changing settings", async () => {
    const t = convexTest(schema, modules)
    await seedCommunityOwner(t, OWNER)
    await seedSiteSettings(t)
    const asOwner = t.withIdentity(OWNER)

    await expect(
      asOwner.mutation(api.cms.contentTypes.setContentTypeArchived, {
        type: "not-a-content-type",
        archived: true,
      })
    ).rejects.toThrow(/unknown active content type/i)
    await expect(
      asOwner.query(api.cms.contentTypes.getArchivedContentTypes, {})
    ).resolves.toEqual([])
  })
})

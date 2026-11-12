/// <reference types="vite/client" />
import { convexTest } from "convex-test"
import { describe, expect, test } from "vitest"
import schema from "./schema"
import {
  clearDocumentReferencesForPage,
  refreshDocumentReferencesForPage,
} from "./lib/documentReferences"

const modules = import.meta.glob("./**/*.ts")

/**
 * Plan 028 C2 scanner tests. C5 activated post's byline as the first live
 * `relation()` field on any content-type descriptor — post/page/landing-page
 * without a set byline still emit zero rows, and a post with a byline emits
 * exactly one shared-field row at `authorIds[0]`. These tests lock the invariants:
 *
 *   1. Post without byline / other types → zero rows inserted (regression: the
 *      scanner accidentally emitting a row for a non-relation primitive would
 *      break `by_target` deletion guards).
 *   2. Post with a byline → one shared-field row at `authorIds[0]`.
 *   3. Clear-for-source removes only that source's rows (by_source index).
 *   4. Refresh is idempotent — same page saved twice yields the same fan-out.
 */

describe("documentReferences scanner", () => {
  test("post without byline + page + landing-page: no relation() values → zero rows", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const now = Date.now()
      const pageId = await ctx.db.insert("pages", {
        slug: "post-a",
        pageType: "post",
        status: "draft",
        content: { en: { title: "Post A", slices: [] } },
        localizedSlugs: { en: "post-a" },
        featured: false,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
      const doc = await ctx.db.get(pageId)
      expect(doc).not.toBeNull()
      await refreshDocumentReferencesForPage(ctx, doc!)

      const rows = await ctx.db.query("documentReferences").take(10)
      expect(rows).toEqual([])
    })
  })

  test("post with a byline → one shared-field row at authorIds[0]", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const now = Date.now()
      const authorPageId = await ctx.db.insert("pages", {
        slug: "jane",
        pageType: "author",
        status: "published",
        name: "Jane Doe",
        content: { en: { title: "Jane Doe", slices: [] } },
        localizedSlugs: { en: "jane" },
        createdAt: now,
        updatedAt: now,
      })
      const postId = await ctx.db.insert("pages", {
        slug: "hello",
        pageType: "post",
        status: "draft",
        content: { en: { title: "Hello", slices: [] } },
        localizedSlugs: { en: "hello" },
        authorIds: [{ pageId: authorPageId }],
        featured: false,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
      const doc = await ctx.db.get(postId)
      expect(doc).not.toBeNull()
      await refreshDocumentReferencesForPage(ctx, doc!)

      const rows = await ctx.db.query("documentReferences").take(10)
      expect(rows.length).toBe(1)
      expect(rows[0]!.sourceId).toBe(postId)
      expect(rows[0]!.targetId).toBe(authorPageId)
      expect(rows[0]!.targetType).toBe("author")
      expect(rows[0]!.path).toBe("authorIds[0]")
      expect(rows[0]!.source).toBe("shared-field")
    })
  })

  test("post with multiple authors → one shared-field row per author, indexed by byline position", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const now = Date.now()
      const leadId = await ctx.db.insert("pages", {
        slug: "jane",
        pageType: "author",
        status: "published",
        name: "Jane Doe",
        content: { en: { title: "Jane Doe", slices: [] } },
        localizedSlugs: { en: "jane" },
        createdAt: now,
        updatedAt: now,
      })
      const coAuthorId = await ctx.db.insert("pages", {
        slug: "john",
        pageType: "author",
        status: "published",
        name: "John Roe",
        content: { en: { title: "John Roe", slices: [] } },
        localizedSlugs: { en: "john" },
        createdAt: now,
        updatedAt: now,
      })
      const postId = await ctx.db.insert("pages", {
        slug: "hello-multi",
        pageType: "post",
        status: "draft",
        content: { en: { title: "Hello", slices: [] } },
        localizedSlugs: { en: "hello-multi" },
        authorIds: [{ pageId: leadId }, { pageId: coAuthorId }],
        featured: false,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
      const doc = await ctx.db.get(postId)
      expect(doc).not.toBeNull()
      await refreshDocumentReferencesForPage(ctx, doc!)

      const rows = await ctx.db.query("documentReferences").take(10)
      expect(rows.length).toBe(2)
      const byPath = new Map(rows.map((r) => [r.path, r]))
      expect(byPath.get("authorIds[0]")?.targetId).toBe(leadId)
      expect(byPath.get("authorIds[1]")?.targetId).toBe(coAuthorId)
      for (const row of rows) {
        expect(row.sourceId).toBe(postId)
        expect(row.targetType).toBe("author")
        expect(row.source).toBe("shared-field")
      }
    })
  })

  test("clearDocumentReferencesForPage removes only the passed source", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const now = Date.now()
      const sourceA = await ctx.db.insert("pages", {
        slug: "source-a",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "source-a" },
        createdAt: now,
        updatedAt: now,
      })
      const sourceB = await ctx.db.insert("pages", {
        slug: "source-b",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "source-b" },
        createdAt: now,
        updatedAt: now,
      })
      const target = await ctx.db.insert("pages", {
        slug: "target",
        pageType: "page",
        status: "published",
        content: { en: { title: "Target", slices: [] } },
        localizedSlugs: { en: "target" },
        createdAt: now,
        updatedAt: now,
      })

      await ctx.db.insert("documentReferences", {
        sourceId: sourceA,
        targetId: target,
        targetType: "page",
        path: "content.en.slices[0].primary.pick",
        source: "slice-body",
        updatedAt: now,
      })
      await ctx.db.insert("documentReferences", {
        sourceId: sourceB,
        targetId: target,
        targetType: "page",
        path: "content.en.slices[0].primary.pick",
        source: "slice-body",
        updatedAt: now,
      })

      await clearDocumentReferencesForPage(ctx, sourceA)

      const remaining = await ctx.db.query("documentReferences").take(10)
      expect(remaining.length).toBe(1)
      expect(remaining[0]!.sourceId).toBe(sourceB)
    })
  })

  test("refresh is idempotent — no growth on repeated calls", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const now = Date.now()
      const pageId = await ctx.db.insert("pages", {
        slug: "idempotent",
        pageType: "post",
        status: "draft",
        content: { en: { title: "Idempotent", slices: [] } },
        localizedSlugs: { en: "idempotent" },
        featured: false,
        promoteToFront: false,
        createdAt: now,
        updatedAt: now,
      })
      const doc = await ctx.db.get(pageId)
      expect(doc).not.toBeNull()

      await refreshDocumentReferencesForPage(ctx, doc!)
      await refreshDocumentReferencesForPage(ctx, doc!)
      await refreshDocumentReferencesForPage(ctx, doc!)

      const rows = await ctx.db.query("documentReferences").take(10)
      expect(rows).toEqual([])
    })
  })

  test("by_target index lists all sources referencing a target", async () => {
    const t = convexTest(schema, modules)

    await t.run(async (ctx) => {
      const now = Date.now()
      const sourceA = await ctx.db.insert("pages", {
        slug: "src-a",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "src-a" },
        createdAt: now,
        updatedAt: now,
      })
      const sourceB = await ctx.db.insert("pages", {
        slug: "src-b",
        pageType: "page",
        status: "draft",
        content: {},
        localizedSlugs: { en: "src-b" },
        createdAt: now,
        updatedAt: now,
      })
      const target = await ctx.db.insert("pages", {
        slug: "shared-target",
        pageType: "page",
        status: "published",
        content: { en: { title: "Shared", slices: [] } },
        localizedSlugs: { en: "shared-target" },
        createdAt: now,
        updatedAt: now,
      })

      await ctx.db.insert("documentReferences", {
        sourceId: sourceA,
        targetId: target,
        targetType: "page",
        path: "authorIds[0]",
        source: "shared-field",
        updatedAt: now,
      })
      await ctx.db.insert("documentReferences", {
        sourceId: sourceB,
        targetId: target,
        targetType: "page",
        path: "content.en.slices[0].primary.pick",
        source: "slice-body",
        updatedAt: now,
      })

      const rowsToTarget = await ctx.db
        .query("documentReferences")
        .withIndex("by_target", (q) => q.eq("targetId", target))
        .take(10)

      expect(rowsToTarget.length).toBe(2)
      const sourceIds = new Set(rowsToTarget.map((r) => r.sourceId))
      expect(sourceIds).toEqual(new Set([sourceA, sourceB]))
    })
  })
})

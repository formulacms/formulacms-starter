/// <reference types="vite/client" />
import { convexTest } from "../convexTestWithExplicitAdmin"
import { describe, expect, test } from "vitest"
import type { Infer } from "convex/values"
import { api } from "./_generated/api"
import type { Doc, Id } from "./_generated/dataModel"
import schema from "./schema"
import { postContentType } from "./lib/contentTypes/post"

const modules = import.meta.glob("./**/*.ts")
type AuthorIdentityRows = NonNullable<
  Infer<typeof postContentType.sharedFields.authorIds.validator>
>
type PostStageIdentityPatch = Partial<
  Extract<Doc<"pageStaging">, { pageType: "post" }>
> & { authorIds: AuthorIdentityRows }
const OWNER = {
  subject: "rf2a-author-identity-owner",
  tokenIdentifier: "https://convex.test|rf2a-author-identity-owner",
  name: "RF2a owner",
  email: "rf2a-owner@example.test",
}

function pageTest() {
  return convexTest({ schema, modules, ownerIdentity: OWNER })
}

async function createAuthor(
  actor: ReturnType<ReturnType<typeof pageTest>["withIdentity"]>,
  name: string
): Promise<Id<"pages">> {
  return actor.mutation(api.cms.pages.create, {
    pageType: "author",
    status: "draft",
    title: name,
    name,
  })
}

describe("RF2a Post author row identity", () => {
  test("D2 create allocates relation row itemIds", async () => {
    const t = pageTest()
    const actor = t.withIdentity(OWNER)
    const author = await createAuthor(actor, "Author A")
    const post = await actor.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Post",
      authorIds: [author],
    })

    const stored = await t.run((ctx) => ctx.db.get("pages", post))
    expect(stored?.pageType).toBe("post")
    if (stored?.pageType !== "post") throw new Error("Expected a post")
    expect(stored.authorIds).toEqual([
      { pageId: author, itemId: expect.any(String) },
    ])
  })

  test("D2 update preserves valid IDs by pageId and allocates missing IDs", async () => {
    const t = pageTest()
    const actor = t.withIdentity(OWNER)
    const authorA = await createAuthor(actor, "Author A")
    const authorB = await createAuthor(actor, "Author B")
    const authorC = await createAuthor(actor, "Author C")
    const post = await actor.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Post",
      authorIds: [authorA, authorB],
    })
    await t.run((ctx) =>
      ctx.db.patch("pages", post, {
        authorIds: [
          { pageId: authorA, itemId: "author-row-a" },
          { pageId: authorB, itemId: "" },
        ],
      })
    )
    const current = await t.run((ctx) => ctx.db.get("pages", post))
    await actor.mutation(api.cms.pages.update, {
      id: post,
      authorIds: [authorB, authorC, authorA],
      expectedUpdatedAt: current?.updatedAt,
    })

    const updated = await t.run((ctx) => ctx.db.get("pages", post))
    expect(updated?.pageType).toBe("post")
    if (updated?.pageType !== "post") throw new Error("Expected a post")
    expect(updated.authorIds).toEqual([
      { pageId: authorB, itemId: expect.any(String) },
      { pageId: authorC, itemId: expect.any(String) },
      { pageId: authorA, itemId: "author-row-a" },
    ])
  })

  test("updateDraft uses staged IDs, stages explicit clear, and does not resurrect them", async () => {
    const t = pageTest()
    const actor = t.withIdentity(OWNER)
    const author = await createAuthor(actor, "Author A")
    const post = await actor.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Post",
      authorIds: [author],
    })
    await t.run((ctx) =>
      ctx.db.patch("pages", post, {
        authorIds: [{ pageId: author, itemId: "live-row" }],
      })
    )
    await actor.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId: post,
      force: true,
    })
    await actor.mutation(api.cms.pages.updateDraft, {
      pageId: post,
      authorIds: [author],
    })
    const stage = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pageStaging")
        .filter((q) => q.eq(q.field("pageId"), post))
        .collect()
      return rows[0]
    })
    if (!stage || stage.pageType !== "post") {
      throw new Error("Expected staged post")
    }
    const stagedAuthorPatch: PostStageIdentityPatch = {
      authorIds: [{ pageId: author, itemId: "staged-row" }],
    }
    await t.run((ctx) =>
      ctx.db.patch("pageStaging", stage._id, stagedAuthorPatch)
    )

    await actor.mutation(api.cms.pages.updateDraft, {
      pageId: post,
      authorIds: [author],
    })
    const preserved = await t.run((ctx) => ctx.db.get("pageStaging", stage._id))
    if (!preserved || preserved.pageType !== "post") {
      throw new Error("Expected preserved post staging")
    }
    expect(preserved).toHaveProperty("authorIds", [
      { pageId: author, itemId: "staged-row" },
    ])

    await actor.mutation(api.cms.pages.updateDraft, {
      pageId: post,
      authorIds: [],
    })
    const cleared = await t.run((ctx) => ctx.db.get("pageStaging", stage._id))
    if (!cleared || cleared.pageType !== "post") {
      throw new Error("Expected cleared post staging")
    }
    expect(cleared).toHaveProperty("authorIds", null)
    await actor.mutation(api.cms.pages.updateDraft, {
      pageId: post,
      authorIds: [author],
    })
    const readded = await t.run((ctx) => ctx.db.get("pageStaging", stage._id))
    if (!readded || readded.pageType !== "post") {
      throw new Error("Expected re-added post staging")
    }
    expect(readded).toHaveProperty("authorIds", [
      { pageId: author, itemId: expect.any(String) },
    ])
  })

  test("D2 duplicate replaces effective source IDs and leaves source unchanged", async () => {
    const t = pageTest()
    const actor = t.withIdentity(OWNER)
    const author = await createAuthor(actor, "Author A")
    const source = await actor.mutation(api.cms.pages.create, {
      pageType: "post",
      status: "draft",
      title: "Source",
      authorIds: [author],
    })
    await t.run((ctx) =>
      ctx.db.patch("pages", source, {
        authorIds: [{ pageId: author, itemId: "live-row" }],
      })
    )
    await actor.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId: source,
      force: true,
    })
    await actor.mutation(api.cms.pages.updateDraft, {
      pageId: source,
      authorIds: [author],
    })
    const stage = await t.run(async (ctx) => {
      const rows = await ctx.db
        .query("pageStaging")
        .filter((q) => q.eq(q.field("pageId"), source))
        .collect()
      return rows[0]
    })
    if (!stage || stage.pageType !== "post") {
      throw new Error("Expected staged source post")
    }
    const stagedAuthorPatch: PostStageIdentityPatch = {
      authorIds: [{ pageId: author, itemId: "staged-row" }],
    }
    await t.run((ctx) =>
      ctx.db.patch("pageStaging", stage._id, stagedAuthorPatch)
    )
    const sourceBefore = await t.run((ctx) => ctx.db.get("pages", source))

    const duplicate = await actor.mutation(api.cms.pages.duplicate, {
      id: source,
      title: "Source copy",
    })
    const [sourceAfter, copy] = await t.run(async (ctx) =>
      Promise.all([ctx.db.get("pages", source), ctx.db.get("pages", duplicate)])
    )
    expect(sourceAfter).toEqual(sourceBefore)
    expect(copy?.pageType).toBe("post")
    if (copy?.pageType !== "post") throw new Error("Expected a post")
    expect(copy.authorIds).toEqual([
      { pageId: author, itemId: expect.any(String) },
    ])
    expect(copy.authorIds?.[0].itemId).not.toBe("staged-row")
  })
})

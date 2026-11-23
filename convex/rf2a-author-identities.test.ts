/// <reference types="vite/client" />
import { convexTest } from "../convexTestWithExplicitAdmin"
import { describe, expect, test } from "vitest"
import { api } from "./_generated/api"
import type { Id } from "./_generated/dataModel"
import { isActiveContentType } from "./lib/contentTypes"
import schema from "./schema"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "rf2a-author-identity-owner",
  tokenIdentifier: "rf2a-author-identity-owner",
  name: "RF2a owner",
  email: "rf2a-owner@example.test",
}

function pageTest() {
  return convexTest({
    schema,
    modules,
    ownerIdentity: OWNER,
  })
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

describe.runIf(isActiveContentType("post") && isActiveContentType("author"))("RF2a Post author row identity", () => {
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

})

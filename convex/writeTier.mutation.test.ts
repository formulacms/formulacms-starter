import { createSampleBlock } from "@/convex/lib/blocks/sample"
/// <reference types="vite/client" />
import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import schema from "./schema"


const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "write-tier-owner",
  tokenIdentifier: "write-tier-owner",
  name: "Write tier owner",
  email: "write-tier@example.test",
}

describe("raw rich-text write guard", () => {
  test("saveEditorDraft rejects a full-only block in a basic body and leaves the stored page and drafts unchanged", blockProfile(["hero-agency"]), async () => {
    const t = convexTest({
      schema,
      modules,
      ownerIdentity: OWNER,
    })
    const actor = t.withIdentity(OWNER)
    await actor.mutation(api.cms.settings.bootstrapInstallation, {
      siteName: "Write tier",
      timezone: "UTC",
      defaultLocale: "en",
    })
    const pageId = await actor.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      slug: "write-tier-regression",
      title: "Write tier regression",
    })
    const sample = createSampleBlock("hero-agency")
    if (sample.type !== "hero-agency") throw new Error("Expected Hero Agency")
    const save = (block: typeof sample, expectedGeneration: number) =>
      actor.mutation(api.cms.publication.saveEditorDraft, {
        pageId,
        expectedLifecycleGeneration: 1,
        localized: {
          locale: "en",
          slug: "write-tier-regression",
          expectedGeneration,
          draft: {
            pageType: "landing-page",
            localized: { title: "Write tier regression" },
            blocks: [block],
          },
        },
      })
    await save(sample, 1)
    const stored = () =>
      t.run(async (ctx) => ({
        page: await ctx.db.get("pages", pageId),
        localeDrafts: await ctx.db
          .query("pageLocaleDrafts")
          .withIndex("by_pageId_and_locale", (q) =>
            q.eq("pageId", pageId).eq("locale", "en")
          )
          .take(2),
        states: await ctx.db
          .query("pageLocalePublicationStates")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .take(4),
        sharedDrafts: await ctx.db
          .query("pageSharedDrafts")
          .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
          .take(2),
      }))
    const before = await stored()
    const title = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Rejected full block" }],
            },
          ],
        },
      ],
    })
    const changed = {
      ...sample,
      primary: { ...sample.primary, description: title },
    }
    await expect(
      save(changed, 2)
    ).rejects.toThrow('node "blockquote" is not allowed in profile "basic"')
    expect(await stored()).toEqual(before)
  })
})

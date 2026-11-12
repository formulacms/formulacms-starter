import { createSampleSlice } from "@/convex/lib/slices/sample"
/// <reference types="vite/client" />
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import schema from "./schema"


const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "write-tier-owner",
  tokenIdentifier: "https://convex.test|write-tier-owner",
  name: "Write tier owner",
  email: "write-tier@example.test",
}

describe("raw rich-text write guard", () => {
  test("updateDraft rejects a full-only block in a basic body and leaves stored page and staging unchanged", sliceProfile(["hero-agency"]), async () => {
    const t = convexTest({ schema, modules, ownerIdentity: OWNER })
    const actor = t.withIdentity(OWNER)
    const pageId = await actor.mutation(api.cms.pages.create, {
      pageType: "landing-page",
      status: "draft",
      title: "Write tier regression",
    })
    await actor.mutation(api.cms.pages.acquirePageEditorLock, {
      pageId,
      force: true,
    })
    const sample = createSampleSlice("hero-agency")
    if (sample.type !== "hero-agency") throw new Error("Expected Hero Agency")
    await actor.mutation(api.cms.pages.updateDraft, {
      pageId,
      content: {
        en: {
          pageType: "landing-page",
          localized: { title: "Write tier regression" },
          slices: [sample],
        },
      },
    })
    const stored = () =>
      t.run(async (ctx) => ({
        page: await ctx.db.get("pages", pageId),
        staging: await ctx.db
          .query("pageStaging")
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
      actor.mutation(api.cms.pages.updateDraft, {
        pageId,
        content: {
          en: {
            pageType: "landing-page",
            localized: { title: "Write tier regression" },
            slices: [changed],
          },
        },
      })
    ).rejects.toThrow('node "blockquote" is not allowed in profile "basic"')
    expect(await stored()).toEqual(before)
  })
})

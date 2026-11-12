/// <reference types="vite/client" />
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import schema from "./schema"
import { snapshotPrePublishChecklist } from "./lib/publishing/checklist"

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
const owner = { subject: "checklist-owner", tokenIdentifier: "https://convex.test|checklist-owner" }
function setup() {
  const t = convexTest({ schema, modules, ownerIdentity: owner })
  return { t, actor: t.withIdentity(owner) }
}

describe("live checklist translation inputs and revision compatibility", () => {
  test("required body parameters cross the public readiness boundary while archive compaction stays exact", async () => {
    const { actor } = setup()
    const pageId = await actor.mutation(api.cms.pages.create, { status: "draft", pageType: "post", title: "Empty post" })
    const checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    const body = checklist.blockers.find((item) => item.field === "body")!
    expect(body).toMatchObject({ code: "missing_required_field", params: { variant: "body" }, locales: ["en"] })
    expect(body.message).toBe("Add at least one enabled content section for EN — this content type requires body content before publishing.")
    const snapshot = snapshotPrePublishChecklist(checklist)
    expect(snapshot).toEqual({
      blockerCount: 1,
      warningCount: 2,
      blockers: [{
        code: "missing_required_field",
        message: "Add at least one enabled content section for EN — this content type requires body content before publishing.",
        field: "body",
        locales: ["en"],
      }],
      warnings: [{
        code: "missing_seo_title",
        message: "Add an SEO title for EN before publishing.",
        field: "content.metaTitle",
        locales: ["en"],
      }, {
        code: "missing_seo_description",
        message: "Add an SEO description for EN before publishing.",
        field: "content.metaDescription",
        locales: ["en"],
      }],
    })
    expect(JSON.stringify(snapshot)).not.toContain('"params"')
  })

  test("descriptor relation variants carry identifiers and editorial titles rather than English type labels", async () => {
    const { t, actor } = setup()
    const authorId = await actor.mutation(api.cms.pages.create, { status: "draft", pageType: "author", title: "Draft author", name: "Draft author" })
    await actor.mutation(api.cms.pages.publish, { pageId: authorId })
    await actor.mutation(api.cms.pages.update, { id: authorId, status: "archived" })
    const pageId = await actor.mutation(api.cms.pages.create, { status: "draft", pageType: "post", title: "Post", authorIds: [authorId] })
    let checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    expect(checklist.blockers.find((item) => item.code === "archived_relation_target")).toMatchObject({ params: { contentType: "post", targetTitle: "Draft author", localeSpecific: false }, field: "authorIds[0]", locales: ["en"] })
    await t.run(async (ctx) => {
      await ctx.db.patch("pages", authorId, { deletedAt: 1 })
    })
    checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    expect(checklist.blockers.find((item) => item.code === "broken_internal_link")).toMatchObject({ params: { contentType: "post" }, field: "authorIds[0]" })

  })

  test("slice field, image, and missing-link variants survive the readiness validator", sliceProfile(["hero-with-image"]), async () => {
    const { actor } = setup()
    const pageId = await actor.mutation(api.cms.pages.create, { status: "draft", pageType: "landing-page", title: "Incomplete hero", content: { en: { title: "Incomplete hero", slices: [{ id: "hero", type: "hero-with-image", enabled: true, primary: { eyebrow: "News", eyebrowLink: { type: "internal" }, title: "", description: canonicalBody("Copy"), image: { url: "https://example.com/hero.jpg", alt: "" } }, items: [] }] } } })
    let checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    expect(checklist.blockers.find((item) => item.code === "missing_required_slice_field")).toMatchObject({ params: { sliceType: "hero-with-image", fieldName: "title" } })
    expect(checklist.blockers.find((item) => item.code === "missing_image_alt_text")).toMatchObject({ params: { sliceType: "hero-with-image" } })
    expect(checklist.blockers.find((item) => item.code === "broken_internal_link")).toMatchObject({ params: { variant: "missing_link_target", sliceType: "hero-with-image" } })
    await actor.mutation(api.cms.pages.acquirePageEditorLock, { pageId, force: true })
    await actor.mutation(api.cms.pages.updateDraft, {
      pageId, content: { en: { pageType: "landing-page", localized: { title: "Incomplete hero" }, slices: [{ id: "hero", type: "hero-with-image", enabled: true, primary: { eyebrow: "News", eyebrowLink: { type: "internal" }, title: "", description: canonicalBody("Copy"), image: { url: "", alt: "" } }, items: [] }] } },
    })
    checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    expect(checklist.blockers.find((item) => item.params?.variant === "image")).toMatchObject({ code: "missing_required_slice_field", params: { variant: "image", sliceType: "hero-with-image" } })
  })

})

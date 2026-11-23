/// <reference types="vite/client" />
import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { convexTest } from "../convexTestWithExplicitAdmin"
import { api } from "./_generated/api"
import schema from "./schema"
import type { Id } from "./_generated/dataModel"
import { isActiveContentType } from "./lib/contentTypes"
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
const owner = { subject: "checklist-owner", tokenIdentifier: "checklist-owner" }
const postActive = isActiveContentType("post")
const authorActive = isActiveContentType("author")
async function setup() {
  const t = convexTest({
    schema,
    modules,
    ownerIdentity: owner,
  })
  const actor = t.withIdentity(owner)
  await actor.mutation(api.cms.settings.bootstrapInstallation, {
    siteName: "Checklist",
    timezone: "UTC",
    defaultLocale: "en",
  })
  return { t, actor }
}

describe("live checklist translation inputs and revision compatibility", () => {
  test("required body parameters cross the public readiness boundary while archive compaction stays exact", { skip: !postActive }, async () => {
    const { actor } = await setup()
    const pageId = await actor.mutation(api.cms.pages.create, { status: "draft", pageType: "post", slug: "empty-post", title: "Empty post" })
    const checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    const body = checklist.blockers.find((item) => item.field === "body")!
    expect(body).toMatchObject({ code: "missing_required_field", params: { variant: "body" }, locales: ["en"] })
    expect(body.message).toBe("Add at least one enabled content block for EN — this content type requires body content before publishing.")
    const snapshot = snapshotPrePublishChecklist(checklist)
    expect(snapshot).toEqual({
      blockerCount: 1,
      warningCount: 2,
      blockers: [{
        code: "missing_required_field",
        message: "Add at least one enabled content block for EN — this content type requires body content before publishing.",
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

  test("descriptor relation variants carry identifiers and editorial titles rather than English type labels", { skip: !postActive || !authorActive }, async () => {
    const { actor } = await setup()
    const authorId = await actor.mutation(api.cms.pages.create, { status: "draft", pageType: "author", slug: "draft-author", title: "Draft author", name: "Draft author" })
    await publishNow(actor, authorId)
    await actor.mutation(api.cms.publication.archivePage, { pageId: authorId, expectedLifecycleGeneration: 1 })
    const pageId = await actor.mutation(api.cms.pages.create, { status: "draft", pageType: "post", slug: "post", title: "Post", authorIds: [authorId] })
    let checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    expect(checklist.blockers.find((item) => item.code === "archived_relation_target")).toMatchObject({ params: { contentType: "post" }, field: "authorIds[0]", locales: ["en"] })
    await actor.mutation(api.cms.publication.softDeletePage, { pageId: authorId, expectedLifecycleGeneration: 2 })
    checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    // A trashed author still blocks, and the parameters keep the identifier
    // (not an English type label).
    expect(checklist.blockers.find((item) => item.field === "authorIds[0]")).toMatchObject({ code: "archived_relation_target", params: { contentType: "post" } })

  })

  test("block field, image, and missing-link variants survive the readiness validator", blockProfile(["hero-with-image"]), async () => {
    const { actor } = await setup()
    const hero = (image: { url: string; alt: string }) => ({ id: "hero", type: "hero-with-image" as const, enabled: true, primary: { eyebrow: "News", eyebrowLink: { type: "internal" as const }, title: "", description: canonicalBody("Copy"), image }, items: [] })
    const pageId = await actor.mutation(api.cms.pages.create, { status: "draft", pageType: "landing-page", slug: "incomplete-hero", title: "Incomplete hero", content: { en: { title: "Incomplete hero", blocks: [hero({ url: "https://example.com/hero.jpg", alt: "" })] } } })
    let checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    expect(checklist.blockers.find((item) => item.code === "missing_required_block_field")).toMatchObject({ params: { blockType: "hero-with-image", fieldName: "title" } })
    expect(checklist.blockers.find((item) => item.code === "missing_image_alt_text")).toMatchObject({ params: { blockType: "hero-with-image" } })
    expect(checklist.blockers.find((item) => item.code === "broken_internal_link")).toMatchObject({ params: { variant: "missing_link_target", blockType: "hero-with-image" } })
    await actor.mutation(api.cms.publication.saveEditorDraft, {
      pageId,
      expectedLifecycleGeneration: 1,
      localized: { locale: "en", slug: "incomplete-hero", expectedGeneration: 1, draft: { pageType: "landing-page", localized: { title: "Incomplete hero" }, blocks: [hero({ url: "", alt: "" })] } },
    })
    checklist = await actor.query(api.cms.pages.getPrePublishChecklist, { pageId })
    expect(checklist.blockers.find((item) => item.params?.variant === "image")).toMatchObject({ code: "missing_required_block_field", params: { variant: "image", blockType: "hero-with-image" } })
  })

})

/** First publication of a freshly created page's English draft. */
function publishNow(actor: Awaited<ReturnType<typeof setup>>["actor"], pageId: Id<"pages">) {
  return actor.mutation(api.cms.publication.publishLocale, {
    pageId,
    locale: "en",
    expectedDraftGeneration: 1,
    expectedSharedDraftGeneration: 1,
    expectedPublicGeneration: 0,
    expectedLifecycleGeneration: 1,
    expectedReleaseGeneration: 0,
  })
}

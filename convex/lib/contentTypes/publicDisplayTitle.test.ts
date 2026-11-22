import { describe, expect, it } from "vitest"
import type { Doc, Id } from "../../_generated/dataModel"
import { publicDisplayTitle } from "./publicProjection"

const pageId = "page1" as Id<"pages">

function page(fields: Record<string, unknown>): Doc<"pages"> {
  return {
    _id: pageId,
    _creationTime: 0,
    status: "draft",
    slug: "x",
    updatedAt: 0,
    ...fields,
  } as unknown as Doc<"pages">
}

describe("publicDisplayTitle (search title fallback)", () => {
  it("names a testimonial by the person, never by its admin-only internal label", () => {
    const doc = page({
      pageType: "testimonial",
      personName: "Grace Hopper",
      content: { en: { title: "Internal: secret label", quote: "Great." } },
    })
    expect(publicDisplayTitle(doc, "en")).toBe("Grace Hopper")
  })

  it("does not need the page to be published", () => {
    const doc = page({
      pageType: "testimonial",
      status: "draft",
      personName: "Ada",
      content: { en: { title: "t", quote: "q" } },
    })
    expect(publicDisplayTitle(doc, "en")).toBe("Ada")
  })

  it("gives an empty title for a language the page does not have, or a trashed page", () => {
    const doc = page({
      pageType: "testimonial",
      personName: "Ada",
      content: { en: { title: "t", quote: "q" } },
    })
    expect(publicDisplayTitle(doc, "fr")).toBe("")
    expect(publicDisplayTitle({ ...doc, deletedAt: 1 }, "en")).toBe("")
  })
})

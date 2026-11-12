import { sliceProfile } from "@/test-utils/slice-profile"
import { beforeEach, describe, expect, test } from "vitest"
import { readRecoveryDraft, recoveryKey } from "./recovery"
import type { Id } from "@/convex/_generated/dataModel"

const pageId = "page_rf2a" as Id<"pages">

describe("RF2a recovery readers", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  test("converts heading-shaped current-profile fields without changing schema or row identity", sliceProfile([]), () => {
    const heading = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Draft title" }],
        },
      ],
    })
    window.sessionStorage.setItem(
      recoveryKey(pageId, "en"),
      JSON.stringify({
        version: 3,
        savedAt: 1720000000000,
        locale: "en",
        title: "Draft",
        slug: "draft",
        pageType: "landing",
        parentId: "",
        authorIds: [],
        tags: [],
        metaTitle: "",
        metaDescription: "",
        seoNoIndex: false,
        seoNoFollow: false,
        seoOgTitle: "",
        seoOgDescription: "",
        seoOgImage: "",
        slices: [
          {
            id: "hero",
            type: "hero-agency",
            enabled: true,
            primary: { title: heading, description: "" },
            items: [{ itemId: "row-1", id: "button-1", label: "Go" }],
          },
        ],
        sharedFieldValues: {},
        localizedFieldValues: {},
      })
    )

    const recovered = readRecoveryDraft(pageId, "en") as unknown as {
      version: number
      slices: Array<{
        primary: { title: string }
        items: Array<{ itemId: string }>
      }>
    }
    expect(recovered.version).toBe(3)
    expect(JSON.parse(recovered.slices[0]!.primary.title).content[0].type).toBe(
      "heading"
    )
    expect(recovered.slices[0]?.items[0]?.itemId).toBe("row-1")
  })
})

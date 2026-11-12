import { sliceProfile } from "@/test-utils/slice-profile"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import type { SliceRenderContext } from "@/lib/slices/links"
import { DefaultSliceBodyRenderer } from "./default-slice-body"

const ctx: SliceRenderContext = {
  locale: "en",
  defaultLocale: "en",
  pagePaths: {},
}

const heroSlice = {
  id: "s1" as string,
  type: "hero-agency",
  enabled: true,
  primary: { eyebrow: "", title: "Hero heading", description: "" },
  items: [],
} as unknown as Slice

function makePage(pageType: "landing-page" | "page") {
  return {
    _id: `${pageType}:test` as Id<"pages">,
    _creationTime: 0,
    pageType,
    slug: "sample-page",
    status: "published",
    createdAt: 0,
    updatedAt: 0,
    content: {
      en: {
        title: "Sample page title",
        slices: [],
      },
    },
  } as unknown as Doc<"pages">
}

describe("DefaultSliceBodyRenderer", () => {
  for (const profileRow of [
    ["empty", []],
    ["populated", [heroSlice]],
  ] as const) {
    it.each([profileRow])("renders a stable slice-body surface for %s content", sliceProfile([]),
      (_state, slices) => {
        const page = makePage("page")
        const content = page.content!.en!
        const { container } = render(
          <DefaultSliceBodyRenderer
            page={page as never}
            content={content as never}
            slices={[...slices]}
            ctx={ctx}
            locale="en"
            renderLocale="en"
            defaultLocale="en"
            bylines={[]}
          />
        )

        expect(container.children).toHaveLength(1)
        expect(
          screen.getByRole("heading", {
            name: slices.length ? "Hero heading" : "Sample page title",
            level: 1,
          })
        ).toBeInTheDocument()
        if (slices.length === 0) {
          expect(screen.getByText("No content yet.")).toBeInTheDocument()
        } else {
          expect(screen.getByText("Hero heading")).toBeInTheDocument()
        }
      }
    )
  }
})

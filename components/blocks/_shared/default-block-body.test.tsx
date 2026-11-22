import { blockProfile } from "@/test-utils/block-profile"
import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import type { Block } from "@/convex/lib/blocks"
import type { BlockRenderContext } from "@/lib/blocks/links"
import { DefaultBlockBodyRenderer } from "./default-block-body"

const ctx: BlockRenderContext = {
  locale: "en",
  defaultLocale: "en",
  pagePaths: {},
}

const heroBlock = {
  id: "s1" as string,
  type: "hero-agency",
  enabled: true,
  primary: { eyebrow: "", title: "Hero heading", description: "" },
  items: [],
} as unknown as Block

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
        blocks: [],
      },
    },
  } as unknown as Doc<"pages">
}

describe("DefaultBlockBodyRenderer", () => {
  for (const profileRow of [
    ["empty", []],
    ["populated", [heroBlock]],
  ] as const) {
    it.each([profileRow])("renders a stable block-body surface for %s content", blockProfile([]),
      (_state, blocks) => {
        const page = makePage("page")
        const content = page.content!.en!
        const { container } = render(
          <DefaultBlockBodyRenderer
            page={page as never}
            content={content as never}
            blocks={[...blocks]}
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
            name: blocks.length ? "Hero heading" : "Sample page title",
            level: 1,
          })
        ).toBeInTheDocument()
        if (blocks.length === 0) {
          expect(screen.getByText("No content yet.")).toBeInTheDocument()
        } else {
          expect(screen.getByText("Hero heading")).toBeInTheDocument()
        }
      }
    )
  }
})

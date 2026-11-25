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
  it.each([
    ["en", "Add blocks to your home page."],
    ["fr", "Ajoutez des blocs à votre page d’accueil."],
  ])("shows the empty home message in %s only until blocks exist", blockProfile(["hero-agency"]), (locale, message) => {
    const page = makePage("landing-page")
    const props = {
      page: page as never,
      content: { title: "Atelier Lune", blocks: [] } as never,
      blocks: [] as Block[],
      ctx: { ...ctx, locale },
      locale,
      renderLocale: locale,
      defaultLocale: "en",
      bylines: [],
      isHomePage: true,
    }
    const view = render(<DefaultBlockBodyRenderer {...props} />)
    expect(screen.getByText(message)).toBeInTheDocument()
    expect(screen.getByRole("heading", { name: "Atelier Lune" })).toBeInTheDocument()
    view.rerender(<DefaultBlockBodyRenderer {...props} blocks={[heroBlock]} />)
    expect(screen.queryByText(message)).toBeNull()
  })

  it("keeps the ordinary empty message off Home", () => {
    const page = makePage("page")
    render(<DefaultBlockBodyRenderer page={page as never} content={page.content!.en! as never}
      blocks={[]} ctx={ctx} locale="en" renderLocale="en" defaultLocale="en" bylines={[]} isHomePage={false} />)
    expect(screen.getByText("No content yet.")).toBeInTheDocument()
    expect(screen.queryByText("Add blocks to your home page.")).toBeNull()
  })

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

import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { PageRenderer } from "./page"

const page = {
  _id: "page:test" as Id<"pages">,
  _creationTime: 0,
  pageType: "page",
  slug: "sample-page",
  status: "published",
  createdAt: 0,
  updatedAt: 0,
  content: { en: { title: "Page title", slices: [] } },
} as unknown as Doc<"pages">

describe("PageRenderer", () => {
  it("renders only page content", () => {
    render(
      <PageRenderer
        page={page as never}
        content={page.content!.en! as never}
        slices={[]}
        ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[]}
      />
    )

    expect(
      screen.getByRole("heading", { name: "Page title" })
    ).toBeInTheDocument()
  })

  it("rejects another content type", () => {
    const otherPage = { ...page, pageType: "landing-page" }
    const { container } = render(
      <PageRenderer
        page={otherPage as never}
        content={otherPage.content!.en! as never}
        slices={[]}
        ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[]}
      />
    )

    expect(container.firstChild).toBeNull()
  })
})

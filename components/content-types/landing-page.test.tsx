import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import { LandingPageRenderer } from "./landing-page"

const page = {
  _id: "landing-page:test" as Id<"pages">,
  _creationTime: 0,
  pageType: "landing-page",
  slug: "home",
  status: "published",
  createdAt: 0,
  updatedAt: 0,
  content: { en: { title: "Landing title", slices: [] } },
} as unknown as Doc<"pages">

describe("LandingPageRenderer", () => {
  it("renders landing-page content", () => {
    render(
      <LandingPageRenderer
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
      screen.getByRole("heading", { name: "Landing title" })
    ).toBeInTheDocument()
  })
})

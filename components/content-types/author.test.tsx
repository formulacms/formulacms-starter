import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import type { SliceRenderContext } from "@/lib/slices/links"
import { AuthorRenderer } from "./author"

/**
 * ADR-0038 exposure regression for the `author` public renderer. Every
 * descriptor field on `author` is `.public()` today (name, socials,
 * title, metaTitle, metaDescription, roleTitle) — the test asserts they
 * surface when set, and pins the identity block's structure so a future
 * refactor doesn't silently drop the name/roleTitle/socials header.
 */

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

function makeAuthor(
  overrides: Partial<{
    name: string
    socials: { platform: string; url: string }[]
    title: string
    roleTitle: string
  }>
) {
  return {
    _id: "authors:test" as Id<"pages">,
    _creationTime: 0,
    pageType: "author",
    slug: "ada-lovelace",
    status: "published",
    createdAt: 0,
    updatedAt: 0,
    name: overrides.name ?? "Ada Lovelace",
    socials: overrides.socials,
    content: {
      en: {
        title: overrides.title ?? "Ada Lovelace",
        roleTitle: overrides.roleTitle,
        slices: [],
      },
    },
  } as unknown as Doc<"pages">
}

describe("AuthorRenderer", () => {
  for (const profileRow of [
    ["empty", []],
    ["populated", [heroSlice]],
  ] as const) {
    it.each([profileRow])("renders one outer element for %s author content without changing its order", sliceProfile([]),
      (_state, slices) => {
        const page = makeAuthor({
          name: "Ada Lovelace",
          roleTitle: "Programmer",
        })
        const content = page.content!.en!
        const { container } = render(
          <AuthorRenderer
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
        const root = container.firstElementChild
        expect(root?.firstElementChild?.tagName).toBe("HEADER")
        expect(
          screen.getByRole("heading", { name: "Ada Lovelace" })
        ).toBeInTheDocument()
        if (slices.length === 0) {
          expect(screen.getByText("No content yet.")).toBeInTheDocument()
        } else {
          expect(screen.getByText("Hero heading")).toBeInTheDocument()
        }
      }
    )
  }

  it("renders the shared name as the h1 heading and the localized roleTitle underneath", () => {
    const page = makeAuthor({
      name: "Ada Lovelace",
      roleTitle: "Programmer",
    })
    const content = page.content!.en!
    render(
      <AuthorRenderer
        page={page as never}
        content={content as never}
        slices={[]}
        ctx={ctx}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[]}
      />
    )
    const heading = screen.getByRole("heading", {
      level: 1,
      name: "Ada Lovelace",
    })
    expect(heading).toBeInTheDocument()
    expect(screen.getByText("Programmer")).toBeInTheDocument()
  })

  it("renders every social link when descriptor marks socials public", () => {
    const page = makeAuthor({
      socials: [
        { platform: "GitHub", url: "https://github.com/ada" },
        { platform: "Bluesky", url: "https://bsky.app/profile/ada" },
      ],
    })
    const content = page.content!.en!
    render(
      <AuthorRenderer
        page={page as never}
        content={content as never}
        slices={[]}
        ctx={ctx}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[]}
      />
    )
    const github = screen.getByRole("link", { name: "GitHub" })
    expect(github).toHaveAttribute("href", "https://github.com/ada")
    expect(github).toHaveAttribute("rel", "noopener noreferrer nofollow")
    expect(github).toHaveAttribute("target", "_blank")
    expect(screen.getByRole("link", { name: "Bluesky" })).toBeInTheDocument()
  })

  it("returns null when the page is not an author arm", () => {
    const page = {
      _id: "posts:x" as Id<"pages">,
      _creationTime: 0,
      pageType: "post",
      slug: "x",
      status: "published",
      createdAt: 0,
      updatedAt: 0,
      content: { en: { title: "x", slices: [] } },
    } as unknown as Doc<"pages">
    const content = { title: "x", slices: [] }
    const { container } = render(
      <AuthorRenderer
        page={page as never}
        content={content as never}
        slices={[]}
        ctx={ctx}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[]}
      />
    )
    expect(container.firstChild).toBeNull()
  })
})

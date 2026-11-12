import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it } from "vitest"
import { render, screen } from "@testing-library/react"
import type { Doc, Id } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import type { SliceRenderContext } from "@/lib/slices/links"
import { PostRenderer } from "./post"
import type { PublicByline } from "./types"

/**
 * ADR-0038 exposure regression for the `post` public renderer. The
 * descriptor marks `tags` as admin-only ("Internal Labels" per plan
 * 029 §Recommended editor seam); the renderer must never surface any
 * tag value to the DOM, regardless of what's stored on the doc.
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

function makePost(overrides: {
  tags?: string[]
  featured?: boolean
  promoteToFront?: boolean
}) {
  return {
    _id: "posts:test" as Id<"pages">,
    _creationTime: 0,
    pageType: "post",
    slug: "sample-post",
    status: "published",
    createdAt: 0,
    updatedAt: 0,
    featured: overrides.featured ?? false,
    promoteToFront: overrides.promoteToFront ?? false,
    tags: overrides.tags,
    authorIds: undefined,
    category: undefined,
    content: {
      en: {
        title: "Sample post title",
        slices: [],
      },
    },
  } as unknown as Doc<"pages">
}

const bylineFixture: PublicByline = {
  name: "Ada Lovelace",
  roleTitle: "Editor at large",
  avatarUrl: null,
}

describe("PostRenderer", () => {
  for (const profileRow of [
    ["empty", []],
    ["populated", [heroSlice]],
  ] as const) {
    it.each([profileRow])("renders one outer element with the resolved page heading for %s content", sliceProfile([]),
      (_state, slices) => {
        const page = makePost({})
        const content = page.content!.en!
        const { container } = render(
          <PostRenderer
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
            name: slices.length ? "Hero heading" : "Sample post title",
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

  it("never renders admin-only tags in the DOM", sliceProfile([]), () => {
    const page = makePost({ tags: ["internal-secret-tag"] })
    const content = page.content!.en!
    const { container } = render(
      <PostRenderer
        page={page as never}
        content={content as never}
        slices={[heroSlice]}
        ctx={ctx}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[]}
      />
    )
    expect(container.textContent ?? "").not.toContain("internal-secret-tag")
  })

  it("shows the public byline when descriptor marks authorIds public", sliceProfile([]), () => {
    const page = makePost({})
    const content = page.content!.en!
    render(
      <PostRenderer
        page={page as never}
        content={content as never}
        slices={[heroSlice]}
        ctx={ctx}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[bylineFixture]}
      />
    )
    expect(screen.getByText("By Ada Lovelace")).toBeInTheDocument()
    expect(screen.getByText("Editor at large")).toBeInTheDocument()
  })

  it("formats a multi-author byline and hides the single-author role title", sliceProfile([]), () => {
    const page = makePost({})
    const content = page.content!.en!
    const coAuthor: PublicByline = {
      name: "Grace Hopper",
      roleTitle: "Contributor",
      avatarUrl: null,
    }
    render(
      <PostRenderer
        page={page as never}
        content={content as never}
        slices={[heroSlice]}
        ctx={ctx}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[bylineFixture, coAuthor]}
      />
    )
    expect(
      screen.getByText("By Ada Lovelace and Grace Hopper")
    ).toBeInTheDocument()
    expect(screen.queryByText("Editor at large")).not.toBeInTheDocument()
    expect(screen.queryByText("Contributor")).not.toBeInTheDocument()
  })

  it("lets a non-empty opening Hero own the page heading", sliceProfile([]), () => {
    const page = makePost({})
    const content = page.content!.en!
    render(
      <PostRenderer
        page={page as never}
        content={content as never}
        slices={[heroSlice]}
        ctx={ctx}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[]}
      />
    )
    const heading = screen.getByRole("heading", {
      name: "Hero heading",
      level: 1,
    })
    expect(heading.className).not.toContain("sr-only")
    expect(
      screen.queryByRole("heading", { name: "Sample post title" })
    ).toBeNull()
  })

  it("does not surface the featured / promoteToFront flags as visible copy", sliceProfile([]), () => {
    const page = makePost({ featured: true, promoteToFront: true })
    const content = page.content!.en!
    const { container } = render(
      <PostRenderer
        page={page as never}
        content={content as never}
        slices={[heroSlice]}
        ctx={ctx}
        locale="en"
        renderLocale="en"
        defaultLocale="en"
        bylines={[]}
      />
    )
    const text = (container.textContent ?? "").toLowerCase()
    expect(text).not.toContain("featured")
    expect(text).not.toContain("promoted")
  })
})


it("ED3 avatar beside its author name is decorative", sliceProfile([]), () => {
  const page = makePost({})
  const view = render(<PostRenderer page={page as never} content={page.content!.en! as never} slices={[heroSlice]} ctx={ctx} locale="en" renderLocale="en" defaultLocale="en" bylines={[{ ...bylineFixture, avatarUrl: "https://example.com/avatar.png" }]} />)
  expect(view.container.querySelector("img")).toHaveAttribute("alt", "")
  expect(screen.getByText("By Ada Lovelace")).toBeInTheDocument()
})

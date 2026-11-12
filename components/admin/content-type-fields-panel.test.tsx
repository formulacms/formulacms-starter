import { describe, expect, it, vi } from "vitest"
import { fireEvent, screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { group, list, text } from "@/convex/lib/slices/primitives"
import type { AdminContentType } from "@/lib/admin/content-types"
import { ContentTypeFieldsPanel } from "./content-type-fields-panel"

// Author is the only shipped descriptor with authorable localized fields today
// (roleTitle / bio), so real-descriptor coverage rides on author. The
// `descriptorOverride` prop exists specifically for the pure-form / mock-
// descriptor path plan 029 C8 calls out — no shipped descriptor has
// `sliceBody:false`, so component-level assertions have to inject one.

const authorSummary: AdminContentType = {
  type: "author",
  singular: "Author",
  plural: "Authors",
  routable: true,
  dictionaryKey: "author",
}

const postSummary: AdminContentType = {
  type: "post",
  singular: "Post",
  plural: "Posts",
  routable: true,
  dictionaryKey: "post",
}

const pageSummary: AdminContentType = {
  type: "page",
  singular: "Page",
  plural: "Pages",
  routable: true,
  dictionaryKey: "page",
}

describe("ContentTypeFieldsPanel", () => {
  it("renders both sections for the author descriptor (shared name/socials + localized roleTitle/bio)", () => {
    render(
      <ContentTypeFieldsPanel
        contentType={authorSummary}
        sharedValues={{ name: "Ada Lovelace" }}
        localizedValues={{ roleTitle: "Mathematician", bio: "" }}
        onSharedChange={() => {}}
        onLocalizedChange={() => {}}
        currentLocale="en"
      />,
    )
    expect(screen.getByText("All locales")).toBeInTheDocument()
    expect(screen.getByText("EN")).toBeInTheDocument()
    // Shared bag renders name + socials list
    expect(screen.getByDisplayValue("Ada Lovelace")).toBeInTheDocument()
    // Localized bag renders roleTitle
    expect(screen.getByDisplayValue("Mathematician")).toBeInTheDocument()
  })

  it("excludes system-owned localized keys (title/metaTitle/metaDescription) via ownership map", () => {
    // Mock descriptor mimicking post's localized set so the assertion is
    // hermetic — no ConvexProvider needed. The ownership map filters the
    // three keys before FieldsEditor sees them.
    render(
      <ContentTypeFieldsPanel
        contentType={postSummary}
        sharedValues={{}}
        localizedValues={{
          title: "not rendered here",
          metaTitle: "not rendered here either",
          metaDescription: "still not",
        }}
        onSharedChange={() => {}}
        onLocalizedChange={() => {}}
        currentLocale="en"
        descriptorOverride={{
          sharedFields: {},
          localizedFields: {
            title: text(),
            metaTitle: text().optional(),
            metaDescription: text({ multiline: true }).optional(),
          },
        }}
      />,
    )
    // Every localized key is system-owned → panel returns null entirely
    // when sharedFields is empty. Value strings must not appear anywhere.
    expect(screen.queryByDisplayValue("not rendered here")).toBeNull()
    expect(screen.queryByDisplayValue("not rendered here either")).toBeNull()
  })

  it("excludes system-owned shared keys (tags → Internal Labels adapter)", () => {
    // Hermetic mock — a synthetic `tags` list primitive alongside a
    // non-system-owned `category`. Category renders; tags does not.
    render(
      <ContentTypeFieldsPanel
        contentType={postSummary}
        sharedValues={{
          tags: ["should", "not", "render"],
          category: "kept",
        }}
        localizedValues={{}}
        onSharedChange={() => {}}
        onLocalizedChange={() => {}}
        currentLocale="en"
        descriptorOverride={{
          sharedFields: {
            tags: list(text()).optional(),
            category: text().optional(),
          },
          localizedFields: {},
        }}
      />,
    )
    // category renders — tags does not
    expect(screen.getByDisplayValue("kept")).toBeInTheDocument()
    expect(screen.queryByDisplayValue("should")).toBeNull()
  })

  it("returns null when descriptor has zero authorable fields after ownership filter", () => {
    // `page` descriptor: empty sharedFields; localized = {title, metaTitle,
    // metaDescription} which are all system-owned. Nothing to render.
    const { container } = render(
      <ContentTypeFieldsPanel
        contentType={pageSummary}
        sharedValues={{}}
        localizedValues={{}}
        onSharedChange={() => {}}
        onLocalizedChange={() => {}}
        currentLocale="en"
      />,
    )
    expect(container.firstChild).toBeNull()
  })

  it("emits shared bag changes with the full object (clearing works)", () => {
    const onSharedChange = vi.fn<(next: Record<string, unknown>) => void>()
    render(
      <ContentTypeFieldsPanel
        contentType={authorSummary}
        sharedValues={{ name: "Ada" }}
        localizedValues={{ roleTitle: "" }}
        onSharedChange={onSharedChange}
        onLocalizedChange={() => {}}
        currentLocale="en"
      />,
    )
    fireEvent.change(screen.getByDisplayValue("Ada"), {
      target: { value: "Ada Lovelace" },
    })
    // Non-optional `name` writes a string; onChange receives the full shared bag
    // shape including any pre-existing keys.
    expect(onSharedChange).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ada Lovelace" }),
    )
  })

  it("threads dir onto the localized (content-editing) section only", () => {
    // Admin chrome stays LTR; only the content-editing bag inherits RTL.
    const { container } = render(
      <ContentTypeFieldsPanel
        contentType={authorSummary}
        sharedValues={{ name: "أدا" }}
        localizedValues={{ roleTitle: "عالمة" }}
        onSharedChange={() => {}}
        onLocalizedChange={() => {}}
        currentLocale="ar"
        dir="rtl"
      />,
    )
    // Shared FieldsEditor wrapper defaults to ltr — descriptors have shared
    // identity fields (like author.name) that are locale-agnostic.
    const wrappers = container.querySelectorAll('[dir="ltr"], [dir="rtl"]')
    const rtlWrappers = Array.from(wrappers).filter(
      (el) => el.getAttribute("dir") === "rtl",
    )
    expect(rtlWrappers.length).toBeGreaterThan(0)
  })

  it("real testimonial descriptor renders 5 shared inputs + 1 localized quote (title is Settings-owned)", () => {
    // Plan 029 C10 task 13 — first real `sliceBody:false` content type
    // registered. No `descriptorOverride`; the panel reads through the
    // admin facade (`adminContentTypeSharedFields` /
    // `adminContentTypeLocalizedFields`) so this asserts the real
    // registered descriptor's shape flows through the ownership filter.
    render(
      <ContentTypeFieldsPanel
        contentType={{
          type: "testimonial",
          singular: "Testimonial",
          plural: "Testimonials",
          routable: false,
          dictionaryKey: "testimonial",
        }}
        sharedValues={{
          personName: "Grace Hopper",
          personRole: "Rear Admiral",
          personCompany: "US Navy",
          personImage: undefined,
          sourceUrl: "",
        }}
        localizedValues={{
          quote: "COBOL is a language for the ages",
        }}
        onSharedChange={() => {}}
        onLocalizedChange={() => {}}
        currentLocale="en"
      />,
    )
    // Shared bag renders personName / personRole / personCompany /
    // sourceUrl (personImage is an image widget — not asserted by value).
    expect(screen.getByDisplayValue("Grace Hopper")).toBeInTheDocument()
    expect(screen.getByDisplayValue("Rear Admiral")).toBeInTheDocument()
    expect(screen.getByDisplayValue("US Navy")).toBeInTheDocument()
    // Localized bag renders `quote`. `title` is filtered out by
    // `SYSTEM_OWNED_LOCALIZED_FIELDS` (edited via Settings panel per
    // plan 029 C10 §Q9.b — the settings panel adds an "Internal
    // identifier, never public" hint for testimonials).
    expect(
      screen.getByDisplayValue("COBOL is a language for the ages"),
    ).toBeInTheDocument()
    // No slice affordance leaks in from the panel.
    expect(screen.queryByRole("button", { name: /add block/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /pick block/i })).toBeNull()
  })

  it("mock sliceBody:false descriptor renders a pure form (no slice affordance in DOM)", () => {
    // No shipped descriptor has `sliceBody:false` today, so the pure-form
    // path is exercised via a descriptorOverride. This asserts the plan's
    // C8 guarantee: `ContentTypeFieldsPanel` is slice-agnostic — the slice
    // zone is composed by the host, so nothing here mentions "slice" and
    // no picker / toolbar / add-section affordance renders inside the
    // panel's tree.
    render(
      <ContentTypeFieldsPanel
        contentType={{
          type: "testimonial" as never,
          singular: "Testimonial",
          plural: "Testimonials",
          routable: false,
          dictionaryKey: "testimonial",
        }}
        sharedValues={{ personName: "", quote: "" }}
        localizedValues={{}}
        onSharedChange={() => {}}
        onLocalizedChange={() => {}}
        currentLocale="en"
        descriptorOverride={{
          sharedFields: {
            personName: text({ placeholder: "Person name" }),
            quote: text({ multiline: true, placeholder: "Their words" }),
            highlights: list(
              group({ label: text() }),
            ).optional(),
          },
          localizedFields: {},
        }}
      />,
    )
    // Fields render.
    expect(screen.getByPlaceholderText("Person name")).toBeInTheDocument()
    expect(screen.getByPlaceholderText("Their words")).toBeInTheDocument()
    // No slice-composition affordance leaks in from FieldsEditor.
    const dom = document.body.textContent ?? ""
    expect(dom.toLowerCase()).not.toContain("block")
    expect(screen.queryByRole("button", { name: /add section/i })).toBeNull()
    expect(screen.queryByRole("button", { name: /pick block/i })).toBeNull()
  })
})

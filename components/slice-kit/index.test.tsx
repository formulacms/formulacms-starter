import { describe, expect, it, vi } from "vitest"
import { cloneElement, isValidElement } from "react"
import { renderToStaticMarkup, renderToString } from "react-dom/server"
import { fireEvent, render, screen } from "@testing-library/react"
import { button } from "@/convex/lib/slices/fields"
import { group, list, richText, text } from "@/convex/lib/slices/primitives"
import type { SliceRenderContext } from "@/lib/slices/links"
import { bindSliceFields, RichText } from "./index"
import { Accordion, type AccordionRow } from "./accordion"

describe("descriptor-bound slice fields", () => {
  const descriptor = {
    primary: group({
      heading: richText({ profile: "inline" }),
      nested: group({ title: text().optional() }),
    }),
    items: list(group({ title: richText({ profile: "inline" }) })),
  }
  const slice = {
    primary: { heading: '{"type":"doc","content":[]}', nested: {} },
    items: [{ title: '{"type":"doc","content":[{"type":"paragraph"}]}' }],
  }

  it("normalizes accepted bracket paths and resolves nested optional and list values", () => {
    const fields = bindSliceFields(descriptor, slice)
    expect(fields.resolve("items[0].title")?.fieldPath).toBe("items.0.title")
    expect(fields.isEmpty("primary.nested.title")).toBe(true)
    expect(fields.isEmpty("items[0].title")).toBe(true)
  })

  it.each([
    "items[0",
    "items[0].title]",
    "items.0.title",
    "items[-1].title",
    "items[2].title",
    "primary.__proto__",
  ])("refuses malformed, partial, forbidden, or absent-row path %s", (path) => {
    const fields = bindSliceFields(descriptor, slice)
    expect(fields.resolve(path as never)).toBeNull()
  })

  it("accepts a descriptor-bound button-list path without changing stored shape", () => {
    const buttonDescriptor = {
      primary: group({ heading: richText({ profile: "inline" }) }),
      items: list(button),
    }
    const fields = bindSliceFields(buttonDescriptor, {
      primary: { heading: "{}" },
      items: [],
    })
    expect(fields.isEmpty("items")).toBe(true)
    expect(list(button).kind).toBe("list")
  })

  it("stamps kit rich text once on its semantic host and leaves public HTML unmarked", () => {
    const headingDescriptor = {
      primary: group({ heading: richText({ profile: "inline" }) }),
    }
    const headingSlice = {
      primary: {
        heading:
          '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Heading"}]}]}',
      },
    }
    const fields = bindSliceFields(headingDescriptor, headingSlice)
    const previewRichText = vi.fn<
      NonNullable<SliceRenderContext["previewRichText"]>
    >(({ fieldPath, profile, rendered }) =>
      isValidElement<Record<string, unknown>>(rendered)
        ? cloneElement(rendered, {
            "data-preview-field": fieldPath,
            "data-preview-inline-contract": profile,
          })
        : rendered
    )
    const previewField = vi.fn<NonNullable<SliceRenderContext["previewField"]>>(
      ({ fieldPath, rendered }) =>
        isValidElement<Record<string, unknown>>(rendered)
          ? cloneElement(rendered, { "data-preview-field": fieldPath })
          : rendered
    )
    const previewContext: SliceRenderContext = {
      locale: "en",
      defaultLocale: "en",
      pagePaths: {},
      relationCards: {},
      previewRichText,
      previewField,
    }

    const previewHtml = renderToStaticMarkup(
      <RichText
        fields={fields}
        fieldPath="primary.heading"
        as="h2"
        ctx={previewContext}
      />
    )
    const previewDocument = document.implementation.createHTMLDocument()
    previewDocument.body.innerHTML = previewHtml
    const marked = previewDocument.querySelectorAll(
      '[data-preview-field="primary.heading"]'
    )
    expect(previewRichText).toHaveBeenCalledTimes(1)
    expect(previewField).not.toHaveBeenCalled()
    expect(marked).toHaveLength(1)
    expect(marked[0]?.tagName).toBe("H2")
    expect(marked[0]?.getAttribute("data-preview-inline-contract")).toBe(
      "inline"
    )
    expect(
      marked[0]?.firstElementChild?.hasAttribute("data-preview-field")
    ).toBe(false)

    const publicHtml = renderToStaticMarkup(
      <RichText fields={fields} fieldPath="primary.heading" as="h2" />
    )
    expect(publicHtml).not.toContain("data-preview-field")
    expect(publicHtml).not.toContain("data-preview-inline-contract")
  })
})

describe("kit accordion keeps closed answers in the HTML", () => {
  const rows: AccordionRow[] = ["one", "two", "three"].map((key) => ({
    key,
    title: `Question ${key}?`,
    answer: `Answer ${key}.`,
    headingLevel: 3,
  }))

  function panelOf(text: string) {
    return screen.getByText(text).closest('[data-slot="accordion-content"]')
  }

  // jsdom loads no Tailwind: these assert the class contract, not the
  // rendered height, visibility or the grid-row transition itself.
  it("renders every answer and hides the closed ones with CSS", () => {
    render(<Accordion rows={rows} label="FAQ" />)

    expect(panelOf("Answer one.")?.getAttribute("data-state")).toBe("open")
    for (const text of ["Answer two.", "Answer three."]) {
      const panel = panelOf(text)
      expect(panel?.getAttribute("data-state")).toBe("closed")
      expect(panel?.className).toContain("group/accordion-content")
      const row = panel?.firstElementChild?.className.split(" ")
      expect(row).toContain("grid-rows-[0fr]")
      expect(row).toContain("group-data-[state=open]/accordion-content:grid-rows-[1fr]")
      expect(row).toContain("group-data-[state=closed]/accordion-content:invisible")
    }

    fireEvent.click(screen.getByRole("button", { name: "Question two?" }))
    expect(panelOf("Answer two.")?.getAttribute("data-state")).toBe("open")
  })

  it("puts a closed answer in the server HTML", () => {
    const html = renderToString(<Accordion rows={rows} label="FAQ" />)
    expect(html).toContain("Answer three.")
  })
})

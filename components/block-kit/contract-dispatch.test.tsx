import { describe, expect, it } from "vitest"
import { cloneElement, createElement, isValidElement } from "react"
import { RichTextContent } from "@/components/blocks/rich-text-content"
import { renderToStaticMarkup } from "react-dom/server"
import { group, richText } from "@/convex/lib/blocks/primitives"
import { RichText, bindBlockFields, HeadingSlot } from "./index"
import type { BlockRenderContext } from "@/lib/blocks/links"

const doc = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [{ type: "text", text: "Title", marks: [{ type: "bold" }] }],
    },
  ],
})
const context: BlockRenderContext = {
  locale: "en",
  defaultLocale: "en",
  pagePaths: {},
}

describe("resolved contract kit dispatch", () => {
  it.each(["inline", "basic", "full"] as const)(
    "renders profile %s byte-identically to its contract alias",
    (profile) => {
      const legacy = bindBlockFields(
        { primary: group({ body: richText({ profile }) }) },
        { primary: { body: doc } }
      )
      const current = bindBlockFields(
        { primary: group({ body: richText({ contract: profile }) }) },
        { primary: { body: doc } }
      )
      expect(
        renderToStaticMarkup(
          <RichText fields={current} fieldPath="primary.body" ctx={context} />
        )
      ).toBe(
        renderToStaticMarkup(
          <RichText fields={legacy} fieldPath="primary.body" ctx={context} />
        )
      )
      // Frozen pre-RF3 profile dispatch and host shape, independent of the kit.
      const previousProfileOutput = createElement(
        profile === "inline" ? "span" : "div",
        {},
        <RichTextContent
          value={doc}
          profile={profile}
          ctx={context}
          fieldPath="primary.body"
        />
      )
      expect(
        renderToStaticMarkup(
          <RichText fields={legacy} fieldPath="primary.body" ctx={context} />
        )
      ).toBe(renderToStaticMarkup(previousProfileOutput))
      for (const value of ["", '{"type":"doc","content":[]}']) {
        const empty = bindBlockFields(
          { primary: group({ body: richText({ contract: profile }) }) },
          { primary: { body: value } }
        )
        expect(empty.isEmpty("primary.body")).toBe(true)
        expect(
          renderToStaticMarkup(
            <RichText fields={empty} fieldPath="primary.body" />
          )
        ).toBe("")
      }
    }
  )
  it.each([
    doc,
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 6 },
          content: [{ type: "text", text: "Title", marks: [{ type: "bold" }] }],
        },
      ],
    }),
    '<p><a href="https://example.com"><strong>Title</strong></a></p>',
  ])(
    "renders a contract-only title with renderer-owned level and unchanged source",
    (value) => {
      const block = { primary: { title: value } }
      const before = JSON.stringify(block)
      const fields = bindBlockFields(
        { primary: group({ title: richText({ contract: "title" }) }) },
        block
      )
      const html = renderToStaticMarkup(
        <RichText
          fields={fields}
          fieldPath="primary.title"
          id="title"
          ctx={context}
        />
      )
      const host = document.createElement("div")
      host.innerHTML = html
      expect(host.querySelectorAll("h2")).toHaveLength(1)
      expect(host.querySelector("h2")?.textContent).toBe("Title")
      expect(host.querySelector("h2 h1,h2 h2,h2 h6,h2 a")).toBeNull()
      expect(JSON.stringify(block)).toBe(before)
    }
  )
  it("keeps contract identity and stamps on a single native title host", () => {
    const fields = bindBlockFields(
      { primary: group({ title: richText({ contract: "title" }) }) },
      { primary: { title: doc } }
    )
    const html = renderToStaticMarkup(
      <RichText
        fields={fields}
        fieldPath="primary.title"
        data-tweak-loc="file:1:1"
        ctx={{
          ...context,
          previewRichText: ({ contract, rendered, fieldPath }) =>
            isValidElement<Record<string, unknown>>(rendered)
              ? cloneElement(rendered, {
                  "data-preview-field": fieldPath,
                  "data-preview-inline-contract": contract,
                })
              : rendered,
        }}
      />
    )
    const host = document.createElement("div")
    host.innerHTML = html
    expect(host.querySelectorAll("[data-preview-field]")).toHaveLength(1)
    expect(
      host.querySelector("h2")?.getAttribute("data-preview-inline-contract")
    ).toBe("title")
    expect(host.querySelector("h2")?.getAttribute("data-tweak-loc")).toBe(
      "file:1:1"
    )
    expect(
      renderToStaticMarkup(
        <RichText fields={fields} fieldPath="primary.title" host="inline" />
      )
    ).toMatch(/^<span/)
    expect(
      renderToStaticMarkup(
        <HeadingSlot level={2} data-tweak-loc="x">
          Words
        </HeadingSlot>
      )
    ).toContain('data-tweak-loc="x"')
  })
})

it("resolves declared title parents and body floors on render-only fields", () => {
  const descriptor = {
    primary: group({
      title: richText({ contract: "title" }),
      subtitle: richText({
        contract: "title",
        heading: { role: "itemTitle", parent: "primary.title" },
      }),
      body: richText({
        contract: "basic",
        headingFloor: { parent: "primary.subtitle" },
      }),
    }),
  }
  const body = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Body" }],
      },
    ],
  })
  for (const [title, expected] of [
    [doc, 3],
    ["", 2],
  ] as const) {
    const fields = bindBlockFields(descriptor, {
      primary: { title, subtitle: doc, body },
    })
    const container = document.createElement("div")
    container.innerHTML = renderToStaticMarkup(
      <>
        <RichText fields={fields} fieldPath="primary.subtitle" />
        <RichText fields={fields} fieldPath="primary.body" />
      </>
    )
    expect(container.querySelector(`h${expected}`)?.textContent).toBe("Title")
    expect(container.querySelector(`h${expected + 1}`)?.textContent).toBe(
      "Body"
    )
  }
})

import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock(import("@tiptap/core"), async (importOriginal) => {
  const original = await importOriginal()
  return { ...original, getSchema: vi.fn(original.getSchema) }
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe("static renderer ProseMirror seams", () => {
  it("builds one cached schema per contract and reuses it on later renders", async () => {
    vi.resetModules()
    const core = await import("@tiptap/core")
    const getSchema = vi.mocked(core.getSchema)
    getSchema.mockClear()
    const { renderStaticRichTextDocument } = await import("./static-render")

    for (const contract of ["title", "inline", "basic", "full"] as const) {
      const document = { type: "doc", content: [] }
      renderStaticRichTextDocument(document, contract)
      renderStaticRichTextDocument(document, contract)
    }

    expect(getSchema).toHaveBeenCalledTimes(4)
    expect(getSchema.mock.calls.map(([extensions]) => extensions)).toHaveLength(
      4
    )
  })

  it("omits a node whose extension renderHTML throws and keeps sibling nodes", async () => {
    vi.resetModules()
    const extensionsModule = await import("./extensions")
    const getExtensions = extensionsModule.extensionsForContract
    vi.spyOn(extensionsModule, "extensionsForContract").mockImplementation(
      (contract) =>
        getExtensions(contract).map((extension) =>
          extension.name === "paragraph"
            ? extension.extend({
                renderHTML() {
                  throw new Error("paragraph render failure")
                },
              })
            : extension
        )
    )
    const { renderStaticRichTextDocument } = await import("./static-render")
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)

    const output = renderStaticRichTextDocument(
      {
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "before" }],
          },
          { type: "paragraph", content: [{ type: "text", text: "omitted" }] },
          {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: "after" }],
          },
        ],
      },
      "full"
    )

    expect(renderToStaticMarkup(createElement("div", null, output))).toBe(
      "<div><h2>before</h2><h3>after</h3></div>"
    )
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it("contains a field-preparation getter failure as an empty field", async () => {
    vi.resetModules()
    const { renderStaticRichTextDocument } = await import("./static-render")
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)
    const document = {
      type: "doc",
      get content(): never {
        throw new Error("synthetic preparation fault")
      },
    }

    const output = renderStaticRichTextDocument(document, "basic")
    expect(renderToStaticMarkup(createElement("div", null, output))).toBe(
      "<div></div>"
    )
    expect(warning).toHaveBeenCalledTimes(1)
  })
})

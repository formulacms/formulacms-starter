import { renderToStaticMarkup } from "react-dom/server"
import { getSchema } from "@tiptap/core"
import { Node as PMNode } from "@tiptap/pm/model"
import { afterEach, describe, expect, it, vi } from "vitest"
import { extensionsForProfile } from "@/lib/rich-text/extensions"
import { renderStaticRichTextDocument } from "@/lib/rich-text/static-render"
import {
  nextPendingClick,
  placeInputCaret,
  placeRichTextCaret,
  previewClickCount,
  previewTextOffsetAt,
  previewTextOffsetFromPoint,
  readPreviewClick,
  registerRichTextCaret,
  richTextPositionAtTextOffset,
  richTextSelectionAtPos,
  wordRangeAt,
} from "./rich-text-caret"
import { isPreviewFieldSelection } from "./visual-editing-types"

const text = (value: string, marks?: { type: string }[]) => ({
  type: "text",
  text: value,
  ...(marks ? { marks } : {}),
})

const documentJson = {
  type: "doc",
  content: [
    { type: "heading", attrs: { level: 2 }, content: [text("Title")] },
    {
      type: "paragraph",
      content: [text("Plain "), text("bold", [{ type: "bold" }]), text(" end")],
    },
    {
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [{ type: "paragraph", content: [text("item one")] }],
        },
      ],
    },
    { type: "paragraph", content: [text("Second paragraph")] },
  ],
}

const doc = PMNode.fromJSON(getSchema(extensionsForProfile("full")), documentJson)

function renderPreview() {
  const root = document.createElement("div")
  root.innerHTML = renderToStaticMarkup(
    renderStaticRichTextDocument(documentJson, "full")
  )
  document.body.append(root)
  return root
}

function textNodeContaining(root: Node, needle: string) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if ((node as Text).data.includes(needle)) return node as Text
  throw new Error(`no text node with ${needle}`)
}

/** Click in the preview after `before` inside the text node holding it. */
function previewToEditor(root: HTMLElement, needle: string, before: string) {
  const node = textNodeContaining(root, needle)
  const offset = previewTextOffsetAt(root, node, node.data.indexOf(before))
  return richTextPositionAtTextOffset(doc, offset!)
}

/** Text after the caret in the editor document. */
function textAfter(pos: number) {
  const $pos = doc.resolve(pos)
  return $pos.parent.textBetween($pos.parentOffset, $pos.parent.content.size)
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("rich-text caret from a preview click", () => {
  it("lands on the clicked word in the second paragraph", () => {
    const root = renderPreview()
    expect(textAfter(previewToEditor(root, "Second", "paragraph")!)).toBe(
      "paragraph"
    )
  })

  it("counts marks and list items the same way on both sides", () => {
    const root = renderPreview()
    expect(textAfter(previewToEditor(root, "bold", "old")!)).toBe("old end")
    expect(textAfter(previewToEditor(root, " end", "nd")!)).toBe("nd")
    expect(textAfter(previewToEditor(root, "item", "one")!)).toBe("one")
    expect(textAfter(previewToEditor(root, "Title", "tle")!)).toBe("tle")
  })

  it("keeps the start of a paragraph distinct from the end of the one before", () => {
    const root = renderPreview()
    const start = previewToEditor(root, "Second", "Second")!
    expect(textAfter(start)).toBe("Second paragraph")
    const node = textNodeContaining(root, "item one")
    const end = richTextPositionAtTextOffset(
      doc,
      previewTextOffsetAt(root, node, node.data.length)!
    )!
    expect(doc.resolve(end).parent.textContent).toBe("item one")
    expect(textAfter(end)).toBe("")
  })

  it("maps an element boundary to the text before it", () => {
    const root = renderPreview()
    const paragraphs = root.querySelectorAll("p")
    const second = paragraphs[paragraphs.length - 1]!
    expect(previewTextOffsetAt(root, second, 0)).toBe(
      previewTextOffsetAt(root, textNodeContaining(root, "Second"), 0)
    )
    expect(previewTextOffsetAt(root, root, root.childNodes.length)).toBe(
      previewTextOffsetAt(root, textNodeContaining(root, "Second"), 16)
    )
  })

  it("counts an inline-only host (a title) as the one paragraph its editor has", () => {
    const heading = document.createElement("h1")
    heading.innerHTML = "Our <strong>digital</strong> work"
    document.body.append(heading)
    const title = PMNode.fromJSON(getSchema(extensionsForProfile("full")), {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [text("Our "), text("digital", [{ type: "bold" }]), text(" work")],
        },
      ],
    })
    const node = textNodeContaining(heading, "digital")
    const pos = richTextPositionAtTextOffset(
      title,
      previewTextOffsetAt(heading, node, 3)!
    )!
    const $pos = title.resolve(pos)
    expect(
      $pos.parent.textBetween($pos.parentOffset, $pos.parent.content.size)
    ).toBe("ital work")
  })

  it("clamps an offset past the end to the last text position", () => {
    expect(richTextPositionAtTextOffset(doc, 10_000)).toBe(
      doc.content.size - 1
    )
    expect(richTextPositionAtTextOffset(doc, 0)).toBe(1)
  })

  it("gives no position for a document without text blocks", () => {
    const empty = { isText: false, isTextblock: false, descendants() {} }
    expect(richTextPositionAtTextOffset(empty, 3)).toBeUndefined()
  })

  it("sends no offset for a point outside the field", () => {
    const root = renderPreview()
    const outside = document.createElement("p")
    outside.textContent = "elsewhere"
    document.body.append(outside)
    expect(previewTextOffsetAt(root, outside.firstChild!, 2)).toBeUndefined()
    // jsdom has no caret-from-point API, so the browser cannot tell.
    expect(previewTextOffsetFromPoint(root, 1, 1)).toBeUndefined()
  })
})

describe("rich-text caret registry", () => {
  it("places the caret through the nearest registered editor", () => {
    const host = document.createElement("div")
    const surface = document.createElement("div")
    host.append(surface)
    const place = vi.fn()
    const unregister = registerRichTextCaret(host, place)
    expect(placeRichTextCaret(surface, 7)).toBe(true)
    expect(place).toHaveBeenCalledWith(7, 1)
    expect(placeRichTextCaret(surface, 7, 3)).toBe(true)
    expect(place).toHaveBeenLastCalledWith(7, 3)
    unregister()
    expect(placeRichTextCaret(surface, 7)).toBe(false)
  })

  it("reports no editor so the form keeps its plain focus", () => {
    expect(placeRichTextCaret(document.createElement("input"), 3)).toBe(false)
  })
})

describe("preview field selection message", () => {
  const base = { blockId: "s1", fieldPath: "primary.body" }
  it("accepts a whole non-negative text offset or none", () => {
    expect(isPreviewFieldSelection(base)).toBe(true)
    expect(isPreviewFieldSelection({ ...base, textOffset: 0 })).toBe(true)
    expect(isPreviewFieldSelection({ ...base, textOffset: 42 })).toBe(true)
  })
  it("refuses a negative, fractional or non-number text offset", () => {
    for (const textOffset of [-1, 1.5, Number.NaN, Infinity, "3", null])
      expect(isPreviewFieldSelection({ ...base, textOffset })).toBe(false)
  })
  it("carries a double or triple click count, never another one", () => {
    expect(isPreviewFieldSelection({ ...base, clickCount: 2 })).toBe(true)
    expect(isPreviewFieldSelection({ ...base, clickCount: 3 })).toBe(true)
    for (const clickCount of [0, 1, 4, "2", null])
      expect(isPreviewFieldSelection({ ...base, clickCount })).toBe(false)
  })
})

describe("word rule shared by every editor", () => {
  const word = (text: string, index: number, segmenter = true) => {
    const range = wordRangeAt(text, index, { segmenter })
    return text.slice(range.start, range.end)
  }
  it.each([true, false])("selects French words whole (Intl.Segmenter %s)", (segmenter) => {
    const text = "l’été dernier, à Montréal!"
    expect(word(text, 2, segmenter)).toBe("l’été")
    expect(word("l'été", 0, segmenter)).toBe("l'été")
    expect(word(text, text.indexOf("tréal"), segmenter)).toBe("Montréal")
    expect(word(text, text.indexOf("à"), segmenter)).toBe("à")
  })
  it.each([true, false])("prefers the letter after the caret, then the word before it (Intl.Segmenter %s)", (segmenter) => {
    const text = "Hello world"
    // Left edge of "world" and right edge of "Hello" (a click on the right
    // half of its last letter).
    expect(word(text, 6, segmenter)).toBe("world")
    expect(word(text, 5, segmenter)).toBe("Hello")
    expect(word(text, 0, segmenter)).toBe("Hello")
    expect(word(text, text.length, segmenter)).toBe("world")
  })
  it.each([true, false])("selects punctuation or space away from any word (Intl.Segmenter %s)", (segmenter) => {
    expect(word("Prix : 12 €", 5, segmenter)).toBe(":")
    expect(word("a  b", 2, segmenter)).toBe("  ")
    expect(word("", 0, segmenter)).toBe("")
  })
})

describe("click count selection in a rich-text document", () => {
  const select = (needle: string, count: 1 | 2 | 3) => {
    let pos = 0
    doc.descendants((node, at) => {
      if (node.isText && node.text!.includes(needle))
        pos = at + node.text!.indexOf(needle) + 1
    })
    const { from, to } = richTextSelectionAtPos(doc, pos, count)
    return doc.textBetween(from, to, "|")
  }
  it("places a caret, the clicked word or the clicked paragraph", () => {
    expect(select("aragraph", 1)).toBe("")
    expect(select("aragraph", 2)).toBe("paragraph")
    // Marks split text nodes, not words.
    expect(select("old", 2)).toBe("bold")
    expect(select("tem one", 2)).toBe("item")
    // A triple click selects the paragraph under the pointer, as the
    // browser does in an open editor; a list item's paragraph too.
    expect(select("aragraph", 3)).toBe("Second paragraph")
    expect(select("old", 3)).toBe("Plain bold end")
    expect(select("tem one", 3)).toBe("item one")
    expect(select("itle", 3)).toBe("Title")
  })
  it("reads the count of a mouse event and keeps a keyboard click without one", () => {
    expect([0, 1, 2, 3, 4].map(previewClickCount)).toEqual([1, 1, 2, 3, 3])
    const host = document.createElement("span")
    expect(
      readPreviewClick(host, { detail: 0, clientX: 0, clientY: 0 })
    ).toBeUndefined()
    expect(
      readPreviewClick(host, { detail: 2, clientX: 4, clientY: 5 })
    ).toMatchObject({ left: 4, top: 5, clickCount: 2 })
  })
  it("raises a pending click's count and keeps its first spot", () => {
    const first = { left: 1, top: 2, textOffset: 7, clickCount: 1 as const }
    const second = { left: 3, top: 4, textOffset: 9, clickCount: 2 as const }
    expect(nextPendingClick(first, second)).toEqual({ ...first, clickCount: 2 })
    expect(nextPendingClick(undefined, second)).toBe(second)
    expect(nextPendingClick(first, undefined)).toBe(first)
  })
})

describe("plain-text field caret", () => {
  it("puts an input or textarea caret on the clicked letter", () => {
    for (const tag of ["input", "textarea"] as const) {
      const field = document.createElement(tag)
      field.value = "Montreal agency"
      document.body.append(field)
      // The preview counts one implicit block before the text: letter 4 is 5.
      expect(placeInputCaret(field, 5)).toBe(true)
      expect(document.activeElement).toBe(field)
      expect([field.selectionStart, field.selectionEnd]).toEqual([4, 4])
    }
  })

  it("clamps to the field's text", () => {
    const input = document.createElement("input")
    input.value = "Short"
    document.body.append(input)
    placeInputCaret(input, 99)
    expect(input.selectionStart).toBe(5)
    placeInputCaret(input, 0)
    expect(input.selectionStart).toBe(0)
  })

  it("leaves other elements to the caller", () => {
    expect(placeInputCaret(document.createElement("div"), 3)).toBe(false)
  })

  it("selects the line around the click in a textarea on a triple click", () => {
    const field = document.createElement("textarea")
    field.value = "First line\nSecond line\n\nLast"
    document.body.append(field)
    const lineOf = (index: number) => {
      // The preview offset counts one implicit block first.
      placeInputCaret(field, index + 1, 3)
      return field.value.slice(field.selectionStart!, field.selectionEnd!)
    }
    expect(lineOf(0)).toBe("First line")
    expect(lineOf(field.value.indexOf("cond"))).toBe("Second line")
    expect(lineOf(field.value.indexOf("Second"))).toBe("Second line")
    expect(lineOf(field.value.indexOf("\n\n") + 1)).toBe("")
    expect(lineOf(field.value.length)).toBe("Last")
  })

  it("selects the clicked word on a double click and the value on a triple click", () => {
    for (const tag of ["input", "textarea"] as const) {
      const field = document.createElement(tag)
      field.value = "Agence à Montréal"
      document.body.append(field)
      const offset = 1 + field.value.indexOf("tréal")
      placeInputCaret(field, offset, 2)
      expect(
        field.value.slice(field.selectionStart!, field.selectionEnd!)
      ).toBe("Montréal")
      placeInputCaret(field, offset, 3)
      expect([field.selectionStart, field.selectionEnd]).toEqual([
        0,
        field.value.length,
      ])
    }
  })

  it("counts a plain-text host as one implicit block", () => {
    const span = document.createElement("span")
    span.textContent = "Agency"
    document.body.append(span)
    expect(previewTextOffsetAt(span, span.firstChild!, 2)).toBe(3)
  })
})

import { Editor } from "@tiptap/core"
import { fireEvent } from "@testing-library/react"
import { afterEach, describe, expect, test } from "vitest"
import { extensionsForContract, extensionsForProfile } from "./extensions"
import { TitleInput } from "./title-input"

// The one title input rule (owner 2026-11-04, ADR-0055 amendment): a title is
// one line. Enter, Shift+Enter and Mod+Enter insert nothing, and a paste is
// joined with single spaces and keeps only what the title contract allows,
// without losing a word.
// Both editors use it: the form editor (paragraph schema) and the preview
// editor (heading schema).

const FORM_TITLE_MARKS = [
  "bold",
  "italic",
  "strike",
  "underline",
  "highlight",
  "subscript",
  "superscript",
]
const schemas: Array<[string, () => ReturnType<typeof extensionsForProfile>]> = [
  [
    "form editor (paragraph schema)",
    () =>
      extensionsForProfile("inline").filter(
        (extension) =>
          extension.type !== "mark" || FORM_TITLE_MARKS.includes(extension.name)
      ),
  ],
  ["preview editor (heading schema)", () => extensionsForContract("title")],
]

describe.each(schemas)("TitleInput in the %s", (_name, extensionsOf) => {
  let editor: Editor | null = null
  afterEach(() => editor?.destroy())

  function mount(content: string, withTitleInput = true) {
    editor = new Editor({
      extensions: [...extensionsOf(), ...(withTitleInput ? [TitleInput] : [])],
      content,
    })
    return editor
  }
  const clipboard = (data: Record<string, string>) => ({
    getData: (type: string) => data[type] ?? "",
    types: Object.keys(data),
  })
  const paste = (target: Editor, data: Record<string, string>) =>
    fireEvent.paste(target.view.dom, { clipboardData: clipboard(data) })
  const pressEnter = (target: Editor, init: KeyboardEventInit = {}) =>
    target.view.dom.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        ...init,
      })
    )
  const types = (target: Editor) =>
    JSON.stringify(target.getJSON()).match(/"type":"[a-zA-Z]+"/g)!
  const breaks = (target: Editor) =>
    types(target).filter((type) => type === '"type":"hardBreak"').length
  const blocks = (target: Editor) => target.getJSON().content!.length
  /** Words and line breaks as one string, a break being a space. */
  const flat = (target: Editor) =>
    target.state.doc.textBetween(0, target.state.doc.content.size, " ", " ")

  test.each([
    ["Enter", {}],
    ["Shift+Enter", { shiftKey: true }],
    ["Mod+Enter (Ctrl)", { ctrlKey: true }],
    ["Mod+Enter (Cmd)", { metaKey: true }],
  ] as const)("%s inserts nothing: no break, no new block", (_key, init) => {
    const target = mount("<p>ab</p>")
    target.commands.setTextSelection(2)
    const before = JSON.stringify(target.getJSON())
    pressEnter(target, init)
    expect(JSON.stringify(target.getJSON())).toBe(before)
    expect(blocks(target)).toBe(1)
    expect(breaks(target)).toBe(0)
  })

  test("a transaction that adds a break or a second block is rejected (mobile/IME guard)", () => {
    const target = mount("<p>ab</p>")
    const { schema } = target.state
    const before = JSON.stringify(target.getJSON())
    if (schema.nodes.hardBreak)
      target.view.dispatch(
        target.state.tr.insert(2, schema.nodes.hardBreak.create())
      )
    target.view.dispatch(
      target.state.tr.insert(
        target.state.doc.content.size,
        target.state.doc.type.schema.nodes[
          target.state.doc.firstChild!.type.name
        ].create()
      )
    )
    expect(JSON.stringify(target.getJSON())).toBe(before)
    target.commands.insertContentAt(2, "X")
    expect(flat(target)).toBe("aXb")
  })

  test("Enter that confirms an IME composition inserts nothing (isComposing, keyCode 229)", () => {
    for (const init of [{ isComposing: true }, { keyCode: 229 }]) {
      const target = mount("<p>ab</p>")
      target.commands.setTextSelection(2)
      pressEnter(target, init)
      expect(breaks(target)).toBe(0)
      expect(blocks(target)).toBe(1)
      target.destroy()
    }
  })

  test("a paste in the middle of a title keeps the text before and after on the same line", () => {
    const target = mount("<p>ab</p>")
    target.commands.setTextSelection(2)
    paste(target, {
      "text/html": "<p>X</p><p>Y</p>",
      "text/plain": "X\n\nY",
    })
    expect(blocks(target)).toBe(1)
    expect(breaks(target)).toBe(0)
    expect(flat(target)).toBe("aX Yb")
  })

  test("pasted plain lines are joined with single spaces, blank lines are ignored", () => {
    const target = mount("<p></p>")
    paste(target, { "text/plain": "a\r\n\r\nb\nc" })
    expect(blocks(target)).toBe(1)
    expect(breaks(target)).toBe(0)
    expect(flat(target)).toBe("a b c")
  })

  test("pasted text that looks like HTML or JSON stays text", () => {
    const target = mount("<p></p>")
    paste(target, { "text/plain": '<b>x</b>\n{"type":"doc"}' })
    expect(types(target)).not.toContain('"type":"bold"')
    expect(flat(target)).toBe('<b>x</b> {"type":"doc"}')
  })

  test("links become plain words and the title marks stay", () => {
    const target = mount("<p></p>")
    paste(target, {
      "text/html":
        '<p>Un <a href="https://example.com">lien</a></p><p><strong>Deux</strong></p>',
    })
    const json = JSON.stringify(target.getJSON())
    expect(json).not.toContain('"link"')
    expect(json).toContain('"bold"')
    expect(flat(target)).toBe("Un lien Deux")
  })

  test("an empty Google Docs paragraph does not add a second space", () => {
    const target = mount("<p></p>")
    paste(target, { "text/html": "<p>a</p><p><br></p><p>b</p>" })
    expect(breaks(target)).toBe(0)
    expect(flat(target)).toBe("a b")
  })

  // Guard for the defect class "a conversion that selects parts of the input
  // loses text": for every pasted shape, the words that come out are the words
  // that went in, in order, with one space between lines.
  const BLOCK_TAGS = "p|div|li|ul|ol|br|blockquote|h[1-6]|pre|tr|table"
  const tokensOf = (html: string) =>
    new DOMParser()
      .parseFromString(
        html
          .replace(/<meta[^>]*>/gi, "")
          .replace(new RegExp(`</?(?:${BLOCK_TAGS})\\b[^>]*>`, "gi"), " ")
          .replace(/<\/?[a-z][^>]*>/gi, ""),
        "text/html"
      )
      .body.textContent!.split(/[\s ]+/)
      .filter(Boolean)
  const shapes: Array<[string, string, number]> = [
    ["a single paragraph", "<p>Just one line</p>", 0],
    ["three paragraphs", "<p>Un</p><p>Deux</p><p>Trois</p>", 2],
    [
      "loose text before divs",
      "Line one<div>Line two</div><div>Line three</div>",
      2,
    ],
    ["loose text before paragraphs", "Loose text<p>A</p><p>B</p>", 2],
    [
      "a nested list",
      "<ul><li>Parent<ul><li>A</li><li>B</li></ul></li></ul>",
      2,
    ],
    [
      "words before nested boxes",
      "<div>Intro words <div>Box one</div><div>Box two</div></div>",
      2,
    ],
    [
      "Word paragraphs (MsoNormal, o:p, nbsp)",
      "<p class=MsoNormal>Un<o:p></o:p></p><p class=MsoNormal>Deux&nbsp;trois<o:p></o:p></p>",
      1,
    ],
    [
      "Google Docs wrapper (font-weight normal bold, accents)",
      `<meta charset='utf-8'><b style="font-weight:normal;" id="docs-internal-guid-1"><p dir="ltr"><span>Œuvre</span></p><p dir="ltr"><span>« deux »</span></p></b>`,
      1,
    ],
    [
      "a heading and a quote",
      "<h2>Title</h2><blockquote><p>Quote</p></blockquote>",
      1,
    ],
    ["marks across blocks", "<p><em>a</em> b</p><p>c <strong>d</strong></p>", 1],
    ["an inline run only", "<span>one</span> <b>two</b>", 0],
  ]
  test.each(shapes)(
    "text preservation: %s keeps every word and joins lines with one space",
    (_shape, html, expectedBreaks) => {
      const target = mount("<p></p>")
      paste(target, { "text/html": html })
      expect(flat(target).split(/[\s ]+/).filter(Boolean)).toEqual(
        tokensOf(html)
      )
      expect(blocks(target)).toBe(1)
      expect(breaks(target)).toBe(0)
      expect(flat(target)).not.toMatch(/\s{2}|^\s|\s$/)
      expect(expectedBreaks).toBeGreaterThanOrEqual(0)
    }
  )
})

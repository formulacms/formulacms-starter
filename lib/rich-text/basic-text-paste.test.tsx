import { Editor, getSchema, type JSONContent } from "@tiptap/core"
import { fireEvent } from "@testing-library/react"
import {
  DOMParser,
  Fragment,
  Slice,
  type Node as PMNode,
} from "@tiptap/pm/model"
import { describe, expect, test, vi } from "vitest"
import { extensionsForProfile } from "./extensions"
import {
  BASIC_PARAGRAPH_GAP,
  BasicTextPaste,
  tidyBasicPaste,
} from "./basic-text-paste"

const schema = getSchema(extensionsForProfile("basic"))
const textNode = (text: string) => ({ type: "text", text })
const paragraph = (...content: object[]) => ({ type: "paragraph", content })
const hardBreak = { type: "hardBreak" }
function parseText(text: string) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  let pasted = Slice.empty
  const editor = new Editor({
    element: host,
    extensions: [...extensionsForProfile("basic"), BasicTextPaste],
    editorProps: {
      handleScrollToSelection: () => true,
      handlePaste(_view, _event, slice) { pasted = slice; return false },
    },
  })
  try {
    fireEvent.paste(editor.view.dom, { clipboardData: transfer({ "text/plain": text }) })
    return pasted
  } finally { editor.destroy(); host.remove() }
}
function parseHtml(html: string) {
  const container = document.createElement("div")
  container.innerHTML = html
  return DOMParser.fromSchema(schema).parseSlice(container)
}
function tokens(slice: Slice) {
  const words: string[] = []
  slice.content.descendants((node) => {
    if (node.isText) words.push(...(node.text!.match(/\S+/g) ?? []))
  })
  return words
}

describe("basic paste policy", () => {
  test("pins the approved basic paragraph gap", () => {
    expect(BASIC_PARAGRAPH_GAP).toBe("[&>p]:m-0 [&>p+p]:mt-[0.75em]")
  })

  test.each([
    [
      "\r\n \r\nOne\r\ntwo\r\n\r\n\r\nThree\r\n",
      [
        paragraph(textNode("One"), hardBreak, textNode("two")),
        paragraph(textNode("Three")),
      ],
    ],
    [
      "  One  \n\t\n two ",
      [paragraph(textNode("  One  ")), paragraph(textNode(" two "))],
    ],
    ["One\rtwo", [paragraph(textNode("One"), hardBreak, textNode("two"))]],
    ["\n \n\t\r\n", null],
    [
      '<b>literal</b> **words** {"type":"doc"}',
      [paragraph(textNode('<b>literal</b> **words** {"type":"doc"}'))],
    ],
  ])(
    "plain text %j has only the requested paragraphs/breaks",
    (text, expected) => {
      expect(parseText(text as string).content.toJSON()).toEqual(expected)
    }
  )

  test.each(["inline", "title", "full"] as const)(
    "%s has no paste override",
    (profile) => {
      const editor = new Editor({ extensions: extensionsForProfile(profile === "title" ? "inline" : profile) })
      try {
        expect(editor.extensionManager.extensions.some((extension) => extension.name === "basicTextPaste")).toBe(false)
      } finally { editor.destroy() }
    }
  )

  test("HTML cleanup keeps marks, links and internal breaks and does not mutate its input", () => {
    const input = parseHtml(
      '<p><br>First <strong>bold</strong><br><a href="https://example.com/kept">linked</a><br></p>' +
        "<p> &nbsp; <br></p><p><br>Last<br></p>"
    )
    const before = JSON.stringify(input.toJSON())
    const first = input.content.firstChild!
    const children: PMNode[] = []
    first.content.forEach((node) => children.push(node))
    expect(children[0].type.name).toBe("hardBreak")
    expect(children.at(-1)!.type.name).toBe("hardBreak")
    const output = tidyBasicPaste(input, { fromEditorCopy: false })
    expect(output.content.childCount).toBe(2)
    expect(output.content.firstChild!.toJSON()).toEqual(
      first.copy(Fragment.fromArray(children.slice(1, -1))).toJSON()
    )
    expect(output.content.lastChild!.textContent).toBe("Last")
    expect(JSON.stringify(input.toJSON())).toBe(before)
  })

  test("non-paragraph nodes are retained by identity, including their nested content", () => {
    const heading = schema.nodes.heading.create(
      { level: 2 },
      schema.text("Heading")
    )
    const list = schema.nodeFromJSON({
      type: "bulletList",
      content: [
        {
          type: "listItem",
          content: [paragraph(hardBreak, textNode("Item"), hardBreak)],
        },
      ],
    })
    const input = Slice.maxOpen(Fragment.fromArray([heading, list]))
    const output = tidyBasicPaste(input, { fromEditorCopy: false })
    expect(output.content.child(0)).toBe(heading)
    expect(output.content.child(1)).toBe(list)
    expect(output.content.toJSON()).toEqual(input.content.toJSON())
  })

  // Our conversion's token invariant; the parser output is the input, not under test.
  test.each([
    ["loose text beside blocks", "Loose start<p>Middle words</p>Loose end"],
    ["nested divs", "<div>Intro <div>Box one</div>Tail words</div>"],
    [
      "nested lists",
      "<ul><li>Parent<ul><li>Child one</li><li>Child two</li></ul></li></ul>",
    ],
    [
      "Word",
      '<p class="MsoNormal"><span>Word words</span></p><p class="MsoNormal">&nbsp;</p><p>End words</p>',
    ],
    [
      "Google Docs",
      '<b id="docs-internal-guid"><p><span>Docs first</span></p><p><br></p><p>Docs last</p></b>',
    ],
    [
      "nonbreaking spaces",
      "<p>&nbsp;</p><p>One&nbsp;two</p><p>Three&nbsp;four</p>",
    ],
    [
      "marks and links",
      '<p><br><em>Marked words</em> <a href="https://example.com/path">Link words</a><br></p>',
    ],
    [
      "headings and paragraphs",
      "<h2>Section words</h2><p><br>First words<br>Last words<br></p>",
    ],
  ])("keeps every token in order: %s", (_name, html) => {
    const input = parseHtml(html)
    const output = tidyBasicPaste(input, { fromEditorCopy: false })
    expect(tokens(input).length).toBeGreaterThan(0)
    expect(tokens(output)).toEqual(tokens(input))
  })

  test("supported 50-paragraph paste preserves every word without blank paragraphs", () => {
    const lines = Array.from(
      { length: 50 },
      (_, i) => `Paragraph ${i}: some ordinary words`
    )
    const output = parseText(`\n${lines.join("\n\n\n")}\n`)
    expect(output.content.childCount).toBe(50)
    expect(tokens(output)).toEqual(lines.flatMap((line) => line.split(" ")))
  })
})

// R1 group 2: external HTML must recompute maximum openness after blank removal.
// This literal is the specified insertion at before |after, not a derived oracle.
test("R1 editor copies external list joins One to before", () => {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: [...extensionsForProfile("basic"), BasicTextPaste],
    content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "before after" }] },
    ] },
    editorProps: { handleScrollToSelection: () => true },
  })
  try {
    editor.commands.setTextSelection(8)
    fireEvent.paste(editor.view.dom, { clipboardData: {
      getData: (type: string) => type === "text/html" ? "<p>&nbsp;</p><ul><li><p>One</p></li></ul>" : "",
      types: ["text/html"],
    } })
    expect(editor.getJSON()).toEqual({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "before Oneafter" }] },
    ] })
  } finally {
    editor.destroy()
    host.remove()
  }
})

// R1 insertion oracles are handwritten documents; never generated by the policy.
const copyCases = [
  ["closed paragraph", '<p data-pm-slice="0 0 []">One</p>', [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "paragraph", content: [{ type: "text", text: "One" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
  ["closed H2", '<h2 data-pm-slice="0 0 []">Heading</h2>', [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
  ["closed H3", '<h3 data-pm-slice="0 0 []">Heading</h3>', [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Heading" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
  ["closed bullet list", '<ul data-pm-slice="0 0 []"><li><p>One</p></li></ul>', [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "bulletList", content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
  ["closed ordered list", '<ol data-pm-slice="0 0 []"><li><p>One</p></li></ol>', [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "orderedList", attrs: { start: 1, type: null }, content: [{ type: "listItem", content: [{ type: "paragraph", content: [{ type: "text", text: "One" }] }] }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
  ["removed first edge 1 0", '<p data-pm-slice="1 0 []"></p><p>One</p>', [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "paragraph", content: [{ type: "text", text: "One" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
  ["removed last edge 0 1", '<p data-pm-slice="0 1 []">One</p><p></p>', [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "paragraph", content: [{ type: "text", text: "One" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
  ["retained first edge 1 0", '<p data-pm-slice="1 0 []">One</p>', [
    { type: "paragraph", content: [{ type: "text", text: "before One" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
  ["retained last edge 0 1", '<p data-pm-slice="0 1 []">One</p>', [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "paragraph", content: [{ type: "text", text: "Oneafter" }] },
  ]],
] as const

function mountPastePolicy() {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: [...extensionsForProfile("basic"), BasicTextPaste],
    content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "before after" }] },
    ] },
    editorProps: { handleScrollToSelection: () => true },
  })
  editor.commands.setTextSelection(8)
  return { editor, dispose: () => { editor.destroy(); host.remove() } }
}
function transfer(data: Record<string, string>) {
  return { getData: (type: string) => data[type] ?? "", types: Object.keys(data), files: [] }
}

test.each(copyCases)("R1 editor copy %s keeps insertion boundaries", (_name, html, expected) => {
  const { editor, dispose } = mountPastePolicy()
  try {
    fireEvent.paste(editor.view.dom, { clipboardData: transfer({ "text/html": html }) })
    expect(editor.getJSON()).toEqual({ type: "doc", content: expected })
  } finally { dispose() }
})

const dropCases = [
  ["external HTML break and blank paragraph", { "text/html": "<p><br>One</p><p>&nbsp;</p><p>Two</p>" }, [
    { type: "paragraph", content: [{ type: "text", text: "before " }, { type: "hardBreak" }, { type: "text", text: "One" }] },
    { type: "paragraph", content: [{ type: "text", text: "\u00a0" }] },
    { type: "paragraph", content: [{ type: "text", text: "Twoafter" }] },
  ]],
  ["external plain text keeps separate lines", { "text/plain": "One\ntwo\n\nThree" }, [
    { type: "paragraph", content: [{ type: "text", text: "before One" }] },
    { type: "paragraph", content: [{ type: "text", text: "two" }] },
    { type: "paragraph", content: [{ type: "text", text: "Threeafter" }] },
  ]],
  ["internal drag keeps edge break", {}, [
    { type: "paragraph", content: [{ type: "text", text: "before " }, { type: "hardBreak" }, { type: "text", text: "Oneafter" }] },
  ]],
] as const

test.each(dropCases)("R1 drop %s stays untidied", (name, data, expected) => {
  const { editor, dispose } = mountPastePolicy()
  const coords = vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 8, inside: -1 })
  try {
    if (name === "internal drag keeps edge break") editor.view.dragging = {
      slice: Slice.maxOpen(Fragment.from(editor.schema.nodeFromJSON({ type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "One" }] }))),
      move: false,
    }
    fireEvent.drop(editor.view.dom, { dataTransfer: transfer(data), ctrlKey: true, altKey: true })
    expect(coords).toHaveBeenCalled()
    expect(editor.getJSON()).toEqual({ type: "doc", content: expected })
  } finally { coords.mockRestore(); dispose() }
})


// An ignored composition paste leaves the marker armed until the microtask.
// A synchronous drop must cancel it before invoking any clipboard hooks.
test("R1 drop immediately after ignored paste clears the marker", () => {
  const { editor, dispose } = mountPastePolicy()
  const coords = vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 8, inside: -1 })
  const composing = vi.spyOn(editor.view, "composing", "get").mockReturnValue(true)
  try {
    fireEvent.paste(editor.view.dom, { clipboardData: transfer({ "text/html": "<p>Ignored</p>" }) })
    composing.mockRestore()
    fireEvent.drop(editor.view.dom, { dataTransfer: transfer({ "text/plain": "One\ntwo\n\nThree" }) })
    expect(coords).toHaveBeenCalled()
    expect(editor.getJSON()).toEqual({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "before One" }] },
      { type: "paragraph", content: [{ type: "text", text: "two" }] },
      { type: "paragraph", content: [{ type: "text", text: "Threeafter" }] },
    ] })
  } finally { composing.mockRestore(); coords.mockRestore(); dispose() }
})

function mountR2Editor(withPolicy: boolean, marks: JSONContent["marks"] = []) {
  const host = document.createElement("div")
  document.body.appendChild(host)
  const editor = new Editor({
    element: host,
    extensions: [...extensionsForProfile("basic"), ...(withPolicy ? [BasicTextPaste] : [])],
    content: { type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "before after", marks }] },
    ] },
    editorProps: { handleScrollToSelection: () => true },
  })
  editor.commands.setTextSelection(8)
  return { editor, dispose: () => { editor.destroy(); host.remove() } }
}

test.each([
  ["single line", "One", [
    { type: "text", text: "before Oneafter", marks: [{ type: "bold" }] },
  ]],
  ["multiple lines", "One\ntwo", [
    { type: "text", text: "before One", marks: [{ type: "bold" }] },
    { type: "hardBreak" },
    { type: "text", text: "twoafter", marks: [{ type: "bold" }] },
  ]],
])("R2 marks: %s plain text retains bold at the cursor", (_name, text, expected) => {
  const { editor, dispose } = mountR2Editor(true, [{ type: "bold" }])
  try {
    fireEvent.paste(editor.view.dom, { clipboardData: transfer({ "text/plain": text as string }) })
    expect(editor.getJSON()).toEqual({ type: "doc", content: [
      { type: "paragraph", content: expected },
    ] })
  } finally { dispose() }
})

test.each([
  ["visible metadata text", "<p>&nbsp;</p><ul><li><p>Example data-pm-slice=value</p></li></ul>", [
    { type: "paragraph", content: [{ type: "text", text: "before Example data-pm-slice=valueafter" }] },
  ]],
  ["invalid attribute value", '<p data-pm-slice="abc">&nbsp;</p><ul><li><p>One</p></li></ul>', [
    { type: "paragraph", content: [{ type: "text", text: "before Oneafter" }] },
  ]],
])("R2 provenance: %s counts as external HTML", (_name, html, expected) => {
  const { editor, dispose } = mountR2Editor(true)
  try {
    fireEvent.paste(editor.view.dom, { clipboardData: transfer({ "text/html": html as string }) })
    expect(editor.getJSON()).toEqual({ type: "doc", content: expected })
  } finally { dispose() }
})

// Class guard: these inputs need no tidying, so the policy must equal the default.
test.each<[string, NonNullable<JSONContent["marks"]>, Record<string, string>]>([
  ["bold context", [{ type: "bold" }], { "text/plain": "One" }],
  ["italic and bold context", [{ type: "italic" }, { type: "bold" }], { "text/plain": "One" }],
  ["external paragraphs", [], { "text/html": "<p>One</p><p>Two</p>" }],
  ["open editor copy", [], { "text/html": '<p data-pm-slice="1 1 []">One</p><p>Two</p>' }],
  ["closed H2 editor copy", [], { "text/html": '<h2 data-pm-slice="0 0 []">Heading</h2>' }],
])("R2 differential: %s equals the no-policy editor", (_name, marks, clipboard) => {
  const policy = mountR2Editor(true, marks)
  const baseline = mountR2Editor(false, marks)
  try {
    fireEvent.paste(policy.editor.view.dom, { clipboardData: transfer(clipboard) })
    fireEvent.paste(baseline.editor.view.dom, { clipboardData: transfer(clipboard) })
    expect(policy.editor.getJSON()).toEqual(baseline.editor.getJSON())
  } finally { policy.dispose(); baseline.dispose() }
})

// Intentional exception to the differential: extensions.ts:54-58 reads noFollow
// from rel, so the default DOM round trip in prosemirror-view clipboard.ts:61-66
// changes the picker-stored null to true. Preserve the stored context link.
// extensions.ts:83 merges HTMLAttributes, retaining TipTap's default rel.
test("R2 link context: plain text preserves the picker-stored link attributes", () => {
  const { editor, dispose } = mountR2Editor(true, [{
    type: "link",
    attrs: {
      href: "https://example.com/kept", target: null,
      rel: "noopener noreferrer nofollow", class: null, title: null, pageId: null,
      noFollow: null, sponsored: null, ugc: null,
    },
  }])
  try {
    fireEvent.paste(editor.view.dom, { clipboardData: transfer({ "text/plain": "One" }) })
    expect(editor.getJSON()).toEqual({ type: "doc", content: [
      { type: "paragraph", content: [{
        type: "text", text: "before Oneafter", marks: [{
          type: "link",
          attrs: {
            href: "https://example.com/kept", target: null,
            rel: "noopener noreferrer nofollow", class: null, title: null, pageId: null,
            noFollow: null, sponsored: null, ugc: null,
          },
        }],
      }] },
    ] })
  } finally { dispose() }
})

// Output validity at our policy/schema seam, not a serializer stress test.
test.each([
  ["plain text", { "text/plain": "One\ntwo" }, [
    { type: "paragraph", content: [
      { type: "text", text: "before One" }, { type: "hardBreak" }, { type: "text", text: "twoafter" },
    ] },
  ]],
  ["external HTML", { "text/html": "<p>&nbsp;</p><ul><li><p>One</p></li></ul>" }, [
    { type: "paragraph", content: [{ type: "text", text: "before Oneafter" }] },
  ]],
  ["editor copy", { "text/html": '<h2 data-pm-slice="0 0 []">Heading</h2>' }, [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ]],
])("R2 round trip: pasted %s reloads as valid JSON", (_name, clipboard, expected) => {
  const pasted = mountR2Editor(true)
  const reloaded = mountR2Editor(true)
  try {
    fireEvent.paste(pasted.editor.view.dom, { clipboardData: transfer(clipboard as Record<string, string>) })
    const json = pasted.editor.getJSON()
    expect(json).toEqual({ type: "doc", content: expected })
    expect(() => pasted.editor.state.doc.check()).not.toThrow()
    reloaded.editor.commands.setContent(json)
    expect(reloaded.editor.getJSON()).toEqual(json)
    expect(() => reloaded.editor.state.doc.check()).not.toThrow()
  } finally { pasted.dispose(); reloaded.dispose() }
})

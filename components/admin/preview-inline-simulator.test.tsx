import { act } from "react"
import type { Editor } from "@tiptap/core"
import { renderToStaticMarkup } from "react-dom/server"
import { renderStaticRichTextDocument } from "@/lib/rich-text/static-render"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterAll, beforeAll, expect, test, vi } from "vitest"
import { BASIC_PARAGRAPH_GAP } from "@/lib/rich-text/basic-text-paste"
import {
  PreviewInlineEditor,
  type PreviewInlineController,
} from "./preview-inline-editor"
const rangeRects = {
  getClientRects: Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getClientRects"
  ),
  getBoundingClientRect: Object.getOwnPropertyDescriptor(
    Range.prototype,
    "getBoundingClientRect"
  ),
}
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect()],
  })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  })
})
afterAll(() => {
  for (const [key, descriptor] of Object.entries(rangeRects)) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor)
    else Reflect.deleteProperty(Range.prototype, key)
  }
})
const pm = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "Body" }] }],
})
test("plain simulator labels keep JSON, HTML and Markdown literal and refuse formatting", async () => {
  let controller: PreviewInlineController | null = null
  const literals = [
    '{"type":"doc","content":[]}',
    "<b>Literal</b>",
    "**Literal**",
  ]
  const { container } = render(
    <PreviewInlineEditor
      value={literals[0]}
      contract="inline"
      fieldPath="primary.eyebrow"
      label="Label"
      onChange={vi.fn()}
      onCancel={vi.fn()}
      onCommit={vi.fn()}
      onCompositionChange={vi.fn()}
      simulator={{
        plain: true,
        onController: (next) => {
          controller = next
        },
      }}
    />
  )
  await waitFor(() => expect(controller).not.toBeNull())
  for (const literal of literals) {
    act(() => {
      controller!.replay(literal)
    })
    expect(controller!.flush().value).toBe(literal)
    expect(container.querySelector("[contenteditable]")).toHaveTextContent(
      literal
    )
    expect(container.querySelector("b,strong")).toBeNull()
    expect(controller!.format("bold")).toBe(false)
    expect(controller!.format("bulletList")).toBe(false)
  }
})
test("opt-in simulator owns replay/history and body structure without value-echo remount", async () => {
  let controller: PreviewInlineController | null = null
  const change = vi.fn()
  const simulator = {
    block: true,
    headingFloor: 4,
    onController(next: PreviewInlineController | null) {
      controller = next
    },
  }
  const props = {
    value: pm,
    contract: "basic" as const,
    fieldPath: "items.0.answer",
    label: "Answer",
    onChange: change,
    onCancel: vi.fn(),
    onCommit: vi.fn(),
    onCompositionChange: vi.fn(),
    simulator,
  }
  const { container, rerender } = render(<PreviewInlineEditor {...props} />)
  await waitFor(() => expect(controller).not.toBeNull())
  const host = container.querySelector("[contenteditable]")
  expect(host?.tagName).toBe("DIV")
  act(() => {
    controller!.format("bulletList")
  })
  expect(JSON.parse(controller!.flush().value).content[0].type).toBe(
    "bulletList"
  )
  act(() => {
    controller!.format("orderedList")
  })
  expect(JSON.parse(controller!.flush().value).content[0].type).toBe(
    "orderedList"
  )
  const edited = controller!.flush().value
  rerender(<PreviewInlineEditor {...props} value={edited} />)
  expect(container.querySelector("[contenteditable]")).toBe(host)
  const count = change.mock.calls.length
  act(() => {
    controller!.replay(pm, { from: 1, to: 1 })
  })
  expect(change).toHaveBeenCalledTimes(count)
  expect(controller!.historyOwnedExternally).toBe(true)
})

test("page defaults retain phrasing host, inline Enter and independent document undo", async () => {
  const change = vi.fn()
  const { container } = render(
    <h2>
      <PreviewInlineEditor
        value={pm}
        fieldPath="primary.title"
        label="Page field"
        onChange={change}
        onCancel={vi.fn()}
        onCommit={vi.fn()}
        onCompositionChange={vi.fn()}
      />
    </h2>
  )
  const editor = container.querySelector("[contenteditable]")!
  expect(editor.tagName).toBe("SPAN")
  fireEvent.keyDown(editor, { key: "Enter" })
  await waitFor(() => expect(change).toHaveBeenCalled())
  expect(change.mock.calls.at(-1)![0]).toContain("hardBreak")
  fireEvent.keyDown(editor, { key: "z", ctrlKey: true })
  expect(change.mock.calls.at(-1)![0]).not.toContain("hardBreak")
})
test("simulator basic bodies render stored relative ranks using the real outline floor", async () => {
  const content = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Heading" }],
      },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "Subheading" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "Paragraph" }] },
    ],
  })
  let controller: PreviewInlineController | null = null
  const { container } = render(
    <PreviewInlineEditor
      value={content}
      contract="basic"
      fieldPath="items.0.answer"
      label="Answer"
      simulator={{
        block: true,
        headingFloor: 4,
        onController: (next) => {
          controller = next
        },
      }}
      onChange={vi.fn()}
      onCancel={vi.fn()}
      onCommit={vi.fn()}
      onCompositionChange={vi.fn()}
    />
  )
  await waitFor(() => expect(controller).not.toBeNull())
  expect(container.querySelector("h4")?.textContent).toBe("Heading")
  expect(container.querySelector("h5")?.textContent).toBe("Subheading")
  expect(controller!.flush().value).toContain('"level":2')
  expect(controller!.flush().value).toContain('"level":3')
  act(() => {
    controller!.format("bold", { from: 1, to: 5 })
  })
  expect(controller!.textState()).toMatchObject({
    headingLevel: 4,
    relativeHeading: "heading",
    marks: ["bold"],
  })
  expect(controller!.flush()).toMatchObject({ from: 1, to: 5 })
  act(() => {
    controller!.format("heading", { from: 1, to: 1 })
  })
  expect(controller!.textState()).toMatchObject({
    block: "paragraph",
    headingLevel: null,
  })
  act(() => {
    controller!.format("subheading", { from: 1, to: 1 })
  })
  expect(controller!.textState()).toMatchObject({
    headingLevel: 4,
    relativeHeading: "subheading",
  })
  act(() => {
    controller!.format("subheading", { from: 1, to: 1 })
    controller!.format("lineBreak", { from: 1, to: 1 })
  })
  expect(controller!.textState().headingLevel).toBeNull()
  expect(controller!.flush().value).toContain('"hardBreak"')
})

const headingCases = [
  { ranks: [0], levels: [0] },
  { ranks: [2], levels: [0] },
  { ranks: [3], levels: [0] },
  { ranks: [2, 3], levels: [0, 1] },
  { ranks: [3, 2], levels: [0, 0] },
]
for (const contract of ["basic", "full"] as const)
  for (const floor of [2, 3, 4, 6]) {
    for (const { ranks, levels } of headingCases) {
      test(`public/editor/badge heading truth ${contract} floor ${floor} ranks ${ranks}`, async () => {
        const doc = {
          type: "doc",
          content: ranks.map((rank, index) => ({
            type: rank ? "heading" : "paragraph",
            ...(rank ? { attrs: { level: rank } } : {}),
            content: [{ type: "text", text: `Text${index}` }],
          })),
        }
        const tags = ranks.map((rank, index) =>
          rank ? `h${Math.min(6, floor + levels[index])}` : "p"
        )
        const expected = tags
          .map((tag, index) => `<${tag}>Text${index}</${tag}>`)
          .join("")
        expect(
          renderToStaticMarkup(
            renderStaticRichTextDocument(doc, contract, { headingFloor: floor })
          )
        ).toBe(expected)
        let controller: PreviewInlineController | null = null
        const change = vi.fn()
        const { container, unmount } = render(
          <PreviewInlineEditor
            value={JSON.stringify(doc)}
            contract={contract}
            fieldPath="items.0.answer"
            label="Answer"
            simulator={{
              block: true,
              headingFloor: floor,
              onController: (next) => {
                controller = next
              },
            }}
            onChange={change}
            onCancel={vi.fn()}
            onCommit={vi.fn()}
            onCompositionChange={vi.fn()}
          />
        )
        await waitFor(() => expect(controller).not.toBeNull())
        const host = container.querySelector("[contenteditable]")!
        expect(
          Array.from(host.children).map((node) => node.tagName.toLowerCase())
        ).toEqual(tags)
        for (let index = 0; index < ranks.length; index++) {
          const from = 1 + index * 7
          act(() => controller!.replay(JSON.stringify(doc), { from, to: from }))
          const before = controller!.flush().value
          change.mockClear()
          const editor = (host as HTMLElement & { editor: Editor }).editor
          const transaction = vi.fn()
          editor.on("transaction", transaction)
          const state = controller!.textState()
          expect(state.headingLevel).toBe(
            ranks[index] ? Number(tags[index].slice(1)) : null
          )
          expect(controller!.textState()).toEqual(state)
          expect(change).not.toHaveBeenCalled()
          expect(transaction).not.toHaveBeenCalled()
          editor.off("transaction", transaction)
          expect(controller!.flush().value).toBe(before)
          for (const command of ["heading", "subheading"] as const) {
            act(() =>
              controller!.replay(JSON.stringify(doc), { from, to: from })
            )
            const predicted =
              controller!.textState()[
                command === "heading" ? "headingResult" : "subheadingResult"
              ]
            act(() => {
              controller!.format(command, { from, to: from })
            })
            const actual = controller!.textState()
            const publicHost = document.createElement("div")
            publicHost.innerHTML = renderToStaticMarkup(
              renderStaticRichTextDocument(
                JSON.parse(controller!.flush().value),
                contract,
                { headingFloor: floor }
              )
            )
            expect(
              Array.from(host.children).map((node) => node.tagName)
            ).toEqual(
              Array.from(publicHost.children).map((node) => node.tagName)
            )
            expect(predicted).toBe(
              actual.headingLevel
                ? `H${actual.headingLevel}`
                : actual.block === "heading"
                  ? "empty"
                  : "P"
            )
            expect(container.querySelector("[contenteditable]")).toBe(host)
          }
        }
        unmount()
      })
    }
  }

test("occurrence projection retags only changed siblings; predictions preserve ownership, marks and selection", async () => {
  const doc = {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Main", marks: [{ type: "bold" }] }],
      },
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "Sub" }],
      },
    ],
  }
  let controller: PreviewInlineController | null = null
  const change = vi.fn()
  const { container } = render(
    <PreviewInlineEditor
      value={JSON.stringify(doc)}
      contract="basic"
      fieldPath="items.0.answer"
      label="Answer"
      simulator={{
        block: true,
        headingFloor: 4,
        onController: (next) => {
          controller = next
        },
      }}
      onChange={change}
      onCancel={vi.fn()}
      onCommit={vi.fn()}
      onCompositionChange={vi.fn()}
    />
  )
  await waitFor(() => expect(controller).not.toBeNull())
  const owner = controller
  const host = container.querySelector("[contenteditable]") as HTMLElement & {
    editor: Editor
  }
  const editor = host.editor
  const view = editor.view
  const main = host.querySelector("h4")
  expect(main?.querySelector("strong")).toHaveTextContent("Main")
  act(() => {
    editor.commands.setTextSelection(8)
  })
  const before = editor.getJSON()
  const transaction = vi.fn()
  editor.on("transaction", transaction)
  change.mockClear()
  expect(controller!.textState()).toMatchObject({
    headingLevel: 5,
    headingResult: "H4",
    subheadingResult: "P",
  })
  expect(editor.getJSON()).toEqual(before)
  expect(editor.state.selection.from).toBe(8)
  expect(transaction).not.toHaveBeenCalled()
  expect(change).not.toHaveBeenCalled()
  editor.off("transaction", transaction)
  // Delete the sole rank2: the otherwise unchanged rank3 must now be H4.
  act(() => {
    editor.view.dispatch(editor.state.tr.delete(0, 6))
  })
  expect(host.querySelector("h4")).toHaveTextContent("Sub")
  expect(host.querySelector("h5")).toBeNull()
  expect(controller!.textState().headingLevel).toBe(4)
  expect(editor.state.selection.from).toBe(2)
  // Toggling the last rank2 also retags the unchanged sibling.
  act(() => {
    controller!.replay(JSON.stringify(doc), { from: 1, to: 1 })
  })
  act(() => {
    controller!.format("heading", { from: 1, to: 1 })
  })
  expect(Array.from(host.children).map((node) => node.tagName)).toEqual([
    "P",
    "H4",
  ])
  expect(editor.state.selection.from).toBe(1)
  // Restore and reorder using ordinary document transactions; stored ranks survive.
  act(() => {
    controller!.replay(JSON.stringify(doc), { from: 8, to: 8 })
  })
  const stableMain = host.querySelector("h4")
  act(() => {
    controller!.format("bold", { from: 8, to: 9 })
  })
  expect(host.querySelector("h4")).toBe(stableMain)
  act(() => {
    const [first, second] = [
      editor.state.doc.child(0),
      editor.state.doc.child(1),
    ]
    editor.view.dispatch(
      editor.state.tr.replaceWith(0, editor.state.doc.content.size, [
        second,
        first,
      ])
    )
  })
  expect(Array.from(host.children).map((node) => node.tagName)).toEqual([
    "H4",
    "H4",
  ])
  expect(editor.getJSON().content?.map((node) => node.attrs?.level)).toEqual([
    3, 2,
  ])
  expect(editor.getJSON().content?.[1].content?.[0].marks).toEqual([
    { type: "bold" },
  ])
  expect(container.querySelector("[contenteditable]")).toBe(host)
  expect(editor.view).toBe(view)
  expect(controller).toBe(owner)
})

for (const text of ["", "   "])
  test(`empty heading is omitted without consuming rank: ${JSON.stringify(text)}`, async () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          ...(text ? { content: [{ type: "text", text }] } : {}),
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Visible" }],
        },
      ],
    }
    expect(
      renderToStaticMarkup(
        renderStaticRichTextDocument(doc, "basic", { headingFloor: 4 })
      )
    ).toBe("<h4>Visible</h4>")
    let controller: PreviewInlineController | null = null
    const { container } = render(
      <PreviewInlineEditor
        value={JSON.stringify(doc)}
        contract="basic"
        fieldPath="items.0.answer"
        label="Answer"
        simulator={{
          block: true,
          headingFloor: 4,
          onController: (next) => {
            controller = next
          },
        }}
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onCommit={vi.fn()}
        onCompositionChange={vi.fn()}
      />
    )
    await waitFor(() => expect(controller).not.toBeNull())
    act(() => controller!.replay(JSON.stringify(doc), { from: 1, to: 1 }))
    expect(controller!.textState()).toMatchObject({
      block: "heading",
      headingLevel: null,
      headingResult: "P",
      subheadingResult: "empty",
    })
    expect(
      Array.from(container.querySelectorAll("h4")).at(-1)
    ).toHaveTextContent("Visible")
  })

test.each(["##", "###"])(
  "basic native %s input and relative commands retain rank semantics at an H4 floor",
  async (prefix) => {
    let controller: PreviewInlineController | null = null
    const { container } = render(
      <PreviewInlineEditor
        value={JSON.stringify({
          type: "doc",
          content: [{ type: "paragraph" }],
        })}
        contract="basic"
        fieldPath="items.0.body"
        label="Body"
        onChange={vi.fn()}
        onCancel={vi.fn()}
        onCommit={vi.fn()}
        onCompositionChange={vi.fn()}
        simulator={{
          block: true,
          headingFloor: 4,
          onController: (next) => {
            controller = next
          },
        }}
      />
    )
    const host = container.querySelector<HTMLElement & { editor: Editor }>(
      "[contenteditable]"
    )!
    const editor = host.editor
    act(() => {
      editor.commands.insertContent(prefix)
      editor.view.someProp("handleTextInput", (handler) =>
        handler(
          editor.view,
          editor.state.selection.from,
          editor.state.selection.to,
          " ",
          () => editor.state.tr.insertText(" ")
        )
      )
      editor.commands.insertContent("Native heading")
    })
    const rank = prefix === "##" ? 2 : 3
    expect(editor.getJSON().content?.[0].attrs?.level).toBe(rank)
    // A lone rank3 resolves to the body floor, as in public rendering.
    expect(host.querySelector("h4")?.textContent).toBe("Native heading")
    act(() => {
      controller!.format("paragraph")
      controller!.format("subheading")
    })
    expect(JSON.parse(controller!.flush().value).content[0].attrs.level).toBe(3)
    act(() => {
      controller!.format("paragraph")
      controller!.format("heading")
    })
    expect(JSON.parse(controller!.flush().value).content[0].attrs.level).toBe(2)
  }
)

// --- Title fields in the preview: the same Enter and paste rule as the form ----
// Owner 2026-11-03 (prototype 4089ddeb): Enter is one line break and a paste
// keeps only what the title contract allows.
const titleDoc = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "heading",
      attrs: { level: 1 },
      content: [{ type: "text", text: "ab" }],
    },
  ],
})
const clipboardOf = (data: Record<string, string>) => ({
  getData: (type: string) => data[type] ?? "",
  types: Object.keys(data),
})
const breaksIn = (json: string) => json.split('"hardBreak"').length - 1

function mountPreview(contract: "title" | "inline", value: string) {
  const change = vi.fn()
  const view = render(
    <h2>
      <PreviewInlineEditor
        value={value}
        contract={contract}
        fieldPath="primary.title"
        label="Title"
        onChange={change}
        onCancel={vi.fn()}
        onCommit={vi.fn()}
        onCompositionChange={vi.fn()}
      />
    </h2>
  )
  const editor = view.container.querySelector("[contenteditable]")!
  const instance = (editor as HTMLElement & { editor: Editor }).editor
  return { change, editor, instance }
}
const lastValue = (change: ReturnType<typeof vi.fn>) =>
  change.mock.calls.at(-1)![0] as string

test.each([
  { "text/plain": "\nOne\ntwo\n\n\nThree\n", "text/html": "" },
  { "text/html": "<p><br>One<br>two<br></p><p>&nbsp;</p><p>Three</p>", "text/plain": "" },
])("basic preview uses the shared tidy-paste policy: %j", async (clipboard) => {
  const change = vi.fn()
  const props = {
    value: "", contract: "basic" as const, fieldPath: "primary.description", label: "Description",
    onChange: change, onCancel: vi.fn(), onCommit: vi.fn(), onCompositionChange: vi.fn(),
  }
  const view = render(<PreviewInlineEditor {...props} />)
  const surface = view.container.querySelector<HTMLElement>("[contenteditable]")!
  fireEvent.paste(surface, { clipboardData: clipboardOf(clipboard) })
  await waitFor(() => expect(change).toHaveBeenCalled())
  expect(JSON.parse(lastValue(change)).content).toEqual([
    { type: "paragraph", content: [
      { type: "text", text: "One" }, { type: "hardBreak" }, { type: "text", text: "two" },
    ] },
    { type: "paragraph", content: [{ type: "text", text: "Three" }] },
  ])
  // The layout-effect attribute refresh must retain the gap after a parent update.
  view.rerender(<PreviewInlineEditor {...props} className="text-lg" />)
  for (const utility of BASIC_PARAGRAPH_GAP.split(" "))
    expect(surface.classList).toContain(utility)
  expect(surface.classList).toContain("text-lg")
})

test("basic preview loading, replay and typing never run paste cleanup", () => {
  const stored = JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "  Kept  " }, { type: "hardBreak" }] },
    { type: "paragraph" },
  ] })
  const change = vi.fn()
  let controller: PreviewInlineController | null = null
  const view = render(<PreviewInlineEditor
    value={stored} contract="basic" fieldPath="primary.description" label="Description"
    onChange={change} onCancel={vi.fn()} onCommit={vi.fn()} onCompositionChange={vi.fn()}
    simulator={{ onController: (next) => { controller = next } }}
  />)
  const surface = view.container.querySelector<HTMLElement>("[contenteditable]")!
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  expect(JSON.stringify(editor.getJSON())).toBe(stored)
  expect(change).not.toHaveBeenCalled()
  act(() => controller!.replay(stored))
  expect(JSON.stringify(editor.getJSON())).toBe(stored)
  expect(change).not.toHaveBeenCalled()
  act(() => editor.view.dispatch(editor.state.tr.insertText("  typed  ", 1)))
  expect(controller!.flush().value).toContain('"  typed  "')
  expect(editor.getJSON().content!.at(-1)).toEqual({ type: "paragraph" })
})

test.each(["inline", "title", "full"] as const)("%s preview has no basic paste or gap override", (contract) => {
  const view = render(<PreviewInlineEditor
    value="" contract={contract} fieldPath="primary.title" label="Title"
    onChange={vi.fn()} onCancel={vi.fn()} onCommit={vi.fn()} onCompositionChange={vi.fn()}
  />)
  const surface = view.container.querySelector<HTMLElement>("[contenteditable]")!
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  expect(editor.options.editorProps.clipboardTextParser).toBeUndefined()
  expect(editor.options.editorProps.transformPasted).toBeUndefined()
  expect(editor.extensionManager.extensions.some((extension) => extension.name === "basicTextPaste")).toBe(false)
  for (const utility of BASIC_PARAGRAPH_GAP.split(" "))
    expect(surface.classList).not.toContain(utility)
})

test("title preview: Enter, Shift+Enter and Mod+Enter insert nothing", async () => {
  const { change, editor, instance } = mountPreview("title", titleDoc)
  act(() => {
    instance.commands.setTextSelection(2)
  })
  const before = JSON.stringify(instance.getJSON())
  for (const init of [
    {},
    { shiftKey: true },
    { ctrlKey: true },
    { metaKey: true },
    { isComposing: true },
  ])
    fireEvent.keyDown(editor, { key: "Enter", ...init })
  expect(JSON.stringify(instance.getJSON())).toBe(before)
  expect(change).not.toHaveBeenCalled()
})

test("title preview: pasted paragraphs join with single spaces and links become plain words", async () => {
  const { change, editor } = mountPreview("title", titleDoc)
  fireEvent.paste(editor, {
    clipboardData: clipboardOf({
      "text/html":
        '<p>Un <a href="https://example.com">lien</a></p><p><strong>Deux</strong></p><p>Trois</p>',
      "text/plain": "Un lien\n\nDeux\n\nTrois",
    }),
  })
  await waitFor(() => expect(change).toHaveBeenCalled())
  const json = lastValue(change)
  expect(breaksIn(json)).toBe(0)
  expect(json).not.toContain('"link"')
  expect(json).toContain('"bold"')
  expect(json).toContain("lien")
})

test("title preview: pasted plain lines join with single spaces, and HTML-looking text stays text", async () => {
  const { change, editor } = mountPreview("title", titleDoc)
  fireEvent.paste(editor, {
    clipboardData: clipboardOf({ "text/plain": "a\r\n\r\n<b>b</b>\nc" }),
  })
  await waitFor(() => expect(change).toHaveBeenCalled())
  const json = lastValue(change)
  expect(breaksIn(json)).toBe(0)
  expect(json).toContain("a <b>b</b> c")
  expect(json).not.toContain('"bold"')
})

// Review round 1 (P1): a title paste keeps every word, whatever the clipboard shape.
test.each([
  ["Line one<div>Line two</div><div>Line three</div>", "Line one", "Line three"],
  ["Loose text<p>A</p><p>B</p>", "Loose text", "B"],
  ["<ul><li>Parent<ul><li>A</li><li>B</li></ul></li></ul>", "Parent", "B"],
  ["<div>Intro words <div>Box one</div><div>Box two</div></div>", "Intro words", "Box two"],
])("title preview: paste %s keeps every word joined with single spaces", async (html, first, last) => {
  const { change, editor } = mountPreview("title", titleDoc)
  fireEvent.paste(editor, { clipboardData: clipboardOf({ "text/html": html }) })
  await waitFor(() => expect(change).toHaveBeenCalled())
  const json = lastValue(change)
  expect(breaksIn(json)).toBe(0)
  expect(json).toContain(first)
  expect(json).toContain(last)
})

test("title preview: a paste in the middle of the title keeps the text around it on the same line", async () => {
  const { change, editor, instance } = mountPreview("title", titleDoc)
  act(() => {
    instance.commands.setTextSelection(2)
  })
  fireEvent.paste(editor, {
    clipboardData: clipboardOf({ "text/html": "<p>X</p><p>Y</p>" }),
  })
  await waitFor(() => expect(change).toHaveBeenCalled())
  expect(instance.state.doc.textContent).toBe("aX Yb")
  expect(breaksIn(lastValue(change))).toBe(0)
})

test("inline preview (not a title): Enter and paste behave as before", async () => {
  const { change, editor } = mountPreview("inline", pm)
  fireEvent.keyDown(editor, { key: "Enter" })
  await waitFor(() => expect(change).toHaveBeenCalled())
  expect(breaksIn(lastValue(change))).toBe(1)
  fireEvent.paste(editor, {
    clipboardData: clipboardOf({ "text/plain": "x\n\ny" }),
  })
  // Plain lines keep every newline as a break, blank lines included.
  expect(breaksIn(lastValue(change))).toBe(3)
})

test("title simulator: the line-break command inserts nothing and does not throw", async () => {
  // Review P2 (2026-11-04): a title schema has no hardBreak, so setHardBreak is missing.
  let controller: PreviewInlineController | null = null
  const change = vi.fn()
  render(
    <h2>
      <PreviewInlineEditor
        value={titleDoc}
        contract="title"
        fieldPath="primary.title"
        label="Title"
        onChange={change}
        onCancel={vi.fn()}
        onCommit={vi.fn()}
        onCompositionChange={vi.fn()}
        simulator={{
          onController: (next) => {
            controller = next
          },
        }}
      />
    </h2>
  )
  await waitFor(() => expect(controller).not.toBeNull())
  let result: boolean | undefined
  act(() => {
    result = controller!.format("lineBreak", { from: 2, to: 2 })
  })
  expect(result).toBe(false)
  expect(breaksIn(controller!.flush().value)).toBe(0)
})

// R1 approved controls: unchanged literals run before and after the repair.
test.each([
  ["plain leading blank, select-all replace", { "text/plain": "\nOne\ntwo\n\n\nThree\n" }, [
    { type: "paragraph", content: [{ type: "text", text: "One" }, { type: "hardBreak" }, { type: "text", text: "two" }] },
    { type: "paragraph", content: [{ type: "text", text: "Three" }] },
  ]],
  ["external HTML without PM metadata", { "text/html": "<p>&nbsp;</p><p>One</p><p>Two</p>" }, [
    { type: "paragraph", content: [{ type: "text", text: "One" }] },
    { type: "paragraph", content: [{ type: "text", text: "Two" }] },
  ]],
])("R1 approved preview %s", async (_name, clipboard, expected) => {
  const view = render(<PreviewInlineEditor
    value={JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Replace me" }] }] })}
    contract="basic" fieldPath="primary.description" label="Description"
    onChange={vi.fn()} onCancel={vi.fn()} onCommit={vi.fn()} onCompositionChange={vi.fn()}
  />)
  const surface = view.container.querySelector<HTMLElement>("[contenteditable]")!
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  act(() => editor.commands.selectAll())
  fireEvent.paste(surface, { clipboardData: clipboardOf(clipboard as Record<string, string>) })
  expect(JSON.stringify(editor.getJSON())).toBe(JSON.stringify({ type: "doc", content: expected }))
  for (const utility of BASIC_PARAGRAPH_GAP.split(" ")) expect(surface.classList).toContain(utility)
})

test("R1 editor copy preview closed H2 keeps insertion boundaries", async () => {
  const view = render(<PreviewInlineEditor
    value={JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "before after" }] }] })}
    contract="basic" fieldPath="primary.description" label="Description"
    onChange={vi.fn()} onCancel={vi.fn()} onCommit={vi.fn()} onCompositionChange={vi.fn()}
  />)
  const surface = view.container.querySelector<HTMLElement>("[contenteditable]")!
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  act(() => editor.commands.setTextSelection(8))
  fireEvent.paste(surface, { clipboardData: clipboardOf({ "text/html": '<h2 data-pm-slice="0 0 []">Heading</h2>' }) })
  expect(editor.getJSON()).toEqual({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ] })
})

test("R1 drop preview external HTML keeps break and blank paragraph", async () => {
  const view = render(<PreviewInlineEditor
    value={JSON.stringify({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "before after" }] }] })}
    contract="basic" fieldPath="primary.description" label="Description"
    onChange={vi.fn()} onCancel={vi.fn()} onCommit={vi.fn()} onCompositionChange={vi.fn()}
  />)
  const surface = view.container.querySelector<HTMLElement>("[contenteditable]")!
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  const coords = vi.spyOn(editor.view, "posAtCoords").mockReturnValue({ pos: 8, inside: -1 })
  try {
    fireEvent.drop(surface, { dataTransfer: { ...clipboardOf({ "text/html": "<p><br>One</p><p>&nbsp;</p><p>Two</p>" }), files: [] } })
    expect(coords).toHaveBeenCalled()
    expect(editor.getJSON()).toEqual({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "before " }, { type: "hardBreak" }, { type: "text", text: "One" }] },
      { type: "paragraph", content: [{ type: "text", text: "\u00a0" }] },
      { type: "paragraph", content: [{ type: "text", text: "Twoafter" }] },
    ] })
  } finally { coords.mockRestore() }
})

// R2 wiring/sibling sweep. Expected text and breaks are handwritten literals;
// link attributes outside href belong to the library, not this paste policy.
test.each([
  { name: "bold", marks: [{ type: "bold" }] },
  { name: "italic", marks: [{ type: "italic" }] },
  { name: "link", marks: [{ type: "link", attrs: { href: "https://example.com/kept" } }] },
].flatMap(({ name, marks }) => [
  { name: `${name} single line`, marks, text: "One", expected: [
    { type: "text", text: "before Oneafter", marks },
  ] },
  { name: `${name} multiple lines`, marks, text: "One\ntwo", expected: [
    { type: "text", text: "before One", marks },
    { type: "hardBreak" },
    { type: "text", text: "twoafter", marks },
  ] },
]))("R2 marks preview: $name retains formatting at the cursor", ({ name, marks, text, expected }) => {
  const view = render(<PreviewInlineEditor
    value={JSON.stringify({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "before after", marks }] },
    ] })}
    contract="basic" fieldPath="primary.description" label="Description"
    onChange={vi.fn()} onCancel={vi.fn()} onCommit={vi.fn()} onCompositionChange={vi.fn()}
  />)
  const surface = view.container.querySelector<HTMLElement>("[contenteditable]")!
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  act(() => editor.commands.setTextSelection(8))
  fireEvent.paste(surface, { clipboardData: clipboardOf({ "text/plain": text }) })
  const expectedDoc = { type: "doc", content: [{ type: "paragraph", content: expected }] }
  if (name.startsWith("link")) expect(editor.getJSON()).toMatchObject(expectedDoc)
  else expect(editor.getJSON()).toEqual(expectedDoc)
})

test.each([
  ["visible metadata text", "<p>&nbsp;</p><ul><li><p>Example data-pm-slice=value</p></li></ul>", "before Example data-pm-slice=valueafter"],
  ["invalid attribute value", '<p data-pm-slice="abc">&nbsp;</p><ul><li><p>One</p></li></ul>', "before Oneafter"],
])("R2 provenance preview: %s remains external", (_name, html, expected) => {
  const view = render(<PreviewInlineEditor
    value={JSON.stringify({ type: "doc", content: [
      { type: "paragraph", content: [{ type: "text", text: "before after" }] },
    ] })}
    contract="basic" fieldPath="primary.description" label="Description"
    onChange={vi.fn()} onCancel={vi.fn()} onCommit={vi.fn()} onCompositionChange={vi.fn()}
  />)
  const surface = view.container.querySelector<HTMLElement>("[contenteditable]")!
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  act(() => editor.commands.setTextSelection(8))
  fireEvent.paste(surface, { clipboardData: clipboardOf({ "text/html": html }) })
  expect(editor.getJSON()).toEqual({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: expected }] },
  ] })
})

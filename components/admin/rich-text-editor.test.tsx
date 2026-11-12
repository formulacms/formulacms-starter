import { StrictMode, useImperativeHandle, useState, type Ref } from "react"
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react"
import type { Editor } from "@tiptap/core"
import { closeHistory, undoDepth } from "@tiptap/pm/history"
import { toast } from "sonner"
import { afterEach, expect, test, vi } from "vitest"
import {
  resolveFieldContract,
  type RichTextContractConfig,
} from "@/convex/lib/richtext/contracts"
import { toFieldShape } from "@/convex/lib/richtext/shape"
import { render } from "@/test-utils/admin-i18n"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import type { FieldGenerate } from "./fields/field-editor"
import { RichTextEditor } from "./rich-text-editor"
import { BASIC_PARAGRAPH_GAP } from "@/lib/rich-text/basic-text-paste"

// jsdom has no layout; ProseMirror needs a rect to place the slash menu.
const rect = { top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: 0 }
const rects = () => Object.assign([rect], { item: () => rect })
Range.prototype.getClientRects = rects as never
Range.prototype.getBoundingClientRect = (() => rect) as never
Element.prototype.getClientRects = rects as never

afterEach(() => vi.restoreAllMocks())

const slashDoc = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "/" }] }],
})

test.each([
  ["a refused Save stays quiet", new PageSaveRefusedError(), 0],
  ["another failure still reports", new Error("route down"), 1],
])("slash AI improve (refine): %s", async (_name, failure, toasts) => {
  const toastError = vi.spyOn(toast, "error").mockReturnValue("")
  const run = vi.fn(async () => {
    throw failure
  })
  const generate: FieldGenerate = {
    run: vi.fn(),
    runRefine: run,
    runSlice: vi.fn(),
  }
  render(
    <ConfirmProvider>
      <RichTextEditor value={slashDoc} onChange={() => {}} generate={generate} />
    </ConfirmProvider>
  )
  const surface = await screen.findByRole("textbox")
  await act(async () => {
    surface.focus()
    const range = document.createRange()
    range.selectNodeContents(surface.querySelector("p")!)
    range.collapse(false)
    const selection = window.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    fireEvent(document, new Event("selectionchange"))
  })
  const item = await screen.findByText(/improve writing/i)
  toastError.mockClear()
  await act(async () => {
    fireEvent.click(item)
  })
  await waitFor(() => expect(run).toHaveBeenCalledOnce())
  await act(async () => {})
  expect(toastError).toHaveBeenCalledTimes(toasts)
})

// --- Controlled value sync (echo race) -------------------------------------

type Handle = { deliver: (value: string) => void }

/**
 * A parent that holds the editor's emissions without re-rendering and hands
 * them back later, the way a slow React commit does when more keystrokes land
 * before the passive effect runs.
 */
function Harness({
  initial,
  config,
  emitted,
  handle,
}: {
  initial: string
  config: RichTextContractConfig
  emitted: string[]
  handle: Ref<Handle>
}) {
  const [value, setValue] = useState(initial)
  useImperativeHandle(handle, () => ({ deliver: setValue }))
  const contract = resolveFieldContract(config)
  return (
    <RichTextEditor
      value={value}
      profile={contract.profile ?? "inline"}
      contract={contract.contract === "title" ? "title" : undefined}
      onChange={(json) => {
        emitted.push(json)
      }}
    />
  )
}

async function mount(initial: string, config: RichTextContractConfig) {
  const emitted: string[] = []
  const handle: { current: Handle | null } = { current: null }
  render(
    <StrictMode>
      <ConfirmProvider>
        <Harness
          initial={initial}
          config={config}
          emitted={emitted}
          handle={handle}
        />
      </ConfirmProvider>
    </StrictMode>
  )
  const surface = await screen.findByRole("textbox")
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  // What field-editor hands the editor: the emission shaped by its contract.
  const deliver = (raw: string) =>
    act(() =>
      handle.current!.deliver(
        toFieldShape(resolveFieldContract(config), raw).value
      )
    )
  return { editor, emitted, deliver }
}

/** One undo event: close the previous group, then apply the edit. */
function edit(editor: Editor, step: (editor: Editor) => void) {
  act(() => {
    editor.view.dispatch(closeHistory(editor.state.tr))
    step(editor)
  })
}
const typeText = (editor: Editor, text: string) =>
  editor.view.dispatch(editor.state.tr.insertText(text))
const docJson = (editor: Editor) => JSON.stringify(editor.getJSON())
const textOf = (editor: Editor) => editor.state.doc.textContent

const fields: Array<[string, RichTextContractConfig]> = [
  ["basic", { contract: "basic" }],
  ["inline", { profile: "inline" }],
  ["title", { contract: "title" }],
]

// Delivery orders a slow React commit can produce before the parent catches up.
const deliveryOrders: Array<[string, number[]]> = [
  ["stale and in order, then synced", [0, 1, 2]],
  ["coalesced (skips an emission), then synced", [0, 2]],
  ["out of order before the sync", [1, 0, 2]],
]

test.each(
  fields.flatMap(([name, config]) =>
    deliveryOrders.map(([order, indexes]) => [name, order, config, indexes] as const)
  )
)(
  "late echoes never revert newer typing (%s field, %s)",
  async (name, _order, config, rawIndexes) => {
    const { editor, emitted, deliver } = await mount("", config)
    const initialDoc = docJson(editor)
    const base = undoDepth(editor.state)

    edit(editor, (e) => typeText(e, "a"))
    edit(editor, (e) => {
      e.commands.toggleBold()
      typeText(e, "b")
    })
    // A title field gets an Enter between "b" and "c": it inserts nothing, so
    // the emission count is the same as for every other field.
    edit(editor, (e) => {
      if (name === "title") fireEvent.keyDown(e.view.dom, { key: "Enter" })
      e.commands.toggleItalic()
      typeText(e, "c")
    })
    const total = 3
    expect(emitted).toHaveLength(total)
    const e1 = emitted[0]
    const e2 = emitted[1]
    const e3 = emitted[total - 1]
    const indexes = rawIndexes.map((index) => (index === 2 ? total - 1 : index))
    const finalDoc = docJson(editor)
    const selection = editor.state.selection.from
    expect(undoDepth(editor.state)).toBe(base + 3)
    expect(textOf(editor)).toBe("abc")

    // The parent renders behind the editor, then catches up.
    for (const index of indexes) {
      await deliver(emitted[index])
      expect(docJson(editor)).toBe(finalDoc)
      expect(editor.state.selection.from).toBe(selection)
      expect(undoDepth(editor.state)).toBe(base + 3)
    }
    expect(emitted).toHaveLength(total)

    // Undo and redo walk the exact documents the owner produced.
    const undo = () => act(() => void editor.commands.undo())
    const redo = () => act(() => void editor.commands.redo())
    await undo()
    expect(docJson(editor)).toBe(JSON.stringify(JSON.parse(e2)))
    await undo()
    expect(docJson(editor)).toBe(JSON.stringify(JSON.parse(e1)))
    await undo()
    expect(docJson(editor)).toBe(initialDoc)
    await redo()
    expect(docJson(editor)).toBe(JSON.stringify(JSON.parse(e1)))
    await redo()
    await redo()
    expect(docJson(editor)).toBe(finalDoc)
    expect(JSON.parse(e3)).toEqual(editor.getJSON())
  }
)

test.each(fields)(
  "restoring an earlier typed state after the parent caught up applies (%s)",
  async (_name, config) => {
    const { editor, emitted, deliver } = await mount("", config)
    edit(editor, (e) => typeText(e, "a"))
    edit(editor, (e) => typeText(e, "b"))
    expect(emitted).toHaveLength(2)
    const [afterA, afterB] = emitted
    await deliver(afterA)
    await deliver(afterB) // in sync: the parent has caught up
    expect(textOf(editor)).toBe("ab")
    const depth = undoDepth(editor.state)

    // A Restore / Discard hands back the doc as it was after "a".
    await deliver(afterA)
    expect(textOf(editor)).toBe("a")
    expect(emitted).toHaveLength(2)
    expect(undoDepth(editor.state)).toBe(depth)
  }
)

test.each(fields)(
  "an external value replaces the doc quietly and is not undoable (%s)",
  async (_name, config) => {
    const { editor, emitted, deliver } = await mount("", config)
    edit(editor, (e) => typeText(e, "pre-external"))
    expect(emitted).toHaveLength(1)
    expect(undoDepth(editor.state)).toBeGreaterThan(0)

    const external = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "translated by AI" }],
        },
      ],
    })
    // The AI answer lands seconds after the last keystroke: its own event.
    act(() => void editor.view.dispatch(closeHistory(editor.state.tr)))
    await deliver(external)
    expect(textOf(editor)).toBe("translated by AI")
    expect(emitted).toHaveLength(1)

    act(() => void editor.commands.undo())
    expect(textOf(editor)).not.toContain("pre-external")

    const before = emitted.length
    edit(editor, (e) => typeText(e, "!"))
    expect(emitted).toHaveLength(before + 1)
    expect(JSON.parse(emitted[before])).toEqual(editor.getJSON())
    expect(textOf(editor)).toContain("!")
    expect(textOf(editor)).not.toContain("pre-external")
  }
)

test.each(fields)(
  "a value equal to the doc on mount adds no history entry (%s)",
  async (_name, config) => {
    const same = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "hello" }] },
      ],
    })
    const { editor, emitted, deliver } = await mount(same, config)
    await deliver(same)
    expect(undoDepth(editor.state)).toBe(0)
    expect(emitted).toHaveLength(0)
    expect(textOf(editor)).toBe("hello")
  }
)

test.each(fields)(
  "mounting an empty field adds no undo entry (%s)",
  async (_name, config) => {
    const { editor, emitted } = await mount("", config)
    expect(undoDepth(editor.state)).toBe(0)
    expect(emitted).toHaveLength(0)
  }
)

// --- Title fields: Enter, paste and toolbar follow the title contract ------
// Owner 2026-11-03 (prototype 4089ddeb) and 2026-11-04 (trailing break).

function clipboardOf(data: Record<string, string>) {
  return {
    getData: (type: string) => data[type] ?? "",
    types: Object.keys(data),
  }
}
const breaksIn = (json: string) => json.split('"hardBreak"').length - 1
const paragraphsIn = (json: string) => json.split('"type":"paragraph"').length - 1

async function mountTitle(contract?: "title", profile: "inline" | "basic" = "inline") {
  const emitted: string[] = []
  render(
    <ConfirmProvider>
      <RichTextEditor
        value=""
        profile={profile}
        contract={contract}
        onChange={(json) => emitted.push(json)}
      />
    </ConfirmProvider>
  )
  const surface = await screen.findByRole("textbox")
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  return { surface, editor, emitted }
}

test("title field: Enter, Shift+Enter and Mod+Enter insert nothing", async () => {
  const { surface, editor, emitted } = await mountTitle("title")
  act(() => {
    editor.commands.insertContent("ab")
    editor.commands.setTextSelection(2)
  })
  const typed = emitted.length
  const before = docJson(editor)
  for (const init of [{}, { shiftKey: true }, { ctrlKey: true }, { metaKey: true }])
    fireEvent.keyDown(surface, { key: "Enter", ...init })
  expect(docJson(editor)).toBe(before)
  expect(breaksIn(docJson(editor))).toBe(0)
  expect(paragraphsIn(docJson(editor))).toBe(1)
  expect(emitted).toHaveLength(typed)
})

test.each([
  ["inline", undefined, "inline"],
  ["basic", undefined, "basic"],
] as const)("%s field without the title contract: Enter still splits the paragraph", async (_name, contract, profile) => {
  const { surface, editor } = await mountTitle(contract as undefined, profile)
  act(() => {
    editor.commands.insertContent("ab")
    editor.commands.setTextSelection(2)
  })
  fireEvent.keyDown(surface, { key: "Enter" })
  expect(paragraphsIn(docJson(editor))).toBe(2)
  expect(breaksIn(docJson(editor))).toBe(0)
})

test("title field: pasted paragraphs join with single spaces and links become plain words", async () => {
  const { surface, editor } = await mountTitle("title")
  fireEvent.paste(surface, {
    clipboardData: clipboardOf({
      "text/html":
        '<p>Un <a href="https://example.com">lien</a></p><p><strong>Deux</strong></p><p>Trois</p>',
      "text/plain": "Un lien\n\nDeux\n\nTrois",
    }),
  })
  const json = docJson(editor)
  expect(breaksIn(json)).toBe(0)
  expect(paragraphsIn(json)).toBe(1)
  expect(json).not.toContain('"link"')
  expect(json).toContain('"bold"')
  expect(editor.state.doc.textContent).toBe("Un lien Deux Trois")
})

test("title field: pasted plain lines join with single spaces, and HTML-looking text stays text", async () => {
  const { surface, editor } = await mountTitle("title")
  fireEvent.paste(surface, {
    clipboardData: clipboardOf({ "text/plain": "a\r\n\r\n<b>b</b>\nc" }),
  })
  const json = docJson(editor)
  expect(breaksIn(json)).toBe(0)
  expect(editor.state.doc.textContent).toBe("a <b>b</b> c")
  expect(json).not.toContain('"bold"')
})

test("title field: the toolbar has no Link button, a basic field keeps it", async () => {
  const title = await mountTitle("title")
  expect(screen.queryByTitle("Link")).toBeNull()
  expect(screen.getByTitle(/bold/i)).toBeTruthy()
  cleanup()
  expect(title.surface).toBeTruthy()
  await mountTitle(undefined, "basic")
  expect(screen.getByTitle("Link")).toBeTruthy()
})

test("title field: a stored title that still carries a link mark loads its words", async () => {
  const stored = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [
          {
            type: "text",
            text: "Words",
            marks: [{ type: "link", attrs: { href: "https://example.com" } }],
          },
        ],
      },
    ],
  })
  render(
    <ConfirmProvider>
      <RichTextEditor value={stored} profile="inline" contract="title" onChange={() => {}} />
    </ConfirmProvider>
  )
  const surface = await screen.findByRole("textbox")
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  expect(editor.state.doc.textContent).toBe("Words")
})

// Review P2-1 (fix-a2-a5): the parent canonicalises titles on every keystroke, so
// the editor must recognise its own emission after the title field shape.
test("title field: the parent's canonical echo of a multi-paragraph value is not applied as an external change", async () => {
  const twoParagraphs = JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Hello" }] },
      { type: "paragraph", content: [{ type: "text", text: "W" }] },
    ],
  })
  const { editor, emitted, deliver } = await mount(twoParagraphs, {
    contract: "title",
  })
  const end = editor.state.doc.content.size - 1
  act(() => editor.commands.setTextSelection(end))
  edit(editor, (e) => typeText(e, "o"))
  edit(editor, (e) => typeText(e, "r"))
  expect(emitted).toHaveLength(2)
  const live = docJson(editor)
  // The lagging parent hands back the canonical form of the first emission.
  await deliver(emitted[0])
  expect(docJson(editor)).toBe(live)
  expect(textOf(editor)).toBe("Hello Wor")
  expect(emitted).toHaveLength(2)
})

// Review round 1 (P1): a title paste keeps every word, whatever the clipboard shape.
test.each([
  ["Line one<div>Line two</div><div>Line three</div>", "Line one Line two Line three"],
  ["Loose text<p>A</p><p>B</p>", "Loose text A B"],
  ["<ul><li>Parent<ul><li>A</li><li>B</li></ul></li></ul>", "Parent A B"],
  ["<div>Intro words <div>Box one</div><div>Box two</div></div>", "Intro words Box one Box two"],
])("title field: paste %s keeps every word joined with single spaces", async (html, text) => {
  const { surface, editor } = await mountTitle("title")
  fireEvent.paste(surface, { clipboardData: clipboardOf({ "text/html": html }) })
  const json = docJson(editor)
  expect(breaksIn(json)).toBe(0)
  expect(paragraphsIn(json)).toBe(1)
  expect(editor.state.doc.textContent).toBe(text)
})

test("title field: a paste in the middle of the title keeps the text around it on the same line", async () => {
  const { surface, editor } = await mountTitle("title")
  act(() => {
    editor.commands.insertContent("ab")
    editor.commands.setTextSelection(2)
  })
  fireEvent.paste(surface, {
    clipboardData: clipboardOf({ "text/html": "<p>X</p><p>Y</p>" }),
  })
  expect(editor.state.doc.textContent).toBe("aX Yb")
  expect(paragraphsIn(docJson(editor))).toBe(1)
  expect(breaksIn(docJson(editor))).toBe(0)
})

test.each([
  ["isComposing", { isComposing: true }],
  ["keyCode 229", { keyCode: 229 }],
])("title field: an Enter that confirms an IME composition (%s) inserts no break", async (_name, init) => {
  const { surface, editor } = await mountTitle("title")
  act(() => {
    editor.commands.insertContent("ab")
    editor.commands.setTextSelection(2)
  })
  fireEvent.keyDown(surface, { key: "Enter", ...init })
  expect(breaksIn(docJson(editor))).toBe(0)
  // The same Enter without the composition flags inserts nothing either.
  fireEvent.keyDown(surface, { key: "Enter" })
  expect(breaksIn(docJson(editor))).toBe(0)
  expect(paragraphsIn(docJson(editor))).toBe(1)
})

// A8 (owner 2026-11-04, "dark text on dark background"): the editing surface
// uses the same typography colours as the other rich-text views
// (components/slices/rich-text-content.tsx, page-live-preview-canvas.tsx), so
// dark mode inverts the prose palette instead of drawing grey-700 text.
test.each(["inline", "basic", "full"] as const)(
  "%s editing surface follows the dark theme",
  async (profile) => {
    render(
      <ConfirmProvider>
        <RichTextEditor value="" onChange={() => {}} profile={profile} />
      </ConfirmProvider>
    )
    const surface = await screen.findByRole("textbox")
    expect(surface.classList).toContain("prose")
    expect(surface.classList).toContain("prose-neutral")
    expect(surface.classList).toContain("dark:prose-invert")
  }
)


test("R6 rich text uses its field name on the multiline editable", async () => {
  render(<ConfirmProvider><RichTextEditor label="Description" value="" onChange={() => {}} /></ConfirmProvider>)
  expect(await screen.findByRole("textbox", { name: "Description" })).toHaveAttribute("aria-multiline", "true")
})

test("R8 toolbar toggles expose pressed state and actions omit it", async () => {
  render(<ConfirmProvider><RichTextEditor value="" profile="full" onChange={() => {}} /></ConfirmProvider>)
  const surface = await screen.findByRole("textbox")
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  const toolbar = within(surface.parentElement!.previousElementSibling as HTMLElement)
  const mod = /Mac|iPhone|iPad|iPod/.test(navigator.platform) ? "⌘" : "Ctrl"
  const expectedPressedNames = [
    "Paragraph", `Bold (${mod}+b)`, `Italic (${mod}+i)`,
    `Underline (${mod}+u)`, `Strikethrough (${mod}+Shift+s)`,
    `Highlight (${mod}+Shift+h)`, `Subscript (${mod}+,)`,
    `Superscript (${mod}+.)`, `Inline code (${mod}+e)`,
    ...[2, 3, 4, 5, 6].map((level) => `Heading ${level} (${mod}+Alt+${level})`),
    `Bullet list (${mod}+Shift+8)`, `Numbered list (${mod}+Shift+7)`,
    `Blockquote (${mod}+Shift+b)`,
  ]
  const assertPressedNames = () => {
    const buttons = toolbar.getAllByRole("button").filter((button) => button.hasAttribute("aria-pressed"))
    expect(buttons.map((button) => button.title).sort()).toEqual([...expectedPressedNames].sort())
    for (const button of buttons) expect(button).toHaveAccessibleName(button.title)
  }
  assertPressedNames()
  expect(toolbar.getByRole("button", { name: "Paragraph" })).toHaveAttribute("aria-pressed", "true")
  const bold = toolbar.getByRole("button", { name: `Bold (${mod}+b)` })
  expect(bold).toHaveAttribute("aria-pressed", "false")
  fireEvent.click(bold)
  expect(bold).toHaveAttribute("aria-pressed", "true")
  await act(async () => { editor.chain().focus().insertTable({ rows: 2, cols: 2 }).run() })
  const insertTable = toolbar.getByRole("button", { name: "Insert table" })
  expect(insertTable).toHaveClass("bg-accent", "text-accent-foreground")
  expect(insertTable).not.toHaveAttribute("aria-pressed")
  assertPressedNames()
  await act(async () => {
    editor.commands.setContent('<p><a href="https://example.com">Linked text</a></p>')
    editor.chain().focus().setTextSelection(2).run()
  })
  const link = toolbar.getByRole("button", { name: "Link" })
  expect(link).toHaveClass("bg-accent", "text-accent-foreground")
  expect(link).not.toHaveAttribute("aria-pressed")
  assertPressedNames()
})

test("R22 slash region persists empty, announces selection and retains it on reopen", async () => {
  const view = render(<ConfirmProvider><RichTextEditor value={slashDoc} profile="full" onChange={() => {}} /></ConfirmProvider>)
  const surface = await screen.findByRole("textbox")
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  const regions = () => view.container.querySelectorAll('[aria-live="polite"]')
  expect(regions()).toHaveLength(1)
  const live = regions()[0]
  expect(live).toBeEmptyDOMElement()
  expect(live).toHaveAttribute("aria-atomic", "true")
  const assertStable = () => {
    expect(regions()).toHaveLength(1)
    expect(regions()[0]).toBe(live)
    expect(surface).toHaveFocus()
  }
  // The slash menu opens from editor selection events, not a keyDown that inserts no text in jsdom.
  await act(async () => { editor.commands.focus("end") })
  const menu = await screen.findByRole("menu")
  const items = within(menu).getAllByRole("menuitem")
  const first = within(items[0]).getByText("Paragraph").textContent
  const second = within(items[1]).getByText("Heading 1").textContent
  expect(live.textContent).toBe(first)
  assertStable()
  fireEvent.keyDown(surface, { key: "ArrowDown" })
  expect(live.textContent).toBe(second)
  assertStable()
  fireEvent.keyDown(surface, { key: "Escape" })
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  expect(live).toBeEmptyDOMElement()
  assertStable()
  await act(async () => { editor.commands.setTextSelection(1) })
  expect(screen.queryByRole("menu")).not.toBeInTheDocument()
  expect(live).toBeEmptyDOMElement()
  assertStable()
  await act(async () => { editor.commands.setTextSelection(2) })
  await screen.findByRole("menu")
  expect(live.textContent).toBe(second)
  assertStable()
})

// ED10: the slash menu adds no draft write of its own.
async function mountBasic(value = "") {
  const onChange = vi.fn()
  render(
    <ConfirmProvider>
      <RichTextEditor
        value={value}
        profile="basic"
        onChange={onChange}
        label="Description"
      />
    </ConfirmProvider>
  )
  const surface = await screen.findByRole("textbox")
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  return {
    surface,
    editor,
    onChange,
    json: () => JSON.stringify(editor.getJSON()),
  }
}

const ed10SlashDoc = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text: "x " }] }],
})

test("ED10 slash menu: opening it writes nothing; the typed '/' is one ordinary draft write", async () => {
  const { surface, editor, onChange } = await mountBasic(ed10SlashDoc)
  await act(async () => {
    surface.focus()
    editor.commands.setTextSelection(3)
  })
  expect(screen.queryByRole("menu")).toBeNull()
  act(() => {
    editor.view.dispatch(editor.state.tr.insertText("/"))
  })
  expect(await screen.findByRole("menu")).toBeTruthy()
  expect(onChange).toHaveBeenCalledTimes(1)
  expect(onChange.mock.calls[0][0]).toContain('"x /"')
  // Re-detecting the open menu (selection/focus events) adds no write.
  act(() => editor.commands.setTextSelection(4))
  expect(onChange).toHaveBeenCalledTimes(1)
})

test.each([
  { "text/plain": "\nOne\ntwo\n\n\nThree\n", "text/html": "" },
  { "text/html": "<p><br>One<br>two<br></p><p>&nbsp;</p><p>Three</p>", "text/plain": "" },
])("basic sidebar uses the shared tidy-paste policy: %j", async (clipboard) => {
  const { surface, editor, onChange } = await mountBasic()
  fireEvent.paste(surface, { clipboardData: clipboardOf(clipboard) })
  await waitFor(() => expect(onChange).toHaveBeenCalled())
  expect(editor.getJSON().content).toEqual([
    { type: "paragraph", content: [
      { type: "text", text: "One" }, { type: "hardBreak" }, { type: "text", text: "two" },
    ] },
    { type: "paragraph", content: [{ type: "text", text: "Three" }] },
  ])
  for (const utility of BASIC_PARAGRAPH_GAP.split(" "))
    expect(surface.classList).toContain(utility)
})

test("basic sidebar loading, setting content and typing never run paste cleanup", async () => {
  const stored = JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "hardBreak" }, { type: "text", text: "  Kept  " }, { type: "hardBreak" }] },
    { type: "paragraph" },
  ] })
  const { editor, onChange, json } = await mountBasic(stored)
  expect(json()).toBe(stored)
  expect(onChange).not.toHaveBeenCalled()
  act(() => {
    editor.commands.setContent(JSON.parse(stored), { emitUpdate: false })
  })
  expect(json()).toBe(stored)
  expect(onChange).not.toHaveBeenCalled()
  act(() => editor.view.dispatch(editor.state.tr.insertText("  typed  ", 1)))
  expect(json()).toContain('"  typed  "')
  expect(editor.getJSON().content!.at(-1)).toEqual({ type: "paragraph" })
})

test.each(["inline", "full"] as const)("%s sidebar has no basic paste or gap override", async (profile) => {
  render(<ConfirmProvider><RichTextEditor value="" profile={profile} onChange={vi.fn()} /></ConfirmProvider>)
  const surface = await screen.findByRole("textbox")
  const editor = (surface as HTMLElement & { editor: Editor }).editor
  expect(editor.options.editorProps.clipboardTextParser).toBeUndefined()
  expect(editor.options.editorProps.transformPasted).toBeUndefined()
  expect(editor.extensionManager.extensions.some((extension) => extension.name === "basicTextPaste")).toBe(false)
  for (const utility of BASIC_PARAGRAPH_GAP.split(" "))
    expect(surface.classList).not.toContain(utility)
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
])("R1 approved sidebar %s", async (_name, clipboard, expected) => {
  const { surface, editor } = await mountBasic(ed10SlashDoc)
  act(() => editor.commands.selectAll())
  fireEvent.paste(surface, { clipboardData: clipboardOf(clipboard as Record<string, string>) })
  expect(JSON.stringify(editor.getJSON())).toBe(JSON.stringify({ type: "doc", content: expected }))
  for (const utility of BASIC_PARAGRAPH_GAP.split(" ")) expect(surface.classList).toContain(utility)
})

test("R1 editor copy sidebar closed H2 keeps insertion boundaries", async () => {
  const { surface, editor } = await mountBasic(JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "before after" }] },
  ] }))
  act(() => editor.commands.setTextSelection(8))
  fireEvent.paste(surface, { clipboardData: clipboardOf({ "text/html": '<h2 data-pm-slice="0 0 []">Heading</h2>' }) })
  expect(editor.getJSON()).toEqual({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "before " }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Heading" }] },
    { type: "paragraph", content: [{ type: "text", text: "after" }] },
  ] })
})

test("R1 drop sidebar external HTML keeps break and blank paragraph", async () => {
  const { surface, editor } = await mountBasic(JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "before after" }] },
  ] }))
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
]))("R2 marks sidebar: $name retains formatting at the cursor", async ({ name, marks, text, expected }) => {
  const { surface, editor } = await mountBasic(JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "before after", marks }] },
  ] }))
  act(() => editor.commands.setTextSelection(8))
  fireEvent.paste(surface, { clipboardData: clipboardOf({ "text/plain": text }) })
  const expectedDoc = { type: "doc", content: [{ type: "paragraph", content: expected }] }
  if (name.startsWith("link")) expect(editor.getJSON()).toMatchObject(expectedDoc)
  else expect(editor.getJSON()).toEqual(expectedDoc)
})

test.each([
  ["visible metadata text", "<p>&nbsp;</p><ul><li><p>Example data-pm-slice=value</p></li></ul>", "before Example data-pm-slice=valueafter"],
  ["invalid attribute value", '<p data-pm-slice="abc">&nbsp;</p><ul><li><p>One</p></li></ul>', "before Oneafter"],
])("R2 provenance sidebar: %s remains external", async (_name, html, expected) => {
  const { surface, editor } = await mountBasic(JSON.stringify({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: "before after" }] },
  ] }))
  act(() => editor.commands.setTextSelection(8))
  fireEvent.paste(surface, { clipboardData: clipboardOf({ "text/html": html }) })
  expect(editor.getJSON()).toEqual({ type: "doc", content: [
    { type: "paragraph", content: [{ type: "text", text: expected }] },
  ] })
})

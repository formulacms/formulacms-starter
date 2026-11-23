// DATA-LOSS-FIXES case 1, phase A: a late AI answer inside a block. Runs the
// real BlockBuilder -> BlockEditor -> GroupFields -> FieldWriteButton chain with
// a stateful parent (blocks in useState, like the page editor). The answer
// arrives after the owner typed in a sibling field of the same block.
import { useLayoutEffect, useState } from "react"
import type { Editor } from "@tiptap/core"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import {
  INSTALLED_BLOCK_TYPES,
  createDefaultBlock,
  readBlockDefinition,
  type Block,
  type Primitive,
} from "@/convex/lib/blocks"
import { transitionForField } from "@/convex/lib/richtext/transitions"
import type { FieldGenerate } from "./fields/field-editor"
import { BlockBuilder } from "./block-builder"

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(async () => true),
  prompt: vi.fn(async () => "a short brief" as string | null),
  error: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
  useQuery_experimental: vi.fn(() => ({ status: "success", data: [] })),
}))
vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
  usePrompt: () => mocks.prompt,
}))
vi.mock("sonner", () => ({
  toast: { error: mocks.error, message: vi.fn(), success: vi.fn() },
}))

// jsdom has no layout; ProseMirror asks for rects when it scrolls a selection.
const rect = { top: 0, bottom: 10, left: 0, right: 10, width: 10, height: 10, x: 0, y: 0 }
const rects = () => Object.assign([rect], { item: () => rect })
Range.prototype.getClientRects = rects as never
Range.prototype.getBoundingClientRect = (() => rect) as never
Element.prototype.getClientRects = rects as never

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

// Pick an installed block type by shape, never by name, so the file holds no
// block-type literal and still runs on every starter block profile.
type Pick = { type: (typeof INSTALLED_BLOCK_TYPES)[number]; plain: string; write: string; rich?: string }
function primaryFields(type: string): [string, Primitive][] {
  const def = readBlockDefinition(type)
  return def
    ? (Object.entries(def.primary.config.fields as Record<string, Primitive>))
    : []
}
function isPlainText(type: string, key: string, def: Primitive) {
  return (
    def.kind === "text" ||
    (def.kind === "richText" &&
      transitionForField({ blockType: type, fieldPath: `primary.${key}` }) !==
        undefined)
  )
}
function pickBlock(): Pick | undefined {
  for (const type of INSTALLED_BLOCK_TYPES) {
    const fields = primaryFields(type)
    const plain = fields.find(([key, def]) => isPlainText(type, key, def))
    if (!plain) continue
    const write = fields.find(
      ([key, def]) =>
        key !== plain[0] && (def.kind === "text" || def.kind === "richText")
    )
    if (!write) continue
    const rich = fields.find(
      ([key, def]) =>
        key !== write[0] &&
        def.kind === "richText" &&
        !isPlainText(type, key, def)
    )
    return { type, plain: plain[0], write: write[0], rich: rich?.[0] }
  }
  return undefined
}
const PICK = pickBlock()

function testBlock(): Block {
  return {
    ...createDefaultBlock(PICK!.type),
    id: "block_1",
  } as unknown as Block
}

function Host({
  initial,
  generate,
  seenRef,
}: {
  initial: Block[]
  generate: FieldGenerate
  seenRef: { current: Block[] }
}) {
  const [blocks, setBlocks] = useState(initial)
  useLayoutEffect(() => {
    seenRef.current = blocks
  })
  return (
    <BlockBuilder
      title="About us"
      blocks={blocks}
      onChange={setBlocks}
      currentLocale="en"
      pickerOpen={false}
      onPickerOpenChange={() => {}}
      selectedBlockId={initial[0] ? (initial[0] as { id: string }).id : null}
      generate={generate}
    />
  )
}

function mount() {
  const field = deferred<string>()
  const whole = deferred<Block>()
  const generate: FieldGenerate = {
    run: vi.fn(() => field.promise),
    runRefine: vi.fn(() => field.promise),
    runBlock: vi.fn(() => whole.promise),
  }
  const seenRef = { current: [testBlock()] }
  const view = render(
    <Host initial={[testBlock()]} generate={generate} seenRef={seenRef} />
  )
  return { view, generate, field, whole, seenRef }
}

function fieldRoot(path: string) {
  const el = document.querySelector<HTMLElement>(
    `[data-block-field-path="${path}"]`
  )
  if (!el) throw new Error(`no field ${path}`)
  return el
}

async function tiptap(path: string): Promise<Editor> {
  const dom = await waitFor(() => {
    const pm = fieldRoot(path).querySelector(".ProseMirror")
    if (!pm) throw new Error("editor not mounted")
    return pm as HTMLElement & { editor?: Editor }
  })
  return dom.editor!
}

function primary(seenRef: { current: Block[] }) {
  return (seenRef.current[0] as unknown as { primary: Record<string, unknown> })
    .primary
}

beforeEach(() => {
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.prompt.mockReset().mockResolvedValue("a short brief")
  mocks.error.mockReset()
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
})
afterEach(() => vi.clearAllMocks())

describe("late field Write inside a block (test 3)", () => {
  it.skipIf(!PICK)(`keeps a sibling plain-text field typed during the request and applies the answer (${JSON.stringify(PICK)})`, async () => {
    const { plain, write } = PICK!
    const { generate, field, seenRef } = mount()
    const before = primary(seenRef)[write]
    await act(async () => {
      fireEvent.click(
        within(fieldRoot(`primary.${write}`)).getByRole("button", { name: "Write" })
      )
    })
    await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
    fireEvent.change(
      within(fieldRoot(`primary.${plain}`)).getByRole("textbox"),
      { target: { value: "typed by the owner" } }
    )
    expect(primary(seenRef)[plain]).toBe("typed by the owner")
    await act(async () => field.resolve("AI answer"))
    // Correctness property: the typed sibling survives.
    expect(primary(seenRef)[plain]).toBe("typed by the owner")
    // Phase B flip: the answer now applies through the newest callback, so it
    // lands on its own field and no "This block changed" toast shows.
    expect(before).not.toBe("AI answer")
    expect(primary(seenRef)[write]).toBe("AI answer")
    expect(mocks.error).not.toHaveBeenCalled()
  })

  it.skipIf(!PICK?.rich)(`keeps a sibling rich-text field (real TipTap) typed during the request and applies the answer (${JSON.stringify(PICK)})`, async () => {
    const { write, rich } = PICK!
    const { generate, field, seenRef } = mount()
    const before = primary(seenRef)[write]
    const editor = await tiptap(`primary.${rich}`)
    await act(async () => {
      fireEvent.click(
        within(fieldRoot(`primary.${write}`)).getByRole("button", { name: "Write" })
      )
    })
    await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
    act(() => {
      editor.commands.insertContent("typed by the owner")
    })
    expect(JSON.stringify(primary(seenRef)[rich!])).toContain("typed by the owner")
    await act(async () => field.resolve("AI answer"))
    expect(JSON.stringify(primary(seenRef)[rich!])).toContain("typed by the owner")
    // Phase B flip: the answer lands on its own field.
    expect(before).not.toBe("AI answer")
    expect(primary(seenRef)[write]).toBe("AI answer")
    expect(mocks.error).not.toHaveBeenCalled()
  })
})

describe("late whole-block Write (test 4)", () => {
  it.skipIf(!PICK)(`does not overwrite a field typed during the request (${JSON.stringify(PICK)})`, async () => {
    const { plain, write } = PICK!
    const { generate, whole, seenRef } = mount()
    const before = primary(seenRef)[write]
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Write with AI" }))
    })
    await waitFor(() => expect(generate.runBlock).toHaveBeenCalledTimes(1))
    fireEvent.change(
      within(fieldRoot(`primary.${plain}`)).getByRole("textbox"),
      { target: { value: "typed by the owner" } }
    )
    const base = testBlock() as unknown as { primary: Record<string, unknown> }
    await act(async () =>
      whole.resolve({
        ...base,
        id: "generated",
        primary: { ...base.primary, [plain]: "AI plain", [write]: "AI answer" },
      } as unknown as Block)
    )
    // Correctness property: the typed value is not overwritten.
    expect(primary(seenRef)[plain]).toBe("typed by the owner")
    // Pin of today's behavior: the whole answer is dropped with the toast.
    expect(primary(seenRef)[write]).toEqual(before)
    expect(mocks.error).toHaveBeenCalledWith(
      "This block changed. Review it before trying again."
    )
  })
})

// Phase B: the owner switches language while a field answer is in flight. The
// host keeps only the active language's blocks in state, like the page editor.
function LocaleHost({
  generate,
  seenRef,
}: {
  generate: FieldGenerate
  seenRef: { current: { locale: string; blocks: Block[] } }
}) {
  const [locale, setLocale] = useState<"en" | "fr">("en")
  // The French copy has the same id and, here, the same (default) values.
  const [blocks, setBlocks] = useState(() => [testBlock()])
  useLayoutEffect(() => {
    seenRef.current = { locale, blocks }
  })
  return (
    <>
      <button
        type="button"
        onClick={() => {
          setLocale("fr")
          setBlocks([testBlock()])
        }}
      >
        Switch to French
      </button>
      <BlockBuilder
        title="About us"
        blocks={blocks}
        onChange={setBlocks}
        currentLocale={locale}
        pickerOpen={false}
        onPickerOpenChange={() => {}}
        selectedBlockId="block_1"
        generate={generate}
      />
    </>
  )
}

describe("late field Write inside a block, language switch (phase B)", () => {
  it.skipIf(!PICK)(`an English answer does not land in the French block, even when both values are equal (${JSON.stringify(PICK)})`, async () => {
    const { write } = PICK!
    const field = deferred<string>()
    const generate: FieldGenerate = {
      run: vi.fn(() => field.promise),
      runRefine: vi.fn(() => field.promise),
      runBlock: vi.fn(),
    }
    const seenRef = { current: { locale: "en", blocks: [] as Block[] } }
    render(<LocaleHost generate={generate} seenRef={seenRef} />)
    const before = primary({ current: seenRef.current.blocks })[write]
    await act(async () => {
      fireEvent.click(
        within(fieldRoot(`primary.${write}`)).getByRole("button", { name: "Write" })
      )
    })
    await waitFor(() => expect(generate.run).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByRole("button", { name: "Switch to French" }))
    expect(seenRef.current.locale).toBe("fr")
    await act(async () => field.resolve("English AI answer"))
    expect(primary({ current: seenRef.current.blocks })[write]).toEqual(before)
    expect(JSON.stringify(seenRef.current.blocks)).not.toContain("English AI answer")
  })
})

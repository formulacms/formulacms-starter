/**
 * Click guarantees of the page preview, for every registered block and one
 * block made by the block factory's scaffolder. Owners build their own
 * blocks, so these checks hold for the shared machinery (preview canvas,
 * in-place editor, rich-text-caret.ts), never for one example block.
 *
 * Editing in the preview is always on (owner, 2026-11-21): there is no
 * on/off button. The editor blocks it only while a recovered draft waits,
 * after a repeated conflict, under a lock, or when the preview needs a
 * reload.
 *
 * Contract matrix. Rows: the field's editing mode. Columns: editing in the
 * preview allowed / blocked × block selected / not selected × 1 / 2 / 3
 * clicks.
 *
 * | Row                       | Allowed                       | Blocked              |
 * | ------------------------- | ----------------------------- | -------------------- |
 * | in-place `title` contract | in-place editor               | form control         |
 * | in-place `basic` contract | in-place editor               | form control         |
 * | in-place plain text       | in-place editor               | form control         |
 * | form-only full rich text  | form control ("unsupported")  | form control         |
 * | multiline text (textarea) | form control ("unsupported")  | form control         |
 * | a row of a primary list   | form control ("unsupported")  | form control         |
 *
 * Plain text is a one-line `text()` field (eyebrow, label, button text):
 * since PR A3 (owner, 2026-11-21, "do option 1") it opens in place like a
 * title, through the kit's `Text` marker only. A multiline field stays in the
 * form (its public render folds line breaks), and so does every row of a
 * primary list (a button label of the block's own buttons).
 *
 * In every cell: 1 click = caret at the clicked letter, 2 = the clicked word
 * selected, 3 = the paragraph under the pointer selected (a title or a plain
 * input is one paragraph: the whole field; a textarea: the clicked line),
 * the same whether or not the in-place editor had opened. The block's selection state does
 * not change the result: an unselected block (the case below) behaves as a
 * selected one. "unsupported" is the canvas's refusal result; the page
 * editor shows no notice for it: the focused form control is the feedback.
 *
 * jsdom covers the click mapping (field, offset, click count), the field host
 * while the in-place editor loads (never empty, same element) and the editor
 * selection. Real layout (boxes, scroll) is checked in the browser by
 * scripts/verify-block-click-editing.ts in the block simulator.
 *
 * Test proportionally: every presentation gets one click per editing mode;
 * the delayed editor mount runs once per in-place mode and click count, on a
 * registered block and on the scaffolded block.
 */
import * as React from "react"
import ts from "typescript"
import { v } from "convex/values"
import { act, fireEvent, waitFor } from "@testing-library/react"
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { Editor } from "@tiptap/core"
import {
  blockDefs,
  REGISTERED_BLOCK_TYPES,
  type Block,
  type Primitive,
} from "@/convex/lib/blocks"
import * as primitiveFactories from "@/convex/lib/blocks/primitives"
import { button } from "@/convex/lib/blocks/fields"
import { walkValue } from "@/convex/lib/blocks/walk"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { createCoverageFixtures } from "@/lib/blocks/authoring/coverage-fixtures"
import { COVERAGE_EXCLUSIONS } from "@/lib/blocks/authoring/field-coverage"
import { scaffoldBlock, type BlockSpec } from "@/lib/blocks/authoring/scaffold"
import { readRegisteredVerificationCatalog } from "@/lib/blocks/authoring/verification-catalog"
import type { BlockRenderContext } from "@/lib/blocks/links"
import { render } from "@/test-utils/admin-i18n"
import { PageLivePreviewCanvas } from "./page-live-preview-canvas"
import type { PreviewFieldSelection } from "./visual-editing-types"

// The in-place editor's code loads on demand. A test holds that load to see
// the field while the editor is on its way.
const editorLoad = vi.hoisted(() => ({ wait: Promise.resolve() }))
vi.mock("./preview-inline-editor", async (importOriginal) => {
  await editorLoad.wait
  return importOriginal()
})

type Mode =
  | "in-place title"
  | "in-place basic"
  | "in-place plain"
  | "form-only rich text"
  | "multiline text"
  | "primary list row"
type TextField = { path: string; mode: Mode }
type Catalog = Awaited<ReturnType<typeof readRegisteredVerificationCatalog>>
type Canvas = typeof PageLivePreviewCanvas
type Renderer = (blocks: Block[], ctx: BlockRenderContext) => React.ReactNode

const canonical = (path: string) => path.replace(/\[(\d+)\]/g, ".$1")

function modeOf(def: Primitive, path: string): Mode | null {
  if (def.kind !== "text" && def.kind !== "richText") return null
  if (/^primary\..*\.\d+(\.|$)/.test(path)) return "primary list row"
  if (def.kind === "text")
    return (def.config as { multiline?: boolean }).multiline
      ? "multiline text"
      : "in-place plain"
  const { contract } = resolveFieldContract(def.config)
  return contract === "title" || contract === "inline"
    ? "in-place title"
    : contract === "basic"
      ? "in-place basic"
      : "form-only rich text"
}

/** The block's text fields the descriptor and fixture say are on screen. */
function expectedTextFields(
  descriptor: { primary: Primitive; items?: Primitive },
  block: { primary: unknown; items?: unknown },
  expectedPaths: string[]
): TextField[] {
  const fields: TextField[] = []
  const visit = ({ path, def }: { path: string; def: Primitive }) => {
    const mode = modeOf(def, canonical(path))
    if (mode && expectedPaths.includes(canonical(path)))
      fields.push({ path: canonical(path), mode })
  }
  walkValue(descriptor.primary, block.primary, visit, "primary")
  if (descriptor.items) walkValue(descriptor.items, block.items, visit, "items")
  return fields
}

function firstTextNode(host: Element) {
  const walker = host.ownerDocument.createTreeWalker(host, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node; node = walker.nextNode())
    if ((node as Text).data.trim()) return node as Text
  throw new Error(`no text in ${host.outerHTML.slice(0, 120)}`)
}

/** jsdom has no hit testing: the browser's caret lookup is the only shim. */
function clickLetter(host: Element, detail: number, letter = 4) {
  const node = firstTextNode(host)
  Object.defineProperty(document, "caretPositionFromPoint", {
    configurable: true,
    value: () => ({ offsetNode: node, offset: letter }),
  })
  fireEvent.click(node.parentElement!, { detail, clientX: 1, clientY: 1 })
}

/** One implicit or real text block, then four letters ("U3 p|rimary …"). */
const LETTER_OFFSET = 5

function hostOf(root: ParentNode, path: string) {
  return root.querySelector<HTMLElement>(`[data-preview-field="${path}"]`)
}

function mountCanvas(
  Component: Canvas,
  renderWith: typeof render,
  blocks: Block[],
  options: {
    enabled: boolean
    catalog: Catalog
    renderPage?: Renderer
    onInlineEditCommit?: React.ComponentProps<Canvas>["onInlineEditCommit"]
  }
) {
  const onSelectField = vi.fn()
  const props: React.ComponentProps<Canvas> = {
    title: "Preview",
    blocks,
    locale: "en",
    defaultLocale: "en",
    contentEpoch: 0,
    renderContext: {
      locale: "en",
      defaultLocale: "en",
      pagePaths: {},
      relationCards: {},
      presentationCatalog: options.catalog,
    },
    selectedBlockId: null,
    onSelectBlock: vi.fn(),
    onSelectBlockFallback: vi.fn(),
    onSelectField,
    onInlineEditCommit: options.onInlineEditCommit ?? (() => true),
    controlledInlineEnabled: options.enabled,
    ...(options.renderPage ? { renderPage: options.renderPage } : {}),
  }
  const view = renderWith(<Component {...props} />)
  return { view, onSelectField }
}

function lastSelection(onSelectField: ReturnType<typeof vi.fn>) {
  return onSelectField.mock.lastCall as
    | [PreviewFieldSelection, unknown?]
    | undefined
}

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const rangeRects = ["getClientRects", "getBoundingClientRect"] as const
const rangeDescriptors = rangeRects.map((key) =>
  Object.getOwnPropertyDescriptor(Range.prototype, key)
)
beforeAll(() => {
  // TipTap measures ranges; jsdom has no layout.
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
  rangeRects.forEach((key, index) => {
    const descriptor = rangeDescriptors[index]
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor)
    else Reflect.deleteProperty(Range.prototype, key)
  })
})
beforeEach(() => {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub)
  editorLoad.wait = Promise.resolve()
})
afterEach(() => {
  Reflect.deleteProperty(document, "caretPositionFromPoint")
  vi.unstubAllGlobals()
})

// The legacy CTA band is excluded from field coverage as a whole (its named
// CTA migration is separate) and still matches clicks by guessing text; it
// has no field hosts, so it is skipped. Its type name is read from the
// exclusion list: a starter that leaves it out may not name it in a test.
const WHOLE_BLOCK_EXCLUSIONS = COVERAGE_EXCLUSIONS.filter(
  (entry) => entry.path === "*"
)
const SKIPPED_BLOCK_TYPES = new Set<string>(
  WHOLE_BLOCK_EXCLUSIONS.map((entry) => entry.type)
)

it("lets no block but the legacy CTA band skip field coverage as a whole", () => {
  // A second whole-block exclusion would let a factory block skip these
  // click guarantees silently.
  expect(WHOLE_BLOCK_EXCLUSIONS).toHaveLength(1)
  expect(WHOLE_BLOCK_EXCLUSIONS[0]).toMatchObject({ status: "legacy" })
})

async function registeredCases() {
  const catalog = await readRegisteredVerificationCatalog()
  const presentations = catalog.entries.filter(
    (entry) =>
      entry.installed &&
      entry.state === "active" &&
      !SKIPPED_BLOCK_TYPES.has(entry.type)
  )
  expect(new Set(presentations.map((entry) => entry.type))).toEqual(
    new Set(REGISTERED_BLOCK_TYPES.filter((t) => !SKIPPED_BLOCK_TYPES.has(t)))
  )
  return {
    catalog,
    cases: presentations.map((presentation) => {
      const type = presentation.type as Block["type"]
      const descriptor = blockDefs[type]
      const fixture = createCoverageFixtures(type, descriptor).find(
        (entry) => entry.id === "filled"
      )!
      const block = {
        ...structuredClone(fixture.block),
        presentationIdV1: presentation.id,
      } as unknown as Block
      return {
        name: `${type}/${presentation.id}`,
        block,
        fields: expectedTextFields(descriptor, fixture.block, fixture.expectedPaths),
      }
    }),
  }
}

describe("every registered block presentation", () => {
  it("maps a click, double click and triple click on each kind of text field", async () => {
    const { catalog, cases } = await registeredCases()
    for (const { name, block, fields } of cases) {
      expect(fields.length, `${name} has no text field on screen`).toBeGreaterThan(0)
      for (const enabled of [false, true]) {
        const { view, onSelectField } = mountCanvas(
          PageLivePreviewCanvas,
          render,
          [block],
          { enabled, catalog }
        )
        for (const { path } of fields)
          expect(hostOf(view.container, path), `${name}: ${path} has no host`).not.toBeNull()
        // One representative per editing mode; form modes first, so the
        // in-place session (one per render) opens last.
        const modes = [...new Set(fields.map((field) => field.mode))].sort(
          (a, b) => Number(a.startsWith("in-place")) - Number(b.startsWith("in-place"))
        )
        for (const mode of modes) {
          const { path } = fields.find((field) => field.mode === mode)!
          const inPlace = enabled && mode.startsWith("in-place")
          for (const detail of inPlace ? [1] : [1, 2, 3]) {
            clickLetter(hostOf(view.container, path)!, detail)
            const [target, result] = lastSelection(onSelectField)!
            const where = `${name} ${mode} ${path} (editing in the preview ${enabled ? "allowed" : "blocked"}, ${detail} clicks)`
            if (inPlace) {
              expect(target, where).toEqual({
                blockId: block.id,
                fieldPath: path,
                inlineEditing: true,
              })
              expect(result, where).toEqual({ status: "activated" })
            } else {
              expect(target, where).toEqual({
                blockId: block.id,
                fieldPath: path,
                textOffset: LETTER_OFFSET,
                ...(detail > 1 ? { clickCount: detail } : {}),
              })
              // Allowed: the canvas reports a form-only field as refused.
              expect(result, where).toEqual(
                enabled ? { status: "refused", reason: "unsupported" } : undefined
              )
            }
          }
        }
        view.unmount()
      }
    }
  })

  it("selects the exact instance and list row among identical texts", async () => {
    const { catalog, cases } = await registeredCases()
    const listCase = cases.find(({ fields }) =>
      fields.some(({ path }) => /\.1\./.test(path) || /\.1$/.test(path))
    )!
    expect(listCase, "no registered block has a list of text fields").toBeDefined()
    const later = listCase.fields.find(({ path }) => /\.1(\.|$)/.test(path))!
    const earlier = later.path.replace(/\.1(\.|$)/, ".0$1")
    const read = (block: Block, path: string) =>
      path.split(".").reduce<unknown>(
        (value, key) => (value as Record<string, unknown>)[key],
        block
      )
    const write = (block: Block, path: string, value: unknown) => {
      const keys = path.split(".")
      const parent = keys
        .slice(0, -1)
        .reduce<unknown>((at, key) => (at as Record<string, unknown>)[key], block)
      ;(parent as Record<string, unknown>)[keys.at(-1)!] = value
    }
    const first = structuredClone(listCase.block)
    write(first, later.path, read(first, earlier))
    const second = { ...structuredClone(first), id: `${first.id}-second` }
    const { view, onSelectField } = mountCanvas(
      PageLivePreviewCanvas,
      render,
      [first, second],
      { enabled: false, catalog }
    )
    const occurrences = view.container.querySelectorAll(
      "[data-preview-block-occurrence]"
    )
    expect(occurrences).toHaveLength(2)
    expect(hostOf(occurrences[1], later.path)!.textContent).toBe(
      hostOf(occurrences[0], earlier)!.textContent
    )
    clickLetter(hostOf(occurrences[1], later.path)!, 1)
    expect(lastSelection(onSelectField)![0]).toMatchObject({
      blockId: second.id,
      fieldPath: later.path,
    })
    clickLetter(hostOf(occurrences[1], earlier)!, 1)
    expect(lastSelection(onSelectField)![0]).toMatchObject({
      blockId: second.id,
      fieldPath: earlier,
    })
  })
})

const SCAFFOLD_TYPE = "factory-click-probe"

/** A block made by the factory's scaffolder, registered only in this test. */
function scaffoldedBlock(modules: FreshModules) {
  const spec: BlockSpec = {
    type: SCAFFOLD_TYPE,
    label: "Factory click probe",
    description: "Scaffolded block for the click guarantees",
    icon: "Layers",
    group: "misc",
    primary: {
      kind: "group",
      fields: {
        title: { kind: "richText", config: { contract: "title", heading: { role: "blockTitle" } } },
        body: { kind: "richText", config: { contract: "basic" } },
        label: { kind: "text" },
        note: { kind: "text", config: { multiline: true } },
        short: { kind: "text", config: { maxLength: 12 } },
      },
    },
  }
  const { descriptorSource, rendererSource } = scaffoldBlock(spec)
  const compile = (source: string) => {
    const output = ts.transpileModule(source, {
      compilerOptions: {
        jsx: ts.JsxEmit.React,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
      reportDiagnostics: true,
    })
    expect(output.diagnostics ?? []).toEqual([])
    return output.outputText
  }
  const descriptorExports: Record<string, unknown> = {}
  new Function("require", "exports", compile(descriptorSource))(
    (id: string) => {
      if (id === "convex/values") return { v }
      if (id === "./primitives") return primitiveFactories
      if (id === "./fields") return { button }
      throw new Error(`Unexpected scaffold descriptor import: ${id}`)
    },
    descriptorExports
  )
  const def = descriptorExports.factoryClickProbeDef as {
    primary: Primitive
  }
  expect(def).toHaveProperty("type", SCAFFOLD_TYPE)
  // As in generated-block-preview.test.tsx: erase the imports and inject the
  // scaffold's descriptor and the real block kit.
  const kit = modules.kit
  const rendererExports: Record<string, unknown> = {}
  new Function(
    "React",
    "bindBlockFields",
    "RichText",
    "Text",
    "Buttons",
    "KitImage",
    "factoryClickProbeDef",
    "exports",
    compile(
      rendererSource
        .split("\n")
        .filter((line) => !line.startsWith("import "))
        .join("\n")
    )
  )(React, kit.bindBlockFields, kit.RichText, kit.Text, kit.Buttons, kit.KitImage, def, rendererExports)
  const Renderer = rendererExports.FactoryClickProbe as React.ComponentType<{
    block: Block
    ctx: BlockRenderContext
  }>
  expect(typeof Renderer).toBe("function")
  const pm = (type: string, text: string) =>
    JSON.stringify({
      type: "doc",
      content: [
        {
          type,
          ...(type === "heading" ? { attrs: { level: 2 } } : {}),
          content: [{ type: "text", text }],
        },
      ],
    })
  const block = {
    id: "factory-click-probe-1",
    type: SCAFFOLD_TYPE,
    enabled: true,
    primary: {
      title: pm("heading", "U3 primary title"),
      body: pm("paragraph", "U3 primary body"),
      label: "U3 primary label",
      note: "U3 primary note",
      short: "U3 short",
    },
  } as unknown as Block
  const registry = {}
  Reflect.set(registry, SCAFFOLD_TYPE, (entry: Block, context: BlockRenderContext) => (
    <Renderer block={entry} ctx={context} />
  ))
  // The scaffolded type is in no presentation catalog: its own renderer
  // draws it, as in the block simulator.
  const renderPage: Renderer = (blocks, ctx) => (
    <modules.BlockList
      blocks={blocks}
      ctx={{ ...ctx, presentationCatalog: undefined }}
      outline={modules.resolvePageOutline({
        blocks,
        locale: ctx.locale,
        mode: modules.pageHeadingModeFor("page"),
      })}
      registry={registry}
    />
  )
  return { def, block, renderPage, fields: expectedTextFields(def, block, ["primary.title", "primary.body", "primary.label", "primary.note", "primary.short"]) }
}

/** A fresh module graph, so the in-place editor's code loads again. */
async function freshModules() {
  // Settle a load an earlier test started: a module still loading survives
  // the reset and would hand its code to the new graph at once.
  await import("./preview-inline-editor")
  vi.resetModules()
  // A new factory for the new module graph; it waits for the held load.
  vi.doMock("./preview-inline-editor", async (importOriginal) => {
    await editorLoad.wait
    return importOriginal()
  })
  const [canvas, blocks, i18n, list, outline, kit] = await Promise.all([
    import("./page-live-preview-canvas"),
    import("@/convex/lib/blocks"),
    import("@/test-utils/admin-i18n"),
    import("@/components/blocks/block-list"),
    import("@/lib/blocks/page-outline"),
    import("@/components/block-kit"),
  ])
  return {
    Canvas: canvas.PageLivePreviewCanvas,
    blockDefs: blocks.blockDefs,
    render: i18n.render,
    BlockList: list.BlockList,
    resolvePageOutline: outline.resolvePageOutline,
    pageHeadingModeFor: outline.pageHeadingModeFor,
    kit,
  }
}
type FreshModules = Awaited<ReturnType<typeof freshModules>>

function holdEditorLoad() {
  let release!: () => void
  editorLoad.wait = new Promise<void>((resolve) => {
    release = resolve
  })
  return release
}

describe("opening a field in place while the editor's code loads", () => {
  // Letter 4 of "U3 primary title" is in its second word.
  const counts = [
    { detail: 1, selected: "caret" },
    { detail: 2, selected: "word" },
    { detail: 3, selected: "paragraph" },
  ] as const
  const sources = ["registered", "scaffolded"] as const
  const modes = ["in-place title", "in-place basic", "in-place plain"] as const

  it.each(sources.flatMap((source) => modes.flatMap((mode) => counts.map((count) => ({ source, mode, ...count })))))(
    "$source block, $mode, $detail click(s): the host keeps its text, then the editor selects it",
    async ({ source, mode, detail, selected }) => {
      const modules = await freshModules()
      const release = holdEditorLoad()
      const catalog = await readRegisteredVerificationCatalog()
      let block: Block
      let path: string
      let renderPage: Renderer | undefined
      let restore = () => {}
      if (source === "registered") {
        const { cases } = await registeredCases()
        const found = cases.find(({ fields }) => fields.some((field) => field.mode === mode))!
        expect(found, `no registered block has a ${mode} field`).toBeDefined()
        block = found.block
        path = found.fields.find((field) => field.mode === mode)!.path
      } else {
        const probe = scaffoldedBlock(modules)
        const original = Object.getOwnPropertyDescriptor(modules.blockDefs, SCAFFOLD_TYPE)
        Reflect.set(modules.blockDefs, SCAFFOLD_TYPE, probe.def)
        restore = () => {
          if (original) Object.defineProperty(modules.blockDefs, SCAFFOLD_TYPE, original)
          else Reflect.deleteProperty(modules.blockDefs, SCAFFOLD_TYPE)
        }
        block = probe.block
        renderPage = probe.renderPage
        path = probe.fields.find((field) => field.mode === mode)!.path
      }
      try {
        const { view, onSelectField } = mountCanvas(modules.Canvas, modules.render, [block], {
          enabled: true,
          catalog,
          renderPage,
        })
        const host = hostOf(view.container, path)!
        expect(host, `${path} has no host`).not.toBeNull()
        const tag = host.tagName
        const staticText = host.textContent!
        expect(staticText.trim()).not.toBe("")
        // Clicks 1, 2 and 3 of a triple click all land while the code loads.
        for (let click = 1; click <= detail; click++) {
          clickLetter(host, click)
          await act(async () => {})
          expect(hostOf(view.container, path)).toBe(host)
          expect(host.tagName).toBe(tag)
          expect(host.textContent, host.innerHTML).toBe(staticText)
          expect(host.querySelector("[data-preview-inline-editor]"), host.innerHTML).toBeNull()
        }
        const activations = onSelectField.mock.calls.filter(
          ([, result]) => (result as { status?: string })?.status === "activated"
        )
        expect(activations[0]).toEqual([
          { blockId: block.id, fieldPath: path, inlineEditing: true },
          { status: "activated" },
        ])
        release()
        const editorHost = await waitFor(() => {
          const found = host.querySelector<HTMLElement>("[data-preview-inline-editor]")
          expect(found).not.toBeNull()
          return found!
        })
        expect(hostOf(view.container, path)).toBe(host)
        expect(host.tagName).toBe(tag)
        expect(host.textContent).toBe(staticText)
        const editor = (editorHost as HTMLElement & { editor: Editor }).editor
        const { from, to } = editor.state.selection
        const text = editor.state.doc.textBetween(from, to, " ")
        const expected = {
          caret: "",
          word: normalize(staticText).split(" ")[1],
          // The fixture's fields are one paragraph each.
          paragraph: normalize(staticText),
        }[selected]
        expect(normalize(text)).toBe(expected)
        if (detail === 1) expect(from).toBe(richTextPos(editor, LETTER_OFFSET))
        view.unmount()
      } finally {
        restore()
      }
    }
  )
})

describe("a plain text field of a factory block, edited in place", () => {
  // The scaffolder's renderer binds its text fields with the kit's `Text`;
  // nothing else gives them in-place editing.
  async function openProbeField(path: string) {
    const modules = await freshModules()
    const catalog = await readRegisteredVerificationCatalog()
    const probe = scaffoldedBlock(modules)
    const original = Object.getOwnPropertyDescriptor(modules.blockDefs, SCAFFOLD_TYPE)
    Reflect.set(modules.blockDefs, SCAFFOLD_TYPE, probe.def)
    const restore = () => {
      if (original) Object.defineProperty(modules.blockDefs, SCAFFOLD_TYPE, original)
      else Reflect.deleteProperty(modules.blockDefs, SCAFFOLD_TYPE)
    }
    const onInlineEditCommit = vi.fn(() => true)
    const { view, onSelectField } = mountCanvas(modules.Canvas, modules.render, [probe.block], {
      enabled: true,
      catalog,
      renderPage: probe.renderPage,
      onInlineEditCommit,
    })
    const host = hostOf(view.container, path)!
    expect(host, `${path} has no host`).not.toBeNull()
    expect(host.dataset.previewInlineContract).toBe("plain")
    clickLetter(host, 1)
    expect(lastSelection(onSelectField)).toEqual([
      { blockId: probe.block.id, fieldPath: path, inlineEditing: true },
      { status: "activated" },
    ])
    const editorHost = await waitFor(() => {
      const found = host.querySelector<HTMLElement>("[data-preview-inline-editor]")
      expect(found).not.toBeNull()
      return found!
    })
    const editor = (editorHost as HTMLElement & { editor: Editor }).editor
    const written = () =>
      (onInlineEditCommit.mock.lastCall as unknown as [{ kind: string; value: string; fieldPath: string }] | undefined)?.[0]
    return { view, host, editor, written, restore }
  }

  it("writes the typed text to the field as a plain string, and undo restores it", async () => {
    const { view, host, editor, written, restore } = await openProbeField("primary.label")
    try {
      act(() => {
        editor.commands.insertContentAt(editor.state.doc.content.size - 1, " now")
      })
      expect(written()).toMatchObject({
        fieldPath: "primary.label",
        kind: "text",
        value: "U3 primary label now",
      })
      expect(editor.schema.marks).toEqual({})
      act(() => {
        editor.commands.undo()
      })
      expect(written()?.value).toBe("U3 primary label")
      expect(hostOf(view.container, "primary.label")).toBe(host)
      view.unmount()
    } finally {
      restore()
    }
  })

  it("keeps one line: Enter adds nothing and a formatted paste becomes plain text", async () => {
    const { view, editor, written, restore } = await openProbeField("primary.label")
    try {
      act(() => {
        editor.commands.selectAll()
        editor.view.pasteHTML(
          '<p><strong>Bold</strong> and <a href="https://example.com">a link</a></p><p>second line</p>',
          new Event("paste") as ClipboardEvent
        )
      })
      expect(written()?.value).toBe("Bold and a link second line")
      act(() => {
        editor.commands.keyboardShortcut("Enter")
        editor.commands.keyboardShortcut("Shift-Enter")
      })
      expect(written()?.value).toBe("Bold and a link second line")
      view.unmount()
    } finally {
      restore()
    }
  })

  it("stops at the field's max length, for typing and for a paste", async () => {
    const { view, editor, written, restore } = await openProbeField("primary.short")
    try {
      act(() => {
        // "U3 short" is 8 of 12 letters.
        editor.commands.insertContentAt(editor.state.doc.content.size - 1, "1234")
      })
      expect(written()?.value).toBe("U3 short1234")
      act(() => {
        editor.commands.insertContentAt(editor.state.doc.content.size - 1, "5")
      })
      expect(written()?.value).toBe("U3 short1234")
      act(() => {
        editor.commands.selectAll()
        editor.view.pasteText("A much longer pasted line", new Event("paste") as ClipboardEvent)
      })
      expect(written()?.value).toBe("A much longe")
      view.unmount()
    } finally {
      restore()
    }
  })

  it("keeps the field's host while it is cleared, then writes the new text", async () => {
    const { view, host, editor, written, restore } = await openProbeField("primary.label")
    try {
      act(() => {
        editor.commands.selectAll()
        editor.commands.deleteSelection()
      })
      expect(written()?.value).toBe("")
      // The renderer hides an empty field; the open editor keeps its host.
      expect(hostOf(view.container, "primary.label")).toBe(host)
      expect(host.querySelector("[data-preview-inline-editor]")).not.toBeNull()
      act(() => {
        editor.commands.insertContent("New label")
      })
      expect(written()?.value).toBe("New label")
      expect(host.textContent).toBe("New label")
      view.unmount()
    } finally {
      restore()
    }
  })
})

describe("the editor's code fails to load", () => {
  it("falls back to the form with the click's spot and count, and retries on the next click", async () => {
    const modules = await freshModules()
    let fail!: (error: Error) => void
    editorLoad.wait = new Promise<void>((_resolve, reject) => {
      fail = reject
    })
    const catalog = await readRegisteredVerificationCatalog()
    const { cases } = await registeredCases()
    const found = cases.find(({ fields }) =>
      fields.some((field) => field.mode === "in-place title")
    )!
    const { path } = found.fields.find((field) => field.mode === "in-place title")!
    const { view, onSelectField } = mountCanvas(
      modules.Canvas,
      modules.render,
      [found.block],
      { enabled: true, catalog }
    )
    const host = hostOf(view.container, path)!
    clickLetter(host, 1)
    clickLetter(host, 2)
    expect(lastSelection(onSelectField)).toEqual([
      { blockId: found.block.id, fieldPath: path, inlineEditing: true },
      { status: "activated" },
    ])
    await act(async () => {
      fail(new Error("The editor chunk did not load"))
      await editorLoad.wait.catch(() => {})
    })
    // The form control gets the field, at the clicked word.
    await waitFor(() =>
      expect(lastSelection(onSelectField)).toEqual([
        {
          blockId: found.block.id,
          fieldPath: path,
          textOffset: LETTER_OFFSET,
          clickCount: 2,
        },
        { status: "refused", reason: "unsupported" },
      ])
    )
    expect(host.textContent).not.toBe("")
    expect(host.querySelector("[data-preview-inline-editor]")).toBeNull()
    // The next click loads the code again and opens the field in place.
    editorLoad.wait = Promise.resolve()
    clickLetter(host, 1)
    await waitFor(() =>
      expect(host.querySelector("[data-preview-inline-editor]")).not.toBeNull()
    )
    view.unmount()
  })
})

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()

function richTextPos(editor: Editor, offset: number) {
  // The first text block's content starts at position 1.
  let pos = 0
  editor.state.doc.descendants((node, at) => {
    if (pos || !node.isTextblock) return !pos
    pos = at + 1 + (offset - 1)
    return false
  })
  return pos
}

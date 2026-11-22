const titleDoc = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text }],
      },
    ],
  })
import { blockProfile } from "@/test-utils/block-profile"
import * as React from "react"
import { createPortal } from "react-dom"
import { RichTextEditor } from "./rich-text-editor"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import { renderToStaticMarkup } from "react-dom/server"
import type { BlockBodyRendererProps } from "@/components/content-types/types"
import { DefaultBlockBodyContent } from "@/components/blocks/_shared/default-block-body"
import { act, fireEvent, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
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
import { blockDefs, type Block, type Primitive } from "@/convex/lib/blocks"
import { group, list, richText } from "@/convex/lib/blocks/primitives"
import {
  applyPageField,
  capturePageField,
} from "./page-editor/lib/page-inline-draft"
import type { PreviewInlineEditCommit } from "./visual-editing-types"
import type { PreviewActiveEditHandle } from "./visual-editing-types"
import { RichTextContent } from "@/components/blocks/rich-text-content"
import {
  isBlockMostlyInView,
  PageLivePreviewCanvas as PageLivePreview,
} from "./page-live-preview-canvas"
import type { BlockRenderContext } from "@/lib/blocks/links"
import type { HeroWithImageBlock } from "@/convex/lib/blocks"
import { createSampleBlock } from "@/lib/blocks/sample"
import { FeaturesIconGrid } from "@/components/blocks/features-icon-grid"
import type { FeaturesIconGridBlock } from "@/convex/lib/blocks"
import { HeroWithImage } from "@/components/blocks/hero-with-image"
import { readBlockPresentationCatalog } from "@/convex/lib/blocks/presentations"
import {
  createLiveFrameController,
  type LiveFrameBridge,
  type LiveFrameCallbacks,
  type LiveFrameInput,
} from "./live-preview-frame-bridge"

const configuredSite = vi.hoisted(() => ({ defaults: {} }))
vi.mock("@/components/blocks/presentations/site-defaults", () => ({
  SITE_PRESENTATION_DEFAULTS: configuredSite.defaults,
}))
beforeEach(() => {
  for (const key of Object.keys(configuredSite.defaults))
    Reflect.deleteProperty(configuredSite.defaults, key)
})

const rangeRectDescriptors = {
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
  for (const [key, descriptor] of Object.entries(rangeRectDescriptors)) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor)
    else Reflect.deleteProperty(Range.prototype, key)
  }
})

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
const pm = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  })
function hero(id: string, title: string): Block {
  return {
    id,
    type: "hero-agency",
    enabled: true,
    primary: {
      eyebrow: "Agency",
      title: titleDoc(title),
      description: pm("Copy"),
    },
    items: [],
  }
}
function setup(
  blocks = [hero("hero-1", "First")],
  extra: Partial<Parameters<typeof PageLivePreview>[0]> = {}
) {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub)
  const onCommit = vi.fn()
  const onChange = vi.fn()
  const onConflict = vi.fn()
  let handle: PreviewActiveEditHandle | null = null
  const baseProps = {
    title: "Preview",
    blocks,
    locale: "en",
    defaultLocale: "en",
    contentEpoch: 0,
    renderContext: undefined as BlockRenderContext | undefined,
    selectedBlockId: null,
    onSelectBlock: vi.fn(),
    onSelectField: vi.fn(),
    onInlineEditCommit: onCommit,
    controlledInlineEnabled: false,
    onActiveEditHandleChange: (next: PreviewActiveEditHandle | null) => {
      handle = next
    },
    onActiveEditChange: onChange,
    onActiveEditConflict: onConflict,
    ...extra,
  }
  onCommit.mockImplementation((commit: PreviewInlineEditCommit) => {
    const next = applyPageField(
      baseProps.blocks,
      baseProps.locale,
      commit,
      baseProps.contentEpoch ?? 0,
      baseProps.renderContext?.presentationCatalog?.revision ?? ""
    )
    if (!next) return false
    baseProps.blocks = next
    view.rerender(<PageLivePreview {...baseProps} />)
    return true
  })
  const view = render(<PageLivePreview {...baseProps} />)
  return {
    ...view,
    onCommit,
    onChange,
    onConflict,
    baseProps,
    handle: () => handle,
  }
}
function enableEditing(view: ReturnType<typeof setup>) {
  view.baseProps.controlledInlineEnabled = true
  view.rerender(<PageLivePreview {...view.baseProps} />)
}
async function begin(
  view: ReturnType<typeof setup>,
  fieldPath = "primary.title"
) {
  enableEditing(view)
  const target = view.container.querySelector(
    `[data-preview-field="${fieldPath}"]`
  )!
  fireEvent.click(target)
  const host = await view.findByRole("textbox")
  return { host, editor: (host as HTMLElement & { editor: Editor }).editor }
}

// Real controller + mounted Canvas/TipTap, with separate asynchronous parent
// render and bridge delivery queues. The transport delays; it never reconciles.
async function asyncFrame() {
  const catalog = await readBlockPresentationCatalog()
  const view = setup(undefined, {
    renderContext: {
      locale: "en",
      defaultLocale: "en",
      pagePaths: {},
      presentationCatalog: catalog,
    },
  })
  let parent: LiveFrameInput = {
    sessionId: "async-session",
    pageId: "async-page",
    buildId: "async-build",
    pageType: "landing-page",
    locale: "en",
    defaultLocale: "en",
    languageVersion: 3,
    title: "Preview",
    blocks: view.baseProps.blocks,
    contentEpoch: 0,
    catalogRevision: catalog.revision,
    selectedBlockId: null,
    inlineEditingEnabled: true,
    mode: "light",
  }
  const snapshots: LiveFrameInput[] = []
  const deliveries: LiveFrameInput[] = []
  const accepted = vi.fn((commit: PreviewInlineEditCommit) => {
    const blocks = applyPageField(
      parent.blocks,
      "en",
      commit,
      0,
      catalog.revision
    )
    if (!blocks) return false
    parent = { ...parent, blocks }
    snapshots.push(parent)
    return true
  })
  const controller = createLiveFrameController(parent, {
    selectBlock: vi.fn(),
    selectField: vi.fn(),
    commit: accepted,
    change: vi.fn(),
    conflict: view.onConflict,
    save: vi.fn(),
    unavailable: vi.fn(),
    context: vi.fn(),
  })
  let childCallbacks!: LiveFrameCallbacks
  const bridge: LiveFrameBridge = {
    ...parent,
    generation: "async-child",
    connect: (_input, callbacks) => {
      childCallbacks = callbacks
      return true
    },
    replaceInput: (input) => {
      deliveries.push(input)
      return true
    },
    disconnect() {},
    capture: () => null,
    acceptCapture() {},
    hasActiveSession: () => view.handle()?.hasActiveSession() ?? false,
    isComposing: () => view.handle()?.isComposing() ?? false,
  }
  expect(controller.connect(bridge)).toBe(true)
  const bind = (commit: PreviewInlineEditCommit) => ({
    ...commit,
    frameBinding: {
      sessionId: parent.sessionId,
      pageId: parent.pageId,
      generation: bridge.generation,
      buildId: parent.buildId,
      languageVersion: parent.languageVersion,
    },
  })
  view.onCommit.mockImplementation((commit) =>
    childCallbacks.commit(bind(commit))
  )
  view.onChange.mockImplementation((commit) =>
    childCallbacks.change(commit ? bind(commit) : null)
  )
  const mounted = await begin(view)
  const turn = (action: () => void) =>
    act(async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          action()
          resolve()
        }, 0)
      })
    })
  return {
    ...mounted,
    view,
    parent: () => parent,
    setParent: (input: LiveFrameInput) => {
      parent = input
    },
    accepted,
    snapshots,
    controller,
    childCallbacks: () => childCallbacks,
    echo: (input: LiveFrameInput) =>
      turn(() => expect(controller.replaceInput(input)).toBe(true)),
    deliver: (index: number) =>
      turn(() => {
        const input = deliveries.at(index)!
        view.baseProps.blocks = input.blocks
        view.baseProps.locale = input.locale
        view.baseProps.contentEpoch = input.contentEpoch ?? 0
        view.baseProps.renderContext = {
          ...view.baseProps.renderContext!,
          presentationCatalog: {
            ...catalog,
            revision: input.catalogRevision ?? "",
          },
        }
        // Runtime's Canvas props forward the input's reconciliation receipt.
        Object.assign(view.baseProps, { inlineEditEcho: input.inlineEditEcho })
        view.rerender(<PageLivePreview {...view.baseProps} />)
      }),
  }
}

describe("async inline echo source contract", () => {
  it("NEW accepts three character edits across late and reordered actual controller/bridge echoes", blockProfile(["hero-agency"]), async () => {
    const frame = await asyncFrame()
    const { editor, host, view } = frame
    act(() => editor.commands.setTextSelection(3))
    for (const char of ["a", "b", "c"]) {
      act(() => editor.commands.insertContent(char))
      await frame.echo(frame.snapshots.at(-1)!)
    }
    const latest = JSON.stringify(editor.getJSON())
    const selection = editor.state.selection.from
    const textDOM = host.firstChild
    // Bridge setInput commits can lag typing, and snapshots arrive out of order.
    for (const index of [1, 0, 2]) await frame.deliver(index)
    expect(view.onConflict).not.toHaveBeenCalled()
    expect(view.getByRole("textbox")).toBe(host)
    expect(host.firstChild).toBe(textDOM)
    expect(editor.state.selection.from).toBe(selection)
    expect(JSON.stringify(editor.getJSON())).toBe(latest)
    act(() => editor.commands.insertContent("d"))
    expect(frame.accepted).toHaveBeenCalledTimes(4)
    expect(frame.parent().blocks[0].primary).toMatchObject({
      title: JSON.stringify(editor.getJSON()),
    })
    expect(view.onConflict).not.toHaveBeenCalled()
    act(() => editor.commands.undo())
    expect(JSON.stringify(editor.getJSON())).not.toBe(latest)
    expect(view.onConflict).not.toHaveBeenCalled()
    act(() => editor.commands.redo())
    const acceptedText = editor.getText()
    fireEvent.keyDown(host, { key: "Escape" })
    expect(view.queryByRole("textbox")).toBeNull()
    expect(view.container.querySelector("h1")?.textContent).toBe(acceptedText)
  })

  it("NEW keeps controller authority on the latest character when parent renders arrive out of order", blockProfile(["hero-agency"]), async () => {
    const frame = await asyncFrame()
    for (const char of ["a", "b", "c"])
      act(() => frame.editor.commands.insertContent(char))
    // Parent snapshots themselves arrive late, before bridge deliveries.
    for (const index of [2, 0, 1, 0]) {
      await frame.echo(frame.snapshots[index])
      await frame.deliver(-1)
    }
    act(() => frame.editor.commands.insertContent("d"))
    expect(frame.accepted).toHaveBeenCalledTimes(4)
    expect(frame.parent().blocks[0].primary).toMatchObject({
      title: JSON.stringify(frame.editor.getJSON()),
    })
    expect(frame.view.onConflict).not.toHaveBeenCalled()
  })

  it("NEW recognizes repeated own values after backspace without rewinding the island", blockProfile(["hero-agency"]), async () => {
    const frame = await asyncFrame()
    act(() => frame.editor.commands.insertContent("a"))
    await frame.echo(frame.snapshots[0])
    act(() => frame.editor.commands.insertContent("b"))
    await frame.echo(frame.snapshots[1])
    act(() => {
      const end = frame.editor.state.selection.from
      frame.editor.commands.deleteRange({ from: end - 1, to: end })
    })
    await frame.echo(frame.snapshots[2])
    expect(frame.snapshots[0].blocks).toEqual(frame.snapshots[2].blocks)
    for (const index of [2, 1, 0, 1]) await frame.deliver(index)
    expect(frame.editor.getText()).toBe("Firsta")
    expect(frame.view.onConflict).not.toHaveBeenCalled()
    act(() => frame.editor.commands.insertContent("c"))
    expect(frame.accepted).toHaveBeenCalledTimes(4)
    expect(frame.parent().blocks[0].primary).toMatchObject({
      title: titleDoc("Firstac"),
    })
  })

  it.each(["new-value", "historical-own-value"] as const)(
    "NEW refuses a genuine external %s even after own echo recognition", blockProfile(["hero-agency"]),
    async (kind) => {
      const frame = await asyncFrame()
      for (const char of ["a", "b", "c"])
        act(() => frame.editor.commands.insertContent(char))
      await frame.echo(frame.snapshots[2])
      await frame.deliver(-1)
      const external: LiveFrameInput = {
        ...frame.parent(),
        // Ordinary external edits have no accepted inline output provenance.
        blocks: frame.parent().blocks.map((block) => ({
          ...block,
          primary: {
            ...block.primary,
            title: kind === "new-value" ? pm("external") : pm("Firsta"),
          },
        })) as Block[],
      }
      // A caller-supplied receipt must not grant controller echo authority.
      external.inlineEditEcho = frame.view.handle()!.capture()!
      frame.setParent(external)
      await frame.echo(external)
      await frame.deliver(-1)
      expect(frame.view.onConflict).toHaveBeenCalled()
      expect(frame.view.getByRole("textbox")).toBe(frame.host)
      const acceptedBefore = frame.accepted.mock.calls.length
      act(() => frame.editor.commands.insertContent(" refused"))
      expect(frame.accepted).toHaveBeenCalledTimes(acceptedBefore)
      // Even a later real own receipt cannot revive a conflicted activation.
      await frame.echo(frame.snapshots[0])
      await frame.deliver(-1)
      expect(JSON.stringify(frame.view.baseProps.blocks)).not.toContain(
        "refused"
      )
      act(() => frame.editor.commands.insertContent(" still refused"))
      expect(frame.accepted).toHaveBeenCalledTimes(acceptedBefore)
    }
  )

  it("NEW preserves unrelated parent fields while delayed own echoes remain compatible", blockProfile(["hero-agency"]), async () => {
    const frame = await asyncFrame()
    for (const char of ["a", "b", "c"])
      act(() => frame.editor.commands.insertContent(char))
    const unrelated = {
      ...frame.parent(),
      blocks: frame.parent().blocks.map((block) => {
        if (block.type !== "hero-agency")
          throw new Error("Expected hero fixture")
        return {
          ...block,
          primary: { ...block.primary, eyebrow: "external retained" },
        }
      }),
    }
    await frame.echo(frame.snapshots[0])
    frame.setParent(unrelated)
    await frame.echo(unrelated)
    await frame.deliver(0)
    await frame.deliver(1)
    expect(frame.view.baseProps.blocks[0].primary).toMatchObject({
      eyebrow: "external retained",
      title: titleDoc("Firstabc"),
    })
    act(() => frame.editor.commands.insertContent("d"))
    expect(frame.accepted).toHaveBeenCalledTimes(4)
    expect(frame.parent().blocks[0].primary).toMatchObject({
      eyebrow: "external retained",
      title: titleDoc("Firstabcd"),
    })
    expect(frame.view.onConflict).not.toHaveBeenCalled()
  })

  it.each(["epoch", "presentation", "catalog", "disabled", "removed"] as const)(
    "NEW invalidates an accepted echo after %s changes without authorizing more writes", blockProfile(["hero-agency"]),
    async (kind) => {
      const frame = await asyncFrame()
      act(() => frame.editor.commands.insertContent("a"))
      const old = frame.snapshots[0]
      const changed: LiveFrameInput = {
        ...old,
        ...(kind === "epoch" ? { contentEpoch: 1 } : {}),
        ...(kind === "catalog" ? { catalogRevision: "changed" } : {}),
        blocks:
          kind === "removed"
            ? []
            : old.blocks.map((block) => ({
                ...block,
                ...(kind === "presentation"
                  ? { presentationIdV1: "centered" }
                  : {}),
                ...(kind === "disabled" ? { enabled: false } : {}),
              })),
      }
      await frame.echo(changed)
      await frame.deliver(-1)
      expect(frame.view.onConflict).toHaveBeenCalled()
      // The host may unmount when its owning block is removed/disabled.
      if (kind !== "removed" && kind !== "disabled") {
        act(() => frame.editor.commands.insertContent(" refused"))
        expect(frame.accepted).toHaveBeenCalledTimes(1)
      }
    }
  )

  it("NEW cannot reuse an earlier activation's receipt after discard and re-entry", blockProfile(["hero-agency"]), async () => {
    const frame = await asyncFrame()
    act(() => frame.editor.commands.insertContent("a"))
    await frame.echo(frame.snapshots[0])
    await frame.deliver(-1)
    const oldSession = frame.view.handle()!.capture()!.inlineSessionId
    act(() => frame.view.handle()!.discardActiveEdit!())
    const fresh = await begin(frame.view)
    expect(frame.view.handle()!.capture()!.inlineSessionId).not.toBe(oldSession)
    act(() => fresh.editor.commands.insertContent("b"))
    await frame.echo(frame.snapshots[0])
    await frame.deliver(-1)
    expect(frame.view.onConflict).toHaveBeenCalled()
    act(() => fresh.editor.commands.insertContent(" refused"))
    expect(frame.accepted).toHaveBeenCalledTimes(2)
  })
})

describe("B1 parent draft and uncontrolled inline DOM", () => {
  it("NEW accepts DOM typing through the frame controller before the parent echoes its draft", blockProfile(["hero-with-image"]), async () => {
    const catalog = await readBlockPresentationCatalog()
    const sample = createSampleBlock("hero-with-image")
    const view = setup(
      [
        {
          ...sample,
          id: "verification-hero-a",
          enabled: true,
          presentationIdV1: "centered",
          primary: { ...sample.primary, title: titleDoc("Repeated headline") },
        },
      ],
      {
        renderContext: {
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          relationCards: {},
          presentationCatalog: catalog,
        },
      }
    )
    let parent: LiveFrameInput = {
      sessionId: "native-session",
      pageId: "native-page",
      buildId: "native-build",
      pageType: "landing-page",
      locale: "en",
      defaultLocale: "en",
      languageVersion: 3,
      title: "Preview",
      blocks: view.baseProps.blocks,
      contentEpoch: 0,
      catalogRevision: catalog.revision,
      selectedBlockId: null,
      inlineEditingEnabled: true,
      mode: "light",
    }
    const accepted = vi.fn((commit: PreviewInlineEditCommit) => {
      const blocks = applyPageField(
        parent.blocks,
        "en",
        commit,
        0,
        catalog.revision
      )
      if (!blocks) return false
      // A separate parent React root owns this draft; no synchronous child echo.
      parent = { ...parent, blocks }
      return true
    })
    const controller = createLiveFrameController(parent, {
      selectBlock: vi.fn(),
      selectField: vi.fn(),
      commit: accepted,
      change: vi.fn(),
      conflict: view.onConflict,
      save: vi.fn(),
      unavailable: vi.fn(),
      context: vi.fn(),
    })
    let childCallbacks!: LiveFrameCallbacks
    const bridge: LiveFrameBridge = {
      ...parent,
      generation: "native-child",
      connect: (_input, callbacks) => {
        childCallbacks = callbacks
        return true
      },
      replaceInput: () => true,
      disconnect() {},
      capture: () => null,
      acceptCapture() {},
      hasActiveSession: () => view.handle()?.hasActiveSession() ?? false,
      isComposing: () => view.handle()?.isComposing() ?? false,
    }
    expect(controller.connect(bridge)).toBe(true)
    const bind = (commit: PreviewInlineEditCommit) => ({
      ...commit,
      frameBinding: {
        sessionId: parent.sessionId,
        pageId: parent.pageId,
        generation: bridge.generation,
        buildId: parent.buildId,
        languageVersion: parent.languageVersion,
      },
    })
    view.onCommit.mockImplementation((commit) =>
      childCallbacks.commit(bind(commit))
    )
    view.onChange.mockImplementation((commit) =>
      childCallbacks.change(commit ? bind(commit) : null)
    )
    const { host, editor } = await begin(view)
    // Browser typing mutates the editor DOM before ProseMirror observes input.
    // jsdom input is untrusted and does not substitute for native browser proof.
    const text = host.querySelector("span")!.firstChild!
    text.textContent += " [native Escape]"
    fireEvent.input(host, { inputType: "insertText", data: " [native Escape]" })
    await waitFor(() => expect(accepted).toHaveBeenCalledTimes(1))
    const exact = JSON.stringify(editor.getJSON())
    expect(parent.blocks[0].primary).toMatchObject({ title: exact })
    expect(view.baseProps.blocks[0].primary).toMatchObject({
      title: titleDoc("Repeated headline"),
    })
    expect(view.onConflict).not.toHaveBeenCalled()
    expect(view.getByRole("textbox")).toBe(host)
    // Callback-only child renders must retain the accepted local baseline.
    const latestChange = vi.fn(view.baseProps.onActiveEditChange)
    view.baseProps.onActiveEditChange = latestChange
    view.rerender(<PageLivePreview {...view.baseProps} />)
    act(() => {
      editor.commands.focus("end")
      editor.commands.insertContent(" again")
    })
    expect(accepted).toHaveBeenCalledTimes(2)
    expect(latestChange).toHaveBeenCalled()
    expect(view.onConflict).not.toHaveBeenCalled()
    // Then the actual parent echo acknowledges the same canonical value.
    view.baseProps.blocks = parent.blocks
    expect(controller.replaceInput(parent)).toBe(true)
    view.rerender(<PageLivePreview {...view.baseProps} />)
    expect(view.getByRole("textbox")).toBe(host)
    expect(view.onConflict).not.toHaveBeenCalled()
    fireEvent.keyDown(host, { key: "Escape" })
    expect(view.queryByRole("textbox")).toBeNull()
    expect(parent.blocks[0].primary).toMatchObject({
      title: titleDoc("Repeated headline [native Escape] again"),
    })
  })

  it.each(["same-field", "epoch", "presentation", "catalog"] as const)(
    "NEW still refuses a changed %s parent input after locally accepted typing", blockProfile(["hero-agency"]),
    async (kind) => {
      const catalog = await readBlockPresentationCatalog()
      const view = setup(undefined, {
        renderContext: {
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          presentationCatalog: catalog,
        },
      })
      view.onCommit.mockImplementation(
        (commit) =>
          applyPageField(
            view.baseProps.blocks,
            "en",
            commit,
            0,
            catalog.revision
          ) !== null
      )
      const { host, editor } = await begin(view)
      act(() => editor.commands.insertContent(" accepted"))
      expect(view.onConflict).not.toHaveBeenCalled()
      if (kind === "same-field")
        view.baseProps.blocks = view.baseProps.blocks.map((block) => ({
          ...block,
          primary: { ...block.primary, title: titleDoc("external") },
        })) as Block[]
      if (kind === "epoch") view.baseProps.contentEpoch = 1
      if (kind === "presentation")
        view.baseProps.blocks = view.baseProps.blocks.map((block) => ({
          ...block,
          presentationIdV1: "centered",
        }))
      if (kind === "catalog")
        view.baseProps.renderContext = {
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          presentationCatalog: { ...catalog, revision: "changed" },
        }
      const before = JSON.stringify(view.baseProps.blocks)
      view.rerender(<PageLivePreview {...view.baseProps} />)
      expect(view.onConflict).toHaveBeenCalled()
      expect(view.getByRole("textbox")).toBe(host)
      expect(view.handle()?.capture()?.value).toBe(
        JSON.stringify(editor.getJSON())
      )
      act(() => editor.commands.insertContent(" rejected"))
      expect(JSON.stringify(view.baseProps.blocks)).toBe(before)
      expect(view.onCommit).toHaveBeenCalledTimes(1)
    }
  )

  it("NEW explicit conflict Discard clears only the transient island and cannot revive rejected text", blockProfile([]), async () => {
    const view = setup()
    let pending: PreviewInlineEditCommit | null = null
    const currentPending = (): PreviewInlineEditCommit | null => pending
    view.onChange.mockImplementation((commit) => {
      pending = commit
    })
    const { editor } = await begin(view)
    act(() => editor.commands.insertContent(" accepted"))
    view.baseProps.blocks = view.baseProps.blocks.map((block) => {
      if (block.type !== "hero-agency") throw new Error("Expected hero fixture")
      return {
        ...block,
        primary: {
          ...block.primary,
          title: titleDoc("external"),
          eyebrow: "manual retained",
        },
      }
    })
    view.rerender(<PageLivePreview {...view.baseProps} />)
    expect(view.onConflict).toHaveBeenCalled()
    expect(currentPending()?.value).toContain("accepted")
    const canonical = JSON.stringify(view.baseProps.blocks)
    view.onConflict.mockClear()
    act(() => {
      pending = null
      const handle = view.handle() as PreviewActiveEditHandle & {
        discardActiveEdit?(): void
      }
      handle.discardActiveEdit?.()
    })
    view.rerender(<PageLivePreview {...view.baseProps} />)
    expect(view.queryByRole("textbox")).toBeNull()
    expect(view.onConflict).not.toHaveBeenCalled()
    expect(pending).toBeNull()
    expect(JSON.stringify(view.baseProps.blocks)).toBe(canonical)
    const fresh = await begin(view)
    expect(fresh.editor.getText()).toBe("external")
    expect(JSON.stringify(view.baseProps.blocks)).toBe(canonical)
  })

  it("NEW Enter/Shift+Enter in a title insert nothing and composing Escape refuses cancellation", blockProfile([]), async () => {
    const view = setup()
    const { host, editor } = await begin(view)
    fireEvent.keyDown(host, { key: "Enter" })
    fireEvent.keyDown(host, { key: "Enter", shiftKey: true })
    expect(JSON.stringify(editor.getJSON())).not.toContain("hardBreak")
    fireEvent.compositionStart(host)
    fireEvent.keyDown(host, { key: "Escape", isComposing: true })
    expect(view.getByRole("textbox")).toBe(host)
    fireEvent.compositionEnd(host)
    const compositionEndedAt = Date.now()
    await waitFor(() => expect(editor.view.composing).toBe(false))
    // ProseMirror swallows a near-composition Safari keydown for 500ms.
    await waitFor(() =>
      expect(Date.now() - compositionEndedAt).toBeGreaterThanOrEqual(500)
    )
    fireEvent.keyDown(host, { key: "Escape" })
    expect(view.queryByRole("textbox")).toBeNull()
    expect(JSON.stringify(view.baseProps.blocks)).not.toContain("hardBreak")
  })
  for (const profileRow of [
    {
      name: "Features intro",
      type: "features-icon-grid",
      field: "primary.body",
      heading: "H3",
    },
    {
      name: "Features item",
      type: "features-icon-grid",
      field: "items.0.body",
      heading: "H4",
    },
    {
      name: "HeroWithImage default",
      type: "hero-with-image",
      field: "primary.description",
      heading: "H2",
    },
    {
      name: "HeroWithImage centered",
      type: "hero-with-image",
      field: "primary.description",
      heading: "H2",
    },
    {
      name: "HeroAgency",
      type: "hero-agency",
      field: "primary.description",
      heading: "H2",
    },
  ] as const) {
    it.each([profileRow])("basic body activation retains public typography for $name", blockProfile([profileRow.type]),
      async ({ name, type, field, heading }) => {
        const paragraph = (text: string) => ({
          type: "paragraph",
          content: [{ type: "text", text }],
        })
        const body = JSON.stringify({
          type: "doc",
          content: [
            paragraph("Introductory paragraph"),
            {
              type: "heading",
              attrs: { level: 2 },
              content: [{ type: "text", text: "Relative heading" }],
            },
            {
              type: "bulletList",
              content: [{ type: "listItem", content: [paragraph("Bullet item")] }],
            },
            {
              type: "orderedList",
              attrs: { start: 1 },
              content: [{ type: "listItem", content: [paragraph("Numbered item")] }],
            },
          ],
        })
        const block = createSampleBlock(type)
        if (block.type === "features-icon-grid") {
          block.primary.heading = titleDoc("Features heading")
          block.primary.body = body
          block.items = [
            { ...block.items[0], title: titleDoc("Feature title"), body },
          ]
        } else if (block.type === "hero-with-image") {
          block.primary.title = titleDoc("Hero heading")
          block.primary.description = body
          block.presentationIdV1 =
            name === "HeroWithImage centered" ? "centered" : "default"
        } else if (block.type === "hero-agency") {
          block.primary.title = titleDoc("Agency heading")
          block.primary.description = body
        }
        const catalog = await readBlockPresentationCatalog()
        const view = setup([block], {
          renderContext: {
            locale: "en",
            defaultLocale: "en",
            pagePaths: {},
            presentationCatalog: catalog,
          },
          renderPage: (blocks, context) => (
            <DefaultBlockBodyContent
              content={{ title: "Preview" } as BlockBodyRendererProps["content"]}
              blocks={blocks}
              ctx={context}
            />
          ),
        })
        enableEditing(view)
        const fieldSelector = `[data-preview-field="${field}"]`
        const semanticHost =
          view.container.querySelector<HTMLElement>(fieldSelector)!
        expect(semanticHost).not.toBeNull()
        const publicProse = semanticHost.querySelector<HTMLElement>(".prose")!
        expect(publicProse).not.toBeNull()
        const publicIdentity = {
          tag: semanticHost.tagName,
          id: semanticHost.id,
          classes: semanticHost.className,
        }
        const depthFromField = (node: HTMLElement) => {
          let depth = 0
          let current: HTMLElement | null = node
          while (current && current !== semanticHost) {
            depth += 1
            current = current.parentElement
          }
          expect(current).toBe(semanticHost)
          return depth
        }
        const publicDepth = depthFromField(publicProse)
        const blockTags = (root: HTMLElement) =>
          [...root.querySelectorAll("p,h1,h2,h3,h4,h5,h6,ul,ol,li")].map(
            (node) => [node.tagName, node.textContent]
          )
        const publicTags = blockTags(publicProse)
        expect(publicProse.querySelector("h1,h2,h3,h4,h5,h6")?.tagName).toBe(
          heading
        )
        expect(publicProse.querySelectorAll("ul,ol")).toHaveLength(2)
        expect(publicDepth).toBe(1)
        const inheritanceHost =
          type === "features-icon-grid"
            ? semanticHost.parentElement!
            : semanticHost
        const inheritanceSelector =
          type === "features-icon-grid"
            ? "[&>div>.prose]:[font-size:inherit]"
            : "[&>.prose]:[font-size:inherit]"
        expect(inheritanceHost.classList.contains(inheritanceSelector)).toBe(true)

        const { host, editor } = await begin(view, field)
        expect(view.getAllByRole("textbox")).toHaveLength(1)
        expect(editor.view.dom).toBe(host)
        expect(view.container.querySelector(fieldSelector)).toBe(semanticHost)
        expect({
          tag: semanticHost.tagName,
          id: semanticHost.id,
          classes: semanticHost.className,
        }).toEqual(publicIdentity)
        expect(host.parentElement).toBe(semanticHost)
        expect(depthFromField(host)).toBe(publicDepth)
        expect(
          type === "features-icon-grid"
            ? host.parentElement?.parentElement
            : host.parentElement
        ).toBe(inheritanceHost)
        expect(blockTags(host)).toEqual(publicTags)
        expect(host.querySelector("h1,h2,h3,h4,h5,h6")?.tagName).toBe(heading)
        expect(host.querySelectorAll("ul,ol")).toHaveLength(2)
        expect(host.querySelector(".prose")).toBeNull()
        const outerLayoutClasses = [...semanticHost.classList].filter(
          (className) => /^(?:m[trblxy]?|p[trblxy]?|w|min-w|max-w)-/.test(className)
        )
        for (const className of outerLayoutClasses)
          expect(host.classList.contains(className)).toBe(false)
        // This seam guard checks root ownership; jsdom does not prove marker paint.
        expect(host).toHaveClass(
          "prose",
          "max-w-none",
          "prose-neutral",
          "dark:prose-invert"
        )
      }
    )
  }
  it("registered basic body activates an island and saves Enter paragraphs with marks and links", blockProfile([]), async () => {
    const view = setup()
    const { host, editor } = await begin(view, "primary.description")
    act(() => {
      editor.commands.selectAll()
      editor.commands.insertContent({
        type: "text",
        text: "First",
        marks: [
          { type: "bold" },
          { type: "link", attrs: { href: "https://example.com" } },
        ],
      })
    })
    fireEvent.keyDown(host, { key: "Enter" })
    act(() => editor.commands.insertContent("Second"))
    expect(editor.getJSON().content).toHaveLength(2)
    expect(editor.getJSON().content?.[0].content?.[0].marks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "bold" }),
        expect.objectContaining({ type: "link" }),
      ])
    )
    act(() => view.handle()?.flush?.())
    expect(
      (view.baseProps.blocks[0].primary as { description: string }).description
    ).toContain("Second")
    expect(
      JSON.parse(
        (view.baseProps.blocks[0].primary as { description: string })
          .description
      ).content
    ).toHaveLength(2)
    expect(view.getByRole("textbox")).toBe(host)
  })
  it("NEW delivers consecutive exact values into the parent without persistence calls or replacing the island", blockProfile([]), async () => {
    const view = setup()
    const heading = view.container.querySelector("h1")!
    const headingId = heading.id
    const marker = heading
    const occurrence = heading.closest<HTMLElement>(
      "[data-preview-block-occurrence]"
    )!
    const initialMarkers = occurrence.querySelectorAll(
      '[data-preview-field="primary.title"]'
    )
    expect(initialMarkers).toHaveLength(1)
    expect(initialMarkers[0]).toBe(marker)
    const { host, editor } = await begin(view)
    act(() => editor.commands.insertContent(" one"))
    act(() => editor.commands.insertContent(" two"))
    expect(view.onCommit).toHaveBeenCalledTimes(2)
    expect(
      (view.baseProps.blocks[0].primary as Record<string, unknown>).title
    ).toBe(titleDoc("First one two"))
    expect(view.getByRole("textbox")).toBe(host)
    const textDOM = host.firstChild
    view.rerender(
      <PageLivePreview {...view.baseProps} title="ordinary unrelated render" />
    )
    expect(view.getByRole("textbox")).toBe(host)
    expect(host.firstChild).toBe(textDOM)
    expect(host.textContent).toBe("First one two")
    expect(host.tagName).toBe("SPAN")
    expect(host.parentElement).toBe(marker)
    expect(heading).toBe(view.container.querySelector("h1"))
    expect(heading.id).toBe(headingId)
    const activeMarkers = occurrence.querySelectorAll(
      '[data-preview-field="primary.title"]'
    )
    expect(activeMarkers).toHaveLength(1)
    expect(activeMarkers[0]).toBe(marker)
    expect(
      occurrence.querySelectorAll('[data-preview-field="primary.title"]')
    ).toHaveLength(1)
    expect(
      heading.querySelectorAll("[data-preview-inline-editor]")
    ).toHaveLength(1)
    expect(heading.querySelector("p, div")).toBeNull()
    expect(marker.contains(host)).toBe(true)
  })
  it("NEW Escape keeps typed/saved parent content and cannot revert a successful Save", blockProfile([]), async () => {
    const view = setup()
    const { host, editor } = await begin(view)
    act(() => editor.commands.insertContent(" saved"))
    const saved = JSON.stringify(view.baseProps.blocks)
    fireEvent.keyDown(host, { key: "Escape" })
    expect(view.queryByRole("textbox")).toBeNull()
    expect(JSON.stringify(view.baseProps.blocks)).toBe(saved)
    expect(view.container.querySelector("h1[id]")?.textContent).toBe(
      "First saved"
    )
  })
  it("NEW fresh activation after reload/reset uses the current parent draft and is clean until input", blockProfile([]), async () => {
    const view = setup()
    await begin(view)
    expect(view.onCommit).not.toHaveBeenCalled()
    view.unmount()
    const fresh = setup()
    const { host } = await begin(fresh)
    expect(host).toHaveTextContent("First")
    expect(fresh.onCommit).not.toHaveBeenCalled()
  })
  it.each([
    ["security defaults", "noopener noreferrer", false],
    ["authored link flags", "noopener noreferrer nofollow sponsored ugc", true],
  ] as const)(
    "NEW B-C0 iframe replacement seeds exact parent PM including marks, links, hard breaks and %s", blockProfile([]),
    async (_name, rel, flagged) => {
      const view = setup()
      const { editor, host } = await begin(view, "primary.description")
      fireEvent.paste(host, {
        clipboardData: {
          getData: (type: string) =>
            type === "text/html"
              ? `<p><strong>Bold</strong> <a href="https://example.invalid/" target="_blank" rel="${rel}">Link</a><br>line</p><p>tail</p>`
              : "",
        },
      })
      const exact = JSON.stringify(editor.getJSON())
      const parent = view.baseProps.blocks
      expect(exact).toContain('"bold"')
      expect(exact).toContain('"link"')
      expect(exact).toContain('"hardBreak"')
      expect(editor.getJSON().content).toHaveLength(2)
      function assertAuthoredFlags(activeEditor: Editor) {
        const link = activeEditor
          .getJSON()
          .content?.[0].content?.flatMap((node) => node.marks ?? [])
          .find((mark) => mark.type === "link")
        expect(link).toBeDefined()
        for (const flag of ["noFollow", "sponsored", "ugc"])
          expect(link!.attrs?.[flag]).toBe(flagged ? true : null)
      }
      assertAuthoredFlags(editor)
      view.unmount()
      const fresh = setup(parent)
      const next = await begin(fresh, "primary.description")
      expect(JSON.stringify(next.editor.getJSON())).toBe(exact)
      assertAuthoredFlags(next.editor)
      expect(fresh.queryByRole("button", { name: "Restore" })).toBeNull()
    }
  )
  it("NEW B-C1 ignores renderer stamps through A/B/A and never replaces parent text", blockProfile([]), async () => {
    const view = setup()
    const { editor, host } = await begin(view)
    act(() => editor.commands.insertContent(" retained"))
    const exact = (view.baseProps.blocks[0].primary as Record<string, unknown>)
      .title
    for (const revision of ["b", "", "a"]) {
      view.container
        .querySelector("h1")
        ?.setAttribute("data-preview-revision", revision)
      view.rerender(<PageLivePreview {...view.baseProps} title={revision} />)
      expect(view.getByRole("textbox")).toBe(host)
      expect(
        (view.baseProps.blocks[0].primary as Record<string, unknown>).title
      ).toBe(exact)
    }
    expect(view.onConflict).not.toHaveBeenCalled()
  })
  it("NEW unrelated same-block sidebar edits remain compatible", blockProfile([]), async () => {
    const view = setup()
    const { editor } = await begin(view)
    view.baseProps.blocks = view.baseProps.blocks.map(
      (block) =>
        ({
          ...block,
          primary: { ...block.primary, eyebrow: "manual sidebar" },
        }) as Block
    )
    view.rerender(<PageLivePreview {...view.baseProps} />)
    act(() => editor.commands.insertContent(" inline"))
    expect(
      (view.baseProps.blocks[0].primary as Record<string, unknown>).eyebrow
    ).toBe("manual sidebar")
    expect(view.onConflict).not.toHaveBeenCalled()
  })
  it("NEW same-field external edits during composition keep the DOM and exact conflict text after refusal", blockProfile([]), async () => {
    const view = setup()
    const { editor, host } = await begin(view)
    fireEvent.compositionStart(host)
    expect(view.handle()?.isComposing()).toBe(true)
    act(() => editor.commands.insertContent(" composing"))
    view.baseProps.blocks = view.baseProps.blocks.map(
      (block) =>
        ({
          ...block,
          primary: { ...block.primary, title: titleDoc("external apply") },
        }) as Block
    )
    view.rerender(<PageLivePreview {...view.baseProps} />)
    expect(view.getByRole("textbox")).toBe(host)
    expect(host).toHaveTextContent("First composing")
    act(() => editor.commands.insertContent(" exact tail"))
    fireEvent.compositionEnd(host)
    expect(view.handle()?.isComposing()).toBe(false)
    expect(view.onConflict).toHaveBeenCalled()
    expect(view.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({
        value: JSON.stringify(editor.getJSON()),
        composing: false,
      })
    )
    expect(
      (view.baseProps.blocks[0].primary as Record<string, unknown>).title
    ).toBe(titleDoc("external apply"))
  })
  it.each(["locale", "epoch", "removed"])(
    "NEW drops a stale %s write without retargeting", blockProfile([]),
    async (kind) => {
      const view = setup()
      const { editor } = await begin(view)
      if (kind === "locale") view.baseProps.locale = "fr"
      if (kind === "epoch") view.baseProps.contentEpoch = 1
      if (kind === "removed") view.baseProps.blocks = []
      if (kind === "presentation")
        view.baseProps.blocks = view.baseProps.blocks.map((block) => ({
          ...block,
          presentationIdV1: "centered",
        }))
      if (kind === "catalog")
        view.baseProps.renderContext = {
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          presentationCatalog: { revision: "different", entries: [] } as never,
        }
      const before = JSON.stringify(view.baseProps.blocks)
      view.rerender(<PageLivePreview {...view.baseProps} />)
      if (kind !== "removed") act(() => editor.commands.insertContent(" stale"))
      expect(JSON.stringify(view.baseProps.blocks)).toBe(before)
      expect(view.onConflict).toHaveBeenCalled()
    }
  )
  it("NEW blocks a public link and routes unsupported fields to the sidebar", blockProfile([]), () => {
    const view = setup(undefined, {
      renderPage: (blocks, context) =>
        context.previewBlock?.(blocks[0], () => (
          <a href="#public" data-testid="public">
            Unbound public link
          </a>
        )),
    })
    const link = view.getByTestId("public")
    const event = new MouseEvent("click", { bubbles: true, cancelable: true })
    act(() => link.dispatchEvent(event))
    expect(event.defaultPrevented).toBe(true)
    expect(view.queryByRole("textbox")).toBeNull()
  })
})

describe("Unit A NEW heading target regressions", () => {
  it("NEW starts inline editing from the whole h1 using its unique stamped inline span", blockProfile([]), async () => {
    const view = setup()
    enableEditing(view)
    fireEvent.click(view.container.querySelector("h1[id]")!)
    expect(await view.findByRole("textbox")).toHaveTextContent("First")
    expect(view.handle()?.hasActiveSession()).toBe(true)
  })

  it("NEW refuses ambiguous duplicate stamped descendants in a heading", blockProfile([]), () => {
    const view = setup(undefined, {
      renderPage: (blocks, context) =>
        blocks.map((block) =>
          context.previewBlock?.(block, (ctx) => (
            <h2 key={block.id} data-testid="ambiguous-heading">
              {[0, 1].map((index) => (
                <RichTextContent
                  key={index}
                  value={pm("First")}
                  profile="inline"
                  fieldPath="primary.title"
                  ctx={ctx}
                />
              ))}
            </h2>
          ))
        ),
    })
    enableEditing(view)
    fireEvent.click(view.getByTestId("ambiguous-heading"))
    expect(view.queryByRole("textbox")).toBeNull()
    expect(view.handle()?.hasActiveSession()).toBe(false)
    expect(view.baseProps.onSelectField).not.toHaveBeenCalled()
  })
})

describe("descriptor-bound migration click targeting", () => {
  it("keeps root items rich text activatable and writable", blockProfile([]), async () => {
    const block = createSampleBlock("features-icon-grid")
    if (block.type !== "features-icon-grid")
      throw new Error("Expected the repeated-feature fixture")
    const view = setup([block], {
      controlledInlineEnabled: true,
      renderPage: (blocks, context) =>
        blocks.map((current) => {
          if (current.type !== "features-icon-grid")
            throw new Error("Expected the repeated-feature renderer")
          return context.previewBlock?.(current, (ctx) => (
            <FeaturesIconGrid
              block={current satisfies FeaturesIconGridBlock}
              ctx={ctx}
            />
          ))
        }),
    })
    const { editor } = await begin(view, "items.0.title")
    expect(view.baseProps.onSelectField).toHaveBeenCalledWith(
      { blockId: block.id, fieldPath: "items.0.title", inlineEditing: true },
      { status: "activated" }
    )
    act(() => editor.commands.insertContent(" updated"))
    const updated = view.baseProps.blocks[0]
    if (updated.type !== "features-icon-grid")
      throw new Error("Expected the repeated-feature edit to remain in place")
    expect(JSON.parse(updated.items[0].title).content[0]).toEqual({
      type: "heading",
      attrs: { level: 3 },
      content: editor.getJSON().content?.[0]?.content,
    })
  })

  it("refuses activation for a rendered block missing from current parent state", blockProfile([]), () => {
    const ghost = hero("unresolved-preview-block", "Ghost")
    const view = setup([hero("canonical-block", "Canonical")], {
      controlledInlineEnabled: true,
      renderBlocksTransform: () => [ghost],
      renderPage: (blocks, context) =>
        blocks.map((block) =>
          context.previewBlock?.(block, (ctx) => (
            <RichTextContent
              value={pm("Ghost")}
              profile="inline"
              fieldPath="primary.title"
              ctx={ctx}
            />
          ))
        ),
    })
    const field = view.container.querySelector<HTMLElement>(
      '[data-preview-field="primary.title"]'
    )
    if (!field) throw new Error("Expected the transformed preview target")
    fireEvent.click(field)
    expect(view.queryByRole("textbox")).toBeNull()
    expect(view.baseProps.onSelectField).toHaveBeenCalledExactlyOnceWith(
      { blockId: ghost.id, fieldPath: "primary.title" },
      { status: "refused", reason: "capture" }
    )
    expect(view.onCommit).not.toHaveBeenCalled()
  })

  it("refuses primary-list rich text and selects its exact form field", blockProfile([]), () => {
    const originalDef = blockDefs["hero-with-image"]
    const syntheticPrimary = group({
      title: richText({ profile: "inline" }),
      features: list(group({ title: richText({ profile: "inline" }) })),
    })
    const block = createSampleBlock("hero-with-image")
    Reflect.set(block.primary, "features", [{ title: titleDoc("List title") }])
    Reflect.set(blockDefs, "hero-with-image", {
      ...originalDef,
      primary: syntheticPrimary,
    })
    const before = JSON.stringify([block])
    let view: ReturnType<typeof setup> | undefined
    try {
      view = setup([block], {
        selectedBlockId: block.id,
        controlledInlineEnabled: true,
        renderPage: (blocks, context) =>
          blocks.map((current) =>
            context.previewBlock?.(current, (ctx) => (
              <h2>
                <RichTextContent
                  value={pm("List title")}
                  profile="inline"
                  fieldPath="primary.features.0.title"
                  ctx={ctx}
                />
              </h2>
            ))
          ),
      })
      const field = view.container.querySelector<HTMLElement>(
        '[data-preview-field="primary.features.0.title"]'
      )
      if (!field) throw new Error("Expected the mounted primary-list field")
      fireEvent.click(field)
      expect(view.queryByRole("textbox")).toBeNull()
      expect(view.baseProps.onSelectField).toHaveBeenCalledExactlyOnceWith(
        { blockId: block.id, fieldPath: "primary.features.0.title" },
        { status: "refused", reason: "unsupported" }
      )
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(JSON.stringify([block])).toBe(before)
    } finally {
      view?.unmount()
      Reflect.set(blockDefs, "hero-with-image", originalDef)
    }
  })

  it("scrolls a selected preview block without forcing smooth motion", blockProfile([]), async () => {
    const migrated = createSampleBlock("hero-with-image") as HeroWithImageBlock
    const scrollIntoView = vi.fn()
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    )
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    try {
      setup([migrated], {
        selectedBlockId: migrated.id,
        renderPage: (blocks, context) =>
          blocks.map((block) =>
            context.previewBlock?.(block, (ctx) => (
              <HeroWithImage block={block as HeroWithImageBlock} ctx={ctx} />
            ))
          ),
      })
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
      })
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" })
      expect(
        scrollIntoView.mock.calls.every(
          ([options]) =>
            !Object.prototype.hasOwnProperty.call(options, "behavior")
        )
      ).toBe(true)
    } finally {
      if (original)
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original)
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
    }
  })

  it("keeps an off-toggle rich-text double-click on its exact field without activating editing", blockProfile([]), async () => {
    const migrated = createSampleBlock("hero-with-image") as HeroWithImageBlock
    const selectBlockFallback = vi.fn()
    const view = setup([migrated], {
      onSelectBlockFallback: selectBlockFallback,
    })
    const heading = view.container.querySelector(
      'h1[data-preview-field="primary.title"]'
    )!
    fireEvent.click(heading)
    fireEvent.doubleClick(heading)

    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith({
      blockId: migrated.id,
      fieldPath: "primary.title",
    })
    expect(view.queryByRole("textbox")).toBeNull()
    expect(selectBlockFallback).not.toHaveBeenCalled()
  })

  it.each([
    ["primary.eyebrow", []],
    ["primary.image", [{ status: "refused", reason: "unsupported" }]],
  ] as const)(
    "keeps off-toggle double-click focus exact for %s instead of selecting the block fallback", blockProfile([]),
    (fieldPath, notice) => {
      const migrated = createSampleBlock(
        "hero-with-image"
      ) as HeroWithImageBlock
      const selectBlockFallback = vi.fn()
      const view = setup([migrated], {
        onSelectBlockFallback: selectBlockFallback,
      })
      const field = view.container.querySelector(
        `[data-preview-field="${fieldPath}"]`
      )!
      fireEvent.doubleClick(field)

      // Off-toggle text has no "form only" notice; an image keeps it.
      expect(view.baseProps.onSelectField).toHaveBeenCalledWith(
        { blockId: migrated.id, fieldPath },
        ...notice
      )
      expect(selectBlockFallback).not.toHaveBeenCalled()
    }
  )

  it("does not text-guess from an unmarked gap inside the migrated Hero occurrence", blockProfile([]), () => {
    const migrated = createSampleBlock("hero-with-image") as HeroWithImageBlock
    const selectBlockFallback = vi.fn()
    const view = setup([migrated], {
      onSelectBlockFallback: selectBlockFallback,
      renderPage: (blocks, context) =>
        blocks.map((block) =>
          context.previewBlock?.(block, (ctx) => (
            <>
              <HeroWithImage block={block as HeroWithImageBlock} ctx={ctx} />
              <div data-testid="migrated-gap">{migrated.primary.title}</div>
            </>
          ))
        ),
    })

    fireEvent.click(view.getByTestId("migrated-gap"))

    expect(view.baseProps.onSelectField).not.toHaveBeenCalled()
    expect(view.baseProps.onSelectBlock).not.toHaveBeenCalled()
    expect(selectBlockFallback).toHaveBeenCalledExactlyOnceWith(migrated.id)
  })

  it("uses a unique legacy image match but refuses ambiguous image matches", blockProfile([]), () => {
    const block = createSampleBlock("hero-with-image") as HeroWithImageBlock
    const unique = setup([block], {
      renderPage: (blocks, context) =>
        blocks.map((item) =>
          context.previewBlock?.(item, () => (
            <section>
              {/* eslint-disable-next-line @next/next/no-img-element -- Native fixture tests legacy image matching. */}
              <img
                data-testid="legacy-image"
                src={block.primary.image.url}
                alt={block.primary.image.alt ?? ""}
              />
            </section>
          ))
        ),
    })
    fireEvent.click(unique.getByTestId("legacy-image"))
    expect(unique.baseProps.onSelectField).toHaveBeenCalledWith(
      {
        blockId: block.id,
        fieldPath: "primary.image",
      },
      { status: "refused", reason: "unsupported" }
    )

    const ambiguousBlock = structuredClone(block)
    ambiguousBlock.items[0].icon = { ...ambiguousBlock.primary.image }
    const duplicate = setup([ambiguousBlock], {
      renderPage: (blocks, context) =>
        blocks.map((item) =>
          context.previewBlock?.(item, () => (
            <section>
              {/* eslint-disable-next-line @next/next/no-img-element -- Native fixture tests legacy image matching. */}
              <img
                data-testid="ambiguous-image-a"
                src={ambiguousBlock.primary.image.url}
                alt={ambiguousBlock.primary.image.alt ?? ""}
              />
              {/* eslint-disable-next-line @next/next/no-img-element -- Native fixture tests legacy image matching. */}
              <img
                data-testid="ambiguous-image-b"
                src={ambiguousBlock.items[0].icon?.url ?? ""}
                alt={ambiguousBlock.items[0].icon?.alt ?? ""}
              />
            </section>
          ))
        ),
    })
    fireEvent.click(duplicate.getByTestId("ambiguous-image-a"))
    expect(duplicate.baseProps.onSelectField).not.toHaveBeenCalled()
    expect(duplicate.baseProps.onSelectBlock).toHaveBeenCalledWith(
      ambiguousBlock.id
    )
  })

  it("keeps exactly one marker on the active Hero h1 while the editor replaces its children", blockProfile([]), async () => {
    const migrated = createSampleBlock("hero-with-image") as HeroWithImageBlock
    const view = setup([migrated], {
      renderPage: (blocks, context) => (
        <DefaultBlockBodyContent
          content={{ title: "Preview" } as never}
          blocks={blocks}
          ctx={context}
        />
      ),
    })
    enableEditing(view)
    const originalHost = view.container.querySelector("h1[id]")!
    fireEvent.click(originalHost)
    const editor = await view.findByRole("textbox")
    const host = view.container.querySelector("h1[id]")!
    expect(host).toBe(originalHost)
    expect(host.id).toBe(`${migrated.id}-heading`)
    expect(host.className).toContain("text-display")
    expect(
      host.querySelectorAll('[data-preview-field="primary.title"]')
    ).toHaveLength(0)
    expect(
      view.container.querySelectorAll('h1[data-preview-field="primary.title"]')
    ).toHaveLength(1)
    expect(editor.closest("h1")).toBe(host)
    expect(editor.className).not.toMatch(
      /(?:^|\s)(?:mt-6|w-full|max-w-sm)(?:\s|$)/
    )
  })

  it("keeps a unique legacy Hero text guess but refuses ambiguous copy", blockProfile([]), () => {
    const unique = setup(undefined, {
      renderPage: (blocks, context) =>
        blocks.map((block) =>
          context.previewBlock?.(block, () => (
            <section>
              <div data-testid="legacy-title">First</div>
            </section>
          ))
        ),
    })
    fireEvent.click(unique.getByTestId("legacy-title"))
    expect(unique.baseProps.onSelectField).toHaveBeenCalledWith({
      blockId: "hero-1",
      fieldPath: "primary.title",
    })

    const duplicate = hero("hero-ambiguous", "First")
    if (duplicate.type !== "hero-agency")
      throw new Error("Ambiguous legacy Hero fixture must use Hero Agency")
    duplicate.primary.description = pm("First")
    const ambiguous = setup([duplicate], {
      renderPage: (blocks, context) =>
        blocks.map((block) =>
          context.previewBlock?.(block, () => (
            <section>
              <div data-testid="ambiguous-copy">First</div>
            </section>
          ))
        ),
    })
    fireEvent.click(ambiguous.getByTestId("ambiguous-copy"))
    expect(ambiguous.baseProps.onSelectField).not.toHaveBeenCalled()
    expect(ambiguous.baseProps.onSelectBlock).toHaveBeenCalledWith(
      "hero-ambiguous"
    )
  })
})

describe("Caret placement NEW coordinate consumer contract", () => {
  function expectSoleTitleHeadingMarker(heading: HTMLElement) {
    const occurrence = heading.closest<HTMLElement>(
      "[data-preview-block-occurrence]"
    )!
    const markers = occurrence.querySelectorAll(
      '[data-preview-field="primary.title"]'
    )
    expect(markers).toHaveLength(1)
    expect(markers[0]).toBe(heading)
    expect(
      heading.querySelectorAll('[data-preview-field="primary.title"]')
    ).toHaveLength(0)
  }

  async function centeredTitles() {
    const catalog = await readBlockPresentationCatalog()
    const blocks = ["caret-first", "caret-second"].map((id) => {
      const sample = createSampleBlock("hero-with-image")
      return {
        ...sample,
        id,
        enabled: true,
        presentationIdV1: "centered",
        primary: { ...sample.primary, title: titleDoc("Repeated headline") },
      }
    })
    const view = setup(blocks, {
      renderContext: {
        locale: "en",
        defaultLocale: "en",
        pagePaths: {},
        relationCards: {},
        presentationCatalog: catalog,
      },
    })
    enableEditing(view)
    return view
  }

  function browserPoint(view: ReturnType<typeof setup>, offset: number | null) {
    const methods = ["caretPositionFromPoint", "elementFromPoint"] as const
    const descriptors = methods.map((key) =>
      Object.getOwnPropertyDescriptor(document, key)
    )
    const caret = vi.fn(() => {
      const node = view.container.querySelector(
        "[data-preview-inline-editor] span"
      )?.firstChild
      return offset === null || !node ? null : { offsetNode: node, offset }
    })
    const element = vi.fn(() =>
      offset === null
        ? null
        : view.container.querySelector("[data-preview-inline-editor]")
    )
    Object.defineProperty(document, methods[0], {
      configurable: true,
      value: caret,
    })
    Object.defineProperty(document, methods[1], {
      configurable: true,
      value: element,
    })
    return {
      caret,
      element,
      restore() {
        methods.forEach((key, index) => {
          const descriptor = descriptors[index]
          if (descriptor) Object.defineProperty(document, key, descriptor)
          else Reflect.deleteProperty(document, key)
        })
      },
    }
  }

  it.each([
    { point: "letter", clientX: 460, clientY: 180, offset: 4 },
    { point: "word gap", clientX: 653, clientY: 185, offset: 9 },
  ])(
    "NEW maps a $point click in frame viewport coordinates to the mounted text offset", blockProfile(["hero-with-image"]),
    async ({ point, clientX, clientY, offset }) => {
      const view = await centeredTitles()
      const mapping = browserPoint(view, offset)
      const heading = view.container.querySelector<HTMLElement>(
        '#caret-first-heading[data-preview-field="primary.title"]'
      )!
      const headingId = heading.id
      expectSoleTitleHeadingMarker(heading)
      try {
        // jsdom provides no hit testing. Only the browser boundary is shimmed:
        // the installed posAtCoords and TipTap selection commands remain real.
        const target =
          point === "word gap"
            ? heading.querySelector<HTMLElement>(":scope > span")!
            : heading
        if (point === "word gap")
          expect(target.hasAttribute("data-preview-field")).toBe(false)
        fireEvent.click(target, { detail: 1, clientX, clientY })
        const host = await view.findByRole("textbox")
        const editor = (host as HTMLElement & { editor: Editor }).editor
        expect(view.container.querySelector("#caret-first-heading")).toBe(
          heading
        )
        expect(heading.id).toBe(headingId)
        expectSoleTitleHeadingMarker(heading)
        expect(editor.view.dom.closest("h1")).toBe(heading)
        expect(heading.querySelectorAll("p, div")).toHaveLength(0)
        expect(editor.state.selection.from).toBe(offset + 1)
        expect(editor.state.selection.to).toBe(offset + 1)
        // Once at the click (no preview text there in this shim), then once
        // by posAtCoords on mount.
        expect(mapping.caret).toHaveBeenCalledTimes(2)
        expect(mapping.caret).toHaveBeenCalledWith(clientX, clientY)
        expect(mapping.element).toHaveBeenCalledExactlyOnceWith(
          clientX,
          clientY
        )
        expect(view.baseProps.onSelectField).toHaveBeenCalledExactlyOnceWith(
          {
            blockId: "caret-first",
            fieldPath: "primary.title",
            inlineEditing: true,
          },
          { status: "activated" }
        )
        expect(view.handle()?.capture()).toMatchObject({
          blockId: "caret-first",
          fieldPath: "primary.title",
          value: titleDoc("Repeated headline"),
        })
        expect(view.onCommit).not.toHaveBeenCalled()
        act(() => editor.commands.insertContent("X"))
        const expected =
          `Repeated headline`.slice(0, offset) +
          "X" +
          `Repeated headline`.slice(offset)
        expect(editor.getText()).toBe(expected)
        expect(view.onCommit).toHaveBeenCalledExactlyOnceWith(
          expect.objectContaining({
            blockId: "caret-first",
            value: titleDoc(expected),
          })
        )
        expect(view.baseProps.blocks[1].primary).toMatchObject({
          title: titleDoc("Repeated headline"),
        })
        view.baseProps.title = "Fresh parent title"
        view.rerender(<PageLivePreview {...view.baseProps} />)
        expect(view.getByRole("textbox")).toBe(host)
        expect(editor.state.selection.from).toBe(offset + 2)
        expect(mapping.caret).toHaveBeenCalledTimes(2)
        expect(view.onConflict).not.toHaveBeenCalled()
        fireEvent.keyDown(host, { key: "Escape" })
        expect(view.queryByRole("textbox")).toBeNull()
        expect(view.baseProps.blocks[0].primary).toMatchObject({
          title: titleDoc(expected),
        })
      } finally {
        mapping.restore()
      }
    }
  )

  it("places the caret from the click-time text offset even if the frame scrolls before mount", blockProfile(["hero-with-image"]), async () => {
    const view = await centeredTitles()
    const heading = view.container.querySelector<HTMLElement>(
      '#caret-first-heading[data-preview-field="primary.title"]'
    )!
    const clicked = document.createTreeWalker(heading, NodeFilter.SHOW_TEXT)
      .nextNode()!
    const caret = vi.fn((): { offsetNode: Node; offset: number } | null => {
      // After the click the block has scrolled: the same point is now over
      // another letter of the mounted editor.
      if (caret.mock.calls.length > 1) {
        const node = view.container.querySelector(
          "[data-preview-inline-editor] span"
        )?.firstChild
        return node ? { offsetNode: node, offset: 11 } : null
      }
      return { offsetNode: clicked, offset: 4 }
    })
    Object.defineProperty(document, "caretPositionFromPoint", {
      configurable: true,
      value: caret,
    })
    try {
      fireEvent.click(heading, { detail: 1, clientX: 460, clientY: 180 })
      const host = await view.findByRole("textbox")
      const editor = (host as HTMLElement & { editor: Editor }).editor
      expect(caret).toHaveBeenCalledOnce()
      expect(editor.state.selection.from).toBe(5)
      expect(editor.state.selection.to).toBe(5)
      act(() => editor.commands.insertContent("X"))
      expect(editor.getText()).toBe("RepeXated headline")
    } finally {
      Reflect.deleteProperty(document, "caretPositionFromPoint")
    }
  })

  it("NEW falls back to the end when a pointing click cannot map into the mounted editor", blockProfile(["hero-with-image"]), async () => {
    const view = await centeredTitles()
    const mapping = browserPoint(view, null)
    const heading = view.container.querySelector<HTMLElement>(
      '#caret-first-heading[data-preview-field="primary.title"]'
    )!
    const headingId = heading.id
    expectSoleTitleHeadingMarker(heading)
    try {
      fireEvent.click(heading, { detail: 1, clientX: 460, clientY: 180 })
      const host = await view.findByRole("textbox")
      const editor = (host as HTMLElement & { editor: Editor }).editor
      expect(view.container.querySelector("#caret-first-heading")).toBe(heading)
      expect(heading.id).toBe(headingId)
      expectSoleTitleHeadingMarker(heading)
      expect(editor.view.dom.closest("h1")).toBe(heading)
      expect(heading.querySelectorAll("p, div")).toHaveLength(0)
      expect(mapping.caret).toHaveBeenCalledTimes(2)
      expect(mapping.caret).toHaveBeenCalledWith(460, 180)
      expect(editor.state.selection.from).toBe(18)
      expect(editor.state.selection.to).toBe(18)
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(view.onConflict).not.toHaveBeenCalled()
    } finally {
      mapping.restore()
    }
  })

  it("NEW keeps zero-detail keyboard-style activation at the end without coordinate mapping", blockProfile(["hero-with-image"]), async () => {
    const view = await centeredTitles()
    const mapping = browserPoint(view, 4)
    const heading = view.container.querySelector<HTMLElement>(
      '#caret-first-heading[data-preview-field="primary.title"]'
    )!
    const headingId = heading.id
    expectSoleTitleHeadingMarker(heading)
    try {
      fireEvent.click(heading, { detail: 0, clientX: 460, clientY: 180 })
      const host = await view.findByRole("textbox")
      const editor = (host as HTMLElement & { editor: Editor }).editor
      expect(view.container.querySelector("#caret-first-heading")).toBe(heading)
      expect(heading.id).toBe(headingId)
      expectSoleTitleHeadingMarker(heading)
      expect(editor.view.dom.closest("h1")).toBe(heading)
      expect(heading.querySelectorAll("p, div")).toHaveLength(0)
      expect(editor.state.selection.from).toBe(18)
      expect(editor.state.selection.to).toBe(18)
      expect(mapping.caret).not.toHaveBeenCalled()
      expect(mapping.element).not.toHaveBeenCalled()
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(view.onConflict).not.toHaveBeenCalled()
    } finally {
      mapping.restore()
    }
  })
})

describe("Inline activation NEW centered Hero consumer contract", () => {
  async function centeredSiblings() {
    const catalog = await readBlockPresentationCatalog()
    const blocks = ["first-centered", "second-centered"].map((id) => {
      const sample = createSampleBlock("hero-with-image")
      return {
        ...sample,
        id,
        enabled: true,
        presentationIdV1: "centered",
        primary: {
          ...sample.primary,
          title: titleDoc("Repeated headline"),
          description: pm("Different supporting copy"),
        },
      }
    })
    const view = setup(blocks, {
      renderContext: {
        locale: "en",
        defaultLocale: "en",
        pagePaths: {},
        relationCards: {},
        presentationCatalog: catalog,
      },
    })
    return { view, catalog }
  }

  async function activateSecond(targetKind: "outer H2" | "word-space span") {
    const { view, catalog } = await centeredSiblings()
    enableEditing(view)
    const heading = view.container.querySelector<HTMLElement>(
      "#second-centered-heading"
    )!
    const headingId = heading.id
    const occurrence = heading.closest<HTMLElement>(
      "[data-preview-block-occurrence]"
    )!
    const field = heading
    expect(field.dataset.previewInlineContract).toBe("title")
    expect(heading.matches('[data-preview-field="primary.title"]')).toBe(true)
    expect(
      heading.querySelectorAll('[data-preview-field="primary.title"]')
    ).toHaveLength(0)
    const initialMarkers = occurrence.querySelectorAll(
      '[data-preview-field="primary.title"]'
    )
    expect(initialMarkers).toHaveLength(1)
    expect(initialMarkers[0]).toBe(heading)
    const wordSpace = heading.querySelector<HTMLElement>(":scope > span")!
    expect(wordSpace.hasAttribute("data-preview-field")).toBe(false)
    const target = targetKind === "outer H2" ? heading : wordSpace
    // The coordinates come from the installed word-space click. jsdom does
    // not hit-test them: this qualifies dispatch to the stated target only.
    const click = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      clientX: 652,
      clientY: 270,
    })
    fireEvent(target, click)
    expect(click.target).toBe(target)
    expect([click.clientX, click.clientY]).toEqual([652, 270])
    expect(click.defaultPrevented).toBe(true)
    expect(view.baseProps.onSelectField).toHaveBeenCalledExactlyOnceWith(
      {
        blockId: "second-centered",
        fieldPath: "primary.title",
        inlineEditing: true,
      },
      { status: "activated" }
    )
    expect(view.baseProps.onSelectBlock).not.toHaveBeenCalled()
    const host = await view.findByRole("textbox", { name: "Inline edit Title" })
    expect(host.parentElement).toBe(heading)
    expect(view.container.querySelector("#second-centered-heading")).toBe(
      heading
    )
    expect(heading.id).toBe(headingId)
    expect(heading.matches('[data-preview-field="primary.title"]')).toBe(true)
    expect(
      heading.querySelectorAll('[data-preview-field="primary.title"]')
    ).toHaveLength(0)
    const activeMarkers = occurrence.querySelectorAll(
      '[data-preview-field="primary.title"]'
    )
    expect(activeMarkers).toHaveLength(1)
    expect(activeMarkers[0]).toBe(heading)
    expect(
      heading.querySelectorAll("[data-preview-inline-editor]")
    ).toHaveLength(1)
    expect(heading.querySelector("p, div")).toBeNull()
    expect(view.handle()?.hasActiveSession()).toBe(true)
    expect(view.handle()?.capture()).toMatchObject({
      locale: "en",
      blockId: "second-centered",
      fieldPath: "primary.title",
      value: titleDoc("Repeated headline"),
      fieldBinding: {
        contentEpoch: 0,
        presentation: "centered",
        catalogRevision: catalog.revision,
      },
    })
    expect(view.onCommit).not.toHaveBeenCalled()
    const editor = (host as HTMLElement & { editor: Editor }).editor
    act(() => editor.commands.insertContent(" selected"))
    const exact = JSON.stringify(editor.getJSON())
    expect(view.onCommit).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        locale: "en",
        blockId: "second-centered",
        fieldPath: "primary.title",
        value: exact,
      })
    )
    expect(view.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ blockId: "second-centered", value: exact })
    )
    expect(view.baseProps.blocks[0].primary).toMatchObject({
      title: titleDoc("Repeated headline"),
    })
    expect(view.baseProps.blocks[1].primary).toMatchObject({ title: exact })
    expect(view.onConflict).not.toHaveBeenCalled()
  }

  it("NEW dispatches an outer centered H2 through field admission and the exact sibling's parent draft", blockProfile(["hero-with-image"]), async () => {
    await activateSecond("outer H2")
  })

  it("NEW dispatches the coordinate-bearing word-space span through field admission and its parent draft", blockProfile(["hero-with-image"]), async () => {
    await activateSecond("word-space span")
  })

  it("NEW keeps a disabled centered outer H2 form-only without an inline session or draft write", blockProfile(["hero-with-image"]), async () => {
    const { view } = await centeredSiblings()
    fireEvent.click(view.container.querySelector("#second-centered-heading")!, {
      clientX: 652,
      clientY: 270,
    })
    expect(view.baseProps.onSelectField).toHaveBeenCalledExactlyOnceWith({
      blockId: "second-centered",
      fieldPath: "primary.title",
    })
    expect(view.handle()?.hasActiveSession()).toBe(false)
    expect(view.queryByRole("textbox")).toBeNull()
    expect(view.onCommit).not.toHaveBeenCalled()
    expect(view.onChange).not.toHaveBeenCalled()
  })

  it.each(["development", "production"] as const)(
    "NEW reports activation only in development while %s keeps the same consumer outcome", blockProfile(["hero-with-image"]),
    async (environment) => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {})
      vi.stubEnv("NODE_ENV", environment)
      try {
        await activateSecond("outer H2")
        const refusal = vi.fn()
        expect(
          capturePageField([], "en", "missing", "primary.title", 0, "", refusal)
        ).toBeNull()
        if (environment === "production") {
          expect(info).not.toHaveBeenCalled()
          expect(refusal).not.toHaveBeenCalled()
        } else {
          expect(refusal).toHaveBeenCalledExactlyOnceWith(
            "block identity does not resolve to exactly one block"
          )
          expect(info).toHaveBeenCalledWith(
            expect.stringContaining(
              "[Page inline activation] Click field match"
            )
          )
          expect(info).toHaveBeenCalledWith(
            expect.stringContaining('Session report {"active":true')
          )
        }
      } finally {
        vi.unstubAllEnvs()
        info.mockRestore()
      }
    }
  )
})

describe("Inline refusal handoff", () => {
  it("routes a composed-field begin refusal back to its exact form target", blockProfile([]), async () => {
    const view = setup()
    enableEditing(view)
    fireEvent.click(
      view.container.querySelector('[data-preview-field="primary.title"]')!
    )
    const activeEditor = await view.findByRole("textbox")
    fireEvent.compositionStart(activeEditor)

    fireEvent.click(
      view.container.querySelector(
        '[data-preview-field="primary.description"]'
      )!
    )

    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      { blockId: "hero-1", fieldPath: "primary.description" },
      { status: "refused", reason: "begin" }
    )
    expect(view.handle()?.capture()?.fieldPath).toBe("primary.title")
  })

  it("reports a refused capture for a field whose rendered occurrence is ambiguous", blockProfile([]), () => {
    const duplicate = hero("duplicate", "Repeated")
    const view = setup([duplicate, { ...duplicate }])
    enableEditing(view)
    const occurrences = view.container.querySelectorAll(
      "[data-preview-block-occurrence]"
    )
    const field = occurrences[1].querySelector<HTMLElement>(
      '[data-preview-field="primary.title"]'
    )!

    fireEvent.click(field)

    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      {
        blockId: "__formulacms-legacy-block-2",
        fieldPath: "primary.title",
      },
      { status: "refused", reason: "capture" }
    )
    expect(view.handle()?.hasActiveSession()).toBe(false)
  })

  it("lets an untouched session yield to a same-field change outside the preview", blockProfile([]), async () => {
    const view = setup()
    enableEditing(view)
    fireEvent.click(
      view.container.querySelector('[data-preview-field="primary.title"]')!
    )
    await view.findByRole("textbox")
    view.baseProps.blocks = [hero("hero-1", "Changed elsewhere")]
    view.rerender(<PageLivePreview {...view.baseProps} />)

    expect(view.onConflict).not.toHaveBeenCalled()
    expect(view.handle()?.hasActiveSession()).toBe(false)
    expect(
      view.container.querySelector('[data-preview-field="primary.title"]')
        ?.textContent
    ).toBe("Changed elsewhere")
  })

  it("reports a stale refusal after a typed field changes outside the preview", blockProfile([]), async () => {
    const view = setup()
    enableEditing(view)
    fireEvent.click(
      view.container.querySelector('[data-preview-field="primary.title"]')!
    )
    const host = await view.findByRole("textbox")
    act(() =>
      (host as HTMLElement & { editor: Editor }).editor.commands.insertContent(
        "x"
      )
    )
    view.baseProps.blocks = [hero("hero-1", "Changed elsewhere")]
    view.rerender(<PageLivePreview {...view.baseProps} />)

    fireEvent.click(
      view.container.querySelector(
        '[data-preview-field="primary.description"]'
      )!
    )

    expect(view.onConflict).toHaveBeenCalled()
    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      { blockId: "hero-1", fieldPath: "primary.description" },
      { status: "refused", reason: "stale" }
    )
    expect(view.handle()?.capture()?.fieldPath).toBe("primary.title")
  })

  it("returns a localized fallback result when an enabled field has no inline marker", blockProfile([]), () => {
    const view = setup()
    enableEditing(view)
    const field = view.container.querySelector<HTMLElement>(
      '[data-preview-field="primary.title"]'
    )!
    field.dataset.previewInlineContract = "basic"

    fireEvent.click(field)

    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      { blockId: "hero-1", fieldPath: "primary.title" },
      { status: "refused", reason: "unsupported" }
    )
    expect(view.handle()?.hasActiveSession()).toBe(false)
  })
})

describe("Unit A amendment3 NEW heading guards", () => {
  function guardedView(kind: "link" | "button" | "distinct" | "div" | "h3") {
    return setup(undefined, {
      renderPage: (blocks, context) =>
        blocks.map((block) =>
          context.previewBlock?.(block, (ctx) => {
            const title = (
              <RichTextContent
                value={pm("First")}
                profile="inline"
                fieldPath="primary.title"
                ctx={ctx}
              />
            )
            if (kind === "div")
              return <div data-testid="fallback-container">{title}</div>
            if (kind === "h3")
              return <h3 data-testid="fallback-container">{title}</h3>
            return (
              <h2 data-testid="guarded-heading">
                {title}
                {kind === "link" && <a href="#synthetic-target">More</a>}
                {kind === "button" && (
                  <button aria-label="More">
                    <svg />
                  </button>
                )}
                {kind === "distinct" && (
                  <RichTextContent
                    value={pm("Copy")}
                    profile="inline"
                    fieldPath="primary.description"
                    ctx={ctx}
                  />
                )}
              </h2>
            )
          })
        ),
    })
  }

  it.each(["link", "button"] as const)(
    "NEW A-R1 refuses an unbound nested %s without retargeting title", blockProfile([]),
    (kind) => {
      const view = guardedView(kind)
      enableEditing(view)
      fireEvent.click(
        kind === "link"
          ? view.getByRole("link", { name: "More" })
          : view.getByRole("button", { name: "More" })
      )
      expect(view.handle()?.hasActiveSession()).toBe(false)
      expect(view.queryByRole("textbox")).toBeNull()
      expect(view.baseProps.onSelectField).not.toHaveBeenCalled()
      expect(view.onCommit).not.toHaveBeenCalled()
    }
  )

  async function withGenuineInlineFields(run: () => void | Promise<void>) {
    const original = blockDefs["hero-agency"]
    const primary = group({
      ...(original.primary.config.fields as Record<string, Primitive>),
      title: richText({ profile: "inline" }),
      description: richText({ profile: "inline" }),
    })
    Reflect.set(blockDefs, "hero-agency", { ...original, primary })
    try {
      await run()
    } finally {
      Reflect.set(blockDefs, "hero-agency", original)
    }
  }

  it("NEW A-R1 refuses a whole H2 with distinct stamped fields without choosing either field", blockProfile([]), async () =>
    withGenuineInlineFields(() => {
      const view = guardedView("distinct")
      enableEditing(view)
      fireEvent.click(view.getByTestId("guarded-heading"))
      expect(view.handle()?.hasActiveSession()).toBe(false)
      expect(view.queryByRole("textbox")).toBeNull()
      expect(view.baseProps.onSelectField).not.toHaveBeenCalled()
      expect(view.onCommit).not.toHaveBeenCalled()
      view.unmount()
    }))

  it.each(["div"] as const)(
    "NEW A-R1 keeps %s ancestor matching form-only", blockProfile([]),
    (kind) => {
      const view = guardedView(kind)
      enableEditing(view)
      fireEvent.click(view.getByTestId("fallback-container"))
      expect(view.handle()?.hasActiveSession()).toBe(false)
      expect(view.queryByRole("textbox")).toBeNull()
      expect(view.baseProps.onSelectField).toHaveBeenCalledWith(
        {
          blockId: "hero-1",
          fieldPath: "primary.title",
        },
        { status: "refused", reason: "unsupported" }
      )
      expect(view.onCommit).not.toHaveBeenCalled()
    }
  )

  it("NEW A-R1 keeps a precise stamped span editable inside a multi-field heading", blockProfile([]), async () =>
    withGenuineInlineFields(async () => {
      const view = guardedView("distinct")
      enableEditing(view)
      fireEvent.click(
        view.container.querySelector(
          '[data-preview-field="primary.description"]'
        )!
      )
      expect(await view.findByRole("textbox")).toHaveTextContent("Copy")
      expect(view.handle()?.capture()?.fieldPath).toBe("primary.description")
      expect(view.baseProps.onSelectField).toHaveBeenCalledWith(
        {
          blockId: "hero-1",
          fieldPath: "primary.description",
          inlineEditing: true,
        },
        { status: "activated" }
      )
      expect(view.onCommit).not.toHaveBeenCalled()
      view.unmount()
    }))

  it("refuses a basic body forged as an inline stamp inside a heading", blockProfile([]), () => {
    const view = guardedView("distinct")
    enableEditing(view)
    fireEvent.click(
      view.container.querySelector(
        '[data-preview-field="primary.description"]'
      )!
    )
    expect(view.queryByRole("textbox")).toBeNull()
    expect(view.handle()?.hasActiveSession()).toBe(false)
    expect(view.baseProps.onSelectField).toHaveBeenCalledWith(
      { blockId: "hero-1", fieldPath: "primary.description" },
      { status: "refused", reason: "unsupported" }
    )
    expect(view.onCommit).not.toHaveBeenCalled()
  })
})

// RF3 promotes only the opening occurrence, while form-only containers stay guarded.
describe("RF3 heading activation", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "activates a unique stamped inline span from H%s", blockProfile([]),
    async (level) => {
      const view = setup(undefined, {
        renderPage: (blocks, context) =>
          context.previewBlock?.(blocks[0], (ctx) =>
            React.createElement(
              `h${level}`,
              { "data-testid": "outline-host" },
              <RichTextContent
                value={pm("First")}
                profile="inline"
                fieldPath="primary.title"
                ctx={ctx}
              />
            )
          ),
      })
      enableEditing(view)
      fireEvent.click(view.getByTestId("outline-host"))
      expect(await view.findByRole("textbox")).toHaveTextContent("First")
      expect(view.handle()?.hasActiveSession()).toBe(true)
    }
  )
})

describe("RF4b preview ownership", () => {
  it.each(["en", "fr"])(
    "%s matches public ownership after an earlier section", blockProfile(["faq-simple","hero-with-image"]),
    async (locale) => {
      const catalog = await readBlockPresentationCatalog()
      for (const presentationId of ["default", "centered"]) {
        const section = createSampleBlock("faq-simple")
        const sample = createSampleBlock("hero-with-image")
        const makeHero = (id: string, title: string) => ({
          ...sample,
          id,
          presentationIdV1: presentationId,
          primary: { ...sample.primary, title: titleDoc(title) },
        })
        const title = locale === "fr" ? "Titre localisé" : "Localized title"
        const blocks = [
          section,
          { ...makeHero("disabled", "Disabled"), enabled: false },
          makeHero("empty", ""),
          makeHero("lead", title),
          makeHero("later", "Later"),
        ]
        const renderContext = {
          locale,
          defaultLocale: "en",
          pagePaths: {},
          presentationCatalog: catalog,
        }
        const view = setup(blocks, { locale, renderContext })
        const publicContainer = document.createElement("div")
        publicContainer.innerHTML = renderToStaticMarkup(
          <DefaultBlockBodyContent
            content={
              { title: "Preview", blocks } as BlockBodyRendererProps["content"]
            }
            blocks={blocks}
            ctx={renderContext}
          />
        )
        const headings = (root: ParentNode) =>
          [...root.querySelectorAll("h1,h2,h3,h4,h5,h6")].map((heading) => [
            heading.tagName,
            heading.textContent,
          ])
        expect(headings(view.container)).toEqual(headings(publicContainer))
        expect(view.container.querySelectorAll("h1")).toHaveLength(1)
        expect(view.container.querySelector("h1")?.textContent).toBe(title)
        expect(view.container.querySelector("h1.sr-only")).toBeNull()
        expect(view.container.querySelector("#later-heading")?.tagName).toBe(
          "H2"
        )
        view.unmount()
      }
    }
  )
})

function ed10Description(blocks: Block[]) {
  const primary = blocks[0].primary
  return "description" in primary ? primary.description : undefined
}

const ed10OwnerDescription = JSON.stringify({
  type: "doc",
  content: [
    {
      type: "paragraph",
      content: [
        { type: "hardBreak" },
        { type: "text", text: "Vous pouvez partager un article." },
        { type: "hardBreak" },
        { type: "text", text: "La reproduction est interdite." },
        { type: "hardBreak" },
        { type: "hardBreak" },
      ],
    },
    {
      type: "paragraph",
      content: [
        {
          type: "text",
          text: "https://www.lemonde.fr/article.html",
          marks: [
            {
              type: "link",
              attrs: { href: "https://www.lemonde.fr/article.html" },
            },
          ],
        },
      ],
    },
    { type: "paragraph", content: [{ type: "text", text: " " }] },
  ],
})

// ED10: exercise the application handoff with a portal and a real sidebar
// editor. Frame lifecycle/ordering has its own existing suites.
describe("ED10 preview behaviour", () => {
  it.each([true, false])(
    "ED10 multi-click fallback guard (enabled=%s)",
    blockProfile([]),
    async (enabled) => {
      const fallback = vi.fn()
      const view = setup(undefined, {
        controlledInlineEnabled: enabled,
        onSelectBlockFallback: fallback,
      })
      const field = view.container.querySelector<HTMLElement>(
        '[data-preview-field="primary.description"]'
      )!
      const gap = field.parentElement!
      expect(gap.closest("[data-preview-field]")).toBeNull()
      // A first unmatched click retains the established fallback behaviour.
      fireEvent.click(gap, { detail: 1 })
      expect(fallback).toHaveBeenCalledOnce()
      fallback.mockClear()
      if (enabled) {
        fireEvent.click(field)
        await view.findByRole("textbox")
      }
      fireEvent.click(gap, { detail: 2 })
      fireEvent.doubleClick(gap, { detail: 2 })
      fireEvent.click(gap, { detail: 3 })
      expect(fallback).not.toHaveBeenCalled()
      if (enabled) expect(view.handle()?.hasActiveSession()).toBe(true)
    }
  )

  it(
    "ED10 mounted editor double-click keeps native selection events",
    blockProfile([]),
    async () => {
      const view = setup()
      const { host } = await begin(view, "primary.description")
      const event = new MouseEvent("dblclick", {
        detail: 2,
        bubbles: true,
        cancelable: true,
      })
      fireEvent(host, event)
      expect(event.defaultPrevented).toBe(false)
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(view.handle()?.hasActiveSession()).toBe(true)
    }
  )

  it.each([pm("Copy"), ed10OwnerDescription])(
    "ED10 toggle-off flushes the touched island and ends its session (%#)",
    blockProfile([]),
    async (description) => {
      const base = hero("hero-1", "First")
      const block = {
        ...base,
        primary: { ...base.primary, description },
      } as Block
      const view = setup([block])
      const { editor } = await begin(view, "primary.description")
      act(() => editor.commands.insertContent("island "))
      // Simulate a final document mutation not yet delivered by onUpdate.
      act(() =>
        editor.view.dispatch(
          editor.state.tr.insertText("last ").setMeta("preventUpdate", true)
        )
      )
      const finalValue = JSON.stringify(editor.getJSON())
      expect(JSON.stringify(view.baseProps.blocks)).not.toContain("last ")
      view.baseProps.controlledInlineEnabled = false
      await act(async () =>
        view.rerender(<PageLivePreview {...view.baseProps} />)
      )
      expect(view.handle()?.hasActiveSession()).toBe(false)
      expect(view.queryByRole("textbox")).toBeNull()
      expect(ed10Description(view.baseProps.blocks)).toBe(finalValue)
      expect(view.onConflict).not.toHaveBeenCalled()
      expect(view.onChange).toHaveBeenLastCalledWith(null)
    }
  )

  it(
    "ED10 toggle-off waits for composition then flushes and leaves",
    blockProfile([]),
    async () => {
      const view = setup()
      const { host, editor } = await begin(view, "primary.description")
      fireEvent.compositionStart(host)
      act(() => editor.commands.insertContent("composed "))
      view.baseProps.controlledInlineEnabled = false
      await act(async () =>
        view.rerender(<PageLivePreview {...view.baseProps} />)
      )
      expect(view.handle()?.hasActiveSession()).toBe(true)
      const value = JSON.stringify(editor.getJSON())
      fireEvent.compositionEnd(host)
      await waitFor(() => expect(view.handle()?.hasActiveSession()).toBe(false))
      expect(ed10Description(view.baseProps.blocks)).toBe(value)
      expect(view.onConflict).not.toHaveBeenCalled()
    }
  )

  it.each([pm("Copy"), ed10OwnerDescription])(
    "ED10 untouched toggle-off keeps the original bytes (%#)",
    blockProfile([]),
    async (description) => {
      const base = hero("hero-1", "First")
      const view = setup([
        { ...base, primary: { ...base.primary, description } } as Block,
      ])
      await begin(view, "primary.description")
      view.baseProps.controlledInlineEnabled = false
      await act(async () =>
        view.rerender(<PageLivePreview {...view.baseProps} />)
      )
      expect(ed10Description(view.baseProps.blocks)).toBe(description)
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(view.handle()?.hasActiveSession()).toBe(false)
    }
  )

  it(
    "ED10 a locale switch refuses a deferred old-locale flush",
    blockProfile([]),
    async () => {
      const view = setup()
      const { host, editor } = await begin(view, "primary.description")
      fireEvent.compositionStart(host)
      act(() => editor.commands.insertContent("English island "))
      const pending = JSON.stringify(editor.getJSON())
      view.baseProps.controlledInlineEnabled = false
      await act(async () =>
        view.rerender(<PageLivePreview {...view.baseProps} />)
      )
      fireEvent.compositionEnd(host)
      view.onCommit.mockClear()
      const next = hero("hero-1", "French")
      view.baseProps.locale = "fr"
      view.baseProps.blocks = [
        {
          ...next,
          primary: { ...next.primary, description: pm("French draft") },
        } as Block,
      ]
      view.rerender(<PageLivePreview {...view.baseProps} />)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(ed10Description(view.baseProps.blocks)).toBe(pm("French draft"))
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(view.onConflict).toHaveBeenCalled()
      expect(view.handle()?.capture()?.value).toBe(pending)
    }
  )

  it(
    "ED10 frame teardown cancels a deferred session end",
    blockProfile([]),
    async () => {
      const view = setup()
      const { host } = await begin(view, "primary.description")
      fireEvent.compositionStart(host)
      view.baseProps.controlledInlineEnabled = false
      await act(async () =>
        view.rerender(<PageLivePreview {...view.baseProps} />)
      )
      fireEvent.compositionEnd(host)
      view.unmount()
      view.onChange.mockClear()
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(view.onChange).not.toHaveBeenCalled()
      expect(view.onCommit).not.toHaveBeenCalled()
    }
  )

  it(
    "ED10 untouched sidebar edit still yields without a conflict",
    blockProfile([]),
    async () => {
      const view = setup()
      const { host } = await begin(view, "primary.description")
      fireEvent.blur(host, { relatedTarget: null })
      view.baseProps.blocks = view.baseProps.blocks.map(
        (block) =>
          ({
            ...block,
            primary: { ...block.primary, description: pm("Copy /") },
          }) as Block
      )
      view.rerender(<PageLivePreview {...view.baseProps} />)
      expect(view.onConflict).not.toHaveBeenCalled()
      expect(view.handle()?.hasActiveSession()).toBe(false)
    }
  )

  it(
    "ED10 touched sidebar focus adopts the flushed island before immediate typing",
    blockProfile([]),
    async () => {
      const frameBody = document.createElement("div")
      document.body.append(frameBody)
      let active: PreviewActiveEditHandle | null = null
      let draft: Block[] = [hero("hero-1", "First")]
      const conflict = vi.fn()
      const changes = vi.fn()
      function Parent() {
        const [blocks, setBlocks] = React.useState(draft)
        function replace(next: Block[]) {
          draft = next
          setBlocks(next)
        }
        return (
          <ConfirmProvider>
            <section data-preview-sidebar>
              <RichTextEditor
                label="Sidebar Description"
                profile="basic"
                value={String(ed10Description(blocks))}
                onChange={(value) => {
                  replace(
                    blocks.map((block) => ({
                      ...block,
                      primary: { ...block.primary, description: value },
                    })) as Block[]
                  )
                }}
              />
            </section>
            {createPortal(
              <PageLivePreview
                title="Preview"
                blocks={blocks}
                locale="en"
                defaultLocale="en"
                selectedBlockId={null}
                onSelectBlock={() => {}}
                onSelectField={() => {}}
                controlledInlineEnabled
                contentEpoch={0}
                onActiveEditHandleChange={(handle) => {
                  active = handle
                }}
                onActiveEditChange={changes}
                onActiveEditConflict={conflict}
                onInlineEditCommit={(commit) => {
                  const next = applyPageField(draft, "en", commit, 0, "")
                  if (!next) return false
                  replace(next)
                  return true
                }}
              />,
              frameBody
            )}
          </ConfirmProvider>
        )
      }
      vi.stubGlobal("ResizeObserver", ResizeObserverStub)
      const view = render(<Parent />)
      const sidebar = await view.findByRole("textbox", {
        name: "Sidebar Description",
      })
      fireEvent.click(
        frameBody.querySelector('[data-preview-field="primary.description"]')!
      )
      await waitFor(() =>
        expect(frameBody.querySelector('[role="textbox"]')).not.toBeNull()
      )
      const island = frameBody.querySelector<HTMLElement>(
        '[role="textbox"]'
      )! as HTMLElement & { editor: Editor }
      const editor = island.editor
      act(() => {
        editor.commands.setTextSelection(editor.state.doc.content.size - 1)
        editor.commands.insertContent(" island")
      })
      const sidebarEditor = (sidebar as HTMLElement & { editor: Editor }).editor
      // Keep a final island change pending so focus must flush, not discard.
      act(() =>
        editor.view.dispatch(
          editor.state.tr.insertText(" last").setMeta("preventUpdate", true)
        )
      )
      fireEvent.blur(island, { relatedTarget: null })
      // Put the keystroke in the same call stack as focusin: no test wait may
      // accidentally make passive sidebar adoption look synchronous.
      act(() => {
        sidebar.focus()
        expect(active?.hasActiveSession()).toBe(false)
        expect(sidebarEditor.getText()).toBe("Copy island last")
        sidebarEditor.commands.setTextSelection(
          sidebarEditor.state.doc.content.size - 1
        )
        sidebarEditor.commands.insertContent(" sidebar /")
      })
      expect(conflict).not.toHaveBeenCalled()
      expect(ed10Description(draft)).toBe(pm("Copy island last sidebar /"))
      expect(changes).toHaveBeenLastCalledWith(null)
      view.unmount()
      frameBody.remove()
    }
  )
})

describe("form-only rich-text click carries the clicked spot", () => {
  const body = JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "First one" }] },
      { type: "paragraph", content: [{ type: "text", text: "Second two" }] },
    ],
  })
  function bodyView() {
    const block = createSampleBlock("rich-text-body") as Block & {
      primary: { body: string }
    }
    block.primary.body = body
    const view = setup([block])
    enableEditing(view)
    const field = view.container.querySelector<HTMLElement>(
      '[data-preview-field="primary.body"]'
    )!
    const second = [...field.querySelectorAll("p")].at(-1)!.firstChild!
    const range = document.createRange()
    range.setStart(second, 7)
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: () => range,
    })
    return { view, block, field }
  }
  afterEach(() => {
    Reflect.deleteProperty(document, "caretRangeFromPoint")
  })

  it("sends the text offset of a pointer click in paragraph 2", blockProfile(["rich-text-body"]), () => {
    const { view, block, field } = bodyView()
    fireEvent.click(field.querySelectorAll("p")[1]!, {
      detail: 1,
      clientX: 5,
      clientY: 5,
    })
    // 1 + "First one" + 1 + "Second ".
    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      { blockId: block.id, fieldPath: "primary.body", textOffset: 18 },
      { status: "refused", reason: "unsupported" }
    )
  })

  it("sends no offset for a keyboard click", blockProfile(["rich-text-body"]), () => {
    const { view, block, field } = bodyView()
    fireEvent.click(field, { detail: 0 })
    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      { blockId: block.id, fieldPath: "primary.body" },
      { status: "refused", reason: "unsupported" }
    )
  })
})

describe("plain-text field click: in place when allowed, else the clicked letter", () => {
  function eyebrowView(enabled: boolean) {
    const view = setup()
    if (enabled) enableEditing(view)
    const field = view.container.querySelector<HTMLElement>(
      '[data-preview-field="primary.eyebrow"]'
    )!
    const range = document.createRange()
    range.setStart(field.firstChild!, 3)
    Object.defineProperty(document, "caretRangeFromPoint", {
      configurable: true,
      value: () => range,
    })
    return { view, field }
  }
  afterEach(() => {
    Reflect.deleteProperty(document, "caretRangeFromPoint")
  })

  it.each([true, false])(
    "sends the offset with editing in the preview allowed: %s",
    blockProfile([]),
    (enabled) => {
      const { view, field } = eyebrowView(enabled)
      expect(field.textContent).toBe("Agency")
      fireEvent.click(field, { detail: 1, clientX: 5, clientY: 5 })
      // One implicit block, then "Age". While editing in the preview is
      // blocked, every field is edited in the form: no refusal result.
      // Allowed: the one-line plain text field opens in place (PR A3), and
      // its editor takes the clicked letter.
      if (enabled)
        expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
          { blockId: "hero-1", fieldPath: "primary.eyebrow", inlineEditing: true },
          { status: "activated" }
        )
      else
        expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith({
          blockId: "hero-1",
          fieldPath: "primary.eyebrow",
          textOffset: 4,
        })
    }
  )
})

describe("selected block scroll condition", () => {
  const rect = (top: number, height: number) => ({
    top,
    bottom: top + height,
    height,
  })
  it("keeps a block that is fully or mostly on screen", () => {
    expect(isBlockMostlyInView(rect(85, 400), 900)).toBe(true)
    expect(isBlockMostlyInView(rect(-150, 400), 900)).toBe(true)
    expect(isBlockMostlyInView(rect(600, 400), 900)).toBe(true)
  })
  it("scrolls a block that is out of view or mostly hidden", () => {
    expect(isBlockMostlyInView(rect(1200, 400), 900)).toBe(false)
    expect(isBlockMostlyInView(rect(-500, 400), 900)).toBe(false)
    expect(isBlockMostlyInView(rect(750, 400), 900)).toBe(false)
  })
  it("measures a block taller than the viewport against the viewport", () => {
    expect(isBlockMostlyInView(rect(-1000, 2000), 900)).toBe(true)
    expect(isBlockMostlyInView(rect(600, 2000), 900)).toBe(false)
  })
  it("treats a block without layout as out of view", () => {
    expect(isBlockMostlyInView(rect(0, 0), 900)).toBe(false)
  })
})

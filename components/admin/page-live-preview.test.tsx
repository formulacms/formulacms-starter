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
import { sliceProfile } from "@/test-utils/slice-profile"
import * as React from "react"
import { createPortal } from "react-dom"
import { RichTextEditor } from "./rich-text-editor"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import { renderToStaticMarkup } from "react-dom/server"
import type { SliceBodyRendererProps } from "@/components/content-types/types"
import { DefaultSliceBodyContent } from "@/components/slices/_shared/default-slice-body"
import { act, fireEvent, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { Editor } from "@tiptap/core"
import { sliceDefs, type Slice, type Primitive } from "@/convex/lib/slices"
import { group, list, richText } from "@/convex/lib/slices/primitives"
import {
  applyPageField,
  capturePageField,
} from "./page-editor/lib/page-inline-draft"
import type { PreviewInlineEditCommit } from "./visual-editing-types"
import type { PreviewActiveEditHandle } from "./visual-editing-types"
import { RichTextContent } from "@/components/slices/rich-text-content"
import { PageLivePreviewCanvas as PageLivePreview } from "./page-live-preview-canvas"
import type { SliceRenderContext } from "@/lib/slices/links"
import type { HeroWithImageSlice } from "@/convex/lib/slices"
import { createSampleSlice } from "@/lib/slices/sample"
import { FeaturesIconGrid } from "@/components/slices/features-icon-grid"
import type { FeaturesIconGridSlice } from "@/convex/lib/slices"
import { HeroWithImage } from "@/components/slices/hero-with-image"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"
import {
  createLiveFrameController,
  type LiveFrameBridge,
  type LiveFrameCallbacks,
  type LiveFrameInput,
} from "./live-preview-frame-bridge"

const configuredSite = vi.hoisted(() => ({ defaults: {} }))
vi.mock("@/components/slices/presentations/site-defaults", () => ({
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
function hero(id: string, title: string): Slice {
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
  slices = [hero("hero-1", "First")],
  extra: Partial<Parameters<typeof PageLivePreview>[0]> = {}
) {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub)
  const onCommit = vi.fn()
  const onChange = vi.fn()
  const onConflict = vi.fn()
  let handle: PreviewActiveEditHandle | null = null
  const baseProps = {
    title: "Preview",
    slices,
    locale: "en",
    defaultLocale: "en",
    contentEpoch: 0,
    renderContext: undefined as SliceRenderContext | undefined,
    selectedSliceId: null,
    onSelectSlice: vi.fn(),
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
      baseProps.slices,
      baseProps.locale,
      commit,
      baseProps.contentEpoch ?? 0,
      baseProps.renderContext?.presentationCatalog?.revision ?? ""
    )
    if (!next) return false
    baseProps.slices = next
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
  const catalog = await readSlicePresentationCatalog()
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
    slices: view.baseProps.slices,
    contentEpoch: 0,
    catalogRevision: catalog.revision,
    selectedSliceId: null,
    inlineEditingEnabled: true,
    mode: "light",
  }
  const snapshots: LiveFrameInput[] = []
  const deliveries: LiveFrameInput[] = []
  const accepted = vi.fn((commit: PreviewInlineEditCommit) => {
    const slices = applyPageField(
      parent.slices,
      "en",
      commit,
      0,
      catalog.revision
    )
    if (!slices) return false
    parent = { ...parent, slices }
    snapshots.push(parent)
    return true
  })
  const controller = createLiveFrameController(parent, {
    selectSlice: vi.fn(),
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
        view.baseProps.slices = input.slices
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
  it("NEW accepts three character edits across late and reordered actual controller/bridge echoes", sliceProfile(["hero-agency"]), async () => {
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
    expect(frame.parent().slices[0].primary).toMatchObject({
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

  it("NEW keeps controller authority on the latest character when parent renders arrive out of order", sliceProfile(["hero-agency"]), async () => {
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
    expect(frame.parent().slices[0].primary).toMatchObject({
      title: JSON.stringify(frame.editor.getJSON()),
    })
    expect(frame.view.onConflict).not.toHaveBeenCalled()
  })

  it("NEW recognizes repeated own values after backspace without rewinding the island", sliceProfile(["hero-agency"]), async () => {
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
    expect(frame.snapshots[0].slices).toEqual(frame.snapshots[2].slices)
    for (const index of [2, 1, 0, 1]) await frame.deliver(index)
    expect(frame.editor.getText()).toBe("Firsta")
    expect(frame.view.onConflict).not.toHaveBeenCalled()
    act(() => frame.editor.commands.insertContent("c"))
    expect(frame.accepted).toHaveBeenCalledTimes(4)
    expect(frame.parent().slices[0].primary).toMatchObject({
      title: titleDoc("Firstac"),
    })
  })

  it.each(["new-value", "historical-own-value"] as const)(
    "NEW refuses a genuine external %s even after own echo recognition", sliceProfile(["hero-agency"]),
    async (kind) => {
      const frame = await asyncFrame()
      for (const char of ["a", "b", "c"])
        act(() => frame.editor.commands.insertContent(char))
      await frame.echo(frame.snapshots[2])
      await frame.deliver(-1)
      const external: LiveFrameInput = {
        ...frame.parent(),
        // Ordinary external edits have no accepted inline output provenance.
        slices: frame.parent().slices.map((slice) => ({
          ...slice,
          primary: {
            ...slice.primary,
            title: kind === "new-value" ? pm("external") : pm("Firsta"),
          },
        })) as Slice[],
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
      expect(JSON.stringify(frame.view.baseProps.slices)).not.toContain(
        "refused"
      )
      act(() => frame.editor.commands.insertContent(" still refused"))
      expect(frame.accepted).toHaveBeenCalledTimes(acceptedBefore)
    }
  )

  it("NEW preserves unrelated parent fields while delayed own echoes remain compatible", sliceProfile(["hero-agency"]), async () => {
    const frame = await asyncFrame()
    for (const char of ["a", "b", "c"])
      act(() => frame.editor.commands.insertContent(char))
    const unrelated = {
      ...frame.parent(),
      slices: frame.parent().slices.map((slice) => {
        if (slice.type !== "hero-agency")
          throw new Error("Expected hero fixture")
        return {
          ...slice,
          primary: { ...slice.primary, eyebrow: "external retained" },
        }
      }),
    }
    await frame.echo(frame.snapshots[0])
    frame.setParent(unrelated)
    await frame.echo(unrelated)
    await frame.deliver(0)
    await frame.deliver(1)
    expect(frame.view.baseProps.slices[0].primary).toMatchObject({
      eyebrow: "external retained",
      title: titleDoc("Firstabc"),
    })
    act(() => frame.editor.commands.insertContent("d"))
    expect(frame.accepted).toHaveBeenCalledTimes(4)
    expect(frame.parent().slices[0].primary).toMatchObject({
      eyebrow: "external retained",
      title: titleDoc("Firstabcd"),
    })
    expect(frame.view.onConflict).not.toHaveBeenCalled()
  })

  it.each(["epoch", "presentation", "catalog", "disabled", "removed"] as const)(
    "NEW invalidates an accepted echo after %s changes without authorizing more writes", sliceProfile(["hero-agency"]),
    async (kind) => {
      const frame = await asyncFrame()
      act(() => frame.editor.commands.insertContent("a"))
      const old = frame.snapshots[0]
      const changed: LiveFrameInput = {
        ...old,
        ...(kind === "epoch" ? { contentEpoch: 1 } : {}),
        ...(kind === "catalog" ? { catalogRevision: "changed" } : {}),
        slices:
          kind === "removed"
            ? []
            : old.slices.map((slice) => ({
                ...slice,
                ...(kind === "presentation"
                  ? { presentationIdV1: "centered" }
                  : {}),
                ...(kind === "disabled" ? { enabled: false } : {}),
              })),
      }
      await frame.echo(changed)
      await frame.deliver(-1)
      expect(frame.view.onConflict).toHaveBeenCalled()
      // The host may unmount when its owning slice is removed/disabled.
      if (kind !== "removed" && kind !== "disabled") {
        act(() => frame.editor.commands.insertContent(" refused"))
        expect(frame.accepted).toHaveBeenCalledTimes(1)
      }
    }
  )

  it("NEW cannot reuse an earlier activation's receipt after discard and re-entry", sliceProfile(["hero-agency"]), async () => {
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
  it("NEW accepts DOM typing through the frame controller before the parent echoes its draft", sliceProfile(["hero-with-image"]), async () => {
    const catalog = await readSlicePresentationCatalog()
    const sample = createSampleSlice("hero-with-image")
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
      slices: view.baseProps.slices,
      contentEpoch: 0,
      catalogRevision: catalog.revision,
      selectedSliceId: null,
      inlineEditingEnabled: true,
      mode: "light",
    }
    const accepted = vi.fn((commit: PreviewInlineEditCommit) => {
      const slices = applyPageField(
        parent.slices,
        "en",
        commit,
        0,
        catalog.revision
      )
      if (!slices) return false
      // A separate parent React root owns this draft; no synchronous child echo.
      parent = { ...parent, slices }
      return true
    })
    const controller = createLiveFrameController(parent, {
      selectSlice: vi.fn(),
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
    expect(parent.slices[0].primary).toMatchObject({ title: exact })
    expect(view.baseProps.slices[0].primary).toMatchObject({
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
    view.baseProps.slices = parent.slices
    expect(controller.replaceInput(parent)).toBe(true)
    view.rerender(<PageLivePreview {...view.baseProps} />)
    expect(view.getByRole("textbox")).toBe(host)
    expect(view.onConflict).not.toHaveBeenCalled()
    fireEvent.keyDown(host, { key: "Escape" })
    expect(view.queryByRole("textbox")).toBeNull()
    expect(parent.slices[0].primary).toMatchObject({
      title: titleDoc("Repeated headline [native Escape] again"),
    })
  })

  it.each(["same-field", "epoch", "presentation", "catalog"] as const)(
    "NEW still refuses a changed %s parent input after locally accepted typing", sliceProfile(["hero-agency"]),
    async (kind) => {
      const catalog = await readSlicePresentationCatalog()
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
            view.baseProps.slices,
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
        view.baseProps.slices = view.baseProps.slices.map((slice) => ({
          ...slice,
          primary: { ...slice.primary, title: titleDoc("external") },
        })) as Slice[]
      if (kind === "epoch") view.baseProps.contentEpoch = 1
      if (kind === "presentation")
        view.baseProps.slices = view.baseProps.slices.map((slice) => ({
          ...slice,
          presentationIdV1: "centered",
        }))
      if (kind === "catalog")
        view.baseProps.renderContext = {
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          presentationCatalog: { ...catalog, revision: "changed" },
        }
      const before = JSON.stringify(view.baseProps.slices)
      view.rerender(<PageLivePreview {...view.baseProps} />)
      expect(view.onConflict).toHaveBeenCalled()
      expect(view.getByRole("textbox")).toBe(host)
      expect(view.handle()?.capture()?.value).toBe(
        JSON.stringify(editor.getJSON())
      )
      act(() => editor.commands.insertContent(" rejected"))
      expect(JSON.stringify(view.baseProps.slices)).toBe(before)
      expect(view.onCommit).toHaveBeenCalledTimes(1)
    }
  )

  it("NEW explicit conflict Discard clears only the transient island and cannot revive rejected text", sliceProfile([]), async () => {
    const view = setup()
    let pending: PreviewInlineEditCommit | null = null
    const currentPending = (): PreviewInlineEditCommit | null => pending
    view.onChange.mockImplementation((commit) => {
      pending = commit
    })
    const { editor } = await begin(view)
    act(() => editor.commands.insertContent(" accepted"))
    view.baseProps.slices = view.baseProps.slices.map((slice) => {
      if (slice.type !== "hero-agency") throw new Error("Expected hero fixture")
      return {
        ...slice,
        primary: {
          ...slice.primary,
          title: titleDoc("external"),
          eyebrow: "manual retained",
        },
      }
    })
    view.rerender(<PageLivePreview {...view.baseProps} />)
    expect(view.onConflict).toHaveBeenCalled()
    expect(currentPending()?.value).toContain("accepted")
    const canonical = JSON.stringify(view.baseProps.slices)
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
    expect(JSON.stringify(view.baseProps.slices)).toBe(canonical)
    const fresh = await begin(view)
    expect(fresh.editor.getText()).toBe("external")
    expect(JSON.stringify(view.baseProps.slices)).toBe(canonical)
  })

  it("NEW Enter/Shift+Enter in a title insert nothing and composing Escape refuses cancellation", sliceProfile([]), async () => {
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
    expect(JSON.stringify(view.baseProps.slices)).not.toContain("hardBreak")
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
    it.each([profileRow])("basic body activation retains public typography for $name", sliceProfile([profileRow.type]),
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
        const slice = createSampleSlice(type)
        if (slice.type === "features-icon-grid") {
          slice.primary.heading = titleDoc("Features heading")
          slice.primary.body = body
          slice.items = [
            { ...slice.items[0], title: titleDoc("Feature title"), body },
          ]
        } else if (slice.type === "hero-with-image") {
          slice.primary.title = titleDoc("Hero heading")
          slice.primary.description = body
          slice.presentationIdV1 =
            name === "HeroWithImage centered" ? "centered" : "default"
        } else if (slice.type === "hero-agency") {
          slice.primary.title = titleDoc("Agency heading")
          slice.primary.description = body
        }
        const catalog = await readSlicePresentationCatalog()
        const view = setup([slice], {
          renderContext: {
            locale: "en",
            defaultLocale: "en",
            pagePaths: {},
            presentationCatalog: catalog,
          },
          renderPage: (slices, context) => (
            <DefaultSliceBodyContent
              content={{ title: "Preview" } as SliceBodyRendererProps["content"]}
              slices={slices}
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
  it("registered basic body activates an island and saves Enter paragraphs with marks and links", sliceProfile([]), async () => {
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
      (view.baseProps.slices[0].primary as { description: string }).description
    ).toContain("Second")
    expect(
      JSON.parse(
        (view.baseProps.slices[0].primary as { description: string })
          .description
      ).content
    ).toHaveLength(2)
    expect(view.getByRole("textbox")).toBe(host)
  })
  it("NEW delivers consecutive exact values into the parent without persistence calls or replacing the island", sliceProfile([]), async () => {
    const view = setup()
    const heading = view.container.querySelector("h1")!
    const headingId = heading.id
    const marker = heading
    const occurrence = heading.closest<HTMLElement>(
      "[data-preview-slice-occurrence]"
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
      (view.baseProps.slices[0].primary as Record<string, unknown>).title
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
  it("NEW Escape keeps typed/saved parent content and cannot revert a successful Save", sliceProfile([]), async () => {
    const view = setup()
    const { host, editor } = await begin(view)
    act(() => editor.commands.insertContent(" saved"))
    const saved = JSON.stringify(view.baseProps.slices)
    fireEvent.keyDown(host, { key: "Escape" })
    expect(view.queryByRole("textbox")).toBeNull()
    expect(JSON.stringify(view.baseProps.slices)).toBe(saved)
    expect(view.container.querySelector("h1[id]")?.textContent).toBe(
      "First saved"
    )
  })
  it("NEW fresh activation after reload/reset uses the current parent draft and is clean until input", sliceProfile([]), async () => {
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
    "NEW B-C0 iframe replacement seeds exact parent PM including marks, links, hard breaks and %s", sliceProfile([]),
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
      const parent = view.baseProps.slices
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
  it("NEW B-C1 ignores renderer stamps through A/B/A and never replaces parent text", sliceProfile([]), async () => {
    const view = setup()
    const { editor, host } = await begin(view)
    act(() => editor.commands.insertContent(" retained"))
    const exact = (view.baseProps.slices[0].primary as Record<string, unknown>)
      .title
    for (const revision of ["b", "", "a"]) {
      view.container
        .querySelector("h1")
        ?.setAttribute("data-preview-revision", revision)
      view.rerender(<PageLivePreview {...view.baseProps} title={revision} />)
      expect(view.getByRole("textbox")).toBe(host)
      expect(
        (view.baseProps.slices[0].primary as Record<string, unknown>).title
      ).toBe(exact)
    }
    expect(view.onConflict).not.toHaveBeenCalled()
  })
  it("NEW unrelated same-slice sidebar edits remain compatible", sliceProfile([]), async () => {
    const view = setup()
    const { editor } = await begin(view)
    view.baseProps.slices = view.baseProps.slices.map(
      (slice) =>
        ({
          ...slice,
          primary: { ...slice.primary, eyebrow: "manual sidebar" },
        }) as Slice
    )
    view.rerender(<PageLivePreview {...view.baseProps} />)
    act(() => editor.commands.insertContent(" inline"))
    expect(
      (view.baseProps.slices[0].primary as Record<string, unknown>).eyebrow
    ).toBe("manual sidebar")
    expect(view.onConflict).not.toHaveBeenCalled()
  })
  it("NEW same-field external edits during composition keep the DOM and exact conflict text after refusal", sliceProfile([]), async () => {
    const view = setup()
    const { editor, host } = await begin(view)
    fireEvent.compositionStart(host)
    expect(view.handle()?.isComposing()).toBe(true)
    act(() => editor.commands.insertContent(" composing"))
    view.baseProps.slices = view.baseProps.slices.map(
      (slice) =>
        ({
          ...slice,
          primary: { ...slice.primary, title: titleDoc("external apply") },
        }) as Slice
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
      (view.baseProps.slices[0].primary as Record<string, unknown>).title
    ).toBe(titleDoc("external apply"))
  })
  it.each(["locale", "epoch", "removed"])(
    "NEW drops a stale %s write without retargeting", sliceProfile([]),
    async (kind) => {
      const view = setup()
      const { editor } = await begin(view)
      if (kind === "locale") view.baseProps.locale = "fr"
      if (kind === "epoch") view.baseProps.contentEpoch = 1
      if (kind === "removed") view.baseProps.slices = []
      if (kind === "presentation")
        view.baseProps.slices = view.baseProps.slices.map((slice) => ({
          ...slice,
          presentationIdV1: "centered",
        }))
      if (kind === "catalog")
        view.baseProps.renderContext = {
          locale: "en",
          defaultLocale: "en",
          pagePaths: {},
          presentationCatalog: { revision: "different", entries: [] } as never,
        }
      const before = JSON.stringify(view.baseProps.slices)
      view.rerender(<PageLivePreview {...view.baseProps} />)
      if (kind !== "removed") act(() => editor.commands.insertContent(" stale"))
      expect(JSON.stringify(view.baseProps.slices)).toBe(before)
      expect(view.onConflict).toHaveBeenCalled()
    }
  )
  it("NEW blocks a public link and routes unsupported fields to the sidebar", sliceProfile([]), () => {
    const view = setup(undefined, {
      renderPage: (slices, context) =>
        context.previewSlice?.(slices[0], () => (
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
  it("NEW starts inline editing from the whole h1 using its unique stamped inline span", sliceProfile([]), async () => {
    const view = setup()
    enableEditing(view)
    fireEvent.click(view.container.querySelector("h1[id]")!)
    expect(await view.findByRole("textbox")).toHaveTextContent("First")
    expect(view.handle()?.hasActiveSession()).toBe(true)
  })

  it("NEW refuses ambiguous duplicate stamped descendants in a heading", sliceProfile([]), () => {
    const view = setup(undefined, {
      renderPage: (slices, context) =>
        slices.map((slice) =>
          context.previewSlice?.(slice, (ctx) => (
            <h2 key={slice.id} data-testid="ambiguous-heading">
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
  it("keeps root items rich text activatable and writable", sliceProfile([]), async () => {
    const slice = createSampleSlice("features-icon-grid")
    if (slice.type !== "features-icon-grid")
      throw new Error("Expected the repeated-feature fixture")
    const view = setup([slice], {
      controlledInlineEnabled: true,
      renderPage: (slices, context) =>
        slices.map((current) => {
          if (current.type !== "features-icon-grid")
            throw new Error("Expected the repeated-feature renderer")
          return context.previewSlice?.(current, (ctx) => (
            <FeaturesIconGrid
              slice={current satisfies FeaturesIconGridSlice}
              ctx={ctx}
            />
          ))
        }),
    })
    const { editor } = await begin(view, "items.0.title")
    expect(view.baseProps.onSelectField).toHaveBeenCalledWith(
      { sliceId: slice.id, fieldPath: "items.0.title", inlineEditing: true },
      { status: "activated" }
    )
    act(() => editor.commands.insertContent(" updated"))
    const updated = view.baseProps.slices[0]
    if (updated.type !== "features-icon-grid")
      throw new Error("Expected the repeated-feature edit to remain in place")
    expect(JSON.parse(updated.items[0].title).content[0]).toEqual({
      type: "heading",
      attrs: { level: 3 },
      content: editor.getJSON().content?.[0]?.content,
    })
  })

  it("refuses activation for a rendered slice missing from current parent state", sliceProfile([]), () => {
    const ghost = hero("unresolved-preview-slice", "Ghost")
    const view = setup([hero("canonical-slice", "Canonical")], {
      controlledInlineEnabled: true,
      renderSlicesTransform: () => [ghost],
      renderPage: (slices, context) =>
        slices.map((slice) =>
          context.previewSlice?.(slice, (ctx) => (
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
      { sliceId: ghost.id, fieldPath: "primary.title" },
      { status: "refused", reason: "capture" }
    )
    expect(view.onCommit).not.toHaveBeenCalled()
  })

  it("refuses primary-list rich text and selects its exact form field", sliceProfile([]), () => {
    const originalDef = sliceDefs["hero-with-image"]
    const syntheticPrimary = group({
      title: richText({ profile: "inline" }),
      features: list(group({ title: richText({ profile: "inline" }) })),
    })
    const slice = createSampleSlice("hero-with-image")
    Reflect.set(slice.primary, "features", [{ title: titleDoc("List title") }])
    Reflect.set(sliceDefs, "hero-with-image", {
      ...originalDef,
      primary: syntheticPrimary,
    })
    const before = JSON.stringify([slice])
    let view: ReturnType<typeof setup> | undefined
    try {
      view = setup([slice], {
        selectedSliceId: slice.id,
        controlledInlineEnabled: true,
        renderPage: (slices, context) =>
          slices.map((current) =>
            context.previewSlice?.(current, (ctx) => (
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
        { sliceId: slice.id, fieldPath: "primary.features.0.title" },
        { status: "refused", reason: "unsupported" }
      )
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(JSON.stringify([slice])).toBe(before)
    } finally {
      view?.unmount()
      Reflect.set(sliceDefs, "hero-with-image", originalDef)
    }
  })

  it("scrolls a selected preview slice without forcing smooth motion", sliceProfile([]), async () => {
    const migrated = createSampleSlice("hero-with-image") as HeroWithImageSlice
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
        selectedSliceId: migrated.id,
        renderPage: (slices, context) =>
          slices.map((slice) =>
            context.previewSlice?.(slice, (ctx) => (
              <HeroWithImage slice={slice as HeroWithImageSlice} ctx={ctx} />
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

  it("keeps an off-toggle rich-text double-click on its exact field without activating editing", sliceProfile([]), async () => {
    const migrated = createSampleSlice("hero-with-image") as HeroWithImageSlice
    const selectSliceFallback = vi.fn()
    const view = setup([migrated], {
      onSelectSliceFallback: selectSliceFallback,
    })
    const heading = view.container.querySelector(
      'h1[data-preview-field="primary.title"]'
    )!
    fireEvent.click(heading)
    fireEvent.doubleClick(heading)

    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith({
      sliceId: migrated.id,
      fieldPath: "primary.title",
    })
    expect(view.queryByRole("textbox")).toBeNull()
    expect(selectSliceFallback).not.toHaveBeenCalled()
  })

  it.each(["primary.eyebrow", "primary.image"])(
    "keeps off-toggle double-click focus exact for %s instead of selecting the slice fallback", sliceProfile([]),
    (fieldPath) => {
      const migrated = createSampleSlice(
        "hero-with-image"
      ) as HeroWithImageSlice
      const selectSliceFallback = vi.fn()
      const view = setup([migrated], {
        onSelectSliceFallback: selectSliceFallback,
      })
      const field = view.container.querySelector(
        `[data-preview-field="${fieldPath}"]`
      )!
      fireEvent.doubleClick(field)

      expect(view.baseProps.onSelectField).toHaveBeenCalledWith(
        { sliceId: migrated.id, fieldPath },
        { status: "refused", reason: "unsupported" }
      )
      expect(selectSliceFallback).not.toHaveBeenCalled()
    }
  )

  it("does not text-guess from an unmarked gap inside the migrated Hero occurrence", sliceProfile([]), () => {
    const migrated = createSampleSlice("hero-with-image") as HeroWithImageSlice
    const selectSliceFallback = vi.fn()
    const view = setup([migrated], {
      onSelectSliceFallback: selectSliceFallback,
      renderPage: (slices, context) =>
        slices.map((slice) =>
          context.previewSlice?.(slice, (ctx) => (
            <>
              <HeroWithImage slice={slice as HeroWithImageSlice} ctx={ctx} />
              <div data-testid="migrated-gap">{migrated.primary.title}</div>
            </>
          ))
        ),
    })

    fireEvent.click(view.getByTestId("migrated-gap"))

    expect(view.baseProps.onSelectField).not.toHaveBeenCalled()
    expect(view.baseProps.onSelectSlice).not.toHaveBeenCalled()
    expect(selectSliceFallback).toHaveBeenCalledExactlyOnceWith(migrated.id)
  })

  it("uses a unique legacy image match but refuses ambiguous image matches", sliceProfile([]), () => {
    const slice = createSampleSlice("hero-with-image") as HeroWithImageSlice
    const unique = setup([slice], {
      renderPage: (slices, context) =>
        slices.map((item) =>
          context.previewSlice?.(item, () => (
            <section>
              {/* eslint-disable-next-line @next/next/no-img-element -- Native fixture tests legacy image matching. */}
              <img
                data-testid="legacy-image"
                src={slice.primary.image.url}
                alt={slice.primary.image.alt ?? ""}
              />
            </section>
          ))
        ),
    })
    fireEvent.click(unique.getByTestId("legacy-image"))
    expect(unique.baseProps.onSelectField).toHaveBeenCalledWith(
      {
        sliceId: slice.id,
        fieldPath: "primary.image",
      },
      { status: "refused", reason: "unsupported" }
    )

    const ambiguousSlice = structuredClone(slice)
    ambiguousSlice.items[0].icon = { ...ambiguousSlice.primary.image }
    const duplicate = setup([ambiguousSlice], {
      renderPage: (slices, context) =>
        slices.map((item) =>
          context.previewSlice?.(item, () => (
            <section>
              {/* eslint-disable-next-line @next/next/no-img-element -- Native fixture tests legacy image matching. */}
              <img
                data-testid="ambiguous-image-a"
                src={ambiguousSlice.primary.image.url}
                alt={ambiguousSlice.primary.image.alt ?? ""}
              />
              {/* eslint-disable-next-line @next/next/no-img-element -- Native fixture tests legacy image matching. */}
              <img
                data-testid="ambiguous-image-b"
                src={ambiguousSlice.items[0].icon?.url ?? ""}
                alt={ambiguousSlice.items[0].icon?.alt ?? ""}
              />
            </section>
          ))
        ),
    })
    fireEvent.click(duplicate.getByTestId("ambiguous-image-a"))
    expect(duplicate.baseProps.onSelectField).not.toHaveBeenCalled()
    expect(duplicate.baseProps.onSelectSlice).toHaveBeenCalledWith(
      ambiguousSlice.id
    )
  })

  it("keeps exactly one marker on the active Hero h1 while the editor replaces its children", sliceProfile([]), async () => {
    const migrated = createSampleSlice("hero-with-image") as HeroWithImageSlice
    const view = setup([migrated], {
      renderPage: (slices, context) => (
        <DefaultSliceBodyContent
          content={{ title: "Preview" } as never}
          slices={slices}
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

  it("keeps a unique legacy Hero text guess but refuses ambiguous copy", sliceProfile([]), () => {
    const unique = setup(undefined, {
      renderPage: (slices, context) =>
        slices.map((slice) =>
          context.previewSlice?.(slice, () => (
            <section>
              <div data-testid="legacy-title">First</div>
            </section>
          ))
        ),
    })
    fireEvent.click(unique.getByTestId("legacy-title"))
    expect(unique.baseProps.onSelectField).toHaveBeenCalledWith({
      sliceId: "hero-1",
      fieldPath: "primary.title",
    })

    const duplicate = hero("hero-ambiguous", "First")
    if (duplicate.type !== "hero-agency")
      throw new Error("Ambiguous legacy Hero fixture must use Hero Agency")
    duplicate.primary.description = pm("First")
    const ambiguous = setup([duplicate], {
      renderPage: (slices, context) =>
        slices.map((slice) =>
          context.previewSlice?.(slice, () => (
            <section>
              <div data-testid="ambiguous-copy">First</div>
            </section>
          ))
        ),
    })
    fireEvent.click(ambiguous.getByTestId("ambiguous-copy"))
    expect(ambiguous.baseProps.onSelectField).not.toHaveBeenCalled()
    expect(ambiguous.baseProps.onSelectSlice).toHaveBeenCalledWith(
      "hero-ambiguous"
    )
  })
})

describe("Caret placement NEW coordinate consumer contract", () => {
  function expectSoleTitleHeadingMarker(heading: HTMLElement) {
    const occurrence = heading.closest<HTMLElement>(
      "[data-preview-slice-occurrence]"
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
    const catalog = await readSlicePresentationCatalog()
    const slices = ["caret-first", "caret-second"].map((id) => {
      const sample = createSampleSlice("hero-with-image")
      return {
        ...sample,
        id,
        enabled: true,
        presentationIdV1: "centered",
        primary: { ...sample.primary, title: titleDoc("Repeated headline") },
      }
    })
    const view = setup(slices, {
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
    "NEW maps a $point click in frame viewport coordinates to the mounted text offset", sliceProfile(["hero-with-image"]),
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
        expect(mapping.caret).toHaveBeenCalledExactlyOnceWith(clientX, clientY)
        expect(mapping.element).toHaveBeenCalledExactlyOnceWith(
          clientX,
          clientY
        )
        expect(view.baseProps.onSelectField).toHaveBeenCalledExactlyOnceWith(
          {
            sliceId: "caret-first",
            fieldPath: "primary.title",
            inlineEditing: true,
          },
          { status: "activated" }
        )
        expect(view.handle()?.capture()).toMatchObject({
          sliceId: "caret-first",
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
            sliceId: "caret-first",
            value: titleDoc(expected),
          })
        )
        expect(view.baseProps.slices[1].primary).toMatchObject({
          title: titleDoc("Repeated headline"),
        })
        view.baseProps.title = "Fresh parent title"
        view.rerender(<PageLivePreview {...view.baseProps} />)
        expect(view.getByRole("textbox")).toBe(host)
        expect(editor.state.selection.from).toBe(offset + 2)
        expect(mapping.caret).toHaveBeenCalledTimes(1)
        expect(view.onConflict).not.toHaveBeenCalled()
        fireEvent.keyDown(host, { key: "Escape" })
        expect(view.queryByRole("textbox")).toBeNull()
        expect(view.baseProps.slices[0].primary).toMatchObject({
          title: titleDoc(expected),
        })
      } finally {
        mapping.restore()
      }
    }
  )

  it("NEW falls back to the end when a pointing click cannot map into the mounted editor", sliceProfile(["hero-with-image"]), async () => {
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
      expect(mapping.caret).toHaveBeenCalledExactlyOnceWith(460, 180)
      expect(editor.state.selection.from).toBe(18)
      expect(editor.state.selection.to).toBe(18)
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(view.onConflict).not.toHaveBeenCalled()
    } finally {
      mapping.restore()
    }
  })

  it("NEW keeps zero-detail keyboard-style activation at the end without coordinate mapping", sliceProfile(["hero-with-image"]), async () => {
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
    const catalog = await readSlicePresentationCatalog()
    const slices = ["first-centered", "second-centered"].map((id) => {
      const sample = createSampleSlice("hero-with-image")
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
    const view = setup(slices, {
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
      "[data-preview-slice-occurrence]"
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
        sliceId: "second-centered",
        fieldPath: "primary.title",
        inlineEditing: true,
      },
      { status: "activated" }
    )
    expect(view.baseProps.onSelectSlice).not.toHaveBeenCalled()
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
      sliceId: "second-centered",
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
        sliceId: "second-centered",
        fieldPath: "primary.title",
        value: exact,
      })
    )
    expect(view.onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ sliceId: "second-centered", value: exact })
    )
    expect(view.baseProps.slices[0].primary).toMatchObject({
      title: titleDoc("Repeated headline"),
    })
    expect(view.baseProps.slices[1].primary).toMatchObject({ title: exact })
    expect(view.onConflict).not.toHaveBeenCalled()
  }

  it("NEW dispatches an outer centered H2 through field admission and the exact sibling's parent draft", sliceProfile(["hero-with-image"]), async () => {
    await activateSecond("outer H2")
  })

  it("NEW dispatches the coordinate-bearing word-space span through field admission and its parent draft", sliceProfile(["hero-with-image"]), async () => {
    await activateSecond("word-space span")
  })

  it("NEW keeps a disabled centered outer H2 form-only without an inline session or draft write", sliceProfile(["hero-with-image"]), async () => {
    const { view } = await centeredSiblings()
    fireEvent.click(view.container.querySelector("#second-centered-heading")!, {
      clientX: 652,
      clientY: 270,
    })
    expect(view.baseProps.onSelectField).toHaveBeenCalledExactlyOnceWith({
      sliceId: "second-centered",
      fieldPath: "primary.title",
    })
    expect(view.handle()?.hasActiveSession()).toBe(false)
    expect(view.queryByRole("textbox")).toBeNull()
    expect(view.onCommit).not.toHaveBeenCalled()
    expect(view.onChange).not.toHaveBeenCalled()
  })

  it.each(["development", "production"] as const)(
    "NEW reports activation only in development while %s keeps the same consumer outcome", sliceProfile(["hero-with-image"]),
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
            "slice identity does not resolve to exactly one slice"
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
  it("routes a composed-field begin refusal back to its exact form target", sliceProfile([]), async () => {
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
      { sliceId: "hero-1", fieldPath: "primary.description" },
      { status: "refused", reason: "begin" }
    )
    expect(view.handle()?.capture()?.fieldPath).toBe("primary.title")
  })

  it("reports a refused capture for a field whose rendered occurrence is ambiguous", sliceProfile([]), () => {
    const duplicate = hero("duplicate", "Repeated")
    const view = setup([duplicate, { ...duplicate }])
    enableEditing(view)
    const occurrences = view.container.querySelectorAll(
      "[data-preview-slice-occurrence]"
    )
    const field = occurrences[1].querySelector<HTMLElement>(
      '[data-preview-field="primary.title"]'
    )!

    fireEvent.click(field)

    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      {
        sliceId: "__formulacms-legacy-slice-2",
        fieldPath: "primary.title",
      },
      { status: "refused", reason: "capture" }
    )
    expect(view.handle()?.hasActiveSession()).toBe(false)
  })

  it("lets an untouched session yield to a same-field change outside the preview", sliceProfile([]), async () => {
    const view = setup()
    enableEditing(view)
    fireEvent.click(
      view.container.querySelector('[data-preview-field="primary.title"]')!
    )
    await view.findByRole("textbox")
    view.baseProps.slices = [hero("hero-1", "Changed elsewhere")]
    view.rerender(<PageLivePreview {...view.baseProps} />)

    expect(view.onConflict).not.toHaveBeenCalled()
    expect(view.handle()?.hasActiveSession()).toBe(false)
    expect(
      view.container.querySelector('[data-preview-field="primary.title"]')
        ?.textContent
    ).toBe("Changed elsewhere")
  })

  it("reports a stale refusal after a typed field changes outside the preview", sliceProfile([]), async () => {
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
    view.baseProps.slices = [hero("hero-1", "Changed elsewhere")]
    view.rerender(<PageLivePreview {...view.baseProps} />)

    fireEvent.click(
      view.container.querySelector(
        '[data-preview-field="primary.description"]'
      )!
    )

    expect(view.onConflict).toHaveBeenCalled()
    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      { sliceId: "hero-1", fieldPath: "primary.description" },
      { status: "refused", reason: "stale" }
    )
    expect(view.handle()?.capture()?.fieldPath).toBe("primary.title")
  })

  it("returns a localized fallback result when an enabled field has no inline marker", sliceProfile([]), () => {
    const view = setup()
    enableEditing(view)
    const field = view.container.querySelector<HTMLElement>(
      '[data-preview-field="primary.title"]'
    )!
    field.dataset.previewInlineContract = "basic"

    fireEvent.click(field)

    expect(view.baseProps.onSelectField).toHaveBeenLastCalledWith(
      { sliceId: "hero-1", fieldPath: "primary.title" },
      { status: "refused", reason: "unsupported" }
    )
    expect(view.handle()?.hasActiveSession()).toBe(false)
  })
})

describe("Unit A amendment3 NEW heading guards", () => {
  function guardedView(kind: "link" | "button" | "distinct" | "div" | "h3") {
    return setup(undefined, {
      renderPage: (slices, context) =>
        slices.map((slice) =>
          context.previewSlice?.(slice, (ctx) => {
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
    "NEW A-R1 refuses an unbound nested %s without retargeting title", sliceProfile([]),
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
    const original = sliceDefs["hero-agency"]
    const primary = group({
      ...(original.primary.config.fields as Record<string, Primitive>),
      title: richText({ profile: "inline" }),
      description: richText({ profile: "inline" }),
    })
    Reflect.set(sliceDefs, "hero-agency", { ...original, primary })
    try {
      await run()
    } finally {
      Reflect.set(sliceDefs, "hero-agency", original)
    }
  }

  it("NEW A-R1 refuses a whole H2 with distinct stamped fields without choosing either field", sliceProfile([]), async () =>
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
    "NEW A-R1 keeps %s ancestor matching form-only", sliceProfile([]),
    (kind) => {
      const view = guardedView(kind)
      enableEditing(view)
      fireEvent.click(view.getByTestId("fallback-container"))
      expect(view.handle()?.hasActiveSession()).toBe(false)
      expect(view.queryByRole("textbox")).toBeNull()
      expect(view.baseProps.onSelectField).toHaveBeenCalledWith(
        {
          sliceId: "hero-1",
          fieldPath: "primary.title",
        },
        { status: "refused", reason: "unsupported" }
      )
      expect(view.onCommit).not.toHaveBeenCalled()
    }
  )

  it("NEW A-R1 keeps a precise stamped span editable inside a multi-field heading", sliceProfile([]), async () =>
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
          sliceId: "hero-1",
          fieldPath: "primary.description",
          inlineEditing: true,
        },
        { status: "activated" }
      )
      expect(view.onCommit).not.toHaveBeenCalled()
      view.unmount()
    }))

  it("refuses a basic body forged as an inline stamp inside a heading", sliceProfile([]), () => {
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
      { sliceId: "hero-1", fieldPath: "primary.description" },
      { status: "refused", reason: "unsupported" }
    )
    expect(view.onCommit).not.toHaveBeenCalled()
  })
})

// RF3 promotes only the opening occurrence, while form-only containers stay guarded.
describe("RF3 heading activation", () => {
  it.each([1, 2, 3, 4, 5, 6])(
    "activates a unique stamped inline span from H%s", sliceProfile([]),
    async (level) => {
      const view = setup(undefined, {
        renderPage: (slices, context) =>
          context.previewSlice?.(slices[0], (ctx) =>
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
    "%s matches public ownership after an earlier section", sliceProfile(["faq-simple","hero-with-image"]),
    async (locale) => {
      const catalog = await readSlicePresentationCatalog()
      for (const presentationId of ["default", "centered"]) {
        const section = createSampleSlice("faq-simple")
        const sample = createSampleSlice("hero-with-image")
        const makeHero = (id: string, title: string) => ({
          ...sample,
          id,
          presentationIdV1: presentationId,
          primary: { ...sample.primary, title: titleDoc(title) },
        })
        const title = locale === "fr" ? "Titre localisé" : "Localized title"
        const slices = [
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
        const view = setup(slices, { locale, renderContext })
        const publicContainer = document.createElement("div")
        publicContainer.innerHTML = renderToStaticMarkup(
          <DefaultSliceBodyContent
            content={
              { title: "Preview", slices } as SliceBodyRendererProps["content"]
            }
            slices={slices}
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

function ed10Description(slices: Slice[]) {
  const primary = slices[0].primary
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
    sliceProfile([]),
    async (enabled) => {
      const fallback = vi.fn()
      const view = setup(undefined, {
        controlledInlineEnabled: enabled,
        onSelectSliceFallback: fallback,
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
    sliceProfile([]),
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
    sliceProfile([]),
    async (description) => {
      const base = hero("hero-1", "First")
      const slice = {
        ...base,
        primary: { ...base.primary, description },
      } as Slice
      const view = setup([slice])
      const { editor } = await begin(view, "primary.description")
      act(() => editor.commands.insertContent("island "))
      // Simulate a final document mutation not yet delivered by onUpdate.
      act(() =>
        editor.view.dispatch(
          editor.state.tr.insertText("last ").setMeta("preventUpdate", true)
        )
      )
      const finalValue = JSON.stringify(editor.getJSON())
      expect(JSON.stringify(view.baseProps.slices)).not.toContain("last ")
      view.baseProps.controlledInlineEnabled = false
      await act(async () =>
        view.rerender(<PageLivePreview {...view.baseProps} />)
      )
      expect(view.handle()?.hasActiveSession()).toBe(false)
      expect(view.queryByRole("textbox")).toBeNull()
      expect(ed10Description(view.baseProps.slices)).toBe(finalValue)
      expect(view.onConflict).not.toHaveBeenCalled()
      expect(view.onChange).toHaveBeenLastCalledWith(null)
    }
  )

  it(
    "ED10 toggle-off waits for composition then flushes and leaves",
    sliceProfile([]),
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
      expect(ed10Description(view.baseProps.slices)).toBe(value)
      expect(view.onConflict).not.toHaveBeenCalled()
    }
  )

  it.each([pm("Copy"), ed10OwnerDescription])(
    "ED10 untouched toggle-off keeps the original bytes (%#)",
    sliceProfile([]),
    async (description) => {
      const base = hero("hero-1", "First")
      const view = setup([
        { ...base, primary: { ...base.primary, description } } as Slice,
      ])
      await begin(view, "primary.description")
      view.baseProps.controlledInlineEnabled = false
      await act(async () =>
        view.rerender(<PageLivePreview {...view.baseProps} />)
      )
      expect(ed10Description(view.baseProps.slices)).toBe(description)
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(view.handle()?.hasActiveSession()).toBe(false)
    }
  )

  it(
    "ED10 a locale switch refuses a deferred old-locale flush",
    sliceProfile([]),
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
      view.baseProps.slices = [
        {
          ...next,
          primary: { ...next.primary, description: pm("French draft") },
        } as Slice,
      ]
      view.rerender(<PageLivePreview {...view.baseProps} />)
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
      })
      expect(ed10Description(view.baseProps.slices)).toBe(pm("French draft"))
      expect(view.onCommit).not.toHaveBeenCalled()
      expect(view.onConflict).toHaveBeenCalled()
      expect(view.handle()?.capture()?.value).toBe(pending)
    }
  )

  it(
    "ED10 frame teardown cancels a deferred session end",
    sliceProfile([]),
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
    sliceProfile([]),
    async () => {
      const view = setup()
      const { host } = await begin(view, "primary.description")
      fireEvent.blur(host, { relatedTarget: null })
      view.baseProps.slices = view.baseProps.slices.map(
        (slice) =>
          ({
            ...slice,
            primary: { ...slice.primary, description: pm("Copy /") },
          }) as Slice
      )
      view.rerender(<PageLivePreview {...view.baseProps} />)
      expect(view.onConflict).not.toHaveBeenCalled()
      expect(view.handle()?.hasActiveSession()).toBe(false)
    }
  )

  it(
    "ED10 touched sidebar focus adopts the flushed island before immediate typing",
    sliceProfile([]),
    async () => {
      const frameBody = document.createElement("div")
      document.body.append(frameBody)
      let active: PreviewActiveEditHandle | null = null
      let draft: Slice[] = [hero("hero-1", "First")]
      const conflict = vi.fn()
      const changes = vi.fn()
      function Parent() {
        const [slices, setSlices] = React.useState(draft)
        function replace(next: Slice[]) {
          draft = next
          setSlices(next)
        }
        return (
          <ConfirmProvider>
            <section data-preview-sidebar>
              <RichTextEditor
                label="Sidebar Description"
                profile="basic"
                value={String(ed10Description(slices))}
                onChange={(value) => {
                  replace(
                    slices.map((slice) => ({
                      ...slice,
                      primary: { ...slice.primary, description: value },
                    })) as Slice[]
                  )
                }}
              />
            </section>
            {createPortal(
              <PageLivePreview
                title="Preview"
                slices={slices}
                locale="en"
                defaultLocale="en"
                selectedSliceId={null}
                onSelectSlice={() => {}}
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

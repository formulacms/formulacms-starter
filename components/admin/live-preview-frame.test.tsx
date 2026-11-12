vi.mock("@/lib/preview-build-id", () => ({ PREVIEW_BUILD_ID: "test-build" }))
import { sliceProfile } from "@/test-utils/slice-profile"
import { capturePageField } from "./page-editor/lib/page-inline-draft"
import { useEffect, useLayoutEffect } from "react"
import { act, fireEvent } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import type { PreviewActiveEditHandle } from "./visual-editing-types"
import { createSampleSlice } from "@/lib/slices/sample"
import {
  LivePreviewFrame,
  type PageLivePreviewProps,
} from "./live-preview-frame"
import { PageLivePreview } from "./page-live-preview"

// Loading the parent host must never evaluate the child renderer graph.
vi.mock("./page-live-preview-canvas", () => {
  throw new Error("Parent loaded Canvas")
})
vi.mock("@/components/slices/slice-zone", () => {
  throw new Error("Parent loaded slice renderers")
})

import {
  LIVE_FRAME_SOURCE,
  type LiveFrameBridge,
  type LiveFrameCallbacks,
  type LiveFrameWindow,
} from "./live-preview-frame-bridge"

class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
function setup(
  extra: Partial<PageLivePreviewProps> = {},
  locale: "en" | "fr" = "en"
) {
  vi.stubGlobal("ResizeObserver", ResizeObserverStub)
  let handle: PreviewActiveEditHandle | null = null
  const props: PageLivePreviewProps = {
    pageId: "page-id",
    pageType: "landing-page",
    languageVersion: 2,
    title: "Draft Page",
    slices: [],
    locale: "fr",
    defaultLocale: "en",
    selectedSliceId: null,
    onSelectSlice: vi.fn(),
    onSelectField: vi.fn(),
    onInlineEditCommit: vi.fn(),
    onOpenSavedPreview: vi.fn(),
    onSave: vi.fn(),
    onActiveEditConflict: vi.fn(),
    onActiveEditChange: vi.fn(),
    onActiveEditHandleChange: (value) => {
      handle = value
    },
    ...extra,
  }
  const view = render(<LivePreviewFrame {...props} />, { locale })
  return { ...view, props, handle: () => handle }
}
function handshake(
  view: ReturnType<typeof setup>,
  contextReady = true,
  generation = "frame-1"
) {
  const frame = view.getByTitle("Draft Page") as HTMLIFrameElement
  const child = frame.contentWindow as LiveFrameWindow
  const sessionId = new URL(frame.src).searchParams.get("session")!
  let callbacks: LiveFrameCallbacks | null = null
  const bridge: LiveFrameBridge = {
    sessionId,
    pageId: "page-id",
    locale: "fr",
    generation,
    buildId: "test-build",
    connect: vi.fn((_input, cb) => {
      callbacks = cb
      if (!contextReady) cb.context(false)
      return true
    }),
    replaceInput: vi.fn(() => true),
    disconnect: vi.fn(),
    capture: vi.fn(() => null),
    acceptCapture: vi.fn(),
    isComposing: () => false,
    hasActiveSession: () => false,
  }
  child.__formulacmsLiveFrame = bridge
  const event = () =>
    new MessageEvent("message", {
      origin: window.location.origin,
      source: child,
      data: {
        source: LIVE_FRAME_SOURCE,
        type: "ready",
        sessionId,
        pageId: "page-id",
        locale: "fr",
        generation,
        buildId: "test-build",
      },
    })
  act(() => {
    window.dispatchEvent(event())
    if (contextReady) callbacks?.context(true)
  })
  return { frame, child, bridge, callbacks: () => callbacks! }
}
const pendingValue = JSON.stringify({
  type: "doc",
  content: [
    { type: "paragraph", content: [{ type: "text", text: "Pending" }] },
  ],
})
function recoveryCommit(slice: ReturnType<typeof createSampleSlice>) {
  const frame = document.querySelector("iframe")!
  return {
    ...capturePageField([slice], "fr", slice.id, "primary.title", 0)!,
    value: pendingValue,
    frameBinding: {
      sessionId: new URL(frame.src).searchParams.get("session")!,
      pageId: "page-id",
      generation: "frame-1",
      buildId: "test-build",
      languageVersion: 2,
    },
  }
}
describe("Page iframe consumer", () => {
  it("NEW R1 parent stamps the rendered snapshot revision, independently of a newer synchronous authority read", () => {
    const view = setup({ draftRevision: 4, getDraftRevision: () => 9 })
    const { bridge } = handshake(view)
    const first = vi.mocked(bridge.connect).mock.calls[0][0]
    expect(first.ordering).toMatchObject({
      draftRevision: 4,
      generation: "frame-1",
    })
    expect(first.ordering!.inputRevision).toBeGreaterThan(0)
    view.rerender(
      <LivePreviewFrame
        {...view.props}
        title="Next authoritative render"
        draftRevision={10}
      />
    )
    const next = vi.mocked(bridge.replaceInput).mock.calls.at(-1)![0]
    expect(next.title).toBe("Next authoritative render")
    expect(next.ordering!.draftRevision).toBe(10)
    expect(next.ordering!.inputRevision).toBeGreaterThan(
      first.ordering!.inputRevision
    )
  })
  it("NEW pushes preview input only when the input changed (fix 2, rank 3a)", sliceProfile(["hero-agency"]), () => {
    const slices = [createSampleSlice("hero-agency")]
    const view = setup({ draftRevision: 4, getDraftRevision: () => 4, slices })
    const { bridge } = handshake(view)
    const pushes = () => vi.mocked(bridge.replaceInput).mock.calls.length
    const before = pushes()
    // Same props with fresh callback identities, as a parent render produces.
    for (let i = 0; i < 3; i++)
      view.rerender(
        <LivePreviewFrame
          {...view.props}
          slices={slices}
          onSelectSlice={vi.fn()}
          onSave={vi.fn()}
          onInlineEditCommit={vi.fn()}
        />
      )
    // A viewport/zoom change is not preview input either.
    fireEvent.click(view.getByRole("button", { name: "Mobile" }))
    expect(pushes()).toBe(before)

    const revisionOf = (index: number) =>
      vi.mocked(bridge.replaceInput).mock.calls[index][0].ordering!
        .inputRevision
    const lastRevision = before
      ? revisionOf(before - 1)
      : vi.mocked(bridge.connect).mock.calls[0][0].ordering!.inputRevision
    const changed = [{ ...slices[0] }]
    view.rerender(
      <LivePreviewFrame {...view.props} slices={changed} title="Changed" />
    )
    expect(pushes()).toBe(before + 1)
    expect(revisionOf(before)).toBeGreaterThan(lastRevision)
    // Selection is part of the input.
    view.rerender(
      <LivePreviewFrame
        {...view.props}
        slices={changed}
        title="Changed"
        selectedSliceId={changed[0].id}
      />
    )
    expect(pushes()).toBe(before + 2)
    expect(revisionOf(before + 1)).toBeGreaterThan(revisionOf(before))
    // Unchanged again: no further push.
    view.rerender(
      <LivePreviewFrame
        {...view.props}
        slices={changed}
        title="Changed"
        selectedSliceId={changed[0].id}
      />
    )
    expect(pushes()).toBe(before + 2)
  })
  it.each(["post", "author"])(
    "keeps unsupported %s type form-accessible without a fake page viewport",
    (pageType) => {
      const view = setup({ pageType })
      expect(view.container.querySelector("iframe")).toBeNull()
      expect(view.getByRole("status")).toHaveTextContent(
        "supports landing pages"
      )
      fireEvent.click(view.getByRole("button", { name: "Saved" }))
      expect(view.props.onOpenSavedPreview).toHaveBeenCalledOnce()
    }
  )
  it("gives a Page the same live frame a Landing page gets, bound to its own type", () => {
    const view = setup({ pageType: "page" })
    expect(view.container.querySelector("iframe")).not.toBeNull()
    expect(view.queryByText(/supports landing pages/)).toBeNull()
    const { bridge } = handshake(view)
    expect(bridge.connect).toHaveBeenCalledWith(
      expect.objectContaining({ pageType: "page", pageId: "page-id" }),
      expect.anything()
    )
  })
  it("gives a Page a live frame on a single-language site", () => {
    const view = setup(
      { pageType: "page", locale: "en", defaultLocale: "en", languageVersion: 1 },
      "en"
    )
    expect(view.container.querySelector("iframe")).not.toBeNull()
  })
  it("uses a fixed real viewport and preserves its document through resize/zoom/input", () => {
    const view = setup()
    const { frame, bridge } = handshake(view)
    const originalSource = frame.src
    expect(frame.width).toBe("1280")
    expect(frame.height).toBe("900")
    fireEvent.click(view.getByRole("button", { name: "Mobile" }))
    expect(frame.width).toBe("390")
    expect(frame.height).toBe("844")
    fireEvent.change(view.getByRole("combobox"), { target: { value: "75" } })
    expect(frame.style.transform).toBe("scale(0.75)")
    view.rerender(
      <LivePreviewFrame
        {...view.props}
        title="New title"
        onActiveEditHandleChange={vi.fn()}
      />
    )
    expect(view.getByTitle("New title")).toBe(frame)
    expect(frame.src).toBe(originalSource)
    expect(bridge.disconnect).not.toHaveBeenCalled()
    expect(bridge.replaceInput).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "New title", locale: "fr" })
    )
  })
  it("blocks direct entry until existing recovery is resolved without replacing the frame", () => {
    const view = setup({ inlineEditingBlocked: true })
    const { frame, bridge } = handshake(view)
    expect(
      view.getByRole("button", { name: "Edit text in preview: off" })
    ).toBeDisabled()
    expect(bridge.connect).toHaveBeenLastCalledWith(
      expect.objectContaining({ inlineEditingEnabled: false }),
      expect.any(Object)
    )
    view.rerender(
      <LivePreviewFrame {...view.props} inlineEditingBlocked={false} />
    )
    expect(view.getByTitle("Draft Page")).toBe(frame)
    expect(
      view.getByRole("button", { name: "Edit text in preview: off" })
    ).toBeEnabled()
    expect(bridge.disconnect).not.toHaveBeenCalled()
  })

  it("reports slow bootstrap after a bounded wait while preserving form access", () => {
    vi.useFakeTimers()
    try {
      const view = setup()
      act(() => {
        vi.advanceTimersByTime(15_000)
      })
      expect(view.getByRole("status")).toHaveTextContent(
        "Still loading the preview"
      )
      expect(view.handle()?.hasActiveSession()).toBe(false)
      expect(view.getByRole("button", { name: "Saved" })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("routes one child Save command to the Page handler and refuses reload callbacks", () => {
    const view = setup()
    const { frame, bridge, callbacks } = handshake(view)
    const listener = vi.fn()
    window.addEventListener("keydown", listener)
    try {
      callbacks().save()
      expect(view.props.onSave).toHaveBeenCalledOnce()
      expect(listener).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener("keydown", listener)
    }
    fireEvent.load(frame)
    expect(bridge.disconnect).toHaveBeenCalledOnce()
    callbacks().selectSlice("stale")
    expect(view.props.onSelectSlice).not.toHaveBeenCalled()
    expect(view.handle()?.hasActiveSession()).toBe(false)
  })
})

describe("Unit A NEW frame regressions", () => {
  it("NEW retires a throwing old bridge and still exposes Retry after a reloading frame stalls", () => {
    vi.useFakeTimers()
    try {
      const view = setup()
      const { frame, bridge } = handshake(view)
      vi.mocked(bridge.disconnect).mockImplementation(() => {
        throw new DOMException("Blocked frame access", "SecurityError")
      })

      expect(() => fireEvent.load(frame)).not.toThrow()
      expect(view.getByRole("status")).toHaveTextContent(
        "Preparing the page preview"
      )
      act(() => vi.advanceTimersByTime(15_000))
      expect(view.getByRole("status")).toHaveTextContent(
        "Still loading the preview"
      )
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("NEW skips a replaced current bridge during retirement and reconnects after reload", () => {
    const view = setup()
    const { frame, child, bridge } = handshake(view)
    child.__formulacmsLiveFrame = {
      ...bridge,
      generation: "frame-2",
    } satisfies LiveFrameBridge
    vi.mocked(bridge.disconnect).mockImplementation(() => {
      throw new DOMException("Old frame is restricted", "SecurityError")
    })

    expect(() => fireEvent.load(frame)).not.toThrow()
    expect(bridge.disconnect).not.toHaveBeenCalled()
    expect(view.getByRole("status")).toHaveTextContent(
      "Preparing the page preview"
    )

    const next = handshake(view, true, "frame-2")
    expect(next.bridge.connect).toHaveBeenCalledOnce()
    expect(view.queryByRole("status")).toBeNull()
  })

  it("NEW treats an inaccessible current bridge as already retired and keeps the loading timer", () => {
    vi.useFakeTimers()
    try {
      const view = setup()
      const { frame, child, bridge } = handshake(view)
      Object.defineProperty(child, "__formulacmsLiveFrame", {
        configurable: true,
        get() {
          throw new DOMException("Blocked frame access", "SecurityError")
        },
      })

      expect(() => fireEvent.load(frame)).not.toThrow()
      expect(bridge.disconnect).not.toHaveBeenCalled()
      act(() => vi.advanceTimersByTime(15_000))
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it.each([
    ["en", "Edit text in preview: off", "Edit text in preview: on"],
    [
      "fr",
      "Modifier le texte dans l’aperçu : désactivé",
      "Modifier le texte dans l’aperçu : activé",
    ],
  ] as const)(
    "NEW shows plain %s pencil on/off copy and a distinct pressed appearance",
    (locale, off, on) => {
      const view = setup({}, locale)
      const pencil = view.getByRole("button", { name: off })
      expect(pencil).toHaveAttribute("aria-pressed", "false")
      expect(pencil).toHaveAttribute("data-variant", "outline")
      fireEvent.click(pencil)
      expect(view.getByRole("button", { name: on })).toBe(pencil)
      expect(pencil).toHaveAttribute("aria-pressed", "true")
      expect(pencil).toHaveAttribute("data-variant", "default")
      fireEvent.click(pencil)
      expect(pencil).toHaveAttribute("aria-pressed", "false")
    }
  )

  it("NEW keeps a slow connected child and its pending buffer alive, then accepts late readiness", sliceProfile([]), () => {
    vi.useFakeTimers()
    try {
      const slice = createSampleSlice("hero-agency")
      const view = setup({ slices: [slice] })
      const { frame, bridge, callbacks } = handshake(view)
      const pending = recoveryCommit(slice)
      bridge.hasActiveSession = () => true
      vi.mocked(bridge.capture).mockReturnValue(pending)
      act(() => {
        callbacks().change(pending)
        callbacks().context(false)
      })
      const beforeVisibility = frame.style.visibility
      act(() => vi.advanceTimersByTime(15_000))
      expect(view.getByRole("status")).toHaveTextContent(
        "Still loading the preview"
      )
      expect(bridge.disconnect).not.toHaveBeenCalled()
      expect(view.handle()?.capture()).toEqual(pending)
      expect(frame.style.visibility).toBe(beforeVisibility)
      expect(view.props.onActiveEditConflict).not.toHaveBeenCalled()
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
      act(() => callbacks().context(true))
      expect(frame.style.visibility).toBe("visible")
      expect(view.queryByRole("button", { name: "Retry preview" })).toBeNull()
      expect(view.handle()?.capture()).toEqual(pending)
    } finally {
      vi.useRealTimers()
    }
  })

  it("NEW B-C0 retries the frame and reconnects to the current parent draft without inline Restore", () => {
    vi.useFakeTimers()
    try {
      const view = setup()
      const first = handshake(view, false)
      act(() => vi.advanceTimersByTime(15_000))
      fireEvent.click(view.getByRole("button", { name: "Retry preview" }))
      fireEvent.load(first.frame)
      expect(first.bridge.disconnect).not.toHaveBeenCalled()
      const fresh = handshake(view)
      expect(fresh.bridge.connect).toHaveBeenCalledWith(
        expect.objectContaining({ slices: view.props.slices }),
        expect.any(Object)
      )
      expect(view.queryByRole("button", { name: "Restore" })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it("NEW shows the French slow-loading notice and Retry action", () => {
    vi.useFakeTimers()
    try {
      const view = setup({}, "fr")
      act(() => vi.advanceTimersByTime(15_000))
      expect(view.getByRole("status")).toHaveTextContent(
        "L’aperçu est encore en cours de chargement"
      )
      expect(
        view.getByRole("button", { name: "Réessayer l’aperçu" })
      ).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("NEW calls the explicit Save handler once without synthesizing a keyboard event", () => {
    const view = setup()
    const { frame, callbacks } = handshake(view)
    const listener = vi.fn()
    window.addEventListener("keydown", listener)
    try {
      act(() => callbacks().save())
      expect(view.props.onSave).toHaveBeenCalledOnce()
      expect(listener).not.toHaveBeenCalled()
      fireEvent.load(frame)
      act(() => callbacks().save())
      expect(view.props.onSave).toHaveBeenCalledOnce()
    } finally {
      window.removeEventListener("keydown", listener)
    }
  })
})

describe("Unit A NEW parent import boundary", () => {
  it("NEW renders the shipping Page host without importing Canvas or slice renderers", () => {
    const view = setup()
    const props = view.props
    view.unmount()
    const host = render(<PageLivePreview {...props} />)
    expect(host.getByTitle("Draft Page").tagName).toBe("IFRAME")
  })
})

describe("Unit A amendment3 NEW late loading guards", () => {
  it("NEW A-R2 retains slow notice through a late current-child handshake and subsequent pending edits", sliceProfile([]), () => {
    vi.useFakeTimers()
    try {
      const slice = createSampleSlice("hero-agency")
      const view = setup({ slices: [slice] })
      act(() => vi.advanceTimersByTime(15_000))
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
      const { frame, bridge, callbacks } = handshake(view, false)
      const pending = recoveryCommit(slice)
      bridge.hasActiveSession = () => true
      vi.mocked(bridge.capture).mockReturnValue(pending)
      act(() => callbacks().change(pending))
      expect(bridge.disconnect).not.toHaveBeenCalled()
      expect(view.handle()?.capture()).toEqual(pending)
      expect(view.props.onActiveEditChange).toHaveBeenLastCalledWith(pending)
      expect(view.getByRole("status")).toHaveTextContent(
        "Still loading the preview"
      )
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
      act(() => vi.advanceTimersByTime(15_000))
      expect(bridge.disconnect).not.toHaveBeenCalled()
      expect(view.handle()?.capture()).toEqual(pending)
      act(() => callbacks().context(true))
      expect(frame.style.visibility).toBe("visible")
      expect(view.queryByRole("button", { name: "Retry preview" })).toBeNull()
      expect(bridge.disconnect).not.toHaveBeenCalled()
      expect(view.handle()?.capture()).toEqual(pending)
      expect(view.props.onActiveEditChange).toHaveBeenLastCalledWith(pending)
    } finally {
      vi.useRealTimers()
    }
  })

  it("NEW A-R2 preserves qualified pending text and Retry on repeated loading context after timeout", sliceProfile([]), () => {
    vi.useFakeTimers()
    try {
      const slice = createSampleSlice("hero-agency")
      const view = setup({ slices: [slice] })
      const { frame, bridge, callbacks } = handshake(view, false)
      const pending = recoveryCommit(slice)
      bridge.hasActiveSession = () => true
      vi.mocked(bridge.capture).mockReturnValue(pending)
      act(() => callbacks().change(pending))
      act(() => vi.advanceTimersByTime(15_000))
      expect(view.handle()?.capture()).toEqual(pending)
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
      act(() => callbacks().context(false))
      expect(bridge.disconnect).not.toHaveBeenCalled()
      expect(view.handle()?.capture()).toEqual(pending)
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
      act(() => callbacks().context(true))
      expect(frame.style.visibility).toBe("visible")
      expect(view.queryByRole("button", { name: "Retry preview" })).toBeNull()
      expect(view.handle()?.capture()).toEqual(pending)
      expect(bridge.disconnect).not.toHaveBeenCalled()
      expect(view.props.onActiveEditChange).toHaveBeenLastCalledWith(pending)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("Unit A amendment3 NEW reload loading guard", () => {
  it("NEW A-R2 re-arms the bounded notice when a new child loads after bootstrap timeout", () => {
    vi.useFakeTimers()
    try {
      const view = setup()
      act(() => vi.advanceTimersByTime(15_000))
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
      const frame = view.getByTitle("Draft Page") as HTMLIFrameElement
      fireEvent.load(frame)
      expect(view.queryByRole("button", { name: "Retry preview" })).toBeNull()
      act(() => vi.advanceTimersByTime(15_000))
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
      expect(view.handle()?.hasActiveSession()).toBe(false)
      expect(view.props.onActiveEditConflict).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })
  it("NEW accepts a current unloading packet with null source and preserves the parent draft", sliceProfile([]), () => {
    vi.useFakeTimers()
    try {
      const draftSlice = createSampleSlice("hero-agency")
      const view = setup({ slices: [draftSlice] })
      const { frame, bridge } = handshake(view)
      const sessionId = new URL(frame.src).searchParams.get("session")!

      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            origin: window.location.origin,
            source: null,
            data: {
              source: LIVE_FRAME_SOURCE,
              type: "unloading",
              sessionId,
              pageId: "page-id",
              locale: "fr",
              generation: bridge.generation,
              buildId: bridge.buildId,
            },
          })
        )
      )

      expect(view.getByRole("status")).toHaveTextContent(
        "Preparing the page preview"
      )
      expect(frame.style.visibility).toBe("hidden")
      expect(view.props.slices).toEqual([draftSlice])
      expect(bridge.disconnect).not.toHaveBeenCalled()
      expect(view.props.onInlineEditCommit).not.toHaveBeenCalled()
      expect(view.props.onActiveEditConflict).not.toHaveBeenCalled()

      act(() => vi.advanceTimersByTime(15_000))
      expect(view.getByRole("button", { name: "Retry preview" })).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })
  it("NEW ignores unloading from a nonmatching non-null source", () => {
    const view = setup()
    const { frame, bridge } = handshake(view)
    const sessionId = new URL(frame.src).searchParams.get("session")!

    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: window,
          data: {
            source: LIVE_FRAME_SOURCE,
            type: "unloading",
            sessionId,
            pageId: "page-id",
            locale: "fr",
            generation: bridge.generation,
            buildId: bridge.buildId,
          },
        })
      )
    )

    expect(view.queryByRole("status")).toBeNull()
    expect(frame.style.visibility).toBe("visible")
    expect(bridge.disconnect).not.toHaveBeenCalled()
    expect(view.props.onInlineEditCommit).not.toHaveBeenCalled()
  })
  it("NEW ignores non-null-source unloading from a retired generation", () => {
    const view = setup()
    const { frame, child, bridge } = handshake(view)
    const sessionId = new URL(frame.src).searchParams.get("session")!

    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: child,
          data: {
            source: LIVE_FRAME_SOURCE,
            type: "unloading",
            sessionId,
            pageId: "page-id",
            locale: "fr",
            generation: "retired-generation",
            buildId: bridge.buildId,
          },
        })
      )
    )

    expect(frame.style.visibility).toBe("visible")
    expect(view.queryByRole("status")).toBeNull()
    expect(bridge.disconnect).not.toHaveBeenCalled()
    expect(view.props.onInlineEditCommit).not.toHaveBeenCalled()
    expect(view.props.onActiveEditConflict).not.toHaveBeenCalled()
  })
  it("NEW refuses null-source unloading with mismatched origin, identity, generation, or build", () => {
    const view = setup()
    const { frame, bridge } = handshake(view)
    const sessionId = new URL(frame.src).searchParams.get("session")!
    const base = {
      source: LIVE_FRAME_SOURCE,
      type: "unloading",
      sessionId,
      pageId: "page-id",
      locale: "fr",
      generation: bridge.generation,
      buildId: bridge.buildId,
    }
    const invalid = [
      { origin: "https://wrong.example", data: base },
      { origin: window.location.origin, data: { ...base, sessionId: "other" } },
      { origin: window.location.origin, data: { ...base, pageId: "other" } },
      { origin: window.location.origin, data: { ...base, locale: "en" } },
      {
        origin: window.location.origin,
        data: { ...base, generation: "retired-generation" },
      },
      {
        origin: window.location.origin,
        data: { ...base, buildId: "retired-build" },
      },
    ]

    for (const event of invalid)
      act(() =>
        window.dispatchEvent(
          new MessageEvent("message", {
            ...event,
            source: null,
          })
        )
      )

    expect(view.queryByRole("status")).toBeNull()
    expect(frame.style.visibility).toBe("visible")
    expect(bridge.disconnect).not.toHaveBeenCalled()
    expect(view.props.onInlineEditCommit).not.toHaveBeenCalled()
    expect(view.props.onActiveEditConflict).not.toHaveBeenCalled()
  })
})

it.each(["retired-build", "test-build"])(
  "NEW B1-R1 ignores delayed %s ready from a retired generation after current child connects", sliceProfile([]),
  (buildId) => {
    const slice = createSampleSlice("hero-agency")
    const view = setup({ slices: [slice] })
    const { frame, child, bridge } = handshake(view)
    expect(frame.style.visibility).toBe("visible")
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: child,
          data: {
            source: LIVE_FRAME_SOURCE,
            type: "ready",
            sessionId: new URL(frame.src).searchParams.get("session"),
            pageId: "page-id",
            locale: "fr",
            generation: "retired-generation",
            buildId,
          },
        })
      )
    )
    expect(child.__formulacmsLiveFrame).toBe(bridge)
    expect(bridge.disconnect).not.toHaveBeenCalled()
    expect(frame.style.visibility).toBe("visible")
    expect(
      view.queryByText("The site was updated. Reload the editor to continue.")
    ).toBeNull()
    expect(view.props.slices).toEqual([slice])
    expect(view.props.onInlineEditCommit).not.toHaveBeenCalled()
  }
)
it("NEW B1-R1 ignores retired notices from earlier generations while accepting current retirement", () => {
  const view = setup()
  const { frame, child, bridge } = handshake(view)
  const retired = (generation: string, buildId: string) =>
    new MessageEvent("message", {
      origin: window.location.origin,
      source: child,
      data: {
        source: LIVE_FRAME_SOURCE,
        type: "retired",
        sessionId: new URL(frame.src).searchParams.get("session"),
        pageId: "page-id",
        locale: "fr",
        generation,
        buildId,
      },
    })
  for (const buildId of ["retired-build", "test-build"])
    act(() => window.dispatchEvent(retired("retired-generation", buildId)))
  expect(bridge.disconnect).not.toHaveBeenCalled()
  expect(frame.style.visibility).toBe("visible")
  act(() => window.dispatchEvent(retired(bridge.generation, bridge.buildId)))
  expect(bridge.disconnect).toHaveBeenCalledOnce()
  expect(frame.style.visibility).toBe("hidden")
})
it("NEW B1-R1 ignores a current-generation ready with an unqualified claimed build", () => {
  const view = setup()
  const { frame, child, bridge } = handshake(view)
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: child,
        data: {
          source: LIVE_FRAME_SOURCE,
          type: "ready",
          sessionId: new URL(frame.src).searchParams.get("session"),
          pageId: "page-id",
          locale: "fr",
          generation: bridge.generation,
          buildId: "claimed-other-build",
        },
      })
    )
  )
  expect(bridge.disconnect).not.toHaveBeenCalled()
  expect(frame.style.visibility).toBe("visible")
  expect(
    view.queryByText("The site was updated. Reload the editor to continue.")
  ).toBeNull()
})
it("NEW keeps ready and retired messages bound to the current WindowProxy", () => {
  const view = setup()
  const { frame, child, bridge } = handshake(view)
  const sessionId = new URL(frame.src).searchParams.get("session")!

  for (const type of ["ready", "retired"] as const)
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: null,
          data: {
            source: LIVE_FRAME_SOURCE,
            type,
            sessionId,
            pageId: "page-id",
            locale: "fr",
            generation: bridge.generation,
            buildId: bridge.buildId,
          },
        })
      )
    )

  expect(child.__formulacmsLiveFrame).toBe(bridge)
  expect(bridge.disconnect).not.toHaveBeenCalled()
  expect(frame.style.visibility).toBe("visible")
  expect(view.queryByRole("status")).toBeNull()
})

it("NEW shows the site-update notice and rejects a mismatched child build while retaining parent data", sliceProfile([]), () => {
  const slice = createSampleSlice("hero-agency")
  const view = setup({ slices: [slice] })
  const { frame, child, bridge } = handshake(view)
  // A genuine mismatch comes from the actual live replacement bridge.
  const updatedBridge: LiveFrameBridge = {
    ...bridge,
    generation: "updated-child",
    buildId: "new-build",
    connect: vi.fn(() => true),
    disconnect: vi.fn(),
  }
  child.__formulacmsLiveFrame = updatedBridge
  act(() =>
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: window.location.origin,
        source: child,
        data: {
          source: LIVE_FRAME_SOURCE,
          type: "ready",
          sessionId: new URL(frame.src).searchParams.get("session"),
          pageId: "page-id",
          locale: "fr",
          generation: "updated-child",
          buildId: "new-build",
        },
      })
    )
  )
  expect(view.getByRole("status")).toHaveTextContent(
    "The site was updated. Reload the editor to continue."
  )
  expect(view.props.slices).toEqual([slice])
  expect(bridge.disconnect).not.toHaveBeenCalled()
  expect(updatedBridge.connect).not.toHaveBeenCalled()
  expect(view.props.onInlineEditCommit).not.toHaveBeenCalled()
})

describe("Conflict recovery", () => {
  it("shows the preview again after the conflicted buffer is discarded", () => {
    const view = setup()
    const { frame, callbacks } = handshake(view)
    expect(frame.style.visibility).toBe("visible")
    // The fake bridge sends context(true) once, as the compiled frame does.
    act(() => callbacks().conflict())
    expect(frame.style.visibility).toBe("hidden")
    act(() => view.handle()?.discardActiveEdit?.())
    view.rerender(
      <LivePreviewFrame
        {...view.props}
        inlineEditingBlocked={false}
        title="Draft Page"
      />
    )
    expect(frame.style.visibility).toBe("visible")
  })

  it("returns to loading, not ready, when the last context was not ready", () => {
    const view = setup()
    const { frame, callbacks } = handshake(view, false)
    act(() => callbacks().conflict())
    act(() => view.handle()?.discardActiveEdit?.())
    expect(frame.style.visibility).toBe("hidden")
  })
})


it("initial fit is measured in layout before passive effects and still observes resize", () => {
  let phase = "render"
  let width = 640
  let resize: (() => void) | undefined
  const measurements: string[] = []
  const measure = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => { measurements.push(phase); return width })
  function Sentinel() {
    useLayoutEffect(() => { phase = "layout" }, [])
    useEffect(() => { phase = "passive" }, [])
    return null
  }
  const props = setup().props
  // setup's independent fixture has already measured; isolate the traced mount.
  measurements.length = 0
  vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { resize = callback } observe() {} disconnect() {} })
  const view = render(<><Sentinel /><LivePreviewFrame {...props} /></>)
  expect(measurements[0]).toBe("layout")
  expect(view.container.querySelector("iframe")?.style.transform).toBe("scale(0.5)")
  width = 320
  act(() => resize?.())
  expect(view.container.querySelector("iframe")?.style.transform).toBe("scale(0.25)")
  measure.mockRestore()
})

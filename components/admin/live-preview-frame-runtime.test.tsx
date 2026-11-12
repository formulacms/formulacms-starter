vi.mock("@/lib/preview-build-id", () => ({ PREVIEW_BUILD_ID: "test-build" }))
import { sliceProfile } from "@/test-utils/slice-profile"
import { act, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  createContext,
  isValidElement,
  useContext,
  type ReactElement,
  type ReactNode,
} from "react"
import { getContentTypeRenderer } from "@/components/content-types"
import { getFunctionName } from "convex/server"
import type { Id } from "@/convex/_generated/dataModel"
import { usePresentationLocale } from "@/components/public/presentation-locale"
import type { SliceRenderContext } from "@/lib/slices/links"
import { render } from "@/test-utils/admin-i18n"
import type { Doc } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import { captureSliceOccurrence } from "./page-editor/lib/slice-occurrence"
import {
  LivePreviewFrame,
  type PageLivePreviewProps,
} from "./live-preview-frame"
import { LivePreviewFrameRuntime } from "./live-preview-frame-runtime"
import type {
  LiveFrameCallbacks,
  LiveFrameInput,
  LiveFrameWindow,
} from "./live-preview-frame-bridge"
import { LIVE_FRAME_SOURCE } from "./live-preview-frame-bridge"
import type { PreviewInlineEditCommit } from "./visual-editing-types"

const controls = vi.hoisted(() => ({
  resolve: vi.fn(),
  query: vi.fn(),
  overrides: new Map<string, unknown>(),
  auth: { isLoading: false, isAuthenticated: true },
  relations: null as Id<"pages">[] | null,
  crash: false,
  change: null as ((commit: PreviewInlineEditCommit | null) => void) | null,
  renderPage: null as
    | ((slices: Slice[], context: SliceRenderContext) => ReactNode)
    | null,
}))
vi.mock("convex/react", () => ({
  useQuery: controls.query,
  useConvexAuth: () => {
    if (!useContext(QueryProviderContext))
      throw new Error("missing authenticated provider")
    return controls.auth
  },
}))
vi.mock(
  "@/app/(live-preview)/admin/pages/[id]/live-frame/[locale]/actions",
  () => ({ resolveLiveFrameContext: controls.resolve })
)
// Only the relation-ID collector seam is synthetic: no registered shipped Slice
// currently has a relation leaf. The ordinary path calls the actual collector.
vi.mock("@/convex/lib/slices/resolve", async () => {
  const actual = await vi.importActual<
    typeof import("@/convex/lib/slices/resolve")
  >("@/convex/lib/slices/resolve")
  return {
    ...actual,
    collectRelationIds: (slices: Slice[]) =>
      controls.relations ?? actual.collectRelationIds(slices),
  }
})
vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => (
    <QueryProviderContext value={true}>{children}</QueryProviderContext>
  ),
}))
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/public/public-site-shell", () => ({
  PublicSiteShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))
vi.mock("./page-live-preview-canvas", () => ({
  PageLivePreviewCanvas: ({
    title,
    renderContext,
    onActiveEditChange,
    renderSlicesTransform,
    renderPage,
    slices,
  }: {
    renderPage(slices: Slice[], context: SliceRenderContext): ReactNode
    title: string
    renderContext: SliceRenderContext
    renderSlicesTransform(slices: Slice[]): Slice[]
    slices: Slice[]
    onActiveEditChange: (commit: PreviewInlineEditCommit | null) => void
  }) => {
    const presentationLocale = usePresentationLocale()
    if (controls.crash) throw new Error("synthetic renderer failure")
    controls.change = onActiveEditChange
    controls.renderPage = renderPage
    return (
      <main
        data-paths={JSON.stringify(renderContext.pagePaths)}
        data-relations={JSON.stringify(renderContext.relationCards)}
        data-catalog={renderContext.presentationCatalog?.revision}
        data-public-path={presentationLocale.publicPath ?? ""}
        data-media={JSON.stringify(renderSlicesTransform(slices))}
      >
        {title}
      </main>
    )
  },
}))

const QueryProviderContext = createContext(false)

const pm = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  })
const slice: Slice = {
  id: "hero",
  type: "hero-agency",
  enabled: true,
  primary: { eyebrow: "Agency", title: pm("First"), description: pm("Copy") },
  items: [],
}
const input: LiveFrameInput = {
  buildId: "test-build",
  sessionId: "session",
  pageId: "page",
  locale: "en",
  defaultLocale: "en",
  languageVersion: 2,
  pageType: "landing-page",
  title: "Title",
  slices: [slice],
  selectedSliceId: null,
  inlineEditingEnabled: true,
  mode: "light",
}
const queryKey = (name: string, args: unknown) =>
  `${name}:${JSON.stringify(args)}`
const configResult = {
  defaultLocale: "en",
  enabledLocales: ["en", "fr"],
  languageVersion: 2,
}
beforeEach(() => {
  controls.overrides.clear()
  controls.relations = null
  controls.auth = { isLoading: false, isAuthenticated: true }
  controls.resolve.mockReset()
  controls.crash = false
  controls.renderPage = null
  controls.query.mockReset().mockImplementation((ref, args) => {
    if (args === "skip") return undefined
    const name = getFunctionName(ref)
    const key = queryKey(name, args)
    const value = controls.overrides.has(key)
      ? controls.overrides.get(key)
      : name === "cms/pages:getForEdit"
        ? { page: { pageType: "landing-page" } }
        : name === "cms/settings:getSiteConfig"
          ? configResult
          : {}
    if (value instanceof Error) throw value
    return value
  })
})
const activeQueryArgs = () =>
  controls.query.mock.calls
    .filter(([, args]) => args !== "skip")
    .map(([ref, args]) => [getFunctionName(ref), args])
function setup(
  config = { defaultLocale: "en", enabledLocales: ["en"], languageVersion: 2 },
  runtimeInput: LiveFrameInput = input,
  pageType: "landing-page" | "page" = "landing-page"
) {
  const callbacks = {
    selectSlice: vi.fn(),
    selectField: vi.fn(),
    commit: vi.fn(),
    change: vi.fn(),
    conflict: vi.fn(),
    save: vi.fn(),
    unavailable: vi.fn(),
    context: vi.fn(),
  } satisfies LiveFrameCallbacks
  const page = { pageType } as Extract<Doc<"pages">, { pageType: typeof pageType }>
  const props = {
    identity: runtimeInput,
    page,
    config,
    publicPath: "/published",
    shell: {
      header: {
        logoUrl: null,
        locale: "en",
        defaultLocale: "en",
        enabledLocales: ["en"],
        languageVersion: 2,
        mainMenuItems: [],
      },
      footer: {
        logoUrl: null,
        locale: "en",
        defaultLocale: "en",
        cardsBySource: {},
        footerMenu: null,
        chrome: null,
      },
    },
  }
  const view = render(<LivePreviewFrameRuntime {...props} />)
  const bridge = (window as LiveFrameWindow).__formulacmsLiveFrame!
  act(() => {
    bridge.connect(runtimeInput, callbacks)
  })
  return { ...view, bridge, callbacks, props, input: runtimeInput }
}
describe("child frame context and generation", () => {
  it("NEW keeps the existing bridge live when pagehide retains the document in BFCache", sliceProfile([]), () => {
    const view = setup()
    const postMessage = vi.spyOn(window.parent, "postMessage")

    act(() =>
      window.dispatchEvent(
        new PageTransitionEvent("pagehide", { persisted: true })
      )
    )

    expect(postMessage).not.toHaveBeenCalled()
    act(() => {
      expect(
        view.bridge.replaceInput({ ...input, title: "Restored parent input" })
      ).toBe(true)
    })
    expect(view.getByText("Restored parent input")).toBeInTheDocument()
    expect(view.callbacks.change).not.toHaveBeenCalled()
  })

  it("NEW retires locally on pagehide and ignores late parent bridge calls", sliceProfile([]), () => {
    const view = setup()
    const title = view.getByText("Title")
    const disconnect = vi.spyOn(view.bridge, "disconnect")
    const posted: unknown[] = []
    const postMessage = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation((message) => {
        posted.push(message)
      })
    postMessage.mockClear()
    posted.length = 0

    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))

    expect(postMessage).toHaveBeenCalledOnce()
    expect(posted[0]).toMatchObject({
      source: LIVE_FRAME_SOURCE,
      type: "unloading",
      sessionId: view.input.sessionId,
      pageId: view.input.pageId,
      locale: view.input.locale,
      generation: view.bridge.generation,
      buildId: view.input.buildId,
    })
    expect(postMessage.mock.calls[0]?.[1]).toBe(window.location.origin)
    expect(view.bridge.connect(input, view.callbacks)).toBe(false)
    expect(
      view.bridge.replaceInput({ ...input, title: "Late parent input" })
    ).toBe(false)
    expect(() => view.bridge.disconnect()).not.toThrow()
    expect(disconnect).toHaveBeenCalledOnce()
    act(() => controls.change?.(null))
    expect(view.getByText("Title")).toBe(title)
    expect(view.queryByText("Late parent input")).toBeNull()
    expect(view.callbacks.change).not.toHaveBeenCalled()

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          cancelable: true,
        })
      )
    )
    expect(view.callbacks.save).not.toHaveBeenCalled()
  })

  it("NEW delivers the runtime's unloading notice to the mounted parent and re-arms Retry", sliceProfile([]), async () => {
    const posted: unknown[] = []
    const postMessage = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation((message) => {
        posted.push(message)
      })
    class ResizeObserverStub {
      observe() {}
      disconnect() {}
    }
    vi.stubGlobal("ResizeObserver", ResizeObserverStub)
    const draftSlice = {
      ...slice,
      primary: { ...slice.primary, title: pm("Parent draft remains") },
    }
    const parentProps: PageLivePreviewProps = {
      pageId: "page-id",
      pageType: "landing-page",
      languageVersion: 2,
      title: "Draft Page",
      slices: [draftSlice],
      locale: "fr",
      defaultLocale: "en",
      selectedSliceId: null,
      onSelectSlice: vi.fn(),
      onSelectField: vi.fn(),
      onInlineEditCommit: vi.fn(),
      onOpenSavedPreview: vi.fn(),
      onSave: vi.fn(),
      onActiveEditConflict: vi.fn(),
    }
    const parentView = render(<LivePreviewFrame {...parentProps} />)
    const frame = parentView.getByTitle("Draft Page") as HTMLIFrameElement
    const child = frame.contentWindow as LiveFrameWindow
    const sessionId = new URL(frame.src).searchParams.get("session")!
    const runtimeInput: LiveFrameInput = {
      ...input,
      sessionId,
      pageId: "page-id",
      locale: "fr",
      title: "Draft Page",
      slices: [draftSlice],
    }
    const runtimeView = setup(
      { defaultLocale: "en", enabledLocales: ["en", "fr"], languageVersion: 2 },
      runtimeInput
    )
    child.__formulacmsLiveFrame = runtimeView.bridge
    const ready = posted.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "ready"
    )
    expect(ready).toBeDefined()

    const dispatch = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", {
          origin: window.location.origin,
          source: child,
          data,
        })
      )
    act(() => dispatch(ready))
    await waitFor(() => expect(parentView.queryByRole("status")).toBeNull())
    expect(frame.style.visibility).toBe("visible")

    const readyPacket = ready as Record<string, unknown>
    act(() =>
      dispatch({
        ...readyPacket,
        type: "unloading",
        generation: "older-generation",
      })
    )
    expect(parentView.queryByRole("status")).toBeNull()
    act(() =>
      dispatch({
        ...readyPacket,
        type: "unloading",
        buildId: "older-build",
      })
    )
    expect(parentView.queryByRole("status")).toBeNull()

    const disconnect = vi.spyOn(runtimeView.bridge, "disconnect")
    posted.length = 0
    postMessage.mockClear()
    act(() => window.dispatchEvent(new PageTransitionEvent("pagehide")))
    const unloading = posted.find(
      (message) =>
        typeof message === "object" &&
        message !== null &&
        "type" in message &&
        message.type === "unloading"
    )
    expect(unloading).toBeDefined()
    expect(unloading).toMatchObject({
      source: LIVE_FRAME_SOURCE,
      type: "unloading",
      sessionId,
      pageId: "page-id",
      locale: "fr",
      generation: runtimeView.bridge.generation,
      buildId: runtimeInput.buildId,
    })
    expect(window.parent.postMessage).toHaveBeenLastCalledWith(
      unloading,
      window.location.origin
    )
    Object.defineProperty(child, "__formulacmsLiveFrame", {
      configurable: true,
      get() {
        throw new DOMException("Blocked frame access", "SecurityError")
      },
    })

    vi.useFakeTimers()
    try {
      await act(async () => {
        Promise.resolve().then(() => dispatch(unloading))
        await Promise.resolve()
      })
      expect(parentView.getByRole("status")).toHaveTextContent(
        "Preparing the page preview"
      )
      expect(frame.style.visibility).toBe("hidden")
      expect(parentProps.slices).toEqual([draftSlice])
      expect(parentProps.onInlineEditCommit).not.toHaveBeenCalled()
      expect(parentProps.onActiveEditConflict).not.toHaveBeenCalled()

      act(() =>
        dispatch({
          ...readyPacket,
          type: "retired",
          generation: runtimeView.bridge.generation,
        })
      )
      expect(disconnect).not.toHaveBeenCalled()
      expect(parentView.getByRole("status")).toHaveTextContent(
        "Preparing the page preview"
      )

      act(() => vi.advanceTimersByTime(15_000))
      expect(parentView.getByRole("status")).toHaveTextContent(
        "Still loading the preview"
      )
      expect(
        parentView.getByRole("button", { name: "Retry preview" })
      ).toBeEnabled()
    } finally {
      vi.useRealTimers()
    }
  })

  it("waits for resolved context and does not refetch or replace text DOM on typing", sliceProfile([]), async () => {
    const view = setup()
    await waitFor(() =>
      expect(view.callbacks.context).toHaveBeenLastCalledWith(true)
    )
    const main = view.getByText("Title")
    const initialQueryArgs = activeQueryArgs()
    controls.query.mockClear()
    const commit = {
      ...captureSliceOccurrence(input.slices, "en", "hero")!,
      fieldPath: "primary.title",
      kind: "richText" as const,
      value: pm("First x"),
    }
    act(() => controls.change?.(commit))
    act(() => controls.change?.({ ...commit, value: pm("First xy") }))
    act(() =>
      view.bridge.replaceInput({
        ...input,
        slices: [
          { ...slice, primary: { ...slice.primary, title: pm("First xy") } },
        ],
      })
    )
    expect(view.getByText("Title")).toBe(main)
    expect(activeQueryArgs()).toEqual(initialQueryArgs)
    expect(controls.resolve).not.toHaveBeenCalled()
    expect(view.callbacks.change).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: pm("First xy") })
    )
  })
  it("ignores obsolete dependency results and never displays stale maps as current", sliceProfile([]), () => {
    const view = setup()
    const linked = (id: string): Slice => ({
      ...slice,
      items: [
        {
          id: "link",
          label: "Go",
          variant: "primary",
          withIcon: false,
          enabled: true,
          link: {
            type: "internal",
            pageId: id as import("@/convex/_generated/dataModel").Id<"pages">,
          },
        },
      ],
    })
    const pathArgs = (id: string) => ({
      ids: [id],
      locale: "en",
      languageVersion: 2,
    })
    controls.overrides.set(
      queryKey("cms/pages:getLocalizedPathsByIds", pathArgs("old")),
      { old: "/old" }
    )
    act(() => view.bridge.replaceInput({ ...input, slices: [linked("old")] }))
    expect(view.getByText("Title")).toHaveAttribute(
      "data-paths",
      JSON.stringify({ old: "/old" })
    )
    controls.overrides.set(
      queryKey("cms/pages:getLocalizedPathsByIds", pathArgs("new")),
      undefined
    )
    act(() => view.bridge.replaceInput({ ...input, slices: [linked("new")] }))
    expect(view.callbacks.context).toHaveBeenLastCalledWith(false)
    expect(view.getByText("Title")).toHaveAttribute("data-paths", "{}")
    controls.overrides.set(
      queryKey("cms/pages:getLocalizedPathsByIds", pathArgs("old")),
      { old: "/obsolete" }
    )
    view.rerender(<LivePreviewFrameRuntime {...view.props} />)
    expect(view.getByText("Title")).toHaveAttribute("data-paths", "{}")
    controls.overrides.set(
      queryKey("cms/pages:getLocalizedPathsByIds", pathArgs("new")),
      { new: "/current" }
    )
    view.rerender(<LivePreviewFrameRuntime {...view.props} />)
    expect(view.getByText("Title")).toHaveAttribute(
      "data-paths",
      JSON.stringify({ new: "/current" })
    )
    expect(view.callbacks.context).toHaveBeenLastCalledWith(true)
  })
  it.each(["landing-page", "page"] as const)(
    "NEW renders a %s row through the slice-body renderer registered for its own type",
    sliceProfile([]),
    async (pageType) => {
      controls.overrides.set(queryKey("cms/pages:getForEdit", { id: "page" }), {
        page: { pageType },
      })
      const view = setup(
        { defaultLocale: "en", enabledLocales: ["en"], languageVersion: 2 },
        { ...input, pageType },
        pageType
      )
      await waitFor(() =>
        expect(view.callbacks.context).toHaveBeenLastCalledWith(true)
      )
      expect(view.callbacks.unavailable).not.toHaveBeenCalled()
      const registered = getContentTypeRenderer(pageType)
      const element = controls.renderPage!([slice], {} as SliceRenderContext)
      expect(isValidElement(element)).toBe(true)
      expect((element as ReactElement).type).toBe(
        registered.kind === "sliceBody" ? registered.Component : null
      )
      expect((element as ReactElement<{ page: unknown }>).props.page).toBe(
        view.props.page
      )
    }
  )
  it("refuses incompatible config/locale input and retires its bridge on unmount", sliceProfile([]), () => {
    const view = setup()
    expect(view.bridge.replaceInput({ ...input, languageVersion: 3 })).toBe(
      false
    )
    expect(view.bridge.replaceInput({ ...input, locale: "fr" })).toBe(false)
    const listener = vi.fn()
    window.addEventListener("keydown", listener)
    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          cancelable: true,
        })
      )
    )
    expect(view.callbacks.save).toHaveBeenCalledOnce()
    window.removeEventListener("keydown", listener)
    view.unmount()
    expect((window as LiveFrameWindow).__formulacmsLiveFrame).toBeUndefined()
    expect(view.bridge.connect(input, view.callbacks)).toBe(false)
    expect(view.bridge.capture()).toBeNull()
  })
})

describe("Unit A NEW locale dependency regressions", () => {
  it("NEW preserves bridge generation and callbacks for equal locale values in a fresh array", sliceProfile([]), async () => {
    const view = setup({
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
      languageVersion: 2,
    })
    await waitFor(() =>
      expect(view.callbacks.context).toHaveBeenLastCalledWith(true)
    )
    const title = view.getByText("Title")
    view.rerender(
      <LivePreviewFrameRuntime
        {...view.props}
        config={{ ...view.props.config, enabledLocales: ["en", "fr"] }}
      />
    )
    expect((window as LiveFrameWindow).__formulacmsLiveFrame).toBe(view.bridge)
    expect(view.getByText("Title")).toBe(title)
    act(() => view.bridge.replaceInput({ ...input, title: "Same generation" }))
    expect(view.getByText("Same generation")).toBe(title)
  })

  it.each(["order", "membership", "defaultLocale", "languageVersion"])(
    "NEW replaces generation on a real %s configuration change", sliceProfile([]),
    (change) => {
      const view = setup({
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        languageVersion: 2,
      })
      const config = {
        ...view.props.config,
        ...(change === "order" ? { enabledLocales: ["fr", "en"] } : {}),
        ...(change === "membership" ? { enabledLocales: ["en"] } : {}),
        ...(change === "defaultLocale" ? { defaultLocale: "fr" } : {}),
        ...(change === "languageVersion" ? { languageVersion: 3 } : {}),
      }
      view.rerender(<LivePreviewFrameRuntime {...view.props} config={config} />)
      expect(
        (window as LiveFrameWindow).__formulacmsLiveFrame?.generation
      ).not.toBe(view.bridge.generation)
      expect(view.bridge.replaceInput(input)).toBe(false)
    }
  )
})

it("NEW refuses a different build even when Page, locale and language authority match", sliceProfile([]), () => {
  const view = setup()
  expect(view.bridge.replaceInput({ ...input, buildId: "new-build" })).toBe(
    false
  )
})

it("NEW catches renderer failure in the frame while retaining the supplied parent draft", sliceProfile([]), () => {
  const error = vi.spyOn(console, "error").mockImplementation(() => {})
  controls.crash = true
  const before = JSON.stringify(input)
  try {
    const view = setup()
    expect(view.callbacks.unavailable).toHaveBeenCalled()
    expect(view.getByRole("status")).toHaveTextContent("preview")
    expect(JSON.stringify(input)).toBe(before)
  } finally {
    controls.crash = false
    error.mockRestore()
  }
})
it("NEW child keyboard Save ignores repeats and dispatches exactly once", sliceProfile([]), () => {
  const view = setup()
  act(() => {
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        cancelable: true,
      })
    )
    window.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "s",
        ctrlKey: true,
        repeat: true,
        cancelable: true,
      })
    )
  })
  expect(view.callbacks.save).toHaveBeenCalledOnce()
})

// B2 fail-first: the real runtime must reach query hooks; action mocks alone cannot satisfy this.
it("NEW B2 subscribes to authorized current Page/config without a Server Action read", sliceProfile([]), async () => {
  controls.query.mockClear()
  controls.resolve.mockClear()
  setup()
  await waitFor(() => expect(controls.query).toHaveBeenCalled())
  expect(controls.resolve).not.toHaveBeenCalled()
})

const linkedSlice = (id: string): Slice => ({
  ...slice,
  items: [
    {
      id: "link",
      label: "Go",
      variant: "primary",
      withIcon: false,
      enabled: true,
      link: { type: "internal", pageId: id as Id<"pages"> },
    },
  ],
})
const imageSlice = (id: string): Slice => ({
  id,
  type: "hero-with-image",
  enabled: true,
  primary: {
    eyebrow: "",
    eyebrowLink: { type: "none" },
    title: pm("Image"),
    description: pm("Copy"),
    image: {
      storageId: id as Id<"_storage">,
      url: "/old",
      alt: "",
      width: 1,
      height: 1,
    },
  },
  items: [],
})
const setQuery = (name: string, args: unknown, value: unknown) =>
  controls.overrides.set(queryKey(name, args), value)

describe("NEW B2 query safety", () => {
  it("NEW B2 waits for authenticated provider readiness, then scopes the Page read", sliceProfile([]), () => {
    controls.auth = { isLoading: true, isAuthenticated: false }
    const view = setup()
    expect(activeQueryArgs()).toEqual([])
    expect(view.callbacks.context).toHaveBeenLastCalledWith(false)
    expect(view.callbacks.unavailable).not.toHaveBeenCalled()
    controls.auth = { isLoading: false, isAuthenticated: true }
    view.rerender(<LivePreviewFrameRuntime {...view.props} />)
    expect(activeQueryArgs()).toEqual([
      ["cms/pages:getForEdit", { id: "page" }],
      ["cms/settings:getSiteConfig", {}],
    ])
    expect(view.callbacks.context).toHaveBeenLastCalledWith(true)
  })
  it("NEW B2 retains the draft and bridge when authenticated access is lost", sliceProfile([]), () => {
    const view = setup()
    const title = view.getByText("Title")
    controls.auth = { isLoading: false, isAuthenticated: false }
    controls.query.mockClear()
    view.rerender(<LivePreviewFrameRuntime {...view.props} />)
    expect(activeQueryArgs()).toEqual([])
    expect(view.callbacks.unavailable).toHaveBeenCalled()
    expect(view.callbacks.context).toHaveBeenLastCalledWith(false)
    expect(view.getByText("Title")).toBe(title)
    expect((window as LiveFrameWindow).__formulacmsLiveFrame).toBe(view.bridge)
  })
  it.each(["pageLoading", "configLoading"])(
    "NEW B2 keeps %s distinct from access refusal", sliceProfile([]),
    (kind) => {
      setQuery(
        kind === "pageLoading"
          ? "cms/pages:getForEdit"
          : "cms/settings:getSiteConfig",
        kind === "pageLoading" ? { id: "page" } : {},
        undefined
      )
      const view = setup()
      expect(view.callbacks.context).toHaveBeenLastCalledWith(false)
      expect(view.callbacks.unavailable).not.toHaveBeenCalled()
      expect(view.getByText("Title")).toBeInTheDocument()
    }
  )
  it.each([
    "permission",
    "type",
    "author",
    "locale",
    "defaultLocale",
    "languageVersion",
  ])(
    "NEW B2 stops context on live %s invalidation of a valid parent input", sliceProfile([]),
    (kind) => {
      const view = setup()
      const before = JSON.stringify(input)
      if (kind === "permission" || kind === "type" || kind === "author")
        setQuery(
          "cms/pages:getForEdit",
          { id: "page" },
          kind === "permission"
            ? null
            : { page: { pageType: kind === "author" ? "author" : "post" } }
        )
      else
        setQuery(
          "cms/settings:getSiteConfig",
          {},
          {
            ...configResult,
            ...(kind === "locale"
              ? { enabledLocales: ["fr"] }
              : kind === "defaultLocale"
                ? { defaultLocale: "fr" }
                : { languageVersion: 3 }),
          }
        )
      view.rerender(<LivePreviewFrameRuntime {...view.props} />)
      expect(view.callbacks.context).toHaveBeenLastCalledWith(false)
      expect(view.callbacks.unavailable).toHaveBeenCalled()
      expect(view.getByText("Title")).toBeInTheDocument()
      expect(JSON.stringify(input)).toBe(before)
      expect((window as LiveFrameWindow).__formulacmsLiveFrame).toBe(
        view.bridge
      )
    }
  )
  it("NEW B2 updates preview paths/media/cards without replacing parent title or public path ownership", sliceProfile([]), () => {
    const view = setup()
    const title = view.getByText("Title")
    controls.relations = ["related" as Id<"pages">]
    act(() =>
      view.bridge.replaceInput({
        ...input,
        slices: [
          linkedSlice("draft"),
          imageSlice("asset"),
          { ...imageSlice("asset"), id: "duplicate-image" },
        ],
      })
    )
    expect(activeQueryArgs()).toContainEqual([
      "cms/pages:getLocalizedPathsByIds",
      { ids: ["draft"], locale: "en", languageVersion: 2 },
    ])
    expect(activeQueryArgs()).toContainEqual([
      "cms/media:getStorageUrls",
      { storageIds: ["asset"] },
    ])
    expect(activeQueryArgs()).toContainEqual([
      "cms/pages:getRelationCardsByIds",
      { ids: ["related"], locale: "en", includeDrafts: true },
    ])
    setQuery(
      "cms/pages:getLocalizedPathsByIds",
      { ids: ["draft"], locale: "en", languageVersion: 2 },
      { draft: "/private-draft" }
    )
    setQuery(
      "cms/media:getStorageUrls",
      { storageIds: ["asset"] },
      { asset: "/fresh" }
    )
    setQuery(
      "cms/pages:getRelationCardsByIds",
      { ids: ["related"], locale: "en", includeDrafts: true },
      { related: null }
    )
    setQuery(
      "cms/pages:getForEdit",
      { id: "page" },
      {
        page: {
          pageType: "landing-page",
          content: { en: { title: "Server value" } },
        },
      }
    )
    view.rerender(<LivePreviewFrameRuntime {...view.props} />)
    expect(view.getByText("Title")).toBe(title)
    expect(title).toHaveAttribute(
      "data-paths",
      JSON.stringify({ draft: "/private-draft" })
    )
    expect(title).toHaveAttribute("data-public-path", "/published")
    expect(title.getAttribute("data-media")).toContain('"url":"/fresh"')
    expect(title).toHaveAttribute(
      "data-relations",
      JSON.stringify({ related: null })
    )
    controls.relations = []
    controls.query.mockClear()
    act(() => view.bridge.replaceInput(input))
    expect(activeQueryArgs()).toEqual([
      ["cms/pages:getForEdit", { id: "page" }],
      ["cms/settings:getSiteConfig", {}],
    ])
    expect(title).toHaveAttribute("data-paths", "{}")
    expect(title).toHaveAttribute("data-relations", "{}")
  })
  it.each([100, 101])(
    "NEW B2 handles %s distinct storage IDs without silently truncating context", sliceProfile([]),
    (count) => {
      const view = setup()
      controls.query.mockClear()
      act(() =>
        view.bridge.replaceInput({
          ...input,
          slices: Array.from({ length: count }, (_, i) =>
            imageSlice(`asset_${i}`)
          ),
        })
      )
      const reads = activeQueryArgs().filter(
        ([name]) => name === "cms/media:getStorageUrls"
      )
      if (count === 100) {
        expect(reads).toHaveLength(1)
        expect(reads[0][1]).toEqual({
          storageIds: Array.from(
            { length: count },
            (_, i) => `asset_${i}`
          ).toSorted(),
        })
        expect(view.callbacks.context).toHaveBeenLastCalledWith(true)
      } else {
        expect(reads).toHaveLength(0)
        expect(view.callbacks.context).toHaveBeenLastCalledWith(false)
        expect(view.callbacks.unavailable).toHaveBeenCalled()
      }
    }
  )
  it.each([
    "cms/pages:getForEdit",
    "cms/settings:getSiteConfig",
    "cms/media:getStorageUrls",
    "cms/pages:getLocalizedPathsByIds",
    "cms/pages:getRelationCardsByIds",
  ])(
    "NEW B2 catches %s error while retaining bridge and draft for parent Retry", sliceProfile([]),
    (name) => {
      const view = setup()
      controls.relations = ["related" as Id<"pages">]
      const args =
        name === "cms/pages:getForEdit"
          ? { id: "page" }
          : name === "cms/settings:getSiteConfig"
            ? {}
            : name === "cms/media:getStorageUrls"
              ? { storageIds: ["asset"] }
              : name === "cms/pages:getLocalizedPathsByIds"
                ? { ids: ["draft"], locale: "en", languageVersion: 2 }
                : { ids: ["related"], locale: "en", includeDrafts: true }
      setQuery(name, args, new Error("synthetic query failure"))
      const before = JSON.stringify(input)
      const error = vi.spyOn(console, "error").mockImplementation(() => {})
      try {
        act(() =>
          view.bridge.replaceInput({
            ...input,
            slices: [linkedSlice("draft"), imageSlice("asset")],
          })
        )
        expect(view.callbacks.unavailable).toHaveBeenCalled()
        expect(view.callbacks.context).toHaveBeenLastCalledWith(false)
        expect(view.getByRole("status")).toHaveTextContent("preview")
        expect((window as LiveFrameWindow).__formulacmsLiveFrame).toBe(
          view.bridge
        )
        expect(JSON.stringify(input)).toBe(before)
        view.unmount()
        controls.overrides.clear()
        const retry = setup()
        expect(retry.callbacks.context).toHaveBeenLastCalledWith(true)
        expect(retry.bridge).not.toBe(view.bridge)
        expect(retry.getByText("Title")).toBeInTheDocument()
      } finally {
        error.mockRestore()
      }
    }
  )
  it("NEW B2 carries only the pinned server presentation catalog into display context", sliceProfile([]), () => {
    const view = setup()
    const catalog = {
      version: "slice-presentations-v1" as const,
      revision: "pinned-source-contract",
      installedTypes: ["hero-agency"],
      contractDigests: {},
      entries: [],
    }
    controls.query.mockClear()
    view.rerender(
      <LivePreviewFrameRuntime {...view.props} presentationCatalog={catalog} />
    )
    expect(view.getByText("Title")).toHaveAttribute(
      "data-catalog",
      catalog.revision
    )
    expect(activeQueryArgs()).toEqual([
      ["cms/pages:getForEdit", { id: "page" }],
      ["cms/settings:getSiteConfig", {}],
    ])
  })
})

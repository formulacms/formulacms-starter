const titleDoc = (text: string, level = 2) =>
  JSON.stringify({
    type: "doc",
    content: [
      { type: "heading", attrs: { level }, content: [{ type: "text", text }] },
    ],
  })
vi.mock("@/lib/preview-build-id", () => ({ PREVIEW_BUILD_ID: "test-build" }))
import { sliceProfile } from "@/test-utils/slice-profile"
import { act, fireEvent } from "@testing-library/react"
import { beforeAll, beforeEach, expect, it, vi } from "vitest"
import type { ReactNode } from "react"
import type { Editor } from "@tiptap/core"
import { getFunctionName } from "convex/server"
import type { Doc } from "@/convex/_generated/dataModel"
import type { Slice } from "@/convex/lib/slices"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"
import { render } from "@/test-utils/admin-i18n"
import { LivePreviewFrameRuntime } from "./live-preview-frame-runtime"
import {
  createLiveFrameController,
  type LiveFrameInput,
  type LiveFrameWindow,
  type LiveFrameCallbacks,
  type LiveFrameBridge,
} from "./live-preview-frame-bridge"
import { applyPageField } from "./page-editor/lib/page-inline-draft"
import type { PreviewInlineEditCommit } from "./visual-editing-types"

const controls = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock("convex/react", () => ({
  useQuery: controls.query,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}))
vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: ReactNode }) => children,
}))
vi.mock("@/components/public/public-site-shell", () => ({
  PublicSiteShell: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}))

const config = {
  defaultLocale: "en",
  enabledLocales: ["en", "fr"],
  languageVersion: 3,
}
beforeEach(() => {
  controls.query.mockImplementation((ref, args) =>
    args === "skip"
      ? undefined
      : getFunctionName(ref) === "cms/pages:getForEdit"
        ? { page: { pageType: "landing-page" } }
        : getFunctionName(ref) === "cms/settings:getSiteConfig"
          ? config
          : {}
  )
})
beforeAll(() => {
  Object.defineProperty(Range.prototype, "getClientRects", {
    configurable: true,
    value: () => [new DOMRect()],
  })
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    configurable: true,
    value: () => new DOMRect(),
  })
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
})
const pm = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  })
const turn = (action: () => void) =>
  act(async () => {
    await new Promise<void>((resolve) =>
      setTimeout(() => {
        action()
        resolve()
      }, 0)
    )
  })
const titleField = (container: HTMLElement) =>
  container.querySelector<HTMLElement>('[data-preview-field="primary.title"]')

// No synthetic reconciliation: transport only delays the real runtime bridge.
async function setup() {
  const catalog = await readSlicePresentationCatalog()
  let draftRevision = 0
  let inputRevision = 0
  let parent = {
    sessionId: "ordered-session",
    pageId: "ordered-page",
    buildId: "test-build",
    pageType: "landing-page",
    locale: "en",
    defaultLocale: "en",
    languageVersion: 3,
    title: "Preview",
    slices: [
      {
        id: "hero",
        type: "hero-agency",
        enabled: true,
        primary: {
          eyebrow: "Agency",
          title: titleDoc("First"),
          description: pm("Copy"),
        },
        items: [],
      },
    ] as Slice[],
    contentEpoch: 0,
    catalogRevision: catalog.revision,
    selectedSliceId: null,
    inlineEditingEnabled: true,
    mode: "light",
    ordering: { draftRevision, inputRevision, generation: "" },
  } as LiveFrameInput & {
    ordering: {
      draftRevision: number
      inputRevision: number
      generation: string
    }
  }
  const props = {
    identity: parent,
    page: { pageType: "landing-page" } as Extract<
      Doc<"pages">,
      { pageType: "landing-page" }
    >,
    config,
    publicPath: "/published",
    presentationCatalog: catalog,
    shell: {
      header: {
        logoUrl: null,
        locale: "en",
        defaultLocale: "en",
        enabledLocales: ["en", "fr"],
        languageVersion: 3,
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
  const actual = (window as LiveFrameWindow).__formulacmsLiveFrame!
  const snapshots: LiveFrameInput[] = []
  const queued: LiveFrameInput[] = []
  const accepted = vi.fn((commit: PreviewInlineEditCommit) => {
    const slices = applyPageField(
      parent.slices,
      parent.locale,
      commit,
      parent.contentEpoch ?? 0,
      parent.catalogRevision ?? ""
    )
    if (!slices) return false
    draftRevision += 1
    parent = {
      ...parent,
      slices,
      ordering: {
        draftRevision,
        inputRevision: ++inputRevision,
        generation: "",
      },
    }
    snapshots.push(parent)
    return true
  })
  const conflict = vi.fn()
  const controller = createLiveFrameController(parent, {
    selectSlice: vi.fn(),
    selectField: vi.fn(),
    commit: accepted,
    change: vi.fn(),
    conflict,
    save: vi.fn(),
    unavailable: vi.fn(),
    context: vi.fn(),
    draftRevision: () => draftRevision,
  } as LiveFrameCallbacks & { draftRevision(): number })
  const transport: LiveFrameBridge = {
    ...actual,
    replaceInput(input) {
      queued.push(input)
      return true
    },
  }
  act(() => {
    expect(controller.connect(transport)).toBe(true)
  })
  const echo = (snapshot: LiveFrameInput) =>
    turn(() => {
      controller.replaceInput(snapshot)
    })
  const deliver = (index: number) =>
    turn(() => {
      actual.replaceInput(queued.at(index)!)
    })
  function external(patch: Partial<LiveFrameInput>, content = true) {
    if (content) draftRevision += 1
    parent = {
      ...parent,
      ...patch,
      ordering: {
        draftRevision,
        inputRevision: ++inputRevision,
        generation: "",
      },
    }
    return parent
  }
  async function begin() {
    fireEvent.click(
      view.container.querySelector('[data-preview-field="primary.title"]')!
    )
    const host = await view.findByRole("textbox")
    return { host, editor: (host as HTMLElement & { editor: Editor }).editor }
  }
  const heading = () => titleField(view.container)?.textContent
  return {
    view,
    actual,
    transport,
    controller,
    snapshots,
    queued,
    accepted,
    conflict,
    parent: () => parent,
    props,
    echo,
    deliver,
    external,
    begin,
    heading,
  }
}

it("renders the lead Hero title as the frame's single h1", sliceProfile(["hero-agency"]), async () => {
  const frame = await setup()
  expect([...frame.view.container.querySelectorAll("h1")]).toEqual([
    titleField(frame.view.container)?.closest("h1"),
  ])
})

it.each(["child", "parent"] as const)(
  "NEW R1 actual runtime drops late %s snapshots after Escape without restoring write authority", sliceProfile(["hero-agency"]),
  async (channel) => {
    const frame = await setup()
    const { host, editor } = await frame.begin()
    for (const char of ["a", "b", "c"]) {
      act(() => editor.commands.insertContent(char))
      await frame.echo(frame.snapshots.at(-1)!)
    }
    await frame.deliver(2)
    act(() => editor.commands.insertContent("d"))
    fireEvent.keyDown(host, { key: "Escape" })
    expect(frame.heading()).toBe("Firstabcd")
    expect(frame.controller.handle.capture()).toBeNull()
    expect(frame.actual.hasActiveSession()).toBe(false)
    if (channel === "parent") await frame.echo(frame.snapshots[0])
    for (const index of channel === "parent" ? [-1] : [0, 1, 0])
      await frame.deliver(index)
    expect(frame.heading()).toBe("Firstabcd")
    expect(frame.accepted).toHaveBeenCalledTimes(4)
    expect(frame.conflict).not.toHaveBeenCalled()
    expect(frame.parent().slices[0].primary).toMatchObject({
      title: titleDoc("Firstabcd"),
    })
  }
)

it("NEW R1 acknowledgment rejects the earliest queued echo before any own input was applied", sliceProfile(["hero-agency"]), async () => {
  const frame = await setup()
  const { host, editor } = await frame.begin()
  for (const char of ["a", "b", "c"]) {
    act(() => editor.commands.insertContent(char))
    await frame.echo(frame.snapshots.at(-1)!)
  }
  fireEvent.keyDown(host, { key: "Escape" })
  await frame.deliver(0)
  expect(frame.heading()).toBe("Firstabc")
  await frame.deliver(2)
  expect(frame.heading()).toBe("Firstabc")
  expect(frame.actual.hasActiveSession()).toBe(false)
})

it.each(["child", "parent"] as const)(
  "NEW R1 preserves authoritative external and unrelated changes against late %s snapshots", sliceProfile(["hero-agency"]),
  async (channel) => {
    const frame = await setup()
    const { host, editor } = await frame.begin()
    for (const char of ["a", "b", "c"]) {
      act(() => editor.commands.insertContent(char))
      await frame.echo(frame.snapshots.at(-1)!)
    }
    fireEvent.keyDown(host, { key: "Escape" })
    const old = frame.snapshots[0]
    const late = async () => {
      if (channel === "parent") await frame.echo(old)
      await frame.deliver(channel === "parent" ? -1 : 0)
    }
    const slices = frame.parent().slices.map((slice) => ({
      ...slice,
      primary: { ...slice.primary, eyebrow: "Updated elsewhere" },
    })) as Slice[]
    await frame.echo(frame.external({ slices }))
    await frame.deliver(-1)
    await late()
    expect(frame.heading()).toBe("Firstabc")
    expect(frame.view.container.textContent).toContain("Updated elsewhere")
    for (const text of ["External", "Firsta"]) {
      await frame.echo(
        frame.external({
          slices: slices.map((slice) => ({
            ...slice,
            primary: { ...slice.primary, title: titleDoc(text) },
          })) as Slice[],
        })
      )
      await frame.deliver(-1)
      await late()
      expect(frame.heading()).toBe(text)
      expect(frame.view.container.textContent).toContain("Updated elsewhere")
      expect(frame.controller.handle.capture()).toBeNull()
    }
    expect(frame.accepted).toHaveBeenCalledTimes(3)
    expect(frame.conflict).not.toHaveBeenCalled()
  }
)

it.each(["epoch", "disabled", "removed"] as const)(
  "NEW R1 late snapshots cannot undo an authoritative %s invalidation", sliceProfile(["hero-agency"]),
  async (kind) => {
    const frame = await setup()
    const { host, editor } = await frame.begin()
    act(() => editor.commands.insertContent("a"))
    await frame.echo(frame.snapshots[0])
    fireEvent.keyDown(host, { key: "Escape" })
    await frame.echo(
      frame.external({
        ...(kind === "epoch" ? { contentEpoch: 1 } : {}),
        slices:
          kind === "removed"
            ? []
            : (frame.parent().slices.map((slice) => ({
                ...slice,
                ...(kind === "disabled" ? { enabled: false } : {}),
                primary: { ...slice.primary, title: titleDoc("External") },
              })) as Slice[]),
      })
    )
    await frame.deliver(-1)
    const display = frame.view.container.textContent
    await frame.deliver(0)
    await frame.echo(frame.snapshots[0])
    await frame.deliver(-1)
    expect(frame.view.container.textContent).toBe(display)
    expect(frame.accepted).toHaveBeenCalledOnce()
    expect(frame.actual.hasActiveSession()).toBe(false)
  }
)

it("NEW R1 same-draft context inputs advance transport ordering without rolling back content", sliceProfile(["hero-agency"]), async () => {
  const frame = await setup()
  const { host, editor } = await frame.begin()
  for (const char of ["a", "b", "c"]) {
    act(() => editor.commands.insertContent(char))
    await frame.echo(frame.snapshots.at(-1)!)
  }
  fireEvent.keyDown(host, { key: "Escape" })
  await frame.echo(
    frame.external({ mode: "dark", inlineEditingEnabled: false }, false)
  )
  await frame.deliver(-1)
  expect(frame.heading()).toBe("Firstabc")
  fireEvent.click(
    frame.view.container.querySelector('[data-preview-field="primary.title"]')!
  )
  expect(frame.view.queryByRole("textbox")).toBeNull()
  await frame.deliver(0)
  expect(frame.heading()).toBe("Firstabc")
  await frame.echo(frame.external({ inlineEditingEnabled: true }, false))
  await frame.deliver(-1)
  const next = await frame.begin()
  act(() => next.editor.commands.insertContent("d"))
  await frame.deliver(0)
  expect(frame.view.getByRole("textbox")).toBe(next.host)
  expect(next.editor.getText()).toBe("Firstabcd")
  expect(frame.accepted).toHaveBeenCalledTimes(4)
  expect(frame.conflict).not.toHaveBeenCalled()
})

it("NEW R1 authorized new generation admits lower ordering while old-generation inputs stay refused", sliceProfile(["hero-agency"]), async () => {
  const frame = await setup()
  const { host, editor } = await frame.begin()
  act(() => editor.commands.insertContent("a"))
  await frame.echo(frame.snapshots[0])
  fireEvent.keyDown(host, { key: "Escape" })
  await frame.deliver(0)
  const old = frame.queued[0]
  frame.view.unmount()
  const fresh = render(<LivePreviewFrameRuntime {...frame.props} />)
  const bridge = (window as LiveFrameWindow).__formulacmsLiveFrame!
  expect(bridge.generation).not.toBe(frame.actual.generation)
  const callbacks = {
    selectSlice: vi.fn(),
    selectField: vi.fn(),
    commit: vi.fn(),
    change: vi.fn(),
    conflict: vi.fn(),
    save: vi.fn(),
    unavailable: vi.fn(),
    context: vi.fn(),
  }
  const initial = {
    ...frame.parent(),
    slices: frame.parent().slices.map((slice) => ({
      ...slice,
      primary: { ...slice.primary, title: titleDoc("New generation") },
    })) as Slice[],
    ordering: {
      draftRevision: 0,
      inputRevision: 0,
      generation: bridge.generation,
    },
  }
  act(() => expect(bridge.connect(initial, callbacks)).toBe(true))
  expect(titleField(fresh.container)?.textContent).toBe("New generation")
  act(() => {
    expect(bridge.replaceInput(old)).toBe(false)
    expect(frame.actual.replaceInput(old)).toBe(false)
    expect(
      bridge.replaceInput({
        ...initial,
        sessionId: "claimed-other",
        ordering: {
          draftRevision: 10,
          inputRevision: 10,
          generation: "claimed-other",
        },
      })
    ).toBe(false)
  })
  expect(titleField(fresh.container)?.textContent).toBe("New generation")
})

it("NEW R1 same-bridge reconnect cannot reset watermarks or downgrade ordered input", sliceProfile(["hero-agency"]), async () => {
  const frame = await setup()
  const { host, editor } = await frame.begin()
  act(() => editor.commands.insertContent("a"))
  await frame.echo(frame.snapshots[0])
  fireEvent.keyDown(host, { key: "Escape" })
  await frame.deliver(0)
  const old = frame.queued[0]
  await frame.echo(frame.external({ title: "New transport context" }, false))
  await frame.deliver(-1)
  const callbacks = {
    selectSlice: vi.fn(),
    selectField: vi.fn(),
    commit: vi.fn(),
    change: vi.fn(),
    conflict: vi.fn(),
    save: vi.fn(),
    unavailable: vi.fn(),
    context: vi.fn(),
  }
  act(() => {
    expect(frame.actual.connect(old, callbacks)).toBe(false)
    expect(frame.actual.replaceInput(old)).toBe(false)
    expect(frame.actual.replaceInput({ ...old, ordering: undefined })).toBe(
      false
    )
  })
  expect(frame.heading()).toBe("Firsta")
  // The failed reconnect must not take over callbacks from the live parent.
  const next = await frame.begin()
  act(() => next.editor.commands.insertContent("b"))
  expect(frame.accepted).toHaveBeenCalledTimes(2)
  expect(callbacks.commit).not.toHaveBeenCalled()
})

it("NEW R1 a new authoritative historical array remains an external conflict while active", sliceProfile(["hero-agency"]), async () => {
  const frame = await setup()
  const { host, editor } = await frame.begin()
  for (const char of ["a", "b", "c"]) {
    act(() => editor.commands.insertContent(char))
    await frame.echo(frame.snapshots.at(-1)!)
  }
  // Reusing an old helper output with a NEW authoritative revision is an Undo/external update, not an old own echo.
  await frame.echo(frame.external({ slices: frame.snapshots[0].slices }))
  await frame.deliver(-1)
  expect(frame.conflict).toHaveBeenCalled()
  act(() => editor.commands.insertContent("d"))
  expect(frame.accepted).toHaveBeenCalledTimes(3)
  await frame.deliver(2)
  expect(editor.getText()).toBe("Firstabcd")
  expect(frame.parent().slices[0].primary).toMatchObject({
    title: titleDoc("Firsta"),
  })
  fireEvent.keyDown(host, { key: "Escape" })
  expect(frame.heading()).toBe("Firsta")
  expect(frame.actual.hasActiveSession()).toBe(false)
})

const W64 = "z".repeat(64)
const withTitle = (frame: Awaited<ReturnType<typeof setup>>, text: string) =>
  frame.parent().slices.map((slice) => ({
    ...slice,
    primary: { ...slice.primary, title: titleDoc(text) },
  })) as Slice[]

it("an open, unedited preview title session yields to a same-field form edit without a conflict", sliceProfile(["hero-agency"]), async () => {
  const frame = await setup()
  await frame.echo(frame.external({ slices: withTitle(frame, W64) }))
  await frame.deliver(-1)
  await frame.begin()
  for (const copies of [2, 3]) {
    await frame.echo(
      frame.external({ slices: withTitle(frame, W64.repeat(copies)) })
    )
    await frame.deliver(-1)
  }
  expect(frame.conflict).not.toHaveBeenCalled()
  expect(frame.heading()).toBe(W64.repeat(3))
  expect(frame.actual.hasActiveSession()).toBe(false)
  expect(frame.controller.handle.capture()).toBeNull()
})

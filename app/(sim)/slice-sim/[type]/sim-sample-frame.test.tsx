import { sliceProfile } from "@/test-utils/slice-profile"
import { act, cloneElement, type ReactElement } from "react"
import { renderToString } from "react-dom/server"
import { hydrateRoot } from "react-dom/client"
import { fireEvent, render, waitFor } from "@testing-library/react"
import { afterAll, afterEach, beforeAll, expect, test, vi } from "vitest"
import { createSampleSlice } from "@/lib/slices/sample"
import { resolvePageOutline } from "@/lib/slices/page-outline"
import { FaqSimple } from "@/components/slices/faq-simple"
import { FeaturesIconGrid } from "@/components/slices/features-icon-grid"
import { buildSamplePresets } from "./sim-sample-presets"
import { richTextToPlainText } from "@/convex/lib/richtext/pmText"
import { HeroAgency } from "@/components/slices/hero-agency"
import type { FaqSimpleSlice } from "@/convex/lib/slices/faqSimple"
import type { SliceRenderContext } from "@/lib/slices/links"
import { currentSimBridge, type SimEdit } from "./sim-frame-bridge"
vi.mock("@/components/slices/slice-sim-registry", () => ({
  SLICE_SIM_COMPONENTS: {
    "features-icon-grid": (
      slice: Parameters<typeof FeaturesIconGrid>[0]["slice"],
      ctx: SliceRenderContext
    ) => (
      <FeaturesIconGrid
        slice={slice}
        ctx={{
          ...ctx,
          previewKitSlice: (rendered) =>
            cloneElement(rendered as ReactElement<Record<string, unknown>>, {
              "data-tweak-loc": "real:source:loc",
              "data-tweak-source": "source-hash",
            }),
        }}
      />
    ),
    "hero-agency": (
      slice: Parameters<typeof HeroAgency>[0]["slice"],
      ctx: SliceRenderContext
    ) => <HeroAgency slice={slice} ctx={ctx} />,
    "faq-simple": (slice: FaqSimpleSlice, ctx: SliceRenderContext) => (
      <FaqSimple
        slice={slice}
        ctx={{
          ...ctx,
          previewKitSlice: (rendered) =>
            cloneElement(rendered as ReactElement<Record<string, unknown>>, {
              "data-tweak-loc": "real:source:loc",
              "data-tweak-source": "source-hash",
            }),
        }}
      />
    ),
  },
}))
vi.mock("./sim-size-reporter", () => ({ SimSizeReporter: () => null }))
import { SimSampleFrame } from "./sim-sample-frame"
const geometry = Object.fromEntries(
  ["getClientRects", "getBoundingClientRect"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(Range.prototype, key),
  ])
)
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
  for (const [key, descriptor] of Object.entries(geometry)) {
    if (descriptor) Object.defineProperty(Range.prototype, key, descriptor)
    else Reflect.deleteProperty(Range.prototype, key)
  }
})
afterEach(() => vi.restoreAllMocks())
function frame() {
  const seed = createSampleSlice("faq-simple")
  const context = { locale: "en", defaultLocale: "en", pagePaths: {} }
  const outline = resolvePageOutline({
    slices: [seed],
    locale: "en",
    mode: "section",
  })
  return (
    <SimSampleFrame
      seed={seed}
      context={context}
      outline={outline}
      targets={[]}
    />
  )
}
test("actual button labels expose editorial hooks while the native bridge refuses internal IDs", sliceProfile([]), () => {
  const seed = createSampleSlice("hero-agency")
  const context = { locale: "en", defaultLocale: "en", pagePaths: {} }
  const outline = resolvePageOutline({
    slices: [seed],
    locale: "en",
    mode: "section",
  })
  const { container } = render(
    <SimSampleFrame
      seed={seed}
      context={context}
      outline={outline}
      targets={[]}
    />
  )
  const bridge = currentSimBridge(window)!
  bridge.connect("parent", {
    change: () => true,
    history: vi.fn(),
    groupEnd: vi.fn(),
    save: vi.fn(),
  })
  const input = {
    generation: bridge.generation,
    sessionId: "parent",
    revision: 1,
    values: { "items.0.id": "injected" },
    selection: null,
    replay: 1,
    reset: 0,
    mode: "edit" as const,
  }
  expect(bridge.replace(input)).toBe(false)
  expect(bridge.fields.some((field) => /\.id$/.test(field.path))).toBe(false)
  expect(container.querySelector('[data-sim-field="items.0.id"]')).toBeNull()
  expect(
    container.querySelector('[data-sim-field="items.0.label"]')
  ).not.toBeNull()
  act(() => {
    expect(
      bridge.replace({
        ...input,
        revision: 2,
        values: { "items.0.label": "A real label" },
      })
    ).toBe(true)
  })
  expect(
    container.querySelector('[data-sim-field="items.0.label"]')
  ).toHaveTextContent("A real label")
})
test("native iframe editor projects real FAQ body and retains its owner through accepted echoes", sliceProfile([]), async () => {
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {})
  const { container } = render(frame())
  const bridge = currentSimBridge(window)!
  const change = vi.fn((edit: SimEdit) => Boolean(edit)),
    history = vi.fn()
  bridge.connect("parent", {
    change,
    history,
    groupEnd: vi.fn(),
    save: vi.fn(),
  })
  const answer = container.querySelector('[data-sim-field="items.0.answer"]')!
  fireEvent.click(answer)
  await waitFor(() => expect(bridge.controller()).not.toBeNull())
  const editor = container.querySelector("[contenteditable]")
  const readyCount = post.mock.calls.filter(
    ([message]) => message.type === "layer-ready"
  ).length
  act(() => {
    bridge.format("heading")
    bridge.flush()
  })
  expect(change).toHaveBeenCalled()
  const edit = change.mock.calls.at(-1)![0]
  expect(JSON.parse(edit.value).content[0].type).toBe("heading")
  act(() => {
    bridge.replace({
      generation: bridge.generation,
      sessionId: "parent",
      revision: 1,
      values: { [edit.path]: edit.value },
      selection: edit.selection,
      replay: 0,
      reset: 0,
      mode: "edit",
    })
  })
  expect(container.querySelector("[contenteditable]")).toBe(editor)
  expect(
    post.mock.calls.filter(([message]) => message.type === "layer-ready")
  ).toHaveLength(readyCount)
  fireEvent.keyDown(editor!, { key: "z", ctrlKey: true })
  expect(history).toHaveBeenLastCalledWith("undo")
  fireEvent(
    editor!,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "historyRedo",
    })
  )
  expect(history).toHaveBeenLastCalledWith("redo")
  fireEvent.keyDown(editor!, { key: "Escape" })
  expect(container.querySelector("[contenteditable]")).toBeNull()
  expect(answer.querySelector("h2,h3,h4,h5,h6")).not.toBeNull()
})
test("Preview commits the native editing session and lets public field clicks proceed; Edit can reopen it", sliceProfile([]), async () => {
  const { container } = render(frame())
  const bridge = currentSimBridge(window)!
  bridge.connect("parent", {
    change: () => true,
    history: vi.fn(),
    groupEnd: vi.fn(),
    save: vi.fn(),
  })
  fireEvent.click(container.querySelector('[data-sim-field="items.0.answer"]')!)
  await waitFor(() => expect(bridge.controller()).not.toBeNull())
  act(() => {
    expect(bridge.flush()).toBe(true)
  })
  const input = {
    generation: bridge.generation,
    sessionId: "parent",
    revision: 1,
    values: {},
    selection: null,
    replay: 1,
    reset: 0,
    mode: "preview" as const,
  }
  act(() => {
    expect(bridge.replace(input)).toBe(true)
  })
  expect(container.querySelector('[contenteditable="true"]')).toBeNull()
  const question = container.querySelector(
    '[data-sim-field="items.0.question"]'
  )!
  expect(fireEvent.click(question)).toBe(true)
  expect(bridge.controller()).toBeNull()
  act(() => {
    expect(bridge.replace({ ...input, revision: 2, mode: "edit" })).toBe(true)
  })
  fireEvent.click(question)
  await waitFor(() => expect(bridge.controller()).not.toBeNull())
})
test("the native client boundary preserves source stamps and hashes byte-for-byte on hydration", sliceProfile([]), async () => {
  const element = frame()
  const host = document.createElement("div")
  host.innerHTML = renderToString(element)
  document.body.append(host)
  const before = [...host.querySelectorAll("[data-tweak-loc]")].map((node) => [
    node.getAttribute("data-tweak-loc"),
    node.getAttribute("data-tweak-source"),
  ])
  let root: ReturnType<typeof hydrateRoot>
  const errors: unknown[] = []
  await act(async () => {
    root = hydrateRoot(host, element, {
      onRecoverableError: (error) => errors.push(error),
    })
  })
  expect(
    [...host.querySelectorAll("[data-tweak-loc]")].map((node) => [
      node.getAttribute("data-tweak-loc"),
      node.getAttribute("data-tweak-source"),
    ])
  ).toEqual(before)
  expect(before).toEqual([["real:source:loc", "source-hash"]])
  expect(errors).toEqual([])
  act(() => root.unmount())
  host.remove()
})

function bufferingFrame(type: "faq-simple" | "features-icon-grid") {
  const seed = createSampleSlice(type)
  const targets = [
    {
      loc: "real:source:loc",
      tag: "section",
      sourceHash: "source-hash",
      sourceClassTokens: [],
      editable: true,
      templateWide: false,
    },
  ]
  return (
    <SimSampleFrame
      seed={seed}
      context={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
      outline={resolvePageOutline({
        slices: [seed],
        locale: "en",
        mode: "section",
      })}
      targets={targets}
    />
  )
}
test("invalid Reset marker refuses the whole input before any accepted mutation", sliceProfile([]), () => {
  render(bufferingFrame("features-icon-grid"))
  const bridge = currentSimBridge(window)!
  bridge.connect("parent", {
    change: () => true,
    history: vi.fn(),
    groupEnd: vi.fn(),
    save: vi.fn(),
  })
  expect(
    bridge.replace({
      generation: bridge.generation,
      sessionId: "parent",
      revision: 1,
      values: {},
      selection: null,
      replay: 0,
      reset: NaN,
      mode: "edit",
    })
  ).toBe(false)
  expect(bridge.acceptedParentRevision).toBe(0)
})
for (const type of ["faq-simple", "features-icon-grid"] as const) {
  test(`${type} projects presets/history without clearing; changed Reset wins and late old flush cannot publish`, sliceProfile([]), async () => {
    const selectOwners: Array<string | null> = []
    const post = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation((message) => {
        if (message.type === "target-select")
          selectOwners.push(currentSimBridge(window)?.editorSessionId() ?? null)
      })
    const { container } = render(bufferingFrame(type))
    const bridge = currentSimBridge(window)!
    const presets = buildSamplePresets(type, bridge.fields)
    const path = type === "faq-simple" ? "items.0.answer" : "items.0.body"
    const sibling = type === "faq-simple" ? "items.0.question" : "items.0.title"
    const change = vi.fn(() => true),
      history = vi.fn()
    let late: ReturnType<typeof bridge.controller> = null
    bridge.connect("parent", {
      change,
      history,
      groupEnd: vi.fn(),
      save: vi.fn(),
      selection: (input) => {
        if (input === null && late) late.flush()
      },
    })
    let revision = 0
    const replace = (
      values: Record<string, string>,
      replay: number,
      reset = 0
    ) =>
      bridge.replace({
        generation: bridge.generation,
        sessionId: "parent",
        revision: ++revision,
        values,
        selection: null,
        replay,
        reset,
        mode: "edit",
      })
    act(() => {
      expect(replace(presets.default, 0)).toBe(true)
    })
    fireEvent.click(container.querySelector(`[data-sim-field="${path}"]`)!)
    await waitFor(() => expect(bridge.controller()).not.toBeNull())
    expect(selectOwners[0]).toBeNull()
    const owner = bridge.controller(),
      editor = container.querySelector("[contenteditable]")
    const original = richTextToPlainText(presets.default[sibling])
    expect(original).not.toBe("")
    post.mockClear()
    for (const [index, values] of [
      presets.french,
      presets.default,
      presets.french,
      presets.french,
    ].entries()) {
      act(() => {
        expect(replace(values, index + 1)).toBe(true)
      })
      expect(bridge.controller()).toBe(owner)
      expect(container.querySelector("[contenteditable]")).toBe(editor)
      expect(
        container.querySelector(`[data-sim-field="${sibling}"]`)
      ).toHaveTextContent(richTextToPlainText(values[sibling]))
      expect(
        post.mock.calls.filter(([message]) => message.type === "target-clear")
      ).toHaveLength(0)
    }
    change.mockClear()
    history.mockClear()
    late = owner
    act(() => {
      expect(replace(presets.default, 5, 1)).toBe(true)
    })
    expect(bridge.controller()).toBeNull()
    expect(bridge.editorSessionId()).toBeNull()
    expect(container.querySelector("[contenteditable]")).toBeNull()
    expect(change).not.toHaveBeenCalled()
    expect(history).not.toHaveBeenCalled()
    for (const field of bridge.fields) {
      const host = container.querySelector(`[data-sim-field="${field.path}"]`)
      if (host)
        expect(host).toHaveTextContent(
          field.contract === "plain"
            ? presets.default[field.path]
            : richTextToPlainText(presets.default[field.path])
        )
    }
    expect(
      post.mock.calls.filter(([message]) => message.type === "target-clear")
        .length
    ).toBe(0)
    late = null
    fireEvent.click(container.querySelector(`[data-sim-field="${path}"]`)!)
    await waitFor(() => expect(bridge.controller()).not.toBeNull())
    expect(bridge.controller()).not.toBe(owner)
  })
  test(`${type} no-op Reset preserves native session and source selection`, sliceProfile([]), async () => {
    const post = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation(() => {})
    const { container } = render(bufferingFrame(type))
    const bridge = currentSimBridge(window)!,
      values = buildSamplePresets(type, bridge.fields).default
    bridge.connect("parent", {
      change: () => true,
      history: vi.fn(),
      groupEnd: vi.fn(),
      save: vi.fn(),
    })
    const input = {
      generation: bridge.generation,
      sessionId: "parent",
      revision: 1,
      values,
      selection: null,
      replay: 0,
      reset: 0,
      mode: "edit" as const,
    }
    act(() => {
      bridge.replace(input)
    })
    const path = type === "faq-simple" ? "items.0.answer" : "items.0.body"
    fireEvent.click(container.querySelector(`[data-sim-field="${path}"]`)!)
    await waitFor(() => expect(bridge.controller()).not.toBeNull())
    const owner = bridge.controller(),
      editor = container.querySelector("[contenteditable]")
    post.mockClear()
    act(() => {
      expect(
        bridge.replace({ ...input, revision: 2, replay: 1, reset: 1 })
      ).toBe(true)
    })
    expect(bridge.controller()).toBe(owner)
    expect(container.querySelector("[contenteditable]")).toBe(editor)
    expect(
      post.mock.calls.filter(([message]) => message.type === "target-clear")
    ).toHaveLength(0)
  })
  test(`${type} changed accepted native text ends on Reset without clearing selected path`, sliceProfile([]), async () => {
    const post = vi
      .spyOn(window.parent, "postMessage")
      .mockImplementation(() => {})
    const { container } = render(bufferingFrame(type))
    const bridge = currentSimBridge(window)!,
      values = buildSamplePresets(type, bridge.fields).default
    const change = vi.fn(() => true)
    bridge.connect("parent", {
      change,
      history: vi.fn(),
      groupEnd: vi.fn(),
      save: vi.fn(),
    })
    const input = {
      generation: bridge.generation,
      sessionId: "parent",
      revision: 1,
      values,
      selection: null,
      replay: 0,
      reset: 0,
      mode: "edit" as const,
    }
    act(() => {
      bridge.replace(input)
    })
    const path = type === "faq-simple" ? "items.0.answer" : "items.0.body"
    fireEvent.click(container.querySelector(`[data-sim-field="${path}"]`)!)
    await waitFor(() => expect(bridge.controller()).not.toBeNull())
    // Ensure an actual accepted text/mark difference, without relying on frozen JSX.
    act(() => {
      bridge.controller()!.format("bold", { from: 1, to: 2 })
    })
    expect(change).toHaveBeenCalled()
    change.mockClear()
    post.mockClear()
    act(() => {
      expect(
        bridge.replace({ ...input, revision: 2, replay: 1, reset: 1 })
      ).toBe(true)
    })
    expect(bridge.controller()).toBeNull()
    expect(change).not.toHaveBeenCalled()
    expect(
      post.mock.calls.filter(([message]) => message.type === "target-clear")
        .length
    ).toBe(0)
  })
}

test("live projection refuses stale/spoofed/invalid Reset and survives actual frame generation replacement", sliceProfile([]), async () => {
  const { container, unmount } = render(bufferingFrame("features-icon-grid"))
  const bridge = currentSimBridge(window)!,
    presets = buildSamplePresets("features-icon-grid", bridge.fields)
  bridge.connect("parent", {
    change: () => true,
    history: vi.fn(),
    groupEnd: vi.fn(),
    save: vi.fn(),
  })
  const input = {
    generation: bridge.generation,
    sessionId: "parent",
    revision: 1,
    values: presets.default,
    selection: null,
    replay: 0,
    reset: 0,
    mode: "edit" as const,
  }
  act(() => {
    bridge.replace(input)
  })
  fireEvent.click(container.querySelector('[data-sim-field="items.0.body"]')!)
  await waitFor(() => expect(bridge.controller()).not.toBeNull())
  const owner = bridge.controller()
  act(() => {
    expect(
      bridge.replace({
        ...input,
        revision: 2,
        values: presets.french,
        replay: 1,
      })
    ).toBe(true)
  })
  const sibling = container.querySelector('[data-sim-field="items.0.title"]')!
  expect(sibling).toHaveTextContent(
    richTextToPlainText(presets.french["items.0.title"])
  )
  for (const extra of [
    { generation: "wrong" },
    { sessionId: "wrong" },
    { revision: 2 },
    { reset: NaN },
    { reset: Infinity },
    { reset: 1.5 },
    { reset: undefined as unknown as number },
    { values: { "items.0.id": "bad" } },
  ]) {
    act(() => {
      expect(
        bridge.replace({
          ...input,
          revision: 3,
          values: presets.french,
          replay: 2,
          reset: 1,
          ...extra,
        })
      ).toBe(false)
    })
    expect(bridge.acceptedParentRevision).toBe(2)
    expect(bridge.controller()).toBe(owner)
    expect(sibling).toHaveTextContent(
      richTextToPlainText(presets.french["items.0.title"])
    )
  }
  fireEvent.keyDown(document, { key: "Escape" })
  expect(
    container.querySelector('[data-sim-field="items.0.title"]')
  ).toHaveTextContent(richTextToPlainText(presets.french["items.0.title"]))
  unmount()
  const second = render(bufferingFrame("features-icon-grid")),
    next = currentSimBridge(window)!
  next.connect("parent", {
    change: () => true,
    history: vi.fn(),
    groupEnd: vi.fn(),
    save: vi.fn(),
  })
  act(() => {
    expect(
      next.replace({
        ...input,
        generation: next.generation,
        revision: 1,
        values: presets.french,
        reset: 9,
      })
    ).toBe(true)
  })
  expect(next.generation).not.toBe(bridge.generation)
  expect(next.controller()).toBeNull()
  expect(
    second.container.querySelector('[data-sim-field="items.0.title"]')
  ).toHaveTextContent(richTextToPlainText(presets.french["items.0.title"]))
})

// R1 P2 class guards use the stamped public renderer and real native controller.
// Replay seeds an ordinary document through the existing controller seam; flush
// exercises the same accepted-change callback as native editing.
function boundaryFrame(type: "faq-simple" | "features-icon-grid") {
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {})
  const { container } = render(bufferingFrame(type))
  const bridge = currentSimBridge(window)!
  const presets = buildSamplePresets(type, bridge.fields)
  const path = type === "faq-simple" ? "items.0.answer" : "items.0.body"
  const sibling = type === "faq-simple" ? "items.0.question" : "items.0.title"
  const change = vi.fn((edit: SimEdit) => Boolean(edit)),
    selection = vi.fn()
  bridge.connect("parent", {
    change,
    selection,
    history: vi.fn(),
    groupEnd: vi.fn(),
    save: vi.fn(),
  })
  let revision = 0
  const replace = (
    values = presets.default,
    mode: "edit" | "preview" = "edit",
    reset = 0
  ) =>
    bridge.replace({
      generation: bridge.generation,
      sessionId: "parent",
      revision: ++revision,
      values,
      selection: null,
      replay: 0,
      reset,
      mode,
    })
  act(() => {
    expect(replace()).toBe(true)
  })
  const host = (field = path) =>
    container.querySelector(`[data-sim-field="${field}"]`)!
  const appearance = () =>
    [...container.querySelectorAll("[data-tweak-loc]")].map((node) => [
      node.getAttribute("class"),
      node.getAttribute("style"),
    ])
  const originalAppearance = appearance()
  const editedText = "Accepted boundary text"
  const editedValue = JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: editedText }] },
    ],
  })
  const open = async () => {
    fireEvent.click(host())
    await waitFor(() => expect(bridge.controller()).not.toBeNull())
    expect(
      post.mock.calls.some(([message]) => message.type === "target-select")
    ).toBe(true)
    return bridge.controller()!
  }
  const edit = (flush = true) => {
    const owner = bridge.controller()!
    act(() => {
      owner.replay(editedValue)
      if (flush) owner.flush()
    })
    if (flush)
      expect(change.mock.calls.at(-1)?.[0]).toMatchObject({
        path,
        value: editedValue,
      })
  }
  const settled = () => {
    expect(appearance()).toEqual(originalAppearance)
    expect(
      post.mock.calls.some(([message]) => message.type === "target-clear")
    ).toBe(false)
  }
  return {
    container,
    bridge,
    presets,
    path,
    sibling,
    change,
    selection,
    post,
    replace,
    host,
    editedText,
    editedValue,
    open,
    edit,
    settled,
  }
}
for (const type of ["faq-simple", "features-icon-grid"] as const) {
  test(`R1 P2 newguard ${type} edited A to B publishes A and retains B native owner`, sliceProfile([]), async () => {
    const h = boundaryFrame(type)
    const old = await h.open()
    h.edit()
    h.post.mockClear()
    fireEvent.click(h.host(h.sibling))
    await waitFor(() => expect(h.bridge.controller()).not.toBe(old))
    expect(h.host()).toHaveTextContent(h.editedText)
    expect(h.host().querySelector("[contenteditable]")).toBeNull()
    expect(h.host(h.sibling).querySelector("[contenteditable]")).not.toBeNull()
    expect(h.selection.mock.calls.at(-1)?.[0]).toMatchObject({
      path: h.sibling,
      editorSessionId: h.bridge.editorSessionId(),
    })
    h.settled()
  })
  test(`R1 P2 newguard ${type} Preview publishes newly flushed A over an older incoming echo`, sliceProfile([]), async () => {
    const h = boundaryFrame(type)
    await h.open()
    h.edit(false)
    h.post.mockClear()
    act(() => {
      expect(h.replace(h.presets.default, "preview")).toBe(true)
    })
    expect(h.change.mock.calls.at(-1)?.[0]).toMatchObject({
      path: h.path,
      value: h.editedValue,
    })
    expect(h.host()).toHaveTextContent(h.editedText)
    expect(h.bridge.controller()).toBeNull()
    expect(h.bridge.editorSessionId()).toBeNull()
    expect(h.container.querySelector("[contenteditable]")).toBeNull()
    expect(fireEvent.click(h.host(h.sibling))).toBe(true)
    expect(h.bridge.controller()).toBeNull()
    h.settled()
  })
  for (const end of ["blur", "Escape"] as const) {
    test(`R1 P2 newguard ${type} ${end} completion publishes accepted A`, sliceProfile([]), async () => {
      const h = boundaryFrame(type)
      await h.open()
      h.edit()
      const editor = h.container.querySelector("[contenteditable]")!
      h.post.mockClear()
      if (end === "blur")
        fireEvent.blur(editor, { relatedTarget: h.host(h.sibling) })
      else fireEvent.keyDown(editor, { key: "Escape" })
      expect(h.host()).toHaveTextContent(h.editedText)
      expect(h.bridge.controller()).toBeNull()
      expect(h.bridge.editorSessionId()).toBeNull()
      expect(h.container.querySelector("[contenteditable]")).toBeNull()
      h.settled()
    })
  }
  test(`R1 P2 newguard ${type} late A flush cannot replace B ownership or accepted canvas`, sliceProfile([]), async () => {
    const h = boundaryFrame(type)
    const old = await h.open()
    h.edit()
    fireEvent.click(h.host(h.sibling))
    await waitFor(() => expect(h.bridge.controller()).not.toBe(old))
    const owner = h.bridge.controller(),
      session = h.bridge.editorSessionId()
    h.change.mockClear()
    h.selection.mockClear()
    act(() => {
      old.flush()
    })
    expect(h.change).not.toHaveBeenCalled()
    expect(h.selection).not.toHaveBeenCalled()
    expect(h.bridge.controller()).toBe(owner)
    expect(h.bridge.editorSessionId()).toBe(session)
    expect(h.host(h.sibling).querySelector("[contenteditable]")).not.toBeNull()
    expect(h.host()).toHaveTextContent(h.editedText)
    h.settled()
  })
  test(`R1 P2 newguard ${type} changed Reset discards old native document and publishes incoming values`, sliceProfile([]), async () => {
    const h = boundaryFrame(type)
    const old = await h.open()
    h.edit(false)
    h.change.mockClear()
    h.post.mockClear()
    act(() => {
      expect(h.replace(h.presets.french, "edit", 1)).toBe(true)
    })
    expect(h.change).not.toHaveBeenCalled()
    expect(h.bridge.controller()).toBeNull()
    expect(h.bridge.editorSessionId()).toBeNull()
    expect(h.host()).toHaveTextContent(
      richTextToPlainText(h.presets.french[h.path])
    )
    expect(h.host()).not.toHaveTextContent(h.editedText)
    act(() => {
      old.flush()
    })
    expect(h.change).not.toHaveBeenCalled()
    expect(h.host()).toHaveTextContent(
      richTextToPlainText(h.presets.french[h.path])
    )
    h.settled()
  })
  test(`R1 P2 newguard ${type} no-op Reset keeps native owner and source selection`, sliceProfile([]), async () => {
    const h = boundaryFrame(type)
    const owner = await h.open(),
      session = h.bridge.editorSessionId()
    const editor = h.container.querySelector("[contenteditable]")
    h.post.mockClear()
    act(() => {
      expect(h.replace(h.presets.default, "edit", 1)).toBe(true)
    })
    expect(h.bridge.controller()).toBe(owner)
    expect(h.bridge.editorSessionId()).toBe(session)
    expect(h.container.querySelector("[contenteditable]")).toBe(editor)
    expect(
      h.post.mock.calls.filter(([message]) => message.type === "target-clear")
    ).toHaveLength(0)
  })
  test(`R1 P2 newguard ${type} Preview preserves live projection with no active native editor`, sliceProfile([]), () => {
    const h = boundaryFrame(type)
    // Pick the stamped source root itself, without clicking an editable field.
    fireEvent.click(h.container.querySelector("[data-tweak-loc]")!)
    expect(
      h.post.mock.calls.some(([message]) => message.type === "target-select")
    ).toBe(true)
    expect(h.bridge.controller()).toBeNull()
    act(() => {
      expect(h.replace(h.presets.french)).toBe(true)
    })
    expect(h.host()).toHaveTextContent(
      richTextToPlainText(h.presets.french[h.path])
    )
    h.post.mockClear()
    act(() => {
      expect(h.replace(h.presets.french, "preview")).toBe(true)
    })
    expect(h.host()).toHaveTextContent(
      richTextToPlainText(h.presets.french[h.path])
    )
    expect(h.bridge.controller()).toBeNull()
    expect(h.bridge.editorSessionId()).toBeNull()
    h.settled()
  })
}

test("transport acceptance does not acknowledge replacement before projected DOM commit", sliceProfile([]), () => {
  const post = vi
    .spyOn(window.parent, "postMessage")
    .mockImplementation(() => {})
  try {
    const mounted = render(frame())
    const bridge = currentSimBridge(window)!
    bridge.connect("parent", {
      change: () => true,
      history: vi.fn(),
      groupEnd: vi.fn(),
      save: vi.fn(),
    })
    const field = bridge.fields.find(
      (field) => field.path === "primary.heading"
    )!
    const text = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Committed heading" }],
        },
      ],
    })
    post.mockClear()
    act(() => {
      expect(
        bridge.replace({
          generation: bridge.generation,
          sessionId: "parent",
          revision: 7,
          values: { [field.path]: text },
          selection: null,
          replay: 0,
          reset: 0,
          mode: "edit",
        })
      ).toBe(true)
      expect(bridge.acceptedParentRevision).toBe(7)
      expect(bridge.lastReplaceRevision).toBe(7)
      expect(bridge.appliedRevision).toBe(0)
      expect(mounted.container).not.toHaveTextContent("Committed heading")
      expect(
        post.mock.calls.filter(
          ([message]) => message.type === "samples-applied"
        )
      ).toHaveLength(0)
    })
    expect(mounted.container).toHaveTextContent("Committed heading")
    expect(bridge.appliedRevision).toBe(7)
    expect(post).toHaveBeenCalledWith(
      expect.objectContaining({ type: "samples-applied", appliedRevision: 7 }),
      window.location.origin
    )
  } finally {
    post.mockRestore()
  }
})

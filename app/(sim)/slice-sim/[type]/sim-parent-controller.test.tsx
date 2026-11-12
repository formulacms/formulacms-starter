import { sliceProfile } from "@/test-utils/slice-profile"
import { act, useLayoutEffect } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import { SIM_FRAME_CONNECTED, type SimFrameWindow } from "./sim-frame-bridge"
import { installSimTestBridge } from "./sim-frame-test-support"
vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: vi.fn(),
  undoSpacingBatchAction: vi.fn(),
}))
import { VisualTweakProvider, useVisualTweak } from "./visual-tweak-store"
afterEach(() => {
  delete (window as SimFrameWindow).__formulacmsSimFrame
})
const target = {
  loc: "loc",
  tag: "section",
  sourceHash: "before",
  sourceClassTokens: ["pt-4"],
  editable: true,
  templateWide: false,
  label: "Section",
  path: "",
}
function Harness() {
  const state = useVisualTweak()
  return (
    <>
      <input aria-label="Draft" />
      <button
        onClick={() =>
          state.setEdit("loc", "pt", { target, suffix: "8", valueRem: 2 })
        }
      >
        Nudge
      </button>
      <output>{state.editCount}</output>
      <button onClick={state.discard}>Discard</button>
    </>
  )
}
function SavedAbsenceHarness() {
  const state = useVisualTweak()
  return (
    <>
      <button
        onClick={() =>
          state.setEdit("loc", "pt", {
            target: {
              ...target,
              sourcePath: "jsx.0",
              sourceClassTokens: ["bg-surface"],
            },
            suffix: "8",
            valueRem: 2,
          })
        }
      >
        Add absent axis
      </button>
      <button onClick={state.save}>Save batch</button>
      <button onClick={state.undo}>Undo batch</button>
      <output aria-label="Pending batch">{JSON.stringify(state.edits)}</output>
      <output aria-label="Blocked batch">{state.blockedReason}</output>
    </>
  )
}
test.each([true, false])(
  "provider removal ownership consumes returned Save diffs (evidence=%s)", sliceProfile([]),
  async (evidence) => {
    const { applySpacingBatchAction } = await import("./read-renderer-source")
    const save = vi.mocked(applySpacingBatchAction)
    save.mockReset()
    window.sessionStorage.clear()
    save.mockResolvedValueOnce({
      ok: true,
      applied: 1,
      skipped: 0,
      results: [
        { id: JSON.stringify(["loc", "all", "spacing:pt"]), status: "applied" },
      ],
      files: [],
      version: 1,
      checkpointId: "save",
      sourceHash: "after",
      targets: [
        {
          ...target,
          loc: "new-loc",
          sourcePath: "jsx.0",
          sourceHash: "after",
          sourceClassTokens: ["bg-surface", "pt-8"],
        },
      ],
      diffs: evidence
        ? [
            {
              target: "loc",
              tag: "section",
              scope: "all",
              group: "spacing:pt",
              before: "bg-surface",
              after: "bg-surface pt-8",
            },
          ]
        : [],
    })
    save.mockResolvedValueOnce({
      ok: false,
      error: "test stops after observing the request",
    })
    render(
      <VisualTweakProvider type="hero-agency" view="desktop">
        <SavedAbsenceHarness />
      </VisualTweakProvider>
    )
    fireEvent.click(screen.getByText("Add absent axis"))
    fireEvent.click(screen.getByText("Save batch"))
    await waitFor(() =>
      expect(screen.getByLabelText("Pending batch")).toHaveTextContent("{}")
    )
    fireEvent.click(screen.getByText("Undo batch"))
    expect(screen.getByLabelText("Pending batch")).toHaveTextContent(
      '"remove":true'
    )
    fireEvent.click(screen.getByText("Save batch"))
    if (evidence) {
      await waitFor(() => expect(save).toHaveBeenCalledTimes(2))
      expect(save.mock.calls[1][0]).toMatchObject({
        edits: [
          {
            kind: "class.remove",
            target: "new-loc",
            expected: "pt-8",
            sourceHash: "after",
            scope: "all",
            group: "spacing:pt",
            postcondition: { kind: "class-absent" },
          },
        ],
      })
      expect(save.mock.calls[1][0].edits[0]).not.toHaveProperty("next")
    } else {
      expect(save).toHaveBeenCalledTimes(1)
      expect(screen.getByLabelText("Blocked batch")).toHaveTextContent(
        "diff evidence"
      )
    }
  }
)
test("parent keyboard and beforeinput share history, and operations require successful flush acknowledgement", sliceProfile([]), () => {
  window.sessionStorage.clear()
  render(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <Harness />
    </VisualTweakProvider>
  )
  const bridge = installSimTestBridge(window)
  bridge.flush = vi.fn(() => true)
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  fireEvent.click(screen.getByText("Nudge"))
  expect(screen.getByRole("status")).toHaveTextContent("1")
  fireEvent.keyDown(screen.getByLabelText("Draft"), { key: "z", ctrlKey: true })
  expect(screen.getByRole("status")).toHaveTextContent("0")
  fireEvent(
    screen.getByLabelText("Draft"),
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "historyRedo",
    })
  )
  expect(screen.getByRole("status")).toHaveTextContent("1")
  bridge.flush = vi.fn(() => false)
  fireEvent.click(screen.getByText("Discard"))
  expect(screen.getByRole("status")).toHaveTextContent("1")
  expect(bridge.flush).toHaveBeenCalled()
})

function SampleHarness() {
  const state = useVisualTweak()
  return <output aria-label="Samples">{JSON.stringify(state.samples)}</output>
}
test("parent accepts only current editor revisions and sample undo never calls appearance writers", sliceProfile([]), async () => {
  const { sampleFields } = await import("./sim-sample-state")
  const { createSampleSlice } = await import("@/lib/slices/sample")
  const { applySpacingBatchAction, undoSpacingBatchAction } =
    await import("./read-renderer-source")
  const bridge = installSimTestBridge(window)
  bridge.fields = sampleFields(createSampleSlice("hero-agency"))
  bridge.editorSessionId = () => "active"
  let callbacks: import("./sim-frame-bridge").SimFrameCallbacks | null = null
  bridge.connect = vi.fn((sessionId, next) => {
    bridge.sessionId = sessionId
    callbacks = next
  })
  vi.clearAllMocks()
  window.sessionStorage.clear()
  render(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <SampleHarness />
    </VisualTweakProvider>
  )
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  const edit = {
    generation: bridge.generation,
    sessionId: bridge.sessionId,
    editorSessionId: "active",
    revision: 1,
    path: "primary.eyebrow",
    value: "New sample",
    selection: null,
  }
  act(() => {
    expect(callbacks!.change(edit)).toBe(true)
  })
  expect(screen.getByLabelText("Samples")).toHaveTextContent("New sample")
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  expect(bridge.connect).toHaveBeenCalledTimes(1)
  for (const changed of [
    { revision: 1 },
    { generation: "old" },
    { sessionId: "old" },
    { editorSessionId: "other" },
    { path: "primary.notAllowed" },
    { path: "items.0.id" },
  ]) {
    expect(callbacks!.change({ ...edit, revision: 2, ...changed })).toBe(false)
  }
  fireEvent.keyDown(document.body, { key: "z", ctrlKey: true })
  expect(screen.getByLabelText("Samples")).not.toHaveTextContent("New sample")
  fireEvent(
    document.body,
    new InputEvent("beforeinput", {
      bubbles: true,
      cancelable: true,
      inputType: "historyRedo",
    })
  )
  expect(screen.getByLabelText("Samples")).toHaveTextContent("New sample")
  bridge.current = () => false
  expect(callbacks!.change({ ...edit, revision: 2 })).toBe(false)
  expect(applySpacingBatchAction).not.toHaveBeenCalled()
  expect(undoSpacingBatchAction).not.toHaveBeenCalled()
})
test("an unresolved stored draft remains visible and persisted while actual Save and preview fail closed", sliceProfile([]), async () => {
  const { VisualTweakSaveBar } = await import("./slice-tweak-inspector")
  const { SLICE_REAPPLY_EVENT } = await import("./slice-preview")
  const { applySpacingBatchAction } = await import("./read-renderer-source")
  vi.clearAllMocks()
  const stored = {
    all: { loc: { pt: { target, suffix: "8", valueRem: 2 } } },
    "below-sm": {},
    "sm-and-up": {},
  }
  window.sessionStorage.setItem(
    "nextcms:vt-batch:hero-agency",
    JSON.stringify(stored)
  )
  const reapply: unknown[] = []
  const listener = (event: Event) =>
    reapply.push((event as CustomEvent).detail.edits)
  window.addEventListener(SLICE_REAPPLY_EVENT, listener)
  const bridge = installSimTestBridge(window)
  bridge.targets = [{ ...target, sourcePath: "jsx.0", sourceHash: "different" }]
  try {
    render(
      <VisualTweakProvider type="hero-agency" view="desktop">
        <VisualTweakSaveBar compact />
      </VisualTweakProvider>
    )
    act(() =>
      window.dispatchEvent(
        new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
      )
    )
    fireEvent.click(
      screen.getByRole("button", { name: "Review appearance changes" })
    )
    expect(
      screen.getByRole("button", { name: "Save appearance changes" })
    ).toBeDisabled()
    expect(screen.getByRole("alert")).toHaveTextContent(
      /saved draft cannot be matched/i
    )
    fireEvent.keyDown(document.body, { key: "s", ctrlKey: true })
    expect(applySpacingBatchAction).not.toHaveBeenCalled()
    expect(reapply).toEqual(reapply.map(() => []))
    const persisted = JSON.parse(
      window.sessionStorage.getItem("nextcms:vt-batch:hero-agency")!
    )
    expect(Object.values(persisted.all)).toEqual([
      expect.objectContaining({
        pt: expect.objectContaining({
          suffix: "8",
          disabledReason: expect.any(String),
          target: expect.objectContaining({ sourceHash: "before" }),
        }),
      }),
    ])
  } finally {
    window.removeEventListener(SLICE_REAPPLY_EVENT, listener)
  }
})

function ResetMarkerHarness() {
  const state = useVisualTweak()
  return (
    <>
      <button onClick={state.resetSamples}>Reset marker</button>
      <button onClick={() => state.setPreset("french")}>Preset marker</button>
      <button onClick={state.undo}>Undo marker</button>
      <button onClick={state.redo}>Redo marker</button>
      <button onClick={state.discard}>Discard marker</button>
    </>
  )
}
test("provider maps Reset-only monotonic marker and other replays do not advance it", sliceProfile([]), async () => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  const bridge = installSimTestBridge(window)
  const { sampleFields } = await import("./sim-sample-state")
  const { createSampleSlice } = await import("@/lib/slices/sample")
  bridge.fields = sampleFields(createSampleSlice("hero-agency"))
  bridge.connect = (session) => {
    bridge.sessionId = session
  }
  const replace = vi.fn(() => true)
  bridge.replace = replace
  render(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <ResetMarkerHarness />
    </VisualTweakProvider>
  )
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  const latest = () =>
    (
      replace.mock.calls as unknown as [
        import("./sim-frame-bridge").SimFrameInput,
      ][]
    ).at(-1)?.[0]
  await waitFor(() => expect(latest()?.reset).toBe(0))
  fireEvent.click(screen.getByText("Preset marker"))
  expect(latest()?.reset).toBe(0)
  fireEvent.click(screen.getByText("Reset marker"))
  expect(latest()?.reset).toBe(1)
  for (const label of ["Undo marker", "Redo marker", "Discard marker"]) {
    fireEvent.click(screen.getByText(label))
    expect(latest()?.reset).toBe(1)
  }
  fireEvent.click(screen.getByText("Reset marker"))
  expect(latest()?.reset).toBe(2)
})

/** Actual provider/listener/bridge queue, including accepted synchronous flush edits. */
async function orderingHarness() {
  window.sessionStorage.clear()
  window.localStorage.clear()
  const { sampleFields } = await import("./sim-sample-state")
  const { createSampleSlice } = await import("@/lib/slices/sample")
  const bridge = installSimTestBridge(window)
  bridge.fields = sampleFields(createSampleSlice("hero-agency"))
  bridge.editorSessionId = () => "ordering-active"
  let callbacks: import("./sim-frame-bridge").SimFrameCallbacks | null = null
  bridge.connect = (session, next) => {
    bridge.sessionId = session
    callbacks = next
  }
  const trace: string[] = []
  const replace = vi.fn((input: import("./sim-frame-bridge").SimFrameInput) => {
    trace.push(`replace:${input.replay}`)
    return true
  })
  bridge.replace = replace
  let current: ReturnType<typeof useVisualTweak> | null = null
  const captureValue = (value: ReturnType<typeof useVisualTweak>): void => {
    current = value
  }
  function OrderingHarness({
    onValue,
  }: {
    onValue: (value: ReturnType<typeof useVisualTweak>) => void
  }) {
    const value = useVisualTweak()
    useLayoutEffect(() => {
      onValue(value)
    }, [onValue, value])
    return (
      <output aria-label="Shortcut samples">
        {JSON.stringify(value.samples)}
      </output>
    )
  }
  render(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <OrderingHarness onValue={captureValue} />
    </VisualTweakProvider>
  )
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  const state = () => current!
  const latest = () => replace.mock.calls.at(-1)![0]
  const field = bridge.fields.find((field) => field.path === "primary.eyebrow")!
  const initialSamples = state().samples
  const initialText = latest().values[field.path]!
  let revision = 0
  const publish = (value: string) => {
    trace.push(`change:${value}`)
    return callbacks!.change({
      generation: bridge.generation,
      sessionId: bridge.sessionId,
      editorSessionId: "ordering-active",
      revision: ++revision,
      path: field.path,
      value,
      selection: null,
    })
  }
  const shortcut = (init: KeyboardEventInit = {}) => {
    const event = new KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "z",
      ctrlKey: true,
      ...init,
    })
    fireEvent(document.body, event)
    return event
  }
  expect(state().canUndo).toBe(false)
  expect(state().canRedo).toBe(false)
  trace.length = 0
  return {
    bridge,
    trace,
    replace,
    state,
    latest,
    field,
    initialSamples,
    initialText,
    publish,
    shortcut,
    history: (intent: "undo" | "redo") => callbacks!.history(intent),
  }
}

test("Undo flushes a queued native sample while committed past is empty, then restores projected text", sliceProfile([]), async () => {
  const h = await orderingHarness()
  h.bridge.flush = vi.fn(() => {
    h.trace.push("flush:start")
    expect(h.publish("Pending native sample")).toBe(true)
    h.trace.push("flush:end")
    return true
  })
  const beforeReplay = h.latest().replay
  expect(h.shortcut().defaultPrevented).toBe(true)
  expect(h.trace.slice(0, 3)).toEqual([
    "flush:start",
    "change:Pending native sample",
    "flush:end",
  ])
  expect(h.trace).toContain(`replace:${beforeReplay + 1}`)
  expect(h.state().samples).toEqual(h.initialSamples)
  expect(h.latest().values[h.field.path]).toBe(h.initialText)
  expect(h.state().canUndo).toBe(false)
  expect(h.state().canRedo).toBe(true)
})

const historyKeys = [
  { name: "Undo", key: "z", shiftKey: false, redo: false },
  { name: "Shift ModZ", key: "z", shiftKey: true, redo: true },
  { name: "ModY", key: "y", shiftKey: false, redo: true },
]
test.each(historyKeys)(
  "successful empty $name owns default without changing state/history", sliceProfile([]),
  async ({ key, shiftKey }) => {
    const h = await orderingHarness(),
      samples = h.state().samples,
      calls = h.replace.mock.calls.length
    h.bridge.flush = vi.fn(() => true)
    expect(h.shortcut({ key, shiftKey }).defaultPrevented).toBe(true)
    expect(h.bridge.flush).toHaveBeenCalledTimes(1)
    expect(h.state().samples).toBe(samples)
    expect(h.state().canUndo).toBe(false)
    expect(h.state().canRedo).toBe(false)
    expect(h.replace).toHaveBeenCalledTimes(calls)
  }
)
test.each(historyKeys)(
  "refused flush leaves $name default and history untouched", sliceProfile([]),
  async ({ key, shiftKey, redo }) => {
    const h = await orderingHarness()
    act(() => {
      expect(h.publish("Existing sample")).toBe(true)
    })
    if (redo) h.shortcut()
    const samples = h.state().samples,
      canUndo = h.state().canUndo,
      canRedo = h.state().canRedo,
      calls = h.replace.mock.calls.length
    h.bridge.flush = vi.fn(() => false)
    expect(h.shortcut({ key, shiftKey }).defaultPrevented).toBe(false)
    expect(h.bridge.flush).toHaveBeenCalledTimes(1)
    expect(h.state().samples).toBe(samples)
    expect(h.state().canUndo).toBe(canUndo)
    expect(h.state().canRedo).toBe(canRedo)
    expect(h.replace).toHaveBeenCalledTimes(calls)
  }
)
test.each(historyKeys.filter((k) => k.redo))(
  "$name consumes flush-queued fresh future while committed future is empty", sliceProfile([]),
  async ({ key, shiftKey }) => {
    const h = await orderingHarness()
    h.bridge.flush = vi.fn(() => {
      h.trace.push("flush:start")
      expect(h.publish("Queued redo sample")).toBe(true)
      h.history("undo")
      h.trace.push("queued:undo", "flush:end")
      return true
    })
    const beforeReplay = h.latest().replay
    expect(h.shortcut({ key, shiftKey }).defaultPrevented).toBe(true)
    expect(h.trace.slice(0, 4)).toEqual([
      "flush:start",
      "change:Queued redo sample",
      "queued:undo",
      "flush:end",
    ])
    expect(h.latest().replay).toBe(beforeReplay + 2)
    expect(h.latest().values[h.field.path]).toBe("Queued redo sample")
    expect(h.state().samples[h.field.path]).toBe("Queued redo sample")
    expect(h.state().canUndo).toBe(true)
    expect(h.state().canRedo).toBe(false)
  }
)
test.each(historyKeys.filter((k) => k.redo))(
  "canonical no-op flush preserves future for $name", sliceProfile([]),
  async ({ key, shiftKey }) => {
    const h = await orderingHarness()
    act(() => {
      expect(h.publish("Remembered sample")).toBe(true)
    })
    h.shortcut()
    expect(h.state().canRedo).toBe(true)
    h.bridge.flush = vi.fn(() => {
      expect(h.publish(h.initialText)).toBe(true)
      return true
    })
    const beforeReplay = h.latest().replay
    expect(h.shortcut({ key, shiftKey }).defaultPrevented).toBe(true)
    expect(h.latest().values[h.field.path]).toBe("Remembered sample")
    expect(h.state().canUndo).toBe(true)
    expect(h.state().canRedo).toBe(false)
    expect(h.latest().replay).toBe(beforeReplay + 1)
  }
)
test("beforeinput retains flush-first queued Undo and refused-flush default ownership", sliceProfile([]), async () => {
  const h = await orderingHarness()
  h.bridge.flush = vi.fn(() => {
    expect(h.publish("Pending beforeinput sample")).toBe(true)
    return true
  })
  const event = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "historyUndo",
  })
  fireEvent(document.body, event)
  expect(event.defaultPrevented).toBe(true)
  expect(h.latest().values[h.field.path]).toBe(h.initialText)
  expect(h.state().canUndo).toBe(false)
  expect(h.state().canRedo).toBe(true)
  const samples = h.state().samples,
    calls = h.replace.mock.calls.length
  h.bridge.flush = vi.fn(() => false)
  const refused = new InputEvent("beforeinput", {
    bubbles: true,
    cancelable: true,
    inputType: "historyRedo",
  })
  fireEvent(document.body, refused)
  expect(refused.defaultPrevented).toBe(false)
  expect(h.state().samples).toBe(samples)
  expect(h.state().canRedo).toBe(true)
  expect(h.replace).toHaveBeenCalledTimes(calls)
})

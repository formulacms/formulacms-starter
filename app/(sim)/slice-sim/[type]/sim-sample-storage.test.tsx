import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { act, useLayoutEffect } from "react"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"

import { sampleFields, sampleStorageKey } from "./sim-sample-state"
import { buildSamplePresets } from "./sim-sample-presets"
import { installSimTestBridge } from "./sim-frame-test-support"
import {
  SIM_FRAME_CONNECTED,
  type SimFrameCallbacks,
  type SimFrameWindow,
} from "./sim-frame-bridge"
vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: vi.fn(),
  undoSpacingBatchAction: vi.fn(),
}))
import {
  applySpacingBatchAction,
  undoSpacingBatchAction,
} from "./read-renderer-source"
import { VisualTweakProvider, useVisualTweak } from "./visual-tweak-store"
import { SimModeControl, SimSampleControls } from "./sim-sample-controls"
import { VisualTweakSaveBar } from "./visual-tweak-save-bar"
function Values() {
  const state = useVisualTweak()
  return (
    <>
      <output aria-label="Active sample">
        {state.samples["primary.eyebrow"]}
      </output>
      <output aria-label="History available">{String(state.canUndo)}</output>
      <button onClick={state.undo}>Undo sample</button>
      <input aria-label="Ordinary letters" />
      <SimModeControl />
      <SimSampleControls />
    </>
  )
}
afterEach(() => {
  delete (window as SimFrameWindow).__formulacmsSimFrame
  vi.restoreAllMocks()
})
test("history-neutral context changes hydrate separate presentation/locale keys; same-context reconnect preserves live edits and undo", sliceProfile([]), async () => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  const fields = sampleFields(createSampleSlice("hero-agency"))
  const key = (presentation: string, locale: string) =>
    sampleStorageKey("hero-agency", presentation, locale, "default")
  for (const [presentation, locale, value] of [
    ["default", "en", "English"],
    ["centered", "en", "Centered"],
    ["centered", "fr", "Français"],
  ])
    window.localStorage.setItem(
      key(presentation, locale),
      JSON.stringify({ "primary.eyebrow": value })
    )
  const untouched = sampleStorageKey(
    "hero-with-image",
    "default",
    "en",
    "default"
  )
  window.localStorage.setItem(untouched, '{"untouched":"another slice"}')
  let callbacks: SimFrameCallbacks | null = null
  const configure = () => {
    const bridge = installSimTestBridge(window)
    bridge.fields = [...fields]
    bridge.editorSessionId = () => "editor"
    bridge.connect = (id, next) => {
      bridge.sessionId = id
      callbacks = next
    }
    return bridge
  }
  let bridge = configure()
  const tree = (presentation: string, locale: string) => (
    <VisualTweakProvider
      type="hero-agency"
      view="desktop"
      presentation={presentation}
      locale={locale}
    >
      <Values />
    </VisualTweakProvider>
  )
  const mounted = render(tree("default", "en"))
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  await waitFor(() =>
    expect(screen.getByLabelText("Active sample")).toHaveTextContent("English")
  )
  mounted.rerender(tree("centered", "en"))
  await waitFor(() =>
    expect(screen.getByLabelText("Active sample")).toHaveTextContent("Centered")
  )
  mounted.rerender(tree("centered", "fr"))
  await waitFor(() =>
    expect(screen.getByLabelText("Active sample")).toHaveTextContent("Français")
  )
  expect(
    JSON.parse(window.localStorage.getItem(key("default", "en"))!)[
      "primary.eyebrow"
    ]
  ).toBe("English")
  expect(
    JSON.parse(window.localStorage.getItem(key("centered", "en"))!)[
      "primary.eyebrow"
    ]
  ).toBe("Centered")
  expect(window.localStorage.getItem(untouched)).toBe(
    '{"untouched":"another slice"}'
  )
  act(() =>
    expect(
      callbacks!.change({
        generation: bridge.generation,
        sessionId: bridge.sessionId,
        editorSessionId: "editor",
        revision: 1,
        path: "primary.eyebrow",
        value: "Modification récente",
        selection: null,
      })
    ).toBe(true)
  )
  window.localStorage.setItem(
    key("centered", "fr"),
    JSON.stringify({ "primary.eyebrow": "Stale stored value" })
  )
  delete (window as SimFrameWindow).__formulacmsSimFrame
  bridge = configure()
  bridge.generation = "reconnected"
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  await waitFor(() =>
    expect(screen.getByLabelText("Active sample")).toHaveTextContent(
      "Modification récente"
    )
  )
  fireEvent.click(screen.getByRole("button", { name: "Undo sample" }))
  expect(screen.getByLabelText("Active sample")).toHaveTextContent("Français")
  expect(
    JSON.parse(window.localStorage.getItem(key("centered", "fr"))!)[
      "primary.eyebrow"
    ]
  ).toBe("Français")
  mounted.unmount()
})
test.each(["blocked-getter", "blocked-write", "corrupt"])(
  "%s storage falls back to a complete real preset without source writes", sliceProfile([]),
  async (failure) => {
    window.sessionStorage.clear()
    window.localStorage.clear()
    vi.clearAllMocks()
    const original = Object.getOwnPropertyDescriptor(window, "localStorage")!
    const fields = sampleFields(createSampleSlice("hero-agency"))
    const defaults = buildSamplePresets("hero-agency", fields)
    const bridge = installSimTestBridge(window)
    bridge.fields = fields
    const storage = window.localStorage
    const write = Storage.prototype.setItem
    if (failure === "corrupt")
      storage.setItem(
        sampleStorageKey("hero-agency", "default", "en", "default"),
        JSON.stringify({
          "primary.eyebrow": "Should not partially survive",
          unknown: "corrupt",
        })
      )
    if (failure === "blocked-getter")
      Object.defineProperty(window, "localStorage", {
        configurable: true,
        get() {
          throw Error("blocked")
        },
      })
    if (failure === "blocked-write")
      vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (
        this: Storage,
        key,
        value
      ) {
        if (key.startsWith("formulacms:sim-samples")) throw Error("blocked")
        write.call(this, key, value)
      })
    const mounted = render(
      <VisualTweakProvider type="hero-agency" view="desktop">
        <Values />
      </VisualTweakProvider>
    )
    try {
      act(() =>
        window.dispatchEvent(
          new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
        )
      )
      await waitFor(() =>
        expect(screen.getByLabelText("Active sample")).toHaveTextContent(
          defaults.default["primary.eyebrow"]
        )
      )
      expect(applySpacingBatchAction).not.toHaveBeenCalled()
      expect(undoSpacingBatchAction).not.toHaveBeenCalled()
    } finally {
      mounted.unmount()
      Object.defineProperty(window, "localStorage", original)
    }
  }
)
test("real provider hydrates scoped storage, preserves edits across presets/mode/view/reload and resets only the active preset", sliceProfile([]), async () => {
  window.localStorage.clear()
  window.sessionStorage.clear()
  vi.clearAllMocks()
  const fields = sampleFields(createSampleSlice("hero-agency"))
  const defaults = buildSamplePresets("hero-agency", fields)
  const key = (preset: string) =>
    sampleStorageKey("hero-agency", "default", "en", preset)
  window.localStorage.setItem(
    key("default"),
    JSON.stringify({ "primary.eyebrow": "Remembered Short" })
  )
  const bridge = installSimTestBridge(window)
  bridge.fields = fields
  bridge.editorSessionId = () => "editor"
  let callbacks: SimFrameCallbacks | null = null
  bridge.connect = (id, next) => {
    bridge.sessionId = id
    callbacks = next
  }
  const tree = (view: "desktop" | "mobile") => (
    <VisualTweakProvider type="hero-agency" view={view}>
      <Values />
    </VisualTweakProvider>
  )
  let mounted = render(tree("desktop"))
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  await waitFor(() =>
    expect(screen.getByLabelText("Active sample")).toHaveTextContent(
      "Remembered Short"
    )
  )
  fireEvent.click(screen.getByRole("radio", { name: "Long" }))
  fireEvent.click(screen.getByRole("radio", { name: "French" }))
  fireEvent.click(screen.getByRole("button", { name: "Reset sample text" }))
  expect(screen.getByLabelText("History available")).toHaveTextContent("false")
  act(() =>
    expect(
      callbacks!.change({
        generation: bridge.generation,
        sessionId: bridge.sessionId,
        editorSessionId: "editor",
        revision: 1,
        path: "primary.eyebrow",
        value: "Une équipe à Montréal",
        selection: null,
      })
    ).toBe(true)
  )
  fireEvent.click(screen.getByRole("radio", { name: "Short" }))
  expect(screen.getByLabelText("Active sample")).toHaveTextContent(
    "Remembered Short"
  )
  fireEvent.click(screen.getByRole("radio", { name: "French" }))
  expect(screen.getByLabelText("Active sample")).toHaveTextContent(
    "Une équipe à Montréal"
  )
  fireEvent.click(screen.getByRole("radio", { name: "Preview" }))
  mounted.rerender(tree("mobile"))
  expect(screen.getByLabelText("Active sample")).toHaveTextContent(
    "Une équipe à Montréal"
  )
  mounted.unmount()
  mounted = render(tree("mobile"))
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  fireEvent.click(screen.getByRole("radio", { name: "French" }))
  await waitFor(() =>
    expect(screen.getByLabelText("Active sample")).toHaveTextContent(
      "Une équipe à Montréal"
    )
  )
  fireEvent.click(screen.getByRole("button", { name: "Reset sample text" }))
  expect(screen.getByLabelText("Active sample")).toHaveTextContent(
    defaults.french["primary.eyebrow"]
  )
  expect(
    JSON.parse(window.localStorage.getItem(key("default"))!)["primary.eyebrow"]
  ).toBe("Remembered Short")
  expect(
    JSON.parse(window.localStorage.getItem(key("french"))!)["primary.eyebrow"]
  ).toBe(defaults.french["primary.eyebrow"])
  expect(applySpacingBatchAction).not.toHaveBeenCalled()
  expect(undoSpacingBatchAction).not.toHaveBeenCalled()
  mounted.unmount()
})
test("mode and preset controls honor flush refusal and mode shortcuts leave ordinary editable letters alone", sliceProfile([]), () => {
  window.sessionStorage.clear()
  window.localStorage.clear()
  const bridge = installSimTestBridge(window)
  bridge.flush = () => false
  render(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <Values />
    </VisualTweakProvider>
  )
  act(() =>
    window.dispatchEvent(
      new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
    )
  )
  fireEvent.click(screen.getByRole("radio", { name: "Preview" }))
  fireEvent.click(screen.getByRole("radio", { name: "French" }))
  expect(screen.getByRole("radio", { name: "Edit" })).toHaveAttribute(
    "aria-checked",
    "true"
  )
  expect(screen.getByRole("radio", { name: "Short" })).toHaveAttribute(
    "aria-checked",
    "true"
  )
  bridge.flush = () => true
  fireEvent.keyDown(screen.getByLabelText("Ordinary letters"), { key: "i" })
  expect(screen.getByRole("radio", { name: "Edit" })).toHaveAttribute(
    "aria-checked",
    "true"
  )
  fireEvent.keyDown(document.body, { key: "i" })
  expect(screen.getByRole("radio", { name: "Preview" })).toHaveAttribute(
    "aria-checked",
    "true"
  )
})

test.each(["save-refused", "undo-refused", "undo-succeeds"] as const)(
  "dirty sample continuity through source Save/Undo: %s", sliceProfile([]),
  async (outcome) => {
    window.localStorage.clear()
    window.sessionStorage.clear()
    vi.resetAllMocks()
    const target = {
      loc: "components/slices/hero-agency.tsx:11:5",
      tag: "section",
      sourceHash: "before-source",
      sourceClassTokens: ["pt-4"],
      editable: true,
      templateWide: false,
      label: "Hero section",
      path: "primary",
    }
    const afterTarget = {
      ...target,
      sourceHash: "after-source",
      sourceClassTokens: ["pt-8"],
    }
    vi.mocked(applySpacingBatchAction).mockResolvedValue(
      outcome === "save-refused"
        ? { ok: false, error: "Source changed before Save." }
        : {
            ok: true,
            applied: 1,
            skipped: 0,
            results: [
              {
                id: JSON.stringify([target.loc, "all", "spacing:pt"]),
                status: "applied",
              },
            ],
            files: ["components/slices/hero-agency.tsx"],
            version: 1,
            checkpointId: "saved-checkpoint",
            sourceHash: afterTarget.sourceHash,
            targets: [afterTarget],
            diffs: [
              {
                target: target.loc,
                tag: target.tag,
                scope: "all",
                group: "spacing:pt",
                before: "pt-4",
                after: "pt-8",
              },
            ],
          }
    )
    vi.mocked(undoSpacingBatchAction).mockResolvedValue(
      outcome === "undo-refused"
        ? { ok: false, error: "Source changed after Save." }
        : {
            ok: true,
            files: ["components/slices/hero-agency.tsx"],
            version: 2,
            sourceHash: target.sourceHash,
            targets: [target],
          }
    )
    const bridge = installSimTestBridge(window)
    bridge.fields = sampleFields(createSampleSlice("hero-agency"))
    bridge.editorSessionId = () => "editor"
    let callbacks: SimFrameCallbacks | null = null
    bridge.connect = (id, next) => {
      bridge.sessionId = id
      callbacks = next
    }
    let current!: ReturnType<typeof useVisualTweak>
    function Capture() {
      const value = useVisualTweak()
      useLayoutEffect(() => {
        current = value
      }, [value])
      return (
        <>
          <Values />
          <VisualTweakSaveBar />
        </>
      )
    }
    render(
      <VisualTweakProvider type="hero-agency" view="desktop">
        <Capture />
      </VisualTweakProvider>
    )
    act(() =>
      window.dispatchEvent(
        new CustomEvent(SIM_FRAME_CONNECTED, { detail: bridge })
      )
    )
    const dirty = "Unsaved Montréal sample"
    expect(current.samples["primary.eyebrow"]).not.toBe(dirty)
    act(() => {
      expect(
        callbacks!.change({
          generation: bridge.generation,
          sessionId: bridge.sessionId,
          editorSessionId: "editor",
          revision: 1,
          path: "primary.eyebrow",
          value: dirty,
          selection: null,
        })
      ).toBe(true)
      current.setEdit(target.loc, "pt", {
        suffix: "8",
        valueRem: 2,
        target,
      })
    })
    const storageKey = sampleStorageKey(
      "hero-agency",
      "default",
      "en",
      "default"
    )
    const expectDirty = async () => {
      expect(current.samples["primary.eyebrow"]).toBe(dirty)
      expect(screen.getByLabelText("Active sample")).toHaveTextContent(dirty)
      await waitFor(() =>
        expect(
          JSON.parse(window.localStorage.getItem(storageKey) ?? "{}")[
            "primary.eyebrow"
          ]
        ).toBe(dirty)
      )
    }
    await expectDirty()
    expect(applySpacingBatchAction).not.toHaveBeenCalled()
    expect(undoSpacingBatchAction).not.toHaveBeenCalled()
    fireEvent.click(
      screen.getByRole("button", { name: "Save appearance changes" })
    )
    await waitFor(() => expect(applySpacingBatchAction).toHaveBeenCalledOnce())
    await waitFor(() => expect(current.saving).toBe(false))
    await expectDirty()
    expect(vi.mocked(applySpacingBatchAction).mock.calls[0][0].edits).toEqual([
      expect.objectContaining({
        target: target.loc,
        sourceHash: target.sourceHash,
        next: "pt-8",
      }),
    ])
    expect(
      JSON.stringify(vi.mocked(applySpacingBatchAction).mock.calls)
    ).not.toContain(dirty)
    if (outcome === "save-refused") {
      expect(current.editCount).toBe(1)
      expect(current.savedCheckpoint).toBeNull()
      expect(undoSpacingBatchAction).not.toHaveBeenCalled()
      return
    }
    expect(current.editCount).toBe(0)
    expect(current.savedCheckpoint?.id).toBe("saved-checkpoint")
    fireEvent.click(
      screen.getByRole("button", { name: "Undo saved appearance changes" })
    )
    await waitFor(() =>
      expect(undoSpacingBatchAction).toHaveBeenCalledExactlyOnceWith({
        type: "hero-agency",
        checkpointId: "saved-checkpoint",
      })
    )
    await waitFor(() => expect(current.saving).toBe(false))
    await expectDirty()
    expect(current.savedCheckpoint?.id ?? null).toBe(
      outcome === "undo-refused" ? "saved-checkpoint" : null
    )
    expect(applySpacingBatchAction).toHaveBeenCalledTimes(1)
  }
)

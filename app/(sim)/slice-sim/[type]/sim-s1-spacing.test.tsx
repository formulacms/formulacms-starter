import { sliceProfile } from "@/test-utils/slice-profile"
import { fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
import { act, useState } from "react"
vi.mock("./read-renderer-source", () => ({
  applySpacingBatchAction: vi.fn(),
  undoSpacingBatchAction: vi.fn(),
}))
import { useVisualTweak, VisualTweakProvider } from "./visual-tweak-store"
import { useSliceTweak } from "./use-slice-tweak"
import { SliceTweakToolbar } from "./slice-tweak-toolbar"
import {
  UNLINKED,
  type LinkedTones,
  type ToolbarSpacingAxis,
} from "./slice-tweak-toolbar-types"
const spacingSet = vi.fn()
const target = {
  loc: "section-loc",
  tag: "section",
  sourceHash: "a".repeat(64),
  sourceClassTokens: ["pt-4"],
  editable: true,
  templateWide: false,
  label: "Section",
  path: "section-loc",
  classAnchor: "anchored" as const,
  metrics: {
    size: { width: 100, height: 100 },
    padding: { top: "16px", right: "16px", bottom: "16px", left: "16px" },
    margin: { top: "16px", right: "16px", bottom: "16px", left: "16px" },
    gap: "16px",
    lineHeight: "24px",
    fontSize: "16px",
  },
}
function Harness({ isList = false }: { isList?: boolean }) {
  const [linked, setLinked] = useState<LinkedTones>(UNLINKED)
  const store = useVisualTweak()
  const tweak = useSliceTweak({
    target: { ...target, isList },
    linked,
    onPreview: vi.fn(),
  })
  return (
    <>
      <SliceTweakToolbar
        label="Section"
        metrics={target.metrics}
        capabilities={tweak.capabilities}
        busy={false}
        linked={linked}
        onLinkedChange={setLinked}
        values={tweak.values}
        onSpacingStep={tweak.onSpacingStep}
        onSpacingSet={(axis, remValue) => {
          spacingSet(axis, remValue)
          tweak.onSpacingSet(axis, remValue)
        }}
        onTypographyStep={tweak.onTypographyStep}
        onClose={vi.fn()}
        scope={store.scope}
        sourceClassTokens={target.sourceClassTokens}
      />
      <output aria-label="Pending count">{store.editCount}</output>
      <output aria-label="Pending state">
        {JSON.stringify({
          edits: store.edits,
          canUndo: store.canUndo,
          canRedo: store.canRedo,
        })}
      </output>
      <output aria-label="Scope">{store.scope}</output>
      <output aria-label="Pending axes">
        {store.pendingRows
          .map((row) => row.group)
          .sort()
          .join(",")}
      </output>
      <button onClick={() => store.resetTarget(target.loc)}>
        Reset selected
      </button>
      <button onClick={store.undo}>Undo</button>
      <button onClick={store.redo}>Redo</button>
    </>
  )
}
beforeEach(() => {
  window.sessionStorage.clear()
  spacingSet.mockClear()
})
const modes = [
  { mode: "All sides linked", side: "top", suffixes: ["t", "r", "b", "l"] },
  { mode: "Left and right linked", side: "right", suffixes: ["r", "l"] },
  { mode: "Top and bottom linked", side: "top", suffixes: ["t", "b"] },
  { mode: "Unlinked", side: "top", suffixes: ["t"] },
]
test.each(
  (["padding", "margin"] as const).flatMap((tone) =>
    modes.map((mode) => ({ tone, ...mode }))
  )
)(
  "$tone $mode changes only the linked sides", sliceProfile([]),
  ({ tone, mode, side, suffixes }) => {
    render(
      <VisualTweakProvider type="hero-agency" view="desktop">
        <Harness />
      </VisualTweakProvider>
    )
    fireEvent.click(screen.getByRole("radio", { name: `${mode} — ${tone}` }))
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: `${tone} ${side}` }),
      { key: "ArrowUp" }
    )
    const prefix = tone === "padding" ? "p" : "m"
    expect(screen.getByLabelText("Pending count")).toHaveTextContent(
      String(suffixes.length)
    )
    expect(screen.getByLabelText("Pending axes").textContent).toBe(
      suffixes
        .map((suffix) => `spacing:${prefix}${suffix}`)
        .sort()
        .join(",")
    )
    expect(
      screen.getAllByRole("textbox", { name: new RegExp(`^${tone} `) })
    ).toHaveLength(4)
  }
)
test("Gap is disabled for non-lists and enabled for lists without affecting padding or margin", sliceProfile([]), () => {
  const mounted = render(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <Harness />
    </VisualTweakProvider>
  )
  expect(screen.getByRole("textbox", { name: "Gap" })).toBeDisabled()
  mounted.rerender(
    <VisualTweakProvider type="hero-agency" view="desktop">
      <Harness isList />
    </VisualTweakProvider>
  )
  const gap = screen.getByRole("textbox", { name: "Gap" })
  expect(gap).toBeEnabled()
  fireEvent.click(screen.getByRole("button", { name: "Increase Gap" }))
  expect(screen.getByLabelText("Pending axes")).toHaveTextContent("spacing:gap")
})
test("responsive fields distinguish Default inheritance and pending overrides; reset is undoable", sliceProfile([]), () => {
  render(
    <VisualTweakProvider type="hero-agency" view="mobile">
      <Harness />
    </VisualTweakProvider>
  )
  expect(
    screen.getByRole("img", { name: "Inherited from Default" })
  ).toBeInTheDocument()
  fireEvent.keyDown(screen.getByRole("textbox", { name: "padding top" }), {
    key: "ArrowUp",
  })
  expect(
    screen.getByRole("img", { name: "Set for this size" })
  ).toBeInTheDocument()
  fireEvent.click(screen.getByText("Reset selected"))
  expect(screen.getByLabelText("Pending count")).toHaveTextContent("0")
  fireEvent.click(screen.getByText("Undo"))
  expect(screen.getByLabelText("Pending count")).toHaveTextContent("1")
})

function pendingState() {
  return JSON.parse(
    screen.getByLabelText("Pending state").textContent ?? "{}"
  ) as Pick<ReturnType<typeof useVisualTweak>, "edits" | "canUndo" | "canRedo">
}

const cancellationCells = [
  ...(["padding", "margin"] as const).flatMap((tone) =>
    modes.map(({ mode, side, suffixes }) => ({
      tone,
      mode,
      label: `${tone} ${side}`,
      axes: suffixes.map(
        (suffix) =>
          `${tone === "padding" ? "p" : "m"}${suffix}` as ToolbarSpacingAxis
      ),
    }))
  ),
  { tone: "gap", mode: "list", label: "Gap", axes: ["gap" as const] },
]

test.each(
  cancellationCells.flatMap((cell) =>
    (["empty", "pending and redo"] as const).map((history) => ({
      ...cell,
      history,
      view: history === "empty" ? ("desktop" as const) : ("mobile" as const),
    }))
  )
)(
  "$label $mode Escape preserves $history history at $view and the next edit commits", sliceProfile([]),
  ({ tone, mode, label, axes, history, view }) => {
    render(
      <VisualTweakProvider type="hero-agency" view={view}>
        <Harness isList={tone === "gap"} />
      </VisualTweakProvider>
    )
    expect(screen.getByLabelText("Scope")).toHaveTextContent(
      view === "mobile" ? "below-sm" : "all"
    )
    if (tone !== "gap")
      fireEvent.click(screen.getByRole("radio", { name: `${mode} — ${tone}` }))

    const initial = pendingState()
    const unrelatedLabel =
      tone === "margin" ? "padding bottom" : "margin bottom"
    let secondStep: ReturnType<typeof pendingState> | undefined
    if (history === "pending and redo") {
      const unrelated = screen.getByRole("textbox", { name: unrelatedLabel })
      fireEvent.keyDown(unrelated, { key: "ArrowUp" })
      fireEvent.keyDown(unrelated, { key: "ArrowUp" })
      secondStep = pendingState()
      fireEvent.click(screen.getByRole("button", { name: "Undo" }))
      expect(pendingState().canUndo).toBe(true)
      expect(pendingState().canRedo).toBe(true)
      expect(screen.getByLabelText("Pending count")).toHaveTextContent("1")
    }
    const before = pendingState()
    const input = screen.getByRole("textbox", { name: label })
    input.focus()
    fireEvent.change(input, { target: { value: "48" } })
    expect(input).toHaveValue("48")
    expect(pendingState()).toEqual(before)
    fireEvent.keyDown(input, { key: "Escape" })
    expect(spacingSet).not.toHaveBeenCalled()
    expect(pendingState()).toEqual(before)
    expect(input).toHaveValue("16")

    if (secondStep) {
      fireEvent.click(screen.getByRole("button", { name: "Redo" }))
      expect(pendingState()).toEqual(secondStep)
      fireEvent.click(screen.getByRole("button", { name: "Undo" }))
      expect(pendingState()).toEqual(before)
      fireEvent.click(screen.getByRole("button", { name: "Undo" }))
      expect(pendingState().edits).toEqual(initial.edits)
      expect(pendingState().canUndo).toBe(false)
      fireEvent.click(screen.getByRole("button", { name: "Redo" }))
      expect(pendingState()).toEqual(before)
    }

    input.focus()
    fireEvent.change(input, { target: { value: "49" } })
    act(() => input.blur())
    expect(spacingSet).toHaveBeenCalledTimes(1)
    expect(input).toHaveValue("48")
    const accepted = pendingState()
    expect(accepted.canUndo).toBe(true)
    expect(accepted.canRedo).toBe(false)
    for (const axis of axes)
      expect(accepted.edits[target.loc][axis]).toMatchObject({
        suffix: "12",
        valueRem: 3,
      })
    const unrelatedAxis = tone === "margin" ? "pb" : "mb"
    expect(accepted.edits[target.loc][unrelatedAxis]).toEqual(
      before.edits[target.loc]?.[unrelatedAxis]
    )
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(pendingState().edits).toEqual(before.edits)
    expect(pendingState().canUndo).toBe(before.canUndo)
    fireEvent.click(screen.getByRole("button", { name: "Redo" }))
    expect(pendingState()).toEqual(accepted)
  }
)

test.each(["Enter", "blur"] as const)(
  "%s still accepts a snapped value as one effective undo step", sliceProfile([]),
  (finish) => {
    render(
      <VisualTweakProvider type="hero-agency" view="desktop">
        <Harness />
      </VisualTweakProvider>
    )
    const input = screen.getByRole("textbox", { name: "padding top" })
    const before = pendingState()
    input.focus()
    fireEvent.change(input, { target: { value: "49" } })
    if (finish === "Enter") fireEvent.keyDown(input, { key: "Enter" })
    else act(() => input.blur())
    expect(spacingSet).toHaveBeenCalledWith("pt", 49 / 16)
    expect(pendingState().edits[target.loc].pt).toMatchObject({
      suffix: "12",
      valueRem: 3,
    })
    const accepted = pendingState()
    fireEvent.click(screen.getByRole("button", { name: "Undo" }))
    expect(pendingState().edits).toEqual(before.edits)
    expect(pendingState().canUndo).toBe(false)
    fireEvent.click(screen.getByRole("button", { name: "Redo" }))
    expect(pendingState()).toEqual(accepted)
  }
)

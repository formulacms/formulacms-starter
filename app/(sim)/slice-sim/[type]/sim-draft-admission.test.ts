import { expect, test } from "vitest"
import {
  initialTweakState,
  reducer,
  scopedEditCount,
  type AxisEdit,
  type Viewport,
  type ScopedEdits,
} from "./visual-tweak-reducer"
const original = {
  loc: "file:1:1",
  tag: "section",
  sourceHash: "same",
  sourceClassTokens: ["pt-4", "sm:pt-4", "max-sm:pt-4"],
  editable: true,
  templateWide: false,
  label: "Saved section",
  path: "",
}
const current = { ...original, sourcePath: "jsx.0" }
const edit: AxisEdit = { suffix: "8", valueRem: 2, target: original }
function batch(scope: Viewport): ScopedEdits {
  return {
    all: {},
    "below-sm": {},
    "sm-and-up": {},
    [scope]: { [original.loc]: { pt: edit } },
  }
}
test.each(["all", "below-sm", "sm-and-up"] as const)(
  "%s exact draft admission works in both event orders",
  (scope) => {
    for (const first of ["load", "targets"]) {
      let state =
        first === "load"
          ? reducer(initialTweakState, { kind: "load", edits: batch(scope) })
          : reducer(initialTweakState, { kind: "targets", targets: [current] })
      state =
        first === "load"
          ? reducer(state, { kind: "targets", targets: [current] })
          : reducer(state, { kind: "load", edits: batch(scope) })
      expect(scopedEditCount(state.edits)).toBe(1)
      expect(state.edits[scope][original.loc].pt).toMatchObject({
        suffix: "8",
        valueRem: 2,
        target: {
          sourcePath: "jsx.0",
          sourceHash: "same",
          sourceClassTokens: original.sourceClassTokens,
        },
      })
      expect(
        state.edits[scope][original.loc].pt?.disabledReason
      ).toBeUndefined()
      expect(Object.keys(state.appearance[scope])).toEqual(["jsx.0"])
      expect([state.past.length, state.future.length]).toEqual([0, 0])
    }
  }
)
test.each(["all", "below-sm", "sm-and-up"] as const)(
  "%s unresolved drafts persist through notifications and serialized reload",
  (scope) => {
    for (const snapshot of [
      [],
      [{ ...current, sourceHash: "wrong" }],
      [{ ...current, loc: "file:2:1" }],
      [{ ...current, sourceHash: "" }],
      [{ ...current, editable: false }],
      [current, { ...current, sourcePath: "jsx.1" }],
      [current, { ...current, loc: "other:1:1" }],
    ]) {
      let state = reducer(initialTweakState, {
        kind: "load",
        edits: batch(scope),
      })
      for (let n = 0; n < 2; n++)
        state = reducer(state, { kind: "targets", targets: snapshot })
      expect(scopedEditCount(state.edits)).toBe(1)
      let pending = Object.values(state.edits[scope])[0].pt!
      expect(pending.disabledReason).toBeTruthy()
      expect(pending.target.sourceHash).toBe("same")
      expect(pending.valueRem).toBe(2)
      state = reducer(initialTweakState, {
        kind: "load",
        edits: JSON.parse(JSON.stringify(state.edits)),
      })
      expect(scopedEditCount(state.edits)).toBe(1)
      pending = Object.values(state.edits[scope])[0].pt!
      expect(pending.disabledReason).toBeTruthy()
      state = reducer(state, { kind: "clearEdits" })
      expect(scopedEditCount(state.edits)).toBe(0)
      state = reducer(state, { kind: "undo" })
      expect(scopedEditCount(state.edits)).toBe(1)
      expect(
        Object.values(state.edits[scope])[0].pt?.disabledReason
      ).toBeTruthy()
      state = reducer(state, { kind: "targets", targets: [current] })
      expect(
        state.edits[scope][original.loc].pt?.disabledReason
      ).toBeUndefined()
    }
  }
)
test("admission renames past and future without erasing samples or selection", () => {
  let state = reducer(initialTweakState, {
    kind: "sample",
    path: "primary.label",
    value: "Sample",
    selection: { path: "primary.label", from: 2, to: 2 },
  })
  state = reducer(state, {
    kind: "set",
    scope: "all",
    path: original.loc,
    axis: "pt",
    edit,
  })
  state = reducer(state, {
    kind: "set",
    scope: "all",
    path: original.loc,
    axis: "pt",
    edit: { ...edit, suffix: "12", valueRem: 3 },
  })
  state = reducer(state, { kind: "undo" })
  const counts = [state.past.length, state.future.length]
  state = reducer(state, { kind: "targets", targets: [current] })
  expect([state.past.length, state.future.length]).toEqual(counts)
  expect(state.samples.default["primary.label"]).toBe("Sample")
  expect(state.selection?.from).toBe(2)
  expect(
    JSON.stringify([
      state.appearance,
      state.initialAppearance,
      state.savedAppearance,
      ...state.past.map((s) => s.appearance),
      ...state.future.map((s) => s.appearance),
    ])
  ).not.toContain(original.loc)
  state = reducer(state, { kind: "redo" })
  expect(state.edits.all[original.loc].pt?.suffix).toBe("12")
  state = reducer(state, { kind: "undo" })
  expect(state.edits.all[original.loc].pt?.suffix).toBe("8")
})
test("a destination conflict keeps both distinct intents and blocks the unresolved one", () => {
  let state = reducer(initialTweakState, {
    kind: "set",
    scope: "all",
    path: current.loc,
    axis: "pt",
    edit: { ...edit, target: current, suffix: "12", valueRem: 3 },
  })
  state = reducer(state, {
    kind: "set",
    scope: "all",
    path: original.loc,
    axis: "pt",
    edit,
  })
  state = reducer(state, { kind: "targets", targets: [current] })
  expect(scopedEditCount(state.edits)).toBe(2)
  const rows = Object.values(state.edits.all).map((axes) => axes.pt!)
  expect(rows.map((row) => row.suffix).sort()).toEqual(["12", "8"])
  expect(rows.filter((row) => row.disabledReason)).toHaveLength(1)
})

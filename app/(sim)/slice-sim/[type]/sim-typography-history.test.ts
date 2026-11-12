import { expect, test } from "vitest"
import { initialTweakState, reducer, type Action } from "./visual-tweak-reducer"

const typography: Action = {
  kind: "typography",
  role: "body",
  property: "font-size",
  initialValue: "1rem",
  delta: 1,
  rootFontSizePx: 16,
}
const spacing: Action = {
  kind: "set",
  scope: "all",
  path: "loc",
  axis: "pt",
  edit: {
    suffix: "8",
    valueRem: 2,
    target: {
      loc: "loc",
      sourcePath: "loc",
      tag: "section",
      sourceHash: "before",
      sourceClassTokens: ["pt-4"],
      editable: true,
      templateWide: false,
      label: "Section",
      path: "",
    },
  },
}

test("sample, spacing and role previews share one ordered Undo/Redo history", () => {
  let state = reducer(initialTweakState, {
    kind: "sample",
    path: "primary.eyebrow",
    value: "Edited",
    selection: null,
  })
  state = reducer(state, spacing)
  state = reducer(state, typography)
  expect(state.typography.body?.["font-size"]).toEqual({
    before: "1rem",
    after: "1.0625rem",
  })
  state = reducer(state, { kind: "undo" })
  expect(state.typography).toEqual({})
  expect(state.edits.all.loc.pt?.suffix).toBe("8")
  state = reducer(state, { kind: "undo" })
  expect(state.edits.all).toEqual({})
  expect(state.samples.default["primary.eyebrow"]).toBe("Edited")
  state = reducer(state, { kind: "undo" })
  expect(state.samples.default).toEqual({})
  for (let i = 0; i < 3; i++) state = reducer(state, { kind: "redo" })
  expect(state.typography.body?.["font-size"]?.after).toBe("1.0625rem")
  expect(state.edits.all.loc.pt?.suffix).toBe("8")
  expect(state.samples.default["primary.eyebrow"]).toBe("Edited")
})

test("rapid steps use the current preview value and retain one original CSS value", () => {
  let state = initialTweakState
  for (let i = 0; i < 20; i++) state = reducer(state, typography)
  expect(state.typography.body?.["font-size"]).toEqual({
    before: "1rem",
    after: "2.25rem",
  })
  for (let i = 0; i < 20; i++) state = reducer(state, { kind: "undo" })
  expect(state.typography).toEqual({})
  for (let i = 0; i < 20; i++) state = reducer(state, { kind: "redo" })
  expect(state.typography.body?.["font-size"]?.after).toBe("2.25rem")
})

test("a return to source removes its row; no-ops/refusals preserve redo", () => {
  let state = reducer(initialTweakState, typography)
  state = reducer(state, { ...typography, delta: -1 })
  expect(state.typography).toEqual({})
  state = reducer(state, { kind: "undo" })
  const snapshot = state
  expect(reducer(state, { ...typography, delta: 0 })).toBe(snapshot)
  expect(reducer(state, { ...typography, delta: -1000 })).toBe(snapshot)
  expect(
    reducer(state, {
      ...typography,
      role: "lead",
      initialValue: "var(--other)",
    })
  ).toBe(snapshot)
  state = reducer(state, { ...typography, delta: 2 })
  expect(state.future).toEqual([])
})

test("discarding previews is one undoable step and does not discard sample text", () => {
  let state = reducer(initialTweakState, typography)
  state = reducer(state, spacing)
  state = reducer(state, {
    kind: "sample",
    path: "primary.eyebrow",
    value: "Sample",
    selection: null,
  })
  state = reducer(state, { kind: "clearEdits" })
  expect(state.typography).toEqual({})
  expect(state.edits.all).toEqual({})
  expect(state.samples.default["primary.eyebrow"]).toBe("Sample")
  state = reducer(state, { kind: "undo" })
  expect(state.typography.body?.["font-size"]?.after).toBe("1.0625rem")
  expect(state.edits.all.loc.pt?.suffix).toBe("8")
})

test("spacing source-save reconciliation never persists or marks role previews saved", () => {
  let state = reducer(reducer(initialTweakState, typography), spacing)
  state = reducer(state, {
    kind: "reconcileSave",
    rows: [
      {
        scope: "all",
        path: "loc",
        axis: "pt",
        suffix: "8",
        sourceHash: "before",
        status: "applied",
      },
    ],
  })
  expect(state.typography.body?.["font-size"]).toEqual({
    before: "1rem",
    after: "1.0625rem",
  })
  expect(JSON.stringify(state.edits)).not.toContain("font-size")
  expect(JSON.stringify(state.savedAppearance)).not.toContain("font-size")
})

test("inherited tracking retains inherit for review and Undo while later steps use pending em", () => {
  const action = {
    kind: "typography",
    role: "body",
    property: "letter-spacing",
    initialValue: "inherit",
    delta: 0.005,
    rootFontSizePx: 16,
    computedLetterSpacing: "0.64px",
    fontSizePx: 16,
  } as const
  let state = reducer(initialTweakState, action)
  expect(state.typography.body?.["letter-spacing"]).toEqual({
    before: "inherit",
    after: "0.045em",
  })
  state = reducer(state, { ...action, computedLetterSpacing: "1px" })
  expect(state.typography.body?.["letter-spacing"]).toEqual({
    before: "inherit",
    after: "0.05em",
  })
  state = reducer(reducer(state, { kind: "undo" }), { kind: "undo" })
  expect(state.typography).toEqual({})
})

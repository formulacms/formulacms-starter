import { expect, test } from "vitest"
import {
  initialTweakState,
  reducer,
  type AxisEdit,
} from "./visual-tweak-reducer"
const target = {
  loc: "loc",
  sourcePath: "loc",
  tag: "section",
  sourceHash: "before",
  sourceClassTokens: ["pt-4"],
  editable: true,
  templateWide: false,
  label: "Section",
  path: "",
}
const edit: AxisEdit = { target, suffix: "8", valueRem: 2 }
test("storage readiness stays outside semantic history and survives source restoration with its samples/defaults", () => {
  const defaults = { default: { "primary.eyebrow": "Seed" } }
  let state = reducer(initialTweakState, {
    kind: "samplePresets",
    scope: "scope",
    defaults,
    stored: { default: { "primary.eyebrow": "Saved" } },
  })
  state = reducer(state, {
    kind: "sample",
    path: "primary.eyebrow",
    value: "Edited",
    selection: null,
  })
  state = reducer(state, { kind: "undo" })
  expect(state.sampleStorageScope).toBe("scope")
  expect(state.samples.default["primary.eyebrow"]).toBe("Saved")
  expect(JSON.stringify(state.past)).not.toContain("sampleStorageScope")
  state = reducer(state, {
    kind: "load",
    edits: { all: {}, "below-sm": {}, "sm-and-up": {} },
  })
  expect(state.sampleStorageScope).toBe("scope")
  state = reducer(state, { kind: "sourceRestored", targets: [] })
  expect(state.sampleStorageScope).toBe("scope")
  expect(state.sampleDefaults).toEqual(defaults)
  expect(state.samples.default["primary.eyebrow"]).toBe("Saved")
})
test("sample and appearance share history; Save rebases hashes and Discard is one step", () => {
  let state = reducer(initialTweakState, {
    kind: "sample",
    path: "primary.title",
    value: "one",
    selection: { path: "primary.title", from: 2, to: 2 },
    group: "typing",
  })
  state = reducer(state, {
    kind: "set",
    scope: "all",
    path: "loc",
    axis: "pt",
    edit,
  })
  state = reducer(state, {
    kind: "reconcileSave",
    sourceHash: "after",
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
  expect(state.past).toHaveLength(2)
  state = reducer(state, {
    kind: "targets",
    targets: [{ ...target, sourceHash: "after", sourceClassTokens: ["pt-8"] }],
  })
  state = reducer(state, { kind: "undo" })
  expect(state.edits.all.loc.pt?.suffix).toBe("4")
  expect(state.edits.all.loc.pt?.target.sourceHash).toBe("after")
  expect(JSON.stringify(state.past)).not.toContain('"sourceHash"')
  state = reducer(state, { kind: "clearEdits" })
  expect(state.samples.default["primary.title"]).toBe("one")
  state = reducer(state, { kind: "undo" })
  expect(state.edits.all.loc.pt?.suffix).toBe("4")
})
test("typing groups, composition boundary, preset switching and reset have one owner", () => {
  let state = reducer(initialTweakState, {
    kind: "sample",
    path: "p",
    value: "a",
    selection: null,
    group: "typing",
  })
  state = reducer(state, {
    kind: "sample",
    path: "p",
    value: "ab",
    selection: null,
    group: "typing",
  })
  expect(state.past).toHaveLength(1)
  state = reducer(state, { kind: "closeGroup" })
  state = reducer(state, {
    kind: "sample",
    path: "p",
    value: "abc",
    selection: null,
    group: "typing",
  })
  expect(state.past).toHaveLength(2)
  state = reducer(state, { kind: "preset", key: "french" })
  state = reducer(state, { kind: "resetSamples" })
  expect(state.past).toHaveLength(2)
})
test.each(["set", "setMany"] as const)(
  "%s refreshes metadata on semantic no-op without truncating redo",
  (kind) => {
    const set = (
      suffix: string,
      sourceHash = "before",
      sourceClassTokens = ["pt-4"]
    ) =>
      kind === "set"
        ? {
            kind,
            scope: "all" as const,
            path: "loc",
            axis: "pt" as const,
            edit: {
              ...edit,
              suffix,
              target: { ...target, sourceHash, sourceClassTokens },
            },
          }
        : {
            kind,
            scope: "all" as const,
            path: "loc",
            axes: ["pt", "pb"] as const,
            edit: {
              ...edit,
              suffix,
              target: { ...target, sourceHash, sourceClassTokens },
            },
          }
    let state = reducer(initialTweakState, set("8"))
    state = reducer(state, set("12"))
    state = reducer(state, { kind: "undo" })
    const counts = [state.past.length, state.future.length, state.reapplyNonce]
    state = reducer(state, set("8", "fresh", ["pt-4", "gap-4"]))
    expect([
      state.past.length,
      state.future.length,
      state.reapplyNonce,
    ]).toEqual(counts)
    expect(state.edits.all.loc.pt?.target.sourceHash).toBe("fresh")
    expect(state.edits.all.loc.pt?.target.sourceClassTokens).toContain("gap-4")
    if (kind === "setMany")
      expect(state.edits.all.loc.pb?.target.sourceHash).toBe("fresh")
    state = reducer(state, { kind: "redo" })
    expect(state.edits.all.loc.pt?.target.sourceHash).toBe("fresh")
    state = reducer(state, { kind: "undo" })
    const changed = reducer(state, set("16", "fresh", ["pt-4", "gap-4"]))
    expect(changed.past).toHaveLength(state.past.length + 1)
    state = reducer(state, set("8", "", []))
    expect(state.edits.all.loc).toBeUndefined()
  }
)
test("existing persisted spacing drafts survive acquisition of stable source paths", () => {
  let state = reducer(initialTweakState, {
    kind: "load",
    edits: {
      all: {
        loc: { pt: { ...edit, target: { ...target, sourcePath: undefined } } },
      },
      "below-sm": {},
      "sm-and-up": {},
    },
  })
  state = reducer(state, {
    kind: "targets",
    targets: [{ ...target, sourcePath: "jsx.0" }],
  })
  expect(state.edits.all.loc.pt?.suffix).toBe("8")
  expect(state.edits.all.loc.pt?.target.sourceHash).toBe("before")
})

test("Reset marker is monotonic state-only and does not travel through sample/appearance history", () => {
  let state = reducer(initialTweakState, {
    kind: "sample",
    path: "primary.eyebrow",
    value: "Edited",
    selection: null,
  })
  state = reducer(state, { kind: "resetSamples" })
  expect(state.resetNonce).toBe(1)
  expect(JSON.stringify(state.past)).not.toContain("resetNonce")
  for (const action of [
    { kind: "preset", key: "french" },
    { kind: "undo" },
    { kind: "redo" },
    { kind: "closeGroup" },
  ] as const) {
    state = reducer(state, action)
    expect(state.resetNonce).toBe(1)
  }
  state = reducer(state, { kind: "resetSamples" })
  expect(state.resetNonce).toBe(2)
})
test.each(["sourceRestored", "load"] as const)(
  "%s preserves Reset marker outside history",
  (kind) => {
    const state = { ...initialTweakState, resetNonce: 7 }
    const next =
      kind === "load"
        ? reducer(state, {
            kind,
            edits: { all: {}, "below-sm": {}, "sm-and-up": {} },
          })
        : reducer(state, { kind, targets: [] })
    expect(next.resetNonce).toBe(7)
  }
)

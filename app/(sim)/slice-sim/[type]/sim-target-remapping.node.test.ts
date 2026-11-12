import { expect, test } from "vitest"
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { applyClassOperationFileBatch } from "@/lib/slices/visual-tweak/class-operation-files"
import {
  applyClassOperationBatch,
  hashTweakSource,
  type ClassTweakOperation,
  type ClassTweakDiff,
} from "@/lib/slices/visual-tweak/class-operations"
import {
  emitScopedSpacingUtility,
  findExpectedSpacingUtility,
} from "@/lib/slices/visual-tweak/spacing-operation"
import { tweakTargetsForSource } from "./tweak-target"
import {
  initialTweakState,
  reducer,
  type State,
  type Viewport,
} from "./visual-tweak-reducer"
import type { ToolbarSpacingAxis } from "./slice-tweak-toolbar-types"
const file = "components/slices/example.tsx"
const metadata = (source: string) =>
  tweakTargetsForSource(source, file).map((target) => ({
    ...target,
    label: target.tag,
    path: target.sourcePath!,
  }))
const revisionSource =
  "export function Example() { return <section><div>A</div><div>B</div><div>C</div></section> }"
function intent(
  source: string,
  scope: Viewport,
  index = 1,
  state = initialTweakState
) {
  const target = metadata(source)[index]
  return reducer(state, {
    kind: "set",
    scope,
    path: target.loc,
    axis: "pt",
    edit: { suffix: "8", valueRem: 2, target },
  })
}
function operation(state: State, scope: Viewport): ClassTweakOperation {
  const edit = Object.values(state.edits[scope])[0].pt!
  const next = emitScopedSpacingUtility("pt", edit.suffix, scope)
  return {
    kind: "class.replace",
    target: edit.target.loc,
    tag: edit.target.tag,
    sourceHash: edit.target.sourceHash,
    scope,
    group: "spacing:pt",
    expected: findExpectedSpacingUtility(
      edit.target.sourceClassTokens,
      "pt",
      scope
    ),
    next,
    postcondition: { kind: "class-token", value: next },
  }
}
async function expectRefusedWithoutWrites(
  state: State,
  source: string,
  scope: Viewport,
  originalHash: string
) {
  const root = await mkdtemp(join(tmpdir(), "sim-pending-revision-"))
  const checkpointDir = join(root, ".nextcms/visual-tweak-checkpoints/example")
  try {
    await mkdir(dirname(join(root, file)), { recursive: true })
    await mkdir(checkpointDir, { recursive: true })
    await writeFile(join(root, file), source)
    await writeFile(
      join(checkpointDir, "existing.json"),
      "existing checkpoint bytes\n"
    )
    const result = await applyClassOperationFileBatch({
      root,
      type: "example",
      operations: [operation(state, scope)],
    })
    const [key, axes] = Object.entries(state.edits[scope])[0]
    expect({
      unresolved: key.startsWith("unresolved:"),
      disabled: !!axes.pt?.disabledReason,
      sourceHash: axes.pt?.target.sourceHash,
      writer: result.ok ? "unexpected-write" : result.code,
      source: await readFile(join(root, file), "utf8"),
      checkpoints: await readdir(checkpointDir),
      checkpoint: await readFile(join(checkpointDir, "existing.json"), "utf8"),
    }).toEqual({
      unresolved: true,
      disabled: true,
      sourceHash: originalHash,
      writer: "hash-mismatch",
      source,
      checkpoints: ["existing.json"],
      checkpoint: "existing checkpoint bytes\n",
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}
const revisionScopes = ["all", "below-sm", "sm-and-up"] as const
test.each(
  revisionScopes.flatMap((scope) =>
    ["insert", "reorder", "other-class"].map((change) => ({ scope, change }))
  )
)(
  "R1 P1 refuses external $change in $scope through metadata, reducer and file writer",
  async ({ scope, change }) => {
    const state = intent(revisionSource, scope)
    const external =
      change === "insert"
        ? revisionSource.replace("<div>A", "<div /><div>A")
        : change === "reorder"
          ? revisionSource.replace(
              "<div>A</div><div>B</div>",
              "<div>B</div><div>A</div>"
            )
          : revisionSource.replace("<div>C", '<div className="pb-4">C')
    const refreshed = reducer(state, {
      kind: "targets",
      targets: metadata(external),
    })
    await expectRefusedWithoutWrites(
      refreshed,
      external,
      scope,
      hashTweakSource(revisionSource)
    )
  }
)
test.each(revisionScopes)(
  "R1 P1 invalidates outstanding transition before a new %s intent on another revision",
  async (scope) => {
    const pending = intent(revisionSource, scope)
    const own = save(
      revisionSource,
      pending,
      (diffs) => diffs,
      () => []
    )
    const external = own.source.replace("<div>C", '<div className="pb-4">C')
    let state = reducer(own.state, {
      kind: "targets",
      targets: metadata(external),
    })
    state = intent(external, scope, 3, state)
    state = reducer(state, { kind: "targets", targets: metadata(own.source) })
    // The pending row belongs to H2, even though an older own-save H1 receipt existed.
    const pendingRows = Object.entries(state.edits[scope]).filter(
      ([, axes]) => axes.pt?.target.sourceHash === hashTweakSource(external)
    )
    const isolated = {
      ...state,
      edits: { ...state.edits, [scope]: Object.fromEntries(pendingRows) },
    }
    await expectRefusedWithoutWrites(
      isolated,
      own.source,
      scope,
      hashTweakSource(external)
    )
  }
)
test.each(revisionScopes)(
  "R1 P1 failed %s Save never authorizes an early snapshot",
  async (scope) => {
    let state = intent(revisionSource, scope)
    const row = Object.values(state.edits[scope])[0].pt!
    state = reducer(state, { kind: "saving", value: true })
    const external = revisionSource.replace("<div>A", "<div /><div>A")
    state = reducer(state, { kind: "targets", targets: metadata(external) })
    state = reducer(state, {
      kind: "reconcileSave",
      rows: [
        {
          scope,
          path: row.target.loc,
          stablePath: row.target.sourcePath,
          axis: "pt",
          suffix: "8",
          sourceHash: row.target.sourceHash,
          status: "skipped",
        },
      ],
    })
    state = reducer(state, { kind: "saving", value: false })
    await expectRefusedWithoutWrites(
      state,
      external,
      scope,
      hashTweakSource(revisionSource)
    )
  }
)
test.each(revisionScopes)(
  "R1 P1 own %s HMR before receipt defers rejection and preserves verified replay",
  (scope) => {
    let state = intent(revisionSource, scope)
    const op = operation(state, scope)
    const written = applyClassOperationBatch({
      source: revisionSource,
      file,
      operations: [op],
    })
    if (!written.ok) throw Error(written.code)
    state = reducer(state, { kind: "saving", value: true })
    state = reducer(state, {
      kind: "targets",
      targets: metadata(written.source),
    })
    // No irreversible rejection or adoption before the writer receipt arrives.
    const waiting = Object.values(state.edits[scope])[0].pt!
    expect(waiting.target.sourceHash).toBe(hashTweakSource(revisionSource))
    expect(waiting.disabledReason ?? "").not.toContain("cannot be matched")
    state = reducer(state, {
      kind: "reconcileSave",
      sourceHash: hashTweakSource(written.source),
      targets: [],
      diffs: written.diffs,
      rows: [
        {
          scope,
          path: op.target,
          stablePath: "jsx.1",
          axis: "pt",
          suffix: "8",
          sourceHash: op.sourceHash!,
          status: "applied",
        },
      ],
    })
    state = reducer(state, { kind: "saving", value: false })
    state = reducer(state, { kind: "undo" })
    const undo = Object.values(state.edits[scope])[0].pt!
    expect(undo.disabledReason).toBeUndefined()
    expect(undo.remove).toBe(true)
    expect(undo.target.sourceHash).toBe(hashTweakSource(written.source))
    expect(undo.expected).toBe(emitScopedSpacingUtility("pt", "8", scope))
    const removed = save(written.source, state)
    expect(removed.source).not.toContain(
      emitScopedSpacingUtility("pt", "8", scope)
    )
  }
)
function save(
  source: string,
  state: State,
  returnedDiffs = (diffs: ClassTweakDiff[]) => diffs,
  returnedTargets = metadata
) {
  const rows: Array<{
    scope: Viewport
    path: string
    stablePath?: string
    axis: ToolbarSpacingAxis
    suffix: string
    sourceHash: string
    status: "applied"
  }> = []
  const operations: ClassTweakOperation[] = []
  for (const scope of ["all", "below-sm", "sm-and-up"] as const)
    for (const [path, axes] of Object.entries(state.edits[scope]))
      for (const [axis, edit] of Object.entries(axes) as [
        ToolbarSpacingAxis,
        NonNullable<typeof axes.pt>,
      ][]) {
        expect(edit.disabledReason).toBeUndefined()
        const common = {
          target: path,
          tag: edit.target.tag,
          scope,
          group: `spacing:${axis}` as const,
          sourceHash: edit.target.sourceHash,
        }
        const next = emitScopedSpacingUtility(axis, edit.suffix, scope)
        operations.push(
          edit.remove
            ? {
                ...common,
                kind: "class.remove",
                expected: edit.expected!,
                postcondition: { kind: "class-absent" },
              }
            : {
                ...common,
                kind: "class.replace",
                expected: findExpectedSpacingUtility(
                  edit.target.sourceClassTokens,
                  axis,
                  scope
                ),
                next,
                postcondition: { kind: "class-token", value: next },
              }
        )
        rows.push({
          scope,
          path,
          stablePath: edit.target.sourcePath,
          axis,
          suffix: edit.suffix,
          sourceHash: edit.target.sourceHash,
          status: "applied",
        })
      }
  const result = applyClassOperationBatch({ source, file, operations })
  if (!result.ok) throw Error(`${result.code}: ${result.error}`)
  return {
    source: result.source,
    state: reducer(state, {
      kind: "reconcileSave",
      rows,
      diffs: returnedDiffs(result.diffs),
      sourceHash: hashTweakSource(result.source),
      targets: returnedTargets(result.source),
    }),
  }
}
test.each(["all", "below-sm", "sm-and-up"] as const)(
  "two %s absent-add-Save-undo-remove-redo-restore cycles retain samples, scopes, hashes and source paths",
  (scope) => {
    let source =
      'import { cn } from "@/lib/utils"; export function Example() { return <section className={cn("bg-surface gap-2")}><span className="text-body">Text</span></section> }'
    const originalSibling = metadata(source)[1].loc
    const target = metadata(source)[0]
    let state = reducer(initialTweakState, {
      kind: "sample",
      path: "primary.eyebrow",
      value: "Example",
      selection: null,
    })
    state = reducer(state, {
      kind: "set",
      scope: "all",
      path: target.loc,
      axis: "gap",
      edit: { suffix: "4", valueRem: 1, target },
    })
    state = reducer(state, {
      kind: "set",
      scope,
      path: target.loc,
      axis: "pt",
      edit: { suffix: "8", valueRem: 2, target },
    })
    ;({ source, state } = save(source, state))
    expect(metadata(source)[1].loc).not.toBe(originalSibling)
    for (let cycle = 0; cycle < 2; cycle++) {
      state = reducer(state, { kind: "undo" })
      const pending = state.edits[scope][state.targets["jsx.0"].loc].pt!
      expect(pending.remove).toBe(true)
      expect(pending.expected).toBe(emitScopedSpacingUtility("pt", "8", scope))
      expect(pending.target.sourceHash).toBe(hashTweakSource(source))
      ;({ source, state } = save(source, state))
      expect(source).not.toContain(emitScopedSpacingUtility("pt", "8", scope))
      state = reducer(state, { kind: "redo" })
      ;({ source, state } = save(source, state))
      expect(source).toContain(emitScopedSpacingUtility("pt", "8", scope))
      expect(state.samples.default["primary.eyebrow"]).toBe("Example")
      expect(source).toContain("gap-4")
      expect(source).not.toContain(', "", ""')
    }
  }
)
test("external revision disables removal; restoring the exact saved revision recovers the intent", () => {
  const source =
    'export function Example() { return <section className="bg-surface" /> }'
  const target = metadata(source)[0]
  let state = reducer(initialTweakState, {
    kind: "set",
    scope: "all",
    path: target.loc,
    axis: "pt",
    edit: { suffix: "8", valueRem: 2, target },
  })
  const saved = save(source, state)
  state = reducer(saved.state, { kind: "undo" })
  const external = saved.source.replace("pt-8", "pt-12")
  state = reducer(state, { kind: "targets", targets: metadata(external) })
  expect(Object.values(state.edits.all)[0].pt?.disabledReason).toContain(
    "cannot be matched"
  )
  expect(Object.values(state.edits.all)[0].pt?.target.sourceHash).toBe(
    hashTweakSource(saved.source)
  )
  state = reducer(state, { kind: "targets", targets: metadata(saved.source) })
  expect(Object.values(state.edits.all)[0].pt?.disabledReason).toBeUndefined()
  expect(Object.values(state.edits.all)[0].pt?.remove).toBe(true)
})
test.each([
  "missing",
  "target",
  "tag",
  "scope",
  "group",
  "after",
  "duplicate",
  "snapshot",
])(
  "removal refuses %s Save diff evidence instead of adopting a current token",
  (invalid) => {
    const source =
      'export function Example() { return <section className="bg-surface" /> }'
    const target = metadata(source)[0]
    const state = reducer(initialTweakState, {
      kind: "set",
      scope: "all",
      path: target.loc,
      axis: "pt",
      edit: { suffix: "8", valueRem: 2, target },
    })
    const saved = save(
      source,
      state,
      (diffs) => {
        if (invalid === "missing") return []
        if (invalid === "duplicate") return [...diffs, ...diffs]
        return diffs.map((diff) => ({
          ...diff,
          ...(invalid === "target" ? { target: "another-loc" } : {}),
          ...(invalid === "tag" ? { tag: "span" } : {}),
          ...(invalid === "scope" ? { scope: "sm-and-up" as const } : {}),
          ...(invalid === "group" ? { group: "spacing:pb" as const } : {}),
          ...(invalid === "after" ? { after: "bg-surface pt-12" } : {}),
        }))
      },
      (source) =>
        metadata(source).map((target) =>
          invalid === "snapshot"
            ? { ...target, sourceClassTokens: ["bg-surface", "pt-12"] }
            : target
        )
    )
    const undone = reducer(saved.state, { kind: "undo" })
    const pending = Object.values(undone.edits.all)[0].pt!
    expect(pending.remove).toBe(true)
    expect(pending.expected).toBeUndefined()
    expect(pending.disabledReason).toContain("diff evidence")
    expect(JSON.stringify(undone.past)).not.toContain("removalEvidence")
  }
)

/**
 * Pure state layer for the contextual visual tweak editor (ADR-0030 +
 * 2026-07-06 perf addendum). Kept out of the provider's `.tsx` so the reducer,
 * its types, and helpers can be exported and unit-tested without dragging in a
 * component export (which would break the provider file's Fast Refresh).
 */

import type {
  ToolbarSpacingAxis,
  ToolbarStatus,
} from "./slice-tweak-toolbar-types"
import {
  emitScopedSpacingUtility,
  findExpectedSpacingUtility,
} from "@/lib/slices/visual-tweak/spacing-operation"
import { signedSpacingSuffixToRem } from "@/lib/slices/visual-tweak/scale"
import {
  canonicalSampleValue,
  type SampleField,
  type SampleSelection,
  type SampleValues,
} from "./sim-sample-state"
import type {
  ClassTweakDiff,
  TweakScope,
} from "@/lib/slices/visual-tweak/class-operations"

export type PendingTweakTarget = {
  loc: string
  sourcePath?: string
  tag: string
  sourceHash: string
  sourceClassTokens: string[]
  editable: boolean
  templateWide: boolean
  label: string
  path: string
}

/** One accumulated axis edit: the on-token suffix to persist + its rem for the
 *  optimistic inline preview / display. */
export interface AxisEdit {
  suffix: string
  valueRem: number
  target: PendingTweakTarget
  remove?: boolean
  expected?: string
  disabledReason?: string
  admissionKey?: string
}

/** Exact responsive scope chosen by the operator. */
export type Viewport = TweakScope

/** Unsaved edits for a single viewport, keyed by element path then axis. */
export type PendingEdits = Record<
  string,
  Partial<Record<ToolbarSpacingAxis, AxisEdit>>
>

/** The whole batch, nested by exact responsive scope before loc and axis. */
export type ScopedEdits = Record<Viewport, PendingEdits>

export interface PendingEditFailure {
  scope: Viewport
  path: string
  axis: ToolbarSpacingAxis
  suffix: string
  reason: string
}

export function pendingEditId(
  scope: Viewport,
  path: string,
  axis: ToolbarSpacingAxis
): string {
  return JSON.stringify([scope, path, axis])
}

/** An empty batch — a `PendingEdits` per viewport. */
export function emptyScopedEdits(): ScopedEdits {
  return { all: {}, "below-sm": {}, "sm-and-up": {} }
}

import {
  shiftTypographyValue,
  type TypographyPreviewEdits,
  type TypographyStep,
} from "@/lib/slices/visual-tweak/typography"

type AppearanceValue = { suffix: string | null; valueRem: number }
export type AppearanceValues = Record<
  Viewport,
  Record<string, Partial<Record<ToolbarSpacingAxis, AppearanceValue>>>
>
export type HistoryEntry = {
  typography: TypographyPreviewEdits
  appearance: AppearanceValues
  samples: Record<string, SampleValues>
  preset: string
  selection: SampleSelection
}
export interface State extends HistoryEntry {
  sampleDefaults: Record<string, SampleValues>
  sampleStorageScope: string | null
  edits: ScopedEdits
  initialAppearance: AppearanceValues
  savedAppearance: AppearanceValues
  /** Tokens owned by this session's successful Save diffs, never history. */
  removalEvidence: AppearanceValues
  targets: Record<string, PendingTweakTarget>
  past: HistoryEntry[]
  future: HistoryEntry[]
  group: string | null
  reapplyNonce: number
  resetNonce: number
  saving: boolean
  status: ToolbarStatus | null
  failures: Record<string, PendingEditFailure>
  /** One successful writer transition; traversal identity is valid only here. */
  refreshHash: { beforeHash: string; afterHash: string } | null
  targetSnapshot: PendingTweakTarget[]
  admissionReasons: Record<string, string>
}
export type Action =
  | ({ kind: "typography" } & TypographyStep)
  | {
      kind: "set"
      scope: Viewport
      path: string
      axis: ToolbarSpacingAxis
      edit: AxisEdit
    }
  | {
      kind: "setMany"
      scope: Viewport
      path: string
      axes: readonly ToolbarSpacingAxis[]
      edit: AxisEdit
    }
  | { kind: "load"; edits: ScopedEdits }
  | { kind: "undo" }
  | { kind: "redo" }
  | { kind: "saving"; value: boolean }
  | { kind: "status"; status: ToolbarStatus | null }
  | {
      kind: "reconcileSave"
      sourceHash?: string
      targets?: PendingTweakTarget[]
      diffs?: ClassTweakDiff[]
      rows: Array<{
        scope: Viewport
        path: string
        axis: ToolbarSpacingAxis
        suffix: string
        sourceHash: string
        stablePath?: string
        status: "applied" | "skipped"
        reason?: string
      }>
    }
  | { kind: "clearEdits" }
  | { kind: "resetTarget"; scope: Viewport; path: string }
  | {
      kind: "sample"
      path: string
      value: string
      selection: SampleSelection
      group?: string
      field?: SampleField
    }
  | { kind: "sampleSeed"; values: SampleValues }
  | {
      kind: "samplePresets"
      scope: string
      defaults: Record<string, SampleValues>
      stored: Record<string, SampleValues>
    }
  | { kind: "sampleSelection"; selection: SampleSelection }
  | { kind: "closeGroup" }
  | { kind: "preset"; key: string }
  | { kind: "resetSamples" }
  | { kind: "targets"; targets: PendingTweakTarget[] }
  | { kind: "sourceRestored"; targets: PendingTweakTarget[] }

export const initialTweakState: State = {
  typography: {},
  edits: emptyScopedEdits(),
  appearance: emptyScopedEdits(),
  initialAppearance: emptyScopedEdits(),
  savedAppearance: emptyScopedEdits(),
  removalEvidence: emptyScopedEdits(),
  targets: {},
  samples: { default: {} },
  sampleDefaults: {},
  sampleStorageScope: null,
  preset: "default",
  selection: null,
  past: [],
  future: [],
  group: null,
  reapplyNonce: 0,
  resetNonce: 0,
  saving: false,
  status: null,
  failures: {},
  refreshHash: null,
  targetSnapshot: [],
  admissionReasons: {},
}
const scopes = ["all", "below-sm", "sm-and-up"] as const
function snapshot(state: State): HistoryEntry {
  return {
    typography: state.typography,
    appearance: state.appearance,
    samples: state.samples,
    preset: state.preset,
    selection: state.selection,
  }
}
function remember(state: State): Pick<State, "past" | "future" | "group"> {
  return {
    past: [...state.past, snapshot(state)].slice(-100),
    future: [],
    group: null,
  }
}
function put(
  values: AppearanceValues,
  scope: Viewport,
  loc: string,
  axis: ToolbarSpacingAxis,
  value: AppearanceValue
): AppearanceValues {
  return {
    ...values,
    [scope]: {
      ...values[scope],
      [loc]: { ...values[scope][loc], [axis]: value },
    },
  }
}
function overlay(
  base: AppearanceValues,
  values: AppearanceValues
): AppearanceValues {
  const next = { ...base }
  for (const scope of scopes) {
    next[scope] = { ...base[scope] }
    for (const [loc, axes] of Object.entries(values[scope]))
      next[scope][loc] = { ...base[scope][loc], ...axes }
  }
  return next
}
function pending(state: State): ScopedEdits {
  const edits = emptyScopedEdits()
  for (const scope of scopes)
    for (const [loc, axes] of Object.entries(state.appearance[scope])) {
      const target = state.targets[loc]
      if (!target || (!target.sourceHash && !state.admissionReasons[loc]))
        continue
      for (const [axis, value] of Object.entries(axes) as [
        ToolbarSpacingAxis,
        AppearanceValue,
      ][]) {
        const saved = state.savedAppearance[scope][loc]?.[axis]
        const actual = findExpectedSpacingUtility(
          target.sourceClassTokens,
          axis,
          scope
        )
        if (
          value.suffix === null &&
          actual === null &&
          !state.admissionReasons[loc]
        )
          continue
        if (value.suffix === saved?.suffix) continue
        const savedToken =
          saved?.suffix === null || saved?.suffix === undefined
            ? null
            : emitScopedSpacingUtility(axis, saved.suffix, scope)
        const proof = state.removalEvidence[scope][loc]?.[axis]?.suffix
        const expected = value.suffix === null ? (proof ?? null) : savedToken
        const disabledReason =
          state.admissionReasons[loc] ??
          (state.refreshHash &&
          target.sourceHash !== state.refreshHash.afterHash
            ? "Waiting for the saved source revision before replaying history."
            : value.suffix === null && (!proof || proof !== savedToken)
              ? "The successful Save did not return matching diff evidence for removing this token."
              : actual !== expected
                ? "The saved spacing token changed outside this editing session. This history change cannot be saved."
                : undefined)
        const rowKey = state.admissionReasons[loc] ? loc : target.loc
        edits[scope][rowKey] ??= {}
        edits[scope][rowKey][axis] = {
          suffix: value.suffix ?? "",
          valueRem: value.valueRem,
          target,
          ...(value.suffix === null
            ? { remove: true, ...(expected ? { expected } : {}) }
            : {}),
          ...(disabledReason ? { disabledReason } : {}),
          ...(state.admissionReasons[loc] ? { admissionKey: loc } : {}),
        }
      }
    }
  return edits
}
function finish(state: State): State {
  return { ...state, edits: pending(state) }
}
function establish(
  state: State,
  scope: Viewport,
  loc: string,
  axis: ToolbarSpacingAxis,
  edit: AxisEdit
): State {
  let next = { ...state, targets: { ...state.targets, [loc]: edit.target } }
  if (state.initialAppearance[scope][loc]?.[axis] === undefined) {
    const token = findExpectedSpacingUtility(
      edit.target.sourceClassTokens,
      axis,
      scope
    )
    const raw = token?.split(":").at(-1)
    const suffix = raw
      ? `${raw.startsWith("-") ? "-" : ""}${raw.replace(new RegExp(`^-?${axis}-`), "")}`
      : null
    const value = {
      suffix,
      valueRem: suffix === null ? 0 : (signedSpacingSuffixToRem(suffix) ?? 0),
    }
    next = {
      ...next,
      initialAppearance: put(state.initialAppearance, scope, loc, axis, value),
      savedAppearance: put(state.savedAppearance, scope, loc, axis, value),
      appearance: put(state.appearance, scope, loc, axis, value),
    }
  }
  return next
}
const ADMISSION_REASON =
  "This saved draft cannot be matched to the current source. Discard it or restore its source revision."
function appearanceMaps(state: State): AppearanceValues[] {
  return [
    state.appearance,
    state.initialAppearance,
    state.savedAppearance,
    ...state.past.map((entry) => entry.appearance),
    ...state.future.map((entry) => entry.appearance),
  ]
}
function canRename(state: State, from: string, to: string): boolean {
  if (from === to) return true
  return appearanceMaps(state).every((values) =>
    scopes.every((scope) =>
      Object.entries(values[scope][from] ?? {}).every(([axis, value]) => {
        const destination = values[scope][to]?.[axis as ToolbarSpacingAxis]
        return (
          !destination ||
          (destination.suffix === value?.suffix &&
            destination.valueRem === value?.valueRem)
        )
      })
    )
  )
}
function renameValues(
  values: AppearanceValues,
  from: string,
  to: string
): AppearanceValues {
  if (from === to) return values
  const next = { ...values }
  for (const scope of scopes) {
    if (!values[scope][from]) continue
    next[scope] = {
      ...values[scope],
      [to]: { ...values[scope][to], ...values[scope][from] },
    }
    delete next[scope][from]
  }
  return next
}
function renameIntent(state: State, from: string, to: string): State {
  if (from === to) return state
  return {
    ...state,
    appearance: renameValues(state.appearance, from, to),
    initialAppearance: renameValues(state.initialAppearance, from, to),
    savedAppearance: renameValues(state.savedAppearance, from, to),
    removalEvidence: renameValues(state.removalEvidence, from, to),
    past: state.past.map((entry) => ({
      ...entry,
      appearance: renameValues(entry.appearance, from, to),
    })),
    future: state.future.map((entry) => ({
      ...entry,
      appearance: renameValues(entry.appearance, from, to),
    })),
  }
}
/** Exact revision evidence, or a single writer-proven class-only transition. */
function admitTargets(
  state: State,
  snapshot: PendingTweakTarget[],
  loading = false
): State {
  let next = state
  const revision =
    snapshot.length &&
    snapshot.every((target) => target.sourceHash === snapshot[0].sourceHash)
      ? snapshot[0].sourceHash
      : null
  const transition =
    !loading && revision === state.refreshHash?.afterHash
      ? state.refreshHash
      : null
  const reasons = { ...state.admissionReasons }
  const fresh = new Map<string, PendingTweakTarget[]>()
  for (const target of snapshot) {
    const key = target.sourcePath ?? target.loc
    fresh.set(key, [...(fresh.get(key) ?? []), target])
  }
  const targets: Record<string, PendingTweakTarget> = {}
  for (const [key, candidates] of fresh)
    if (candidates.length === 1) targets[key] = candidates[0]
  const keys = new Set(
    appearanceMaps(state).flatMap((values) =>
      scopes.flatMap((scope) => Object.keys(values[scope]))
    )
  )
  for (const key of keys) {
    const original = state.targets[key]
    if (!original) continue
    const eligible = snapshot.filter(
      (target) =>
        original.editable &&
        target.editable &&
        target.tag === original.tag &&
        !!target.sourceHash
    )
    const exact = eligible.filter(
      (target) =>
        !!original.sourceHash &&
        target.loc === original.loc &&
        target.sourceHash === original.sourceHash
    )
    const candidates = exact.length
      ? exact
      : eligible.filter(
          (target) =>
            transition &&
            original.sourceHash === transition.beforeHash &&
            target.sourceHash === transition.afterHash &&
            !!original.sourcePath &&
            target.sourcePath === original.sourcePath
        )
    const match = candidates.length === 1 ? candidates[0] : undefined
    const destination = match && (match.sourcePath ?? match.loc)
    if (
      match &&
      destination &&
      fresh.get(destination)?.length === 1 &&
      canRename(next, key, destination)
    ) {
      next = renameIntent(next, key, destination)
      targets[destination] = {
        ...match,
        label: original.label,
        path: original.path,
      }
      delete reasons[key]
    } else {
      const unresolved = key.startsWith("unresolved:")
        ? key
        : `unresolved:${key}`
      next = renameIntent(next, key, unresolved)
      targets[unresolved] = original
      delete reasons[key]
      reasons[unresolved] = ADMISSION_REASON
    }
  }
  return {
    ...next,
    targets,
    targetSnapshot: snapshot,
    admissionReasons: reasons,
    // A snapshot of the before revision can precede HMR. The first after
    // snapshot consumes the authority; any unrelated revision invalidates it.
    refreshHash:
      !loading && revision === state.refreshHash?.beforeHash
        ? state.refreshHash
        : null,
  }
}

export function reducer(state: State, action: Action): State {
  switch (action.kind) {
    case "samplePresets":
      return {
        ...state,
        sampleDefaults: action.defaults,
        sampleStorageScope: action.scope,
        samples: Object.fromEntries(
          Object.entries(action.defaults).map(([key, defaults]) => [
            key,
            {
              ...defaults,
              ...action.stored[key],
              ...(state.sampleStorageScope === null ||
              state.sampleStorageScope === action.scope
                ? state.samples[key]
                : {}),
            },
          ])
        ),
        reapplyNonce: state.reapplyNonce + 1,
      }
    case "sampleSeed":
      return {
        ...state,
        samples: {
          ...state.samples,
          [state.preset]: { ...action.values, ...state.samples[state.preset] },
        },
      }
    case "sampleSelection":
      return { ...state, selection: action.selection }
    case "closeGroup":
      return { ...state, group: null }
    case "typography": {
      const previous = state.typography[action.role]?.[action.property]
      const current = previous?.after ?? action.initialValue
      const shifted = shiftTypographyValue({
        property: action.property,
        value: current,
        delta: action.delta,
        rootFontSizePx: action.rootFontSizePx,
        computedLetterSpacing: action.computedLetterSpacing,
        fontSizePx: action.fontSizePx,
      })
      if (!shifted.ok || shifted.value === current) return state
      const before = previous?.before ?? action.initialValue
      const roleEdits = { ...state.typography[action.role] }
      if (shifted.value === before) delete roleEdits[action.property]
      else roleEdits[action.property] = { before, after: shifted.value }
      const typography = { ...state.typography }
      if (Object.keys(roleEdits).length) typography[action.role] = roleEdits
      else delete typography[action.role]
      return {
        ...state,
        ...remember(state),
        typography,
        reapplyNonce: state.reapplyNonce + 1,
      }
    }
    case "sample": {
      const previous = state.samples[state.preset]?.[action.path]
      const canonical =
        action.field && canonicalSampleValue(action.field, action.value)
      if (
        previous === action.value ||
        (canonical !== null &&
          canonical !== undefined &&
          canonical ===
            canonicalSampleValue(
              action.field!,
              previous ??
                state.sampleDefaults[state.preset]?.[action.path] ??
                action.field!.value
            ))
      )
        return { ...state, selection: action.selection }
      const group = action.group
        ? `${state.preset}:${action.path}:${action.group}`
        : null
      return {
        ...state,
        ...(group && group === state.group ? {} : remember(state)),
        group,
        samples: {
          ...state.samples,
          [state.preset]: {
            ...state.samples[state.preset],
            [action.path]: action.value,
          },
        },
        selection: action.selection,
      }
    }
    case "preset":
      return {
        ...state,
        preset: action.key,
        reapplyNonce: state.reapplyNonce + 1,
        samples: {
          ...state.samples,
          [action.key]: state.samples[action.key] ?? {},
        },
        selection: null,
        group: null,
      }
    case "resetSamples":
      return {
        ...state,
        reapplyNonce: state.reapplyNonce + 1,
        resetNonce: state.resetNonce + 1,
        samples: {
          ...state.samples,
          [state.preset]: state.sampleDefaults[state.preset] ?? {},
        },
        selection: null,
        group: null,
      }
    case "sourceRestored":
      return {
        ...initialTweakState,
        targetSnapshot: action.targets,
        samples: state.samples,
        typography: state.typography,
        sampleDefaults: state.sampleDefaults,
        sampleStorageScope: state.sampleStorageScope,
        resetNonce: state.resetNonce,
        preset: state.preset,
        targets: Object.fromEntries(
          action.targets.map((target) => [
            target.sourcePath ?? target.loc,
            target,
          ])
        ),
        reapplyNonce: state.reapplyNonce + 1,
      }
    case "targets": {
      // HMR can beat its Save receipt. Preserve the original intent until the
      // receipt proves a transition (or saving:false refuses it).
      if (state.saving) return { ...state, targetSnapshot: action.targets }
      const admitted = admitTargets(state, action.targets)
      const targets = admitted.targets
      let saved = admitted.savedAppearance
      for (const scope of scopes)
        for (const [key, axes] of Object.entries(admitted.appearance[scope]))
          for (const [axis, value] of Object.entries(axes) as [
            ToolbarSpacingAxis,
            AppearanceValue,
          ][]) {
            if (
              value.suffix === null &&
              !admitted.admissionReasons[key] &&
              targets[key] &&
              findExpectedSpacingUtility(
                targets[key].sourceClassTokens,
                axis,
                scope
              ) === null
            )
              saved = put(saved, scope, key, axis, value)
          }
      return finish({
        ...admitted,
        targets,
        savedAppearance: saved,
        reapplyNonce: state.reapplyNonce + 1,
      })
    }
    case "load": {
      let next = {
        ...initialTweakState,
        samples: state.samples,
        sampleDefaults: state.sampleDefaults,
        sampleStorageScope: state.sampleStorageScope,
        resetNonce: state.resetNonce,
        preset: state.preset,
      }
      for (const scope of scopes)
        for (const [loc, axes] of Object.entries(action.edits[scope]))
          for (const [axis, edit] of Object.entries(axes) as [
            ToolbarSpacingAxis,
            AxisEdit,
          ][]) {
            const key = edit.admissionKey ?? edit.target.sourcePath ?? loc
            next = establish(next, scope, key, axis, edit)
            next.appearance = put(next.appearance, scope, key, axis, {
              suffix: edit.remove ? null : edit.suffix,
              valueRem: edit.valueRem,
            })
          }
      return finish({
        ...admitTargets(next, state.targetSnapshot, true),
        reapplyNonce: state.reapplyNonce + 1,
      })
    }
    case "set":
    case "setMany": {
      let next = state
      const key = action.edit.target.sourcePath ?? action.path
      const axes = action.kind === "set" ? [action.axis] : action.axes
      for (const axis of axes)
        next = establish(next, action.scope, key, axis, action.edit)
      if (
        axes.every(
          (axis) =>
            next.appearance[action.scope][key]?.[axis]?.suffix ===
            action.edit.suffix
        )
      ) {
        const previous = state.targets[key]
        const current = action.edit.target
        return previous?.sourceHash === current.sourceHash &&
          JSON.stringify(previous.sourceClassTokens) ===
            JSON.stringify(current.sourceClassTokens)
          ? state
          : finish(next)
      }
      const remembered = remember(next)
      for (const axis of axes)
        next = {
          ...next,
          appearance: put(next.appearance, action.scope, key, axis, {
            suffix: action.edit.suffix,
            valueRem: action.edit.valueRem,
          }),
        }
      return finish({ ...next, ...remembered, status: null, failures: {} })
    }
    case "resetTarget": {
      if (!state.edits[action.scope][action.path]) return state
      const key =
        Object.keys(state.targets).find(
          (key) => state.targets[key].loc === action.path
        ) ?? action.path
      return finish({
        ...state,
        ...remember(state),
        appearance: {
          ...state.appearance,
          [action.scope]: {
            ...state.appearance[action.scope],
            [key]: state.savedAppearance[action.scope][key] ?? {},
          },
        },
        reapplyNonce: state.reapplyNonce + 1,
        failures: {},
      })
    }
    case "undo":
    case "redo": {
      const from = action.kind === "undo" ? state.past : state.future
      if (!from.length) return state
      const entry = from.at(-1)!
      return finish({
        ...state,
        ...entry,
        appearance: overlay(state.initialAppearance, entry.appearance),
        past:
          action.kind === "undo"
            ? from.slice(0, -1)
            : [...state.past, snapshot(state)],
        future:
          action.kind === "redo"
            ? from.slice(0, -1)
            : [...state.future, snapshot(state)],
        group: null,
        reapplyNonce: state.reapplyNonce + 1,
        status: null,
        failures: {},
      })
    }
    case "saving": {
      const next = { ...state, saving: action.value }
      return state.saving && !action.value && state.targetSnapshot.length
        ? reducer(
            { ...next, refreshHash: null },
            { kind: "targets", targets: state.targetSnapshot }
          )
        : next
    }
    case "status":
      return { ...state, status: action.status }
    case "clearEdits": {
      if (
        !scopedEditCount(state.edits) &&
        !Object.keys(state.typography).length
      )
        return { ...state, group: null }
      return finish({
        ...state,
        ...remember(state),
        appearance: state.savedAppearance,
        typography: {},
        failures: {},
        reapplyNonce: state.reapplyNonce + 1,
      })
    }
    case "reconcileSave": {
      const next = { ...state, failures: { ...state.failures }, group: null }
      const freshSnapshot = action.targets?.length
        ? action.targets
        : state.targetSnapshot
      for (const row of action.rows) {
        const key = row.stablePath ?? row.path
        const target = state.targets[key]
        const current = target && state.edits[row.scope][target.loc]?.[row.axis]
        if (
          !current ||
          current.suffix !== row.suffix ||
          (current.target.sourceHash !== row.sourceHash &&
            current.target.sourceHash !== action.sourceHash)
        )
          continue
        const id = pendingEditId(row.scope, row.path, row.axis)
        if (row.status === "skipped")
          next.failures[id] = {
            ...row,
            reason: row.reason ?? "This change could not be saved.",
          }
        else {
          // The returned diff must name the submitted loc/scope/group. Its
          // actual after-token must also agree with the fresh stable target.
          const diffs =
            action.diffs?.filter(
              (diff) =>
                diff.target === row.path &&
                diff.tag === current.target.tag &&
                diff.scope === row.scope &&
                diff.group === `spacing:${row.axis}`
            ) ?? []
          const diffToken =
            diffs.length === 1
              ? findExpectedSpacingUtility(
                  diffs[0].after.split(/\s+/).filter(Boolean),
                  row.axis,
                  row.scope
                )
              : null
          const fresh = freshSnapshot.filter(
            (candidate) =>
              (candidate.sourcePath ?? candidate.loc) === key &&
              candidate.tag === current.target.tag &&
              candidate.editable &&
              candidate.sourceHash === action.sourceHash
          )
          const freshToken =
            fresh.length === 1
              ? findExpectedSpacingUtility(
                  fresh[0].sourceClassTokens,
                  row.axis,
                  row.scope
                )
              : null
          const requestedToken = current.remove
            ? null
            : emitScopedSpacingUtility(row.axis, current.suffix, row.scope)
          next.removalEvidence = put(
            next.removalEvidence,
            row.scope,
            key,
            row.axis,
            {
              suffix:
                !current.remove &&
                diffToken === requestedToken &&
                freshToken === diffToken
                  ? diffToken
                  : null,
              valueRem: 0,
            }
          )
          next.savedAppearance = put(
            next.savedAppearance,
            row.scope,
            key,
            row.axis,
            {
              suffix: current.remove ? null : current.suffix,
              valueRem: current.valueRem,
            }
          )
          delete next.failures[id]
        }
      }
      if (
        action.sourceHash &&
        action.rows.some((row) => row.status === "applied") &&
        action.rows.every(
          (row) =>
            !!row.sourceHash && row.sourceHash === action.rows[0].sourceHash
        )
      ) {
        next.refreshHash = {
          beforeHash: action.rows[0].sourceHash,
          afterHash: action.sourceHash,
        }
        next.saving = false
        if (freshSnapshot.length)
          return reducer(next, { kind: "targets", targets: freshSnapshot })
      }
      return finish(next)
    }
  }
}

/** Number of axis edits in one viewport's `PendingEdits`. */
export function pendingEditCount(edits: PendingEdits): number {
  let n = 0
  for (const axes of Object.values(edits)) n += Object.keys(axes).length
  return n
}

/** Total axis edits across every viewport in the batch. */
export function scopedEditCount(edits: ScopedEdits): number {
  return (
    pendingEditCount(edits.all) +
    pendingEditCount(edits["below-sm"]) +
    pendingEditCount(edits["sm-and-up"])
  )
}

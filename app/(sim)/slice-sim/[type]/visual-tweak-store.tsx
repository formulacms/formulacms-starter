"use client"

/**
 * Editor-scoped state for the contextual visual tweak editor (ADR-0030 +
 * 2026-07-06 perf addendum). `createContext` + `useReducer` — the repo's own
 * state pattern (see command-palette / confirm-provider), no external store dep.
 *
 * Why a provider and not local component state: a spacing nudge must NOT touch
 * the renderer source (that write is what triggers the dev recompile + iframe
 * Fast-Refresh — the per-press stall). So nudges only accumulate here, in a
 * **client-side batch**, and the durable write happens once, on explicit Save.
 * The provider wraps the editor region and **stays mounted across deselection**,
 * so the batch survives switching between elements (edit A, edit B, Save both =
 * one compile). Only the inspector + the save bar consume this context, so a
 * nudge re-renders just those small components — the workbench, source panes and
 * AI form (stable children) never re-render. The live preview is driven
 * imperatively (postMessage → inline style on one iframe node), not from here, so
 * it costs zero React render.
 */

import {
  createContext,
  useLayoutEffect,
  useContext,
  useEffect,
  useEffectEvent,
  useReducer,
  useRef,
  useState,
  type ReactNode,
} from "react"
import {
  applySpacingBatchAction,
  undoSpacingBatchAction,
} from "./read-renderer-source"
import { spacingBatchEditId, type SpacingBatchEdit } from "./spacing-batch"
import {
  emptyScopedEdits,
  initialTweakState,
  reducer,
  scopedEditCount,
  type AxisEdit,
  type PendingEdits,
  type PendingEditFailure,
  type ScopedEdits,
  type State,
  type Viewport,
} from "./visual-tweak-reducer"
import type { SlicePreviewView } from "./slice-preview-frame"
import {
  SLICE_APPLIED_EVENT,
  SLICE_LAYER_READY_EVENT,
  SLICE_REAPPLY_EVENT,
  SLICE_REAPPLY_RESULT_EVENT,
} from "./slice-preview"
import type {
  ToolbarSpacingAxis,
  ToolbarStatus,
} from "./slice-tweak-toolbar-types"
import type {
  TypographyPreviewEdits,
  TypographyStep,
  TypographyTokenValues,
} from "@/lib/slices/visual-tweak/typography"
import { SNAPSHOT_STALE_EVENT } from "@/components/admin/slices/slice-sim-events"
import type {
  ClassTweakDiff,
  TweakScope,
} from "@/lib/slices/visual-tweak/class-operations"
import {
  emitScopedSpacingUtility,
  findExpectedSpacingUtility,
} from "@/lib/slices/visual-tweak/spacing-operation"

import {
  SIM_FRAME_CONNECTED,
  historyIntent,
  type SimFrameBridge,
  type SimFrameInput,
} from "./sim-frame-bridge"
import {
  validSampleValue,
  readSampleStorage,
  writeSampleStorage,
  sampleStorageKey,
  type SampleField,
  type SampleValues,
} from "./sim-sample-state"
import { buildSamplePresets, SAMPLE_PRESETS } from "./sim-sample-presets"
import type {
  PreviewInlineFormat,
  PreviewInlineTextState,
} from "@/components/admin/preview-inline-editor"

/** sessionStorage key for a slice's unsaved batch — scoped per slice type so
 *  two sim tabs on different slices don't clobber each other. */
function batchStorageKey(type: string): string {
  return `nextcms:vt-batch:${type}`
}

/** Flatten the keyed batch to the wire shape the reconcile channel forwards into
 *  the iframe (one entry per element+axis edit). */
function flattenEdits(edits: ScopedEdits): {
  loc: string
  axis: string
  valueRem: number
  scope: TweakScope
  sourceHash: string
  remove?: boolean
  expected?: string
}[] {
  const out: {
    loc: string
    axis: string
    valueRem: number
    scope: TweakScope
    sourceHash: string
    remove?: boolean
    expected?: string
  }[] = []
  for (const scope of ["all", "below-sm", "sm-and-up"] as const) {
    for (const axes of Object.values(edits[scope])) {
      for (const [axis, edit] of Object.entries(axes)) {
        if (edit && !edit.disabledReason) {
          out.push({
            loc: edit.target.loc,
            axis,
            valueRem: edit.valueRem,
            scope,
            sourceHash: edit.target.sourceHash,
            ...(edit.remove ? { remove: true, expected: edit.expected } : {}),
          })
        }
      }
    }
  }
  return out
}

/** The approved device defaults: Desktop uses base classes, Tablet sm:, Mobile max-sm:. */
function viewportFor(view: SlicePreviewView): Viewport {
  return view === "mobile"
    ? "below-sm"
    : view === "tablet"
      ? "sm-and-up"
      : "all"
}

/** Read a persisted batch back from sessionStorage, tolerating absent/garbage
 *  values and the pre-Item-8 flat shape (returns an empty scoped batch rather
 *  than throwing or mis-loading). */
function readStoredBatch(type: string): ScopedEdits {
  if (typeof window === "undefined") return emptyScopedEdits()
  try {
    const raw = window.sessionStorage.getItem(batchStorageKey(type))
    if (!raw) return emptyScopedEdits()
    const parsed = JSON.parse(raw)
    // Only accept the current per-viewport shape; a stale flat batch from before
    // Item 8 is dropped rather than loaded into the wrong scope.
    if (
      parsed &&
      typeof parsed === "object" &&
      parsed.all &&
      typeof parsed.all === "object" &&
      parsed["below-sm"] &&
      typeof parsed["below-sm"] === "object" &&
      parsed["sm-and-up"] &&
      typeof parsed["sm-and-up"] === "object"
    ) {
      return {
        all: parsed.all as PendingEdits,
        "below-sm": parsed["below-sm"] as PendingEdits,
        "sm-and-up": parsed["sm-and-up"] as PendingEdits,
      }
    }
    return emptyScopedEdits()
  } catch {
    return emptyScopedEdits()
  }
}

export interface VisualTweakContextValue {
  activeText: ({ field: SampleField } & PreviewInlineTextState) | null
  samples: SampleValues
  preset: string
  setPreset(key: string): void
  resetSamples(): void
  mode: "edit" | "preview"
  setMode(mode: "edit" | "preview"): void
  formatSample(command: PreviewInlineFormat): boolean
  edits: PendingEdits
  /** Session previews only: never written by Save or stored with spacing. */
  typography: TypographyPreviewEdits
  typographyTokens: TypographyTokenValues
  stepTypography: (step: TypographyStep) => void
  saving: boolean
  blockedReason?: string
  status: ToolbarStatus | null
  failures: PendingEditFailure[]
  scope: TweakScope
  setScope: (scope: TweakScope) => void
  savedCheckpoint: { id: string; diffs: ClassTweakDiff[] } | null
  undoSaved: () => void
  pendingRows: Array<{
    id: string
    loc: string
    tag: string
    sourceHash: string
    label: string
    scope: TweakScope
    group: string
    before: string
    after: string
    templateWide: boolean
  }>
  /** Number of unsaved axis edits across all elements. */
  editCount: number
  /** Whether there's a prior batch state to step back to. */
  canUndo: boolean
  /** Whether an undone batch state can be re-applied. */
  canRedo: boolean
  /** Step the batch back one nudge and re-post it to the preview. */
  undo: () => void
  /** Re-apply the last undone nudge and re-post the batch to the preview. */
  redo: () => void
  /** Record (or replace) one axis edit on one element in the batch. */
  setEdit: (path: string, axis: ToolbarSpacingAxis, edit: AxisEdit) => void
  /** Record the same edit on N axes of one element in ONE dispatch, so the
   *  "linked all sides" nudge lands as a single reducer step (one re-render,
   *  one undo unit). */
  setEdits: (
    path: string,
    axes: readonly ToolbarSpacingAxis[],
    edit: AxisEdit
  ) => void
  /** Persist the whole batch in one server write (one recompile). */
  save: () => void
  /** Drop the batch and reload the preview to wipe the inline styles. */
  discard: () => void
  resetTarget: (path: string) => void
  clearStatus: () => void
}

const VisualTweakContext = createContext<VisualTweakContextValue | null>(null)

export function useVisualTweak(): VisualTweakContextValue {
  const ctx = useContext(VisualTweakContext)
  if (!ctx) {
    throw new Error("useVisualTweak must be used inside <VisualTweakProvider>")
  }
  return ctx
}

export function VisualTweakProvider({
  type,
  view,
  presentation = "default",
  locale = "en",
  typographyTokens = {},
  children,
}: {
  type: string
  /** The active preview view chooses the initial explicit breakpoint scope. */
  view: SlicePreviewView
  presentation?: string
  locale?: string
  typographyTokens?: TypographyTokenValues
  children: ReactNode
}) {
  const [state, dispatch] = useReducer(reducer, initialTweakState)
  const stateRef = useRef(state)
  const latestRef = useRef<{
    state: State
    save: () => void | Promise<void>
  }>({ state, save: () => {} })

  const bridgeRef = useRef<SimFrameBridge | null>(null)
  const [fields, setFields] = useState<SampleField[]>([])
  const sampleScope = JSON.stringify([type, presentation, locale])
  const [mode, setModeState] = useState<"edit" | "preview">("edit")
  const [activeText, setActiveText] =
    useState<VisualTweakContextValue["activeText"]>(null)
  const modeRef = useRef(mode)
  const [sessionId] = useState(() => crypto.randomUUID())
  const lastEdit = useRef({ generation: "", editorSessionId: "", revision: 0 })
  function flushSample() {
    return bridgeRef.current?.flush() !== false
  }
  const replaceFrame = useEffectEvent(
    (
      bridge: SimFrameBridge,
      current: Pick<
        State,
        | "samples"
        | "sampleDefaults"
        | "preset"
        | "selection"
        | "reapplyNonce"
        | "resetNonce"
        | "typography"
      >
    ) => {
      const input: SimFrameInput = {
        generation: bridge.generation,
        sessionId,
        revision: ++bridge.incomingRevision,
        values: {
          ...current.sampleDefaults[current.preset],
          ...current.samples[current.preset],
        },
        selection: current.selection,
        replay: current.reapplyNonce,
        reset: current.resetNonce,
        mode: modeRef.current,
        typography: current.typography,
      }
      bridge.lastReplaceRevision = input.revision
      return bridge.replace(input)
    }
  )
  useLayoutEffect(() => {
    stateRef.current = state
    modeRef.current = mode
    latestRef.current = { state, save }
  })
  useEffect(() => {
    function connect(event: Event) {
      const bridge = (event as CustomEvent<SimFrameBridge>).detail
      if (!bridge?.generation || bridge.fields.length > 10) return
      if (
        bridgeRef.current === bridge &&
        bridgeRef.current.generation === bridge.generation
      )
        return
      bridgeRef.current = bridge
      setActiveText(null)
      setFields(bridge.fields)
      lastEdit.current = {
        generation: bridge.generation,
        editorSessionId: "",
        revision: 0,
      }
      bridge.connect(sessionId, {
        selection(input) {
          if (bridgeRef.current !== bridge || !bridge.current()) return
          if (!input) {
            setActiveText(null)
            return
          }
          const field = bridge.fields.find((field) => field.path === input.path)
          if (!field || input.editorSessionId !== bridge.editorSessionId())
            return
          setActiveText({ field, ...input.text })
          dispatch({
            kind: "sampleSelection",
            selection: { path: input.path, from: input.from, to: input.to },
          })
        },
        change(edit) {
          if (
            bridgeRef.current !== bridge ||
            !bridge.current() ||
            edit.generation !== bridge.generation ||
            edit.sessionId !== sessionId ||
            edit.editorSessionId !== bridge.editorSessionId()
          )
            return false
          const field = bridge.fields.find((field) => field.path === edit.path)
          if (
            !field ||
            !validSampleValue(field, edit.value) ||
            !Number.isSafeInteger(edit.revision)
          )
            return false
          if (
            lastEdit.current.editorSessionId === edit.editorSessionId &&
            edit.revision <= lastEdit.current.revision
          )
            return false
          lastEdit.current = edit
          dispatch({
            kind: "sample",
            path: edit.path,
            value: edit.value,
            field,
            selection: edit.selection,
            group: edit.editorSessionId,
          })
          return true
        },
        groupEnd() {
          dispatch({ kind: "closeGroup" })
        },
        history(intent) {
          dispatch({ kind: intent })
        },
        save() {
          void latestRef.current.save()
        },
      })
      dispatch({ kind: "targets", targets: bridge.targets })
      replaceFrame(bridge, stateRef.current)
    }
    window.addEventListener(SIM_FRAME_CONNECTED, connect)
    window.dispatchEvent(new Event(`${SIM_FRAME_CONNECTED}:hello`))
    return () => {
      window.removeEventListener(SIM_FRAME_CONNECTED, connect)
      bridgeRef.current = null
    }
  }, [sessionId])
  useEffect(() => {
    if (bridgeRef.current)
      replaceFrame(bridgeRef.current, {
        samples: state.samples,
        sampleDefaults: state.sampleDefaults,
        preset: state.preset,
        selection: state.selection,
        reapplyNonce: state.reapplyNonce,
        resetNonce: state.resetNonce,
        typography: state.typography,
      })
  }, [
    state.samples,
    state.sampleDefaults,
    state.preset,
    state.selection,
    state.reapplyNonce,
    state.resetNonce,
    state.typography,
    mode,
  ])
  useEffect(() => {
    if (!fields.length) return
    const defaults = buildSamplePresets(type, fields)
    let stored: Record<string, SampleValues> = {}
    try {
      const storage = window.localStorage
      stored = Object.fromEntries(
        SAMPLE_PRESETS.map((preset) => [
          preset.key,
          readSampleStorage(
            storage,
            sampleStorageKey(type, presentation, locale, preset.key),
            fields
          ),
        ])
      )
    } catch {
      /* A blocked storage getter falls back to curated memory. */
    }
    dispatch({ kind: "samplePresets", scope: sampleScope, defaults, stored })
  }, [fields, type, presentation, locale, sampleScope])
  useEffect(() => {
    if (state.sampleStorageScope !== sampleScope || !fields.length) return
    try {
      const storage = window.localStorage
      for (const preset of SAMPLE_PRESETS)
        writeSampleStorage(
          storage,
          sampleStorageKey(type, presentation, locale, preset.key),
          { ...state.sampleDefaults[preset.key], ...state.samples[preset.key] },
          fields
        )
    } catch {
      /* Browser memory is optional; the in-memory editor stays usable. */
    }
  }, [
    state.samples,
    state.sampleDefaults,
    fields,
    type,
    presentation,
    locale,
    sampleScope,
    state.sampleStorageScope,
  ])
  const [selection, setSelection] = useState({ view, scope: viewportFor(view) })
  if (selection.view !== view) {
    setSelection({ view, scope: viewportFor(view) })
  }
  const scope = selection.view === view ? selection.scope : viewportFor(view)
  function setScope(next: TweakScope) {
    setSelection({ view, scope: next })
  }
  const [savedCheckpoint, setSavedCheckpoint] = useState<{
    id: string
    diffs: ClassTweakDiff[]
  } | null>(null)

  // Device changes select their matching scope; manual choices remain until the next device change.
  const scopedEdits = state.edits[scope]
  const editCount = scopedEditCount(state.edits)
  const blockedReason = Object.values(state.edits)
    .flatMap((pending) => Object.values(pending))
    .flatMap((axes) => Object.values(axes))
    .find((edit) => edit?.disabledReason)?.disabledReason
  const canUndo = state.past.length > 0
  const canRedo = state.future.length > 0
  const pendingRows = Object.entries(state.edits).flatMap(
    ([rawScope, pending]) =>
      Object.values(pending).flatMap((axes) =>
        Object.entries(axes).flatMap(([axis, edit]) => {
          if (!edit) return []
          const scope = rawScope as TweakScope
          const spacingAxis = axis as ToolbarSpacingAxis
          const expected = findExpectedSpacingUtility(
            edit.target.sourceClassTokens,
            spacingAxis,
            scope
          )
          const next = emitScopedSpacingUtility(spacingAxis, edit.suffix, scope)
          const beforeTokens = edit.target.sourceClassTokens
          const afterTokens = edit.remove
            ? beforeTokens.filter((token) => token !== edit.expected)
            : expected
              ? beforeTokens.map((token) => (token === expected ? next : token))
              : [...beforeTokens, next]
          return [
            {
              id: JSON.stringify([
                edit.admissionKey ?? edit.target.loc,
                scope,
                axis,
              ]),
              loc: edit.target.loc,
              tag: edit.target.tag,
              sourceHash: edit.target.sourceHash,
              label: edit.target.label,
              scope,
              group: `spacing:${axis}`,
              before: beforeTokens.join(" "),
              after: afterTokens.join(" "),
              templateWide: edit.target.templateWide,
            },
          ]
        })
      )
  )

  // Latest *visible-scope* batch, readable from stable event listeners without
  // re-subscribing on every nudge. Tracks the current scope so a view switch
  // re-applies the right viewport's optimistic
  // styles. Updated in an effect (not during render) per the React 19 rules.
  const editsRef = useRef(state.edits)
  useEffect(() => {
    editsRef.current = state.edits
  }, [state.edits])

  // Rehydrate the batch on mount so a Fast Refresh / page reload that remounts
  // this provider doesn't silently destroy unsaved work (finding 2). Only the
  // admitted reducer state may publish preview edits.
  useEffect(() => {
    const stored = readStoredBatch(type)
    if (scopedEditCount(stored) > 0) {
      dispatch({ kind: "load", edits: stored })
    }
  }, [type])

  // Persist every batch change so the work survives a reload; clear the key when
  // the batch empties (Save / Discard) so a stale batch never resurrects.
  useEffect(() => {
    if (typeof window === "undefined") return
    const key = batchStorageKey(type)
    if (scopedEditCount(state.edits) === 0) {
      window.sessionStorage.removeItem(key)
    } else {
      window.sessionStorage.setItem(key, JSON.stringify(state.edits))
    }
  }, [state.edits, type])

  // When targeting comes (back) online in the iframe — first load, Fast Refresh,
  // or post-Save HMR reload — re-apply the whole batch so the render reflects the
  // pending edits, not just the unsaved count (finding 2 divergence fix).
  useEffect(() => {
    function onLayerReady() {
      const edits = editsRef.current
      if (scopedEditCount(edits) === 0) return
      window.dispatchEvent(
        new CustomEvent(SLICE_REAPPLY_EVENT, {
          detail: { edits: flattenEdits(edits) },
        })
      )
    }
    window.addEventListener(SLICE_LAYER_READY_EVENT, onLayerReady)
    return () =>
      window.removeEventListener(SLICE_LAYER_READY_EVENT, onLayerReady)
  }, [])

  // Admission, source reconciliation and undo/redo re-post the admitted batch
  // through the reload reconcile channel. The nonce does not bump on nudges,
  // so this never fires
  // for a live nudge (the inspector already previews those imperatively). An
  // empty batch posts `edits: []`, which tells the idempotent reconcile handler
  // to clear every optimistic style — i.e. undo back to zero reverts the render.
  // Re-post on nonce/view transitions, not initial mount or live edits. Record
  // the committed pair in the effect so StrictMode replay cannot dispatch twice.
  // Read the batch from `editsRef` — updated by the effect
  // declared above, which commits before this one — so `state.edits` isn't a
  // dependency and only admitted reconciliation changes trigger this effect.
  const lastReapply = useRef({ nonce: state.reapplyNonce, view })
  useEffect(() => {
    if (
      lastReapply.current.nonce === state.reapplyNonce &&
      lastReapply.current.view === view
    )
      return
    lastReapply.current = { nonce: state.reapplyNonce, view }
    window.dispatchEvent(
      new CustomEvent(SLICE_REAPPLY_EVENT, {
        detail: { edits: flattenEdits(editsRef.current) },
      })
    )
  }, [state.reapplyNonce, view])

  // Latest state + save handler, read by the always-mounted keyboard listener
  // without re-subscribing every render. Updated in an effect per React 19 rules.
  // Keyboard shortcuts for the batch (Item 5): Cmd/Ctrl+Z undo, Shift+Cmd/Ctrl+Z
  // (or Cmd/Ctrl+Y) redo, Cmd/Ctrl+S Save. Skipped while an input/textarea/
  // contenteditable belongs to the same simulator history owner.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      if (event.isComposing) return
      const key = event.key.toLowerCase()
      const { save: latestSave } = latestRef.current
      if (key === "z" && !event.shiftKey) {
        if (!flushSample()) return
        event.preventDefault()
        dispatch({ kind: "undo" })
      } else if ((key === "z" && event.shiftKey) || key === "y") {
        if (!flushSample()) return
        event.preventDefault()
        dispatch({ kind: "redo" })
      } else if (key === "s") {
        event.preventDefault()
        void latestSave()
      }
    }
    function beforeInput(event: InputEvent) {
      const intent = historyIntent(event)
      if (!intent || !flushSample()) return
      event.preventDefault()
      dispatch({ kind: intent })
    }
    document.addEventListener("keydown", onKey, true)
    document.addEventListener("beforeinput", beforeInput, true)
    return () => {
      document.removeEventListener("keydown", onKey, true)
      document.removeEventListener("beforeinput", beforeInput, true)
    }
  }, [])

  // Surface a warning if a reload couldn't re-apply part of the batch, rather
  // than letting the count and the render diverge silently (plan item 2).
  useEffect(() => {
    function onResult(event: Event) {
      const missing = (event as CustomEvent).detail?.missing ?? 0
      if (missing > 0) {
        dispatch({
          kind: "status",
          status: {
            kind: "error",
            message:
              `${missing} pending change${missing === 1 ? "" : "s"} couldn't ` +
              `be re-applied to the reloaded preview — Save to persist them, or ` +
              `Discard.`,
          },
        })
      }
    }
    window.addEventListener(SLICE_REAPPLY_RESULT_EVENT, onResult)
    return () =>
      window.removeEventListener(SLICE_REAPPLY_RESULT_EVENT, onResult)
  }, [])

  function stepTypography(step: TypographyStep) {
    if (state.saving || !flushSample()) return
    dispatch({ ...step, kind: "typography" })
  }

  function setEdit(path: string, axis: ToolbarSpacingAxis, edit: AxisEdit) {
    const target = bridgeRef.current?.targets.find(
      (target) => target.loc === edit.target.loc
    )
    dispatch({
      kind: "set",
      scope,
      path,
      axis,
      edit: target
        ? { ...edit, target: { ...edit.target, sourcePath: target.sourcePath } }
        : edit,
    })
  }

  function setEdits(
    path: string,
    axes: readonly ToolbarSpacingAxis[],
    edit: AxisEdit
  ) {
    const target = bridgeRef.current?.targets.find(
      (target) => target.loc === edit.target.loc
    )
    dispatch({
      kind: "setMany",
      scope,
      path,
      axes,
      edit: target
        ? { ...edit, target: { ...edit.target, sourcePath: target.sourcePath } }
        : edit,
    })
  }

  async function save() {
    if (!flushSample() || state.saving || blockedReason) return
    // Materialize the pending reducer state into the one typed operation protocol
    // used by the atomic writer. The reducer already owns last-write-wins; the
    // persistence engine receives at most one value per loc/scope/group.
    const batch: SpacingBatchEdit[] = []
    const submitted = new Map<
      string,
      {
        scope: Viewport
        path: string
        axis: ToolbarSpacingAxis
        suffix: string
        sourceHash: string
        stablePath?: string
      }
    >()
    for (const [rawScope, pending] of Object.entries(state.edits) as [
      Viewport,
      PendingEdits,
    ][]) {
      for (const [path, axes] of Object.entries(pending)) {
        for (const [axis, edit] of Object.entries(axes)) {
          if (edit) {
            const spacingAxis = axis as ToolbarSpacingAxis
            const next = emitScopedSpacingUtility(
              spacingAxis,
              edit.suffix,
              rawScope
            )
            if (edit.disabledReason || (edit.remove && !edit.expected)) {
              dispatch({
                kind: "status",
                status: {
                  kind: "error",
                  message:
                    edit.disabledReason ??
                    "The original spacing token is no longer available.",
                },
              })
              return
            }
            const common = {
              target: edit.target.loc,
              tag: edit.target.tag,
              scope: rawScope,
              group: `spacing:${spacingAxis}` as const,
              sourceHash: edit.target.sourceHash,
            }
            const row: SpacingBatchEdit = edit.remove
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
                    spacingAxis,
                    rawScope
                  ),
                  next,
                  postcondition: { kind: "class-token", value: next },
                }
            batch.push(row)
            submitted.set(spacingBatchEditId(row), {
              scope: rawScope,
              path,
              axis: spacingAxis,
              suffix: edit.suffix,
              sourceHash: edit.target.sourceHash,
              stablePath: edit.target.sourcePath,
            })
          }
        }
      }
    }
    if (batch.length === 0) return
    dispatch({ kind: "saving", value: true })
    dispatch({ kind: "status", status: null })
    try {
      const res = await applySpacingBatchAction({ type, edits: batch })
      if (res.ok) {
        dispatch({
          kind: "reconcileSave",
          sourceHash: res.sourceHash,
          diffs: res.diffs,
          targets: res.targets?.map((target) => ({
            ...target,
            label: target.tag,
            path: target.sourcePath ?? target.loc,
          })),
          rows: res.results.flatMap((result) => {
            const row = submitted.get(result.id)
            return row
              ? [
                  {
                    ...row,
                    status: result.status,
                    ...(result.reason ? { reason: result.reason } : {}),
                  },
                ]
              : []
          }),
        })
        if (res.files.length > 0) {
          window.dispatchEvent(new Event(SNAPSHOT_STALE_EVENT))
        }
        setSavedCheckpoint({ id: res.checkpointId, diffs: res.diffs })
        dispatch({
          kind: "status",
          status: {
            kind: res.skipped ? "error" : "applied",
            message:
              `Saved ${res.applied} change${res.applied === 1 ? "" : "s"}` +
              (res.skipped
                ? `. ${res.skipped} change${res.skipped === 1 ? " is" : "s are"} still pending.`
                : "."),
          },
        })
      } else {
        if (res.results) {
          dispatch({
            kind: "reconcileSave",
            rows: res.results.flatMap((result) => {
              const row = submitted.get(result.id)
              return row
                ? [
                    {
                      ...row,
                      status: "skipped" as const,
                      reason: result.reason,
                    },
                  ]
                : []
            }),
          })
        }
        dispatch({
          kind: "status",
          status: { kind: "error", message: res.error },
        })
      }
    } catch (error) {
      dispatch({
        kind: "status",
        status: {
          kind: "error",
          message: error instanceof Error ? error.message : "Save failed.",
        },
      })
    }
    dispatch({ kind: "saving", value: false })
  }

  function discard() {
    if (!flushSample() || state.saving) return
    dispatch({ kind: "clearEdits" })
    dispatch({ kind: "status", status: null })
    // Reload the preview so the dev-only inline styles are wiped and the render
    // reverts to the committed source.
    window.dispatchEvent(new Event(SLICE_APPLIED_EVENT))
  }

  function clearStatus() {
    dispatch({ kind: "status", status: null })
  }

  function undo() {
    if (!flushSample()) return
    dispatch({ kind: "undo" })
  }

  function redo() {
    if (!flushSample()) return
    dispatch({ kind: "redo" })
  }

  async function undoSaved() {
    if (!savedCheckpoint || state.saving || !flushSample()) return
    dispatch({ kind: "saving", value: true })
    const result = await undoSpacingBatchAction({
      type,
      checkpointId: savedCheckpoint.id,
    })
    if (result.ok) {
      setSavedCheckpoint(null)
      dispatch({
        kind: "sourceRestored",
        targets:
          result.targets?.map((target) => ({
            ...target,
            label: target.tag,
            path: target.sourcePath ?? target.loc,
          })) ?? [],
      })
      window.dispatchEvent(new Event(SNAPSHOT_STALE_EVENT))
      window.dispatchEvent(new Event(SLICE_APPLIED_EVENT))
      dispatch({
        kind: "status",
        status: {
          kind: "applied",
          message:
            "Restored the previous saved source. Edit history was cleared to match it.",
        },
      })
    } else {
      dispatch({
        kind: "status",
        status: { kind: "error", message: result.error },
      })
    }
    dispatch({ kind: "saving", value: false })
  }

  // The keyboard listener reads the latest Save closure. Undo/Redo consume the
  // reducer queue after flush has admitted any pending native sample.

  const value: VisualTweakContextValue = {
    activeText,
    samples: state.samples[state.preset] ?? {},
    preset: state.preset,
    setPreset(key) {
      if (flushSample() && ["default", "stress", "french"].includes(key))
        dispatch({ kind: "preset", key })
    },
    resetSamples() {
      if (flushSample()) dispatch({ kind: "resetSamples" })
    },
    mode,
    setMode(next) {
      if (flushSample()) setModeState(next)
    },
    formatSample(command) {
      return bridgeRef.current?.format(command) ?? false
    },
    // Expose only the current viewport's slice — consumers key by path→axis and
    // stay scope-agnostic (Item 8). `editCount` below still totals every scope.
    resetTarget: (path) => dispatch({ kind: "resetTarget", path, scope }),
    edits: scopedEdits,
    typography: state.typography,
    typographyTokens,
    stepTypography,
    saving: state.saving,
    blockedReason,
    status: blockedReason
      ? { kind: "error", message: blockedReason }
      : state.status,
    failures: Object.values(state.failures),
    scope,
    setScope,
    savedCheckpoint,
    undoSaved,
    pendingRows,
    editCount,
    canUndo,
    canRedo,
    undo,
    redo,
    setEdit,
    setEdits,
    save,
    discard,
    clearStatus,
  }

  return (
    <VisualTweakContext.Provider value={value}>
      {children}
    </VisualTweakContext.Provider>
  )
}

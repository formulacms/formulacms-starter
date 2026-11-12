import { validate } from "convex-helpers/validators"
import { sliceValidator, type Slice } from "@/convex/lib/slices"
import { hasValidSliceOccurrencePresentation } from "@/convex/lib/slices/occurrencePresentation"
import { validateSlicesRichText } from "@/convex/lib/slices/validate"
import {
  applyPageField,
  pageFieldEcho,
  reconcilePageFieldEcho,
  rebasePageField,
} from "./page-editor/lib/page-inline-draft"
import {
  isPreviewFieldSelection,
  isPreviewInlineActivationResult,
} from "./visual-editing-types"
import {
  supportsLivePreviewFrame,
  type LivePreviewPageType,
} from "./live-preview-page-type"
import type {
  PreviewActiveEditHandle,
  PreviewFieldSelection,
  PreviewInlineActivationResult,
  PreviewInlineEditCommit,
} from "./visual-editing-types"

export type LiveFrameIdentity = {
  sessionId: string
  pageId: string
  locale: string
}
export type LiveFrameInput = LiveFrameIdentity & {
  pageType: LivePreviewPageType
  defaultLocale: string
  languageVersion: number
  buildId: string
  catalogRevision?: string
  title: string
  slices: Slice[]
  contentEpoch?: number
  /** Parent-qualified own-edit receipt, scoped to one inline activation. */
  inlineEditEcho?: PreviewInlineEditCommit
  /** Stamped by the parent snapshot owner; generation is bound before delivery. */
  ordering?: {
    draftRevision: number
    inputRevision: number
    generation: string
  }
  selectedSliceId: string | null
  inlineEditingEnabled: boolean
  mode: "light" | "dark"
}
export type LiveFrameCallbacks = {
  selectSlice(id: string): void
  /** Authenticated exact occurrence fallback: focus its first form control. */
  selectSliceFallback?(id: string): void
  selectField(
    target: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ): void
  commit(value: PreviewInlineEditCommit): boolean | void
  change(value: PreviewInlineEditCommit | null): void
  conflict(): void
  save(): void
  unavailable(): void
  context(ready: boolean): void
  /** Read only after the parent has accepted a commit. */
  draftRevision?(): number
}
export type LiveFrameBridge = PreviewActiveEditHandle &
  LiveFrameIdentity & {
    buildId: string
    disconnect(): void
    generation: string
    connect(input: LiveFrameInput, callbacks: LiveFrameCallbacks): boolean
    replaceInput(input: LiveFrameInput): boolean
    acknowledgeDraftRevision?(revision: number): void
  }
export type LiveFrameWindow = Window & {
  __formulacmsLiveFrame?: LiveFrameBridge
}
export const LIVE_FRAME_SOURCE = "formulacms-page-frame"

export function validLiveFrameInput(value: unknown): value is LiveFrameInput {
  if (!value || typeof value !== "object") return false
  const input = value as Partial<LiveFrameInput>
  if (
    !supportsLivePreviewFrame(input.pageType) ||
    typeof input.sessionId !== "string" ||
    !input.sessionId ||
    typeof input.pageId !== "string" ||
    !input.pageId ||
    typeof input.locale !== "string" ||
    !input.locale ||
    typeof input.defaultLocale !== "string" ||
    !input.defaultLocale ||
    !Number.isSafeInteger(input.languageVersion) ||
    (input.ordering !== undefined &&
      (!input.ordering ||
        typeof input.ordering !== "object" ||
        !Number.isSafeInteger(input.ordering.draftRevision) ||
        input.ordering.draftRevision < 0 ||
        !Number.isSafeInteger(input.ordering.inputRevision) ||
        input.ordering.inputRevision < 0 ||
        typeof input.ordering.generation !== "string")) ||
    (input.contentEpoch !== undefined &&
      (!Number.isSafeInteger(input.contentEpoch) || input.contentEpoch < 0)) ||
    typeof input.buildId !== "string" ||
    !input.buildId ||
    typeof input.title !== "string" ||
    typeof input.inlineEditingEnabled !== "boolean" ||
    (input.mode !== "light" && input.mode !== "dark") ||
    (input.selectedSliceId !== null &&
      typeof input.selectedSliceId !== "string") ||
    !Array.isArray(input.slices) ||
    !input.slices.every(
      (slice) =>
        validate(sliceValidator, slice) &&
        hasValidSliceOccurrencePresentation(slice)
    )
  )
    return false
  try {
    validateSlicesRichText(input.slices, "legacy")
  } catch {
    return false
  }
  return true
}

export function sameLiveFrameIdentity(
  a: LiveFrameIdentity,
  b: LiveFrameIdentity
) {
  return (
    a.sessionId === b.sessionId &&
    a.pageId === b.pageId &&
    a.locale === b.locale
  )
}
export function liveFrameMessageMatches(
  event: Pick<MessageEvent, "origin" | "source" | "data">,
  origin: string,
  frameWindow: Window | null,
  identity: LiveFrameIdentity
): event is MessageEvent & {
  data: LiveFrameIdentity & {
    source: string
    type: "ready" | "retired" | "unloading"
    generation: string
    buildId: string
  }
} {
  const data = event.data
  return (
    event.origin === origin &&
    frameWindow !== null &&
    data !== null &&
    typeof data === "object" &&
    (event.source === frameWindow ||
      (data.type === "unloading" && event.source === null)) &&
    data.source === LIVE_FRAME_SOURCE &&
    (data.type === "ready" ||
      data.type === "retired" ||
      data.type === "unloading") &&
    typeof data.buildId === "string" &&
    typeof data.generation === "string" &&
    data.generation.length > 0 &&
    sameLiveFrameIdentity(data, identity)
  )
}

/** The frame owns transient DOM only. Every accepted value enters the parent draft. */
export function createLiveFrameController(
  initial: LiveFrameInput,
  callbacks: LiveFrameCallbacks = {
    selectSlice() {},
    selectField() {},
    commit() {},
    change() {},
    conflict() {},
    save() {},
    unavailable() {},
    context() {},
  },
  initialBridgeCheck?: (bridge: LiveFrameBridge) => boolean
) {
  let input = initial
  let bridge: LiveFrameBridge | null = null
  let active: PreviewInlineEditCommit | null = null
  let composing = false
  let echoesInvalidated = false
  let isCurrentBridge = initialBridgeCheck
  let draftRevision = initial.ordering?.draftRevision ?? 0
  let inputRevision = -1
  function clearBridge() {
    const old = bridge
    bridge = null
    active = null
    composing = false
    echoesInvalidated = false
    return old
  }
  function forget() {
    clearBridge()
    callbacks.change(null)
  }
  function retire() {
    const old = clearBridge()
    if (old) {
      let canDisconnect = !isCurrentBridge
      try {
        canDisconnect = canDisconnect || isCurrentBridge?.(old) === true
      } catch {
        canDisconnect = false
      }
      if (canDisconnect) {
        try {
          old.disconnect()
        } catch {
          // A frame that navigated or became inaccessible is already retired.
        }
      }
    }
    callbacks.change(null)
  }
  const handle: PreviewActiveEditHandle = {
    flush: () => bridge?.flush?.(),
    discardActiveEdit: () => {
      bridge?.discardActiveEdit?.()
      active = null
      composing = false
      echoesInvalidated = false
      callbacks.change(null)
    },
    capture: () => active,
    acceptCapture() {},
    isComposing: () => composing || (bridge?.isComposing() ?? false),
    hasActiveSession: () => active !== null,
  }
  const validBinding = (
    commit: PreviewInlineEditCommit,
    selected: LiveFrameBridge
  ) => {
    const identity = commit.frameBinding
    return (
      !!identity &&
      identity.sessionId === input.sessionId &&
      identity.pageId === input.pageId &&
      identity.generation === selected.generation &&
      identity.buildId === input.buildId &&
      identity.languageVersion === input.languageVersion &&
      commit.locale === input.locale
    )
  }
  return {
    handle,
    setCurrentBridgeCheck(check: (bridge: LiveFrameBridge) => boolean) {
      isCurrentBridge = check
    },
    forget,
    retire,
    resolveRecovery() {},
    replaceCallbacks(next: LiveFrameCallbacks) {
      callbacks = next
    },
    generation: () => bridge?.generation,
    replaceInput(next: LiveFrameInput) {
      if (
        !validLiveFrameInput(next) ||
        !sameLiveFrameIdentity(input, next) ||
        next.buildId !== input.buildId ||
        next.languageVersion !== input.languageVersion
      )
        return false
      if (
        input.ordering &&
        (!next.ordering ||
          next.ordering.draftRevision < draftRevision ||
          next.ordering.inputRevision <= inputRevision ||
          (next.ordering.generation !== "" &&
            next.ordering.generation !== bridge?.generation))
      )
        return false
      // A parent React render may acknowledge an older accepted character.
      // Only exact parent helper outputs carry provenance; old matching text
      // from an external update must continue to fail the ordinary field guard.
      const echo = pageFieldEcho(next.slices)
      const ownSlices =
        active &&
        !echoesInvalidated &&
        bridge &&
        echo &&
        (!next.ordering || echo.value === active.fieldBinding?.lastApplied) &&
        validBinding(echo, bridge)
          ? reconcilePageFieldEcho(
              next.slices,
              next.locale,
              // active.value can be rejected recovery text; only lastApplied
              // is a parent-accepted canonical value.
              {
                ...active,
                value: active.fieldBinding?.lastApplied ?? active.value,
              },
              echo,
              next.contentEpoch ?? 0,
              next.catalogRevision ?? ""
            )
          : null
      if (
        active &&
        !ownSlices &&
        !applyPageField(
          next.slices,
          next.locale,
          rebasePageField(
            next.slices,
            next.locale,
            active,
            next.contentEpoch ?? 0,
            next.catalogRevision ?? ""
          ),
          next.contentEpoch ?? 0,
          next.catalogRevision ?? ""
        )
      )
        echoesInvalidated = true
      input = {
        ...next,
        ...(next.ordering && bridge
          ? { ordering: { ...next.ordering, generation: bridge.generation } }
          : {}),
        ...(ownSlices ? { slices: ownSlices } : {}),
        // Derive receipts locally; never trust a caller-supplied receipt.
        inlineEditEcho: ownSlices ? pageFieldEcho(ownSlices) : undefined,
      }
      if (next.ordering) {
        draftRevision = next.ordering.draftRevision
        inputRevision = next.ordering.inputRevision
      }
      if (active)
        active = rebasePageField(
          input.slices,
          next.locale,
          active,
          next.contentEpoch ?? 0,
          next.catalogRevision ?? ""
        )
      return bridge?.replaceInput(input) ?? false
    },
    connect(next: LiveFrameBridge) {
      if (
        !sameLiveFrameIdentity(input, next) ||
        next.buildId !== input.buildId ||
        !next.generation ||
        ![next.connect, next.replaceInput, next.disconnect].every(
          (method) => typeof method === "function"
        )
      )
        return false
      if (bridge && bridge !== next) retire()
      bridge = next
      if (input.ordering)
        input = {
          ...input,
          ordering: { ...input.ordering, generation: next.generation },
        }
      const current = () => bridge === next
      const connected = next.connect(input, {
        selectSlice(id) {
          if (current()) callbacks.selectSlice(id)
        },
        selectSliceFallback(id) {
          if (!current()) return
          if (callbacks.selectSliceFallback) callbacks.selectSliceFallback(id)
          else callbacks.selectSlice(id)
        },
        selectField(target, result) {
          if (
            current() &&
            isPreviewFieldSelection(target) &&
            (result === undefined || isPreviewInlineActivationResult(result)) &&
            (result?.status !== "activated" || target.inlineEditing === true)
          )
            callbacks.selectField(target, result)
        },
        commit(commit) {
          if (!current() || !active || !validBinding(commit, next)) return false
          if (
            input.ordering &&
            (!callbacks.draftRevision || !next.acknowledgeDraftRevision)
          )
            return false
          if (echoesInvalidated) {
            callbacks.change(commit)
            callbacks.conflict()
            return false
          }
          const rebased = rebasePageField(
            input.slices,
            input.locale,
            commit,
            input.contentEpoch ?? 0,
            input.catalogRevision ?? ""
          )
          if (
            active.sliceId !== commit.sliceId ||
            active.fieldPath !== commit.fieldPath ||
            active.kind !== commit.kind ||
            active.fieldBinding?.lastApplied !==
              commit.fieldBinding?.lastApplied
          )
            return false
          const slices = applyPageField(
            input.slices,
            input.locale,
            rebased,
            input.contentEpoch ?? 0,
            input.catalogRevision ?? ""
          )
          if (!slices || callbacks.commit(rebased) === false) {
            echoesInvalidated = true
            callbacks.change(commit)
            callbacks.conflict()
            return false
          }
          input = { ...input, slices }
          if (input.ordering) {
            const acceptedRevision = callbacks.draftRevision?.()
            if (
              acceptedRevision !== undefined &&
              Number.isSafeInteger(acceptedRevision) &&
              acceptedRevision > draftRevision
            ) {
              draftRevision = acceptedRevision
              input = {
                ...input,
                ordering: { ...input.ordering, draftRevision },
              }
              next.acknowledgeDraftRevision?.(draftRevision)
            }
          }
          active = {
            ...rebased,
            fieldBinding: {
              ...rebased.fieldBinding!,
              lastApplied: commit.value,
            },
          }
          return true
        },
        change(commit) {
          if (!current()) return
          if (commit && !validBinding(commit, next)) return
          if (
            commit &&
            !active &&
            !applyPageField(
              input.slices,
              input.locale,
              commit,
              input.contentEpoch ?? 0,
              input.catalogRevision ?? ""
            )
          ) {
            callbacks.change(commit)
            callbacks.conflict()
            return
          }
          active = commit
          if (!commit) echoesInvalidated = false
          composing = commit?.composing ?? false
          callbacks.change(commit)
        },
        conflict() {
          if (current()) {
            echoesInvalidated = true
            callbacks.conflict()
          }
        },
        save() {
          if (current()) callbacks.save()
        },
        unavailable() {
          if (current()) {
            callbacks.unavailable()
            retire()
          }
        },
        context(ready) {
          if (current()) callbacks.context(ready)
        },
      })
      if (!connected) bridge = null
      return connected
    },
  }
}

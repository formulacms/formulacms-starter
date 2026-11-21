import type { RemovedRichTextLink } from "@/convex/lib/richtext/shape"
import type { RepeatedItemTarget } from "./page-editor/lib/repeated-item-identity"

export type SliceFieldFocusTarget = {
  sliceId: string
  fieldPath: string
  nonce: number
  /** Plain-text offset of the preview click; places the rich-text caret. */
  textOffset?: number
  /** 2 selects the clicked word, 3 the clicked paragraph; absent is one click. */
  clickCount?: 2 | 3
}

export type PreviewFieldSelection = {
  sliceId: string
  fieldPath: string
  /** True only after the preview has actually opened an inline session. */
  inlineEditing?: boolean
  /** Plain-text offset of the click in a form-only rich-text field. */
  textOffset?: number
  /** 2 selects the clicked word, 3 the clicked paragraph; absent is one click. */
  clickCount?: 2 | 3
}

export type PreviewInlineRefusalReason =
  "unsupported" | "begin" | "capture" | "stale"

export type PreviewInlineActivationResult =
  | { status: "activated" }
  | { status: "refused"; reason: PreviewInlineRefusalReason }

export function isPreviewInlineActivationResult(
  value: unknown
): value is PreviewInlineActivationResult {
  if (!value || typeof value !== "object") return false
  const result = value as Record<string, unknown>
  return (
    (result.status === "activated" && Object.keys(result).length === 1) ||
    (result.status === "refused" &&
      Object.keys(result).length === 2 &&
      (result.reason === "unsupported" ||
        result.reason === "begin" ||
        result.reason === "capture" ||
        result.reason === "stale"))
  )
}

export function isPreviewFieldSelection(
  value: unknown
): value is PreviewFieldSelection {
  if (!value || typeof value !== "object") return false
  const target = value as Record<string, unknown>
  return (
    typeof target.sliceId === "string" &&
    target.sliceId.length > 0 &&
    typeof target.fieldPath === "string" &&
    target.fieldPath.length > 0 &&
    (target.inlineEditing === undefined ||
      typeof target.inlineEditing === "boolean") &&
    (target.textOffset === undefined ||
      (Number.isInteger(target.textOffset) &&
        (target.textOffset as number) >= 0)) &&
    (target.clickCount === undefined ||
      target.clickCount === 2 ||
      target.clickCount === 3) &&
    Object.keys(target).every((key) =>
      [
        "sliceId",
        "fieldPath",
        "inlineEditing",
        "textOffset",
        "clickCount",
      ].includes(key)
    )
  )
}

export type PreviewRendererSource = {
  rendererSource: string
  presentationId: string
  sourceHash: string
}

export type SliceOccurrenceBaseline = {
  rendererSource?: PreviewRendererSource
  /** Once observed stale, exact byte reverts cannot revive this buffer. */
  sourceInvalidated?: boolean
  locale: string
  sliceId: string
  sliceType: string
  expectedSlice: string
  repeatedTarget?: RepeatedItemTarget
}

export type PreviewInlineEditCommit = SliceOccurrenceBaseline & {
  /** Transient activation identity; never persisted with Page content. */
  inlineSessionId?: string
  /** Page content binding. Whole-occurrence bindings remain for source tools. */
  fieldBinding?: {
    contentEpoch: number
    presentation: string
    catalogRevision: string
    descriptor: string
    lastApplied: string
    itemFingerprint?: string
  }
  frameBinding?: {
    sessionId: string
    pageId: string
    generation: string
    buildId: string
    languageVersion: number
  }
  composing?: boolean
  fieldPath: string
  kind: "text" | "richText"
  value: string
  /** Transient title-adoption diagnostics, located by this commit binding. */
  removedLinks?: RemovedRichTextLink[]
}

/** Synchronous active-buffer capture for Page Save/Publish. */
export type PreviewActiveEditHandle = {
  flush?(): void
  /** Explicitly discard transient editing DOM, preserving the parent draft. */
  discardActiveEdit?(): void
  capture(): PreviewInlineEditCommit | null
  isSourceCurrent?(commit: PreviewInlineEditCommit): Promise<boolean>
  matchesRenderedSource?(commit: PreviewInlineEditCommit): boolean
  acceptCapture(commit: PreviewInlineEditCommit): void
  isComposing(): boolean
  hasActiveSession(): boolean
}

export type SliceFirstControlFocusTarget = {
  sliceId: string
  nonce: number
}

/**
 * The block a click on a preview field selected. The form shows that block's
 * row as selected without scrolling to it, so the preview stays under the
 * pointer for the rest of the click sequence. A new nonce per click.
 */
export type SlicePreviewClickSelection = {
  sliceId: string
  nonce: number
}

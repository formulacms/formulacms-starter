"use client"

import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import {
  mergeRemovedLinks,
  type RemovedRichTextLink,
} from "@/convex/lib/richtext/shape"

import {
  resolvePageOutline,
  pageHeadingModeFor,
} from "@/lib/slices/page-outline"

import {
  adminFieldMetadata,
  adminSliceMetadata,
  type AdminMetadataTranslator,
} from "@/lib/i18n/admin-metadata"

import {
  cloneElement,
  isValidElement,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { flushSync } from "react-dom"
import dynamic from "next/dynamic"
import { useTranslations } from "next-intl"
import {
  type ImageField,
  type Primitive,
  type Slice,
} from "@/convex/lib/slices"
import { withUniqueSliceRenderIds } from "@/convex/lib/slices/identity"
import {
  resolveFieldContract,
  type FieldContract,
  type ResolvedFieldContract,
} from "@/convex/lib/richtext/contracts"
import { SliceZone } from "@/components/slices/slice-zone"
import type { SliceRenderContext } from "@/lib/slices/links"
import { parseFieldPath } from "./page-editor/lib/field-path"
import { cn } from "@/lib/utils"
import type {
  PreviewActiveEditHandle,
  PreviewFieldSelection,
  PreviewInlineActivationResult,
  PreviewInlineEditCommit,
} from "./visual-editing-types"
import {
  capturePageField,
  applyPageField,
  rebasePageField,
  reconcilePageFieldEcho,
  isPrimaryListPath,
} from "./page-editor/lib/page-inline-draft"
import type { PreviewInlineSession } from "./preview-inline-session"

const PreviewInlineEditor = dynamic(
  () =>
    import("./preview-inline-editor").then(
      (module) => module.PreviewInlineEditor
    ),
  { ssr: false }
)

type PreviewFieldTarget = {
  fieldPath: string
  label: string
  kind: "text" | "richText" | "image"
  text?: string
  url?: string
  alt?: string
  /** Source PM-JSON value for richText targets — used as the editor's seed
   *  so existing marks survive inline editing. */
  value?: string
  /** The installed descriptor profile; direct editing must never widen it. */
  profile?: FieldContract
  resolvedContract?: ResolvedFieldContract
}

type PreviewFieldMatch = {
  target: PreviewFieldTarget
  element: HTMLElement
  point?: { left: number; top: number }
}

function inlineActivationDiagnostic(
  message: string,
  details: Record<string, unknown> = {}
) {
  if (process.env.NODE_ENV === "development")
    console.info(
      `[Page inline activation] ${message} ${JSON.stringify(details)}`
    )
}

function diagnosticElement(target: EventTarget | null) {
  if (!(target instanceof Element))
    return { nodeType: target instanceof Node ? target.nodeType : null }
  return {
    tag: target.tagName,
    field: target.getAttribute("data-preview-field"),
    profile: target.getAttribute("data-preview-inline-contract"),
    inlineEditor: target.hasAttribute("data-preview-inline-editor"),
  }
}

function normalizeText(value: string | null | undefined) {
  return (value ?? "").replace(/\s+/g, " ").trim()
}

function compactText(value: string) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
}

function containsText(haystack: string, needle: string) {
  return haystack.indexOf(needle) !== -1
}

function richTextPlainText(value: string) {
  if (!value.trim()) return ""
  try {
    const parsed = JSON.parse(value) as unknown
    const parts: string[] = []
    function walk(node: unknown) {
      if (!node || typeof node !== "object") return
      const record = node as { text?: unknown; content?: unknown }
      if (typeof record.text === "string") parts.push(record.text)
      if (Array.isArray(record.content)) record.content.forEach(walk)
    }
    walk(parsed)
    return normalizeText(parts.join(" "))
  } catch {
    return normalizeText(value.replace(/<[^>]+>/g, " "))
  }
}

function collectPreviewTargets(
  def: Primitive,
  value: unknown,
  fieldPath: string,
  label: string,
  targets: PreviewFieldTarget[],
  tMetadata: AdminMetadataTranslator
) {
  switch (def.kind) {
    case "text": {
      const text = typeof value === "string" ? normalizeText(value) : ""
      if (text) {
        targets.push({
          fieldPath,
          label,
          kind: "text",
          text,
        })
      }
      return
    }
    case "richText": {
      const raw = typeof value === "string" ? value : ""
      const text = richTextPlainText(raw)
      if (text) {
        const resolvedContract = resolveFieldContract(def.config)
        const profile = resolvedContract.contract
        // All profiles remain form-selectable; direct canvas editing is
        // qualified only for explicitly instrumented supported renderers.
        targets.push({
          fieldPath,
          label,
          kind: "richText",
          text,
          value: raw,
          profile,
          resolvedContract,
        })
      }
      return
    }
    case "image": {
      const image = value as ImageField | undefined
      if (image?.url) {
        targets.push({
          fieldPath,
          label,
          kind: "image",
          url: image.url,
          alt: image.alt,
        })
      }
      return
    }
    case "group": {
      const fields = def.config.fields as Record<string, Primitive>
      const obj =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      for (const [key, child] of Object.entries(fields)) {
        collectPreviewTargets(
          child,
          obj[key],
          `${fieldPath}.${key}`,
          adminFieldMetadata(child, key, tMetadata).label,
          targets,
          tMetadata
        )
      }
      return
    }
    case "list": {
      const itemDef = def.config.item as Primitive
      const items = Array.isArray(value) ? value : []
      items.forEach((item, index) => {
        collectPreviewTargets(
          itemDef,
          item,
          `${fieldPath}.${index}`,
          `${label} ${index + 1}`,
          targets,
          tMetadata
        )
      })
      return
    }
  }
}

function previewTargetsForSlice(
  slice: Slice,
  labels: { primary: string; items: string },
  tMetadata: AdminMetadataTranslator
): PreviewFieldTarget[] {
  const def = readSliceDefinition(readSlice(slice).type)
  if (!def) return []
  const targets: PreviewFieldTarget[] = []
  collectPreviewTargets(
    def.primary,
    readSlice(slice).primary,
    "primary",
    labels.primary,
    targets,
    tMetadata
  )
  if (def.items !== undefined && "items" in slice) {
    collectPreviewTargets(
      def.items,
      (slice as { items?: unknown[] }).items,
      "items",
      labels.items,
      targets,
      tMetadata
    )
  }
  return targets
}

function bestTextTarget(text: string, targets: PreviewFieldTarget[]) {
  const clicked = normalizeText(text).toLowerCase()
  if (clicked.length < 2 || clicked.length > 500) return null
  const compactClicked = compactText(clicked)
  const matches: PreviewFieldTarget[] = []
  for (const target of targets) {
    if (!target.text) continue
    const candidate = normalizeText(target.text).toLowerCase()
    const compactCandidate = compactText(candidate)
    if (candidate.length < 2) continue
    const exact = candidate === clicked
    const compactContains =
      compactCandidate.length >= 2 &&
      compactClicked.length >= 2 &&
      (containsText(compactCandidate, compactClicked) ||
        containsText(compactClicked, compactCandidate))
    const contains =
      exact ||
      containsText(candidate, clicked) ||
      containsText(clicked, candidate) ||
      compactContains
    if (!contains) continue
    matches.push(target)
  }
  return matches.length === 1 ? matches[0] : null
}

function bestImageTarget(element: HTMLElement, targets: PreviewFieldTarget[]) {
  const image = element.closest("img")
  if (!image) return null
  const src = image.getAttribute("src") ?? ""
  const alt = image.getAttribute("alt") ?? ""
  const matches = targets.filter(
    (target) =>
      target.kind === "image" &&
      ((target.url &&
        (containsText(src, target.url) || containsText(target.url, src))) ||
        (!!target.alt && target.alt === alt))
  )
  return matches.length === 1 ? matches[0] : null
}

function imageMatchFromClick(
  element: HTMLElement,
  targets: PreviewFieldTarget[]
): PreviewFieldMatch | null {
  const image = element.closest("img")
  if (!image) return null
  const target = bestImageTarget(element, targets)
  return target ? { target, element: image } : null
}

function fieldMatchFromClick(
  root: HTMLElement,
  target: EventTarget,
  targets: PreviewFieldTarget[]
): PreviewFieldMatch | null {
  if (!(target instanceof HTMLElement)) return null
  const explicit = target.closest<HTMLElement>("[data-preview-field]")
  if (explicit && root.contains(explicit)) {
    const field = targets.find(
      (entry) => entry.fieldPath === explicit.dataset.previewField
    )
    return field ? { target: field, element: explicit } : null
  }
  // Migrated kit renderers resolve fields only by descriptor-bound markers.
  // An empty gap or unmarked wrapper inside one must not fall back to text.
  if (root.querySelector("[data-preview-field-kit='true']")) return null
  const imageMatch = imageMatchFromClick(target, targets)
  if (imageMatch) return imageMatch

  const interactive = target.closest("a, button, [role='button']")
  if (interactive && root.contains(interactive)) {
    const match = bestTextTarget(interactive.textContent ?? "", targets)
    // An unbound control must not fall through to a neighbouring heading field.
    return match ? { target: match, element: interactive as HTMLElement } : null
  }

  let cursor: HTMLElement | null = target
  while (cursor && cursor !== root) {
    const match = bestTextTarget(cursor.textContent ?? "", targets)
    if (match) {
      // The whole heading extends its inline span's click target. Other fuzzy
      // ancestor matches keep their existing form-only selection behaviour.
      if (!/^H[1-6]$/.test(cursor.tagName))
        return { target: match, element: cursor }
      const descendants = [
        ...cursor.querySelectorAll<HTMLElement>("[data-preview-field]"),
      ]
      if (descendants.length > 1) return null
      const field = descendants[0]
      return {
        target: match,
        element:
          field?.tagName === "SPAN" &&
          field.dataset.previewField === match.fieldPath
            ? field
            : cursor,
      }
    }
    cursor = cursor.parentElement
  }
  return null
}

function AdminSlicePreviewZone({
  title,
  slices,
  ctx,
  selectedSliceId,
  onSelectSlice,
  onSelectSliceFallback,
  onSelectField,
  inlineEditingEnabled,
  onBeginInlineEdit,
  registerSliceNode,
  activeSession,
  initialPoint,
  onDraftChange,
  onCommit,
  onCancel,
  onCompositionChange,
  onFlushHandleChange,
  renderPage,
}: {
  title: string
  slices: Slice[]
  ctx: SliceRenderContext
  selectedSliceId: string | null
  onSelectSlice: (sliceId: string) => void
  onSelectSliceFallback?: (sliceId: string) => void
  onSelectField: (
    target: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ) => void
  inlineEditingEnabled: boolean
  onBeginInlineEdit: (
    sliceId: string,
    match: PreviewFieldMatch
  ) => PreviewInlineActivationResult
  registerSliceNode: (sliceId: string, node: HTMLDivElement | null) => void
  activeSession: PreviewInlineSession | null
  initialPoint?: { left: number; top: number }
  onDraftChange: (value: string, removedLinks?: RemovedRichTextLink[]) => void
  onCommit: () => void
  onCancel: () => void
  onCompositionChange: (composing: boolean) => void
  onFlushHandleChange: (flush: (() => void) | null) => void
  renderPage?: (slices: Slice[], context: SliceRenderContext) => ReactNode
}) {
  const t = useTranslations("editor.livePreview")
  const tMetadata = useTranslations("metadata")
  const visible = slices.filter((slice) => readSlice(slice).enabled !== false)

  const interceptedContext: SliceRenderContext = {
    ...ctx,
    previewSlice: (slice, render) => {
      const index = visible.findIndex(
        (entry) => readSlice(entry).id === readSlice(slice).id
      )
      const label =
        adminSliceMetadata(readSlice(slice).type, tMetadata)?.label ??
        readSlice(slice).type
      const selected = selectedSliceId === readSlice(slice).id
      const fieldTargets = previewTargetsForSlice(
        slice,
        {
          primary: t("primary"),
          items: t("items"),
        },
        tMetadata
      )

      function selectSlice() {
        onSelectSlice(readSlice(slice).id)
      }

      function focusSliceFormFallback(clickCount: number) {
        if (clickCount > 1) return
        if (onSelectSliceFallback) onSelectSliceFallback(readSlice(slice).id)
        else selectSlice()
      }

      function selectField(
        fieldPath: string,
        result?: PreviewInlineActivationResult
      ) {
        const target = {
          sliceId: readSlice(slice).id,
          fieldPath,
          ...(result?.status === "activated" ? { inlineEditing: true } : {}),
        }
        if (result) onSelectField(target, result)
        else onSelectField(target)
      }

      function beginInlineIfSupported(
        match: PreviewFieldMatch,
        event: { detail: number; clientX: number; clientY: number }
      ) {
        if (!inlineEditingEnabled) {
          if (match.target.kind === "text" || match.target.kind === "image") {
            selectField(match.target.fieldPath, {
              status: "refused",
              reason: "unsupported",
            })
          } else {
            selectField(match.target.fieldPath)
          }
          return false
        }
        const supported =
          match.target.kind === "richText" &&
          ["inline", "title", "basic"].includes(match.target.profile ?? "") &&
          (match.element.dataset.previewInlineContract ===
            match.target.profile ||
            (match.target.profile === "title" &&
              match.element.dataset.previewInlineContract === "inline")) &&
          match.element.dataset.previewField === match.target.fieldPath
        if (process.env.NODE_ENV === "development") {
          const reasons = [
            match.target.kind !== "richText" &&
              "matched field is not rich text",
            match.target.profile !== "inline" &&
              match.target.profile !== "title" &&
              match.target.profile !== "basic" &&
              "field profile is not inline",
            !["inline", "title", "basic"].includes(
              match.element.dataset.previewInlineContract ?? ""
            ) && "matched element has no inline profile",
            match.element.dataset.previewField !== match.target.fieldPath &&
              "matched element does not identify the matched field",
          ].filter(Boolean)
          inlineActivationDiagnostic(
            supported ? "Supported field can begin" : "Supported field refused",
            {
              sliceId: readSlice(slice).id,
              fieldPath: match.target.fieldPath,
              reasons,
            }
          )
        }
        if (!supported) {
          selectField(match.target.fieldPath, {
            status: "refused",
            reason: "unsupported",
          })
          return false
        }
        const result = onBeginInlineEdit(readSlice(slice).id, {
          ...match,
          point:
            event.detail > 0
              ? { left: event.clientX, top: event.clientY }
              : undefined,
        })
        selectField(match.target.fieldPath, result)
        return result.status === "activated"
      }

      return (
        <div
          key={readSlice(slice).id}
          data-preview-slice-occurrence
          ref={(node) => registerSliceNode(readSlice(slice).id, node)}
          onClickCapture={(event) => {
            if (process.env.NODE_ENV === "development")
              inlineActivationDiagnostic("Click reached the slice", {
                sliceId: readSlice(slice).id,
                target: diagnosticElement(event.target),
                clientX: event.clientX,
                clientY: event.clientY,
                trusted: event.isTrusted,
              })
            if (
              event.target instanceof Element &&
              event.target.closest("[data-preview-inline-editor]")
            ) {
              inlineActivationDiagnostic(
                "Click stays in the active inline editor"
              )
              return
            }
            event.preventDefault()
            event.stopPropagation()
            if (
              event.target instanceof HTMLElement &&
              event.target.closest("[data-preview-slice-control]")
            ) {
              inlineActivationDiagnostic("Click selects a slice control")
              selectSlice()
              return
            }
            const match = fieldMatchFromClick(
              event.currentTarget,
              event.target,
              fieldTargets
            )
            if (process.env.NODE_ENV === "development")
              inlineActivationDiagnostic("Click field match", {
                sliceId: readSlice(slice).id,
                match: match
                  ? {
                      fieldPath: match.target.fieldPath,
                      kind: match.target.kind,
                      profile: match.target.profile,
                      element: diagnosticElement(match.element),
                    }
                  : null,
              })
            if (match) {
              beginInlineIfSupported(match, event)
              return
            }
            focusSliceFormFallback(event.detail)
          }}
          onDoubleClickCapture={(event) => {
            if (process.env.NODE_ENV === "development")
              inlineActivationDiagnostic("Double click reached the slice", {
                sliceId: readSlice(slice).id,
                target: diagnosticElement(event.target),
                clientX: event.clientX,
                clientY: event.clientY,
                trusted: event.isTrusted,
              })
            if (
              event.target instanceof Element &&
              event.target.closest("[data-preview-inline-editor]")
            ) {
              inlineActivationDiagnostic(
                "Double click stays in the active inline editor"
              )
              return
            }
            event.preventDefault()
            event.stopPropagation()
            const match = fieldMatchFromClick(
              event.currentTarget,
              event.target,
              fieldTargets
            )
            if (!inlineEditingEnabled) {
              inlineActivationDiagnostic(
                "Double click refused: inline editing is switched off"
              )
              if (match) beginInlineIfSupported(match, event)
              else focusSliceFormFallback(event.detail)
              return
            }
            if (process.env.NODE_ENV === "development")
              inlineActivationDiagnostic("Double click field match", {
                sliceId: readSlice(slice).id,
                match: match
                  ? {
                      fieldPath: match.target.fieldPath,
                      kind: match.target.kind,
                      profile: match.target.profile,
                      element: diagnosticElement(match.element),
                    }
                  : null,
              })
            if (!match) {
              focusSliceFormFallback(event.detail)
              return
            }
            beginInlineIfSupported(match, event)
          }}
          className={cn(
            "group relative isolate cursor-pointer transition-[box-shadow]",
            inlineEditingEnabled && "cursor-text",
            selected && "ring-2 ring-primary/70"
          )}
        >
          {render
            ? render({
                ...ctx,
                previewRichText: ({
                  fieldPath: requestedFieldPath,
                  profile,
                  contract = profile,
                  headingFloor,
                  rendered,
                }) => {
                  const fieldPath = parseFieldPath(requestedFieldPath).join(".")
                  const target = fieldTargets.find(
                    (entry) => entry.fieldPath === fieldPath
                  )
                  const editingThisField =
                    activeSession?.sliceId === readSlice(slice).id &&
                    activeSession.fieldPath === fieldPath
                  if (!target && !editingThisField) return rendered
                  if (
                    editingThisField &&
                    ["inline", "title", "basic"].includes(contract)
                  ) {
                    const editor = (
                      <PreviewInlineEditor
                        key={`${readSlice(slice).id}:${fieldPath}`}
                        fieldPath={fieldPath}
                        contract={contract}
                        resolvedContract={target?.resolvedContract}
                        className={
                          contract === "basic"
                            ? "prose max-w-none prose-neutral dark:prose-invert"
                            : undefined
                        }
                        headingFloor={headingFloor}
                        value={activeSession.draft}
                        initialPoint={initialPoint}
                        label={t("inlineEdit", {
                          label: activeSession.label,
                        })}
                        onChange={onDraftChange}
                        onCancel={onCancel}
                        onCommit={onCommit}
                        onCompositionChange={onCompositionChange}
                        onFlushHandleChange={onFlushHandleChange}
                      />
                    )
                    // Keep the descriptor-owned semantic host and its id; the
                    // active editor replaces only its children.
                    return isValidElement<Record<string, unknown>>(rendered)
                      ? cloneElement(
                          rendered,
                          {
                            "data-preview-field": fieldPath,
                            "data-preview-inline-contract": contract,
                          },
                          editor
                        )
                      : rendered
                  }
                  // Retain the exact public host, including flex-item geometry.
                  return isValidElement<Record<string, unknown>>(rendered)
                    ? cloneElement(rendered, {
                        "data-preview-field": fieldPath,
                        "data-preview-inline-contract": contract,
                      })
                    : rendered
                },
                previewField: ({ fieldPath, rendered }) => {
                  const normalized = parseFieldPath(fieldPath).join(".")
                  const target = fieldTargets.find(
                    (entry) => entry.fieldPath === normalized
                  )
                  const editingThisField =
                    activeSession?.sliceId === readSlice(slice).id &&
                    activeSession.fieldPath === normalized
                  if (
                    (!target && !editingThisField) ||
                    !isValidElement<Record<string, unknown>>(rendered)
                  ) {
                    return rendered
                  }
                  return cloneElement(rendered, {
                    "data-preview-field": normalized,
                  })
                },
                previewKitSlice: (rendered) =>
                  isValidElement<Record<string, unknown>>(rendered)
                    ? cloneElement(rendered, {
                        "data-preview-field-kit": "true",
                      })
                    : rendered,
              })
            : null}
          <button
            type="button"
            data-preview-slice-control
            aria-label={t("editSlice", { label, index: index + 1 })}
            aria-pressed={selected}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              selectSlice()
            }}
            className={cn(
              "absolute top-3 left-3 z-30 rounded-md bg-primary px-2 py-1 text-[11px] font-medium text-primary-foreground opacity-0 shadow-sm transition-opacity outline-none",
              "group-hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/60",
              selected && "opacity-100"
            )}
          >
            {label}
          </button>
          <div
            aria-hidden={true}
            className={cn(
              "pointer-events-none absolute inset-0 z-20 opacity-0 ring-2 ring-primary/55 transition-opacity ring-inset",
              "group-hover:opacity-100 group-focus-visible:opacity-100",
              selected && "opacity-100"
            )}
          />
        </div>
      )
    },
  }
  const outline = resolvePageOutline({
    slices,
    locale: ctx.locale,
    mode: pageHeadingModeFor("page"),
  })
  return renderPage ? (
    renderPage(slices, interceptedContext)
  ) : (
    <>
      {outline.hostRendersFallbackH1 && <h1 className="sr-only">{title}</h1>}
      <SliceZone slices={slices} ctx={interceptedContext} outline={outline} />
    </>
  )
}

export function PageLivePreviewCanvas({
  title,
  slices,
  locale,
  defaultLocale,
  contentEpoch = 0,
  inlineEditEcho,
  selectedSliceId,
  onSelectSlice,
  onSelectSliceFallback,
  onSelectField,
  onInlineEditCommit,
  onActiveEditHandleChange,
  onActiveEditChange,
  onActiveEditConflict,
  controlledInlineEnabled,
  renderContext,
  renderPage,
  renderSlicesTransform,
}: {
  title: string
  slices: Slice[]
  locale: string
  defaultLocale: string
  contentEpoch?: number
  inlineEditEcho?: PreviewInlineEditCommit
  selectedSliceId: string | null
  onSelectSlice: (sliceId: string) => void
  onSelectSliceFallback?: (sliceId: string) => void
  onSelectField: (
    target: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ) => void
  onInlineEditCommit: (commit: PreviewInlineEditCommit) => boolean | void
  onActiveEditHandleChange?: (handle: PreviewActiveEditHandle | null) => void
  onActiveEditChange?: (commit: PreviewInlineEditCommit | null) => void
  onActiveEditConflict?: () => void
  controlledInlineEnabled?: boolean
  renderContext?: SliceRenderContext
  renderPage?: (slices: Slice[], context: SliceRenderContext) => ReactNode
  renderSlicesTransform?: (slices: Slice[]) => Slice[]
}) {
  const [session, setSession] = useState<PreviewInlineSession | null>(null)
  // Display only parent-accepted local values over the exact lagging input.
  // A new external array immediately drops this projection. It is not a draft
  // owner: every change below must first succeed through the parent callback.
  const [projection, setProjection] = useState<{
    input: Slice[]
    slices: Slice[]
  } | null>(null)
  const [initialPoint, setInitialPoint] = useState<
    { left: number; top: number } | undefined
  >()
  const sessionRef = useRef<PreviewInlineSession | null>(null)
  const composing = useRef(false)
  const conflict = useRef(false)
  const flushEditor = useRef<(() => void) | null>(null)
  const endRequested = useRef(false)
  // Stable component prop: changing a callback must never remount the island.
  const [bindFlush] = useState(() => (flush: (() => void) | null) => {
    flushEditor.current = flush
  })
  const sliceRefs = useRef<Map<string, HTMLDivElement> | null>(null)
  if (sliceRefs.current === null) {
    sliceRefs.current = new Map()
  }
  const canonical = useRef({
    slices,
    locale,
    contentEpoch,
    catalog: renderContext?.presentationCatalog?.revision ?? "",
  })
  const callbacks = useRef({
    onInlineEditCommit,
    onActiveEditChange,
    onActiveEditConflict,
  })
  const enabled = controlledInlineEnabled ?? false
  const ctx: SliceRenderContext = renderContext ?? {
    locale,
    defaultLocale,
    pagePaths: {},
    relationCards: {},
  }
  function report(next: PreviewInlineSession | null) {
    sessionRef.current = next
    setSession(next)
    if (process.env.NODE_ENV === "development")
      inlineActivationDiagnostic("Session report", {
        active: next !== null,
        sliceId: next?.sliceId ?? null,
        fieldPath: next?.fieldPath ?? null,
        composing: composing.current,
      })
    callbacks.current.onActiveEditChange?.(
      next ? { ...next, value: next.draft, composing: composing.current } : null
    )
  }
  function markConflict() {
    conflict.current = true
    const current = sessionRef.current
    if (current)
      callbacks.current.onActiveEditChange?.({
        ...current,
        value: current.draft,
        composing: composing.current,
      })
    callbacks.current.onActiveEditConflict?.()
  }
  const leaveFromEffect = useEffectEvent(leave)
  useLayoutEffect(() => {
    callbacks.current = {
      onInlineEditCommit,
      onActiveEditChange,
      onActiveEditConflict,
    }
  })
  useLayoutEffect(() => {
    // The child root renders each accepted keystroke before the parent can echo
    // its draft. Only a new parent input may replace that local field baseline.
    const current = sessionRef.current
    const reconciled =
      current && !conflict.current
        ? reconcilePageFieldEcho(
            slices,
            locale,
            { ...current, value: current.draft },
            inlineEditEcho,
            contentEpoch,
            ctx.presentationCatalog?.revision ?? ""
          )
        : null
    const baseline = reconciled ?? slices
    if (reconciled) setProjection({ input: slices, slices: reconciled })
    canonical.current = {
      slices: baseline,
      locale,
      contentEpoch,
      catalog: ctx.presentationCatalog?.revision ?? "",
    }
    if (!current) return
    const rebased = rebasePageField(
      baseline,
      locale,
      { ...current, value: current.draft },
      contentEpoch,
      canonical.current.catalog
    )
    if (
      !applyPageField(
        baseline,
        locale,
        rebased,
        contentEpoch,
        canonical.current.catalog
      )
    ) {
      // An untouched session yields to a same-field value change from the form.
      const binding = current.fieldBinding
      const now = capturePageField(
        baseline,
        locale,
        current.sliceId,
        current.fieldPath,
        contentEpoch,
        canonical.current.catalog
      )
      if (
        !composing.current &&
        binding &&
        now?.fieldBinding &&
        current.draft === current.cancellationValue &&
        current.draft === binding.lastApplied &&
        now.value !== binding.lastApplied &&
        current.locale === locale &&
        binding.contentEpoch === contentEpoch &&
        binding.catalogRevision === canonical.current.catalog &&
        now.sliceType === current.sliceType &&
        now.kind === current.kind &&
        now.fieldBinding.presentation === binding.presentation &&
        now.fieldBinding.descriptor === binding.descriptor &&
        now.fieldBinding.itemFingerprint === binding.itemFingerprint &&
        !now.repeatedTarget &&
        !current.repeatedTarget
      ) {
        leaveFromEffect()
      } else markConflict()
    } else sessionRef.current = { ...current, ...rebased, draft: current.draft }
    // A same-field external change never overwrites the uncontrolled island.
  }, [
    slices,
    locale,
    contentEpoch,
    ctx.presentationCatalog?.revision,
    inlineEditEcho,
  ])
  useEffect(() => {
    const handle: PreviewActiveEditHandle = {
      flush: () => flushEditor.current?.(),
      discardActiveEdit: () => {
        composing.current = false
        conflict.current = false
        leaveFromEffect()
      },
      capture: () =>
        sessionRef.current
          ? { ...sessionRef.current, value: sessionRef.current.draft }
          : null,
      acceptCapture() {},
      isComposing: () => composing.current,
      hasActiveSession: () => sessionRef.current !== null,
    }
    onActiveEditHandleChange?.(handle)
    return () => onActiveEditHandleChange?.(null)
  }, [onActiveEditHandleChange])
  useEffect(() => {
    if (!selectedSliceId) return
    const id = requestAnimationFrame(() =>
      sliceRefs.current?.get(selectedSliceId)?.scrollIntoView({ block: "start" })
    )
    return () => cancelAnimationFrame(id)
  }, [selectedSliceId])
  function leave() {
    if (composing.current) return
    endRequested.current = false
    report(null)
    conflict.current = false
  }
  // A parent-document focus transfer has no island relatedTarget. Finish at
  // focusin, before the sidebar editor can accept its first input. Save and
  // preview toolbar focus deliberately keep their existing capture semantics.
  function finishSession() {
    if (!sessionRef.current || conflict.current) return
    if (composing.current) {
      endRequested.current = true
      return
    }
    endRequested.current = false
    flushEditor.current?.()
    if (composing.current) endRequested.current = true
    else if (!conflict.current) leave()
  }
  const finishFromEffect = useEffectEvent(finishSession)
  useEffect(() => {
    // enabled crosses the frame/root boundary; the canvas owns the session.
    if (!enabled) finishFromEffect()
  }, [enabled])
  useEffect(() => {
    const frameDocument =
      sliceRefs.current?.values().next().value?.ownerDocument ?? document
    const parentDocument =
      frameDocument.defaultView?.frameElement?.ownerDocument ?? frameDocument
    function onSidebarFocus(event: FocusEvent) {
      const target = event.target as Element | null
      if (
        !sessionRef.current ||
        conflict.current ||
        !target?.closest?.("[data-preview-sidebar]")
      )
        return
      // Flush both roots and the sidebar's controlled-value adoption before
      // returning to the browser's focus/input sequence.
      flushSync(() => finishFromEffect())
    }
    parentDocument.addEventListener("focusin", onSidebarFocus, true)
    return () => {
      endRequested.current = false
      parentDocument.removeEventListener("focusin", onSidebarFocus, true)
    }
  }, [])
  function begin(
    sliceId: string,
    match: PreviewFieldMatch
  ): PreviewInlineActivationResult {
    const current = canonical.current
    const targetSlice = current.slices.find(
      (slice) => readSlice(slice).id === sliceId
    )
    const targetDef = targetSlice
      ? readSliceDefinition(readSlice(targetSlice).type)
      : undefined
    if (!targetSlice || !targetDef)
      return { status: "refused", reason: "capture" }
    if (isPrimaryListPath(targetDef.primary, match.target.fieldPath))
      return { status: "refused", reason: "unsupported" }
    if (
      sessionRef.current?.sliceId === sliceId &&
      sessionRef.current.fieldPath === match.target.fieldPath
    ) {
      inlineActivationDiagnostic("Begin retained the active field session")
      return { status: "activated" }
    }
    if (conflict.current) {
      inlineActivationDiagnostic("Begin refused: the preview field is stale")
      return { status: "refused", reason: "stale" }
    }
    if (
      !enabled ||
      composing.current ||
      match.target.kind !== "richText" ||
      !["inline", "title", "basic"].includes(match.target.profile ?? "") ||
      match.element.dataset.previewField !== match.target.fieldPath
    ) {
      if (process.env.NODE_ENV === "development")
        inlineActivationDiagnostic("Begin refused", {
          sliceId,
          fieldPath: match.target.fieldPath,
          reasons: [
            !enabled && "inline editing is switched off",
            composing.current && "an edit is composing",
            match.target.kind !== "richText" &&
              "matched field is not rich text",
            match.target.profile !== "inline" &&
              match.target.profile !== "title" &&
              match.target.profile !== "basic" &&
              "field profile is not inline",
            match.element.dataset.previewField !== match.target.fieldPath &&
              "matched element does not identify the matched field",
          ].filter(Boolean),
        })
      return { status: "refused", reason: "begin" }
    }
    const binding = capturePageField(
      current.slices,
      current.locale,
      sliceId,
      match.target.fieldPath,
      current.contentEpoch,
      current.catalog,
      process.env.NODE_ENV === "development"
        ? (reason) =>
            inlineActivationDiagnostic(`Capture refused: ${reason}`, {
              sliceId,
              fieldPath: match.target.fieldPath,
            })
        : undefined
    )
    if (!binding) return { status: "refused", reason: "capture" }
    if (binding.value !== match.target.value)
      return { status: "refused", reason: "stale" }
    inlineActivationDiagnostic("Capture accepted; reporting an active session")
    conflict.current = false
    endRequested.current = false
    setInitialPoint(match.point)
    report({
      ...binding,
      inlineSessionId: crypto.randomUUID(),
      draft: binding.value,
      cancellationValue: binding.value,
      label: match.target.label,
    })
    return { status: "activated" }
  }
  function change(value: string, removedLinks: RemovedRichTextLink[] = []) {
    const current = sessionRef.current
    if (!current) return
    const links = mergeRemovedLinks(current.removedLinks ?? [], removedLinks)
    if (
      value === current.draft &&
      links.length === (current.removedLinks?.length ?? 0)
    )
      return
    const next = {
      ...current,
      draft: value,
      ...(links.length ? { removedLinks: links } : {}),
    }
    sessionRef.current = next
    setSession(next)
    const base = canonical.current
    const commit = rebasePageField(
      base.slices,
      base.locale,
      { ...next, value, composing: composing.current },
      base.contentEpoch,
      base.catalog
    )
    const patched =
      !conflict.current &&
      applyPageField(
        base.slices,
        base.locale,
        commit,
        base.contentEpoch,
        base.catalog
      )
    if (!patched || callbacks.current.onInlineEditCommit(commit) === false) {
      markConflict()
      return
    }
    canonical.current = { ...base, slices: patched }
    setProjection({ input: slices, slices: patched })
    report({
      ...next,
      ...commit,
      draft: value,
      fieldBinding: { ...commit.fieldBinding!, lastApplied: value },
    })
  }
  const renderSlices = withUniqueSliceRenderIds(
    renderSlicesTransform
      ? renderSlicesTransform(
          projection?.input === slices ? projection.slices : slices
        )
      : projection?.input === slices
        ? projection.slices
        : slices
  )
  return (
    <AdminSlicePreviewZone
      title={title}
      slices={renderSlices}
      ctx={ctx}
      selectedSliceId={selectedSliceId}
      onSelectSlice={onSelectSlice}
      onSelectSliceFallback={onSelectSliceFallback}
      onSelectField={onSelectField}
      inlineEditingEnabled={enabled}
      onBeginInlineEdit={begin}
      registerSliceNode={(id, node) => {
        if (node) sliceRefs.current?.set(id, node)
        else sliceRefs.current?.delete(id)
      }}
      activeSession={session}
      initialPoint={initialPoint}
      onDraftChange={change}
      onCommit={leave}
      onCancel={leave}
      onCompositionChange={(value) => {
        composing.current = value
        report(sessionRef.current)
        if (!value && endRequested.current) {
          // Custom DOM handlers run before ProseMirror clears composing and
          // flushes its pending DOM records. Finish in the next task, after
          // those microtasks; a discarded/replaced session cancels the request.
          setTimeout(() => {
            if (endRequested.current) finishSession()
          }, 0)
        }
      }}
      onFlushHandleChange={bindFlush}
      renderPage={renderPage}
    />
  )
}

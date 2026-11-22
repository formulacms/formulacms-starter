"use client"

import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock } from "@/convex/lib/blocks/identity"
import {
  mergeRemovedLinks,
  type RemovedRichTextLink,
} from "@/convex/lib/richtext/shape"

import {
  resolvePageOutline,
  pageHeadingModeFor,
} from "@/lib/blocks/page-outline"

import {
  adminFieldMetadata,
  adminBlockMetadata,
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
import { useTranslations } from "next-intl"
import {
  type ImageField,
  type Primitive,
  type Block,
} from "@/convex/lib/blocks"
import { withUniqueBlockRenderIds } from "@/convex/lib/blocks/identity"
import {
  resolveFieldContract,
  type FieldContract,
  type ResolvedFieldContract,
} from "@/convex/lib/richtext/contracts"
import { BlockList } from "@/components/blocks/block-list"
import type { BlockRenderContext } from "@/lib/blocks/links"
import {
  parseFieldPath,
  setValueAtFieldPath,
} from "./page-editor/lib/field-path"
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
  isInPlacePlainText,
  isPrimaryListPath,
} from "./page-editor/lib/page-inline-draft"
import type { PreviewInlineSession } from "./preview-inline-session"
import {
  nextPendingClick,
  readPreviewClick,
  type PreviewClickPoint,
} from "./rich-text-caret"

type InlineEditorComponent =
  typeof import("./preview-inline-editor").PreviewInlineEditor

let inlineEditorLoad: Promise<InlineEditorComponent> | null = null

/**
 * Loads the in-place editor's code once, as soon as editing in the preview is
 * on. Not `next/dynamic` or `React.lazy`: their Suspense fallback would empty
 * the field (`loading` gets no field props) and React holds a revealed
 * Suspense boundary back for up to 300 ms. Until the code is here the field
 * keeps its rendered text, so clicks keep landing on the same words.
 */
function loadPreviewInlineEditor() {
  inlineEditorLoad ??= import("./preview-inline-editor").then(
    (module) => module.PreviewInlineEditor,
    (error: unknown) => {
      inlineEditorLoad = null
      throw error
    }
  )
  return inlineEditorLoad
}

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
  /** A one-line plain text field, edited in place like a title. */
  plainLine?: boolean
  maxLength?: number
}

type PreviewFieldMatch = {
  target: PreviewFieldTarget
  element: HTMLElement
  point?: PreviewClickPoint
}

/** The field selection a preview click reports: one click is the default,
 *  only a double or triple click says so. */
function previewFieldSelection(
  blockId: string,
  fieldPath: string,
  result?: PreviewInlineActivationResult,
  click?: PreviewClickPoint
): PreviewFieldSelection {
  const clickCount = click?.clickCount
  return {
    blockId,
    fieldPath,
    ...(result?.status === "activated" ? { inlineEditing: true } : {}),
    ...(click?.textOffset !== undefined ? { textOffset: click.textOffset } : {}),
    ...(clickCount === 2 || clickCount === 3 ? { clickCount } : {}),
  }
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
          value: value as string,
          ...(isInPlacePlainText(def)
            ? {
                plainLine: true,
                maxLength: (def.config as { maxLength?: number }).maxLength,
              }
            : {}),
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

function previewTargetsForBlock(
  block: Block,
  labels: { primary: string; items: string },
  tMetadata: AdminMetadataTranslator
): PreviewFieldTarget[] {
  const def = readBlockDefinition(readBlock(block).type)
  if (!def) return []
  const targets: PreviewFieldTarget[] = []
  collectPreviewTargets(
    def.primary,
    readBlock(block).primary,
    "primary",
    labels.primary,
    targets,
    tMetadata
  )
  if (def.items !== undefined && "items" in block) {
    collectPreviewTargets(
      def.items,
      (block as { items?: unknown[] }).items,
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

/**
 * The in-place editor a matched field host opens, or null when the field is
 * edited in the form: a title, inline or basic rich-text field, or a one-line
 * plain text field ("plain"), on its own marked host and outside a primary
 * list. Full rich text, multiline text, images and list rows stay in the form.
 */
function inPlaceMode(
  block: Block,
  { target, element }: PreviewFieldMatch
): FieldContract | "plain" | null {
  if (element.dataset.previewField !== target.fieldPath) return null
  const def = readBlockDefinition(readBlock(block).type)
  if (def && isPrimaryListPath(def.primary, target.fieldPath)) return null
  const marker = element.dataset.previewInlineContract
  if (target.kind === "text")
    return target.plainLine && marker === "plain" ? "plain" : null
  const profile = target.profile
  if (
    target.kind !== "richText" ||
    !profile ||
    !["inline", "title", "basic"].includes(profile)
  )
    return null
  return marker === profile || (profile === "title" && marker === "inline")
    ? profile
    : null
}

function AdminBlockPreviewZone({
  title,
  blocks,
  ctx,
  selectedBlockId,
  onSelectBlock,
  onSelectBlockFallback,
  onSelectField,
  inlineEditingEnabled,
  onBeginInlineEdit,
  registerBlockNode,
  activeSession,
  inlineEditor: PreviewInlineEditor,
  initialPoint,
  onDraftChange,
  onCommit,
  onCancel,
  onCompositionChange,
  onFlushHandleChange,
  renderPage,
}: {
  title: string
  blocks: Block[]
  ctx: BlockRenderContext
  selectedBlockId: string | null
  onSelectBlock: (blockId: string) => void
  onSelectBlockFallback?: (blockId: string) => void
  onSelectField: (
    target: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ) => void
  inlineEditingEnabled: boolean
  onBeginInlineEdit: (
    blockId: string,
    match: PreviewFieldMatch
  ) => PreviewInlineActivationResult
  registerBlockNode: (blockId: string, node: HTMLDivElement | null) => void
  activeSession: PreviewInlineSession | null
  /** The loaded in-place editor; null while its code is still loading. */
  inlineEditor: InlineEditorComponent | null
  initialPoint?: PreviewClickPoint
  onDraftChange: (value: string, removedLinks?: RemovedRichTextLink[]) => void
  onCommit: () => void
  onCancel: () => void
  onCompositionChange: (composing: boolean) => void
  onFlushHandleChange: (flush: (() => void) | null) => void
  renderPage?: (blocks: Block[], context: BlockRenderContext) => ReactNode
}) {
  const t = useTranslations("editor.livePreview")
  const tMetadata = useTranslations("metadata")
  const visible = blocks.filter((block) => readBlock(block).enabled !== false)

  const interceptedContext: BlockRenderContext = {
    ...ctx,
    previewBlock: (block, render) => {
      const index = visible.findIndex(
        (entry) => readBlock(entry).id === readBlock(block).id
      )
      const label =
        adminBlockMetadata(readBlock(block).type, tMetadata)?.label ??
        readBlock(block).type
      const selected = selectedBlockId === readBlock(block).id
      const fieldTargets = previewTargetsForBlock(
        block,
        {
          primary: t("primary"),
          items: t("items"),
        },
        tMetadata
      )

      function selectBlock() {
        onSelectBlock(readBlock(block).id)
      }

      function focusBlockFormFallback(clickCount: number) {
        if (clickCount > 1) return
        if (onSelectBlockFallback) onSelectBlockFallback(readBlock(block).id)
        else selectBlock()
      }

      function selectField(
        fieldPath: string,
        result?: PreviewInlineActivationResult,
        click?: PreviewClickPoint
      ) {
        const target = previewFieldSelection(
          readBlock(block).id,
          fieldPath,
          result,
          click
        )
        if (result) onSelectField(target, result)
        else onSelectField(target)
      }

      function beginInlineIfSupported(
        match: PreviewFieldMatch,
        event: { detail: number; clientX: number; clientY: number }
      ) {
        // The click is read now, on the field's own host: its spot and click
        // count reach the form control or the in-place editor, and the frame
        // may scroll the block before either one is ready.
        const click =
          match.target.kind !== "image" &&
          match.element.dataset.previewField === match.target.fieldPath
            ? readPreviewClick(match.element, event)
            : undefined
        if (!inlineEditingEnabled) {
          // While the editor blocks editing in the preview (a recovered
          // draft waits, a repeated conflict, a lock, a reload needed),
          // every field is edited in the form; an image always is.
          selectField(
            match.target.fieldPath,
            match.target.kind === "image"
              ? { status: "refused", reason: "unsupported" }
              : undefined,
            click
          )
          return false
        }
        // Every form-only field is refused here, with the click, so its
        // form control gets the clicked spot and count.
        const supported = inPlaceMode(block, match) !== null
        if (process.env.NODE_ENV === "development")
          inlineActivationDiagnostic(
            supported ? "Supported field can begin" : "Supported field refused",
            {
              blockId: readBlock(block).id,
              fieldPath: match.target.fieldPath,
              kind: match.target.kind,
              profile: match.target.profile ?? null,
              marker:
                match.element.dataset.previewInlineContract ?? null,
              markedField: match.element.dataset.previewField ?? null,
            }
          )
        if (!supported) {
          selectField(
            match.target.fieldPath,
            { status: "refused", reason: "unsupported" },
            click
          )
          return false
        }
        const result = onBeginInlineEdit(readBlock(block).id, {
          ...match,
          point: click,
        })
        selectField(match.target.fieldPath, result)
        return result.status === "activated"
      }

      return (
        <div
          key={readBlock(block).id}
          data-preview-block-occurrence
          ref={(node) => registerBlockNode(readBlock(block).id, node)}
          onClickCapture={(event) => {
            if (process.env.NODE_ENV === "development")
              inlineActivationDiagnostic("Click reached the block", {
                blockId: readBlock(block).id,
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
              // A plain text host may sit in a link, button or label. A
              // click in its editor places the caret only: it never follows
              // the link, submits or moves the focus.
              if (event.target.closest("a, button, label"))
                event.preventDefault()
              return
            }
            event.preventDefault()
            event.stopPropagation()
            if (
              event.target instanceof HTMLElement &&
              event.target.closest("[data-preview-block-control]")
            ) {
              inlineActivationDiagnostic("Click selects a block control")
              selectBlock()
              return
            }
            const match = fieldMatchFromClick(
              event.currentTarget,
              event.target,
              fieldTargets
            )
            if (process.env.NODE_ENV === "development")
              inlineActivationDiagnostic("Click field match", {
                blockId: readBlock(block).id,
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
            focusBlockFormFallback(event.detail)
          }}
          onDoubleClickCapture={(event) => {
            if (process.env.NODE_ENV === "development")
              inlineActivationDiagnostic("Double click reached the block", {
                blockId: readBlock(block).id,
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
            // A pointer double click already reached onClickCapture as its
            // second click, which owns the click count. Only a double click
            // without clicks (detail 0, an assistive or synthetic one) selects.
            if (event.detail > 0) return
            const match = fieldMatchFromClick(
              event.currentTarget,
              event.target,
              fieldTargets
            )
            if (!inlineEditingEnabled) {
              inlineActivationDiagnostic(
                "Double click refused: editing in the preview is blocked"
              )
              if (match) beginInlineIfSupported(match, event)
              else focusBlockFormFallback(event.detail)
              return
            }
            if (process.env.NODE_ENV === "development")
              inlineActivationDiagnostic("Double click field match", {
                blockId: readBlock(block).id,
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
              focusBlockFormFallback(event.detail)
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
                    activeSession?.blockId === readBlock(block).id &&
                    activeSession.fieldPath === fieldPath
                  if (!target && !editingThisField) return rendered
                  if (
                    editingThisField &&
                    PreviewInlineEditor &&
                    ["inline", "title", "basic"].includes(contract)
                  ) {
                    const editor = (
                      <PreviewInlineEditor
                        key={`${readBlock(block).id}:${fieldPath}`}
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
                  // An opening field keeps it until its editor code is loaded.
                  return isValidElement<Record<string, unknown>>(rendered)
                    ? cloneElement(rendered, {
                        "data-preview-field": fieldPath,
                        "data-preview-inline-contract": contract,
                      })
                    : rendered
                },
                previewField: ({ fieldPath, kind, rendered }) => {
                  const normalized = parseFieldPath(fieldPath).join(".")
                  const target = fieldTargets.find(
                    (entry) => entry.fieldPath === normalized
                  )
                  const editingThisField =
                    activeSession?.blockId === readBlock(block).id &&
                    activeSession.fieldPath === normalized
                  if (
                    (!target && !editingThisField) ||
                    !isValidElement<Record<string, unknown>>(rendered)
                  ) {
                    return rendered
                  }
                  // A one-line plain text host opens in place, as a title,
                  // when the field's text is all it holds (the kit's `Text`).
                  const marker =
                    kind === "text" &&
                    target?.plainLine &&
                    typeof rendered.props.children === "string"
                      ? { "data-preview-inline-contract": "plain" }
                      : {}
                  if (
                    editingThisField &&
                    PreviewInlineEditor &&
                    activeSession.kind === "text" &&
                    "data-preview-inline-contract" in marker
                  )
                    // Same host, same id; the editor replaces its text only.
                    return cloneElement(
                      rendered,
                      { "data-preview-field": normalized, ...marker },
                      <PreviewInlineEditor
                        key={`${readBlock(block).id}:${normalized}`}
                        fieldPath={normalized}
                        plainText
                        maxLength={target?.maxLength}
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
                  return cloneElement(rendered, {
                    "data-preview-field": normalized,
                    ...marker,
                  })
                },
                previewKitBlock: (rendered) =>
                  isValidElement<Record<string, unknown>>(rendered)
                    ? cloneElement(rendered, {
                        "data-preview-field-kit": "true",
                      })
                    : rendered,
              })
            : null}
          <button
            type="button"
            data-preview-block-control
            aria-label={t("editBlock", { label, index: index + 1 })}
            aria-pressed={selected}
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              selectBlock()
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
    blocks,
    locale: ctx.locale,
    mode: pageHeadingModeFor("page"),
  })
  return renderPage ? (
    renderPage(blocks, interceptedContext)
  ) : (
    <>
      {outline.hostRendersFallbackH1 && <h1 className="sr-only">{title}</h1>}
      <BlockList blocks={blocks} ctx={interceptedContext} outline={outline} />
    </>
  )
}

/**
 * True when at least half of the block, or half of the viewport for a block
 * taller than it, is on screen. A block without layout height is not in view.
 */
export function isBlockMostlyInView(
  rect: { top: number; bottom: number; height: number },
  viewportHeight: number
) {
  if (rect.height <= 0 || viewportHeight <= 0) return false
  const visible =
    Math.min(rect.bottom, viewportHeight) - Math.max(rect.top, 0)
  return visible >= Math.min(rect.height, viewportHeight) / 2
}

export function PageLivePreviewCanvas({
  title,
  blocks,
  locale,
  defaultLocale,
  contentEpoch = 0,
  inlineEditEcho,
  selectedBlockId,
  onSelectBlock,
  onSelectBlockFallback,
  onSelectField,
  onInlineEditCommit,
  onActiveEditHandleChange,
  onActiveEditChange,
  onActiveEditConflict,
  controlledInlineEnabled,
  renderContext,
  renderPage,
  renderBlocksTransform,
}: {
  title: string
  blocks: Block[]
  locale: string
  defaultLocale: string
  contentEpoch?: number
  inlineEditEcho?: PreviewInlineEditCommit
  selectedBlockId: string | null
  onSelectBlock: (blockId: string) => void
  onSelectBlockFallback?: (blockId: string) => void
  onSelectField: (
    target: PreviewFieldSelection,
    result?: PreviewInlineActivationResult
  ) => void
  onInlineEditCommit: (commit: PreviewInlineEditCommit) => boolean | void
  onActiveEditHandleChange?: (handle: PreviewActiveEditHandle | null) => void
  onActiveEditChange?: (commit: PreviewInlineEditCommit | null) => void
  onActiveEditConflict?: () => void
  controlledInlineEnabled?: boolean
  renderContext?: BlockRenderContext
  renderPage?: (blocks: Block[], context: BlockRenderContext) => ReactNode
  renderBlocksTransform?: (blocks: Block[]) => Block[]
}) {
  const [session, setSession] = useState<PreviewInlineSession | null>(null)
  // Display only parent-accepted local values over the exact lagging input.
  // A new external array immediately drops this projection. It is not a draft
  // owner: every change below must first succeed through the parent callback.
  const [projection, setProjection] = useState<{
    input: Block[]
    blocks: Block[]
  } | null>(null)
  const [initialPoint, setInitialPoint] = useState<
    PreviewClickPoint | undefined
  >()
  const [inlineEditor, setInlineEditor] =
    useState<InlineEditorComponent | null>(null)
  const sessionRef = useRef<PreviewInlineSession | null>(null)
  const composing = useRef(false)
  const conflict = useRef(false)
  const flushEditor = useRef<(() => void) | null>(null)
  const endRequested = useRef(false)
  // Stable component prop: changing a callback must never remount the island.
  const [bindFlush] = useState(() => (flush: (() => void) | null) => {
    flushEditor.current = flush
  })
  const blockRefs = useRef<Map<string, HTMLDivElement> | null>(null)
  if (blockRefs.current === null) {
    blockRefs.current = new Map()
  }
  const canonical = useRef({
    blocks,
    locale,
    contentEpoch,
    catalog: renderContext?.presentationCatalog?.revision ?? "",
  })
  const callbacks = useRef({
    onInlineEditCommit,
    onActiveEditChange,
    onActiveEditConflict,
    onSelectField,
  })
  // The latest pending click, also read when the editor's code fails.
  const pendingClick = useRef<PreviewClickPoint | undefined>(undefined)
  const loadingEditor = useRef(false)
  const enabled = controlledInlineEnabled ?? false
  const ctx: BlockRenderContext = renderContext ?? {
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
        blockId: next?.blockId ?? null,
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
      onSelectField,
    }
  })
  useLayoutEffect(() => {
    // The child root renders each accepted keystroke before the parent can echo
    // its draft. Only a new parent input may replace that local field baseline.
    const current = sessionRef.current
    const reconciled =
      current && !conflict.current
        ? reconcilePageFieldEcho(
            blocks,
            locale,
            { ...current, value: current.draft },
            inlineEditEcho,
            contentEpoch,
            ctx.presentationCatalog?.revision ?? ""
          )
        : null
    const baseline = reconciled ?? blocks
    if (reconciled) setProjection({ input: blocks, blocks: reconciled })
    canonical.current = {
      blocks: baseline,
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
        current.blockId,
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
        now.blockType === current.blockType &&
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
    blocks,
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
    if (!selectedBlockId) return
    const id = requestAnimationFrame(() => {
      const node = blockRefs.current?.get(selectedBlockId)
      // A block the owner can already see stays put: scrolling it would move
      // the second click of a double-click onto another line.
      if (
        node &&
        !isBlockMostlyInView(node.getBoundingClientRect(), window.innerHeight)
      )
        node.scrollIntoView({ block: "start" })
    })
    return () => cancelAnimationFrame(id)
  }, [selectedBlockId])
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
  /**
   * Loads the in-place editor's code. If it fails, an opening field falls
   * back to the form, with the click's spot and count, as a form-only field;
   * the next click tries the load again.
   */
  function ensureInlineEditor() {
    if (inlineEditor || loadingEditor.current) return
    loadingEditor.current = true
    loadPreviewInlineEditor().then(
      (component) => {
        loadingEditor.current = false
        setInlineEditor(() => component)
      },
      (error: unknown) => {
        loadingEditor.current = false
        inlineActivationDiagnostic("The in-place editor did not load", {
          error: String(error),
        })
        const current = sessionRef.current
        if (!current) return
        composing.current = false
        leave()
        callbacks.current.onSelectField(
          previewFieldSelection(
            current.blockId,
            current.fieldPath,
            undefined,
            pendingClick.current
          ),
          { status: "refused", reason: "unsupported" }
        )
      }
    )
  }
  const ensureFromEffect = useEffectEvent(ensureInlineEditor)
  useEffect(() => {
    // Preload as soon as editing in the preview is allowed.
    if (enabled) ensureFromEffect()
  }, [enabled])
  useEffect(() => {
    const frameDocument =
      blockRefs.current?.values().next().value?.ownerDocument ?? document
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
    blockId: string,
    match: PreviewFieldMatch
  ): PreviewInlineActivationResult {
    const current = canonical.current
    const targetBlock = current.blocks.find(
      (block) => readBlock(block).id === blockId
    )
    const targetDef = targetBlock
      ? readBlockDefinition(readBlock(targetBlock).type)
      : undefined
    if (!targetBlock || !targetDef)
      return { status: "refused", reason: "capture" }
    if (isPrimaryListPath(targetDef.primary, match.target.fieldPath))
      return { status: "refused", reason: "unsupported" }
    if (
      sessionRef.current?.blockId === blockId &&
      sessionRef.current.fieldPath === match.target.fieldPath
    ) {
      inlineActivationDiagnostic("Begin retained the active field session")
      // A later click of a double or triple click that lands while the editor
      // mounts raises its pending click count; a mounted editor ignores it.
      if (match.point) {
        pendingClick.current = nextPendingClick(pendingClick.current, match.point)
        setInitialPoint(pendingClick.current)
      }
      return { status: "activated" }
    }
    if (conflict.current) {
      inlineActivationDiagnostic("Begin refused: the preview field is stale")
      return { status: "refused", reason: "stale" }
    }
    if (
      !enabled ||
      composing.current ||
      inPlaceMode(targetBlock, match) === null
    ) {
      if (process.env.NODE_ENV === "development")
        inlineActivationDiagnostic("Begin refused", {
          blockId,
          fieldPath: match.target.fieldPath,
          reasons: [
            !enabled && "editing in the preview is blocked",
            composing.current && "an edit is composing",
            inPlaceMode(targetBlock, match) === null &&
              "the matched field is edited in the form",
          ].filter(Boolean),
        })
      return { status: "refused", reason: "begin" }
    }
    const binding = capturePageField(
      current.blocks,
      current.locale,
      blockId,
      match.target.fieldPath,
      current.contentEpoch,
      current.catalog,
      process.env.NODE_ENV === "development"
        ? (reason) =>
            inlineActivationDiagnostic(`Capture refused: ${reason}`, {
              blockId,
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
    pendingClick.current = match.point
    setInitialPoint(match.point)
    report({
      ...binding,
      inlineSessionId: crypto.randomUUID(),
      draft: binding.value,
      cancellationValue: binding.value,
      label: match.target.label,
    })
    // A load that failed before is tried again by this click.
    ensureInlineEditor()
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
      base.blocks,
      base.locale,
      { ...next, value, composing: composing.current },
      base.contentEpoch,
      base.catalog
    )
    const patched =
      !conflict.current &&
      applyPageField(
        base.blocks,
        base.locale,
        commit,
        base.contentEpoch,
        base.catalog
      )
    if (!patched || callbacks.current.onInlineEditCommit(commit) === false) {
      markConflict()
      return
    }
    canonical.current = { ...base, blocks: patched }
    setProjection({ input: blocks, blocks: patched })
    report({
      ...next,
      ...commit,
      draft: value,
      fieldBinding: { ...commit.fieldBinding!, lastApplied: value },
    })
  }
  const projected = projection?.input === blocks ? projection.blocks : blocks
  // A plain text field being edited renders its opening value: its editor
  // owns the host's text, and a renderer hides an empty field (`Text`, or
  // `{primary.eyebrow && …}`), so clearing it in place must not remove its
  // host (or move the page under the pointer).
  const shown =
    session?.kind === "text"
      ? projected.map((block) =>
          readBlock(block).id === session.blockId
            ? (setValueAtFieldPath(
                block,
                parseFieldPath(session.fieldPath),
                session.cancellationValue
              ) as Block)
            : block
        )
      : projected
  const renderBlocks = withUniqueBlockRenderIds(
    renderBlocksTransform ? renderBlocksTransform(shown) : shown
  )
  return (
    <AdminBlockPreviewZone
      title={title}
      blocks={renderBlocks}
      ctx={ctx}
      selectedBlockId={selectedBlockId}
      onSelectBlock={onSelectBlock}
      onSelectBlockFallback={onSelectBlockFallback}
      onSelectField={onSelectField}
      inlineEditingEnabled={enabled}
      onBeginInlineEdit={begin}
      registerBlockNode={(id, node) => {
        if (node) blockRefs.current?.set(id, node)
        else blockRefs.current?.delete(id)
      }}
      activeSession={session}
      inlineEditor={inlineEditor}
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

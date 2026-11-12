"use client"

import {
  currentSimBridge,
  postSimMessage,
  simMessageMatches,
} from "./sim-frame-bridge"

import { useEffect, useLayoutEffect, useRef } from "react"
import { type TargetEntry } from "@/lib/slices/flatten-content"
import { roleFromClassName } from "@/lib/slices/visual-tweak/capabilities"
import { classAnchorVerdict } from "@/lib/slices/visual-tweak/class-anchor"
import type { ToolbarMetrics } from "./slice-tweak-toolbar-types"
import type { TweakTargetMetadata } from "./tweak-target"

/**
 * Client-only targeting resolver, rendered *inside* the `?bare=1` preview
 * iframe (sibling to `SimSizeReporter`). It reads the already-rendered DOM and
 * maps the element under the cursor back to its content field using the existing
 * dev-only source stamp and simulator field adapters. It never touches the server-rendered
 * slice path (the locked boundary: only the slice renderers are Server
 * Components; all targeting is client-side here).
 *
 * It reports the resolved target up to the parent simulator via the existing
 * `formulacms-sim` postMessage channel; the parent draws the highlight + tooltip
 * and owns selection. Rects are in *iframe* viewport coordinates — the parent
 * scales them by the same factor it scales the iframe.
 */

type TargetRect = { left: number; top: number; width: number; height: number }
/** Everything the parent needs to draw the highlight and fill the inspector,
 *  read from one layout pass. */
type TargetBox = { rect: TargetRect; metrics: ToolbarMetrics }

function roundedMetric(value: number): number {
  return Math.round(value * 10) / 10
}

/** The design-system typography role an element carries (`text-display` →
 *  `"display"`), or `null` — lets the parent decide whether the token-edit
 *  (typography) controls are available for this target. */
function elementRole(el: Element): string | null {
  return roleFromClassName(el.getAttribute("class") ?? "")
}

/** One layout read per measurement: the highlight rect and the inspector's box
 *  metrics both come out of the same `getBoundingClientRect()` call, so a hover,
 *  a select and a post-nudge re-measure each cost a single forced layout. */
function measureTarget(el: Element): TargetBox {
  const r = el.getBoundingClientRect()
  const style = window.getComputedStyle(el)
  return {
    rect: { left: r.left, top: r.top, width: r.width, height: r.height },
    metrics: {
      size: {
        width: roundedMetric(r.width),
        height: roundedMetric(r.height),
      },
      padding: {
        top: style.paddingTop,
        right: style.paddingRight,
        bottom: style.paddingBottom,
        left: style.paddingLeft,
      },
      margin: {
        top: style.marginTop,
        right: style.marginRight,
        bottom: style.marginBottom,
        left: style.marginLeft,
      },
      gap: style.gap,
      fontSize: style.fontSize,
      lineHeight: style.lineHeight,
      letterSpacing: style.letterSpacing,
      rootFontSize: window.getComputedStyle(document.documentElement).fontSize,
    },
  }
}

/** Inline-style property for a spacing axis — the optimistic preview writes this
 *  directly on the selected element (dev/edit-time only, never persisted; the
 *  clean-CSS source bar is untouched). Tailwind JIT wouldn't have a
 *  runtime-injected class compiled, so we set the resolved style, not a class. */
const AXIS_STYLE_PROP: Record<string, string> = {
  pt: "paddingTop",
  pr: "paddingRight",
  pb: "paddingBottom",
  pl: "paddingLeft",
  mt: "marginTop",
  mr: "marginRight",
  mb: "marginBottom",
  ml: "marginLeft",
  gap: "gap",
}

/** Every optimistic inline style this layer has applied (element → CSS props),
 *  so the batch reconcile can clear the previous batch before applying the next
 *  one — making reconcile idempotent. That's what lets undo/redo (which re-post
 *  a *reduced* batch) actually remove the styles they dropped, instead of leaving
 *  a stale value behind. Module-scoped: a real iframe reload re-evaluates the
 *  module and starts clean; detached nodes left after a Fast Refresh are harmless
 *  (removeProperty is a no-op on them, and the reconcile re-resolves by path). */
const appliedStyles = new Map<HTMLElement, Set<string>>()
const removedClassTokens = new Map<HTMLElement, Set<string>>()

/** Kebab-case CSS property for a spacing axis (`"pt"` → `"padding-top"`). */
function axisCssProp(axis: string): string | undefined {
  const prop = AXIS_STYLE_PROP[axis]
  return prop?.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)
}

/** Apply one optimistic spacing value as a dev-only inline style. Shared by the
 *  live nudge preview and the post-reload batch reconcile so both write the same
 *  CSS property from the same axis map. Returns false when the axis is unknown. */
function setAxisStyle(
  el: HTMLElement,
  axis: string,
  valueRem: number
): boolean {
  const cssProp = axisCssProp(axis)
  if (!cssProp) return false
  el.style.setProperty(cssProp, `${valueRem}rem`)
  const props = appliedStyles.get(el) ?? new Set<string>()
  props.add(cssProp)
  appliedStyles.set(el, props)
  return true
}

/** Remove every optimistic inline style this layer has applied and forget them,
 *  so the next reconcile starts from the committed render. Called at the top of a
 *  batch reconcile so re-posting a reduced batch (undo/redo) drops stale styles. */
function clearAppliedStyles(): void {
  for (const [el, props] of appliedStyles) {
    for (const prop of props) el.style.removeProperty(prop)
  }
  appliedStyles.clear()
  for (const [el, tokens] of removedClassTokens)
    for (const token of tokens) el.classList.add(token)
  removedClassTokens.clear()
}

export function SliceTargetLayer({
  entries,
  targets,
  onSelectionChange,
  typographyRevision,
}: {
  entries: TargetEntry[]
  targets: TweakTargetMetadata[]
  onSelectionChange?(selected: boolean): void
  typographyRevision?: string
}) {
  const latest = useRef({ entries, targets, onSelectionChange })
  const revalidate = useRef<() => void>(() => {})
  useLayoutEffect(() => {
    latest.current = { entries, targets, onSelectionChange }
  }, [entries, targets, onSelectionChange])
  const lastPath = useRef<string | null>(null)
  const selectedPath = useRef<string | null>(null)
  const selectedEl = useRef<Element | null>(null)
  useEffect(() => {
    let live = true
    let refreshRaf = 0
    function targetFor(loc: string) {
      return latest.current.targets.find((target) => target.loc === loc)
    }
    function canonicalPath(path: string) {
      return path.replace(/\[(\d+)\]/g, ".$1")
    }
    function entryFor(path: string) {
      return latest.current.entries.find(
        (entry) => canonicalPath(entry.path) === canonicalPath(path)
      )
    }
    function post(message: Record<string, unknown>) {
      postSimMessage(message)
    }

    function locElement(el: Element | null): HTMLElement | null {
      const located = el?.closest<HTMLElement>("[data-tweak-loc]") ?? null
      const target = located?.dataset.tweakLoc
        ? targetFor(located.dataset.tweakLoc)
        : undefined
      return target && located?.dataset.tweakSource === target.sourceHash
        ? located
        : null
    }

    function elementsForLoc(loc: string): HTMLElement[] {
      return [
        ...document.querySelectorAll<HTMLElement>("[data-tweak-loc]"),
      ].filter(
        (element) =>
          element.dataset.tweakLoc === loc && locElement(element) === element
      )
    }

    function resolveLoc(hit: Element | null) {
      const el = locElement(hit)
      const loc = el?.dataset.tweakLoc
      const target = loc ? targetFor(loc) : undefined
      if (!el || !loc || !target) return null
      const stamped = hit?.closest<HTMLElement>(
        "[data-tweak-path],[data-sim-field]"
      )
      const path = stamped?.dataset.tweakPath ?? stamped?.dataset.simField
      const entry = path ? entryFor(path) : undefined
      const content =
        entry && findElementForEntry(entry) === stamped ? entry : undefined
      return {
        el,
        target,
        path: content?.path ?? loc,
        label: content?.fieldLabel ?? `<${target.tag}>`,
        text: content?.text ?? "",
      }
    }

    function postLocTarget(
      type: string,
      resolved: {
        el: HTMLElement
        target: TweakTargetMetadata
        path: string
        label: string
        text: string
      },
      advisory = false
    ) {
      if (
        !advisory &&
        (type === "target-select" || type === "target-refresh")
      ) {
        selectedPath.current = resolved.path
        selectedEl.current = resolved.el
        latest.current.onSelectionChange?.(true)
      }
      const className = resolved.el.getAttribute("class") ?? ""
      const { rect, metrics } = measureTarget(resolved.el)
      post({
        type,
        path: resolved.path,
        label: resolved.label,
        text: resolved.text,
        rect,
        metrics,
        className,
        classAnchor: classAnchorVerdict(className),
        role: elementRole(resolved.el),
        parentLoc:
          resolved.el.parentElement?.closest<HTMLElement>("[data-tweak-loc]")
            ?.dataset.tweakLoc ?? null,
        isList:
          !resolved.target.templateWide &&
          Array.from(resolved.el.children).some((child) => {
            const childLoc = (child as HTMLElement).dataset.tweakLoc
            return childLoc ? targetFor(childLoc)?.templateWide === true : false
          }),
        ...resolved.target,
        headingLevel: /^h[1-6]$/.test(resolved.el.localName)
          ? Number(resolved.el.localName.slice(1))
          : undefined,
      })
    }

    function resolvePath(path: string) {
      const target = targetFor(path)
      if (target) return resolveLoc(elementsForLoc(path)[0] ?? null)
      const entry = entryFor(path)
      const el = entry ? findElementForEntry(entry) : null
      const anchor = locElement(el)
      const metadata = anchor?.dataset.tweakLoc
        ? targetFor(anchor.dataset.tweakLoc)
        : undefined
      return entry && anchor && metadata
        ? {
            el: anchor,
            target: metadata,
            path: entry.path,
            label: entry.fieldLabel,
            text: entry.text,
          }
        : null
    }
    function refreshSelection() {
      if (refreshRaf) cancelAnimationFrame(refreshRaf)
      refreshRaf = requestAnimationFrame(() => {
        refreshRaf = 0
        if (!live) return
        const bridge = currentSimBridge(window)
        const controlled = !!bridge?.readTargetPath
        const path = controlled
          ? bridge!.readTargetPath!()
          : selectedPath.current
        if (!path) return
        const resolved = resolvePath(path)
        if (resolved) postLocTarget("target-refresh", resolved, controlled)
        else if (!controlled || entryFor(path) || targetFor(path))
          post({ type: "target-hidden", path })
        else
          post({
            type: "target-missing",
            path,
            appliedRevision: bridge?.appliedRevision,
          })
      })
    }
    revalidate.current = refreshSelection

    // Nested stamps describe the same field; only the unique innermost one
    // is its identity. Independent duplicate branches remain ambiguous.
    function findElementForEntry(entry: TargetEntry): HTMLElement | null {
      const bound = [
        ...document.querySelectorAll<HTMLElement>(
          "[data-tweak-path],[data-sim-field]"
        ),
      ].filter(
        (element) =>
          canonicalPath(
            element.dataset.tweakPath ?? element.dataset.simField ?? ""
          ) === canonicalPath(entry.path)
      )
      const innermost = bound.filter(
        (element) =>
          !bound.some((other) => other !== element && element.contains(other))
      )
      return innermost.length === 1 && locElement(innermost[0])
        ? innermost[0]
        : null
    }

    let raf = 0
    function onMove(event: MouseEvent) {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        const hit = resolveLoc(
          document.elementFromPoint(event.clientX, event.clientY)
        )
        if (!hit) {
          if (lastPath.current !== null) {
            lastPath.current = null
            post({ type: "target-out" })
          }
          return
        }
        const hoverIdentity = `${hit.target.loc}\0${hit.path}`
        if (hoverIdentity === lastPath.current) return
        lastPath.current = hoverIdentity
        postLocTarget("target-hover", hit)
      })
    }

    function onLeave() {
      lastPath.current = null
      post({ type: "target-out" })
    }

    function onClick(event: MouseEvent) {
      // The preview is a picker, not a live page. Make EVERY click inert up
      // front — before resolving a target — so a click on a link/button whose
      // text isn't a content leaf (or a click during the post-reload window
      // before a target resolves) can never navigate the iframe away (P0
      // click-through). A belt-and-suspenders capture-phase blocker is also
      // installed pre-hydration in the bare route; this covers the hydrated case
      // and stops the slice's own click handlers from firing on a pick.
      if (document.documentElement.dataset.simMode === "preview") return
      if (
        event.target instanceof Element &&
        event.target.closest("[data-preview-inline-editor]")
      )
        return
      event.preventDefault()
      if (!(
        event.target instanceof Element &&
        event.target.closest("[data-sim-field]")
      ))
        event.stopPropagation()
      // Clicks already identify their DOM target. Keyboard/selector clicks can
      // have zero coordinates, so re-hit-testing would pick an unrelated node.
      const hit = resolveLoc(
        event.target instanceof Element ? event.target : null
      )
      if (!hit) {
        // Click away from any content leaf clears the selection.
        selectedPath.current = null
        selectedEl.current = null
        latest.current.onSelectionChange?.(false)
        post({ type: "target-clear" })
        return
      }
      postLocTarget("target-select", hit)
    }

    function onKey(event: KeyboardEvent) {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        (event.target instanceof Element &&
          event.target.closest("[data-preview-inline-editor]"))
      )
        return
      selectedPath.current = null
      selectedEl.current = null
      latest.current.onSelectionChange?.(false)
      post({ type: "target-clear" })
    }

    // Reverse channel from the brief panel's part index (via the parent frame):
    // resolve the requested field path to an element and reply on the same
    // hover/select channels. `path: null` clears the highlight.
    function onMessage(event: MessageEvent) {
      // The parent frame is same-origin by design (the iframe just embeds the
      // sim route) — refuse anything else before even looking at `data`.
      const bridge = currentSimBridge(window)
      if (
        !simMessageMatches(event, window.location.origin, window.parent, bridge)
      )
        return
      if (event.data.revision <= bridge!.acceptedParentRevision) return
      bridge!.acceptedParentRevision = event.data.revision
      const data = event.data
      if (
        !data ||
        typeof data !== "object" ||
        data.source !== "formulacms-sim"
      ) {
        return
      }

      // Optimistic spacing preview: apply the nudged value as an inline style on
      // the selected element, instantly, without a write or reload. Dev-only,
      // in-iframe, never persisted (ADR-0030 addendum).
      if (data.type === "preview-style") {
        const loc = typeof data.loc === "string" ? data.loc : ""
        const target = targetFor(loc)
        if (!target || data.sourceHash !== target.sourceHash) return
        const active =
          data.scope === "all" ||
          (data.scope === "below-sm" && window.innerWidth < 640) ||
          (data.scope === "sm-and-up" && window.innerWidth >= 640)
        const elements = active ? elementsForLoc(loc) : []
        let applied = false
        if (typeof data.valueRem === "number") {
          for (const element of elements) {
            applied =
              setAxisStyle(element, data.axis as string, data.valueRem) ||
              applied
          }
        }
        if (applied) {
          // Re-measure on the next frame so the parent highlight ring tracks
          // the resized element. Without this the ring stays anchored to the
          // pre-nudge rect and reads as detached from the target while the
          // designer is nudging.
          refreshSelection()
        }
        return
      }

      // Batch reconcile after a reload (Items 2+3): the parent re-posts the
      // whole unsaved batch so the optimistic inline styles are restored on the
      // fresh document — otherwise the save bar's count and the render diverge
      // (finding 2). Each edit is resolved by field path (not the current
      // selection), so multi-element batches come back intact. Unresolvable
      // targets are reported so the parent can warn instead of silently losing
      // the visual.
      if (data.type === "reapply-styles") {
        // Clear the previously-applied batch first so this is idempotent: a
        // reduced batch (undo/redo dropping an axis) removes the styles it no
        // longer contains, instead of leaving the old value behind. No-op on a
        // freshly-reloaded document (nothing recorded yet), so the reload
        // reconcile + `missing` semantics (Items 2+3) are unchanged.
        clearAppliedStyles()
        const edits = Array.isArray(data.edits) ? data.edits : []
        let missing = 0
        for (const edit of edits) {
          if (
            !edit ||
            typeof edit.loc !== "string" ||
            typeof edit.axis !== "string" ||
            typeof edit.valueRem !== "number"
          ) {
            continue
          }
          const active =
            edit.scope === "all" ||
            (edit.scope === "below-sm" && window.innerWidth < 640) ||
            (edit.scope === "sm-and-up" && window.innerWidth >= 640)
          if (!active && !edit.remove) continue
          const target = targetFor(edit.loc)
          if (!target || edit.sourceHash !== target.sourceHash) {
            missing += 1
            continue
          }
          const elements = elementsForLoc(edit.loc)
          if (edit.remove) {
            if (
              typeof edit.expected !== "string" ||
              !target.sourceClassTokens.includes(edit.expected) ||
              elements.length === 0
            ) {
              missing += 1
              continue
            }
            for (const element of elements) {
              element.classList.remove(edit.expected)
              const removed =
                removedClassTokens.get(element) ?? new Set<string>()
              removed.add(edit.expected)
              removedClassTokens.set(element, removed)
            }
            continue // CSS fallback owns the result; never synthesize an inline zero.
          }
          if (
            elements.length === 0 ||
            !elements.every((el) => setAxisStyle(el, edit.axis, edit.valueRem))
          ) {
            missing += 1
          }
        }
        post({ type: "reapply-result", missing })
        // Re-measure the current selection so the highlight ring + inspector
        // metrics track the reverted box after an undo/redo cleared a style —
        // otherwise the fallback would read stale metrics and show the old value.
        refreshSelection()
        return
      }

      // The parent acknowledges our readiness handshake — stop re-announcing.
      if (data.type === "layer-ack") {
        return
      }

      const isHighlight = data.type === "highlight-path"
      const isSelect = data.type === "select-path"
      const isRestore = data.type === "restore-path"
      if (!isHighlight && !isSelect && !isRestore) return
      const controlled = !!bridge?.readTargetPath
      const advisory = isRestore || (isSelect && controlled)
      const path =
        advisory && controlled
          ? bridge!.readTargetPath!()
          : typeof data.path === "string"
            ? data.path
            : null
      if (!path) {
        if (advisory) return
        if (isHighlight) post({ type: "target-out" })
        if (isSelect) {
          selectedPath.current = null
          selectedEl.current = null
          latest.current.onSelectionChange?.(false)
          post({ type: "target-clear" })
        }
        return
      }
      const resolved = resolvePath(path)
      if (resolved) {
        postLocTarget(
          isHighlight
            ? "target-hover"
            : advisory
              ? "target-refresh"
              : "target-select",
          resolved,
          advisory
        )
      } else if (isHighlight) post({ type: "target-out" })
      else if (advisory && (entryFor(path) || targetFor(path)))
        post({ type: "target-hidden", path })
      else {
        if (!advisory) {
          selectedPath.current = path
          selectedEl.current = null
        }
        post({
          type: "target-missing",
          path,
          appliedRevision: bridge!.appliedRevision,
        })
      }
    }

    document.addEventListener("mousemove", onMove, true)
    document.addEventListener("mouseleave", onLeave)
    document.addEventListener("click", onClick, true)
    document.addEventListener("keydown", onKey)
    window.addEventListener("message", onMessage)
    window.addEventListener("resize", refreshSelection)
    // Announce that targeting is live (listeners attached, `pathMap` built) so
    // the parent can (re)apply the pending batch onto this fresh document and
    // re-measure the selection. Fires on every mount — first load, Fast Refresh,
    // post-Save HMR reload — which is exactly when the reconcile (Items 2+3) and
    // re-measure (4b) must run.
    //
    // Readiness belongs exclusively to the installed native frame bridge.
    return () => {
      live = false
      if (refreshRaf) cancelAnimationFrame(refreshRaf)
      revalidate.current = () => {}
      if (raf) cancelAnimationFrame(raf)
      document.removeEventListener("mousemove", onMove, true)
      document.removeEventListener("mouseleave", onLeave)
      document.removeEventListener("click", onClick, true)
      document.removeEventListener("keydown", onKey)
      window.removeEventListener("message", onMessage)
      window.removeEventListener("resize", refreshSelection)
    }
  }, [])
  useEffect(() => {
    revalidate.current()
  }, [entries, targets, typographyRevision])

  return null
}

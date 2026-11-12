"use client"

import { useEffect, useState, type RefObject } from "react"

/**
 * Track an element's rendered width via `ResizeObserver`.
 *
 * The workbench measures available width in three places — the canvas render
 * pane, the source reference pane, and the preview's fit-to-width scaler — and
 * each had its own copy of the same observe/disconnect effect. One hook so the
 * measurement (and its cleanup) has a single definition.
 *
 * `fallback` is the width reported before the first measurement, and whenever
 * the ref is empty. The measured value is reported as-is — a container that is
 * genuinely zero-width reads as `0`, which callers rely on to distinguish
 * "not laid out" from "narrow"; apply any floor at the point of use.
 */
export function useElementWidth(
  ref: RefObject<HTMLElement | null>,
  fallback: number
): number {
  const [width, setWidth] = useState(fallback)

  useEffect(() => {
    const node = ref.current
    if (!node) return

    function updateWidth() {
      const node = ref.current
      if (node) setWidth(node.clientWidth)
    }

    updateWidth()
    const observer = new ResizeObserver(updateWidth)
    observer.observe(node)
    return () => observer.disconnect()
  }, [ref])

  return width
}

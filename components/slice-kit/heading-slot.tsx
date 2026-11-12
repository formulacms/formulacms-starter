import { createElement, type HTMLAttributes } from "react"

/** A single native heading host, safe to import from client islands. */
export function HeadingSlot({
  level,
  ...props
}: HTMLAttributes<HTMLHeadingElement> & { level: number }) {
  const bounded = Number.isFinite(level)
    ? Math.max(1, Math.min(6, Math.trunc(level)))
    : 2
  return createElement(`h${bounded}`, props)
}

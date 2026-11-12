import { clsx, type ClassValue } from "clsx"
import { mergeTailwindClasses } from "@/lib/design-system/tw-merge"

export function cn(...inputs: ClassValue[]) {
  return mergeTailwindClasses(clsx(inputs))
}

/**
 * Move the element at `index` by `dir` (-1 up / +1 down) and renumber each
 * element's `order` to match its new array position. Returns the original
 * array unchanged if the move would fall out of bounds. Used by the menu
 * editor's up/down reorder controls (no drag dependency).
 */
export function moveAndReindex<T extends { order: number }>(
  arr: T[],
  index: number,
  dir: -1 | 1
): T[] {
  const target = index + dir
  if (target < 0 || target >= arr.length) return arr
  const next = [...arr]
  ;[next[index], next[target]] = [next[target], next[index]]
  return next.map((item, i) => ({ ...item, order: i }))
}

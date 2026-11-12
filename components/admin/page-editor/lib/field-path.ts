import { parseFieldPath } from "@/components/slice-kit/field-path"

/** Preserve the admin's permissive parser import while sharing its pure implementation. */
export { parseFieldPath } from "@/components/slice-kit/field-path"

export function setValueAtFieldPath(
  source: unknown,
  path: string[],
  value: unknown
): unknown {
  if (path.length === 0) return value
  const [head, ...rest] = path
  if (head === "__proto__" || head === "constructor" || head === "prototype") {
    return source
  }
  if (Array.isArray(source)) {
    const index = Number(head)
    if (!Number.isInteger(index) || index < 0) return source
    const next = [...source]
    next[index] = setValueAtFieldPath(next[index], rest, value)
    return next
  }
  const record =
    source && typeof source === "object"
      ? (source as Record<string, unknown>)
      : {}
  return {
    ...record,
    [head]: setValueAtFieldPath(record[head], rest, value),
  }
}

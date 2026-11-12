/**
 * Shared pure field-path parser. The admin editor re-exports this function for
 * compatibility; the public slice kit imports it without crossing an
 * admin-only module boundary.
 */
export function parseFieldPath(path: string): string[] {
  if (!path) return []
  const segments: string[] = []
  let current = ""
  const pushCurrent = () => {
    if (current.length > 0) {
      segments.push(current)
      current = ""
    }
  }
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]
    if (ch === ".") {
      pushCurrent()
    } else if (ch === "[") {
      pushCurrent()
      const end = path.indexOf("]", i)
      if (end === -1) return segments
      segments.push(path.slice(i + 1, end))
      i = end
    } else {
      current += ch
    }
  }
  pushCurrent()
  return segments
}

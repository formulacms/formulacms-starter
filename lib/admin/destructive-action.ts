export type DestructiveActionCopy = {
  intro: string
  losses?: readonly string[]
  warnings?: readonly string[]
  blockers?: readonly string[]
  irreversible?: boolean
  safeNote?: string
}

function sentenceList(label: string, items: readonly string[]): string {
  if (items.length === 0) return ""
  return `${label}: ${items.filter(Boolean).join("; ")}.`
}

export function pluralize(
  count: number,
  singular: string,
  plural = `${singular}s`
): string {
  return `${count} ${count === 1 ? singular : plural}`
}

export function formatList(items: readonly string[], limit = 3): string {
  const visible = items.slice(0, limit)
  const more = items.length - visible.length
  return more > 0
    ? `${visible.join(", ")} and ${more} more`
    : visible.join(", ")
}

export function destructiveActionDescription({
  intro,
  losses = [],
  warnings = [],
  blockers = [],
  irreversible,
  safeNote,
}: DestructiveActionCopy): string {
  return [
    intro,
    sentenceList("Will be lost", losses),
    sentenceList("Warnings", warnings),
    sentenceList("Blocked by", blockers),
    irreversible ? "This cannot be undone." : "",
    safeNote ?? "",
  ]
    .filter(Boolean)
    .join(" ")
}

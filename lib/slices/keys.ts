// Stable React keys for slice list items.
//
// Slice lists are `v.array(item)` (ADR-0008 `list()` primitive) — items carry
// no stored identity, so renderers historically keyed them by array index.
// That is wrong in two ways that bite in the editor's live preview, where the
// same list re-renders as an editor reorders it:
//
//   1. React reuses DOM nodes by position, so a reorder moves content between
//      already-mounted nodes instead of moving the nodes.
//   2. Worse, anything that addresses an item by that key inherits the bug.
//      The FAQ slices bound Radix `AccordionItem value` to `item-${index}`,
//      which pinned "which panel is open" to a *position*: reorder the items
//      and the wrong answer stayed expanded.
//
// The fix is to derive the key from the item's content, so the key travels
// with the item. This mirrors the existing button-key logic in
// `components/slices/render-helpers.tsx`: prefer real identity, disambiguate
// collisions, and fall back to position only when there is nothing else.
//
// This is a pragmatic fix, not the ideal one. React steers toward identity
// assigned at creation time; content-derived keys change when the content
// changes (editing a question remounts its accordion item, resetting its open
// state — a blink in live preview, harmless on the public site). The clean
// version is an additive optional `_key` on list items with this function as
// the fallback, which needs no backfill. Worth doing if slice items ever need
// durable identity (per-item comments, analytics, permissions); not worth a
// schema migration on its own today.

/**
 * Derive stable, unique React keys for a list of slice items.
 *
 * @param items    the list being rendered
 * @param identify pulls the item's natural identity (a question, title, name).
 *                 Return `undefined` when the item has none.
 *
 * Keys follow their item across a reorder. Items sharing an identity stay
 * unique via an occurrence suffix. Items with no identity at all fall back to
 * position — unavoidable without stored ids, and stable for a fixed list.
 */
export function stableItemKeys<T>(
  items: readonly T[],
  identify: (item: T, index: number) => string | null | undefined
): string[] {
  const seen = new Map<string, number>()

  return items.map((item, index) => {
    const itemId =
      item &&
      typeof item === "object" &&
      "itemId" in item &&
      typeof item.itemId === "string"
        ? item.itemId.trim()
        : ""
    const identity = itemId ? `itemId:${itemId}` : identify(item, index)?.trim()
    // No identity to derive from — position is the only thing left.
    const base = identity && identity.length > 0 ? identity : `@${index}`
    const occurrence = seen.get(base) ?? 0
    seen.set(base, occurrence + 1)
    // First occurrence keeps the clean key so the common case stays readable.
    return occurrence === 0 ? base : `${base}~${occurrence}`
  })
}

/** Prefer durable row identity; use editor-owned ephemeral keys for missing or duplicate IDs. */
export function listItemKeys<T>(
  items: readonly T[],
  fallbackKeys: readonly string[]
): string[] {
  const seen = new Set<string>()
  return items.map((item, index) => {
    const id =
      item &&
      typeof item === "object" &&
      !Array.isArray(item) &&
      "itemId" in item &&
      typeof item.itemId === "string"
        ? item.itemId.trim()
        : ""
    if (id && !seen.has(id)) {
      seen.add(id)
      return `itemId:${id}`
    }
    return fallbackKeys[index] ?? `@${index}`
  })
}

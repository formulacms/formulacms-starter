/**
 * Client-safe capability checks for the contextual visual tweak editor (ADR-0030).
 *
 * The toolbar runs in the browser and only has the clicked element's field
 * `path` (from the target layer) and its class list — not the renderer source.
 * These pure predicates let the editor decide, before any server round-trip,
 * which controls to enable: spacing edits need a *surgically anchorable* path
 * (the write layer refuses list items and dynamic classNames), and typography
 * edits need a known design-system role token on the element.
 */

/** Typography role tokens defined in `app/globals.css` (`--text-<role>`), whose
 *  line-height / font-size the editor can move site-wide. */
export const TYPOGRAPHY_ROLES = [
  "display",
  "title",
  "heading",
  "lead",
  "body",
  "caption",
] as const

export type TypographyRole = (typeof TYPOGRAPHY_ROLES)[number]

/**
 * The zero-based card index a list-item path addresses (`items[2]` → `2`), or
 * `null` when the path isn't a single list item. Sole owner of the `items[i]`
 * path convention: the editability predicate, the write-scope wording, the
 * hover badge and the source-side variant resolver all read it from here, so
 * the shape is defined once rather than re-matched per layer.
 */
export function parseListItemIndex(path: string): number | null {
  const match = /^items\[(\d+)\]$/.exec(path)
  return match ? Number(match[1]) : null
}

/**
 * Whether a spacing axis may go negative. Margins can (`-mt-4`); padding and
 * gap can't — Tailwind has no `-p-*`/`-gap-*`, so a negative there clamps to 0.
 * The single statement of that policy: the toolbar input, the tweak hook and
 * the utility writer all defer to it instead of re-deriving the first-letter
 * rule, so a future axis with different sign rules is taught once.
 */
export function canAxisGoNegative(axis: string): boolean {
  return axis.startsWith("m")
}

/**
 * Whether a target `path` can take a spacing (className) edit. Directly
 * anchorable paths: the whole slice (`""`), the primary content group
 * (`primary`), and primary leaves (`primary.<field>`). A specific card
 * (`items[i]`) is editable too (Item 7, option D) via a structural variant on the
 * static grid parent — see `resolveListItemSpacing`.
 *
 * Still excluded: deeper list leaves (`items[i].<field>` — a button inside a
 * card), which sit in the card's dynamic className with no static direct-child
 * anchor and are refused by the legacy editor. The bare list (`items` → all-cards
 * `*:`) is supported by the write layer but gated OFF the UI until the cascade
 * spike confirms `*:` overrides each card's own `p-8` (Item 7 follow-up).
 */
export function isSpacingEditablePath(path: string): boolean {
  return (
    path === "" ||
    path === "primary" ||
    /^primary\.[A-Za-z_$][\w$]*$/.test(path) ||
    parseListItemIndex(path) !== null
  )
}

/**
 * Plain-language statement of the write scope for a list-item spacing edit,
 * shown in the inspector before Save so the designer knows the edit lands on the
 * card via an `[&>:nth-child(n)]:` variant on the list's parent (option D).
 * `null` for non-list paths (a normal element edits itself — no scope caveat).
 */
export function describeSpacingScope(path: string): string | null {
  const index = parseListItemIndex(path)
  if (index === null) return null
  return `Applies to card ${index + 1} only — written on the list's parent as an nth-child rule.`
}

/**
 * The design-system role an element carries, read from its `text-<role>` utility
 * (e.g. `text-display` → `display`), or `null` when it carries none — in which
 * case typography token editing is unavailable for that element.
 */
export function roleFromClassName(className: string): TypographyRole | null {
  for (const role of TYPOGRAPHY_ROLES) {
    if (new RegExp(`(?<![\\w-])text-${role}(?![\\w-])`).test(className)) {
      return role
    }
  }
  return null
}

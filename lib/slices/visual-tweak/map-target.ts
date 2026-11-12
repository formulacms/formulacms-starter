/**
 * Map a click target (a content field path from the slice-sim target layer) to
 * the `className` string it should edit in the renderer source (ADR-0030, the
 * spacing/target-A half). This is the "make-or-break unknown" the ADR calls out:
 * a clicked element carries no `data-*` anchor (the source must stay clean), so
 * we bridge path → source structurally.
 *
 * The target layer emits these path shapes (see `slice-target-layer.tsx`):
 *
 * - **`""` (whole slice):** the renderer's root JSX element. A designer editing
 *   "the section's outer padding" means the root `<section>`, which is also
 *   where the padding utility lives. The read side resolves the same element
 *   (via the `[data-slice-preview-root]` anchor), so highlight, metrics and
 *   patch all agree on the root.
 * - **`primary` (the content group):** the element that wraps every
 *   `{primary.*}` leaf — resolved as their lowest common ancestor in the JSX
 *   tree (e.g. hero-agency's `gap-4` flex `<div>`).
 * - **`primary.<field>`:** the element that directly wraps `{primary.<field>}`.
 * - **`items[i]` / `items[i].<field>` (UNSUPPORTED):** list items render through
 *   a `.map((local, i) => …)` callback, so the item path (`items[0].name`) never
 *   appears literally in source (it's `{tier.name}`), and item containers use a
 *   dynamic `className={cn(…)}`. Patching either would fight the clean-diff bar,
 *   so these paths are refused (throw) rather than mis-edited — ADR-0030's
 *   "restrict spacing edits to anchorable elements".
 *
 * For spacing specifically, `resolveSpacingSpan` adds the ADR's "nearest
 * ancestor owning the axis" rule: a *container* tweak walks self→ancestors to
 * the element that actually carries the axis utility (so nudging the section's
 * padding lands on the `<section>`, not the inner content div the reader
 * highlighted). Leaf tweaks stay on the leaf's own element.
 *
 * We deliberately avoid a full JSX AST for the common substring cases (`""`,
 * `primary.<field>`), and use the lightweight `jsx-tree` scanner only where the
 * element nesting is genuinely needed (`primary` LCA, ancestor walk).
 */

import { parseListItemIndex } from "./capabilities"
import {
  buildJsxTree,
  elementAt,
  lowestCommonAncestor,
  rootNode,
  selfAndAncestors,
  type JsxNode,
} from "./jsx-tree"

export interface ClassNameSpan {
  /** Index of the first character *inside* the className quotes. */
  start: number
  /** Index one past the last character inside the className quotes. */
  end: number
  /** Current className string (the text between the quotes). */
  className: string
}

/** Spacing axes the editor can nudge. Each maps to the Tailwind utility prefix
 *  whose value we replace on the targeted element. Shared here (rather than in
 *  `write.ts`) so both the resolver and the patcher agree on axis detection
 *  without an import cycle. A runtime tuple (not just a type) so the server
 *  actions can validate an axis coming off the network, not just the compiler. */
export const SPACING_AXES = [
  "p",
  "px",
  "py",
  "pt",
  "pr",
  "pb",
  "pl",
  "m",
  "mx",
  "my",
  "mt",
  "mr",
  "mb",
  "ml",
  "gap",
  "gap-x",
  "gap-y",
] as const

export type SpacingAxis = (typeof SPACING_AXES)[number]

/** Match a single utility on `axis` within a className, e.g. `py-section`,
 *  `gap-4`, `py-[5rem]`, and the negative-margin form `-mt-4` (leading dash
 *  captured in group 1). The optional `(-)?` sign is part of the utility; a
 *  className's sign dash always sits at a word boundary (start / space), so
 *  leftmost-match starts the match ON the dash and captures it — a positive
 *  `axisUtilityRegExp("mt")` therefore reads `-mt-4` as the negative it is,
 *  never as a bare `mt-4` at the later `m`. The negative lookbehind stops
 *  `p`/`py`/… matching inside `px`/`py`/`pt`/… (those have a letter after `p`)
 *  and stops a variant-prefixed utility (`sm:py-8`) matching as bare `py`. The
 *  negative lookahead stops `gap` matching the `gap-x`/`gap-y` prefix inside
 *  `gap-x-4`. Because every axis regex requires the exact axis letters bounded
 *  on both sides, the per-side axes stay mutually exclusive: `mt-` only matches
 *  `mt-`, never `m-`/`mr-`/… (and `-mt-4` carries no bare `m-` substring).
 *
 *  The `-` in the lookbehind (`[\\w:-]`) is the Item 8 hardening: a prefixed
 *  negative utility (`sm:-mt-6`, `*:-mt-6`, `[&>:nth-child(1)]:-mt-6`) starts
 *  its sign dash after a `:`, so the leading-dash attempt fails the lookbehind —
 *  and WITHOUT the `-` here the engine would retry at the bare `mt` (preceded by
 *  the `-`) and wrongly match the negative's magnitude as a positive bare
 *  utility, letting a base edit corrupt a responsive/variant value. Excluding a
 *  preceding `-` refuses that interior match; a genuine bare negative
 *  (`… -mt-4`, dash after a space/start) still matches ON its dash, unchanged. */
export function axisUtilityRegExp(axis: SpacingAxis): RegExp {
  return new RegExp(
    `(?<![\\w:-])(-)?${axis}-(?:\\[[^\\]]+\\]|[\\w.]+)(?![\\w-])`
  )
}

/** Whether a className already carries a utility for `axis`. */
export function hasAxisUtility(className: string, axis: SpacingAxis): boolean {
  return axisUtilityRegExp(axis).test(className)
}

/**
 * A structural child-variant that reaches the repeated children of a
 * statically-classed list container (option D, ADR-0030, Item 7). The cards
 * render through `slice.items.map(...)` with a dynamic `className={cn(...)}`, so
 * a card has no single-element anchor of its own; a Tailwind child-combinator
 * variant on the static grid parent edits it instead:
 *  - `all` → `*:`                (Tailwind `& > *` — every direct child)
 *  - `nth` → `[&>:nth-child(n)]:` (a specific 1-based direct child)
 *
 * `first:` / `last:` are deliberately NOT modelled: bare `first:pt-4` styles the
 * grid itself when *it* is a first-child, not the grid's first child. Reaching a
 * card always needs the `>` child combinator, i.e. `[&>:nth-child(n)]:`.
 */
export type ChildVariant = { kind: "all" } | { kind: "nth"; n: number }

/** The Tailwind variant prefix (with its trailing `:`) for a child variant. */
export function childVariantPrefix(variant: ChildVariant): string {
  return variant.kind === "all" ? "*:" : `[&>:nth-child(${variant.n})]:`
}

/**
 * Match a variant-prefixed spacing utility (`[&>:nth-child(1)]:pt-4`, `*:-mt-6`)
 * on `axis` under `variant`. A deliberately SEPARATE matcher from
 * `axisUtilityRegExp` (Item 7 must NOT relax that regex's `:`-in-lookbehind
 * hardening): the exact prefix is required literally, so a variant utility never
 * cross-matches the bare axis, a different variant, or a sibling card — and the
 * bare regex still refuses a variant-prefixed utility (the `sm:py-8` guard). The
 * sign `(-)?` sits AFTER the prefix, matching Tailwind's `*:-mt-6` negative form.
 */
export function variantAxisUtilityRegExp(
  variant: ChildVariant,
  axis: SpacingAxis
): RegExp {
  const prefix = escapeRegExp(childVariantPrefix(variant))
  return new RegExp(
    `(?<![\\w:])${prefix}(-)?${axis}-(?:\\[[^\\]]+\\]|[\\w.]+)(?![\\w-])`
  )
}

/**
 * Responsive scopes a spacing edit can be pinned to (Item 8, viewport honesty).
 * Only `sm` is modelled — the slice-sim Mobile tab (a 390px frame) is the sole
 * producer. A runtime tuple (not just a type) so the server action can validate
 * a viewport coming off the network. The `md`/`lg` hedge is deliberately NOT
 * built — YAGNI until a wider viewport tab exists.
 *
 * IMPORTANT — this emits a **max-width** variant, not the min-width `sm:`.
 * Tailwind is mobile-first: `sm:` means `min-width:640px` = "640px and UP", which
 * would MISS the 390px mobile frame and HIT the 1280px desktop — the exact
 * cross-viewport mutation Item 8 exists to kill (verified in-browser: a saved
 * `sm:pt-1.5` showed nothing at 390 and shifted desktop). To isolate the small
 * end you need `max-sm:` (`@media (max-width:639px)`): it applies on the phone
 * and leaves desktop's base utility alone. So `sm` (the scope id) → `max-sm:`
 * (the emitted variant). Desktop edits stay on the base utility.
 */
export const RESPONSIVE_BREAKPOINTS = ["sm"] as const

export type ResponsiveBreakpoint = (typeof RESPONSIVE_BREAKPOINTS)[number]

/** The Tailwind variant prefix (with trailing `:`) emitted for a scope — a
 *  max-width variant so the edit targets the small end only (see above). */
const RESPONSIVE_VARIANT_PREFIX: Record<ResponsiveBreakpoint, string> = {
  sm: "max-sm:",
}

/** The emitted variant prefix (`max-sm:`) for a responsive scope. */
export function responsiveVariantPrefix(
  breakpoint: ResponsiveBreakpoint
): string {
  return RESPONSIVE_VARIANT_PREFIX[breakpoint]
}

/** Whether a string is a supported responsive breakpoint (network boundary). */
export function isResponsiveBreakpoint(
  value: string
): value is ResponsiveBreakpoint {
  return (RESPONSIVE_BREAKPOINTS as readonly string[]).includes(value)
}

/**
 * Match a responsive-prefixed spacing utility (`max-sm:pt-4`, `max-sm:-mt-6`) on
 * `axis` at `breakpoint`. A deliberately SEPARATE matcher from `axisUtilityRegExp`
 * (Item 8 must NOT relax that regex's `:`-in-lookbehind hardening): the exact
 * `max-sm:` prefix is required literally, so a responsive utility never
 * cross-matches the bare axis, and the bare regex still refuses a
 * responsive-prefixed utility. The `(?<![\\w:])` lookbehind before the prefix
 * also excludes a combined variant+responsive form (`[&>:nth-child(1)]:max-sm:pt-4`,
 * whose prefix is preceded by `:`) — that combo is out of scope for Item 8. The
 * sign `(-)?` sits AFTER the prefix, matching Tailwind's `max-sm:-mt-6` negative
 * form.
 */
export function responsiveAxisUtilityRegExp(
  breakpoint: ResponsiveBreakpoint,
  axis: SpacingAxis
): RegExp {
  const prefix = escapeRegExp(responsiveVariantPrefix(breakpoint))
  return new RegExp(
    `(?<![\\w:])${prefix}(-)?${axis}-(?:\\[[^\\]]+\\]|[\\w.]+)(?![\\w-])`
  )
}

/**
 * A content path a structural-variant spacing edit can target: the whole list
 * (`items`) or one card (`items[i]`). Deeper leaves (`items[i].field`) are
 * excluded — they sit inside the card's dynamic className and have no static
 * direct-child anchor, so the legacy editor refuses them instead.
 */
export function isListItemSpacingPath(path: string): boolean {
  return path === "items" || parseListItemIndex(path) !== null
}

export interface ListItemSpacingResolution {
  span: ClassNameSpan
  variant: ChildVariant
}

/**
 * Resolve a list path to the static grid parent's className span + the child
 * variant that reaches the intended card(s). The anchor is the element that
 * directly encloses the `items.map(...)` call — the cards' real DOM parent — so
 * a `>` child-combinator variant lands on the cards.
 *
 * Returns `null` (the caller skips the edit, never throws) when there is no items
 * map or the anchor's className is dynamic (`className={cn(...)}`): the parent
 * isn't a clean anchor, so we leave the file untouched rather than fight the
 * clean-diff bar. We deliberately do NOT walk up to a higher static ancestor —
 * the variant uses the direct-child combinator, so anchoring above the cards'
 * immediate parent would target the wrong elements.
 */
export function resolveListItemSpacing(
  source: string,
  path: string
): ListItemSpacingResolution | null {
  if (!isListItemSpacingPath(path)) return null
  const index = parseListItemIndex(path)
  const variant: ChildVariant =
    index === null ? { kind: "all" } : { kind: "nth", n: index + 1 }
  // `\bitems\.map\(` targets the items collection specifically — never a nested
  // `tier.features.map(` (no word boundary before `features`) or a `menuItems`.
  const mapMatch = /\bitems\.map\(/.exec(source)
  if (!mapMatch) return null
  const parent = elementAt(buildJsxTree(source), mapMatch.index)
  if (!parent) return null
  const span = classNameSpanOfNode(source, parent)
  return span ? { span, variant } : null
}

/** Locate the `className="…"` of the JSX open tag that starts at or after
 *  `fromTagStart`, returning the span of the quoted value. Only scans within the
 *  single open tag (up to its closing `>`), so it can't wander into a child.
 *  Returns `null` for a dynamic `className={…}` (or none) — the caller refuses
 *  rather than mangle an expression. */
function classNameSpanInTag(
  source: string,
  fromTagStart: number,
  tagEnd?: number
): ClassNameSpan | null {
  const end = tagEnd ?? source.indexOf(">", fromTagStart) + 1
  if (end <= fromTagStart) return null
  const tag = source.slice(fromTagStart, end)
  const match = /className="([^"]*)"/.exec(tag)
  if (!match) return null
  const valueStart = fromTagStart + match.index + 'className="'.length
  return {
    start: valueStart,
    end: valueStart + match[1].length,
    className: match[1],
  }
}

/** className span for a resolved JSX node's open tag (bounded by the node's own
 *  `tagEnd`, so an attribute expression can't be misread). */
function classNameSpanOfNode(
  source: string,
  node: JsxNode
): ClassNameSpan | null {
  return classNameSpanInTag(source, node.tagStart, node.tagEnd)
}

/** The renderer's root element: the first JSX open tag after `return (`. */
function rootClassNameSpan(source: string): ClassNameSpan | null {
  const returnIdx = source.indexOf("return (")
  const searchFrom = returnIdx === -1 ? 0 : returnIdx
  const tagStart = source.indexOf("<", searchFrom)
  if (tagStart === -1) return null
  return classNameSpanInTag(source, tagStart)
}

/** Byte offsets of every standalone `primary.<field>` reference in `source`,
 *  excluding a longer identifier (`primary.title` must not match inside
 *  `primary.titleId`). */
function fieldReferences(source: string, path: string): number[] {
  const re = new RegExp(`${escapeRegExp(path)}(?![\\w$])`, "g")
  const out: number[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(source))) out.push(m.index)
  return out
}

/** A reference is a conditional GUARD when the field is the *condition* deciding
 *  whether an element renders (`field && …`, `field || …`, `field ? … : …`),
 *  not the value that element renders. The guard lives in the *parent's* body,
 *  so it must never anchor a resolve — the element a spacing edit targets is the
 *  one INSIDE the guard. (`?.` optional-chaining is a value access, not a
 *  ternary, so it is NOT treated as a guard.) */
function isGuardReference(
  source: string,
  index: number,
  path: string
): boolean {
  const after = source.slice(index + path.length).replace(/^\s+/, "")
  return (
    after.startsWith("&&") ||
    after.startsWith("||") ||
    (after.startsWith("?") && !after.startsWith("?."))
  )
}

/**
 * Resolve a `primary.<field>` leaf to the className span of the element that
 * actually RENDERS it — the element wrapping the child expression
 * `{primary.field}` OR carrying it as an attribute value
 * (`value={primary.field}`).
 *
 * A field can appear more than once: as a render site AND as a conditional guard
 * (`{primary.description && ( … )}`). The guard reference sits in the *parent's*
 * body, so anchoring on it resolves the wrong element — the preceding sibling or
 * the container (the bug this replaces). We therefore drop guard references and
 * resolve the first real render site through the JSX tree (`elementAt`), which
 * maps both a child expression and an attribute value to their owning element —
 * unlike the old back-scan, which only handled a direct child expression and
 * mis-targeted attribute-rendered fields.
 */
function leafClassNameSpan(source: string, path: string): ClassNameSpan | null {
  const roots = buildJsxTree(source)
  const indices = fieldReferences(source, path)
  const renderSites = indices.filter((i) => !isGuardReference(source, i, path))
  const candidates = renderSites.length > 0 ? renderSites : indices
  for (const index of candidates) {
    const node = elementAt(roots, index)
    const span = node ? classNameSpanOfNode(source, node) : null
    if (span) return span
  }
  return null
}

/** Escape a field path for use inside a RegExp (paths contain `.` and `[]`). */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/** Every `primary.<field>` reference in the source (in an attribute or a child
 *  expression); matches the identifier, not a preceding `{`, so it finds both
 *  `{primary.title}` and `value={primary.description}`. */
const PRIMARY_FIELD_RE = /\bprimary\.[A-Za-z_$][\w$]*/g

/** The element wrapping all `{primary.*}` leaves — their lowest common ancestor
 *  in the JSX tree. `null` when no primary leaf is present. */
function primaryContainerNode(source: string): JsxNode | null {
  const roots = buildJsxTree(source)
  if (roots.length === 0) return null
  const els: JsxNode[] = []
  let match: RegExpExecArray | null
  PRIMARY_FIELD_RE.lastIndex = 0
  while ((match = PRIMARY_FIELD_RE.exec(source))) {
    const el = elementAt(roots, match.index)
    if (el) els.push(el)
  }
  return lowestCommonAncestor(els)
}

/** True for a path that names a structural container (whole slice / the primary
 *  content group) rather than a single content leaf. */
function isContainerPath(path: string): boolean {
  return path === "" || path === "primary"
}

/**
 * Resolve a target field path to the className span to edit, or `null` when the
 * path can't be located. Throws for paths beyond the supported shapes (`items[i]`
 * and deeper) so the caller refuses the edit instead of silently patching the
 * wrong element.
 */
export function resolveClassNameSpan(
  source: string,
  path: string
): ClassNameSpan | null {
  if (path === "") return rootClassNameSpan(source)

  if (path === "primary") {
    const node = primaryContainerNode(source)
    return node ? classNameSpanOfNode(source, node) : null
  }

  // Leaf content field: `primary.title`, `primary.eyebrow`, …
  if (/^primary\.[A-Za-z_$][\w$]*$/.test(path)) {
    return leafClassNameSpan(source, path)
  }

  throw new Error(
    `resolveClassNameSpan: path "${path}" is not supported (list items render ` +
      `through a .map() local and a dynamic className, so they are not ` +
      `surgically anchorable — supported: "", "primary", "primary.<field>")`
  )
}

/**
 * Resolve the className span a *spacing* tweak on `axis` should edit.
 *
 * - **Leaf paths** (`primary.<field>`): the field's own element — spacing is
 *   local to what was clicked.
 * - **Container paths** (`""`, `primary`): walk self→ancestors to the nearest
 *   element that already carries this axis's utility (ADR-0030 "nearest ancestor
 *   owning the axis"); if none does, patch the container element itself so the
 *   intent is added where it belongs.
 *
 * Returns `null` when the target can't be located or its className is dynamic
 * (the caller leaves the file untouched). Throws on unsupported paths, mirroring
 * `resolveClassNameSpan`.
 */
export function resolveSpacingSpan(
  source: string,
  path: string,
  axis: SpacingAxis
): ClassNameSpan | null {
  if (!isContainerPath(path)) return resolveClassNameSpan(source, path)

  const base = path === "" ? rootNode(source) : primaryContainerNode(source)
  if (!base) return null

  for (const node of selfAndAncestors(base)) {
    const span = classNameSpanOfNode(source, node)
    if (span && hasAxisUtility(span.className, axis)) return span
  }
  return classNameSpanOfNode(source, base)
}

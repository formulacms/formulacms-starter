import type { Primitive } from "./primitives"

/**
 * Field-primitive tree walkers (ADR-0008).
 *
 * The `group → config.fields` / `list → config.item` descent — and the
 * `as Record<string, Primitive>` / `as Primitive` casts it requires — was
 * copy-pasted across the validate, resolve, sample, catalog, and verify
 * modules. Each re-proved the same recursion to reach the leaves it cared
 * about. These two combinators own that descent once, so callers declare only
 * their leaf rule; the tree shape (and the unsafe casts) live here.
 *
 * Two shapes, deliberately separate (their path conventions differ):
 *
 * - {@link walkValue} traverses a descriptor *alongside a stored value* and
 *   visits every leaf. List rows carry real indices (`items[2].title`) because
 *   actual data is present. Callers that collect from stored slices use this.
 * - {@link walkDef} is structure-only (no value): it visits every node and
 *   carries a `path` plus list-nesting `depth`. List items use a positional
 *   `[]` (no index — no rows exist). Callers that summarize or lint the schema
 *   use this.
 *
 * Transform-folds that *rebuild* a value tree (`sample.ts` `sampleValue`,
 * `localizer.ts` `localizeValue`) are a different shape — they produce a new
 * tree rather than visiting an existing one — and are intentionally not built
 * on these walkers.
 */

/** A leaf reached by {@link walkValue}: the primitive plus its stored value. */
export interface LeafVisit {
  /** The leaf primitive (never `group`/`list`). */
  def: Primitive
  /** The stored value at this position (may be `undefined`/malformed). */
  value: unknown
  /** Dotted path with real list indices, e.g. `items[2].title`. */
  path: string
  /** Last path segment, with any trailing `[n]` index stripped. */
  key: string
}

/**
 * Walk every leaf of a descriptor field map (`Record<string, Primitive>`)
 * alongside its stored value bag. Thin routing shim over {@link walkValue}: it
 * exists because plan 029 C9a has four consumers (rich-text profile check,
 * document-reference scanner, publish-checklist walk, search-text extractor)
 * all with the same "for every top-level key, walkValue into its stored bag
 * value" shape. Factoring it here keeps the four consumers from drifting.
 *
 * The `visit` callback also receives the top-level field key so consumers
 * that need to gate by field-level metadata (e.g. `def.config.public`) can
 * do so without re-implementing the enumeration.
 */
export function walkFieldMap(
  fields: Record<string, Primitive>,
  values: Record<string, unknown> | undefined,
  visit: (leaf: LeafVisit & { fieldKey: string }) => void,
): void {
  const bag = values ?? {}
  for (const [fieldKey, def] of Object.entries(fields)) {
    walkValue(def, bag[fieldKey], (leaf) => visit({ ...leaf, fieldKey }), fieldKey)
  }
}

/**
 * Walk `def` alongside `value`, invoking `visit` at every leaf. Groups read
 * their fields object (missing/malformed values descend as `{}`); lists read
 * their array rows (missing/malformed descend as `[]`), preserving index order
 * so a visitor's side effects fire in stable order. The visitor filters by
 * `leaf.def.kind` for the leaves it cares about.
 */
export function walkValue(
  def: Primitive,
  value: unknown,
  visit: (leaf: LeafVisit) => void,
  path = "",
): void {
  if (!def) return
  switch (def.kind) {
    case "group": {
      const fields = def.config.fields as Record<string, Primitive>
      const obj =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      for (const [key, child] of Object.entries(fields)) {
        walkValue(child, obj[key], visit, path ? `${path}.${key}` : key)
      }
      return
    }
    case "list": {
      const item = def.config.item as Primitive
      const rows = Array.isArray(value) ? value : []
      rows.forEach((row, i) => walkValue(item, row, visit, `${path}[${i}]`))
      return
    }
    default:
      visit({
        def,
        value,
        path,
        key: path.split(".").at(-1)?.replace(/\[\d+\]$/, "") ?? path,
      })
  }
}

/** A node reached by {@link walkDef}: every node (groups/lists included). */
export interface DefNode {
  def: Primitive
  /** Schema position; list items use positional `[]` (no index). */
  path: string
  /** List-nesting level (groups keep the parent's depth). */
  depth: number
  /** Last path segment, with any trailing `[]` stripped. */
  key: string
}

/**
 * Walk `def` structurally (no value), invoking `visit` at every node. The
 * visitor descends by default; returning `"skip"` treats the node as opaque and
 * stops descent into it — used to render a `button` group as one row rather than
 * walking its label/link/variant subfields. `opts.path`/`opts.depth` seed the
 * walk for callers that root at a non-empty scope (e.g. `"items"`).
 */
export function walkDef(
  def: Primitive,
  visit: (node: DefNode) => void | "skip",
  opts: { path?: string; depth?: number } = {},
): void {
  const recur = (d: Primitive, path: string, depth: number) => {
    if (!d) return
    const key = path.split(".").at(-1)?.replace(/\[\]$/, "") ?? path
    if (visit({ def: d, path, depth, key }) === "skip") return
    if (d.kind === "group") {
      const fields = d.config.fields as Record<string, Primitive>
      for (const [k, child] of Object.entries(fields)) {
        recur(child, path ? `${path}.${k}` : k, depth)
      }
    } else if (d.kind === "list") {
      const item = d.config.item as Primitive
      recur(item, `${path}[]`, depth + 1)
    }
  }
  recur(def, opts.path ?? "", opts.depth ?? 0)
}

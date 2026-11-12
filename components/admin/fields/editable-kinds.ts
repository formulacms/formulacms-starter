/**
 * Canonical set of field-primitive `kind`s the admin can edit. This module is
 * dependency-free (no React/browser imports) on purpose, so the two consumers
 * that must never drift can both import it:
 *
 *  - the editor registry in `field-editor.tsx`, typed `satisfies
 *    Record<LeafEditorKind, …>` so a widget is required for exactly these kinds
 *    (a missing or stray widget is a tsc error), and
 *  - the verify gate (`lib/slices/authoring/verify.ts`), which fails any slice
 *    whose descriptor references a kind absent here.
 *
 * Together they close the "uneditable slice" hole: a slice can author a valid
 * validator + renderer and pass tsc, yet reference a field kind with no admin
 * editor (the nested `list` that printed `No editor for field … (kind: list)`).
 * The gate now rejects that class outright.
 *
 * Container kinds (`group`, `list`) are editable by recursion, not by a registry
 * entry, so they live in their own set; the gate descends into them.
 */

/** Leaf kinds that resolve to a widget in `EDITOR_REGISTRY`. */
export const LEAF_EDITOR_KINDS = [
  "text",
  "richText",
  "boolean",
  "select",
  "number",
  "image",
  "link",
  "relation",
  "date",
  "datetime",
  "geopoint",
  "embed",
  "table",
] as const

export type LeafEditorKind = (typeof LEAF_EDITOR_KINDS)[number]

/** Containers the editor renders by recursing into their children. */
export const CONTAINER_EDITOR_KINDS = ["group", "list"] as const
export type ContainerEditorKind = (typeof CONTAINER_EDITOR_KINDS)[number]

/** Every kind the admin can edit — leaves (via a widget) + containers (via
 *  recursion). The verify gate checks each slice field's kind against this. */
export const EDITABLE_FIELD_KINDS: ReadonlySet<string> = new Set<string>([
  ...LEAF_EDITOR_KINDS,
  ...CONTAINER_EDITOR_KINDS,
])

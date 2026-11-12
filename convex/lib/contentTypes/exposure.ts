import type { Primitive } from "../slices/primitives"

/**
 * Descriptor field exposure contract (ADR-0038).
 *
 * The single source of truth for "does this field cross the public seam?"
 * Consumers that render, index, emit, or export public output route through
 * `isDescriptorFieldPublic` at top-level `sharedFields` / `localizedFields`
 * iteration. Nested primitives inside a group/list inherit their container's
 * classification (ADR-0038 §3).
 *
 * Default is admin-only (fail-closed): a field must call `.public()` to opt in.
 * Compare with the pre-C10 shape (`(def.config as {public?: boolean}).public
 * !== false`) which defaulted to public and required opt-out.
 *
 * Admin-facing surfaces (admin editor, exports, AI prompt builder) do NOT
 * route through this reader — they see every field. The reader gates only
 * seams that reach the public: renderer, search index, JSON-LD/OG metadata,
 * reference-card output.
 */

/** True iff the field is opted-in to public surfaces via `.public()`. */
export function isDescriptorFieldPublic(def: Primitive): boolean {
  return def.config.public === true
}

/**
 * Filter a top-level descriptor field map to only public entries. Convenience
 * wrapper — consumers can also loop and check per-field. Preserves iteration
 * order.
 */
export function publicFieldsOf(
  fields: Record<string, Primitive>,
): Record<string, Primitive> {
  const out: Record<string, Primitive> = {}
  for (const [key, def] of Object.entries(fields)) {
    if (isDescriptorFieldPublic(def)) out[key] = def
  }
  return out
}

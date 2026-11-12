import { SYSTEM_OWNED_SHARED_FIELDS as CONTENT_TYPE_SYSTEM_OWNED_SHARED_FIELDS } from "@/convex/lib/contentTypes/fieldOwnership"

/**
 * System-owned field ownership map (plan 029 C8).
 *
 * The generic descriptor-driven Content panel renders every descriptor field
 * EXCEPT those already rendered by a dedicated system panel — title/meta by
 * the SEO or Settings panels, slug/status/scheduling by Settings, etc. This
 * module is the single source of truth for those exclusions so the rule
 * lives in one place instead of scattered string checks per surface.
 *
 * Two kinds of ownership:
 *
 * - **Localized-owned:** descriptor `localizedFields` keys already surfaced
 *   by a system panel. Excluded from the generic panel's active-locale
 *   section but still saved through the descriptor-shaped `localized` bag
 *   in `pages.updateDraft` (the system panel writes into the same
 *   editor-state slot).
 * - **Shared-owned:** descriptor `sharedFields` keys the system UX already
 *   owns. The generic panel skips them; they save through their existing
 *   paths (`pages.update` for the byline / tags / SEO; `pages.updateDraft`
 *   only writes what the descriptor localized bag covers).
 *
 * NOTE: `slug`, `status`, `expiresAt`, hierarchy fields, and the global
 * SEO block do not appear in any descriptor's `sharedFields` /
 * `localizedFields` — they live on `systemPageFields` in
 * `convex/schema.ts`. They can't leak into the generic panel by
 * construction; they are listed here only for documentation.
 * `scheduledAt` moved onto `pageStaging` in ADR-0041 Deploy 2 PR B
 * (staged through `pages.updateDraft`, promoted by the shared
 * `performPublish` helper).
 */

/**
 * Localized descriptor keys already rendered by an existing system panel
 * and therefore excluded from the generic active-locale section.
 *
 * `title` is rendered by the Settings panel's slug/title control.
 * `metaTitle` / `metaDescription` are rendered by the SEO panel.
 */
export const SYSTEM_OWNED_LOCALIZED_FIELDS: ReadonlySet<string> = new Set([
  "title",
  "metaTitle",
  "metaDescription",
])

/**
 * Shared descriptor keys the system UX already owns and therefore
 * excluded from the generic All-locales section.
 *
 * - `tags`: rendered by TagField / Internal Labels adapter (plan 029
 *   §Recommended editor seam).
 * - `authorIds`: rendered by the SettingsPanel's bespoke multi-select
 *   `RelationPicker` (plan 029 C10 task 14) with an accessibility label +
 *   explicit locale prop the generic `RelationWidget` doesn't currently
 *   thread (it resolves candidate titles from a hardcoded `.en` bag, not
 *   the active admin locale), AND with an `Id<"pages">[]` shape that
 *   differs from the primitive's stored `{ pageId }[]` bag. Plan 029
 *   Phase 3 §7 gates the swap on "only after the generic relation field
 *   has equivalent behavior" — it doesn't today, so this stays bespoke
 *   until a follow-up chunk brings the generic widget to locale parity.
 *
 *   NOTE: this key was `"authorId"` (singular) until the C10 schema
 *   rename to plural `authorIds` — the stale singular string silently
 *   stopped matching, so `authorIds` briefly leaked through the generic
 *   panel (duplicate UI) AND lost generic-panel edits at save (the
 *   bespoke `authorIds:` key in `use-page-save.ts` always wins the same
 *   object literal). Keep this string in lockstep with the descriptor
 *   field name.
 */
export const SYSTEM_OWNED_SHARED_FIELDS =
  CONTENT_TYPE_SYSTEM_OWNED_SHARED_FIELDS

export function isSystemOwnedLocalizedField(key: string): boolean {
  return SYSTEM_OWNED_LOCALIZED_FIELDS.has(key)
}

export function isSystemOwnedSharedField(key: string): boolean {
  return SYSTEM_OWNED_SHARED_FIELDS.has(key)
}

/**
 * Filter a descriptor field map, dropping the entries a system panel owns.
 * Preserves insertion order so the generic panel renders in descriptor
 * declaration order.
 */
export function filterOwnedFields<T>(
  fields: Record<string, T>,
  owned: ReadonlySet<string>,
): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (!owned.has(key)) out[key] = value
  }
  return out
}

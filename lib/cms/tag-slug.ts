// lib/cms/tag-slug.ts
//
// Isomorphic helpers for content-tag slugs. Lives here (not in `convex/cms/`)
// so client components can import it without dragging the Convex server SDK
// into the browser bundle. The Convex server module re-exports these.
//
// Naming note: `lib/cms/tags.ts` is the unrelated Next.js cache-tag contract.

/** Max characters for a slug. Long enough for multi-word phrases, short enough
 *  to fit in URL segments and badge UI without truncation surprises. */
export const TAG_SLUG_MAX_LENGTH = 48;

/**
 * Single source of truth for tag slug normalization. Used by the
 * `ensureMany` mutation server-side and by the `TagField` client component
 * for input validation, so both agree on what counts as a valid tag.
 *
 * Rules: trim → lowercase → strip everything that isn't a letter, `-`, or
 * whitespace (digits, underscores, punctuation, accented chars all go) →
 * collapse whitespace runs to `-` → collapse consecutive `-` → trim edge `-` →
 * cap length. Returns `null` if the result is empty (e.g. "   !!!  ", "2025").
 *
 * Letters + hyphen only by design: tag slugs are referenced by descriptor
 * code (e.g. `relation({ tag: "featured" })`), so we keep them
 * pronounceable / typeable and don't open the door to `news-2025` vs
 * `news 2025` style drift.
 */
export function normalizeTagSlug(input: string): string | null {
  const lowered = input.trim().toLowerCase();
  if (!lowered) return null;
  const stripped = lowered.replace(/[^a-z\-\s]+/g, "");
  const slugged = stripped
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slugged) return null;
  return slugged.slice(0, TAG_SLUG_MAX_LENGTH);
}

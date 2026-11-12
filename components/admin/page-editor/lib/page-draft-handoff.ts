// Hand page content from the New Page screen to the editor's unsaved draft
// across a route change.
//
// sessionStorage keeps the hand-off out of persisted Page state so the
// editor's existing discard behavior can still abandon it.
//
// One-shot: the editor reads the stash on mount, applies it, and clears the
// key so a hard refresh after save does not rehydrate stale content.
import type { Slice } from "@/convex/lib/slices"

const KEY_PREFIX = "nextcms:page-ai-draft:"

export interface PageDraftHandoff {
  /** Editor's current-locale slug suggested by the producer. Optional — only
   * applied if the editor's slug field is still untouched. */
  slug?: string
  metaTitle?: string
  metaDescription?: string
  slices: Slice[]
}

function isBrowser(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.sessionStorage !== "undefined"
  )
}

/** Stash a draft against a pageId. Replaces any prior stash for the same id.
 * Returns `false` when the stash did not happen (no browser storage, or the
 * write threw, such as on quota exhaustion). */
export function stashPageDraftHandoff(
  pageId: string,
  draft: PageDraftHandoff
): boolean {
  if (!isBrowser()) return false
  try {
    sessionStorage.setItem(KEY_PREFIX + pageId, JSON.stringify(draft))
    return true
  } catch {
    return false
  }
}

/** Read the draft for `pageId`. Returns null if none was stashed or it failed
 * to parse. The caller decides when to clear it so React Strict Mode's double
 * lazy-initializer check cannot accidentally consume the only copy. */
export function readPageDraftHandoff(pageId: string): PageDraftHandoff | null {
  if (!isBrowser()) return null
  const key = KEY_PREFIX + pageId
  const raw = sessionStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as PageDraftHandoff
    if (!parsed || !Array.isArray(parsed.slices)) return null
    return parsed
  } catch {
    return null
  }
}

export function clearPageDraftHandoff(pageId: string): void {
  if (!isBrowser()) return
  sessionStorage.removeItem(KEY_PREFIX + pageId)
}

/** Read and remove the draft for `pageId`. */
export function consumePageDraftHandoff(
  pageId: string
): PageDraftHandoff | null {
  const draft = readPageDraftHandoff(pageId)
  clearPageDraftHandoff(pageId)
  return draft
}

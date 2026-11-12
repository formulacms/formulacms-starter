import type { Id } from "@/convex/_generated/dataModel"

/**
 * The generations an editor tab sends as its `expected*` values.
 *
 * This tab keeps one base for every content buffer it holds, and the base is
 * the generation that buffer was loaded from, never the generation of a later
 * `router.refresh()` that did not reload the buffer. The server compares these
 * values for strict equality, so a stale base is what turns another tab's save
 * into a refusal instead of a silent overwrite.
 */
export type SnapshotEditorPublication = {
  authority: "snapshot_active"
  lifecycleGeneration: number
  sharedDraftGeneration: number
  locales: Array<{
    locale: string
    // Per-language state and address, the same projection the Pages list reads.
    state?: "published" | "draft" | "not_translated"
    title?: string
    slug?: string
    path?: string | null
    draftGeneration: number
    publicGeneration: number
    releaseGeneration: number
    currentSnapshotId?: Id<"pagePublishedSnapshots">
  }>
}

/** An independent copy: a base is mutated by its own save results. */
export function cloneBase(
  base: SnapshotEditorPublication | undefined
): SnapshotEditorPublication | undefined {
  return base ? structuredClone(base) : undefined
}

/**
 * Take one language's generations from the payload that supplied that
 * language's content (first visit to a language, or a translation source read
 * from the `page` prop). Only that language changes: the shared and lifecycle
 * bases belong to buffers that were loaded earlier. The entry is cloned, so a
 * later own-result write never reaches the server prop.
 */
export function adoptLocaleBase(
  base: SnapshotEditorPublication,
  publication: SnapshotEditorPublication,
  locale: string
): void {
  const source = publication.locales.find((entry) => entry.locale === locale)
  const index = base.locales.findIndex((entry) => entry.locale === locale)
  if (!source) {
    // No server state yet: the editor reads a missing entry as generation 0.
    if (index >= 0) base.locales.splice(index, 1)
    return
  }
  const copy = structuredClone(source)
  if (index >= 0) base.locales[index] = copy
  else base.locales.push(copy)
}

/** Forget one language's base so its next load adopts from a payload. */
export function dropLocaleBase(
  base: SnapshotEditorPublication,
  locale: string
): void {
  const index = base.locales.findIndex((entry) => entry.locale === locale)
  if (index >= 0) base.locales.splice(index, 1)
}

/** What a History remount keeps from the tab that is being replaced. */
export type RetainedPublicationBase = {
  /** A clone of the replaced tab's base, taken just before the remount. */
  base: SnapshotEditorPublication
  /** The language the restore rewrote. */
  restoredLocale: string
  /** True when that language's unsaved buffer survives the remount. */
  keepRestoredLocale: boolean
  /** True when unsaved shared fields survive the remount. */
  keepShared: boolean
}

/**
 * The base for a new editor session, built once from the payload it mounts
 * with. After a History restore the remount keeps every retained language's
 * old base and adopts the refreshed generations only for what the remount
 * actually reloads: the restored language (unless its unsaved buffer was kept)
 * and the shared and lifecycle bases (unless unsaved shared fields were kept).
 */
export function buildSessionBase(
  publication: SnapshotEditorPublication | undefined,
  retained: RetainedPublicationBase | undefined
): SnapshotEditorPublication | undefined {
  if (!publication) return undefined
  if (!retained) return structuredClone(publication)
  const base = structuredClone(retained.base)
  // The remount reloads the lifecycle state and, unless unsaved shared fields
  // were kept, the shared fields from the refreshed page. A kept language
  // buffer is refused by its own (old) language base, so it needs no old shared
  // base; the other languages' saves send the shared base they reloaded.
  base.lifecycleGeneration = publication.lifecycleGeneration
  base.sharedDraftGeneration = retained.keepShared
    ? retained.base.sharedDraftGeneration
    : publication.sharedDraftGeneration
  if (!retained.keepRestoredLocale) {
    adoptLocaleBase(base, publication, retained.restoredLocale)
  } else if (
    !base.locales.some((entry) => entry.locale === retained.restoredLocale)
  ) {
    // A kept buffer with no base is based on generation 0, never the refresh.
    const entry = publication.locales.find(
      (candidate) => candidate.locale === retained.restoredLocale
    )
    if (entry) {
      base.locales.push({ ...structuredClone(entry), draftGeneration: 0 })
    }
  }
  return base
}

/** The language's base, or the generation-0 default the editor assumes. */
export function localeBaseOf(
  base: SnapshotEditorPublication,
  locale: string
): SnapshotEditorPublication["locales"][number] {
  return (
    base.locales.find((entry) => entry.locale === locale) ?? {
      locale,
      draftGeneration: 0,
      publicGeneration: 0,
      releaseGeneration: 0,
    }
  )
}

/** The scalar expectations History sends, read from the session base. */
export function restoreExpectations(
  base: SnapshotEditorPublication,
  locale: string
) {
  const entry = localeBaseOf(base, locale)
  return {
    expectedDraftGeneration: entry.draftGeneration,
    expectedSharedDraftGeneration: base.sharedDraftGeneration,
    expectedLifecycleGeneration: base.lifecycleGeneration,
    expectedPublicGeneration: entry.publicGeneration,
    expectedReleaseGeneration: entry.releaseGeneration,
  }
}

/** Only the expectations a draft save sends; public/release clocks are separate. */
export type RecoveryBase = {
  draftGeneration: number
  sharedDraftGeneration: number
  lifecycleGeneration: number
}

/** Snapshot expectations held by this buffer, never the live query payload. */
export function heldRecoveryBase(
  base: SnapshotEditorPublication | undefined,
  locale: string
): RecoveryBase | null {
  return base
    ? {
        draftGeneration: localeBaseOf(base, locale).draftGeneration,
        sharedDraftGeneration: base.sharedDraftGeneration,
        lifecycleGeneration: base.lifecycleGeneration,
      }
    : null
}

/** Build an independent refusal base for draft saves only. The ordinary
 * command base must never adopt recovery expectations. */
export function adoptRecoveryBase(
  base: SnapshotEditorPublication,
  locale: string,
  recorded: RecoveryBase | undefined
): SnapshotEditorPublication {
  const adopted = structuredClone(base)
  adopted.lifecycleGeneration = -1
  adopted.sharedDraftGeneration = recorded?.sharedDraftGeneration ?? -1
  const entry = localeBaseOf(adopted, locale)
  entry.draftGeneration = recorded?.draftGeneration ?? -1
  if (!adopted.locales.some((candidate) => candidate.locale === locale))
    adopted.locales.push(entry)
  return adopted
}

/** Refusal provenance is part of the content buffer, not its presentation. */
export type Buffered<T> = T & { refusalBase?: RecoveryBase }

/** Select only provenance belonging to the buffers this write carries. */
export function bufferRecoveryBase(
  ordinary: RecoveryBase | null,
  localized?: RecoveryBase,
  shared?: RecoveryBase
): RecoveryBase | null {
  if (!ordinary || (!localized && !shared)) return ordinary
  return {
    draftGeneration: localized?.draftGeneration ?? ordinary.draftGeneration,
    sharedDraftGeneration:
      shared?.sharedDraftGeneration ??
      localized?.sharedDraftGeneration ??
      ordinary.sharedDraftGeneration,
    lifecycleGeneration: -1,
  }
}

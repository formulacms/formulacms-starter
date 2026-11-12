import { readSlice } from "@/convex/lib/slices/identity"
import { removedTitleLinksValidator } from "@/convex/lib/richtext/write"
import {
  adoptHeroTitles,
  mergeTitleReports,
} from "@/lib/rich-text/adopt-hero-titles"
import type { Id } from "@/convex/_generated/dataModel"
import { validate } from "convex-helpers/validators"
import { contentTypeDefs } from "@/convex/lib/contentTypes"
import { sliceValidator, type Primitive } from "@/convex/lib/slices"
import { hasValidSliceOccurrencePresentation } from "@/convex/lib/slices/occurrencePresentation"
import {
  validateFieldMapRichText,
  validateSlicesRichText,
  validateUniqueSliceIds,
  convertSliceFields,
} from "@/convex/lib/slices/validate"
import type { Locale } from "@/lib/i18n/config"
import type { RecoveryBase } from "./publication-base"
import type { PageEditorRecoveryDraft } from "./types"
import {
  SYSTEM_OWNED_LOCALIZED_FIELDS,
  SYSTEM_OWNED_SHARED_FIELDS,
} from "./system-owned-fields"
import { sliceDefs, type Slice } from "@/convex/lib/slices"

/**
 * Recovery-payload schema version (plan 029 C8 Phase 3a).
 *
 * v1 (pre-C8) — flat top-level bag: title/slug/pageType/authorId/tags/…
 * v2 (C8+)   — same bag PLUS `sharedFieldValues` + `localizedFieldValues`
 *   for descriptor-generic fields (author roleTitle/bio, and every future
 *   descriptor field the generic Content panel renders).
 * v3 (C10 task 14) — `authorId: Id<"pages"> | null` → `authorIds:
 *   Id<"pages">[]` (multi-author byline). A v2 payload's `authorId` field
 *   doesn't match the new shape at all, so it must be refused rather than
 *   coerced.
 *
 * Bumping the version + refusing to read an older payload is safer than
 * best-effort shape migration: an old payload silently missing/mismatching
 * a new field would restore an editor state that never contained it,
 * silently clearing whatever was in storage on the next save. The "lost
 * draft" cost is bounded — old-version payloads only exist for pages
 * abandoned mid-edit *and* opened again after this deploy.
 */
// Additive save-base metadata keeps pre-base v3 drafts readable.
export const RECOVERY_SCHEMA_VERSION = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function hasRecoveryShape(value: unknown): value is PageEditorRecoveryDraft {
  if (!isRecord(value)) return false
  const strings = [
    "locale",
    "title",
    "slug",
    "pageType",
    "parentId",
    "metaTitle",
    "metaDescription",
    "seoOgTitle",
    "seoOgDescription",
    "seoOgImage",
  ]
  return (
    strings.every((key) => typeof value[key] === "string") &&
    ["seoNoIndex", "seoNoFollow"].every(
      (key) => typeof value[key] === "boolean"
    ) &&
    ["authorIds", "tags"].every(
      (key) =>
        Array.isArray(value[key]) &&
        value[key].every((entry) => typeof entry === "string")
    ) &&
    (value.removedTitleLinks === undefined ||
      validate(removedTitleLinksValidator, value.removedTitleLinks)) &&
    Array.isArray(value.slices) &&
    isRecord(value.sharedFieldValues) &&
    isRecord(value.localizedFieldValues)
  )
}

/** A recovered buffer may outlive the renderer/descriptor that created it. */
export function isCurrentSourceRecovery(
  draft: PageEditorRecoveryDraft,
  pageType: PageEditorRecoveryDraft["pageType"],
  locale: Locale
): boolean {
  if (
    !hasRecoveryShape(draft) ||
    Boolean(draft.inlineConflicts?.length) ||
    draft.pageType !== pageType ||
    draft.locale !== locale
  )
    return false
  const descriptor = contentTypeDefs[pageType]
  if (!descriptor) return false
  function validBag(
    fields: Record<string, Primitive>,
    values: Record<string, unknown>,
    owned: ReadonlySet<string>
  ) {
    const editable = Object.fromEntries(
      Object.entries(fields).filter(([key]) => !owned.has(key))
    )
    if (Object.keys(values).some((key) => !(key in editable))) return false
    return Object.entries(editable).every(([key, field]) =>
      validate(field.validator, values[key])
    )
  }
  try {
    if (!draft.slices.every(hasValidSliceOccurrencePresentation)) return false
    if (!draft.slices.every((slice) => validate(sliceValidator, slice)))
      return false
    if (
      !validBag(
        descriptor.sharedFields,
        draft.sharedFieldValues,
        SYSTEM_OWNED_SHARED_FIELDS
      ) ||
      !validBag(
        descriptor.localizedFields,
        draft.localizedFieldValues,
        SYSTEM_OWNED_LOCALIZED_FIELDS
      )
    )
      return false
    validateUniqueSliceIds(draft.slices)
    validateSlicesRichText(draft.slices, "legacy")
    validateFieldMapRichText(
      descriptor.sharedFields,
      draft.sharedFieldValues,
      "legacy"
    )
    validateFieldMapRichText(
      descriptor.localizedFields,
      draft.localizedFieldValues,
      "legacy"
    )
    return true
  } catch {
    return false
  }
}

/** The -1 refusal token is valid metadata after another refused save. */
export function parseRecoveryBase(value: unknown): RecoveryBase | undefined {
  if (!isRecord(value)) return undefined
  if (
    !["draftGeneration", "sharedDraftGeneration", "lifecycleGeneration"].every(
      (key) => Number.isSafeInteger(value[key]) && (value[key] as number) >= -1
    )
  )
    return undefined
  return {
    draftGeneration: value.draftGeneration as number,
    sharedDraftGeneration: value.sharedDraftGeneration as number,
    lifecycleGeneration: value.lifecycleGeneration as number,
  }
}

/** The single currentness decision. Missing/cross-authority bases are unsafe. */
export function isRecoveryBaseCurrent(
  recorded: unknown,
  held: RecoveryBase | null
): boolean {
  const base = parseRecoveryBase(recorded)
  return (
    !!base &&
    !!held &&
    base.draftGeneration === held.draftGeneration &&
    base.sharedDraftGeneration === held.sharedDraftGeneration &&
    base.lifecycleGeneration === held.lifecycleGeneration
  )
}

export type RecoveryDraftWrite = Omit<PageEditorRecoveryDraft, "base"> & {
  base: RecoveryBase | null
}

export function recoveryKey(pageId: Id<"pages">, locale: Locale): string {
  return `nextcms:page-editor:${pageId}:recovery:${locale}`
}

export function readRecoveryDraft(
  pageId: Id<"pages">,
  locale: Locale
): PageEditorRecoveryDraft | null {
  if (typeof window === "undefined") return null
  try {
    // sessionStorage survives reloads in this tab, while another tab and
    // another locale cannot replace or clear its pending work.
    const key = recoveryKey(pageId, locale)
    const legacyKey = `nextcms:page-editor:${pageId}:recovery`
    const stored = window.sessionStorage.getItem(key)
    const raw = stored ?? window.localStorage.getItem(legacyKey)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    if (!hasRecoveryShape(parsed)) return null
    if (typeof parsed.savedAt !== "number" || !Number.isFinite(parsed.savedAt))
      return null
    if (parsed.version !== RECOVERY_SCHEMA_VERSION) return null
    if (parsed.locale !== locale) return null
    // Keep an unreadable buffer available for explicit recovery refusal/copy.
    // Never replace failed conversion with an empty document or drop its bytes.
    let adopted = {
      value: parsed.slices,
      reports: parsed.removedTitleLinks ?? [],
    }
    try {
      const titles = adoptHeroTitles(
        parsed.slices,
        locale,
        parsed.removedTitleLinks
      )
      let reports = titles.reports
      const value = titles.value.map((slice) => {
        if (
          !slice ||
          typeof slice !== "object" ||
          !(readSlice(slice).type in sliceDefs)
        )
          return slice
        const converted = convertSliceFields(slice as Slice)
        reports = mergeTitleReports(
          reports,
          converted.reports
            .filter((report) => report.removedLinks.length > 0)
            .map((report) => ({
              locale,
              sliceId: readSlice(slice).id,
              fieldPath: report.fieldPath,
              removedLinks: report.removedLinks,
            }))
        )
        return converted.value
      })
      adopted = { value, reports }
    } catch {
      // Keep the entire original buffer. A partial conversion would erase
      // diagnostics needed by a later retry; failed adoption never permits a write.
    }
    // Adopt a matching legacy draft once. Do not consume another locale's
    // legacy payload or let it resurrect after a successful Save.
    if (stored === null) {
      window.sessionStorage.setItem(key, raw)
      window.localStorage.removeItem(legacyKey)
    }
    return {
      ...parsed,
      base: parsed.base === null ? null : parseRecoveryBase(parsed.base),
      slices: adopted.value,
      ...(adopted.reports.length ? { removedTitleLinks: adopted.reports } : {}),
    }
  } catch {
    return null
  }
}

export function writeRecoveryDraft(
  pageId: Id<"pages">,
  draft: RecoveryDraftWrite
): void {
  if (typeof window === "undefined") return
  const payload = { ...draft, version: RECOVERY_SCHEMA_VERSION }
  try {
    window.sessionStorage.setItem(
      recoveryKey(pageId, draft.locale),
      JSON.stringify(payload)
    )
  } catch {
    // Disabled/quota-limited storage must not interrupt ordinary editing.
  }
}

export function clearRecoveryDraft(pageId: Id<"pages">, locale: Locale): void {
  if (typeof window === "undefined") return
  try {
    window.sessionStorage.removeItem(recoveryKey(pageId, locale))
  } catch {
    // Recovery storage is optional; saving remains available.
  }
}

/** Record a freshly captured editor buffer before its document is replaced. */
export function writeCapturedRecoveryDraft(
  pageId: Id<"pages">,
  draft: Omit<RecoveryDraftWrite, "savedAt">
): PageEditorRecoveryDraft {
  const captured = { ...draft, savedAt: Date.now() }
  writeRecoveryDraft(pageId, captured)
  return captured
}

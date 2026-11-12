import { readSlice } from "@/convex/lib/slices/identity"
import { type Slice } from "@/convex/lib/slices"
import {
  isPrimitiveValueEmpty,
  type Primitive,
} from "@/convex/lib/slices/primitives"
import { walkFieldMap } from "@/convex/lib/slices/walk"
import { type Locale } from "@/lib/i18n/config"
import type { LocaleContentSummary, Page } from "./types"
import { SYSTEM_OWNED_LOCALIZED_FIELDS } from "./system-owned-fields"

export function getTitle(page: Page, locale: Locale): string {
  return page.content?.[locale]?.title ?? ""
}

export { slugify } from "@/convex/lib/contentTypes/routing"

/** True when the page has at least a title or one slice — the minimum the
 *  meta-only AI call needs to summarise. Mirrors the spec §7.3 "no brief; meta
 *  is derived from existing copy." */
export function hasAnyContent(slices: Slice[], title: string): boolean {
  if (title.trim()) return true
  return slices.some((s) => readSlice(s).enabled !== false)
}

export function summarizeLocaleContent(
  content: {
    title?: string
    metaTitle?: string
    metaDescription?: string
    slices?: Slice[]
    /**
     * Descriptor localized field values (author roleTitle/bio, future
     * faq/testimonial content). Plan 029 C9a: without this the transfer
     * popover reported "empty" for a locale whose only content was in
     * descriptor-generic fields, so the picker's `hasAny/hasTranslatable`
     * indicator misled the copy/translate UX. Optional so existing
     * call-sites without descriptor context still summarize correctly.
     */
    localizedFieldValues?: Record<string, unknown>
  },
  localizedFieldDefs?: Record<string, Primitive>
): LocaleContentSummary {
  // Plan 029 C9a — collapse hasAny + hasTranslatable into one walk so the
  // two filters stay in lockstep. Advisor-flagged bug on the v1 shape:
  // `hasTranslatable` inspected only top-level text/richText leaves while
  // `collectTranslatableLeaves` walks recursively via `walkFieldMap` — a
  // locale whose only translatable content lived in nested list/group
  // leaves reported `hasTranslatable=false` and blocked the transfer
  // popover from translating. `walkFieldMap` recurses so nested leaves
  // count.
  const { hasAnyDescriptorField, hasTranslatableDescriptorField } = (() => {
    if (!localizedFieldDefs || !content.localizedFieldValues) {
      return {
        hasAnyDescriptorField: false,
        hasTranslatableDescriptorField: false,
      }
    }
    const visibleFields: Record<string, Primitive> = {}
    for (const [key, def] of Object.entries(localizedFieldDefs)) {
      if (SYSTEM_OWNED_LOCALIZED_FIELDS.has(key)) continue
      visibleFields[key] = def
    }
    let hasAny = false
    let hasTranslatable = false
    walkFieldMap(visibleFields, content.localizedFieldValues, (leaf) => {
      if (isPrimitiveValueEmpty(leaf.def, leaf.value)) return
      hasAny = true
      if (leaf.def.kind === "text" || leaf.def.kind === "richText") {
        hasTranslatable = true
      }
    })
    return {
      hasAnyDescriptorField: hasAny,
      hasTranslatableDescriptorField: hasTranslatable,
    }
  })()

  const hasAny =
    (content.title ?? "").trim().length > 0 ||
    (content.metaTitle ?? "").trim().length > 0 ||
    (content.metaDescription ?? "").trim().length > 0 ||
    (content.slices ?? []).length > 0 ||
    hasAnyDescriptorField
  return {
    hasAny,
    hasTranslatable:
      (content.title ?? "").trim().length > 0 ||
      (content.metaTitle ?? "").trim().length > 0 ||
      (content.metaDescription ?? "").trim().length > 0 ||
      (content.slices ?? []).length > 0 ||
      hasTranslatableDescriptorField,
  }
}

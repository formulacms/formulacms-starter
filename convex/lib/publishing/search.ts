import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import type { Doc } from "../../_generated/dataModel"
import type { MutationCtx } from "../../_generated/server"
import { contentTypeDefs, type ContentType } from "../contentTypes"
import {
  isDescriptorFieldPublic,
  publicFieldsOf,
} from "../contentTypes/exposure"
import { type Slice, type SliceType } from "../slices"
import type { Primitive } from "../slices/primitives"
import { walkFieldMap, walkValue } from "../slices/walk"
import { collectTextSegments, parsePMDoc } from "../richtext/pmText"
import { readFieldText, convertTransitionTitle } from "../richtext/transitions"
import { resolveFieldContract } from "../richtext/contracts"
import { toFieldShape } from "../richtext/shape"
import { getStagingByPageId, overlayStagingOnPage } from "./staging"

/**
 * Page search denormalization (plan 023 Phase 4 #2).
 *
 * Convex search indexes read one top-level string field, but everything an
 * editor or visitor would search for lives inside `pages.content.<locale>`
 * (titles, rich-text slice bodies). So each page fans out into one
 * `pageSearch` row per translated locale holding a flattened `text` blob,
 * and every content-affecting page write resyncs those rows — same
 * discipline as `refreshMediaReferencesForPage`, called at the same sites.
 *
 * Invariant: `pageSearch` rows exist iff the page exists and is not
 * soft-deleted; one row per locale present in `page.content`.
 *
 * Plan 029 C10 — descriptor localized + shared text/richText fan into the
 * same `text` blob so a future faq answer or testimonial quote is searchable.
 * Admin-only fields (default per ADR-0038, opt-in with `.public()`) are
 * excluded via the canonical `publicFieldsOf` gate at top-level field
 * iteration. Convex full-text search tokenizes on whitespace + basic
 * separators — Arabic and CJK content is stored as-is but won't tokenize
 * into recall-friendly units; a proper multilingual analyzer is out of
 * scope until Convex's search primitives ship one.
 */

/** Walk a descriptor field map and collect leaf text values (text +
 *  richText). Called once for shared, once per locale for localized —
 *  matches the checklist / doc-refs walker discipline (plan 029 C9a).
 *  Applies the exposure gate at top-level field iteration (ADR-0038 §3). */
function extractDescriptorFieldMapText(
  fields: Record<string, Primitive>,
  values: Record<string, unknown> | undefined,
  parts: string[]
): void {
  walkFieldMap(publicFieldsOf(fields), values, (leaf) => {
    if (leaf.def.kind === "text" && typeof leaf.value === "string") {
      if (leaf.value.trim()) parts.push(leaf.value)
    } else if (leaf.def.kind === "richText" && typeof leaf.value === "string") {
      const config = leaf.def.config as {
        profile?: "inline" | "basic" | "full"
        contract?: "title" | "inline" | "basic" | "full"
      }
      const doc = parsePMDoc(
        toFieldShape(resolveFieldContract(config), leaf.value).value
      )
      if (doc) {
        const segments = collectTextSegments(doc).filter((s) => s.trim())
        parts.push(...segments)
      }
    }
  })
}

/** Cap the denormalized blob well under Convex's 1MB document limit. */
export const MAX_SEARCH_TEXT_LENGTH = 50_000

/** Flatten the human-readable text of a locale's slices, in document order. */
export function extractSliceText(slices: Slice[]): string {
  const parts: string[] = []
  for (const slice of slices) {
    if (!readSlice(slice).enabled) continue
    const def = readSliceDefinition(readSlice(slice).type as SliceType)
    if (!def) continue
    const visit = (leaf: { def: Primitive; value: unknown; path: string }) => {
      if (leaf.def.kind === "text" && typeof leaf.value === "string") {
        const projected = readFieldText(
          { sliceType: readSlice(slice).type, fieldPath: leaf.path },
          leaf.value
        )
        if (projected.trim()) parts.push(projected)
      } else if (
        leaf.def.kind === "richText" &&
        typeof leaf.value === "string"
      ) {
        const config = leaf.def.config as {
          profile?: "inline" | "basic" | "full"
          contract?: "title" | "inline" | "basic" | "full"
        }
        const doc = parsePMDoc(
          convertTransitionTitle(
            { sliceType: readSlice(slice).type, fieldPath: leaf.path },
            leaf.value
          )?.value ??
            toFieldShape(resolveFieldContract(config), leaf.value).value
        )
        if (doc) {
          const segments = collectTextSegments(doc).filter((s) => s.trim())
          parts.push(...segments)
        }
      }
    }
    walkValue(def.primary, readSlice(slice).primary, visit, "primary")
    if (def.items && "items" in slice) {
      walkValue(def.items, readSlice(slice).items, visit, "items")
    }
  }
  return parts.join(" ")
}

/** Build one locale's search blob: title + meta + slug + slice text +
 *  descriptor text/richText (shared + localized), capped. */
export function buildPageSearchText(input: {
  /** Undefined when the descriptor classifies localized title admin-only. */
  title: string | undefined
  metaTitle?: string
  metaDescription?: string
  slug: string
  cardExcerpt?: string
  slices: Slice[]
  /** Plan 029 C9a — descriptor shared bag (row-level, one pass across all
   *  locales). Undefined = no descriptor or type not registered. */
  descriptorShared?: {
    values: Record<string, unknown>
    fields: Record<string, Primitive>
  }
  /** Plan 029 C9a — descriptor localized bag for THIS locale. Undefined
   *  when the type has no localized descriptor fields. */
  descriptorLocalized?: {
    values: Record<string, unknown>
    fields: Record<string, Primitive>
  }
}): string {
  const descriptorParts: string[] = []
  if (input.descriptorShared) {
    extractDescriptorFieldMapText(
      input.descriptorShared.fields,
      input.descriptorShared.values,
      descriptorParts
    )
  }
  if (input.descriptorLocalized) {
    extractDescriptorFieldMapText(
      input.descriptorLocalized.fields,
      input.descriptorLocalized.values,
      descriptorParts
    )
  }
  const text = [
    input.title,
    input.metaTitle,
    input.metaDescription,
    input.slug,
    input.cardExcerpt,
    extractSliceText(input.slices),
    descriptorParts.join(" "),
  ]
    .filter((part): part is string => Boolean(part && part.trim()))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
  return text.length > MAX_SEARCH_TEXT_LENGTH
    ? text.slice(0, MAX_SEARCH_TEXT_LENGTH)
    : text
}

/** Excerpt window around the first hit, for public search results. */
export const SEARCH_EXCERPT_LENGTH = 160

/**
 * Build a short excerpt from a search blob centered on the first occurrence
 * of any queried word (case-insensitive). Falls back to the blob's start
 * when nothing matches (the hit may be in the title, which the result
 * already shows).
 */
export function buildSearchExcerpt(text: string, term: string): string {
  const words = term
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w.length > 1)
  const lower = text.toLowerCase()
  let hit = -1
  for (const word of words) {
    const at = lower.indexOf(word)
    if (at !== -1 && (hit === -1 || at < hit)) hit = at
  }
  const start = Math.max(0, hit === -1 ? 0 : hit - 40)
  const raw = text.slice(start, start + SEARCH_EXCERPT_LENGTH).trim()
  const prefix = start > 0 ? "…" : ""
  const suffix = start + SEARCH_EXCERPT_LENGTH < text.length ? "…" : ""
  return `${prefix}${raw}${suffix}`
}

/** Delete every `pageSearch` row for a page (hard delete / trash). */
export async function deletePageSearch(
  ctx: MutationCtx,
  pageId: Doc<"pages">["_id"]
): Promise<void> {
  const rows = await ctx.db
    .query("pageSearch")
    .withIndex("by_pageId", (q) => q.eq("pageId", pageId))
    .collect()
  await Promise.all(rows.map((row) => ctx.db.delete(row._id)))
}

/**
 * Resync a page's `pageSearch` rows from its current content. Pass the
 * post-patch shape (`{ ...page, ...patch }`) exactly like
 * `refreshMediaReferencesForPage`. Soft-deleted pages get their rows removed.
 * Bounded: one row per locale (a handful), so `.collect()` is safe.
 *
 * ADR-0041 Deploy 2 PR B: for non-published pages, the working copy lives
 * on `pageStaging`, not `pages.content`. The row's `pages.content` is `{}`
 * for a fresh draft (or a hoisted never-published draft), so a naive
 * iteration over `Object.keys(page.content)` produces zero rows and the
 * draft becomes unsearchable in admin. Overlay staging content onto the
 * page for drafts / archived rows before deriving the search rows —
 * published rows stay untouched (staged unpublished changes must NOT
 * leak into the public search surface, which filters on `status`).
 */
export async function syncPageSearch(
  ctx: MutationCtx,
  page: Doc<"pages">
): Promise<void> {
  const existing = await ctx.db
    .query("pageSearch")
    .withIndex("by_pageId", (q) => q.eq("pageId", page._id))
    .collect()

  if (page.deletedAt !== undefined) {
    await Promise.all(existing.map((row) => ctx.db.delete(row._id)))
    return
  }

  const workingCopy =
    page.status === "published"
      ? page
      : overlayStagingOnPage(page, await getStagingByPageId(ctx, page._id))

  const byLocale = new Map(existing.map((row) => [row.locale, row]))
  const now = Date.now()
  const locales = Object.keys(workingCopy.content ?? {})

  // Plan 029 C9a — descriptor bags fed into each locale's search blob.
  // Shared is row-level (one bag for all locales); localized reads
  // `content[locale]` per iteration. Missing descriptor (unknown type)
  // silently skips — matches the doc-refs scanner's fallthrough.
  //
  // Shared bag reads from `workingCopy` so staged sharedField edits (post
  // `category`, author `socials`, testimonial `personRole`, …) feed the
  // draft's search blob before they publish.
  const descriptor = contentTypeDefs[page.pageType as ContentType]
  const descriptorShared = descriptor
    ? {
        values: workingCopy as unknown as Record<string, unknown>,
        fields: descriptor.sharedFields as Record<string, Primitive>,
      }
    : undefined

  await Promise.all(
    locales.map(async (locale) => {
      const content = workingCopy.content?.[locale]
      if (!content) return
      const slug = workingCopy.localizedSlugs?.[locale] ?? workingCopy.slug
      const descriptorLocalized = descriptor
        ? {
            values: content as unknown as Record<string, unknown>,
            fields: descriptor.localizedFields as Record<string, Primitive>,
          }
        : undefined
      // Bag-adapter — search is slurp-everything (ADR-0038 §Q9.b): any
      // textual value on any arm feeds the blob. The strict per-arm union
      // drops `metaTitle` / `metaDescription` / `slices` when a pure-form
      // arm (testimonial) enters the mix; those keys really are absent
      // there, so the coalesce reads them as `undefined` and search still
      // gets testimonial's descriptor-derived text via `descriptorShared`
      // + `descriptorLocalized` above.
      const contentBag = content as {
        title: string
        metaTitle?: string
        metaDescription?: string
        slices?: Slice[]
      }
      // ADR-0038 §Q9.b — descriptor-classified admin-only fields never cross
      // the public search seam. When the descriptor marks localized `title`
      // as admin-only (testimonial — plan 029 C10 §Q9.b), fall back to a
      // public-safe display label and omit the admin-only title from the
      // tokenized `text` blob. Slice-body arms (page/post/author/landing-page)
      // mark `title.public()`, so the public path is behavior-preserving there.
      //
      // The fallback is arm-specific rather than routed through the
      // descriptor's `referenceCard` — that helper is exposure-unaware and
      // itself falls back to the admin-only `localizedTitle` when
      // personName is missing (see `testimonial.ts:referenceCard`), which
      // would silently re-leak the admin-only title once the personName-
      // required invariant ever softens. Testimonial is the only arm today
      // with an admin-only localized title; a future admin-only-title arm
      // needs its own public-safe substitute added here.
      const titleIsPublic = descriptor?.localizedFields.title
        ? isDescriptorFieldPublic(descriptor.localizedFields.title as Primitive)
        : true
      const publicDisplayTitle = titleIsPublic
        ? contentBag.title
        : page.pageType === "testimonial"
          ? (workingCopy as { personName?: string }).personName || ""
          : ""
      const fields = {
        pageId: page._id,
        locale,
        status: page.status,
        title: publicDisplayTitle,
        slug,
        text: buildPageSearchText({
          title: titleIsPublic ? contentBag.title : undefined,
          metaTitle: contentBag.metaTitle ?? workingCopy.seo?.metaTitle,
          metaDescription:
            contentBag.metaDescription ?? workingCopy.seo?.metaDescription,
          slug,
          cardExcerpt: workingCopy.cardExcerpt,
          slices: contentBag.slices ?? [],
          descriptorShared,
          descriptorLocalized,
        }),
        updatedAt: now,
      }
      const row = byLocale.get(locale)
      if (row) {
        byLocale.delete(locale)
        if (
          row.text !== fields.text ||
          row.status !== fields.status ||
          row.title !== fields.title ||
          row.slug !== fields.slug
        ) {
          await ctx.db.patch(row._id, fields)
        }
      } else {
        await ctx.db.insert("pageSearch", fields)
      }
    })
  )

  // Locales removed from the page no longer have content to match against.
  await Promise.all(
    Array.from(byLocale.values()).map((stale) => ctx.db.delete(stale._id))
  )
}

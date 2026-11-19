import { v } from "convex/values"

/**
 * Per-language search and social fields (ADR-0037 amendment, 2026-11-17).
 *
 * Each Localized Content owns its social share title and description, noindex,
 * nofollow, structured data, keywords, focus keyword, card excerpt and (posts)
 * category. The social share image and the card image stay shared.
 *
 * This module is pure (no database access) so every reader and writer applies
 * one rule. Frozen Published Snapshots written before the change keep the old
 * shared values in `shared.system.seo`, `shared.system.cardExcerpt` and
 * `shared.descriptor.category`; `normalizeSnapshotPayload` resolves them.
 */

export const perLanguageSeoValidator = v.object({
  ogTitle: v.optional(v.string()),
  ogDescription: v.optional(v.string()),
  noIndex: v.optional(v.boolean()),
  noFollow: v.optional(v.boolean()),
  structuredData: v.optional(v.string()),
  keywords: v.optional(v.array(v.string())),
  focusKeyword: v.optional(v.string()),
})

/** Copied into every language: a robots choice is not a language-bound text. */
export const PER_LANGUAGE_ROBOTS_KEYS = ["noIndex", "noFollow"] as const
/** Language-bound text, written in the language the owner used. */
export const PER_LANGUAGE_TEXT_KEYS = [
  "ogTitle",
  "ogDescription",
  "structuredData",
  "keywords",
  "focusKeyword",
] as const
export const PER_LANGUAGE_SEO_KEYS = [
  ...PER_LANGUAGE_ROBOTS_KEYS,
  ...PER_LANGUAGE_TEXT_KEYS,
] as const

/** Keys of the old shared `seo` block that moved or are legacy meta text. */
const LEGACY_SHARED_SEO_KEYS = [
  ...PER_LANGUAGE_SEO_KEYS,
  "metaTitle",
  "metaDescription",
] as const

export type PerLanguageSeo = {
  ogTitle?: string
  ogDescription?: string
  noIndex?: boolean
  noFollow?: boolean
  structuredData?: string
  keywords?: string[]
  focusKeyword?: string
}

type PayloadLike = {
  locale: string
  localized: { slug: string; content: Record<string, unknown> }
  shared: {
    system: Record<string, unknown>
    descriptor: Record<string, unknown>
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isBlank(value: unknown): boolean {
  return value === undefined || value === null || value === ""
}

/** Strip undefined entries so a payload stays canonical. */
function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined)
  )
}

/** The per-language `seo` bag stored in a Localized Content, if any. */
export function readLocalizedSeo(
  content: Record<string, unknown> | undefined
): Record<string, unknown> {
  return content && isRecord(content.seo) ? content.seo : {}
}

/**
 * True when the shared blocks of a payload still carry old shared values. A
 * snapshot published after the change has them stripped, so this is the marker
 * of an old snapshot.
 */
export function hasLegacySharedValues(shared: PayloadLike["shared"]): boolean {
  const seo = shared.system.seo
  if (
    isRecord(seo) &&
    LEGACY_SHARED_SEO_KEYS.some((key) => seo[key] !== undefined)
  )
    return true
  return (
    shared.system.cardExcerpt !== undefined ||
    shared.descriptor.category !== undefined
  )
}

/**
 * Resolve the per-language values of an old snapshot. `noIndex` and `noFollow`
 * apply in every language. Text values apply only in the language recorded as
 * the legacy shared language (`siteSettings.legacySharedFieldsLocale`), never
 * in another language. The result is a new payload in the new shape: the
 * values sit in the Localized Content and the shared blocks carry no moved
 * key. A payload already in the new shape is returned unchanged.
 */
export function normalizeSnapshotPayload<P extends PayloadLike>(
  payload: P,
  legacyLocale: string
): P {
  if (!hasLegacySharedValues(payload.shared)) return payload
  const { system, descriptor } = payload.shared
  const sharedSeo = isRecord(system.seo) ? system.seo : {}
  const content = payload.localized.content
  const own = readLocalizedSeo(content)
  const inLegacyLocale = payload.locale === legacyLocale

  const seo: Record<string, unknown> = {}
  for (const key of PER_LANGUAGE_ROBOTS_KEYS)
    seo[key] = own[key] !== undefined ? own[key] : sharedSeo[key]
  for (const key of PER_LANGUAGE_TEXT_KEYS)
    seo[key] =
      own[key] !== undefined
        ? own[key]
        : inLegacyLocale
          ? sharedSeo[key]
          : undefined

  const nextContent: Record<string, unknown> = { ...content }
  const resolvedSeo = compact(seo)
  if (Object.keys(resolvedSeo).length > 0) nextContent.seo = resolvedSeo
  else delete nextContent.seo
  const cardExcerpt =
    content.cardExcerpt !== undefined
      ? content.cardExcerpt
      : inLegacyLocale
        ? system.cardExcerpt
        : undefined
  if (cardExcerpt !== undefined) nextContent.cardExcerpt = cardExcerpt
  else delete nextContent.cardExcerpt
  if ("category" in descriptor || "category" in content) {
    const category =
      content.category !== undefined
        ? content.category
        : inLegacyLocale
          ? descriptor.category
          : undefined
    if (category !== undefined) nextContent.category = category
    else delete nextContent.category
  }
  // The legacy meta text fills the language's own meta only where empty, and
  // only in the legacy language.
  if (inLegacyLocale) {
    if (isBlank(content.metaTitle) && !isBlank(sharedSeo.metaTitle))
      nextContent.metaTitle = sharedSeo.metaTitle
    if (isBlank(content.metaDescription) && !isBlank(sharedSeo.metaDescription))
      nextContent.metaDescription = sharedSeo.metaDescription
  }

  const nextSystem = { ...system }
  delete nextSystem.cardExcerpt
  const remainingSeo = compact(
    Object.fromEntries(
      Object.entries(sharedSeo).filter(
        ([key]) => !(LEGACY_SHARED_SEO_KEYS as readonly string[]).includes(key)
      )
    )
  )
  if (Object.keys(remainingSeo).length > 0) nextSystem.seo = remainingSeo
  else delete nextSystem.seo
  const nextDescriptor = { ...descriptor }
  delete nextDescriptor.category

  return {
    ...payload,
    localized: { ...payload.localized, content: nextContent },
    shared: { system: nextSystem, descriptor: nextDescriptor },
  }
}

/**
 * Remove the moved keys from the shared blocks of a new payload. The Shared
 * Draft keeps the old values until a later narrowing step, so a new snapshot
 * must not carry them: their absence marks it as a snapshot that owns its
 * per-language values.
 */
export function stripMovedSharedValues(shared: PayloadLike["shared"]): {
  system: Record<string, unknown>
  descriptor: Record<string, unknown>
} {
  const system = { ...shared.system }
  const descriptor = { ...shared.descriptor }
  delete system.cardExcerpt
  delete descriptor.category
  if (isRecord(system.seo)) {
    const remaining = compact(
      Object.fromEntries(
        Object.entries(system.seo).filter(
          ([key]) =>
            !(LEGACY_SHARED_SEO_KEYS as readonly string[]).includes(key)
        )
      )
    )
    if (Object.keys(remaining).length > 0) system.seo = remaining
    else delete system.seo
  }
  return { system, descriptor }
}

/** What a Localized Content stores of the moved fields, from a seo patch. */
export function sanitizeLocalizedSeo(
  value: unknown
): PerLanguageSeo | undefined {
  if (!isRecord(value)) return undefined
  const out: Record<string, unknown> = {}
  for (const key of PER_LANGUAGE_SEO_KEYS)
    if (value[key] !== undefined) out[key] = value[key]
  return Object.keys(out).length > 0 ? (out as PerLanguageSeo) : undefined
}

/**
 * Merge the effective per-language seo over the shared seo block into the
 * shape the public projection and readers already use (`page.seo`).
 */
export function mergedSeoForProjection(
  sharedSeo: unknown,
  content: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  const merged = compact({
    ...(isRecord(sharedSeo) ? sharedSeo : {}),
    ...readLocalizedSeo(content),
  })
  return Object.keys(merged).length > 0 ? merged : undefined
}

export type BackfillPlan = {
  /** Content patch for the language's Working Draft, or null for nothing. */
  contentPatch: Record<string, unknown> | null
  copiedText: boolean
}

/**
 * The Working Draft patch of the one-time backfill (ADR clause 6): text values
 * only into the legacy language and only where the draft's own value is empty;
 * noindex and nofollow into every existing draft where unset. The result is a
 * full replacement `content` object, or null when nothing changes.
 */
export function planDraftBackfill(args: {
  locale: string
  legacyLocale: string
  content: Record<string, unknown>
  sharedSeo: Record<string, unknown> | undefined
  sharedCardExcerpt: unknown
  sharedCategory: unknown
  hasCategoryField: boolean
}): Record<string, unknown> | null {
  const { content } = args
  const sharedSeo = args.sharedSeo ?? {}
  const own = readLocalizedSeo(content)
  const nextSeo: Record<string, unknown> = { ...own }
  const next: Record<string, unknown> = { ...content }
  let changed = false
  for (const key of PER_LANGUAGE_ROBOTS_KEYS) {
    if (own[key] === undefined && sharedSeo[key] !== undefined) {
      nextSeo[key] = sharedSeo[key]
      changed = true
    }
  }
  if (args.locale === args.legacyLocale) {
    for (const key of PER_LANGUAGE_TEXT_KEYS) {
      if (isBlank(own[key]) && !isBlank(sharedSeo[key])) {
        nextSeo[key] = sharedSeo[key]
        changed = true
      }
    }
    if (isBlank(content.cardExcerpt) && !isBlank(args.sharedCardExcerpt)) {
      next.cardExcerpt = args.sharedCardExcerpt
      changed = true
    }
    if (
      args.hasCategoryField &&
      isBlank(content.category) &&
      !isBlank(args.sharedCategory)
    ) {
      next.category = args.sharedCategory
      changed = true
    }
    if (isBlank(content.metaTitle) && !isBlank(sharedSeo.metaTitle)) {
      next.metaTitle = sharedSeo.metaTitle
      changed = true
    }
    if (
      isBlank(content.metaDescription) &&
      !isBlank(sharedSeo.metaDescription)
    ) {
      next.metaDescription = sharedSeo.metaDescription
      changed = true
    }
  }
  if (!changed) return null
  const seo = compact(nextSeo)
  if (Object.keys(seo).length > 0) next.seo = seo
  return next
}

/**
 * Put the per-language `seo` and `cardExcerpt` of a save into the content a
 * Working Draft stores. A key the save does not send keeps the stored value
 * (`baseline`: the language's current Working Draft, else its verified base).
 * A key it sends sets the value; an empty `seo` or an empty `cardExcerpt`
 * clears it. `content` is the descriptor's localized fields plus slices.
 */
export function applyPerLanguageInput(
  content: Record<string, unknown>,
  input: { seo?: unknown; cardExcerpt?: string | undefined },
  baseline: Record<string, unknown> | undefined
): Record<string, unknown> {
  const next = { ...content }
  if (input.seo !== undefined) {
    const seo = sanitizeLocalizedSeo(input.seo)
    if (seo) next.seo = seo
  } else if (baseline && isRecord(baseline.seo)) {
    next.seo = baseline.seo
  }
  if (input.cardExcerpt !== undefined) {
    if (input.cardExcerpt.trim() !== "") next.cardExcerpt = input.cardExcerpt
  } else if (baseline && typeof baseline.cardExcerpt === "string") {
    next.cardExcerpt = baseline.cardExcerpt
  }
  return next
}

/**
 * The common per-language fields that sit beside `localized` in every typed
 * draft input arm (ADR-0037 amendment, 2026-11-17): the language's `seo` block
 * and its card excerpt. This is the ONE definition of that set. A save that
 * omits a key keeps the stored value; `applyPerLanguageInput` is the writer.
 */
export const PER_LANGUAGE_DRAFT_KEYS = ["seo", "cardExcerpt"] as const

/**
 * The validator fields every typed draft input arm spreads beside `localized`
 * (`inputShapes.ts`). Keyed by the definition above, so the two cannot drift.
 */
export const perLanguageDraftValidatorFields = {
  seo: v.optional(perLanguageSeoValidator),
  cardExcerpt: v.optional(v.string()),
} as const satisfies Record<(typeof PER_LANGUAGE_DRAFT_KEYS)[number], unknown>

export type PerLanguageDraftFields = {
  seo?: PerLanguageSeo
  cardExcerpt?: string
}

/**
 * The common per-language draft fields of anything that carries them under
 * the stored names: a stored Localized Content or a typed draft. `seoKeys`
 * narrows the `seo` block (default: every key); `cardExcerpt: false` leaves
 * the excerpt out. Blank values are left out, as a save treats them as unset.
 */
export function perLanguageDraftFields(
  source: Record<string, unknown> | undefined,
  options: {
    seoKeys?: readonly (keyof PerLanguageSeo)[]
    cardExcerpt?: boolean
  } = {}
): PerLanguageDraftFields {
  const out: PerLanguageDraftFields = {}
  const seo = sanitizeLocalizedSeo(source?.seo)
  if (seo) {
    const keys = options.seoKeys ?? PER_LANGUAGE_SEO_KEYS
    const picked = Object.fromEntries(
      keys.flatMap((key) => (seo[key] !== undefined ? [[key, seo[key]]] : []))
    )
    if (Object.keys(picked).length > 0) out.seo = picked as PerLanguageSeo
  }
  const excerpt = source?.cardExcerpt
  if (
    options.cardExcerpt !== false &&
    typeof excerpt === "string" &&
    excerpt.trim() !== ""
  )
    out.cardExcerpt = excerpt
  return out
}

/**
 * Stored content -> typed draft input. `localized` is built from the declared
 * descriptor keys only (never from "everything except slices"), the common
 * per-language fields sit beside it, and the slices come from `slices` or the
 * content when the type has a slice body. Which fields an AI job translates is
 * a separate list; this only serializes.
 */
export function draftInputFromContent(args: {
  pageType: string
  localizedKeys: readonly string[]
  sliceBody: boolean
  content: Record<string, unknown>
  slices?: readonly unknown[]
  seoKeys?: readonly (keyof PerLanguageSeo)[]
  cardExcerpt?: boolean
}): Record<string, unknown> {
  const localized: Record<string, unknown> = {}
  for (const key of args.localizedKeys)
    if (args.content[key] !== undefined)
      localized[key] = structuredClone(args.content[key])
  return {
    pageType: args.pageType,
    localized,
    ...perLanguageDraftFields(args.content, {
      seoKeys: args.seoKeys,
      cardExcerpt: args.cardExcerpt,
    }),
    ...(args.sliceBody
      ? { slices: args.slices ?? args.content.slices ?? [] }
      : {}),
  }
}

/** The shared `seo` patch a save may still write: never a moved key. */
export function sharedSeoPatch(
  seo: Record<string, unknown> | undefined
): Record<string, unknown> | undefined {
  if (seo === undefined) return undefined
  return compact(
    Object.fromEntries(
      Object.entries(seo).filter(
        ([key]) => !(LEGACY_SHARED_SEO_KEYS as readonly string[]).includes(key)
      )
    )
  )
}

/**
 * The `siteSettings` fields that record the outgoing default language as the
 * legacy shared language, once. Spread into every patch that changes
 * `defaultLocale`, so the language of the old shared text is fixed before the
 * default changes and never follows it afterwards.
 */
export function recordLegacyLocalePatch(settings: {
  defaultLocale: string
  legacySharedFieldsLocale?: string
}): { legacySharedFieldsLocale?: string } {
  return settings.legacySharedFieldsLocale === undefined
    ? { legacySharedFieldsLocale: settings.defaultLocale }
    : {}
}

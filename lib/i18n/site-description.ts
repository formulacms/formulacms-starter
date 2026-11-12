// Site description per language (M05 amendment A5, F09 2026-11-01 record).
//
// `siteSettings.siteDescriptions` maps a locale code to that language's site
// description. The single legacy value (`siteDescription`) is read as the
// default language's description until it is moved: the move happens at the
// first per-language write, inside the make-default commit, or inside an F09
// activation commit, whichever comes first, and always files the text under
// the OUTGOING default language so a default change never relabels it.
//
// Every function here is pure. The writers spread the returned fields into
// their own single `ctx.db.patch`, so the move happens in the same transaction
// and the same write as the change that needs it.

export type SiteDescriptions = Record<string, string>

export type SiteDescriptionSource = {
  siteDescription?: string
  siteDescriptions?: SiteDescriptions
}

/** Fields a writer spreads into its `siteSettings` patch. */
export type SiteDescriptionFields = {
  siteDescriptions?: SiteDescriptions
  siteDescription?: undefined
}

function textOrUndefined(value: string | undefined): string | undefined {
  return value !== undefined && value.trim().length > 0 ? value : undefined
}

function has(map: SiteDescriptions | undefined, locale: string): boolean {
  return map !== undefined && Object.hasOwn(map, locale)
}

/**
 * The description to show for one language. A stored per-language value wins;
 * the legacy value stands in only for the default language and only until it
 * is moved. Never another language's text.
 */
export function readSiteDescription(
  settings: SiteDescriptionSource & { defaultLocale: string },
  locale: string
): string | undefined {
  if (has(settings.siteDescriptions, locale)) {
    return textOrUndefined(settings.siteDescriptions![locale])
  }
  return locale === settings.defaultLocale
    ? textOrUndefined(settings.siteDescription)
    : undefined
}

/**
 * Move the legacy single value under the outgoing default language and clear
 * it. Returns no fields when there is nothing to move, so existing documents
 * stay byte-identical. A value already stored under that key wins.
 */
export function storeLegacySiteDescription(
  settings: SiteDescriptionSource | null,
  outgoingLocale: string
): SiteDescriptionFields {
  if (!settings || settings.siteDescription === undefined) return {}
  const next: SiteDescriptions = { ...settings.siteDescriptions }
  const legacy = textOrUndefined(settings.siteDescription)
  if (legacy !== undefined && !has(next, outgoingLocale)) {
    next[outgoingLocale] = legacy
  }
  return {
    ...(Object.keys(next).length > 0 ? { siteDescriptions: next } : {}),
    siteDescription: undefined,
  }
}

/**
 * Apply per-language edits on top of the stored map. The legacy value is moved
 * first. An empty (or whitespace-only) text removes that language's key; keys
 * not named are kept, including those of languages that are no longer enabled.
 */
export function mergeSiteDescriptions(
  settings: SiteDescriptionSource | null,
  outgoingLocale: string,
  edits: Readonly<Record<string, string | undefined>>
): SiteDescriptionFields {
  const moved = storeLegacySiteDescription(settings, outgoingLocale)
  const base = moved.siteDescriptions ?? settings?.siteDescriptions
  const next: SiteDescriptions = { ...base }
  for (const [locale, text] of Object.entries(edits)) {
    if (text === undefined) continue
    const value = text.trim()
    if (value.length > 0) next[locale] = value
    else delete next[locale]
  }
  const hadMap = base !== undefined
  return {
    ...moved,
    ...(Object.keys(next).length > 0
      ? { siteDescriptions: next }
      : hadMap
        ? { siteDescriptions: undefined }
        : {}),
  }
}

/**
 * F09 relabel. Swap the values stored under the two keys: a retained target
 * value moves to the source key, an absent value stays absent, nothing is
 * deleted. Returns the same map when neither key holds a value.
 */
export function swapSiteDescriptions(
  descriptions: SiteDescriptions | undefined,
  a: string,
  b: string
): SiteDescriptions | undefined {
  if (!has(descriptions, a) && !has(descriptions, b)) return descriptions
  const next: SiteDescriptions = { ...descriptions }
  const aValue = has(descriptions, a) ? descriptions![a] : undefined
  const bValue = has(descriptions, b) ? descriptions![b] : undefined
  delete next[a]
  delete next[b]
  if (bValue !== undefined) next[a] = bValue
  if (aValue !== undefined) next[b] = aValue
  return next
}

/**
 * The description fields for an F09 activation commit: the legacy value goes
 * under the source language first, then a `correct_label` relabel (or the
 * rollback of one) swaps the source and target values.
 */
export function transitionSiteDescriptionFields(
  settings: SiteDescriptionSource,
  sourceLocale: string,
  targetLocale: string,
  swap: boolean
): SiteDescriptionFields {
  const moved = storeLegacySiteDescription(settings, sourceLocale)
  if (!swap) return moved
  const current = moved.siteDescriptions ?? settings.siteDescriptions
  const swapped = swapSiteDescriptions(current, sourceLocale, targetLocale)
  return swapped === current ? moved : { ...moved, siteDescriptions: swapped }
}

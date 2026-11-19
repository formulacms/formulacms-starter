import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import type { MutationCtx, QueryCtx } from "../../_generated/server"

/**
 * ADR-0037 amendment (2026-11-17): the per-content-type translation switch.
 * `siteSettings.untranslatedContentTypes` lists the types switched to one
 * language, each with the language that stays public. A type's versions in
 * every other enabled language are hidden from public readers; nothing is
 * deleted, and switching back restores them without a republish.
 *
 * One predicate serves the public snapshot reader, the publish and AI
 * translation guards and the redirect readers, so they cannot disagree.
 */

export const CONTENT_TYPE_TRANSLATION_OFF = "CONTENT_TYPE_TRANSLATION_OFF"

type SwitchSettings = Pick<
  Doc<"siteSettings">,
  "untranslatedContentTypes" | "enabledLocales" | "homePageId"
>

/** The entry that switches `pageType` to one language, or undefined. */
export function untranslatedEntryFor(
  settings: Pick<Doc<"siteSettings">, "untranslatedContentTypes"> | null,
  pageType: string
): { pageType: string; locale: string } | undefined {
  return settings?.untranslatedContentTypes?.find(
    (entry) => entry.pageType === pageType
  )
}

/**
 * True when a visitor must not see this page in `locale`: its type is
 * switched to one language, that language is still enabled, `locale` is
 * another language, and the page is not the Home page (Home stays in every
 * language). An entry whose language is no longer enabled has no effect.
 */
export function isHiddenByTranslationSwitch(
  settings: SwitchSettings | null,
  page: { pageId: Id<"pages">; pageType: string },
  locale: string
): boolean {
  if (!settings) return false
  const entry = untranslatedEntryFor(settings, page.pageType)
  if (!entry) return false
  return (
    settings.enabledLocales?.includes(entry.locale) === true &&
    locale !== entry.locale &&
    settings.homePageId !== page.pageId
  )
}

/** Publish and AI translation into a hidden language are refused. */
export async function assertPageTypeTranslatedIn(
  ctx: QueryCtx | MutationCtx,
  page: { pageId: Id<"pages">; pageType: string },
  locale: string,
  settings?: SwitchSettings | null
): Promise<void> {
  const resolved = settings ?? (await ctx.db.query("siteSettings").first())
  if (isHiddenByTranslationSwitch(resolved, page, locale)) {
    throw new ConvexError(CONTENT_TYPE_TRANSLATION_OFF)
  }
}

/**
 * Same refusal for a page known by id: a running or stopped AI translation job
 * must not translate, resume or spend into a language where the page's type is
 * switched to another language. A page that no longer exists is not refused
 * here; the job's own source checks handle it.
 */
export async function assertPageIdTranslatedIn(
  ctx: QueryCtx | MutationCtx,
  pageId: Id<"pages">,
  locale: string
): Promise<void> {
  const settings = await ctx.db.query("siteSettings").first()
  if (!settings?.untranslatedContentTypes?.length) return
  const page = await ctx.db.get("pages", pageId)
  if (!page) return
  await assertPageTypeTranslatedIn(
    ctx,
    { pageId, pageType: page.pageType },
    locale,
    settings
  )
}

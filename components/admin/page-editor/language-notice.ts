import { getLocaleDisplayName } from "@/lib/i18n/config"

export type SourcePublicationNotice = {
  sourceLocale: string
  targetLocale: string
  sharedChangedSinceSourcePublication: boolean
} | null

type LanguageChangeMessageKey =
  keyof (typeof import("@/messages/admin/en.json"))["editor"]["page"]["languageChange"]
export type LanguageChangeTranslator = (
  key: LanguageChangeMessageKey,
  values?: { source: string; target: string }
) => string

/**
 * F09 contract "Replace content": during a replacement the editor says where
 * shared fields are edited that they are the same in every language. When the
 * owner writes the new-language version it also says that version is private
 * and needs confirming again. Returns the lines to show, or null.
 */
export function languageChangeEditorNotice(
  notice: SourcePublicationNotice | undefined,
  writingTarget: boolean,
  t: LanguageChangeTranslator
): string[] | null {
  if (!notice) return null
  const source = getLocaleDisplayName(notice.sourceLocale)
  const target = getLocaleDisplayName(notice.targetLocale)
  const values = { source, target }
  const shared = t("sharedFields", values)
  if (!writingTarget) {
    return [t("sourceNotice", values), shared]
  }
  return [t("targetNotice", values), t("confirmAgain"), shared]
}

/**
 * F09 contract proof row 39. Shared Draft values are the same in every
 * language, so during a replacement a source publication publishes whatever
 * the Shared Draft holds, including text typed in the new language. Returns
 * the confirmation to show before publishing, or null when none is needed.
 */
export function sourcePublicationWarning(
  notice: SourcePublicationNotice | undefined,
  t: LanguageChangeTranslator
): { title: string; description: string; confirmText: string } | null {
  if (!notice?.sharedChangedSinceSourcePublication) return null
  const source = getLocaleDisplayName(notice.sourceLocale)
  const target = getLocaleDisplayName(notice.targetLocale)
  return {
    title: t("publishTitle"),
    description: t("publishDescription", { source, target }),
    confirmText: t("publishAnyway"),
  }
}

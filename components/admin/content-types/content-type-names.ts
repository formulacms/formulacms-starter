"use client"

import { useLocale, useTranslations } from "next-intl"
import {
  adminContentTypePluralMessageKey,
  adminContentTypes,
} from "@/lib/admin/content-types"

/** Interface languages that write a common noun in lower case mid-sentence. */
const LOWER_CASE_NOUN_LOCALES = new Set(["fr"])

/**
 * A content type's plural name for use inside a sentence, as `{ type }`:
 * "Translate Posts" in English, "Traduire les articles" in French.
 */
export function useContentTypeSentenceNames() {
  const t = useTranslations("sidebar.contentType")
  const locale = useLocale()
  return (type: string) => {
    const key = adminContentTypePluralMessageKey(type)
    const summary = adminContentTypes().find((entry) => entry.type === type)
    const name = key ? t(key) : summary?.plural || summary?.singular || type
    return {
      type: LOWER_CASE_NOUN_LOCALES.has(locale)
        ? name.toLocaleLowerCase(locale)
        : name,
    }
  }
}

/** "Not shown on the site: translation is off for Posts." */
export function useTranslationOffMessage() {
  const t = useTranslations("editor.pageSave.publication")
  const names = useContentTypeSentenceNames()
  return (pageType: string) => t("translationOff", names(pageType))
}

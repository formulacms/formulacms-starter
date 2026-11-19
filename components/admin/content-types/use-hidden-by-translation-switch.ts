"use client"

import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { isHiddenByTranslationSwitch } from "@/convex/lib/publishing/translationSwitch"

/**
 * True when the content type's translation switch hides this language version
 * from the site (ADR-0037 amendment, 2026-11-17). The server's own rule: the
 * kept language and the Home page stay public, and an entry whose language is
 * no longer enabled has no effect. False while the switch is loading.
 */
export function useHiddenByTranslationSwitch({
  pageId,
  pageType,
  locale,
  enabledLocales,
  homePageId,
}: {
  pageId: Id<"pages">
  pageType: string
  locale: string
  enabledLocales: string[]
  homePageId: string | null | undefined
}): boolean {
  const entries = useQuery(
    api.cms.contentTypes.getUntranslatedContentTypes,
    enabledLocales.length > 1 ? {} : "skip"
  )
  if (!entries) return false
  return isHiddenByTranslationSwitch(
    {
      untranslatedContentTypes: entries,
      enabledLocales,
      homePageId: (homePageId ?? undefined) as Id<"pages"> | undefined,
    },
    { pageId, pageType },
    locale
  )
}

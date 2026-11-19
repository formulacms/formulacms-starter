"use client"

import { useState } from "react"
import { useConvex, useMutation, useQuery } from "convex/react"
import { useLocale, useTranslations } from "next-intl"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { ContentType } from "@/convex/lib/contentTypes"
import { useModuleGate } from "@/components/admin/admin-module-state-provider"
import { languagesErrorMessage } from "@/components/admin/languages/errors"
import { hasErrorCode } from "@/components/admin/pages-list-errors"
import { useConfirm } from "@/components/providers/confirm-provider"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { useContentTypeSentenceNames } from "./content-type-names"

/** A language name inside a sentence, in the interface language. */
function languageInSentence(code: string, interfaceLocale: string): string {
  try {
    return (
      new Intl.DisplayNames([interfaceLocale], { type: "language" }).of(code) ??
      code
    )
  } catch {
    return code
  }
}

/** The confirm lines, in order, with the impact count each one reads. */
const TURN_OFF_LINES = [
  ["versions", "hiddenVersions"],
  ["links", "linkingPages"],
  ["children", "childPages"],
] as const

/**
 * ADR-0037 amendment (2026-11-17): the translation switch of one content type.
 * Shown only while the Multilingual module is on. The control copies the
 * Modules page checkbox; turning translation off asks first and says what
 * gets hidden, turning it on does not ask.
 */
export function ContentTypeLanguagesCard({ type }: { type: ContentType }) {
  const t = useTranslations("inventory.contentTypes.languages")
  const tLanguages = useTranslations("settings.multilingualLanguages")
  const interfaceLocale = useLocale()
  const names = useContentTypeSentenceNames()(type)
  const multilingual = useModuleGate("multilingual").state === "on"
  const entries = useQuery(
    api.cms.contentTypes.getUntranslatedContentTypes,
    multilingual ? {} : "skip"
  )
  const config = useQuery(
    api.cms.settings.getSiteConfig,
    multilingual ? {} : "skip"
  )
  const setTranslation = useMutation(
    api.cms.contentTypes.setContentTypeTranslation
  )
  const convex = useConvex()
  const confirm = useConfirm()
  const [pending, setPending] = useState(false)

  if (!multilingual) return null
  const ready = entries !== undefined && config !== undefined
  // An entry whose language is no longer enabled has no effect.
  const entry = entries?.find(
    (candidate) =>
      candidate.pageType === type &&
      config?.enabledLocales.includes(candidate.locale)
  )
  const translate = entry === undefined

  function refusalMessage(error: unknown): string {
    return hasErrorCode(error, "PAGE_PURGE_IN_PROGRESS")
      ? t("errors.purgeRunning")
      : languagesErrorMessage(tLanguages, error)
  }

  async function askTurnOff(): Promise<boolean> {
    const impact = await convex.query(
      api.cms.contentTypes.getContentTypeTranslationImpact,
      { pageType: type }
    )
    // A line whose count is 0 is left out; a capped count shows "N+".
    const description = TURN_OFF_LINES.filter(
      ([, key]) => impact[key].count > 0
    )
      .map(([line, key]) =>
        t(`turnOff.${line}`, {
          ...names,
          count: impact[key].count,
          shown: impact[key].capped
            ? `${impact[key].count}+`
            : String(impact[key].count),
        })
      )
      .join("\n")
    return confirm({
      title: t("turnOff.title", {
        ...names,
        language: languageInSentence(impact.keptLocale, interfaceLocale),
      }),
      ...(description ? { description } : {}),
      confirmText: t("turnOff.confirm"),
    })
  }

  async function toggle() {
    if (!ready || pending) return
    setPending(true)
    const outcome = await (translate ? askTurnOff() : Promise.resolve(true))
      .then(async (confirmed) => {
        if (confirmed)
          await setTranslation({ pageType: type, translated: !translate })
        return null
      })
      .catch((error: unknown) => error)
    setPending(false)
    if (outcome !== null) toast.error(refusalMessage(outcome))
  }

  return (
    <Card data-testid="languages-card">
      <CardHeader>
        <CardTitle className="text-base">{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <label className="flex items-center gap-2 text-sm font-medium">
          <input
            type="checkbox"
            checked={translate}
            disabled={!ready || pending}
            onChange={() => void toggle()}
            className="size-4 accent-primary"
          />
          <span>{t("toggle", names)}</span>
        </label>
        {ready && (
          <p className="text-sm text-muted-foreground">
            {entry
              ? t("off", {
                  ...names,
                  language: languageInSentence(entry.locale, interfaceLocale),
                })
              : t("on", names)}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

"use client"

import { usePaginatedQuery, useMutation, useQuery } from "convex/react"
import { useTranslations } from "next-intl"
import { api } from "@/convex/_generated/api"
import { readSiteDescription } from "@/lib/i18n/site-description"
import { LanguagesScreen } from "./languages/languages-screen"
import type {
  DefaultReadiness,
  LanguagesActions,
  LanguagesQueries,
} from "./languages/types"

// ─── Reads ──────────────────────────────────────────────────────────────────

function useImpactPage(args: Parameters<LanguagesQueries["useImpactPage"]>[0]) {
  return useQuery(api.cms.multilingual.listLanguageImpact, args)
}

function useDefaultRoutes(
  args: Parameters<LanguagesQueries["useDefaultRoutes"]>[0]
) {
  return usePaginatedQuery(
    api.cms.multilingual.listDefaultLanguageRoutes,
    { ...args, filter: "all" },
    { initialNumItems: 20 }
  )
}

function useMigrationDisclosure(
  args: Parameters<LanguagesQueries["useMigrationDisclosure"]>[0]
) {
  return useQuery(api.cms.multilingual.listDefaultMigrationDisclosure, args)
}

/**
 * Only the site description is known from an existing read. The home page and
 * menu rows stay advice (`null`); the server still refuses the change with a
 * plain message when either is missing.
 */
function useDefaultReadiness(
  locale: string | null
): DefaultReadiness | undefined {
  const settings = useQuery(api.cms.settings.getSettings)
  if (settings === undefined || locale === null) return undefined
  return {
    homePublished: null,
    menuText: null,
    siteDescription:
      settings === null
        ? null
        : readSiteDescription(settings, locale) !== undefined,
  }
}

/**
 * Advisory: whether adding this language needs a reviewed preview first.
 * Skipped until a language is picked. A refusal (unsupported, already added,
 * invalid setup) throws while rendering; the add dialog catches it.
 */
function useNeedsReviewToAddLanguage(locale: string | null) {
  return useQuery(
    api.cms.multilingual.needsReviewToAddLanguage,
    locale === null ? "skip" : { locale }
  )
}

function useMenuTextMissing(locales: string[]) {
  return useQuery(
    api.cms.menus.countMenuTextMissing,
    locales.length === 0 ? "skip" : { locales }
  )
}

const queries: LanguagesQueries = {
  useMenuTextMissing,
  useNeedsReviewToAddLanguage,
  useImpactPage,
  useDefaultRoutes,
  useMigrationDisclosure,
  useDefaultReadiness,
}

// ─── Writes ─────────────────────────────────────────────────────────────────

function useActions(): LanguagesActions {
  const settings = useQuery(api.cms.settings.getSettings)
  const updateSettings = useMutation(api.cms.settings.updateSettings)
  const addSiteLanguage = useMutation(api.cms.multilingual.addSiteLanguage)
  const prepareLanguageReview = useMutation(
    api.cms.multilingual.prepareLanguageReview
  )
  const prepareLanguageChange = useMutation(
    api.cms.multilingual.prepareLanguageChange
  )
  const removeLastExtraLanguage = useMutation(
    api.cms.multilingual.removeLastExtraLanguage
  )
  const setDefaultLanguage = useMutation(
    api.cms.multilingual.setDefaultLanguage
  )
  const addLanguage = useMutation(api.cms.multilingual.addLanguage)
  const removeLanguage = useMutation(api.cms.multilingual.removeLanguage)
  const startPreview = useMutation(
    api.cms.multilingual.startLanguageImpactPreview
  )
  const recordReview = useMutation(
    api.cms.multilingual.recordLanguageImpactReview
  )
  const startMigration = useMutation(
    api.cms.multilingual.startDefaultLanguageMigration
  )
  const continueMigration = useMutation(
    api.cms.multilingual.continueDefaultLanguageMigration
  )
  const recordMigrationReview = useMutation(
    api.cms.multilingual.recordDefaultMigrationReview
  )
  const activateMigration = useMutation(
    api.cms.multilingual.activateDefaultLanguageMigration
  )
  const cancelMigration = useMutation(
    api.cms.multilingual.cancelDefaultLanguageMigration
  )
  return {
    addSiteLanguage,
    prepareLanguageReview,
    prepareLanguageChange,
    removeLastExtraLanguage,
    setDefaultLanguage,
    addLanguage,
    removeLanguage,
    startLanguageImpactPreview: startPreview,
    recordLanguageImpactReview: recordReview,
    startDefaultLanguageMigration: startMigration,
    continueDefaultLanguageMigration: continueMigration,
    recordDefaultMigrationReview: recordMigrationReview,
    activateDefaultLanguageMigration: activateMigration,
    cancelDefaultLanguageMigration: cancelMigration,
    copySiteDescription: async ({ fromLocale, toLocale }) => {
      const text = settings
        ? readSiteDescription(settings, fromLocale)
        : undefined
      if (text === undefined) return { copied: false }
      await updateSettings({ siteDescriptions: { [toLocale]: text } })
      return { copied: true }
    },
  }
}

// ─── Container ──────────────────────────────────────────────────────────────

/** Settings > Languages: reads the site's language state and hands the screen its data and actions. */
export function LanguagesSettings() {
  const tCommon = useTranslations("settings.common")
  const state = useQuery(api.cms.multilingual.getMultilingualState, {})
  const settings = useQuery(api.cms.settings.getSettings)
  const actions = useActions()

  if (state === undefined || settings === undefined) {
    return (
      <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
        {tCommon("loading")}
      </div>
    )
  }

  return <LanguagesScreen state={state} actions={actions} queries={queries} />
}

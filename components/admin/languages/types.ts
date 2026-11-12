import type { FunctionArgs, FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"

/**
 * The Languages screen's data and actions, as one props contract.
 *
 * Everything below mirrors `convex/cms/multilingual.ts`: the existing
 * commands are typed from their generated references, and the four combined
 * commands plus `needsReviewToAddLanguage` follow the frozen L2a API
 * (`commandTokens`, `addSiteLanguage`, `prepareLanguageReview`,
 * `prepareLanguageChange`, `removeLastExtraLanguage`). Settings Apply now
 * belongs to `modules.commit`. The screen never
 * imports a Convex reference: the container (`multilingual-languages-settings`)
 * wires these props to Convex.
 */
type Multilingual = typeof api.cms.multilingual

// ─── State ──────────────────────────────────────────────────────────────────

/**
 * Version tokens the owner commands compare against. `authorityVersion: null`
 * means there is no authority row yet (never version 0). `settingsUpdatedAt`
 * is null only when no settings document exists.
 */
export type CommandTokens = {
  settingsUpdatedAt: number | null
  moduleConfigurationVersion: number
  authorityVersion: number | null
}

export type LanguagesState = FunctionReturnType<
  Multilingual["getMultilingualState"]
>

export type ImpactPreview = LanguagesState["latestPreviews"][number]
export type DefaultMigration = NonNullable<LanguagesState["defaultMigration"]>

export type ImpactPage = Exclude<
  FunctionReturnType<Multilingual["listLanguageImpact"]>,
  { stale: true }
>
export type DisclosureItem = ImpactPage["items"][number]
/** A review page, or `{ stale: true }` when the review was replaced. */
export type ImpactPageResult = FunctionReturnType<
  Multilingual["listLanguageImpact"]
>
export type DisclosurePageResult = FunctionReturnType<
  Multilingual["listDefaultMigrationDisclosure"]
>
export type DefaultRoute = FunctionReturnType<
  Multilingual["listDefaultLanguageRoutes"]
>["page"][number]

export type PreviewCommitClaim = FunctionArgs<Multilingual["removeLanguage"]>

// ─── New commands (L2a) ─────────────────────────────────────────────────────

export type NeedsReviewReason = "reveal" | "shadowsDefaultPath"
export type NeedsReviewResult = {
  needsReview: boolean
  reasons: NeedsReviewReason[]
}

type TokenArgs = {
  expectedSettingsUpdatedAt: number | null
  expectedModuleConfigurationVersion: number
  expectedAuthorityVersion: number | null
}

export type AddSiteLanguageArgs = TokenArgs & {
  locale: string
  preview?: PreviewCommitClaim
}
// B1: structured results (`ok: false` for a stale token or an address conflict).
export type AddSiteLanguageResult = FunctionReturnType<
  Multilingual["addSiteLanguage"]
>

export type PrepareLanguageReviewArgs = TokenArgs & { locale: string }
export type PrepareLanguageReviewResult = {
  authorityVersion: number
  moduleConfigurationVersion: number
  settingsUpdatedAt: number
  defaultLocale: string
  enabledLocales: string[]
  /** True when cancelling must return the site to one language. */
  cancelReturnsToOneLanguage: boolean
}

export type PrepareLanguageChangeResult = {
  authorityVersion: number
  moduleConfigurationVersion: number
  settingsUpdatedAt: number
  defaultLocale: string
  enabledLocales: string[]
}

export type RemoveLastExtraLanguageResult = {
  authorityVersion: number
  moduleConfigurationVersion: number
  locale: string
  removedLocale: string
}

// ─── Screen props ───────────────────────────────────────────────────────────

/**
 * What the Make default checklist knows about the language being promoted.
 * `null` means unknown: the row is shown as advice and the server still
 * checks when the change starts.
 */
export type DefaultReadiness = {
  homePublished: boolean | null
  menuText: boolean | null
  siteDescription: boolean | null
}

export type LanguagesActions = {
  // New combined commands (L2a)
  addSiteLanguage(args: AddSiteLanguageArgs): Promise<AddSiteLanguageResult>
  prepareLanguageReview(
    args: PrepareLanguageReviewArgs
  ): Promise<PrepareLanguageReviewResult>
  prepareLanguageChange(args: TokenArgs): Promise<PrepareLanguageChangeResult>
  removeLastExtraLanguage(
    claim: PreviewCommitClaim
  ): Promise<RemoveLastExtraLanguageResult>
  /** The silent default change: one command, refusals in plain words. */
  setDefaultLanguage(
    args: FunctionArgs<Multilingual["setDefaultLanguage"]>
  ): Promise<FunctionReturnType<Multilingual["setDefaultLanguage"]>>
  // Existing commands
  addLanguage(
    args: FunctionArgs<Multilingual["addLanguage"]>
  ): Promise<FunctionReturnType<Multilingual["addLanguage"]>>
  removeLanguage(
    claim: PreviewCommitClaim
  ): Promise<FunctionReturnType<Multilingual["removeLanguage"]>>
  startLanguageImpactPreview(
    args: FunctionArgs<Multilingual["startLanguageImpactPreview"]>
  ): Promise<FunctionReturnType<Multilingual["startLanguageImpactPreview"]>>
  recordLanguageImpactReview(
    args: FunctionArgs<Multilingual["recordLanguageImpactReview"]>
  ): Promise<FunctionReturnType<Multilingual["recordLanguageImpactReview"]>>
  startDefaultLanguageMigration(
    args: FunctionArgs<Multilingual["startDefaultLanguageMigration"]>
  ): Promise<
    FunctionReturnType<Multilingual["startDefaultLanguageMigration"]>
  >
  continueDefaultLanguageMigration(
    args: FunctionArgs<Multilingual["continueDefaultLanguageMigration"]>
  ): Promise<unknown>
  recordDefaultMigrationReview(
    args: FunctionArgs<Multilingual["recordDefaultMigrationReview"]>
  ): Promise<FunctionReturnType<Multilingual["recordDefaultMigrationReview"]>>
  activateDefaultLanguageMigration(
    args: FunctionArgs<Multilingual["activateDefaultLanguageMigration"]>
  ): Promise<unknown>
  cancelDefaultLanguageMigration(
    args: FunctionArgs<Multilingual["cancelDefaultLanguageMigration"]>
  ): Promise<unknown>
  /**
   * Puts the current default language's site description into `toLocale`
   * (an existing settings command). Menu text has no one-step command, so the
   * checklist shows it as advice.
   */
  copySiteDescription(args: {
    fromLocale: string
    toLocale: string
  }): Promise<{ copied: boolean }>
}

/** Reactive reads, passed in as hooks so the screen stays free of Convex. */
export type LanguagesQueries = {
  useNeedsReviewToAddLanguage(
    locale: string | null
  ): NeedsReviewResult | undefined
  useImpactPage(
    args: { previewId: ImpactPreview["previewId"]; ordinal: number } | "skip"
  ): ImpactPageResult | undefined
  useDefaultRoutes(args: {
    migrationId: DefaultMigration["migrationId"]
    generation: number
  }): {
    results: DefaultRoute[]
    status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
    loadMore(count: number): void
  }
  useMigrationDisclosure(
    args:
      | {
          migrationId: DefaultMigration["migrationId"]
          generation: number
          ordinal: number
        }
      | "skip"
  ): DisclosurePageResult | undefined
  useDefaultReadiness(locale: string | null): DefaultReadiness | undefined
  /** Menu items with no text yet, per language: a quiet status, never a block. */
  useMenuTextMissing(
    locales: string[]
  ): Record<string, number> | undefined
}

export type LanguagesScreenProps = {
  state: LanguagesState
  actions: LanguagesActions
  queries: LanguagesQueries
}

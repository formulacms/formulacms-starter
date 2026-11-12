import { useOptionalContributionRun } from "../optional-contribution"
import { moduleFailureState } from "../module-gate"
import { ConvexError } from "convex/values"
import type { useTranslations } from "next-intl"

type MultilingualMessages =
  (typeof import("../../../messages/admin/en.json"))["settings"]["multilingualLanguages"]
export type LanguagesErrorKey = Extract<
  keyof MultilingualMessages["errors"],
  string
>
export type Translate = ReturnType<
  typeof useTranslations<"settings.multilingualLanguages">
>

export function errorCode(error: unknown): string | null {
  if (error instanceof ConvexError && typeof error.data === "string") {
    return error.data
  }
  return error instanceof Error ? error.message : null
}

/** Server refusal codes that have their own plain-words message, in order. */
const ERROR_CODES: ReadonlyArray<readonly [string, LanguagesErrorKey]> = [
  ["SITE_LANGUAGE_VERSION_CHANGED", "stale"],
  ["LANGUAGE_OPERATION_STALE", "stale"],
  ["CMS_MODULE_CONFIGURATION_STALE", "stale"],
  ["LANGUAGE_PREVIEW_MISMATCH", "stale"],
  ["LANGUAGE_PREVIEW_REQUIRED", "reviewRequired"],
  ["LANGUAGE_OPERATION_OPEN", "operationOpen"],
  ["LANGUAGE_TRANSITION_OPEN", "operationOpen"],
  ["LANGUAGE_PREVIEW_REVIEW_INCOMPLETE", "reviewIncomplete"],
  ["DEFAULT_MIGRATION_REVIEW_INCOMPLETE", "reviewIncomplete"],
  ["LANGUAGE_LOCALE_OBLIGATIONS_PRESENT", "scheduledWork"],
  ["DEFAULT_MIGRATION_TARGET_HOME_MISSING", "homeMissing"],
  ["DEFAULT_MIGRATION_SUPERSEDED", "stale"],
  ["LANGUAGE_OPERATION_REQUIRES_SNAPSHOT_AUTHORITY", "notReady"],
  ["LOCALE_NOT_ENABLED", "notLastExtra"],
  ["LOCALE_IS_DEFAULT", "notLastExtra"],
  ["DEFAULT_MIGRATION_MENU_TEXT_MISSING", "menuText"],
  ["DEFAULT_MIGRATION_ROUTE_PATH_TOO_LONG", "addressTooLong"],
  ["LOCALE_ALREADY_ENABLED", "alreadyAdded"],
  ["LOCALE_UNSUPPORTED", "unsupported"],
  ["LANGUAGE_NOT_LAST_EXTRA", "notLastExtra"],
  ["MULTILINGUAL_NOT_ADOPTED", "notReady"],
  ["CMS_MODULE_DISABLED", "moduleOff"],
  ["MULTILINGUAL_MODULE_NOT_ENABLED", "moduleOff"],
  ["SITE_LANGUAGE_AUTHORITY_INVALID", "invalid"],
]

export function languagesErrorMessage(t: Translate, error: unknown): string {
  const code = errorCode(error) ?? ""
  const match = ERROR_CODES.find(([fragment]) => code.includes(fragment))
  return t(`errors.${match ? match[1] : "generic"}`)
}

/** Known domain refusals retain their existing toast; transport failures are contained. */
export function isLanguageDomainRefusal(error: unknown): boolean {
  const code = errorCode(error)
  return (
    code !== null && ERROR_CODES.some(([fragment]) => code.includes(fragment))
  )
}

export function useLanguageRun(): ReturnType<
  typeof useOptionalContributionRun
> {
  const containedRun = useOptionalContributionRun()
  return async function run<T>(
    work: () => T | Promise<T>
  ): Promise<T | undefined> {
    const outcome = await containedRun(async () => {
      try {
        return { value: await work() }
      } catch (error) {
        if (
          moduleFailureState(error) !== "error" ||
          !isLanguageDomainRefusal(error)
        )
          throw error
        return { error }
      }
    })
    if (outcome && "error" in outcome) throw outcome.error
    return outcome?.value
  }
}

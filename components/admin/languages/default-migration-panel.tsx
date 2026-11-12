"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { DialogFooter } from "@/components/ui/dialog"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { useLanguageRun, languagesErrorMessage, type Translate } from "./errors"
import { recordReceipts, ReviewList, useReviewPages } from "./impact-review"
import type {
  DefaultMigration,
  LanguagesActions,
  LanguagesQueries,
} from "./types"

/** How long a background step may show no progress before Continue appears. */
export const STALL_AFTER_MS = 30_000
const ACTIVATION_ABORTED = Symbol("activation-aborted")

function migrationPhaseMessage(
  t: Translate,
  phase: DefaultMigration["phase"]
): string {
  switch (phase) {
    case "enumerating":
      return t("migration.phase.enumerating")
    case "validating":
      return t("migration.phase.validating")
    case "ready":
      return t("migration.phase.ready")
    default:
      // Preserve next-intl's configured dotted-key fallback for terminal
      // phases, which this open-migration panel does not normally render.
      return `settings.multilingualLanguages.migration.phase.${phase}`
  }
}

/**
 * True once a background step has shown no new progress for a while. The
 * server keeps stepping by itself, so Continue stays hidden until then.
 */
function useStalled(migration: DefaultMigration): boolean {
  const working =
    migration.phase === "enumerating" || migration.phase === "validating"
  const signature = `${migration.phase}:${migration.generation}:${JSON.stringify(
    migration.counts
  )}`
  const [stalledSignature, setStalledSignature] = useState<string | null>(null)
  useEffect(() => {
    if (!working) return
    const timer = setTimeout(() => setStalledSignature(signature), STALL_AFTER_MS)
    return () => clearTimeout(timer)
  }, [working, signature])
  return working && stalledSignature === signature
}

/**
 * The address and page review for an open default-language change: today's
 * panel, moved into the Make default dialog.
 */
export function DefaultMigrationPanel({
  migration,
  authorityVersion,
  queries,
  actions,
  onFinished,
}: {
  migration: DefaultMigration
  authorityVersion: number | null
  queries: Pick<
    LanguagesQueries,
    "useDefaultRoutes" | "useMigrationDisclosure"
  >
  actions: Pick<
    LanguagesActions,
    | "continueDefaultLanguageMigration"
    | "activateDefaultLanguageMigration"
    | "cancelDefaultLanguageMigration"
    | "recordDefaultMigrationReview"
  >
  /** Called after the change was made or stopped. */
  onFinished: () => void
}) {
  const t = useTranslations("settings.multilingualLanguages")
  const runOptional = useLanguageRun()
  const routes = queries.useDefaultRoutes({
    migrationId: migration.migrationId,
    generation: migration.generation,
  })
  const stalled = useStalled(migration)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const review = useReviewPages(
    migration.disclosurePageCount,
    migration.reviewedThroughOrdinal + 1
  )
  const canActivate =
    migration.phase === "ready" &&
    migration.readinessVersion !== null &&
    review.status.ready &&
    authorityVersion !== null
  const toLanguage = getLocaleDisplayName(migration.toLocale)

  async function run(
    action: () => Promise<unknown>,
    success: string,
    finished: boolean
  ) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      const outcome = await runOptional(async () => ({ value: await action() }))
      if (!outcome || outcome.value === ACTIVATION_ABORTED) return
      if (outcome.value === "stale") {
        setError(t("errors.stale"))
        return
      }
      toast.success(success)
      if (finished) onFinished()
    } catch (caught) {
      setError(languagesErrorMessage(t, caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div>
        <p className="text-sm font-medium">
          {t("migration.title", {
            from: getLocaleDisplayName(migration.fromLocale),
            to: toLanguage,
          })}
        </p>
        <p className="mt-1 text-xs text-muted-foreground">
          {migrationPhaseMessage(t, migration.phase)}
        </p>
      </div>
      <p className="text-sm">
        {t("migration.summary", {
          addresses: migration.counts.rows,
          collisions:
            migration.counts.shadowedByCurrent +
            migration.counts.shadowedByHistorical +
            migration.counts.manualRulesShadowed,
          blockers: migration.counts.blockers,
        })}
      </p>
      {migration.counts.blockers > 0 && (
        <p role="alert" className="text-sm text-destructive">
          {t("migration.blocked")}
        </p>
      )}
      <div className="space-y-2">
        <h3 className="text-sm font-medium">{t("migration.addresses")}</h3>
        {routes.results.length === 0 &&
        routes.status !== "LoadingFirstPage" ? (
          <p className="text-sm text-muted-foreground">
            {t("migration.noAddresses")}
          </p>
        ) : (
          <ul className="max-h-48 space-y-2 overflow-y-auto text-sm">
            {routes.results.map((route) => (
              <li
                key={`${route.fromPath}:${route.pageId}`}
                className="rounded-md border px-3 py-2"
              >
                {route.shadow
                  ? t("migration.routeShadowed", {
                      path: route.fromPath,
                      language: toLanguage,
                      oldLanguage: getLocaleDisplayName(route.locale),
                    })
                  : route.retiredAt
                    ? t("migration.routeRetired", { path: route.fromPath })
                    : t("migration.routeRedirect", {
                        path: route.fromPath,
                        locale: route.locale,
                      })}
              </li>
            ))}
          </ul>
        )}
        {routes.status === "CanLoadMore" && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => routes.loadMore(20)}
          >
            {t("showMore")}
          </Button>
        )}
      </div>

      <div className="space-y-3">
        <h3 className="text-sm font-medium">{t("migration.reviewTitle")}</h3>
        <ReviewList
          pageCount={migration.disclosurePageCount}
          usePage={queries.useMigrationDisclosure}
          pageArgs={(ordinal) => ({
            migrationId: migration.migrationId,
            generation: migration.generation,
            ordinal,
          })}
          review={review}
        />
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <DialogFooter className="flex-wrap gap-2">
        {stalled && (
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={() =>
              void run(
                () =>
                  actions.continueDefaultLanguageMigration({
                    migrationId: migration.migrationId,
                    expectedGeneration: migration.generation,
                  }),
                t("migration.continued"),
                false
              )
            }
          >
            {t("migration.continue")}
          </Button>
        )}
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() =>
            void run(
              () =>
                actions.cancelDefaultLanguageMigration({
                  migrationId: migration.migrationId,
                  expectedGeneration: migration.generation,
                }),
              t("migration.cancelled"),
              true
            )
          }
        >
          {t("migration.cancel")}
        </Button>
        <Button
          type="button"
          disabled={busy || !canActivate}
          onClick={() =>
            void run(
              async () => {
                const recorded = await recordReceipts(
                  review.status.receipts,
                  (receipt) =>
                    runOptional(() => actions.recordDefaultMigrationReview({
                      migrationId: migration.migrationId,
                      expectedGeneration: migration.generation,
                      ordinal: receipt.ordinal,
                      pageDigest: receipt.pageDigest,
                    })).then((result) => result ?? { stale: true as const })
                )
                if (!recorded) return "stale" as const
                const activated = await runOptional(async () => {
                  await actions.activateDefaultLanguageMigration({
                    migrationId: migration.migrationId,
                    expectedGeneration: migration.generation,
                    expectedReadinessVersion: migration.readinessVersion!,
                    expectedAuthorityVersion: authorityVersion!,
                  })
                  return { done: true }
                })
                if (activated === undefined) return ACTIVATION_ABORTED
              },
              t("migration.activated", { language: toLanguage }),
              true
            )
          }
        >
          {t("migration.activate", { language: toLanguage })}
        </Button>
      </DialogFooter>
    </div>
  )
}

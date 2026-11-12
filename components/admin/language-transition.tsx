"use client"

// F09b owner workflow for the one current site language (F09 single-language
// contract). Replaces the retired multi-language settings controls: there are
// no locale tabs, no second enabled language and no public switcher here.
// A ready, reviewed change is switched through the bounded F09c activation,
// bound to the exact authority, settings, generation and readiness it showed.

import { useState } from "react"
import Link from "next/link"
import { useMutation, usePaginatedQuery, useQuery } from "convex/react"
import { ConvexError } from "convex/values"
import { useFormatter, useTranslations } from "next-intl"
import { toast } from "sonner"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { SUPPORTED_LOCALES, getLocaleDisplayName } from "@/lib/i18n/config"

type WorkflowMode = "correct_label" | "replace_content"
type LanguageMessages =
  (typeof import("../../messages/admin/en.json"))["settings"]["languages"]
type LanguageErrorKey = Extract<keyof LanguageMessages["errors"], string>
type Translate = ReturnType<typeof useTranslations<"settings.languages">>

const WORKFLOW_MODES: readonly WorkflowMode[] = [
  "correct_label",
  "replace_content",
]

const ERROR_KEYS = {
  LANGUAGE_TRANSITION_STALE: "stale",
  LANGUAGE_TRANSITION_PAGE_STALE: "stale",
  LANGUAGE_TRANSITION_SOURCE_STALE: "stale",
  LANGUAGE_TRANSITION_NOT_OPEN: "stale",
  LANGUAGE_TRANSITION_PHASE_INVALID: "stale",
  LANGUAGE_TRANSITION_ALREADY_OPEN: "alreadyOpen",
  LANGUAGE_TRANSITION_PENDING_PUBLICATION_OBLIGATIONS: "pending",
  TARGET_LOCALE_HAS_RETAINED_CONTENT: "retained",
  RETAINED_TARGET_REVIEW_STALE: "retainedStale",
  RETAINED_TARGET_DECISION_INVALID: "retainedInvalid",
  RETAINED_TARGET_SELECTION_MUST_BE_WITHDRAWN: "retainedWithdrawFirst",
  LANGUAGE_MULTI_LOCALE_REQUIRES_L01_M05: "multi",
  TARGET_CONFIRMATION_STALE: "confirmationStale",
  PAGE_ANCESTRY_UNAVAILABLE: "ancestry",
  LANGUAGE_TRANSITION_NOT_RESOLVED: "notResolved",
  LANGUAGE_TRANSITION_PREVIEW_UNCONFIRMED: "previewUnconfirmed",
  LANGUAGE_TRANSITION_MENU_TEXT_MISSING: "menuText",
  SITE_LANGUAGE_AUTHORITY_INVALID: "invalid",
  LANGUAGE_TRANSITION_STATE_INVALID: "invalid",
  LOCALE_NOT_ENABLED: "invalid",
} satisfies Record<string, LanguageErrorKey>

/** Plain-language message for a refused language command. */
export function languageErrorMessage(t: Translate, error: unknown): string {
  const code =
    error instanceof ConvexError && typeof error.data === "string"
      ? error.data
      : null
  const matchedKey = code
    ? Object.entries(ERROR_KEYS).find(([errorCode]) => errorCode === code)?.[1]
    : undefined
  const key: LanguageErrorKey = matchedKey ?? "generic"
  return t(`errors.${key}`)
}

export function LanguageTransition() {
  const t = useTranslations("settings.languages")
  const tCommon = useTranslations("settings.common")
  const state = useQuery(api.cms.language.getLanguageState)
  const settings = useQuery(api.cms.settings.getSettings)
  const initialize = useMutation(
    api.cms.language.initializeSiteLanguageAuthority
  )

  async function run(action: () => Promise<unknown>, success?: string) {
    try {
      await action()
      if (success) toast.success(success)
    } catch (error) {
      toast.error(languageErrorMessage(t, error))
    }
  }

  if (state === undefined || settings === undefined) {
    return <Panel>{tCommon("loading")}</Panel>
  }
  if (settings === null) return <Panel>{tCommon("notInitialized")}</Panel>

  return (
    <div className="space-y-4">
      <p className="text-xs text-muted-foreground">{t("adminNote")}</p>
      {state.kind === "invalid" ? (
        <Panel>{t("invalid")}</Panel>
      ) : state.kind === "multilingual" ? (
        <Panel>
          {t("multi", {
            languages: state.enabledLocales.map(getLocaleDisplayName).join(", "),
          })}
        </Panel>
      ) : state.kind === "multi_locale" ? (
        <Panel>
          {t("multi", {
            languages: state.enabledLocales.map(getLocaleDisplayName).join(", "),
          })}
        </Panel>
      ) : state.kind === "uninitialized" ? (
        <div className="space-y-3 rounded-lg border bg-card p-4">
          <p className="text-sm">
            {t("uninitialized", {
              language: getLocaleDisplayName(state.currentLocale ?? ""),
            })}
          </p>
          <Button
            onClick={() => run(() => initialize({}), t("toast.initialized"))}
          >
            {t("initialize")}
          </Button>
        </div>
      ) : state.transition ? (
        <TransitionPanel
          transition={state.transition}
          authorityVersion={state.version ?? 0}
          settingsUpdatedAt={settings.updatedAt}
          run={run}
        />
      ) : (
        <StartPanel
          currentLocale={state.currentLocale ?? ""}
          authorityVersion={state.version ?? 0}
          settingsUpdatedAt={settings.updatedAt}
          run={run}
        />
      )}
    </div>
  )
}

function Panel({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border bg-card p-6 text-sm text-muted-foreground">
      {children}
    </div>
  )
}

type Run = (action: () => Promise<unknown>, success?: string) => Promise<void>

function StartPanel({
  currentLocale,
  authorityVersion,
  settingsUpdatedAt,
  run,
}: {
  currentLocale: string
  authorityVersion: number
  settingsUpdatedAt: number
  run: Run
}) {
  const t = useTranslations("settings.languages")
  const start = useMutation(api.cms.language.startLanguageTransition)
  const [target, setTarget] = useState("")
  const [mode, setMode] = useState<WorkflowMode | null>(null)
  const choices = SUPPORTED_LOCALES.filter((code) => code !== currentLocale)

  return (
    <div className="divide-y rounded-lg border bg-card">
      <div className="p-4">
        <p className="text-sm font-medium">
          {t("current", { language: getLocaleDisplayName(currentLocale) })}
        </p>
      </div>
      <div className="space-y-4 p-4">
        <h2 className="text-sm font-medium">{t("startHeading")}</h2>
        <label className="block space-y-1">
          <span className="text-xs text-muted-foreground">
            {t("newLanguage")}
          </span>
          <select
            value={target}
            onChange={(event) => setTarget(event.target.value)}
            className="block w-full max-w-xs rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          >
            <option value="">{t("chooseLanguage")}</option>
            {choices.map((code) => (
              <option key={code} value={code}>
                {getLocaleDisplayName(code)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="space-y-2">
          <legend className="mb-1 text-xs text-muted-foreground">
            {t("chooseMode")}
          </legend>
          {WORKFLOW_MODES.map((option) => (
            <div
              key={option}
              className="flex gap-3 rounded-md border bg-background px-3 py-2"
            >
              <input
                id={`language-change-mode-${option}`}
                type="radio"
                name="language-change-mode"
                value={option}
                checked={mode === option}
                onChange={() => setMode(option)}
                className="mt-1"
              />
              <label
                htmlFor={`language-change-mode-${option}`}
                className="cursor-pointer"
              >
                <span className="block text-sm font-medium">
                  {t(`modes.${option}.title`)}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(`modes.${option}.hint`)}
                </span>
              </label>
            </div>
          ))}
        </fieldset>
        <Button
          disabled={!target || !mode}
          onClick={() =>
            mode &&
            run(
              () =>
                start({
                  mode,
                  sourceLocale: currentLocale,
                  targetLocale: target,
                  expectedSettingsUpdatedAt: settingsUpdatedAt,
                  expectedAuthorityVersion: authorityVersion,
                }),
              t("toast.started")
            )
          }
        >
          {t("start")}
        </Button>
      </div>
    </div>
  )
}

type TransitionSummary = NonNullable<
  NonNullable<
    (typeof api.cms.language.getLanguageState)["_returnType"]
  >["transition"]
>

function TransitionPanel({
  transition,
  authorityVersion,
  settingsUpdatedAt,
  run,
}: {
  transition: TransitionSummary
  authorityVersion: number
  settingsUpdatedAt: number
  run: Run
}) {
  const t = useTranslations("settings.languages")
  const continueStep = useMutation(api.cms.language.continueLanguageTransition)
  const validate = useMutation(api.cms.language.validateLanguageTransition)
  const confirmPreview = useMutation(api.cms.language.confirmTransitionPreview)
  const cancel = useMutation(api.cms.language.cancelLanguageTransition)
  const activate = useMutation(api.cms.language.activateLanguageTransition)
  const [cancelOpen, setCancelOpen] = useState(false)
  const [switchOpen, setSwitchOpen] = useState(false)
  const [switching, setSwitching] = useState(false)
  const source = getLocaleDisplayName(transition.sourceLocale)
  const target = getLocaleDisplayName(transition.targetLocale)
  const expectedGeneration = transition.generation
  const transitionId = transition._id
  const busy =
    transition.phase === "enumerating" ||
    transition.phase === "validating" ||
    transition.phase === "cancelling"
  const hasCarryDecisions = transition.carryDecisionDigest !== null
  const carryDecisions = usePaginatedQuery(
    api.cms.language.listLanguageCarryDecisions,
    hasCarryDecisions ? { transitionId, filter: "all" as const } : "skip",
    { initialNumItems: 25 }
  )
  const carryReviewComplete =
    !hasCarryDecisions || carryDecisions.status === "Exhausted"
  const previewConfirmed =
    transition.previewConfirmedPreparedSetVersion !== null &&
    transition.previewConfirmedPreparedSetVersion ===
      transition.preparedSetVersion &&
    (!hasCarryDecisions ||
      transition.previewConfirmedCarryDecisionDigest ===
        transition.carryDecisionDigest)
  const readyCount =
    transition.pageCount - transition.unresolvedCount - transition.blockedCount
  const readinessVersion = transition.readinessVersion
  // The server rechecks every value; this only hides a switch it would refuse.
  const canSwitch =
    transition.phase === "ready" &&
    readinessVersion !== null &&
    previewConfirmed &&
    transition.unresolvedCount === 0 &&
    transition.blockedCount === 0

  async function switchLanguage() {
    if (switching || readinessVersion === null) return
    setSwitching(true)
    await run(
      () =>
        activate({
          transitionId,
          expectedGeneration,
          expectedAuthorityVersion: authorityVersion,
          expectedSettingsUpdatedAt: settingsUpdatedAt,
          expectedReadinessVersion: readinessVersion,
        }),
      t("toast.switched", { target })
    )
    setSwitching(false)
    setSwitchOpen(false)
  }

  return (
    <div className="space-y-4">
      <div className="divide-y rounded-lg border bg-card">
        <div className="space-y-1 p-4">
          <h2 className="text-sm font-medium">
            {t("progressHeading", { source, target })}
          </h2>
          <p className="text-xs text-muted-foreground">
            {t("liveNote", { source, target })}
          </p>
        </div>
        <div className="space-y-2 p-4">
          <p className="text-sm font-medium">
            {t(`phases.${transition.phase as "preparing"}`)}
          </p>
          <p className="text-xs text-muted-foreground">
            {t("counts", {
              pages: transition.pageCount,
              ready: Math.max(readyCount, 0),
              undecided: transition.unresolvedCount,
              blocked: transition.blockedCount,
            })}
          </p>
          {transition.mode === "replace_content" && (
            <p className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
              {t("sharedWarning", { source, target })}
            </p>
          )}
          {canSwitch && (
            <div className="flex flex-wrap items-center gap-3">
              <p className="text-sm">{t("readyNote", { source, target })}</p>
              <Button disabled={switching} onClick={() => setSwitchOpen(true)}>
                {t("switch", { target })}
              </Button>
            </div>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <Button
            variant="outline"
            disabled={busy}
            onClick={() =>
              run(() => continueStep({ transitionId, expectedGeneration }))
            }
          >
            {t("continue")}
          </Button>
          <Button
            variant="outline"
            disabled={busy || previewConfirmed || !carryReviewComplete}
            onClick={() =>
              run(() =>
                confirmPreview({
                  transitionId,
                  expectedPreparedSetVersion: transition.preparedSetVersion,
                  ...(transition.carryDecisionDigest === null
                    ? {}
                    : {
                        expectedCarryDecisionDigest:
                          transition.carryDecisionDigest,
                      }),
                })
              )
            }
          >
            {previewConfirmed ? t("previewConfirmed") : t("confirmPreview")}
          </Button>
          <Button
            disabled={busy}
            onClick={() =>
              run(() => validate({ transitionId, expectedGeneration }))
            }
          >
            {t("check")}
          </Button>
          <div className="flex-1" />
          <Button
            variant="ghost"
            disabled={transition.phase === "cancelling"}
            onClick={() => setCancelOpen(true)}
          >
            {t("cancel")}
          </Button>
        </div>
      </div>

      {hasCarryDecisions && (
        <div className="divide-y rounded-lg border bg-card">
          <div className="p-4">
            <h2 className="text-sm font-medium">{t("carry.title")}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("carry.description")}
            </p>
          </div>
          {carryDecisions.results.length === 0 &&
          carryDecisions.status !== "LoadingFirstPage" ? (
            <p className="p-4 text-sm text-muted-foreground">
              {t("carry.none")}
            </p>
          ) : (
            <ul className="divide-y">
              {carryDecisions.results.map((decision) => (
                <li
                  key={decision.fromPath}
                  className="flex flex-wrap items-center justify-between gap-2 p-4 text-sm"
                >
                  <span className="font-medium">{decision.fromPath}</span>
                  <span className="text-muted-foreground">
                    {decision.outcome === "carry"
                      ? t("carry.kept")
                      : t(`carry.${decision.outcome}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          {carryDecisions.status === "CanLoadMore" && (
            <div className="p-4">
              <Button
                variant="outline"
                onClick={() => carryDecisions.loadMore(25)}
              >
                {t("loadMore")}
              </Button>
            </div>
          )}
          {!carryReviewComplete && (
            <p className="p-4 text-xs text-muted-foreground">
              {t("carry.reviewAll")}
            </p>
          )}
        </div>
      )}

      <TransitionPages transition={transition} run={run} />

      <Dialog
        open={switchOpen && canSwitch}
        onOpenChange={(open) => !switching && setSwitchOpen(open)}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("switchTitle", { target })}</DialogTitle>
            <DialogDescription>
              {t("switchDescription", { source, target })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap gap-2">
            <Button
              variant="outline"
              disabled={switching}
              onClick={() => setSwitchOpen(false)}
            >
              {t("notYet")}
            </Button>
            <Button disabled={switching} onClick={() => void switchLanguage()}>
              {switching ? t("switching") : t("switchConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={cancelOpen} onOpenChange={setCancelOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("cancelTitle")}</DialogTitle>
            <DialogDescription>
              {t("cancelDescription", { target })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter className="flex-wrap gap-2">
            <Button variant="outline" onClick={() => setCancelOpen(false)}>
              {t("keepGoing")}
            </Button>
            {[false, true].map((discardTargetDrafts) => (
              <Button
                key={String(discardTargetDrafts)}
                variant={discardTargetDrafts ? "destructive" : "secondary"}
                onClick={() => {
                  setCancelOpen(false)
                  void run(
                    () =>
                      cancel({
                        transitionId,
                        expectedGeneration,
                        discardTargetDrafts,
                      }),
                    t("toast.cancelled")
                  )
                }}
              >
                {discardTargetDrafts ? t("discardDrafts") : t("keepDrafts")}
              </Button>
            ))}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type TransitionPageReport = NonNullable<
  (typeof api.cms.language.listLanguageTransitionPages)["_returnType"]
>["page"][number]

function TransitionPages({
  transition,
  run,
}: {
  transition: TransitionSummary
  run: Run
}) {
  const t = useTranslations("settings.languages")
  const { results, status, loadMore } = usePaginatedQuery(
    api.cms.language.listLanguageTransitionPages,
    { transitionId: transition._id },
    { initialNumItems: 25 }
  )

  return (
    <div className="divide-y rounded-lg border bg-card">
      <div className="p-4">
        <h2 className="text-sm font-medium">{t("pagesHeading")}</h2>
      </div>
      {results.length === 0 && status !== "LoadingFirstPage" ? (
        <p className="p-4 text-sm text-muted-foreground">{t("noPages")}</p>
      ) : (
        results.map((row) => (
          <TransitionPageRow
            key={row.pageId}
            row={row}
            rows={results}
            transition={transition}
            run={run}
          />
        ))
      )}
      {status === "CanLoadMore" && (
        <div className="p-4">
          <Button variant="outline" onClick={() => loadMore(25)}>
            {t("loadMore")}
          </Button>
        </div>
      )}
    </div>
  )
}

function pageLabel(t: Translate, row: TransitionPageReport): string {
  return row.sourcePath ?? row.sourceSlug ?? t("page.noAddress")
}

function TransitionPageRow({
  row,
  rows,
  transition,
  run,
}: {
  row: TransitionPageReport
  rows: TransitionPageReport[]
  transition: TransitionSummary
  run: Run
}) {
  const t = useTranslations("settings.languages")
  const format = useFormatter()
  const setDisposition = useMutation(api.cms.language.setPageDisposition)
  const copySource = useMutation(api.cms.language.copySourceToTargetDraft)
  const confirmContent = useMutation(api.cms.language.confirmTargetContent)
  const prepare = useMutation(api.cms.language.prepareTargetPage)
  const target = getLocaleDisplayName(transition.targetLocale)
  const transitionId = transition._id
  const pageId = row.pageId
  const page = pageLabel(t, row)
  const replacing = transition.mode === "replace_content"
  const redirectChoices = rows.filter((other) => other.pageId !== pageId)

  function decide(
    disposition: "target" | "withdraw" | "redirect",
    redirectToPageId?: Id<"pages">
  ) {
    return run(() =>
      setDisposition({
        transitionId,
        pageId,
        disposition,
        ...(redirectToPageId ? { redirectToPageId } : {}),
        expectedPageGeneration: row.generation,
      })
    )
  }

  function decideRetained(
    disposition: "target" | "withdraw",
    basis: "retained_snapshot" | "draft"
  ) {
    const retainedTarget = row.retainedTarget
    if (!retainedTarget) return Promise.resolve()
    return run(() =>
      setDisposition({
        transitionId,
        pageId,
        disposition,
        expectedPageGeneration: row.generation,
        retainedTargetReview: {
          digest: retainedTarget.reviewDigest,
          basis,
        },
      })
    )
  }

  const retainedSnapshotDecision =
    row.disposition === "target" &&
    row.retainedTarget?.selection != null &&
    row.retainedTarget.decisionBasis === "retained_snapshot" &&
    row.retainedTarget.decisionCurrent
  const retainedDecisionStale =
    row.disposition === "target" &&
    row.retainedTarget !== null &&
    !row.retainedTarget.decisionCurrent

  return (
    <div className="space-y-2 p-4" data-testid="language-transition-page">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-sm font-medium">{page}</span>
        <span className="text-xs text-muted-foreground">
          {t(`page.status.${row.status}`)}
        </span>
      </div>
      <div className="space-y-0.5 text-xs text-muted-foreground">
        {row.kind === "private_draft" && <p>{t("page.privateDraft")}</p>}
        {row.targetPath && row.targetPath !== row.sourcePath && (
          <p>{t("page.newAddress", { path: row.targetPath })}</p>
        )}
        {row.contentKeys.length > 0 && (
          <p>{t("page.sections", { keys: row.contentKeys.join(", ") })}</p>
        )}
        {row.seoJson && <p>{t("page.seo", { seo: row.seoJson })}</p>}
        {row.targetRouteConflict && (
          <p className="text-destructive">{t("page.conflict", { target })}</p>
        )}
        {row.status === "blocked" && (
          <p className="text-destructive">
            {row.blockerCode === "TARGET_SELECTION_MISMATCH"
              ? t("page.blockers.targetMissing", { target })
              : row.blockerCode === "ANCESTRY_UNRESOLVED"
                ? t("page.blockers.parent")
                : row.blockerCode === "TARGET_LOCALE_HAS_RETAINED_CONTENT"
                  ? row.retainedTarget
                    ? t("page.retained.reviewRequired")
                    : t("page.blockers.retained", { target, page })
                  : t("page.blockers.generic")}
          </p>
        )}
        {row.status === "blocked" &&
          row.blockerCode === "TARGET_LOCALE_HAS_RETAINED_CONTENT" &&
          !row.retainedTarget && (
            <Link
              href={`/admin/pages/${pageId}`}
              className="inline-flex font-medium text-foreground underline underline-offset-2"
            >
              {t("page.blockers.retainedRemedy", { page })}
            </Link>
          )}
      </div>
      {row.retainedTarget && (
        <div className="space-y-3 rounded-md border bg-muted/30 p-3 text-xs">
          <div>
            <p className="font-medium text-foreground">
              {t("page.retained.heading", { target })}
            </p>
            <p className="mt-1 text-muted-foreground">
              {t("page.retained.description")}
            </p>
          </div>
          {row.retainedTarget.selection ? (
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                {t("page.retained.published", {
                  title: row.retainedTarget.selection.title,
                  path:
                    row.retainedTarget.selection.path ??
                    t("page.retained.noAddress"),
                  date: format.dateTime(
                    row.retainedTarget.selection.publishedAt,
                    { dateStyle: "medium", timeStyle: "short" }
                  ),
                })}
              </p>
              {row.retainedTarget.selection.seoTitle && (
                <p>
                  {t("page.retained.seoTitle", {
                    title: row.retainedTarget.selection.seoTitle,
                  })}
                </p>
              )}
              {row.retainedTarget.selection.seoDescription && (
                <p>
                  {t("page.retained.seoDescription", {
                    description: row.retainedTarget.selection.seoDescription,
                  })}
                </p>
              )}
            </div>
          ) : (
            <p>{t("page.retained.noPublished", { target })}</p>
          )}
          {row.retainedTarget.workingDraft && (
            <div className="space-y-1">
              <p className="font-medium text-foreground">
                {t("page.retained.draft", {
                  title: row.retainedTarget.workingDraft.title,
                  slug: row.retainedTarget.workingDraft.slug,
                  generation: row.retainedTarget.workingDraft.generation,
                })}
              </p>
              {row.retainedTarget.selection &&
                row.retainedTarget.workingDraft.differsFromSelection && (
                  <p>{t("page.retained.newerDraftPreserved")}</p>
                )}
            </div>
          )}
          {row.retainedTarget.draftBaseSnapshotId &&
            !row.retainedTarget.workingDraft && (
              <p>{t("page.retained.baseOnly")}</p>
            )}
          {retainedDecisionStale && (
            <p className="font-medium text-foreground">
              {t("page.retained.changedSinceDecision")}
            </p>
          )}
          {row.disposition === "target" &&
          row.status !== "blocked" &&
          row.retainedTarget.decisionCurrent ? (
            <p className="font-medium text-foreground">
              {retainedSnapshotDecision
                ? t("page.retained.usingPublished")
                : t("page.retained.preparingDraft")}
            </p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {row.retainedTarget.selection &&
              row.retainedTarget.decisionBasis !== "draft" ? (
                <>
                  <Button
                    size="sm"
                    onClick={() =>
                      void decideRetained("target", "retained_snapshot")
                    }
                  >
                    {t("page.retained.usePublished")}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() =>
                      void decideRetained("withdraw", "retained_snapshot")
                    }
                  >
                    {t("page.retained.withdrawPublished")}
                  </Button>
                </>
              ) : (
                <>
                  {row.retainedTarget.workingDraft && (
                    <Button
                      size="sm"
                      onClick={() => void decideRetained("target", "draft")}
                    >
                      {t("page.retained.prepareDraft")}
                    </Button>
                  )}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => void decideRetained("withdraw", "draft")}
                  >
                    {t("page.retained.keepPrivate")}
                  </Button>
                </>
              )}
            </div>
          )}
        </div>
      )}
      {(!row.retainedTarget ||
        row.disposition === "withdraw" ||
        row.disposition === "redirect") && (
        <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 text-xs">
          <span className="text-muted-foreground">{t("page.decision")}</span>
          <select
            value={row.disposition}
            disabled={
              row.kind === "hidden_selection" || row.kind === "private_draft"
            }
            onChange={(event) => {
              const next = event.target.value
              if (next === "target" || next === "withdraw") void decide(next)
              if (next === "redirect" && redirectChoices[0]) {
                void decide("redirect", redirectChoices[0].pageId)
              }
            }}
            className="rounded-md border bg-background px-2 py-1 text-xs"
          >
            {row.disposition === "undecided" && (
              <option value="undecided">{t("page.decisions.undecided")}</option>
            )}
            {row.kind !== "private_draft" && !row.retainedTarget && (
              <option value="target">
                {t("page.decisions.target", { target })}
              </option>
            )}
            <option value="withdraw">{t("page.decisions.withdraw")}</option>
            {row.kind !== "private_draft" && redirectChoices.length > 0 && (
              <option value="redirect">{t("page.decisions.redirect")}</option>
            )}
          </select>
        </label>
        {row.disposition === "redirect" && (
          <label className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">
              {t("page.redirectTo")}
            </span>
            <select
              value={row.redirectToPageId ?? ""}
              onChange={(event) =>
                void decide("redirect", event.target.value as Id<"pages">)
              }
              className="rounded-md border bg-background px-2 py-1 text-xs"
            >
              {redirectChoices.map((other) => (
                <option key={other.pageId} value={other.pageId}>
                  {pageLabel(t, other)}
                </option>
              ))}
            </select>
          </label>
        )}
        </div>
      )}
      {row.disposition === "target" && !retainedDecisionStale && (
        <div className="flex flex-wrap items-center gap-2">
          {/* The page editor resolves the language from the open change. */}
          {replacing &&
            !retainedSnapshotDecision &&
            row.lifecycleGeneration !== null && (
            <Button size="sm" variant="outline" asChild>
              <Link href={`/admin/pages/${pageId}?language=new`}>
                {row.hasTargetDraft
                  ? t("page.editTarget", { target })
                  : t("page.writeTarget", { target })}
              </Link>
            </Button>
          )}
          {replacing &&
            !row.retainedTarget &&
            !row.hasTargetDraft &&
            row.lifecycleGeneration !== null && (
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run(() =>
                    copySource({
                      transitionId,
                      pageId,
                      expectedSourceDraftGeneration: row.sourceDraftGeneration,
                      expectedLifecycleGeneration: row.lifecycleGeneration!,
                    })
                  )
                }
              >
                {t("page.copy")}
              </Button>
            )}
          {replacing &&
            !retainedSnapshotDecision &&
            row.hasTargetDraft &&
            (row.confirmed && row.status !== "stale" ? (
              <span className="text-xs text-emerald-700 dark:text-emerald-400">
                {t("page.confirmed", { target })}
              </span>
            ) : (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={
                    row.targetDraftGeneration === null ||
                    row.sharedDraftGeneration === null
                  }
                  onClick={() =>
                    run(() =>
                      confirmContent({
                        transitionId,
                        pageId,
                        expectedTargetDraftGeneration:
                          row.targetDraftGeneration!,
                        expectedSharedDraftGeneration:
                          row.sharedDraftGeneration!,
                        expectedPageGeneration: row.generation,
                      })
                    )
                  }
                >
                  {t("page.confirm", { target })}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {t("page.unconfirmedHint", { target })}
                </span>
              </>
            ))}
          {row.status !== "ready" &&
            (!replacing || row.confirmed || retainedSnapshotDecision) && (
            <Button
              size="sm"
              onClick={() =>
                run(() =>
                  prepare({
                    transitionId,
                    pageId,
                    expectedPageGeneration: row.generation,
                  })
                )
              }
            >
              {t("page.prepare")}
            </Button>
          )}
        </div>
      )}
    </div>
  )
}

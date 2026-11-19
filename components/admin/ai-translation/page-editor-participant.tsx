"use client"

import { useEffect, useState } from "react"
import { useMutation } from "convex/react"
import { ConvexError } from "convex/values"
import { useTranslations } from "next-intl"
import { Languages, Loader2 } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { startLocalPageJob } from "@/app/(core)/admin/(authenticated)/pages/local-ai-job-actions"
import type { Locale } from "@/lib/i18n/config"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { useTranslationOffMessage } from "@/components/admin/content-types/content-type-names"
import { reportContainedModuleFailure } from "@/lib/modules/containment"
import { useModuleGate } from "../admin-module-state-provider"
import type {
  AdminAiTranslationHostInput,
  AdminAiTranslationHostProps,
  AdminAiTranslationHostResult,
} from "../contributions/ai-translation"
import { OptionalContribution } from "../optional-contribution"
import { ApiKeyNotice } from "../ai-writing/new-page-participant"
import {
  LocalRouteProvider,
  LocalToolElsewhereNotice,
  PageJobCard,
  RunningJobNotice,
  focusPageJobCard,
  isActive,
  runsElsewhere,
  usePageJobState,
  type PageJob,
} from "../ai-writing/page-jobs"
import { TranslationReview, useLanguageName } from "./translation-review"

const NO_PARTICIPATION: AdminAiTranslationHostResult = {
  fieldTranslate: undefined,
  busy: false,
  command: null,
  control: null,
  panel: null,
  setTranslateOpen: () => {},
  runPushedTranslate: () => {},
}

/** A refused Start: another job runs, or a line under the header. */
type Refusal =
  | "active"
  | "elsewhere"
  | "targetHasContent"
  | "sourceTooLarge"
  | "translationOff"
  | { error: unknown }

type Shared = Pick<
  AdminAiTranslationHostInput,
  "page" | "currentLocale" | "fieldSource" | "getLocaleSummary" | "ensureSaved"
> & { fieldSource: Locale }

/** This page's unreviewed translation jobs, and the one running now. */
function usePageTranslation(pageId: string) {
  const state = usePageJobState("translation")
  const jobs = state.translationJobs.filter((job) => job.pageId === pageId)
  return { ...state, pageJobs: jobs, running: jobs.find(isActive) }
}

/** The active tab is a language other than the source with nothing in it. */
const notTranslated = ({
  page,
  currentLocale,
  fieldSource,
  getLocaleSummary,
}: Shared) =>
  currentLocale !== fieldSource &&
  !getLocaleSummary(currentLocale).hasAny &&
  page.content?.[currentLocale] === undefined

/**
 * Translation's page-editor participant. The host reads only the AI and
 * Multilingual gates and always renders the editor at the same place; every
 * AI read lives in the parts below, mounted only while both are on.
 */
export function PageEditorTranslationSlot({
  children,
  routeData,
  page,
  currentLocale,
  fieldSource,
  getLocaleSummary,
  ensureSaved,
  beginSavedLanguage,
}: AdminAiTranslationHostProps) {
  const ai = useModuleGate("ai")
  const multilingual = useModuleGate("multilingual")
  const on =
    (ai.state === "on" || ai.state === "needs_setup") &&
    multilingual.state === "on" &&
    fieldSource !== undefined
  const [busy, setBusy] = useState(false)
  const [startOpen, setStartOpen] = useState(false)
  const [refusal, setRefusal] = useState<Refusal | null>(null)
  // A new tab starts without the Start box or an old refusal.
  const [seenLocale, setSeenLocale] = useState(currentLocale)
  if (seenLocale !== currentLocale) {
    setSeenLocale(currentLocale)
    setStartOpen(false)
    setRefusal(null)
  }
  const shared: Shared | undefined =
    on && fieldSource !== undefined
      ? { page, currentLocale, fieldSource, getLocaleSummary, ensureSaved }
      : undefined
  return (
    <LocalRouteProvider assistant="translation" routeData={routeData.brandTranslation}>
      {shared && <BusyWatch pageId={page._id} onBusy={setBusy} />}
      {children(
        shared
          ? {
              ...NO_PARTICIPATION,
              busy,
              control: (
                <TranslateControl
                  {...shared}
                  onPress={(active) => {
                    if (active) {
                      setStartOpen(false)
                      setRefusal("active")
                      return
                    }
                    setRefusal(null)
                    setStartOpen(true)
                  }}
                />
              ),
              panel: (
                <TranslatePanel
                  {...shared}
                  beginSavedLanguage={beginSavedLanguage}
                  startOpen={startOpen}
                  refusal={refusal}
                  onStarted={() => {
                    setStartOpen(false)
                    setRefusal(null)
                  }}
                  onRefused={(next) => {
                    setStartOpen(next !== "active" && next !== "elsewhere")
                    setRefusal(next)
                  }}
                  onFollowed={() => setRefusal(null)}
                />
              ),
            }
          : NO_PARTICIPATION
      )}
    </LocalRouteProvider>
  )
}

/** Lifts "this page has a running translation job" to the host's `busy`. */
function BusyWatch({
  pageId,
  onBusy,
}: {
  pageId: string
  onBusy: (busy: boolean) => void
}) {
  const { status, jobs, ready, runsLocally, running } = usePageTranslation(pageId)
  // A running job holds the editor whatever Translation's current setup.
  const busy = running !== undefined
  // Without a ready service the jobs read may refuse (an API job needs its
  // connection); that is not a failure to report, the cards just stay hidden.
  const jobsFailed = jobs instanceof Error && (ready || runsLocally)
  useEffect(() => {
    onBusy(busy)
    return () => onBusy(false)
  }, [busy, onBusy])
  useEffect(() => {
    if (status instanceof Error)
      reportContainedModuleFailure("ai", "admin.contribution", status)
    if (jobsFailed)
      reportContainedModuleFailure("ai", "admin.contribution", jobs)
  }, [status, jobs, jobsFailed])
  return null
}

/** "Translate from EN" in the header row, or the key notice in its place. */
function TranslateControl({
  onPress,
  ...shared
}: Shared & { onPress: (active: boolean) => void }) {
  const t = useTranslations("pages.aiTranslate")
  const { loaded, ready, elsewhere, connection, active, pageJobs, running } =
    usePageTranslation(shared.page._id)
  if (!loaded) return null
  const empty = notTranslated(shared)
  // Every state (not ready, running, idle) shows only on an eligible language.
  if (!empty) return null
  if (elsewhere) return <LocalToolElsewhereNotice messages="pages.aiTranslate" />
  if (!ready) return <ApiKeyNotice connection={connection} />
  if (running)
    return (
      <button
        type="button"
        data-testid="translate-page"
        disabled
        className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
      >
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
        {t("translating")}
      </button>
    )
  // One unreviewed job per language: its card is under the header.
  if (pageJobs.some((job) => job.targetLocale === shared.currentLocale))
    return null
  return (
    <button
      type="button"
      data-testid="translate-page"
      onClick={() => onPress(active !== undefined)}
      className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
    >
      <Languages className="size-3.5" aria-hidden />
      {t("button", { source: shared.fieldSource.toUpperCase() })}
    </button>
  )
}

/** Under the header: the running notice, Start, this page's cards and the running note. */
function TranslatePanel({
  beginSavedLanguage,
  startOpen,
  refusal,
  onStarted,
  onRefused,
  onFollowed,
  ...shared
}: Shared & {
  beginSavedLanguage: AdminAiTranslationHostInput["beginSavedLanguage"]
  startOpen: boolean
  refusal: Refusal | null
  onStarted: () => void
  onRefused: (refusal: Refusal) => void
  onFollowed: () => void
}) {
  const t = useTranslations("pages.aiTranslate")
  const tWrite = useTranslations("pages.aiWrite")
  const tShell = useTranslations("shell")
  const languageName = useLanguageName()
  const displayError = useCaughtError()
  const translationOffMessage = useTranslationOffMessage()
  const startApiJob = useMutation(api.cms.aiJobs.startPageJob)
  const [starting, setStarting] = useState(false)
  const { ready, runsLocally, localTool, jobs, active, pageJobs, running } =
    usePageTranslation(shared.page._id)
  // A local job's card shows on every device; it needs no API connection. A
  // job that exists keeps its card when Translation moves to a service that is
  // not set up: only a new job needs one.
  if (!ready && !runsLocally && pageJobs.length === 0) return null
  const shownHere = (job: PageJob) =>
    job.kind === "translation" && job.pageId === shared.page._id

  // Only a ready Translation starts a job: an open Start box hides while it is not ready.
  const showStart = startOpen && ready

  async function start() {
    if (!ready) return
    setStarting(true)
    const input = {
      kind: "translation" as const,
      pageId: shared.page._id,
      sourceLocale: shared.fieldSource,
      targetLocale: shared.currentLocale,
    }
    // The route decision: Translation's local tool on this computer, else its
    // API service (which Convex refuses while it runs with a local tool).
    const run = localTool
      ? startLocalPageJob(input).then((result) => {
          if (!result.ok) throw new ConvexError(result.refusal)
          return result.value
        })
      : startApiJob({ input })
    // .then with two arms, not try: the React Compiler skips some try blocks.
    const outcome = await run.then(
      () => ({ started: true as const, error: undefined }),
      (error: unknown) => ({ started: false as const, error })
    )
    setStarting(false)
    if (outcome.started) {
      onStarted()
      return
    }
    const error = outcome.error
    const code = error instanceof ConvexError ? error.data : undefined
    if (code === "AI_JOB_ALREADY_ACTIVE") onRefused("active")
    else if (code === "AI_JOB_TARGET_HAS_CONTENT") onRefused("targetHasContent")
    else if (code === "AI_JOB_SOURCE_TOO_LARGE") onRefused("sourceTooLarge")
    else if (code === "CONTENT_TYPE_TRANSLATION_OFF") onRefused("translationOff")
    else if (runsElsewhere(error)) onRefused("elsewhere")
    else onRefused({ error })
  }

  const refusalLine =
    refusal === "targetHasContent"
      ? t("targetHasContent")
      : refusal === "sourceTooLarge"
        ? t("sourceTooLarge")
        : refusal === "translationOff"
          ? translationOffMessage(shared.page.pageType)
          : typeof refusal === "object" && refusal !== null
          ? displayError(refusal.error, tWrite("wizard.startFailed"))
          : null
  const showCards = !(jobs instanceof Error) && pageJobs.length > 0
  if (refusal === null && !showStart && !showCards && !running) return null

  return (
    <div
      data-testid="translate-panel"
      className="mx-4 mb-3 flex max-h-[50vh] shrink-0 flex-col gap-3 overflow-y-auto"
    >
      {refusal === "active" && (
        <RunningJobNotice
          active={active}
          shownHere={shownHere}
          onFollow={(jobId) => {
            onFollowed()
            focusPageJobCard(jobId)
          }}
        />
      )}
      {refusal === "elsewhere" && (
        <LocalToolElsewhereNotice messages="pages.aiTranslate" />
      )}
      {refusal !== null && refusal !== "active" && refusal !== "elsewhere" && (
        <p
          role="alert"
          data-testid="start-error"
          className="text-sm text-destructive"
        >
          {refusalLine}
        </p>
      )}
      {showStart && (
        <div className="flex flex-col gap-3 rounded-md border p-3">
          <button
            type="button"
            data-testid="start-job"
            disabled={starting}
            onClick={start}
            className="self-end rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground disabled:opacity-50"
          >
            {t("start")}
          </button>
        </div>
      )}
      {showCards && (
        <OptionalContribution
          moduleId="ai"
          slot="admin.ai-translation"
          readyWithoutSetup={runsLocally || pageJobs.length > 0}
          fallbackText={tShell("modulesUnavailable")}
          finishSetup={{
            href: "/admin/settings/ai",
            label: tWrite("settingsLink"),
          }}
        >
          <div className="flex flex-col gap-3">
            {pageJobs.map((job) => (
              <PageJobCard
                key={job.jobId}
                job={job}
                otherJobActive={
                  active !== undefined && active.jobId !== job.jobId
                }
                anchored
                renderReview={(reviewed, dismiss) => (
                  <TranslationReview
                    key={reviewed.jobId}
                    job={reviewed}
                    dismiss={dismiss}
                    getLocaleSummary={shared.getLocaleSummary}
                    ensureSaved={shared.ensureSaved}
                    beginSavedLanguage={beginSavedLanguage}
                  />
                )}
              />
            ))}
          </div>
        </OptionalContribution>
      )}
      {running && (
        <p
          role="status"
          data-testid="translate-running"
          className="flex items-center gap-2 rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground"
        >
          <Loader2 className="size-4 animate-spin" aria-hidden />
          {t("running", {
            language: languageName(running.targetLocale ?? running.locale),
          })}
        </p>
      )}
    </div>
  )
}

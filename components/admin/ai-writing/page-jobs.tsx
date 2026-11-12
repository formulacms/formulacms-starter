"use client"

import { useEffect, useId, useState, type ReactNode } from "react"
import Link from "next/link"
import { useMutation, useQueries } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Check, CircleAlert, Clock, Loader2, RotateCcw, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { useConfirm } from "@/components/providers/confirm-provider"
import { getLocaleLabel } from "@/lib/i18n/config"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { readSliceMetadata } from "@/lib/slices/builder"
import { cn } from "@/lib/utils"

type AiStatus = FunctionReturnType<typeof api.cms.aiSettings.status>
export type PageJob = FunctionReturnType<
  typeof api.cms.aiJobs.pageJobProgress
>[number]
type PageJobResult = FunctionReturnType<typeof api.cms.aiJobs.pageJobResult>

// useQueries memoizes its subscription on the request object's identity, and
// the React Compiler does not memoize every component (it skips some
// statements), so each request below is created once, never per render.
const STATUS_REQUEST = {
  status: { query: api.cms.aiSettings.status, args: {} },
}
const JOBS_REQUEST = {
  jobs: { query: api.cms.aiJobs.pageJobProgress, args: {} },
}
const NO_REQUEST = {}

export const isActive = (job: PageJob) =>
  job.state === "running" || job.state === "canceling"

/** DOM id of a job card, so the running-job link can scroll to it. */
export const pageJobCardId = (jobId: string) => `ai-page-job-${jobId}`

/** Focus a job card on this page; false when it is not shown here. */
export function focusPageJobCard(jobId: string): boolean {
  const card = document.getElementById(pageJobCardId(jobId))
  if (!card) return false
  card.scrollIntoView({ block: "center" })
  card.focus()
  return true
}

/** Where the running-job link leads for a job not shown on this screen. */
const pageJobHref = (job: PageJob) =>
  `${job.kind === "write" ? "/admin/pages/new" : `/admin/pages/${job.pageId}`}#${pageJobCardId(job.jobId)}`

/**
 * One assistant's readiness and the owner's unreviewed page jobs. Both reads
 * return an Error value instead of throwing, so a failing AI read never breaks
 * the host. Jobs are read only while that assistant is ready.
 */
export function usePageJobState(assistant: "writing" | "translation") {
  const { status } = useQueries(STATUS_REQUEST) as {
    status?: AiStatus | Error
  }
  const loaded = status instanceof Error ? undefined : status
  const writing = loaded?.assistants.find((entry) => entry.id === assistant)
  const ready = writing?.ready === true
  const { jobs } = useQueries(ready ? JOBS_REQUEST : NO_REQUEST) as {
    jobs?: PageJob[] | Error
  }
  const rows = Array.isArray(jobs) ? jobs : []
  return {
    status,
    loaded: loaded !== undefined,
    ready,
    connection: loaded?.connections.find(
      (entry) => entry.provider === writing?.provider
    ),
    jobs,
    writeJobs: rows.filter((job) => job.kind === "write"),
    translationJobs: rows.filter((job) => job.kind === "translation"),
    /** Any job of this owner that is running or canceling, of any kind. */
    active: rows.find(isActive),
  }
}

/** Writing readiness and the owner's unreviewed page jobs (see `usePageJobState`). */
export function useWritingState() {
  return usePageJobState("writing")
}

/** The bar of the prototype (`SpendBar`, job tone). */
function SavedBar({
  value,
  total,
  complete,
  label,
}: {
  value: number
  total: number
  complete: boolean
  label: string
}) {
  const pct = total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      className="h-2.5 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          "h-full rounded-full transition-all",
          complete ? "bg-emerald-700 dark:bg-emerald-400" : "bg-primary"
        )}
        style={{ width: `${pct}%` }}
      />
    </div>
  )
}

/** One Dismiss for the card and the review list; the backend decides the wording. */
function useDismiss(job: PageJob, onFinish?: () => void) {
  const t = useTranslations("pages.aiWrite")
  const tTranslate = useTranslations("pages.aiTranslate")
  const confirm = useConfirm()
  const dismiss = useMutation(api.cms.aiJobs.dismissPageJob)
  const displayError = useCaughtError()
  return async () => {
    const trash = job.dismissMovesPageToTrash
    const ok = await confirm(
      job.kind === "translation"
        ? {
            title: tTranslate("dismiss.title"),
            description: tTranslate("dismiss.description"),
            confirmText: t("dismiss.confirm"),
          }
        : {
            title: t("dismiss.title"),
            description: trash
              ? t("dismiss.movesToTrash", { title: job.title })
              : t("dismiss.staysInPages", { title: job.title }),
            confirmText: trash
              ? t("dismiss.confirmTrash")
              : t("dismiss.confirm"),
          }
    )
    if (!ok) return
    // .catch, not try: the React Compiler skips a try holding `?.` or `? :`.
    const outcome = await dismiss({ jobId: job.jobId }).catch(
      (error: unknown) => {
        toast.error(displayError(error, t("job.actionFailed")))
        return null
      }
    )
    if (!outcome) return
    onFinish?.()
    toast(
      outcome.pageMovedToTrash
        ? t("dismiss.movedToTrash")
        : t("dismiss.dismissed")
    )
  }
}

/**
 * A page job card, shared by New Page, the wizard's running view and the page
 * editor. `onFinish` closes the wizard after Accept or a confirmed Dismiss;
 * `anchored` marks the copy that the running-job link scrolls to. A
 * translation job's review list comes from `renderReview`.
 */
export function PageJobCard({
  job,
  otherJobActive,
  onFinish,
  anchored = false,
  renderReview,
}: {
  job: PageJob
  otherJobActive: boolean
  onFinish?: () => void
  anchored?: boolean
  renderReview?: (job: PageJob, dismiss: () => Promise<void>) => ReactNode
}) {
  const t = useTranslations("pages.aiWrite.job")
  const tTranslate = useTranslations("pages.aiTranslate.job")
  const translation = job.kind === "translation"
  const displayError = useCaughtError()
  const cancel = useMutation(api.cms.aiJobs.cancelPageJob)
  const resume = useMutation(api.cms.aiJobs.resumePageJob)
  const dismiss = useDismiss(job, onFinish)
  const [reviewOpen, setReviewOpen] = useState(false)
  const busy = isActive(job)
  // The running-job link may arrive from another screen with this card's id.
  useEffect(() => {
    if (anchored && window.location.hash === `#${pageJobCardId(job.jobId)}`)
      focusPageJobCard(job.jobId)
  }, [anchored, job.jobId])
  const saved = job.units.filter((unit) => unit.state === "saved").length
  // `capped` cannot happen while the cap is off; it reads exactly like `failed`.
  const stopped =
    job.state === "canceled" || job.state === "failed" || job.state === "capped"
  const status = {
    running: t("running"),
    canceling: t("canceling"),
    canceled: t("canceled"),
    failed: t("failed"),
    capped: t("failed"),
    done: t("done"),
    expired: t("expired"),
  }[job.state]

  async function act(work: () => Promise<unknown>) {
    try {
      await work()
    } catch (error) {
      toast.error(displayError(error, t("actionFailed")))
    }
  }

  function unitStatus(unit: PageJob["units"][number]) {
    if (unit.state === "saved")
      return unit.reused ? t("unitReused") : t("unitSaved")
    if (job.failedIndex === unit.index) return t("unitFailed")
    if (unit.state === "inProgress") return t("unitInProgress")
    return t("unitWaiting")
  }

  return (
    <>
      <section
        id={anchored ? pageJobCardId(job.jobId) : undefined}
        tabIndex={anchored ? -1 : undefined}
        data-testid="job-progress"
        data-job-id={job.jobId}
        data-state={job.state}
        className="flex flex-col gap-3 rounded-md border p-3 text-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-2 font-medium" role="status">
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-hidden />
            ) : job.state === "done" ? (
              <Check className="size-4" aria-hidden />
            ) : (
              <CircleAlert className="size-4" aria-hidden />
            )}
            {status}
          </h3>
        </div>
        <p data-testid="job-count">
          {translation
            ? tTranslate("count", { saved, total: job.units.length })
            : t("count", { saved, total: job.units.length })}
        </p>
        <SavedBar
          value={saved}
          total={job.units.length}
          complete={job.state === "done"}
          label={t("savedUnits")}
        />
        {job.reusedCount > 0 && (
          <p
            data-testid="reused"
            className="flex items-center gap-2 text-muted-foreground"
          >
            <RotateCcw className="size-4" aria-hidden />
            {t("reused", { count: job.reusedCount })}
          </p>
        )}
        {job.state !== "expired" && (
          <ol
            aria-label={t("savedResults")}
            className="max-h-40 overflow-auto rounded-md border text-xs"
          >
            {job.units.map((unit) => (
              <li
                key={unit.index}
                className="flex items-center gap-2 border-b px-2 py-1.5 last:border-0"
                data-testid="job-unit"
                data-saved={unit.state === "saved"}
              >
                {unit.state === "saved" ? (
                  <Check className="size-3.5 shrink-0" aria-hidden />
                ) : job.failedIndex === unit.index ? (
                  <CircleAlert className="size-3.5 shrink-0" aria-hidden />
                ) : (
                  <Clock className="size-3.5 shrink-0" aria-hidden />
                )}
                <span className="flex-1">
                  {translation
                    ? tTranslate("unit", { number: unit.index + 1 })
                    : t("unit", {
                        number: unit.index + 1,
                        purpose: unit.purpose ?? "",
                      })}
                </span>
                <span>{unitStatus(unit)}</span>
              </li>
            ))}
          </ol>
        )}
        <div className="flex flex-wrap items-center gap-2">
          {busy && (
            <Button
              data-testid="cancel-job"
              variant="outline"
              disabled={job.state === "canceling"}
              onClick={() => act(() => cancel({ jobId: job.jobId }))}
            >
              <X />
              {t("cancel")}
            </Button>
          )}
          {stopped && (
            <Button
              data-testid="resume-job"
              disabled={otherJobActive}
              onClick={() => act(() => resume({ jobId: job.jobId }))}
            >
              <RotateCcw />
              {t("resume")}
            </Button>
          )}
          {(stopped || job.state === "expired") && (
            <Button
              variant="outline"
              data-testid="dismiss-job"
              onClick={dismiss}
            >
              <X />
              {t("dismiss")}
            </Button>
          )}
          {job.state === "done" && (
            <Button
              data-testid={
                translation ? "review-translation" : "review-sections"
              }
              aria-expanded={reviewOpen}
              onClick={() => setReviewOpen((open) => !open)}
            >
              {translation
                ? tTranslate("reviewTranslation")
                : t("reviewSections")}
            </Button>
          )}
        </div>
      </section>
      {job.state === "done" &&
        reviewOpen &&
        (translation ? (
          renderReview?.(job, dismiss)
        ) : (
          <ReviewList
            key={job.jobId}
            job={job}
            dismiss={dismiss}
            onFinish={onFinish}
          />
        ))}
    </>
  )
}

function ReviewList({
  job,
  dismiss,
  onFinish,
}: {
  job: PageJob
  dismiss: () => Promise<void>
  onFinish?: () => void
}) {
  const t = useTranslations("pages.aiWrite.review")
  const router = useRouter()
  const id = useId()
  const headingId = useId()
  const accept = useMutation(api.cms.aiJobs.acceptPageJob)
  // Error values, not throws: the job leaves review once accepted or dismissed.
  // Created once: the parent keys this list by job id (see STATUS_REQUEST).
  const [request] = useState(() => ({
    result: { query: api.cms.aiJobs.pageJobResult, args: { jobId: job.jobId } },
  }))
  const { result } = useQueries(request) as {
    result?: PageJobResult | Error
  }
  // Every section starts ticked; only the owner's unticks are kept.
  const [unticked, setUnticked] = useState<ReadonlySet<number>>(new Set())
  const [saving, setSaving] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  if (result === undefined || result instanceof Error) return null
  const chosen = result.sections
    .filter((section) => !unticked.has(section.index))
    .map((section) => section.index)

  function tick(index: number, checked: boolean) {
    setUnticked((current) => {
      const next = new Set(current)
      if (checked) next.delete(index)
      else next.add(index)
      return next
    })
  }

  async function acceptChosen() {
    setSaving(true)
    setSaveFailed(false)
    // .catch, not try: the React Compiler skips a try holding `?.` or `? :`.
    const saved = await accept({ jobId: job.jobId, chosen }).catch(() => null)
    setSaving(false)
    if (!saved) {
      setSaveFailed(true)
      return
    }
    onFinish?.()
    toast.success(t("saved"))
    router.push(`/admin/pages/${saved.pageId}`)
  }

  return (
    <section
      data-testid="review-list"
      aria-labelledby={headingId}
      className="flex flex-col gap-3 rounded-md border p-3 text-sm"
    >
      <div>
        <h3 id={headingId} className="font-medium">
          {t("heading")}
        </h3>
        <p data-testid="review-meta" className="text-muted-foreground">
          {t("meta", {
            title: result.title,
            language: getLocaleLabel(result.locale),
          })}
        </p>
      </div>
      <ul className="divide-y border-y">
        {result.sections.map((section) => (
          <li
            key={section.index}
            data-testid="review-row"
            className="flex items-start gap-3 py-3"
          >
            <Checkbox
              id={`${id}-${section.index}`}
              checked={!unticked.has(section.index)}
              onCheckedChange={(value) => tick(section.index, value === true)}
              className="mt-0.5"
            />
            <div className="flex flex-col gap-1">
              <Label htmlFor={`${id}-${section.index}`}>
                {readSliceMetadata(section.sliceType)?.label ??
                  section.sliceType}
              </Label>
              <p className="text-muted-foreground">{section.purpose}</p>
              {section.fields.map((field, index) => (
                <p key={index} data-testid="review-text">
                  {field.text}
                </p>
              ))}
            </div>
          </li>
        ))}
      </ul>
      {saveFailed && (
        <p
          role="alert"
          data-testid="save-error"
          className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-destructive"
        >
          {t("saveFailed")}
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button
          data-testid="accept-chosen"
          disabled={chosen.length === 0 || saving}
          onClick={acceptChosen}
        >
          <Check />
          {t("acceptChosen", { count: chosen.length })}
        </Button>
        <Button variant="outline" data-testid="dismiss-all" onClick={dismiss}>
          <X />
          {t("dismissAll")}
        </Button>
      </div>
    </section>
  )
}

/**
 * "A page job is already running." with a link to that job's card: in place
 * when `shownHere` says the card is on this screen, else to the job's screen.
 */
export function RunningJobNotice({
  active,
  onFollow,
  shownHere = (job) => job.kind === "write",
}: {
  active: PageJob | undefined
  onFollow: (jobId: string) => void
  shownHere?: (job: PageJob) => boolean
}) {
  const t = useTranslations("pages.aiWrite")
  return (
    <div
      role="alert"
      data-testid="one-job"
      className="flex flex-wrap items-center gap-2 text-sm"
    >
      <CircleAlert className="size-4" aria-hidden />
      {t("runningNotice")}
      {active &&
        (shownHere(active) ? (
          <Button
            variant="link"
            data-testid="running-link"
            onClick={() => onFollow(active.jobId)}
          >
            {t("runningLink")}
          </Button>
        ) : (
          <Button variant="link" data-testid="running-link" asChild>
            <Link href={pageJobHref(active)}>{t("runningLink")}</Link>
          </Button>
        ))}
    </div>
  )
}

/** The cards above the New Page form: Write jobs only, in the returned order. */
export function PageJobList() {
  const { jobs, writeJobs, active } = useWritingState()
  // A refused read is shown by the surrounding contribution boundary.
  if (jobs instanceof Error) throw jobs
  if (writeJobs.length === 0) return null
  return (
    <div className="flex flex-col gap-3">
      {writeJobs.map((job) => (
        <PageJobCard
          key={job.jobId}
          job={job}
          otherJobActive={active !== undefined && active.jobId !== job.jobId}
          anchored
        />
      ))}
    </div>
  )
}

"use client"

import { useEffect, useRef, useState } from "react"
import { useAction, useMutation, useQueries, useQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { ConvexError } from "convex/values"
import { useTranslations } from "next-intl"
import { GripVertical, Loader2, Plus, Sparkles, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getLocaleLabel } from "@/lib/i18n/config"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { readSliceMetadata } from "@/lib/slices/builder"
import { moveItem, useDragReorder } from "@/lib/use-drag-reorder"
import { OptionalContribution } from "../optional-contribution"
import {
  PageJobCard,
  RunningJobNotice,
  focusPageJobCard,
  useWritingState,
} from "./page-jobs"

/** The only languages a Write-page job accepts. */
export type WriteLocale = "en" | "fr"
type Presets = FunctionReturnType<typeof api.cms.agents.getContentPresets>
type OutlineRow = { id: string; type: string; purpose: string }
type Meta = {
  title: string
  slug: string
  metaTitle: string
  metaDescription: string
}
const MAX_SECTIONS = 8

type WizardProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Enabled site languages a job accepts, in site order. */
  languages: readonly WriteLocale[]
  initialLocale: WriteLocale
  defaultLocale: string
}

/** The "Write a page with AI" dialog. Closing it never cancels or discards a job. */
export function PageWizard({ open, onOpenChange, ...props }: WizardProps) {
  const t = useTranslations("pages.aiWrite")
  const tShell = useTranslations("shell")
  // A followed running-job link focuses that card once the dialog has closed.
  const followJob = useRef<string | null>(null)
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[94vh] overflow-y-auto sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          const jobId = followJob.current
          followJob.current = null
          if (jobId && focusPageJobCard(jobId)) event.preventDefault()
        }}
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4" />
            {t("wizard.title")}
          </DialogTitle>
          <DialogDescription>{t("wizard.description")}</DialogDescription>
        </DialogHeader>
        <OptionalContribution
          moduleId="ai"
          slot="admin.ai-writing"
          fallbackText={tShell("modulesUnavailable")}
          finishSetup={{ href: "/admin/settings/ai", label: t("settingsLink") }}
        >
          <WizardBody
            {...props}
            onClose={() => onOpenChange(false)}
            onFollow={(jobId) => {
              followJob.current = jobId
              onOpenChange(false)
            }}
          />
        </OptionalContribution>
      </DialogContent>
    </Dialog>
  )
}

// Created once: useQueries subscribes again whenever the request object changes.
const PRESETS_REQUEST = {
  presets: { query: api.cms.agents.getContentPresets, args: {} },
}

function WizardBody({
  languages,
  initialLocale,
  defaultLocale,
  onClose,
  onFollow,
}: Omit<WizardProps, "open" | "onOpenChange"> & {
  onClose: () => void
  onFollow: (jobId: string) => void
}) {
  const t = useTranslations("pages.aiWrite.wizard")
  const displayError = useCaughtError()
  const { active, writeJobs } = useWritingState()
  // Optional starting briefs: a refused read only hides the picker.
  const { presets } = useQueries(PRESETS_REQUEST) as {
    presets?: Presets | Error
  }
  const settings = useQuery(api.cms.settings.getSettings)
  const planOutline = useAction(api.agents.contentWriter.generatePageOutline)
  const startJob = useMutation(api.cms.aiJobs.startPageJob)
  const [stage, setStage] = useState<"brief" | "outline" | "running">("brief")
  const [brief, setBrief] = useState("")
  const [locale, setLocale] = useState<WriteLocale>(initialLocale)
  const [meta, setMeta] = useState<Meta>({
    title: "",
    slug: "",
    metaTitle: "",
    metaDescription: "",
  })
  const [rows, setRows] = useState<OutlineRow[]>([])
  const [planning, setPlanning] = useState(false)
  const [planError, setPlanError] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const [startError, setStartError] = useState<string | null>(null)
  const [refused, setRefused] = useState(false)
  const [jobId, setJobId] = useState<Id<"aiJobs"> | null>(null)
  const { dragHandlers } = useDragReorder((from, to) =>
    setRows((current) => moveItem(current, from, to))
  )
  const job = writeJobs.find((entry) => entry.jobId === jobId)

  async function plan() {
    if (!brief.trim()) return
    setPlanning(true)
    setPlanError(null)
    try {
      const result = await planOutline({ brief: brief.trim(), locale })
      setMeta({
        title: result.title,
        slug: result.slug,
        metaTitle: result.metaTitle,
        metaDescription: result.metaDescription,
      })
      setRows(
        result.outline.map((row) => ({
          id: crypto.randomUUID(),
          type: row.type,
          // The server refuses a purpose over 500 characters.
          purpose: row.purpose.slice(0, 500),
        }))
      )
      setStage("outline")
    } catch (error) {
      setPlanError(displayError(error, t("planFailed")))
    }
    // No finally clause: the React Compiler skips components that use one.
    setPlanning(false)
  }

  async function start() {
    setStarting(true)
    setStartError(null)
    setRefused(false)
    try {
      const id = await startJob({
        input: {
          kind: "write",
          brief: brief.trim(),
          locale,
          meta,
          rows: rows.map((row) => ({
            sliceType: row.type,
            purpose: row.purpose,
          })),
        },
      })
      setJobId(id)
      setStage("running")
    } catch (error) {
      if (
        error instanceof ConvexError &&
        error.data === "AI_JOB_ALREADY_ACTIVE"
      )
        setRefused(true)
      else setStartError(displayError(error, t("startFailed")))
    }
    setStarting(false)
  }

  return (
    <>
      {refused && <RunningJobNotice active={active} onFollow={onFollow} />}
      {stage === "brief" && (
        <BriefStep
          brief={brief}
          setBrief={setBrief}
          locale={locale}
          setLocale={setLocale}
          languages={languages}
          defaultLocale={defaultLocale}
          brandVoice={settings?.brandVoice ?? ""}
          seeds={presets instanceof Error ? [] : (presets?.pageBriefs ?? [])}
          planning={planning}
          planError={planError}
          onCancel={onClose}
          onSubmit={plan}
        />
      )}
      {stage === "outline" && (
        <OutlineStep
          meta={meta}
          setMeta={setMeta}
          rows={rows}
          updateRow={(id, patch) =>
            setRows((current) =>
              current.map((row) => (row.id === id ? { ...row, ...patch } : row))
            )
          }
          removeRow={(id) =>
            setRows((current) => current.filter((row) => row.id !== id))
          }
          addRow={() =>
            setRows((current) =>
              current.length >= MAX_SECTIONS
                ? current
                : [
                    ...current,
                    {
                      id: crypto.randomUUID(),
                      type: INSTALLED_SLICE_TYPES[0]!,
                      purpose: "",
                    },
                  ]
            )
          }
          dragHandlers={dragHandlers}
          starting={starting}
          startError={startError}
          onBack={() => setStage("brief")}
          onSubmit={start}
        />
      )}
      {stage === "running" && job && (
        <PageJobCard
          job={job}
          otherJobActive={active !== undefined && active.jobId !== job.jobId}
          onFinish={onClose}
        />
      )}
    </>
  )
}

function BriefStep({
  brief,
  setBrief,
  locale,
  setLocale,
  languages,
  defaultLocale,
  brandVoice,
  seeds,
  planning,
  planError,
  onCancel,
  onSubmit,
}: {
  brief: string
  setBrief: (value: string) => void
  locale: WriteLocale
  setLocale: (value: WriteLocale) => void
  languages: readonly WriteLocale[]
  defaultLocale: string
  brandVoice: string
  seeds: readonly { label: string; body: string }[]
  planning: boolean
  planError: string | null
  onCancel: () => void
  onSubmit: () => void
}) {
  const t = useTranslations("pages.aiWrite.wizard")
  const tNew = useTranslations("pages.newForm")
  const [seedsOpen, setSeedsOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  function cancelLeave() {
    if (leaveTimer.current !== null) clearTimeout(leaveTimer.current)
    leaveTimer.current = null
  }
  function scheduleLeave() {
    cancelLeave()
    leaveTimer.current = setTimeout(() => setSeedsOpen(false), 150)
  }
  useEffect(() => {
    const timer = leaveTimer
    return () => {
      if (timer.current !== null) clearTimeout(timer.current)
    }
  }, [])
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-1.5 flex items-center justify-between">
          <label htmlFor="wizard-brief" className="text-sm font-medium">
            {t("brief")}
          </label>
          {seeds.length > 0 && (
            <DropdownMenu
              modal={false}
              open={seedsOpen}
              onOpenChange={(next) => {
                cancelLeave()
                setSeedsOpen(next)
              }}
            >
              <DropdownMenuTrigger asChild>
                <button
                  ref={trigger}
                  type="button"
                  data-testid="starting-brief"
                  onPointerEnter={cancelLeave}
                  onPointerLeave={scheduleLeave}
                  className="rounded-md border bg-background px-2 py-1 text-xs hover:bg-accent"
                >
                  {t("startingBrief")}
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent
                sideOffset={0}
                align="end"
                className="max-h-64 w-72"
                onPointerEnter={cancelLeave}
                onPointerLeave={scheduleLeave}
                onCloseAutoFocus={(event) => {
                  event.preventDefault()
                  trigger.current?.focus()
                }}
              >
                {seeds.map((seed) => (
                  <DropdownMenuItem
                    key={seed.label}
                    className="flex-col items-stretch gap-0"
                    onSelect={() => setBrief(seed.body)}
                  >
                    <div className="font-medium">{seed.label}</div>
                    <div className="line-clamp-2 text-xs text-muted-foreground">
                      {seed.body}
                    </div>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
        <textarea
          id="wizard-brief"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          maxLength={2000}
          rows={5}
          placeholder={t("briefPlaceholder")}
          className="w-full resize-y rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
        />
        <p className="mt-1 text-xs text-muted-foreground">{t("briefHelp")}</p>
        {planError && (
          <p role="alert" className="mt-2 text-sm text-destructive">
            {planError}
          </p>
        )}
      </div>

      <div>
        <label
          htmlFor="wizard-locale"
          className="mb-1.5 block text-sm font-medium"
        >
          {t("language")}
        </label>
        <select
          id="wizard-locale"
          value={locale}
          onChange={(event) => setLocale(event.target.value as WriteLocale)}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
        >
          {languages.map((code) => (
            <option key={code} value={code}>
              {getLocaleLabel(code)}
              {code === defaultLocale ? tNew("defaultLanguage") : ""}
            </option>
          ))}
        </select>
      </div>

      <div className="rounded-md border bg-muted/40 p-3">
        <div className="mb-1 text-xs font-medium text-muted-foreground">
          {t("brandVoice")}
        </div>
        <p className="text-sm">
          {brandVoice ? (
            brandVoice
          ) : (
            <span className="text-muted-foreground italic">
              {t("noBrandVoice")}
            </span>
          )}
        </p>
      </div>

      <DialogFooter>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
        >
          {t("cancel")}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!brief.trim() || planning}
          className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {planning && <Loader2 className="size-3.5 animate-spin" />}
          {planning ? t("planning") : planError ? t("planAgain") : t("plan")}
        </button>
      </DialogFooter>
    </div>
  )
}

function OutlineStep({
  meta,
  setMeta,
  rows,
  updateRow,
  removeRow,
  addRow,
  dragHandlers,
  starting,
  startError,
  onBack,
  onSubmit,
}: {
  meta: Meta
  setMeta: (meta: Meta) => void
  rows: OutlineRow[]
  updateRow: (id: string, patch: Partial<OutlineRow>) => void
  removeRow: (id: string) => void
  addRow: () => void
  dragHandlers: ReturnType<typeof useDragReorder>["dragHandlers"]
  starting: boolean
  startError: string | null
  onBack: () => void
  onSubmit: () => void
}) {
  const t = useTranslations("pages.aiWrite.wizard")
  const tSettings = useTranslations("editor.settings")
  return (
    <div className="-mx-6 max-h-[60vh] space-y-4 overflow-y-auto px-6">
      <div className="grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label
            htmlFor="wizard-page-title"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("pageTitle")}
          </label>
          <input
            id="wizard-page-title"
            type="text"
            value={meta.title}
            onChange={(event) =>
              setMeta({ ...meta, title: event.target.value })
            }
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div>
          <label
            htmlFor="wizard-page-slug"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {tSettings("slug")}
          </label>
          <input
            id="wizard-page-slug"
            type="text"
            value={meta.slug}
            onChange={(event) => setMeta({ ...meta, slug: event.target.value })}
            className="w-full rounded-md border bg-background px-3 py-1.5 font-mono text-sm"
          />
        </div>
        <div>
          <label
            htmlFor="wizard-meta-title"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("metaTitle")}
          </label>
          <input
            id="wizard-meta-title"
            type="text"
            value={meta.metaTitle}
            onChange={(event) =>
              setMeta({ ...meta, metaTitle: event.target.value })
            }
            className="w-full rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
        <div className="col-span-2">
          <label
            htmlFor="wizard-meta-desc"
            className="mb-1 block text-xs font-medium text-muted-foreground"
          >
            {t("metaDescription")}
          </label>
          <textarea
            id="wizard-meta-desc"
            value={meta.metaDescription}
            onChange={(event) =>
              setMeta({ ...meta, metaDescription: event.target.value })
            }
            rows={2}
            className="w-full resize-y rounded-md border bg-background px-3 py-1.5 text-sm"
          />
        </div>
      </div>

      <div className="space-y-2">
        <div className="text-sm font-medium">{t("sections")}</div>
        {rows.length === 0 && (
          <p className="text-sm text-muted-foreground italic">
            {t("noSections")}
          </p>
        )}
        <ul className="space-y-2">
          {rows.map((row, index) => (
            <li
              key={row.id}
              {...dragHandlers(index)}
              className="flex items-start gap-2 rounded-md border bg-card p-2"
            >
              <button
                type="button"
                className="mt-1 cursor-grab text-muted-foreground hover:text-foreground"
                aria-label={t("dragToReorder")}
              >
                <GripVertical className="size-4" />
              </button>
              <select
                value={row.type}
                onChange={(event) =>
                  updateRow(row.id, { type: event.target.value })
                }
                className="mt-0.5 rounded-md border bg-background px-2 py-1 text-xs"
              >
                {INSTALLED_SLICE_TYPES.map((type) => (
                  <option key={type} value={type}>
                    {readSliceMetadata(type)?.label ?? type}
                  </option>
                ))}
              </select>
              <textarea
                value={row.purpose}
                onChange={(event) =>
                  updateRow(row.id, { purpose: event.target.value })
                }
                maxLength={500}
                rows={2}
                placeholder={t("purposePlaceholder")}
                aria-label={t("purposeLabel")}
                className="flex-1 resize-y rounded-md border bg-background px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={() => removeRow(row.id)}
                className="mt-1 p-1 text-muted-foreground hover:text-destructive"
                aria-label={t("removeSection")}
              >
                <X className="size-4" />
              </button>
            </li>
          ))}
        </ul>
        <button
          type="button"
          disabled={rows.length >= MAX_SECTIONS}
          onClick={addRow}
          className="mt-2 inline-flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed px-3 py-2 text-sm hover:bg-accent"
        >
          <Plus className="size-3.5" />
          {t("addSection")}
        </button>
      </div>

      {startError && (
        <p role="alert" className="text-sm text-destructive">
          {startError}
        </p>
      )}

      <DialogFooter>
        <button
          type="button"
          onClick={onBack}
          className="rounded-md border px-3 py-1.5 text-sm hover:bg-accent"
        >
          {t("back")}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          data-testid="start-job"
          disabled={
            starting ||
            !meta.title.trim() ||
            rows.length === 0 ||
            rows.some((row) => !row.purpose.trim())
          }
          className="rounded-md bg-primary px-3 py-1.5 text-sm text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {t("start")}
        </button>
      </DialogFooter>
    </div>
  )
}

"use client"

import { isModuleConfigurationStale } from "../module-gate"
import { useModuleGate, useModuleStateFailure } from "../admin-module-state-provider"
import {
  Component,
  useEffect,
  useState,
  type ComponentType,
  type ReactNode,
} from "react"
import Link from "next/link"
import { useMutation, useQuery } from "convex/react"
import type { FunctionArgs, FunctionReturnType } from "convex/server"
import { useTranslations } from "next-intl"
import { ChevronRight, CircleCheck, RefreshCw } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { MODULE_CATALOG } from "@/lib/modules/catalog"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { cn } from "@/lib/utils"

type AdminMessages = typeof import("../../../messages/admin/en.json")
type ModuleMessageId = Extract<
  keyof AdminMessages["settings"]["modules"]["items"],
  string
>
type ModuleMessageField = "name" | "summary"

const MODULE_MESSAGE_IDS = [
  "system",
  "owner-access",
  "content-model",
  "content-editor",
  "publication",
  "media",
  "language",
  "email",
  "redirects",
  "multilingual",
  "ai",
] as const satisfies readonly ModuleMessageId[]

function moduleMessageId(moduleId: string): ModuleMessageId | null {
  return MODULE_MESSAGE_IDS.find((candidate) => candidate === moduleId) ?? null
}

function moduleMessageKey(
  moduleId: ModuleMessageId,
  field: ModuleMessageField
) {
  return `items.${moduleId}.${field}` as const
}

/**
 * What a module adds to the Modules page. A row shows only name, summary and
 * the switch; setup lives on the module's own page.
 */
type ModuleSlots = Readonly<{
  /** In the module's review row while it is being turned off. */
  offNote?: ComponentType
}>
type ModuleSlotMap = Readonly<Partial<Record<string, ModuleSlots>>>

const MODULE_SLOTS: ModuleSlotMap = {}

const OPTIONAL_MODULES = MODULE_CATALOG.filter((descriptor) => !descriptor.required)
const ALWAYS_ON_MODULES = MODULE_CATALOG.filter((descriptor) => descriptor.required)

/** Each Apply step stays on screen at least this long so it can be read. */
const STEP_MIN_MS = 400
/** After the save, wait at most this long for the live state to show the change. */
const SETTLE_MAX_MS = 5000

/** One Apply, from click to Close. `shown` trails the real work by at most one step per STEP_MIN_MS. */
type ApplyRun = {
  key: number
  title: string
  steps: string[]
  targets: { moduleId: string; enabled: boolean }[]
  /** saving: commit in flight; settling: saved, waiting for the live state; noop and failed are final. */
  phase: "saving" | "settling" | "noop" | "failed"
  result: string
  shown: number
  shownAt: number
  settleBy: number
  timedOut: boolean
}

/** On a narrow screen Apply sits below the fold: bring the new panel into view. */
function scrollIntoViewOnMount(node: HTMLDivElement | null) {
  node?.scrollIntoView?.({ block: "nearest" })
}

type ModuleTransitionRequest = FunctionArgs<
  typeof api.cms.modules.preview
>["changes"][number]
type ModulePreview = FunctionReturnType<typeof api.cms.modules.preview>
type ModuleBlocker = ModulePreview["blockers"][number]

function requireBlockerPayload(valid: boolean): asserts valid {
  if (!valid) throw new Error("Invalid module lifecycle blocker")
}

class ModuleSettingsErrorBoundary extends Component<
  { children: ReactNode; message: string },
  { hasError: boolean }
> {
  state = { hasError: false }

  static getDerivedStateFromError() {
    return { hasError: true }
  }

  render() {
    if (this.state.hasError) {
      return (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          {this.props.message}
        </div>
      )
    }
    return this.props.children
  }
}

function ModulesSettingsContent({ slots }: { slots: ModuleSlotMap }) {
  const t = useTranslations("settings.modules")
  const redirectsGate = useModuleGate("redirects")
  const multilingualGate = useModuleGate("multilingual")
  const globalFailure = useModuleStateFailure()
  const [draftEnabled, setDraftEnabled] = useState<Record<string, boolean>>({})
  const [pendingBaseVersion, setPendingBaseVersion] = useState<number | null>(
    null
  )
  const [saving, setSaving] = useState(false)
  const [commitStale, setCommitStale] = useState(false)
  const [run, setRun] = useState<ApplyRun | null>(null)
  const [alwaysOnOpen, setAlwaysOnOpen] = useState(false)

  const changes: ModuleTransitionRequest[] = MODULE_CATALOG.flatMap(
    (descriptor) =>
      descriptor.required || draftEnabled[descriptor.id] === undefined
        ? []
        : [{ moduleId: descriptor.id, enabled: draftEnabled[descriptor.id]! }]
  )

  const currentPreview = useQuery(api.cms.modules.preview, {
    changes: [],
  })
  const pendingPreview = useQuery(
    api.cms.modules.preview,
    changes.length > 0 ? { changes } : "skip"
  )
  const commit = useMutation(api.cms.modules.commit)
  const pendingBlockers = pendingPreview?.blockers ?? []

  const baseline = currentPreview?.readiness ?? []
  const review = changes.length > 0 ? pendingPreview : currentPreview
  const reviewBlockers = review?.blockers ?? []
  const stateById = new Map(baseline.map((state) => [state.moduleId, state]))
  const reviewedById = new Map(
    (review?.readiness ?? []).map((state) => [state.moduleId, state])
  )
  const isStale = commitStale ||
    changes.length > 0 &&
    pendingBaseVersion !== null &&
    ((currentPreview !== undefined &&
      currentPreview.configurationVersion !== pendingBaseVersion) ||
      (pendingPreview !== undefined &&
        pendingPreview.configurationVersion !== pendingBaseVersion))

  // Apply progress. Real work: 1 step once the reviewed preview is current, 2 once
  // the commit is saved, then one per changed module the live state shows.
  let reached = 0
  let finalStep = 0
  if (run) {
    const settled = run.timedOut
      ? run.targets.length
      : run.targets.findIndex(
          (target) => stateById.get(target.moduleId)?.enabled !== target.enabled
        )
    reached =
      run.phase === "saving" || run.phase === "failed"
        ? 1
        : run.phase === "noop"
          ? 2
          : 2 + (settled === -1 ? run.targets.length : settled)
    finalStep =
      run.phase === "saving"
        ? Number.POSITIVE_INFINITY
        : run.phase === "failed"
          ? 1
          : run.phase === "noop"
            ? 2
            : run.steps.length
  }
  const runStatus = !run
    ? null
    : // `shown` only advances up to `reached`, so the end stays put once shown.
      run.shown >= finalStep
      ? run.phase === "settling"
        ? "done"
        : run.phase
      : "running"
  const busy = saving || runStatus === "running"
  const percent = !run
    ? 0
    : runStatus === "done" || runStatus === "noop"
      ? 100
      : Math.round((run.shown / run.steps.length) * 100)

  useEffect(() => {
    if (!run) return
    const key = run.key
    const timers: ReturnType<typeof setTimeout>[] = []
    if (run.shown < Math.min(reached, finalStep))
      timers.push(
        setTimeout(
          () =>
            setRun((current) =>
              current?.key === key
                ? { ...current, shown: current.shown + 1, shownAt: Date.now() }
                : current
            ),
          Math.max(0, run.shownAt + STEP_MIN_MS - Date.now())
        )
      )
    if (run.phase === "settling" && !run.timedOut && reached < run.steps.length)
      timers.push(
        setTimeout(
          () =>
            setRun((current) =>
              current?.key === key ? { ...current, timedOut: true } : current
            ),
          Math.max(0, run.settleBy - Date.now())
        )
      )
    return () => timers.forEach(clearTimeout)
  }, [run, reached, finalStep])

  function labelFor(moduleId: string) {
    const descriptor = MODULE_CATALOG.find(
      (candidate) => candidate.id === moduleId
    )
    const messageId = descriptor ? moduleMessageId(descriptor.id) : null
    return messageId ? t(moduleMessageKey(messageId, "name")) : moduleId
  }

  function summaryFor(moduleId: string, fallback: string) {
    const messageId = moduleMessageId(moduleId)
    return messageId ? t(moduleMessageKey(messageId, "summary")) : fallback
  }

  function renderBlocker(blocker: ModuleBlocker): ReactNode {
    requireBlockerPayload(typeof blocker.moduleId === "string")
    const code = blocker.code
    switch (code) {
      case "DEPENDENCY_NOT_LISTED":
        requireBlockerPayload(typeof blocker.relatedModuleId === "string")
        return t("dependencyBlocker", {
          name: labelFor(blocker.moduleId),
          relatedName: labelFor(blocker.relatedModuleId),
        })
      case "DEPENDANT_ENABLED":
        requireBlockerPayload(typeof blocker.relatedModuleId === "string")
        return t("dependantBlocker", {
          name: labelFor(blocker.moduleId),
          relatedName: labelFor(blocker.relatedModuleId),
        })
      case "REQUIRED_MODULE":
        requireBlockerPayload(typeof blocker.relatedModuleId === "string")
        return t("requiredBlocker", { name: labelFor(blocker.moduleId) })
      case "REDIRECT_RULES_PRESENT":
        requireBlockerPayload(
          blocker.moduleId === "redirects" &&
            Number.isSafeInteger(blocker.ruleCount) &&
            blocker.ruleCount >= 0 &&
            typeof blocker.moreRules === "boolean" &&
            Array.isArray(blocker.rules) &&
            blocker.rules.every(
              (rule) =>
                rule !== null &&
                typeof rule === "object" &&
                typeof rule.ruleId === "string" &&
                typeof rule.fromPath === "string" &&
                (rule.locale === undefined || typeof rule.locale === "string")
            )
        )
        return (
          <>
            {blocker.moreRules
              ? t("redirectRulesBlockerMore", { count: blocker.rules.length })
              : t("redirectRulesBlocker", { count: blocker.ruleCount })}
            <ul
              className="mt-1 list-disc space-y-0.5 pl-5"
              data-testid="redirect-rules-blocker"
            >
              {blocker.rules.map((rule) => (
                <li key={rule.ruleId}>
                  {rule.locale === undefined
                    ? rule.fromPath
                    : t("redirectRuleLocale", {
                        fromPath: rule.fromPath,
                        locale: rule.locale,
                      })}
                </li>
              ))}
            </ul>
          </>
        )
      case "MULTILINGUAL_AUTHORITY_ACTIVE":
        requireBlockerPayload(
          blocker.moduleId === "multilingual" &&
            Array.isArray(blocker.locales) &&
            blocker.locales.every((locale) => typeof locale === "string")
        )
        return (
          <>
            <p>{t("multilingualActiveBlocker")}</p>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {blocker.locales.map((locale) => (
                <li key={locale}>
                  <Link
                    href="/admin/settings/languages"
                    className="underline underline-offset-4"
                  >
                    {t("manageLanguage", { language: getLocaleDisplayName(locale) })}
                  </Link>
                </li>
              ))}
              <li>
                <Link
                  href="/admin/settings/languages"
                  className="underline underline-offset-4"
                >
                  {t("returnToOneLanguage")}
                </Link>
              </li>
            </ul>
          </>
        )
      case "LANGUAGE_OPERATION_OPEN":
        requireBlockerPayload(
          blocker.moduleId === "multilingual" &&
            (blocker.kind === "language_transition" ||
              blocker.kind === "default_migration")
        )
        return (
          <>
            {t("languageOperationBlocker")}{" "}
            <Link
              href="/admin/settings/languages"
              className="underline underline-offset-4"
            >
              {t("openLanguages")}
            </Link>
          </>
        )
      case "LANGUAGE_STATE_INVALID":
        requireBlockerPayload(blocker.moduleId === "multilingual")
        return t("languageStateInvalid")
      default: {
        const unhandledCode: never = code
        throw new Error(
          `Unsupported module lifecycle blocker: ${unhandledCode}`
        )
      }
    }
  }

  function toggle(moduleId: string) {
    const descriptor = MODULE_CATALOG.find(
      (candidate) => candidate.id === moduleId
    )
    const current =
      reviewedById.get(moduleId)?.enabled ?? stateById.get(moduleId)?.enabled
    if (!descriptor || descriptor.required || current === undefined || busy)
      return

    const next = { ...draftEnabled, [moduleId]: !current }
    const baselineEnabled = stateById.get(moduleId)?.enabled
    if (baselineEnabled === next[moduleId]) delete next[moduleId]
    setDraftEnabled(next)
    setPendingBaseVersion(
      Object.keys(next).length === 0
        ? null
        : (pendingBaseVersion ?? currentPreview?.configurationVersion ?? null)
    )
    setCommitStale(false)
  }

  function reviewCurrentConfiguration() {
    setDraftEnabled({})
    setPendingBaseVersion(null)
    setCommitStale(false)
  }

  async function apply() {
    if (
      !pendingPreview ||
      pendingBlockers.length > 0 ||
      isStale ||
      busy
    )
      return
    // Snapshot the wording now: the draft resets once the commit is saved.
    const values = (change: ModuleTransitionRequest) => ({
      id: change.moduleId,
      name: labelFor(change.moduleId),
    })
    const one = changes.length === 1 ? changes[0]! : null
    const now = Date.now()
    setRun({
      key: now,
      title: one
        ? t(one.enabled ? "progress.turningOn" : "progress.turningOff", values(one))
        : t("progress.applyingMany", { count: changes.length }),
      steps: [
        t("progress.stepCheck"),
        t("progress.stepSave"),
        ...changes.map((change) =>
          t(change.enabled ? "progress.stepOn" : "progress.stepOff", values(change))
        ),
      ],
      targets: changes,
      phase: "saving",
      result: one
        ? t(one.enabled ? "progress.doneOn" : "progress.doneOff", values(one))
        : t("progress.doneMany", { count: changes.length }),
      shown: 0,
      shownAt: now,
      settleBy: 0,
      timedOut: false,
    })
    setSaving(true)
    setCommitStale(false)
    try {
      const result = await commit({
        expectedConfigurationVersion: pendingPreview.configurationVersion,
        changes: pendingPreview.changes.map(({ moduleId, toEnabled }) => ({ moduleId, enabled: toEnabled })),
        multilingualCommandTokens: pendingPreview.multilingualCommandTokens,
      })
      setDraftEnabled({})
      setPendingBaseVersion(null)
      setRun((current) =>
        current?.key !== now
          ? current
          : result.committed
            ? { ...current, phase: "settling", settleBy: Date.now() + SETTLE_MAX_MS }
            : { ...current, phase: "noop", result: t("noChanges") }
      )
    } catch (error) {
      const stale = isModuleConfigurationStale(error)
      if (stale) {
        // The stale alert above the modules takes over; the draft stays.
        setRun(null)
        setCommitStale(true)
      } else {
        setDraftEnabled({})
        setPendingBaseVersion(null)
        setRun((current) =>
          current?.key === now
            ? { ...current, phase: "failed", result: t("commitFailed") }
            : current
        )
      }
    }
    setSaving(false)
  }

  if (currentPreview === undefined) {
    return (
      <div className="space-y-4" aria-busy={true} aria-live="polite">
        <p className="text-sm text-muted-foreground">{t("loading")}</p>
        <Skeleton className="h-36 w-full" />
        <Skeleton className="h-36 w-full" />
      </div>
    )
  }

  // While the saved change settles, rows already show where they are going.
  const settlingTargets = new Map(
    run?.phase === "settling" && runStatus === "running"
      ? run.targets.map((target) => [target.moduleId, target.enabled])
      : []
  )

  function gateFor(moduleId: string) {
    return moduleId === "redirects"
      ? redirectsGate
      : moduleId === "multilingual"
        ? multilingualGate
        : null
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {run && runStatus && (
        <Card
          key={run.key}
          ref={scrollIntoViewOnMount}
          data-testid="apply-progress"
          // Clears the fixed sidebar button and development badge (top 3 + 2rem).
          className="scroll-mt-14"
          data-status={runStatus}
          role="status"
          aria-live="polite"
        >
          <CardContent className="space-y-3">
            <div className="flex items-baseline justify-between gap-3">
              <p className="font-medium" data-testid="apply-title">
                {run.title}
              </p>
              <span
                aria-hidden={true}
                className="text-sm text-muted-foreground tabular-nums"
              >
                {t("progress.percent", { percent })}
              </span>
            </div>
            <Progress value={percent} aria-label={run.title} />
            <div className="flex min-h-8 items-center justify-between gap-3">
              <p
                data-testid="apply-step"
                className={cn(
                  "flex items-center gap-2 text-sm text-muted-foreground",
                  runStatus === "failed" && "text-destructive",
                  runStatus === "done" && "text-foreground"
                )}
              >
                {runStatus === "done" && (
                  <CircleCheck
                    aria-hidden={true}
                    className="size-4 shrink-0 text-green-600"
                  />
                )}
                {runStatus === "running" ? run.steps[run.shown] : run.result}
              </p>
              {runStatus !== "running" && (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => setRun(null)}
                >
                  {t("progress.close")}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {isStale && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t("stale")}</span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={reviewCurrentConfiguration}
            >
              {t("reviewAgain")}
            </Button>
          </div>
        </div>
      )}

      <Card data-testid="optional-modules">
        <CardHeader>
          <CardTitle>{t("optional")}</CardTitle>
        </CardHeader>
        <CardContent>
          {OPTIONAL_MODULES.map((descriptor) => {
            const state =
              reviewedById.get(descriptor.id) ?? stateById.get(descriptor.id)
            if (!state) return null
            const enabled = settlingTargets.get(descriptor.id) ?? state.enabled
            const hasPendingValue = draftEnabled[descriptor.id] !== undefined
            const name = labelFor(descriptor.id)
            const gate = gateFor(descriptor.id)
            return (
              <div key={descriptor.id} data-testid={`module-${descriptor.id}`}>
                <Separator />
                <div className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between sm:gap-3">
                  <div className="min-w-0">
                    <p className="font-medium">{name}</p>
                    <p className="text-sm text-muted-foreground">
                      {summaryFor(descriptor.id, descriptor.summary)}
                    </p>
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={t("toggle", { name })}
                      checked={enabled}
                      disabled={
                        busy ||
                        gate?.state === "loading" ||
                        gate?.state === "error"
                      }
                      onChange={() => toggle(descriptor.id)}
                      className="size-4 accent-primary"
                    />
                    <span>{enabled ? t("enabled") : t("disabled")}</span>
                  </label>
                </div>
                <div className="flex flex-col gap-2 pb-4 empty:hidden">
                  {gate?.state === "error" && !globalFailure && (
                    <p role="alert" className="text-sm text-destructive">
                      {t("moduleError", { name })}
                    </p>
                  )}
                  {gate?.state === "loading" && (
                    <p className="text-sm text-muted-foreground">
                      {t("loading")}
                    </p>
                  )}
                  {hasPendingValue && review === undefined && (
                    <p
                      className="text-sm text-muted-foreground"
                      aria-live="polite"
                    >
                      {t("reviewing")}
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t("exactChanges")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {review === undefined && changes.length > 0 ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t("reviewing")}
            </p>
          ) : review?.changes.length ? (
            <ul className="space-y-2 text-sm" data-testid="module-changes">
              {review.changes.map((change) => {
                const OffNote = change.toEnabled
                  ? undefined
                  : slots[change.moduleId]?.offNote
                return (
                  <li key={change.moduleId} className="rounded-md border p-3">
                    <div className="flex items-center justify-between gap-3">
                      <span>{labelFor(change.moduleId)}</span>
                      <span className="text-muted-foreground">
                        {change.fromEnabled ? t("enabled") : t("disabled")}{" "}
                        {"→"}{" "}
                        {change.toEnabled ? t("enabled") : t("disabled")}
                      </span>
                    </div>
                    {OffNote && <OffNote />}
                  </li>
                )
              })}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noChanges")}</p>
          )}

          {reviewBlockers.length ? (
            <div
              role="alert"
              className="rounded-md border border-destructive/40 bg-destructive/5 p-3"
            >
              <h3 className="text-sm font-medium text-destructive">
                {t("blockers")}
              </h3>
              <ul className="mt-2 space-y-1 text-sm text-destructive">
                {reviewBlockers.map((blocker, index) => (
                  <li key={`${blocker.code}:${blocker.moduleId}:${index}`}>
                    {renderBlocker(blocker)}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <div className="flex items-center justify-end gap-3 border-t pt-4">
            <Button
              type="button"
              onClick={apply}
              disabled={
                changes.length === 0 ||
                pendingPreview === undefined ||
                pendingBlockers.length > 0 ||
                isStale ||
                busy
              }
            >
              {busy ? (
                <RefreshCw aria-hidden={true} className="animate-spin" />
              ) : null}
              {busy ? t("saving") : t("save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card data-testid="always-on">
        <Collapsible open={alwaysOnOpen} onOpenChange={setAlwaysOnOpen}>
          <CardHeader>
            <div className="flex items-start justify-between gap-3">
              <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
                <CardTitle className="flex items-center gap-1.5">
                  <ChevronRight
                    aria-hidden={true}
                    className={cn(
                      "size-4 shrink-0 transition-transform",
                      alwaysOnOpen && "rotate-90"
                    )}
                  />
                  {t("alwaysOn", { count: ALWAYS_ON_MODULES.length })}
                </CardTitle>
                <p className="text-sm text-muted-foreground">
                  {t("alwaysOnLine")}
                </p>
              </div>
              <CollapsibleTrigger asChild>
                <Button type="button" variant="ghost" size="sm">
                  {alwaysOnOpen ? t("hide") : t("show")}
                </Button>
              </CollapsibleTrigger>
            </div>
          </CardHeader>
          <CollapsibleContent>
            <CardContent className="pt-4">
              <ul
                data-testid="always-on-list"
                className="list-disc space-y-1 pl-5 text-sm sm:columns-2 sm:gap-8"
              >
                {ALWAYS_ON_MODULES.map((descriptor) => (
                  <li
                    key={descriptor.id}
                    data-testid={`module-${descriptor.id}`}
                    className="break-inside-avoid"
                  >
                    {descriptor.id === "language"
                      ? t("itemWithNote", {
                          name: labelFor(descriptor.id),
                          note: t("languageAlwaysOn"),
                        })
                      : labelFor(descriptor.id)}
                  </li>
                ))}
              </ul>
            </CardContent>
          </CollapsibleContent>
        </Collapsible>
      </Card>
    </div>
  )
}

export function ModulesSettings({
  slots = MODULE_SLOTS,
}: {
  /** Defaults to the installed modules' contributions; tests pass their own. */
  slots?: ModuleSlotMap
} = {}) {
  const t = useTranslations("settings.modules")
  return (
    <ModuleSettingsErrorBoundary message={t("error")}>
      <ModulesSettingsContent slots={slots} />
    </ModuleSettingsErrorBoundary>
  )
}

"use client"

import { isModuleConfigurationStale } from "../module-gate"
import { useModuleGate, useModuleStateFailure } from "../admin-module-state-provider"
import { Component, useState, type ReactNode } from "react"
import Link from "next/link"
import { useMutation, useQuery } from "convex/react"
import type { FunctionArgs, FunctionReturnType } from "convex/server"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Languages, Package, RefreshCw } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { MODULE_CATALOG } from "@/lib/modules/catalog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Skeleton } from "@/components/ui/skeleton"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { ADMIN_AI_SETTINGS_BROWSER_BINDING } from "../contributions/ai-settings"


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

function ModulesSettingsContent() {
  const t = useTranslations("settings.modules")
  const redirectsGate = useModuleGate("redirects")
  const multilingualGate = useModuleGate("multilingual")
  const globalFailure = useModuleStateFailure()
  const [draftEnabled, setDraftEnabled] = useState<Record<string, boolean>>({})
  const [pendingBaseVersion, setPendingBaseVersion] = useState<number | null>(
    null
  )
  const [saving, setSaving] = useState(false)
  const [actionError, setActionError] = useState<"stale" | "commitFailed" | null>(null)

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
  const isStale = actionError === "stale" ||
    changes.length > 0 &&
    pendingBaseVersion !== null &&
    ((currentPreview !== undefined &&
      currentPreview.configurationVersion !== pendingBaseVersion) ||
      (pendingPreview !== undefined &&
        pendingPreview.configurationVersion !== pendingBaseVersion))

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
    if (!descriptor || descriptor.required || current === undefined || saving)
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
    setActionError(null)
  }

  function reviewCurrentConfiguration() {
    setDraftEnabled({})
    setPendingBaseVersion(null)
    setActionError(null)
  }

  async function apply() {
    if (
      !pendingPreview ||
      pendingBlockers.length > 0 ||
      isStale ||
      saving
    )
      return
    setSaving(true)
    setActionError(null)
    try {
      const result = await commit({
        expectedConfigurationVersion: pendingPreview.configurationVersion,
        changes: pendingPreview.changes.map(({ moduleId, toEnabled }) => ({ moduleId, enabled: toEnabled })),
        multilingualCommandTokens: pendingPreview.multilingualCommandTokens,
      })
      const committed = result.committed
      setDraftEnabled({})
      setPendingBaseVersion(null)
      toast.success(t(committed ? "saved" : "noChanges"))
    } catch (error) {
      const stale = isModuleConfigurationStale(error)
      if (!stale) {
        setDraftEnabled({})
        setPendingBaseVersion(null)
      }
      setActionError(stale ? "stale" : "commitFailed")
      toast.error(stale ? t("stale") : t("commitFailed"))
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

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="mt-1 text-sm text-muted-foreground">{t("subtitle")}</p>
      </div>

      {(actionError === "stale" || isStale) && (
        <div
          role="alert"
          className="rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm text-destructive"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <span>{t(actionError ?? "stale")}</span>
            {isStale && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={reviewCurrentConfiguration}
              >
                {t("reviewAgain")}
              </Button>
            )}
          </div>
        </div>
      )}

      <section aria-label={t("title")} className="space-y-4">
        {MODULE_CATALOG.map((descriptor) => {
          const state =
            reviewedById.get(descriptor.id) ?? stateById.get(descriptor.id)
          if (!state) return null
          const hasPendingValue = draftEnabled[descriptor.id] !== undefined
          const name = labelFor(descriptor.id)
          return (
            <Card key={descriptor.id} data-testid={`module-${descriptor.id}`}>
              <CardHeader className="gap-3 sm:flex sm:flex-row sm:items-start sm:justify-between">
                <div className="flex min-w-0 gap-3">
                  <Package
                    aria-hidden={true}
                    className="mt-0.5 size-5 shrink-0 text-muted-foreground"
                  />
                  <div className="min-w-0">
                    <CardTitle>{name}</CardTitle>
                    <CardDescription>
                      {summaryFor(descriptor.id, descriptor.summary)}
                    </CardDescription>
                  </div>
                </div>
                <div className="flex shrink-0 items-center gap-3">
                  {descriptor.id === "multilingual" &&
                    state.enabled &&
                    !hasPendingValue && (
                      <Button asChild variant="outline" size="sm">
                        <Link href="/admin/settings/languages">
                          <Languages aria-hidden={true} />
                          {t("openLanguages")}
                        </Link>
                      </Button>
                    )}
                  <label className="flex shrink-0 items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      aria-label={t("toggle", { name })}
                      checked={state.enabled}
                      disabled={descriptor.required || saving || (descriptor.id === "redirects" ? redirectsGate : descriptor.id === "multilingual" ? multilingualGate : { state: "on" }).state === "loading" || (descriptor.id === "redirects" ? redirectsGate : descriptor.id === "multilingual" ? multilingualGate : { state: "on" }).state === "error"}
                      onChange={() => toggle(descriptor.id)}
                      className="size-4 accent-primary"
                    />
                    <span>{state.enabled ? t("enabled") : t("disabled")}</span>
                  </label>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                {((descriptor.id === "redirects" && redirectsGate.state === "error") || (descriptor.id === "multilingual" && multilingualGate.state === "error")) && !globalFailure && <p role="alert" className="text-sm text-destructive">{t("moduleError", { name })}</p>}
                {((descriptor.id === "redirects" && redirectsGate.state === "loading") || (descriptor.id === "multilingual" && multilingualGate.state === "loading")) && <p className="text-sm text-muted-foreground">{t("loading")}</p>}
                {descriptor.id === "ai" && ADMIN_AI_SETTINGS_BROWSER_BINDING && <ADMIN_AI_SETTINGS_BROWSER_BINDING.ModulesSetupLine savedOn={stateById.get("ai")?.effective === true} />}
                <div
                  className="flex flex-wrap gap-2"
                  aria-label={t("statusLabel", { name })}
                >
                  <Badge
                    variant={state.available ? "secondary" : "destructive"}
                  >
                    {t("availability")}:{" "}
                    {state.available ? t("available") : t("unavailable")}
                  </Badge>
                  <Badge variant={state.effective ? "default" : "outline"}>
                    {t("effective")}:{" "}
                    {state.effective ? t("active") : t("inactive")}
                  </Badge>
                  <Badge
                    variant={
                      state.readiness === "ready" ? "secondary" : "destructive"
                    }
                  >
                    {t("readiness")}:{" "}
                    {state.readiness === "ready" ? t("ready") : t("needsSetup")}
                  </Badge>
                  <Badge variant="outline">
                    {t("setup")}:{" "}
                    {state.setup === "not_required"
                      ? t("notRequired")
                      : t("needsSetup")}
                  </Badge>
                  {descriptor.required && (
                    <Badge variant="outline">{t("required")}</Badge>
                  )}
                </div>
                <div className="grid gap-3 text-sm sm:grid-cols-2">
                  <div>
                    <h3 className="font-medium">{t("dependencies")}:</h3>
                    <p className="mt-1 text-muted-foreground">
                      {descriptor.dependencies.length === 0
                        ? t("none")
                        : descriptor.dependencies.map(labelFor).join(", ")}
                    </p>
                  </div>
                  <div>
                    <h3 className="font-medium">
                      {t("requiredDependencies")}:
                    </h3>
                    <p className="mt-1 text-muted-foreground">
                      {review?.requiredDependencies.length
                        ? review.requiredDependencies.map(labelFor).join(", ")
                        : t("none")}
                    </p>
                  </div>
                </div>
                {descriptor.id === "language" && (
                  <p className="rounded-md bg-muted/40 px-3 py-2 text-sm text-muted-foreground">
                    {t("languageAlwaysOn")}
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
              </CardContent>
            </Card>
          )
        })}
      </section>

      <Card>
        <CardHeader>
          <CardTitle>{t("exactChanges")}</CardTitle>
          <CardDescription>{t("reviewBeforeSave")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {review === undefined && changes.length > 0 ? (
            <p className="text-sm text-muted-foreground" aria-live="polite">
              {t("reviewing")}
            </p>
          ) : review?.changes.length ? (
            <ul className="space-y-2 text-sm" data-testid="module-changes">
              {review.changes.map((change) => (
                <li
                  key={change.moduleId}
                  className="flex items-center justify-between gap-3 rounded-md border p-3"
                >
                  <span>{labelFor(change.moduleId)}</span>
                  <span className="text-muted-foreground">
                    {change.fromEnabled ? t("enabled") : t("disabled")} {"→"}{" "}
                    {change.toEnabled ? t("enabled") : t("disabled")}
                  </span>
                </li>
              ))}
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
            {actionError === "commitFailed" ? <p role="alert" className="mr-auto text-sm text-destructive">{t(actionError)}</p> : <span className="mr-auto" />}
            <Button
              type="button"
              onClick={apply}
              disabled={
                changes.length === 0 ||
                pendingPreview === undefined ||
                pendingBlockers.length > 0 ||
                          isStale ||
                saving
              }
            >
              {saving ? (
                <RefreshCw aria-hidden={true} className="animate-spin" />
              ) : null}
              {saving ? t("saving") : t("save")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}

export function ModulesSettings() {
  const t = useTranslations("settings.modules")
  return (
    <ModuleSettingsErrorBoundary message={t("error")}>
      <ModulesSettingsContent />
    </ModuleSettingsErrorBoundary>
  )
}

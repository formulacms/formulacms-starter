"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AlertTriangle, CheckCircle2, Loader2, Sparkles } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { PrePublishChecklistContent } from "./pre-publish-checklist"
import {
  buildPageReadinessSuggestions,
  type PageReadinessSuggestion,
} from "../lib/readiness"
import type { PrePublishChecklist } from "../lib/types"

type PageReadinessContentProps = {
  checklist?: PrePublishChecklist
  checklistError?: boolean
  onRetry?(): void
  warningsAcknowledged: boolean
  canGenerateMeta: boolean
  isGeneratingMeta?: boolean
  onAction(suggestion: PageReadinessSuggestion): void | Promise<void>
}

export function PageReadinessContent({
  checklist,
  checklistError = false,
  onRetry,
  warningsAcknowledged,
  canGenerateMeta,
  isGeneratingMeta = false,
  onAction,
}: PageReadinessContentProps) {
  const t = useTranslations("editor.readiness")

  function suggestionLabel(suggestion: PageReadinessSuggestion): string {
    switch (suggestion.id) {
      case "focus-title":
        return t("suggestions.addTitle")
      case "add-content":
        return t("suggestions.addContent")
      case "open-content":
        return t("suggestions.reviewContent")
      case "open-seo":
        return t("suggestions.reviewSeo")
      case "generate-meta":
        return t("suggestions.generateSeo")
      case "review-locale":
        return t("suggestions.reviewLocale", {
          locale: suggestion.locale.toUpperCase(),
        })
    }
  }

  if (checklistError) {
    return (
      <div className="space-y-3">
        <p role="alert" className="text-sm text-muted-foreground">
          {t("unavailable")}
        </p>
        <button
          type="button"
          onClick={onRetry}
          className="rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent"
        >
          {t("retry")}
        </button>
        <p className="border-t pt-3 text-xs text-muted-foreground">
          {t("reportHint")}
        </p>
      </div>
    )
  }

  if (!checklist) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("checking")}
      </div>
    )
  }

  const suggestions = buildPageReadinessSuggestions(checklist, {
    canGenerateMeta,
  })

  return (
    <div className="space-y-4">
      <PrePublishChecklistContent
        checklist={checklist}
        warningsAcknowledged={warningsAcknowledged}
      />

      {suggestions.length > 0 && (
        <div className="space-y-2 border-t pt-3">
          <div className="text-xs font-semibold text-muted-foreground uppercase">
            {t("nextSteps")}
          </div>
          <div className="flex flex-wrap gap-2">
            {suggestions.map((suggestion) => {
              const key =
                suggestion.id === "review-locale"
                  ? `${suggestion.id}:${suggestion.locale}`
                  : suggestion.id
              const generating =
                suggestion.id === "generate-meta" && isGeneratingMeta
              return (
                <button
                  key={key}
                  type="button"
                  disabled={generating}
                  onClick={() => void onAction(suggestion)}
                  className="inline-flex items-center gap-1.5 rounded-md border bg-background px-2.5 py-1.5 text-xs font-medium transition-colors hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50"
                >
                  {suggestion.id === "generate-meta" && (
                    <Sparkles className="size-3.5" />
                  )}
                  {generating ? t("generating") : suggestionLabel(suggestion)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      <p className="border-t pt-3 text-xs text-muted-foreground">
        {t("reportHint")}
      </p>
    </div>
  )
}

export function PageReadinessTrigger({
  checklist,
  checklistError = false,
  onRetry,
  warningsAcknowledged,
  canGenerateMeta,
  isGeneratingMeta,
  onAction,
}: PageReadinessContentProps) {
  const t = useTranslations("editor.readiness")
  const [open, setOpen] = useState(false)
  const blockerCount = checklist?.blockers.length ?? 0
  const warningCount = checklist?.warnings.length ?? 0
  const label = checklistError
    ? t("unavailableShort")
    : !checklist
      ? t("checkingShort")
      : blockerCount > 0
        ? t("blockerCount", { count: blockerCount })
        : warningCount > 0
          ? t("warningCount", { count: warningCount })
          : t("readyShort")
  const Icon = checklistError
    ? AlertTriangle
    : !checklist
      ? Loader2
      : blockerCount > 0 || warningCount > 0
        ? AlertTriangle
        : CheckCircle2
  const iconClassName =
    checklistError || blockerCount > 0
      ? "size-3.5 text-destructive"
      : !checklist
        ? "size-3.5 animate-spin"
        : blockerCount > 0
          ? "size-3.5 text-destructive"
          : warningCount > 0
            ? "size-3.5 text-amber-600"
            : "size-3.5 text-emerald-600"

  async function handleAction(suggestion: PageReadinessSuggestion) {
    setOpen(false)
    await onAction(suggestion)
  }

  function handleRetry() {
    setOpen(false)
    onRetry?.()
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`${t("title")}: ${label}`}
          title={`${t("title")}: ${label}`}
          className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-xs transition-colors hover:bg-accent sm:hidden lg:flex lg:h-auto lg:w-auto lg:gap-1.5 lg:border lg:px-2.5 lg:py-1.5"
        >
          <Icon className={iconClassName} />
          <span className="sr-only lg:not-sr-only">{label}</span>
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-96 max-w-[calc(100vw-1.5rem)] p-3"
      >
        <div className="space-y-3">
          <div>
            <div className="text-xs font-semibold text-muted-foreground uppercase">
              {t("title")}
            </div>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("description")}
            </p>
          </div>
          <PageReadinessContent
            checklist={checklist}
            checklistError={checklistError}
            onRetry={handleRetry}
            warningsAcknowledged={warningsAcknowledged}
            canGenerateMeta={canGenerateMeta}
            isGeneratingMeta={isGeneratingMeta}
            onAction={handleAction}
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

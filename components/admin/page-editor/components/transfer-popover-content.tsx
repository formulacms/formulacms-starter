import type { Dispatch, SetStateAction } from "react"
import { useTranslations } from "next-intl"
import { ArrowRight, Copy, Sparkles } from "lucide-react"
import { PopoverContent } from "@/components/ui/popover"
import { getLocaleDisplayName, type Locale } from "@/lib/i18n/config"
import type { LocaleContentSummary, TranslateMode } from "../lib/types"

export function TransferPopoverContent({
  mode,
  currentLocale,
  otherLocales,
  currentHasContent,
  currentSummary,
  isTranslating,
  showPushOut,
  setShowPushOut,
  hasContentForMode,
  onPullCopy,
  onPullTranslate,
  onPush,
  onCloseAutoFocus,
}: {
  mode: TranslateMode
  currentLocale: Locale
  otherLocales: Locale[]
  currentHasContent: boolean
  currentSummary: LocaleContentSummary
  isTranslating: boolean
  showPushOut: boolean
  setShowPushOut: Dispatch<SetStateAction<boolean>>
  hasContentForMode: (locale: Locale, mode: TranslateMode) => boolean
  onPullCopy: (locale: Locale) => void
  onPullTranslate?: (locale: Locale) => void
  onPush: (locale: Locale, mode: TranslateMode) => void
  /** Runs as the popover closes, before focus returns to its trigger. */
  onCloseAutoFocus?: (event: Event) => void
}) {
  const t = useTranslations("editor.transfer")
  const isCopy = mode === "copy"
  const label = isCopy ? t("copyFrom") : t("translateFrom")
  const Icon = isCopy ? Copy : Sparkles
  const currentCanSend =
    mode === "copy" ? currentSummary.hasAny : currentSummary.hasTranslatable
  const hasUsableInbound = otherLocales.some((loc) =>
    hasContentForMode(loc, mode)
  )
  const expanded = showPushOut || (!hasUsableInbound && currentCanSend)
  const noContentTitle = t(
    isCopy ? "noContentToCopy" : "noContentToTranslate",
    { locale: currentLocale.toUpperCase() }
  )

  return (
    <PopoverContent
      align="end"
      className="w-80 p-2"
      onCloseAutoFocus={onCloseAutoFocus}
    >
      <div>
        <div className="px-1 pb-1 text-[11px] font-semibold text-muted-foreground uppercase">
          {t("fillFrom", { locale: currentLocale.toUpperCase() })}
        </div>
        <div className="space-y-0.5">
          {otherLocales.map((loc) => {
            const hasContent = hasContentForMode(loc, mode)
            return (
              <button
                key={`${mode}-pull-${loc}`}
                type="button"
                disabled={!hasContent || isTranslating}
                title={
                  hasContent
                    ? undefined
                    : t("noContentYet", { locale: loc.toUpperCase() })
                }
                onClick={() => {
                  if (!hasContent) return
                  if (isCopy) onPullCopy(loc)
                  else onPullTranslate?.(loc)
                }}
                className="flex min-h-9 w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Icon className="size-3.5 shrink-0" />
                  <span className="truncate">
                    {label} {loc.toUpperCase()}
                  </span>
                  <span className="truncate text-muted-foreground">
                    · {getLocaleDisplayName(loc)}
                  </span>
                </span>
                {!hasContent && (
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {t("noContent")}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      </div>

      {currentHasContent && otherLocales.length > 0 && (
        <div className="mt-2 border-t pt-2">
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setShowPushOut((open) => !open)}
            className="flex w-full items-center gap-1 p-1 text-left text-[11px] font-medium text-muted-foreground hover:text-foreground"
          >
            <span aria-hidden={true}>{expanded ? "▾" : "▸"}</span>
            {t("sendToAnother", { locale: currentLocale.toUpperCase() })}
          </button>
          {expanded && (
            <div className="mt-1 space-y-0.5">
              {otherLocales.map((loc) => (
                <button
                  key={`${mode}-push-${loc}`}
                  type="button"
                  disabled={!currentCanSend || isTranslating}
                  title={currentCanSend ? undefined : noContentTitle}
                  onClick={() => {
                    if (!currentCanSend) return
                    onPush(loc, mode)
                  }}
                  className="flex min-h-9 w-full items-center justify-between gap-3 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent disabled:cursor-not-allowed disabled:opacity-45"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <Icon className="size-3.5 shrink-0" />
                    <span className="truncate">
                      {currentLocale.toUpperCase()}
                    </span>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{loc.toUpperCase()}</span>
                  </span>
                  <span className="truncate text-[11px] text-muted-foreground">
                    {getLocaleDisplayName(loc)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </PopoverContent>
  )
}

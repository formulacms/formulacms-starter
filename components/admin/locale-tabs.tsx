"use client"

import { useTranslations } from "next-intl"
import type { Locale } from "@/lib/i18n/config"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { cn } from "@/lib/utils"

interface LocaleTabsProps {
  currentLocale: Locale
  enabledLocales: Locale[]
  availableLocales: Locale[]
  onLocaleChange: (locale: Locale) => void
  disabled?: boolean
  className?: string
}

export function LocaleTabs({
  currentLocale,
  enabledLocales,
  availableLocales,
  onLocaleChange,
  disabled = false,
  className,
}: LocaleTabsProps) {
  const t = useTranslations("common.localeTabs")
  if (enabledLocales.length <= 1) return null

  return (
    <div
      role="tablist"
      aria-label={t("label")}
      className={cn(
        "flex items-center gap-1 rounded-md border bg-muted/30 p-0.5",
        className
      )}
    >
      {enabledLocales.map((locale) => {
        const hasContent = availableLocales.includes(locale)
        const isActive = locale === currentLocale
        const language = getLocaleDisplayName(locale)
        return (
          <button
            key={locale}
            type="button"
            role="tab"
            aria-selected={isActive}
            aria-label={`${locale.toUpperCase()} — ${t("edit", { language })}`}
            title={language}
            disabled={disabled}
            onClick={() => onLocaleChange(locale)}
            className={`relative rounded px-2.5 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
              isActive
                ? "bg-primary text-primary-foreground shadow-sm"
                : "text-muted-foreground hover:bg-background/50 hover:text-foreground"
            }`}
          >
            {locale.toUpperCase()}
            {hasContent && !isActive && (
              <span className="sr-only">{t("hasContent")}</span>
            )}
          </button>
        )
      })}
    </div>
  )
}

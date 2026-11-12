"use client"

import type { ReactNode } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Badge } from "@/components/ui/badge"
import { adminContentTypeSingularMessageKey } from "@/lib/admin/content-types"
import { getLocaleLabel } from "@/lib/i18n/config"
import { toPublicPath } from "@/lib/pages/url"
import type { AdminPageLocale } from "@/convex/cms/publication"

type ActiveEntry = Partial<AdminPageLocale> | undefined

/**
 * Each item draws its own leading separator and the item that starts a line
 * has it clipped (negative start margin inside an overflow-hidden box), so a
 * bar never shows at a line start or end when the row wraps.
 */
const itemStyle = {
  borderInlineStart: "1px solid var(--border)",
  paddingInlineStart: 16,
  marginInlineEnd: 16,
} as const

function HeaderItem({
  label,
  children,
}: {
  label: string
  children: ReactNode
}) {
  return (
    <span
      className="inline-flex min-w-0 items-baseline gap-1.5"
      style={itemStyle}
    >
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate font-medium text-foreground">
        {children}
      </span>
    </span>
  )
}

/** Language name in the interface language, first letter capitalised. */
function languageName(code: string, interfaceLocale: string): string {
  try {
    const name =
      new Intl.DisplayNames([interfaceLocale], { type: "language" }).of(code) ??
      getLocaleLabel(code)
    return name.charAt(0).toLocaleUpperCase(interfaceLocale) + name.slice(1)
  } catch {
    return getLocaleLabel(code)
  }
}

/**
 * The line under the page title: address, content type, home badge, language
 * and page status of the ACTIVE language. The list reads the same
 * `AdminPageLocale`, so the two cannot disagree.
 */
export function PageHeaderMeta({
  locale,
  defaultLocale,
  entry,
  pageType,
  isHome,
  archived,
}: {
  locale: string
  defaultLocale: string
  /** The active language's entry; absent means Not translated. */
  entry: ActiveEntry
  pageType: string
  isHome: boolean
  archived: boolean
}) {
  const interfaceLocale = useLocale()
  const t = useTranslations("editor.page")
  const tList = useTranslations("pages.list")
  const tContentType = useTranslations("sidebar.contentType")
  const state: "published" | "draft" | "notTranslated" =
    !entry || entry.state === "not_translated"
      ? "notTranslated"
      : (entry.state ?? (entry.currentSnapshotId ? "published" : "draft"))
  const status = archived ? "archived" : state
  const contentTypeKey = adminContentTypeSingularMessageKey(pageType)
  // A non-routable content type has no address at all.
  const showAddress = entry?.path !== null
  const address =
    entry?.path && state !== "notTranslated"
      ? toPublicPath(entry.path, locale, defaultLocale)
      : null
  return (
    <div className="min-w-0 overflow-hidden text-xs">
      <div
        className="flex min-w-0 flex-wrap items-center gap-y-1"
        style={{ marginInlineStart: -17 }}
      >
        {showAddress && (
          <HeaderItem label={t("header.address")}>
            {address ?? (
              <span className="text-muted-foreground">{t("noAddress")}</span>
            )}
          </HeaderItem>
        )}
        <HeaderItem label={t("header.contentType")}>
          {contentTypeKey ? tContentType(contentTypeKey) : pageType}
        </HeaderItem>
        {isHome && state !== "notTranslated" && (
          <span className="inline-flex items-center" style={itemStyle}>
            <Badge
              variant="outline"
              className="shrink-0 text-xs text-muted-foreground"
            >
              {t("homePage")}
            </Badge>
          </span>
        )}
        <HeaderItem label={t("header.language")}>
          {languageName(locale, interfaceLocale)}
        </HeaderItem>
        <HeaderItem label={t("header.status")}>
          {tList(`rowStatus.${status}`)}
        </HeaderItem>
      </div>
    </div>
  )
}

"use client"

import { useId, useState } from "react"
import type { Target } from "@/convex/lib/menu"
import { Input } from "@/components/ui/input"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  ExternalLink,
  FileText,
  Link2Off,
  LayoutGrid,
  CircleDashed,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { LinkPagePicker } from "@/components/admin/fields/link-page-picker"
import { adminContentTypeSingularMessageKey } from "@/lib/admin/content-types"

import { useMenuValidation } from "./menu-validation"
import { targetError } from "@/lib/admin/menu/validation"
import { useQuery } from "convex/react"
import { api } from "@/convex/_generated/api"

type TargetType = Target["type"] | "none" | "panel"

interface MenuTargetFieldProps {
  value: Target | undefined
  onChange: (value: Target | undefined) => void
  locale: string
  canEditTarget?: boolean
  allowEmpty?: boolean
  validationKey?: string
  panelSelected?: boolean
  panelContent?: React.ReactNode
  onSelectPanel?: () => void
  confirmLeavePanel?: (type: string) => Promise<boolean>
}

/**
 * Canonical menu target picker. Unlike the legacy link field it owns only a
 * `Target | undefined`: labels are edited by the surrounding localized leaf.
 */
export function MenuTargetField({
  value,
  onChange,
  locale,
  canEditTarget = true,
  allowEmpty = true,
  validationKey,
  panelSelected = false,
  panelContent,
  onSelectPanel,
  confirmLeavePanel,
}: MenuTargetFieldProps) {
  const t = useTranslations("menus.link")
  const tContentType = useTranslations("sidebar.contentType")
  const fieldId = useId()
  const validation = useMenuValidation()
  const key = validationKey ?? fieldId
  const [localType, setLocalType] = useState<TargetType>(value?.type ?? "none")
  const [blurred, setBlurred] = useState(false)
  const activeType = panelSelected
    ? "panel"
    : (validation.intents[key] ?? localType)
  const code =
    activeType === "panel" ? undefined : targetError(value, activeType)
  const showError =
    code && (validation.attempt > 0 || (code === "url" && blurred))
  const errorId = `${fieldId}-error`

  async function handleTypeChange(type: TargetType) {
    const label =
      type === "internal"
        ? t("page")
        : type === "external"
          ? t("url")
          : t("none")
    if (
      panelSelected &&
      type !== "panel" &&
      confirmLeavePanel &&
      !(await confirmLeavePanel(label))
    )
      return
    if (type === "panel") {
      onSelectPanel?.()
      return
    }
    setLocalType(type)
    setBlurred(false)
    validation.setIntent(key, type)
    if (type === "none") onChange(undefined)
    else if (type === "external")
      onChange(
        value?.type === "external"
          ? value
          : { type: "external", url: "", openInNewTab: true }
      )
    else onChange(value?.type === "internal" ? value : undefined)
  }

  return (
    <Tabs
      value={activeType}
      onValueChange={(type) => handleTypeChange(type as TargetType)}
    >
      <TabsList
        className={`grid w-full ${onSelectPanel ? "grid-cols-4" : allowEmpty ? "grid-cols-3" : "grid-cols-2"}`}
      >
        <TabsTrigger
          value="internal"
          disabled={!canEditTarget}
          className="gap-1"
        >
          <FileText className="size-3" />
          {t("page")}
        </TabsTrigger>
        <TabsTrigger
          value="external"
          disabled={!canEditTarget}
          className="gap-1"
        >
          <ExternalLink className="size-3" />
          {t("url")}
        </TabsTrigger>
        {allowEmpty && (
          <TabsTrigger value="none" disabled={!canEditTarget} className="gap-1">
            <Link2Off className="size-3" aria-hidden />
            {t("none")}
          </TabsTrigger>
        )}
        {onSelectPanel && (
          <TabsTrigger
            value="panel"
            disabled={!canEditTarget}
            className="gap-1"
          >
            <LayoutGrid className="size-3" aria-hidden />
            {t("panel")}
          </TabsTrigger>
        )}
      </TabsList>
      {onSelectPanel && (
        <TabsContent value="panel" className="mt-4">
          {panelContent}
        </TabsContent>
      )}

      <TabsContent
        value="internal"
        className="mt-4 space-y-1"
        data-menu-field={key}
      >
        <label htmlFor={`${fieldId}-page`} className="text-sm font-medium">
          {t("selectPage", { locale: locale.toUpperCase() })}
        </label>
        <LinkPagePicker
          id={`${fieldId}-page`}
          value={value?.type === "internal" ? value.pageId : undefined}
          onChange={(pageId) => onChange({ type: "internal", pageId })}
          locale={locale}
          disabled={!canEditTarget}
          invalid={Boolean(showError)}
          describedBy={showError ? errorId : undefined}
          publicationLabels={{
            badge: (locale) => t("notPublished", { locale }),
            hint: (locale) => t("notPublishedHint", { locale }),
          }}
          labels={{
            archived: t("archived"),
            archivedWarning: t("archivedWarning"),
            deleted: t("deleted"),
            loadingPages: t("loadingPages"),
            missingPage: t("missingPage"),
            missingWarning: t("missingWarning"),
            noPages: t("noPages", { locale: locale.toUpperCase() }),
            searchLabel: t("searchLabel"),
            searchPlaceholder: t("searchPlaceholder"),
            selectPagePlaceholder: t("selectPagePlaceholder"),
            selectedPage: t("selectedPage"),
            unavailable: t("unavailable"),
            unavailablePage: t("unavailablePage"),
            unavailableWarning: t("unavailableWarning"),
          }}
          pageTypeLabel={(pageType) => {
            const messageKey = adminContentTypeSingularMessageKey(pageType)
            return messageKey && tContentType.has(messageKey)
              ? tContentType(messageKey)
              : pageType
          }}
        />
        {showError && (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {t("pageRequired")}
          </p>
        )}
      </TabsContent>

      <TabsContent
        value="external"
        className="mt-4 space-y-2"
        data-menu-field={key}
      >
        <label htmlFor={`${fieldId}-url`} className="text-sm font-medium">
          {t("externalUrl")}
        </label>
        <Input
          id={`${fieldId}-url`}
          onBlur={() => setBlurred(true)}
          aria-invalid={Boolean(showError)}
          aria-describedby={showError ? errorId : undefined}
          className={showError ? "border-destructive" : undefined}
          value={value?.type === "external" ? value.url : ""}
          onChange={(event) =>
            onChange({
              type: "external",
              url: event.target.value,
              openInNewTab:
                value?.type === "external" ? value.openInNewTab : true,
            })
          }
          placeholder={t("externalUrlPlaceholder")}
          disabled={!canEditTarget}
        />
        {showError && (
          <p id={errorId} role="alert" className="text-xs text-destructive">
            {t("urlError")}
          </p>
        )}
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={
              value?.type === "external" ? (value.openInNewTab ?? true) : true
            }
            onChange={(event) =>
              onChange({
                type: "external",
                url: value?.type === "external" ? value.url : "",
                openInNewTab: event.target.checked,
              })
            }
            className="rounded"
            disabled={!canEditTarget}
          />
          {t("openInNewTab")}
        </label>
      </TabsContent>

      {allowEmpty && (
        <TabsContent value="none" className="mt-4">
          <p className="text-sm text-muted-foreground">
            {t("noTargetConfigured")}
          </p>
        </TabsContent>
      )}
    </Tabs>
  )
}

/** Text-only locale editor still explains the selected page's publication state. */
export function MenuPublicationNotice({ target }: { target?: Target }) {
  const t = useTranslations("menus.link")
  const selection = useQuery(
    api.cms.pages.getLinkablePageSelection,
    target?.type === "internal" ? { pageId: target.pageId } : "skip"
  )
  if (selection?.status !== "available") return null
  return (
    <>
      {Object.entries(selection.page.localePublicationStates ?? {})
        .filter(([, state]) => state !== "published")
        .map(([locale]) => (
          <p
            key={locale}
            className="flex items-center gap-1 text-xs text-muted-foreground"
          >
            <CircleDashed className="size-3.5 shrink-0" aria-hidden />
            {t("notPublishedHint", { locale: locale.toUpperCase() })}
          </p>
        ))}
    </>
  )
}

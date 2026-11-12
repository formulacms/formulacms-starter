"use client"

import { useTranslations } from "next-intl"
import { adminContentTypeSingularMessageKey } from "@/lib/admin/content-types"

import { useId, useState } from "react"
import { useQuery } from "convex/react"
import { Check, ChevronsUpDown, Search, CircleDashed } from "lucide-react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export type LinkPagePickerLabels = {
  archived: string
  archivedWarning: string
  deleted: string
  loadingPages: string
  missingPage: string
  missingWarning: string
  noPages: string
  searchLabel: string
  searchPlaceholder: string
  selectPagePlaceholder: string
  selectedPage: string
  unavailable: string
  unavailablePage: string
  unavailableWarning: string
}

const LABEL_KEYS = [
  "archived",
  "archivedWarning",
  "deleted",
  "loadingPages",
  "missingPage",
  "missingWarning",
  "noPages",
  "searchLabel",
  "searchPlaceholder",
  "selectPagePlaceholder",
  "selectedPage",
  "unavailable",
  "unavailablePage",
  "unavailableWarning",
] as const

function titleFor(
  page: { localizedTitles: Record<string, string>; slug: string },
  locale: string
): string {
  return page.localizedTitles[locale] || page.slug
}

function slugFor(
  page: { localizedSlugs?: Record<string, string>; slug: string },
  locale: string
): string {
  return page.localizedSlugs?.[locale] || page.slug
}

/**
 * Shared searchable picker for an internal link target. It deliberately owns
 * only the page id; menu targets and ADR-0008 link primitives keep their own
 * surrounding discriminated unions.
 */
export function LinkPagePicker({
  value,
  onChange,
  locale,
  id,
  disabled = false,
  labels: providedLabels,
  pageTypeLabel,
  invalid,
  describedBy,
  publicationLabels,
}: {
  value: Id<"pages"> | undefined
  onChange: (pageId: Id<"pages">) => void
  locale: string
  id?: string
  disabled?: boolean
  labels?: LinkPagePickerLabels
  pageTypeLabel?: (pageType: string) => string
  invalid?: boolean
  describedBy?: string
  publicationLabels?: {
    badge: (locale: string) => string
    hint: (locale: string) => string
  }
}) {
  const t = useTranslations("editor.linkPagePicker")
  const tType = useTranslations("sidebar.contentType")
  const generatedId = useId()
  const fieldId = id ?? generatedId
  const [open, setOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState("")
  const labels =
    providedLabels ??
    (Object.fromEntries(
      LABEL_KEYS.map((key) => [key, t(key)])
    ) as LinkPagePickerLabels)
  const resolvePageTypeLabel =
    pageTypeLabel ??
    ((type: string) => {
      const key = adminContentTypeSingularMessageKey(type)
      return key ? tType(key) : type
    })
  const pages = useQuery(api.cms.pages.listLinkablePages, {
    locale,
    limit: 100,
  })
  const selection = useQuery(
    api.cms.pages.getLinkablePageSelection,
    value ? { pageId: value } : "skip"
  )
  const selectedPage =
    selection?.status === "available" ? selection.page : undefined
  const isMissing = selection?.status === "missing"
  const isUnavailable = selection?.status === "unavailable"
  const isArchived = selectedPage?.status === "archived"
  const query = searchQuery.trim().toLowerCase()
  const filteredPages = (pages ?? [])
    .filter((page) => {
      if (!page.localizedTitles[locale] || page.status === "archived") {
        return false
      }
      if (!query) return true
      return (
        titleFor(page, locale).toLowerCase().includes(query) ||
        slugFor(page, locale).toLowerCase().includes(query) ||
        page.pageType.toLowerCase().includes(query)
      )
    })
    .sort((a, b) => titleFor(a, locale).localeCompare(titleFor(b, locale)))
    .slice(0, 100)

  function select(pageId: Id<"pages">) {
    onChange(pageId)
    setOpen(false)
    setSearchQuery("")
  }

  return (
    <div className="space-y-1">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            id={fieldId}
            type="button"
            variant="outline"
            aria-expanded={open}
            aria-invalid={invalid}
            aria-describedby={describedBy}
            className={cn(
              "w-full justify-between",
              invalid && "border-destructive"
            )}
            disabled={disabled}
          >
            {selectedPage ? (
              <span className="flex min-w-0 items-center gap-2 truncate">
                <span className="truncate">
                  {titleFor(selectedPage, locale)}
                </span>
                <Badge variant="secondary" className="shrink-0 text-xs">
                  {resolvePageTypeLabel(selectedPage.pageType)}
                </Badge>
                {isArchived && (
                  <Badge
                    variant="outline"
                    className="shrink-0 border-destructive/50 text-xs text-destructive"
                  >
                    {labels.archived}
                  </Badge>
                )}
              </span>
            ) : isMissing ? (
              <span className="flex items-center gap-2 truncate">
                <span className="truncate">{labels.missingPage}</span>
                <Badge
                  variant="outline"
                  className="shrink-0 border-destructive/50 text-xs text-destructive"
                >
                  {labels.deleted}
                </Badge>
              </span>
            ) : isUnavailable ? (
              <span className="flex items-center gap-2 truncate">
                <span className="truncate">{labels.unavailablePage}</span>
                <Badge
                  variant="outline"
                  className="shrink-0 text-xs text-muted-foreground"
                >
                  {labels.unavailable}
                </Badge>
              </span>
            ) : value !== undefined ? (
              <span>{labels.selectedPage}</span>
            ) : (
              labels.selectPagePlaceholder
            )}
            <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[360px] p-0" align="start">
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-3.5 text-muted-foreground" />
            <input
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={labels.searchPlaceholder}
              aria-label={labels.searchLabel}
              className="h-9 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-[300px] overflow-y-auto p-1">
            {pages === undefined ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {labels.loadingPages}
              </p>
            ) : filteredPages.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {labels.noPages}
              </p>
            ) : (
              filteredPages.map((page) => (
                <button
                  key={page._id}
                  type="button"
                  onClick={() => select(page._id)}
                  className="flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent"
                >
                  <Check
                    className={cn(
                      "size-4 shrink-0",
                      value === page._id ? "opacity-100" : "opacity-0"
                    )}
                  />
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate font-medium">
                      {titleFor(page, locale)}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      /{slugFor(page, locale)}
                    </span>
                  </span>
                  {publicationLabels &&
                    Object.entries(page.localePublicationStates ?? {})
                      .filter(([, state]) => state !== "published")
                      .map(([locale]) => (
                        <Badge
                          key={locale}
                          variant="outline"
                          className="shrink-0 text-xs"
                        >
                          {publicationLabels.badge(locale.toUpperCase())}
                        </Badge>
                      ))}
                </button>
              ))
            )}
          </div>
        </PopoverContent>
      </Popover>
      {publicationLabels &&
        selectedPage &&
        Object.entries(selectedPage.localePublicationStates ?? {})
          .filter(([, state]) => state !== "published")
          .map(([locale]) => (
            <p
              key={locale}
              className="flex items-center gap-1 text-xs text-muted-foreground"
            >
              <CircleDashed className="size-3.5 shrink-0" aria-hidden />
              {publicationLabels.hint(locale.toUpperCase())}
            </p>
          ))}
      {isArchived && (
        <p className="text-xs text-destructive">{labels.archivedWarning}</p>
      )}
      {isMissing && (
        <p className="text-xs text-destructive">{labels.missingWarning}</p>
      )}
      {isUnavailable && (
        <p className="text-xs text-muted-foreground">
          {labels.unavailableWarning}
        </p>
      )}
    </div>
  )
}

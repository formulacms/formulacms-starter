"use client"

import { adminContentTypeSingularMessageKey } from "@/lib/admin/content-types"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useQuery } from "convex/react"
import { Search, X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { PageType } from "@/convex/lib/pages/types"

const inputClass =
  "w-full rounded-md border bg-background px-3 py-1.5 text-sm focus:ring-1 focus:ring-ring focus:outline-none"

export type RelationValue = {
  pageId?: Id<"pages">
}

type CandidatePage = {
  slug: string
  localizedSlugs?: Record<string, string>
  localizedTitles: Record<string, string>
}

// Title in the field's content language, then English, then any language,
// then the address (the order this picker already used).
function titleFor(page: CandidatePage, locale: string): string {
  return (
    page.localizedTitles[locale] ||
    page.localizedTitles.en ||
    Object.values(page.localizedTitles).find(Boolean) ||
    page.slug
  )
}

function slugFor(page: CandidatePage, locale: string): string {
  return page.localizedSlugs?.[locale] || page.slug
}

function labelForPageType(type: string): string {
  return type.replace(/-/g, " ").replace(/\b\w/g, (char) => char.toUpperCase())
}

export function RelationPicker({
  value,
  pageTypes,
  tag,
  locale,
  optional,
  onChange,
}: {
  value: RelationValue | undefined
  pageTypes: readonly PageType[]
  tag?: string
  /** Active content locale the titles and addresses are shown in. */
  locale: string
  optional: boolean
  onChange: (value: RelationValue | undefined) => void
}) {
  const t = useTranslations("editor.relationField")
  const tType = useTranslations("sidebar.contentType")
  const tStatus = useTranslations("pages.list.status")
  const typeLabel = (type: string) => {
    const key = adminContentTypeSingularMessageKey(type)
    return key ? tType(key) : labelForPageType(type)
  }
  const [search, setSearch] = useState("")
  const pages =
    useQuery(api.cms.pages.listRelationCandidates, {
      pageTypes: [...pageTypes],
      tag,
      includeDrafts: true,
      limit: 100,
    }) ?? []

  const selected = pages.find((page) => page._id === value?.pageId)
  const q = search.trim().toLowerCase()
  const filtered = !q
    ? pages.slice(0, 50)
    : pages
        .filter((page) => {
          const title = titleFor(page, locale).toLowerCase()
          const slug = slugFor(page, locale).toLowerCase()
          const type = page.pageType.toLowerCase()
          return title.includes(q) || slug.includes(q) || type.includes(q)
        })
        .slice(0, 50)

  function clear() {
    onChange(optional ? undefined : {})
  }

  return (
    <div className="space-y-2">
      {selected && (
        <div className="flex min-h-10 items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">
              {titleFor(selected, locale)}
            </div>
            <div className="truncate text-xs text-muted-foreground">
              /{slugFor(selected, locale)}
            </div>
          </div>
          <button
            type="button"
            onClick={clear}
            title={t("clear")}
            className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
          >
            <X className="size-4" />
          </button>
        </div>
      )}

      <div className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
        <input
          type="search"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("searchTypes", {
            types: pageTypes.map(typeLabel).join(", "),
          })}
          aria-label={t("searchPages")}
          className={`${inputClass} pl-8`}
        />
      </div>

      <div className="max-h-64 overflow-y-auto rounded-md border">
        {filtered.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            {t("noMatches")}
          </p>
        ) : (
          <ul>
            {filtered.map((page) => {
              const isSelected = page._id === value?.pageId
              return (
                <li key={page._id}>
                  <button
                    type="button"
                    onClick={() => onChange({ pageId: page._id })}
                    className={`block w-full px-3 py-2 text-left text-sm hover:bg-accent/50 ${
                      isSelected ? "bg-accent text-accent-foreground" : ""
                    }`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="min-w-0 truncate font-medium">
                        {titleFor(page, locale)}
                      </span>
                      <span className="shrink-0 rounded border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground uppercase">
                        {typeLabel(page.pageType)}
                      </span>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="truncate">/{slugFor(page, locale)}</span>
                      <span className="shrink-0">· {tStatus(page.status)}</span>
                    </div>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>
    </div>
  )
}

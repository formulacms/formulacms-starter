"use client"

import { OptionalContribution } from "./optional-contribution"
import { useModuleGate } from "./admin-module-state-provider"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { formatScheduleTime, formatTranslationCount } from "@/lib/i18n/admin-format"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { useQuery, useMutation, usePaginatedQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import {
  Archive,
  ArchiveRestore,
  Check,
  Clock,
  Languages,
  Copy,
  MoreHorizontal,
  Trash2,
  X,
} from "lucide-react"
import { toast } from "sonner"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { RowTitle, RowUrlName, WrappingBadge } from "./list-row-text"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { useConfirm } from "@/components/providers/confirm-provider"
import { DuplicatePageDialog } from "@/components/admin/duplicate-page-dialog"
import {
  PublicSiteUpdateStatus,
  RetryButton,
  usePublicUpdatesRetry,
} from "@/components/admin/public-site-updates-row"
import {
  ADMIN_LIST_SEARCH_BROWSER_BINDING,
  type AdminListSearchPage,
  type AdminListSearchResult,
} from "@/components/admin/contributions/list-search"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { api } from "@/convex/_generated/api"
import type { Doc } from "@/convex/_generated/dataModel"
import {
  adminContentTypeSingularMessageKey,
  adminContentTypes,
} from "@/lib/admin/content-types"
import { destructiveRefusalMessage } from "@/lib/admin/destructive-refusal"
import {
  SnapshotPagesBody,
  type SnapshotListPage,
} from "./pages-list-snapshot-rows"
import {
  openingLanguage,
  pageMatchesStatus,
  siteLocaleOrder,
} from "./pages-list-locales"
import { CONTENT_TYPES, type ContentType } from "@/convex/lib/contentTypes"

// ADR-0041 Deploy 2 PR B — the admin list queries (`list`, `listPaginated`)
// enrich each row with two staged overlays: `scheduledAt` for the
// "Publishes {date}" badge, and `effectiveTitles[locale]` so drafts whose
// content lives on `pageStaging` (never-published or hoisted) still show a
// title in the list. After Deploy 2 PR B item 3, `pages.content` is empty
// for those drafts.
type Page = Pick<
  Doc<"pages">,
  "_id" | "pageType" | "slug" | "status" | "updatedAt"
> & {
  content?: Doc<"pages">["content"]
  localizedSlugs?: Record<string, string>
  scheduledAt?: number
  expiresAt?: number
  effectiveTitles?: Record<string, string>
  localizedTitles?: Record<string, string>
  lifecycleState?: "active" | "archived" | "trashed"
  restoreLifecycleState?: "active" | "archived"
  lifecycleGeneration?: number
}

type PageTypeFilter = "all" | ContentType

function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value)
}

const STATUSES = ["all", "published", "draft", "archived"] as const
// Snapshot sites filter per language, so "not translated" is a status there.
const SNAPSHOT_STATUSES = [
  "all",
  "published",
  "draft",
  "notTranslated",
  "archived",
] as const

function pickAnyEffectiveTitle(page: Page) {
  const staged = page.localizedTitles ?? page.effectiveTitles
  if (staged) {
    for (const [locale, value] of Object.entries(staged)) {
      const trimmed = value?.trim()
      if (trimmed) return { title: trimmed, titleLocale: locale }
    }
  }
  return undefined
}

function getTitle(page: Page, untitled: string) {
  const first = Object.entries(page.content ?? {})[0]
  const title = first?.[1]?.title?.trim()
  return title
    ? { title, titleLocale: first[0] }
    : pickAnyEffectiveTitle(page) ?? { title: untitled, titleLocale: undefined }
}

function getDuplicateTitle(
  page: Page,
  defaultLocale: string | undefined,
  untitled: string
) {
  if (defaultLocale) {
    const stagedTitle = page.effectiveTitles?.[defaultLocale]?.trim()
    if (stagedTitle) return stagedTitle
    const storedTitle = page.content?.[defaultLocale]?.title?.trim()
    if (storedTitle) return storedTitle
  }
  return getTitle(page, untitled).title
}

function getLocaleRow(
  page: Page,
  locale: string,
  defaultLocale: string | undefined,
  untitled: string,
  missingLocaleTitle: string
) {
  if (locale === "all") {
    return {
      ...getTitle(page, untitled),
      slug: page.slug || "",
      slugLocale: page.slug ? defaultLocale : undefined,
      titleMissing: false,
      usingDefaultSlug: false,
    }
  }

  const localeContent = page.content?.[locale]
  const stagedTitle = (
    page.localizedTitles?.[locale] ?? page.effectiveTitles?.[locale]
  )?.trim()
  const localizedTitle = localeContent?.title?.trim() || stagedTitle
  const localizedSlug =
    locale !== defaultLocale ? page.localizedSlugs?.[locale]?.trim() : undefined

  return {
    title: localizedTitle || missingLocaleTitle,
    titleLocale: localizedTitle ? locale : undefined,
    slugLocale:
      locale !== defaultLocale && localizedSlug
        ? locale
        : page.slug ? defaultLocale : undefined,
    slug:
      locale === defaultLocale
        ? page.slug || ""
        : localizedSlug || page.slug || "missing-slug",
    titleMissing: !localizedTitle,
    usingDefaultSlug: locale !== defaultLocale && !localizedSlug,
  }
}

function hasLocale(page: Page, locale: string) {
  // Every arm carries `title`; only slice-body arms carry `slices` (plan
  // 029 C10 pure-form testimonials don't). Read via a permissive shape so
  // the check works uniformly — an empty testimonial locale has no title
  // and no slices, so it correctly reads as "no locale". `effectiveTitles`
  // from the staged overlay counts as "the locale exists" for a draft
  // whose `pages.content` is empty (Deploy 2 PR B item 3).
  const bag = page.content?.[locale] as
    { title?: string; slices?: unknown[] } | undefined
  const stagedTitle = (
    page.localizedTitles?.[locale] ?? page.effectiveTitles?.[locale]
  )?.trim()
  return Boolean(bag?.title || bag?.slices?.length || stagedTitle)
}


type PublicationAuthority =
  FunctionReturnType<typeof api.cms.publication.getAdminAuthority> | undefined
type StatusFilter = (typeof SNAPSHOT_STATUSES)[number]
type LegacyStatus = "draft" | "published" | "archived"

/** The legacy list has no per-language status: only the three page-wide ones. */
function legacyStatus(status: StatusFilter): LegacyStatus | undefined {
  return status === "all" || status === "notTranslated" ? undefined : status
}

/** A choice that follows the admin language: it resets when that changes. */
function useFollowAdminLanguage(adminLocale: string) {
  const [chosen, setChosen] = useState<string | null>(null)
  const [seenAdminLocale, setSeenAdminLocale] = useState(adminLocale)
  if (seenAdminLocale !== adminLocale) {
    setSeenAdminLocale(adminLocale)
    setChosen(null)
  }
  return [chosen, setChosen] as const
}

const NO_PAGES_SEARCH: AdminListSearchResult<AdminListSearchPage> = {
  control: null,
  query: "",
  results: undefined,
  reset: () => {},
}

/**
 * The public-site update banner, from the backend's `updateState`. Nothing
 * when up to date; a calm neutral line for a missing address or code, an
 * update in progress, or a local site; a warning with Retry only for a real
 * failure.
 */
function PublicUpdatesBanner({
  health,
}: {
  health: NonNullable<
    FunctionReturnType<typeof api.cms.revalidate.getRevalidationHealth>
  >
}) {
  const tList = useTranslations("pages.list")
  const t = useTranslations("settings.languageLifecycle")
  const retry = usePublicUpdatesRetry()
  const state = health.updateState
  if (state === undefined || state === "ok") return null
  if (state !== "failed") {
    return (
      <div role="status" className="border-b bg-muted/40 px-4 py-3 text-sm">
        <PublicSiteUpdateStatus state={state} retry={retry} />
      </div>
    )
  }
  const count = health.consecutiveFailureCount
  return (
    <div
      role="alert"
      className="border-b border-amber-500/40 bg-amber-500/10 px-4 py-3 text-sm text-amber-950 dark:text-amber-100"
    >
      <p className="font-medium">{tList("revalidation.attentionHeading")}</p>
      <p className="mt-1">
        {t("failing")}.{" "}
        {count > 0 &&
          (health.consecutiveFailureCountCapped
            ? tList("revalidation.cappedFailures", { count })
            : tList("revalidation.failures", { count }))}{" "}
        <Link
          href="/admin/settings"
          className="rounded-sm font-medium underline underline-offset-2 hover:no-underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {tList("revalidation.openSettings")}
        </Link>
        .
      </p>
      <RetryButton retry={retry} className="mt-2" />
    </div>
  )
}

export function PagesListClient() {
  const publicationAuthority = useQuery(api.cms.publication.getAdminAuthority)
  const [status, setStatus] = useState<StatusFilter>("all")
  // Full-text search is a Search (M04) list control reached only through its
  // binding; without a participant the ordinary paginated list and filters
  // remain the whole surface.
  const SearchSlot = ADMIN_LIST_SEARCH_BROWSER_BINDING?.PagesListSlot
  const surface = (search: AdminListSearchResult<AdminListSearchPage>) => (
    <PagesListSurface
      publicationAuthority={publicationAuthority}
      status={status}
      setStatus={setStatus}
      search={search}
    />
  )
  if (!SearchSlot) return surface(NO_PAGES_SEARCH)
  return (
    <SearchSlot
      searchable={publicationAuthority === "legacy"}
      status={legacyStatus(status)}
    >
      {surface}
    </SearchSlot>
  )
}

function PagesListSurface({
  publicationAuthority,
  status,
  setStatus,
  search,
}: {
  publicationAuthority: PublicationAuthority
  status: StatusFilter
  setStatus: (status: StatusFilter) => void
  search: AdminListSearchResult<AdminListSearchPage>
}) {
  const displayError = useCaughtError()
  const adminLocale = useLocale()
  const tList = useTranslations("pages.list")
  const tPages = useTranslations("pages")
  const tContentType = useTranslations("sidebar.contentType")
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const siteConfig = useQuery(api.cms.settings.getSiteConfig)
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const canViewRevalidationHealth = owner !== undefined && owner !== null
  const multilingual = useModuleGate("multilingual").state === "on"
  const tShell = useTranslations("shell")
  const tModules = useTranslations("settings.modules")
  // The Pages list is available to viewers, but health is operational settings
  // data. Skip the privileged subscription until its permission is known.
  const revalidationHealth = useQuery(
    api.cms.revalidate.getRevalidationHealth,
    canViewRevalidationHealth ? {} : "skip"
  )
  const update = useMutation(api.cms.pages.update)
  const softDelete = useMutation(api.cms.pages.softDelete)
  const archiveSnapshotPage = useMutation(api.cms.publication.archivePage)
  const restoreSnapshotPage = useMutation(api.cms.publication.restorePage)
  const softDeleteSnapshotPage = useMutation(api.cms.publication.softDeletePage)
  const confirm = useConfirm()
  const contentTypes = adminContentTypes()
  const locales = siteConfig?.enabledLocales ?? []
  const [duplicateTarget, setDuplicateTarget] = useState<Page | null>(null)

  // The `?type=<slug>` search param IS the filter state — sidebar Content
  // group entries navigate by URL, and the dropdown mirrors that via
  // `router.replace`. No `useState`/`useEffect` sync means no cascading
  // re-render when the sidebar navigates.
  const typeParam = searchParams.get("type")
  const pageType: PageTypeFilter =
    typeParam && isContentType(typeParam) ? typeParam : "all"

  function setPageType(next: PageTypeFilter) {
    const params = new URLSearchParams(searchParams.toString())
    if (next === "all") params.delete("type")
    else params.set("type", next)
    const qs = params.toString()
    // scroll: false keeps the reader's position when they change the filter
    // dropdown; the default `router.replace` behavior would jump to the top
    // of the admin content area.
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false })
  }

  const [localeFilter, setLocaleFilter] = useFollowAdminLanguage(adminLocale)

  const q = search.query
  const isSearching = q !== ""
  const searchResults = search.results
  const legacyPaginated = usePaginatedQuery(
    api.cms.pages.listPaginated,
    isSearching || publicationAuthority !== "legacy"
      ? "skip"
      : {
          status: legacyStatus(status),
          pageType: pageType !== "all" ? pageType : undefined,
        },
    { initialNumItems: 25 }
  )
  const snapshotPaginated = usePaginatedQuery(
    api.cms.publication.listAdminPages,
    isSearching || publicationAuthority !== "snapshot_active"
      ? "skip"
      : { scope: status === "archived" ? "archive" : "content" },
    { initialNumItems: 25 }
  )

  async function handleArchive(page: Page) {
    const ok = await confirm({
      title: tList("archiveDialog.title"),
      description: tList("archiveDialog.description"),
    })
    if (!ok) return
    try {
      if (publicationAuthority === "snapshot_active") {
        if (page.lifecycleGeneration === undefined) {
          throw new Error("Snapshot lifecycle state is unavailable")
        }
        await archiveSnapshotPage({
          pageId: page._id,
          expectedLifecycleGeneration: page.lifecycleGeneration,
        })
      } else {
        await update({ id: page._id, status: "archived" })
      }
      toast.success(tList("toast.archived"))
      router.refresh()
    } catch (err) {
      toast.error(
        destructiveRefusalMessage(
          err,
          displayError(err, tList("toast.archiveFailed")),
          { PAGE_HOME_LIFECYCLE_REFUSED: tList("actions.homeNoArchive") }
        )
      )
    }
  }

  async function handleUnarchive(page: Page) {
    try {
      if (publicationAuthority === "snapshot_active") {
        if (page.lifecycleGeneration === undefined) {
          throw new Error("Snapshot lifecycle state is unavailable")
        }
        await restoreSnapshotPage({
          pageId: page._id,
          expectedLifecycleGeneration: page.lifecycleGeneration,
        })
      } else {
        await update({ id: page._id, status: "draft" })
      }
      toast.success(
        publicationAuthority === "snapshot_active"
          ? tList("toast.restored")
          : tList("toast.restoredToDraft")
      )
      router.refresh()
    } catch (err) {
      toast.error(
        displayError(err, tList("toast.unarchiveFailed"))
      )
    }
  }

  async function handleMoveToTrash(page: Page) {
    const ok = await confirm({
      title: tList("trashDialog.title"),
      description: tList("trashDialog.description"),
      confirmText: tList("trashDialog.confirm"),
      destructive: true,
    })
    if (!ok) return
    try {
      if (publicationAuthority === "snapshot_active") {
        if (page.lifecycleGeneration === undefined) {
          throw new Error("Snapshot lifecycle state is unavailable")
        }
        await softDeleteSnapshotPage({
          pageId: page._id,
          expectedLifecycleGeneration: page.lifecycleGeneration,
        })
      } else {
        await softDelete({ id: page._id })
      }
      toast.success(tList("toast.movedToTrash"))
      router.refresh()
    } catch (err) {
      toast.error(
        destructiveRefusalMessage(err, tList("toast.deleteFailed"), {
          PAGE_HOME_LIFECYCLE_REFUSED: tList("actions.homeNoArchive"),
          PAGE_SOFT_DELETE_MENU_REFERENCE: tList("toast.menuReference"),
          PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE: tList(
            "toast.publishedPostReference"
          ),
        })
      )
    }
  }

  const defaultLocale = siteConfig?.defaultLocale
  const snapshotMode = publicationAuthority === "snapshot_active"
  // Snapshot sites: the list opens on the admin language when the site has it,
  // else on the site default, and follows the admin language live.
  const siteLocales = siteLocaleOrder(locales, defaultLocale)
  const openingLocale = openingLanguage(adminLocale, siteLocales, defaultLocale)
  const requestedLocale = localeFilter ?? openingLocale
  const effectiveLocale = snapshotMode
    ? requestedLocale === "all" || siteLocales.includes(requestedLocale)
      ? requestedLocale
      : (defaultLocale ?? "all")
    : (localeFilter ?? defaultLocale ?? "all")
  const isLoading = isSearching
    ? publicationAuthority === undefined ||
      (publicationAuthority === "legacy" && searchResults === undefined)
    : publicationAuthority === undefined ||
      (snapshotMode
        ? snapshotPaginated.status === "LoadingFirstPage" ||
          siteConfig === undefined
        : legacyPaginated.status === "LoadingFirstPage")
  const basePages: readonly Page[] = isSearching
    ? publicationAuthority === "legacy"
      ? (searchResults ?? [])
      : []
    : snapshotMode
      ? []
      : legacyPaginated.results

  const filtered = basePages.filter((page) => {
    if (isSearching && pageType !== "all" && page.pageType !== pageType)
      return false
    if (status !== "all" && page.status !== status) return false
    if (effectiveLocale !== "all" && !hasLocale(page, effectiveLocale))
      return false
    return true
  })

  // Snapshot rows expand into site languages, so the status filter runs on
  // the languages shown, not on a page-wide status.
  const snapshotPages: readonly SnapshotListPage[] =
    snapshotMode && !isSearching ? snapshotPaginated.results : []
  const snapshotFiltered = snapshotPages.filter((page) => {
    if (pageType !== "all" && page.pageType !== pageType) return false
    if (status === "archived") return true
    return pageMatchesStatus(
      page,
      status,
      effectiveLocale === "all" ? siteLocales : [effectiveLocale]
    )
  })
  const rowCount = snapshotMode ? snapshotFiltered.length : filtered.length

  const isFiltering =
    q !== "" ||
    pageType !== "all" ||
    status !== "all" ||
    // Snapshot lists open on a language; only moving away from it is a filter.
    (snapshotMode
      ? effectiveLocale !== openingLocale
      : effectiveLocale !== "all")

  const canLoadMore =
    !isSearching &&
    (publicationAuthority === "snapshot_active"
      ? snapshotPaginated.status === "CanLoadMore"
      : legacyPaginated.status === "CanLoadMore")
  const isLoadingMore =
    !isSearching &&
    (publicationAuthority === "snapshot_active"
      ? snapshotPaginated.status === "LoadingMore"
      : legacyPaginated.status === "LoadingMore")
  return (
    <div className="rounded-lg border bg-card">
      {revalidationHealth && (
        <PublicUpdatesBanner health={revalidationHealth} />
      )}
      <div className="flex flex-col gap-3 border-b px-4 py-3">
        <div className="flex items-center justify-between">
          <p className="text-sm font-medium">
            {isLoading
              ? tList("count.loading")
              : isFiltering
                ? tList("count.matching", { count: rowCount })
                : tList("count.loaded", { count: rowCount })}
          </p>
          {isFiltering && (
            <button
              type="button"
              onClick={() => {
                search.reset()
                setPageType("all")
                setStatus("all")
                setLocaleFilter(snapshotMode ? null : "all")
              }}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {tList("resetFilters")}
            </button>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {search.control}
          <select
            value={pageType}
            onChange={(e) => setPageType(e.target.value as PageTypeFilter)}
            aria-label={tList("filters.contentType")}
            className="rounded-md border bg-background px-2.5 py-1.5 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          >
            <option value="all">{tList("filters.allTypes")}</option>
            {contentTypes.map((contentType) => {
              const messageKey = adminContentTypeSingularMessageKey(
                contentType.type
              )
              const label =
                messageKey && tContentType.has(messageKey)
                  ? tContentType(messageKey)
                  : contentType.singular
              return (
                <option key={contentType.type} value={contentType.type}>
                  {contentType.routable
                    ? label
                    : `${label} — ${tPages("contentType.noPublicUrl")}`}
                </option>
              )
            })}
          </select>
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as typeof status)}
            aria-label={tList("filters.status")}
            className="rounded-md border bg-background px-2.5 py-1.5 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          >
            {(snapshotMode ? SNAPSHOT_STATUSES : STATUSES).map((s) => (
              <option key={s} value={s}>
                {s === "all"
                  ? tList("filters.allStatuses")
                  : snapshotMode
                    ? tList(`rowStatus.${s}`)
                    : s === "published"
                      ? tList("status.published")
                      : s === "archived"
                        ? tList("status.archived")
                        : tList("status.draft")}
              </option>
            ))}
          </select>
          <select
            value={effectiveLocale}
            onChange={(e) => setLocaleFilter(e.target.value)}
            aria-label={tList("filters.locale")}
            className="rounded-md border bg-background px-2.5 py-1.5 text-sm focus:ring-1 focus:ring-ring focus:outline-none"
          >
            <option value="all">{tList("filters.allLocales")}</option>
            {locales.map((locale) => (
              <option key={locale} value={locale}>
                {locale.toUpperCase()}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="divide-y">
        {isLoading ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {tList("loading")}
          </p>
        ) : isSearching && publicationAuthority === "snapshot_active" ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            {tList("searchUnavailable")}
          </p>
        ) : rowCount === 0 ? (
          snapshotMode && isFiltering ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-6 text-sm text-muted-foreground">
              <span>{tList("noPagesMatch")}</span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0"
                onClick={() => {
                  search.reset()
                  setPageType("all")
                  setStatus("all")
                  setLocaleFilter("all")
                }}
              >
                {tList("clearFilters")}
              </Button>
            </div>
          ) : (
            <p className="px-4 py-10 text-center text-sm text-muted-foreground">
              {isFiltering ? tList("noMatches") : tList("empty")}
            </p>
          )
        ) : snapshotMode ? (
          <SnapshotPagesBody
            pages={snapshotFiltered}
            selected={effectiveLocale}
            archivedLocale={
              effectiveLocale === "all"
                ? (siteLocales.includes(adminLocale)
                    ? adminLocale
                    : (defaultLocale ?? adminLocale))
                : effectiveLocale
            }
            languages={siteLocales}
            defaultLocale={defaultLocale ?? adminLocale}
            homePageId={siteConfig?.homePageId}
            onArchive={(page) => void handleArchive(page)}
            onUnarchive={(page) => void handleUnarchive(page)}
            onTrash={(page) => void handleMoveToTrash(page)}
          />
        ) : (
          filtered.map((page) => {
            const localeLabel = effectiveLocale.toUpperCase()
            const row = getLocaleRow(
              page,
              effectiveLocale,
              defaultLocale,
              tList("untitled"),
              tList("missingLocaleTitle", { locale: localeLabel })
            )
            const localeStates = locales.map((locale) => ({ locale, translated: hasLocale(page, locale) }))
            const translated = localeStates.filter((state) => state.translated).length
            const complete = translated === locales.length
            return (
              <div
                key={page._id}
                className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent/30"
              >
                <div className="min-w-[140px] flex-1">
                  <RowTitle href={`/admin/pages/${page._id}${effectiveLocale === "all" ? "" : `?locale=${effectiveLocale}`}`} locale={row.titleLocale} muted={row.titleMissing}>
                    {row.title}
                  </RowTitle>
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <RowUrlName value={row.slug} locale={row.slugLocale} />
                    {row.usingDefaultSlug && <WrappingBadge muted>{tList("defaultSlug")}</WrappingBadge>}
                    {page.scheduledAt && page.status !== "published" && (
                      <WrappingBadge icon={<Clock className="size-3" aria-hidden={true} />}>
                        {tList("publishes", { date: formatScheduleTime(adminLocale, page.scheduledAt) })}
                      </WrappingBadge>
                    )}
                    {page.expiresAt && page.status === "published" && (
                      <WrappingBadge icon={<Clock className="size-3" aria-hidden={true} />}>
                        {tList("expires", { date: formatScheduleTime(adminLocale, page.expiresAt) })}
                      </WrappingBadge>
                    )}
                  </div>
                </div>

                <div className={`ms-auto flex shrink-0 items-center gap-2 ${multilingual ? "sm:-mt-1.5" : "sm:-mt-0.5"}`}>
                  {multilingual && (
                    <OptionalContribution moduleId="multilingual" slot="admin.page-languages" fallbackText={tShell("modulesUnavailable")} finishSetup={{ href: "/admin/settings/modules", label: tModules("title") }}>
                    <Popover>
                      <PopoverTrigger asChild>
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className={`hidden w-28 tabular-nums sm:inline-flex ${complete ? "text-muted-foreground" : "border-amber-400 bg-amber-50 text-amber-900"}`}
                          aria-label={tList("languagesDetails", { translated, total: locales.length })}
                        >
                          <Languages className="size-4" aria-hidden={true} />
                          <span>{formatTranslationCount(translated, locales.length)}</span>
                          {complete ? <Check className="size-4" aria-hidden={true} /> : <X className="size-4" aria-hidden={true} />}
                          <span className="sr-only">{tList(complete ? "languagesComplete" : "languagesMissing")}</span>
                        </Button>
                      </PopoverTrigger>
                      <PopoverContent align="end" className="max-w-[calc(100vw-2rem)]" aria-label={tList("languages")}>
                        <p className="mb-2 text-sm font-semibold">{tList("languages")}</p>
                        <ul>
                          {[...localeStates].sort((a, b) => Number(a.translated) - Number(b.translated)).map(({ locale, translated: has }) => (
                            <li key={locale} className="flex items-start gap-2 py-1.5 text-sm">
                              <span className={`shrink-0 ${has ? "text-muted-foreground" : "text-amber-900"}`}>
                                {has ? <Check className="size-4" aria-hidden={true} /> : <X className="size-4" aria-hidden={true} />}
                                <span className="sr-only">{tList(has ? "translated" : "missingTranslation")}</span>
                              </span>
                              <span lang={locale} dir="auto" className="min-w-0 flex-1 wrap-break-word">{getLocaleDisplayName(locale)}</span>
                              <Link className="shrink-0 text-xs underline underline-offset-4" href={`/admin/pages/${page._id}?locale=${locale}`} aria-label={tList("editLanguage", { locale: getLocaleDisplayName(locale) })}>{tList("edit")}</Link>
                            </li>
                          ))}
                        </ul>
                      </PopoverContent>
                    </Popover>
                    </OptionalContribution>
                  )}
                  <Badge
                    variant={
                      page.status === "published" ? "default" : "secondary"
                    }
                    className="text-xs"
                  >
                    {page.status === "published"
                      ? tList("status.published")
                      : page.status === "archived"
                        ? tList("status.archived")
                        : tList("status.draft")}
                  </Badge>
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      aria-label={tList("actionsFor", { title: row.title })}
                      className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus:ring-1 focus:ring-ring focus:outline-none"
                    >
                      <MoreHorizontal className="size-4" />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {page.pageType !== "author" && (
                        <DropdownMenuItem
                          onSelect={() => setDuplicateTarget(page)}
                        >
                          <Copy className="mr-2 size-4" />
                          {tList("actions.duplicate")}
                        </DropdownMenuItem>
                      )}
                      {page.status !== "archived" ? (
                        <DropdownMenuItem onSelect={() => handleArchive(page)}>
                          <Archive className="mr-2 size-4" />
                          {tList("actions.archive")}
                        </DropdownMenuItem>
                      ) : (
                        <>
                          <DropdownMenuItem
                            onSelect={() => handleUnarchive(page)}
                          >
                            <ArchiveRestore className="mr-2 size-4" />
                            {tList("actions.unarchive")}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onSelect={() => handleMoveToTrash(page)}
                          >
                            <Trash2 className="mr-2 size-4" />
                            {tList("actions.moveToTrash")}
                          </DropdownMenuItem>
                        </>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>
            )
          })
        )}
      </div>
      {canLoadMore && (
        <div className="flex justify-center border-t px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() =>
              publicationAuthority === "snapshot_active"
                ? snapshotPaginated.loadMore(25)
                : legacyPaginated.loadMore(25)
            }
            disabled={isLoadingMore}
          >
            {isLoadingMore
              ? tList("pagination.loading")
              : tList("pagination.loadMore")}
          </Button>
        </div>
      )}
      {duplicateTarget && duplicateTarget.pageType !== "author" && (
        <DuplicatePageDialog
          pageId={duplicateTarget._id}
          sourceTitle={getDuplicateTitle(
            duplicateTarget,
            defaultLocale,
            tList("untitled")
          )}
          onClose={() => setDuplicateTarget(null)}
          onDuplicated={() => router.refresh()}
        />
      )}
    </div>
  )
}

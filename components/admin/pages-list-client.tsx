"use client"

import { useState } from "react"
import Link from "next/link"
import { usePathname, useRouter, useSearchParams } from "next/navigation"
import { useLocale, useTranslations } from "next-intl"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { useQuery, useMutation, usePaginatedQuery } from "convex/react"
import type { FunctionReturnType } from "convex/server"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useConfirm } from "@/components/providers/confirm-provider"
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
import { api } from "@/convex/_generated/api"
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

type PageTypeFilter = "all" | ContentType

function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value)
}

// The page-wide statuses. The status filter offers them while publishing is
// not set up (the list then keeps loading).
const STATUSES = ["all", "published", "draft", "archived"] as const
// Snapshot sites filter per language, so "not translated" is a status there.
const SNAPSHOT_STATUSES = [
  "all",
  "published",
  "draft",
  "notTranslated",
  "archived",
] as const

type PublicationAuthority =
  FunctionReturnType<typeof api.cms.publication.getAdminAuthority> | undefined
type StatusFilter = (typeof SNAPSHOT_STATUSES)[number]
type PageWideStatus = "draft" | "published" | "archived"

/** The Search slot filters by page-wide status only. */
function pageWideStatus(status: StatusFilter): PageWideStatus | undefined {
  return status === "all" || status === "notTranslated" ? undefined : status
}

/**
 * The row's lifecycle generation for a lifecycle command. Module-level so the
 * handlers hold no `throw` inside `try`: React Compiler 1.0.0 skips a whole
 * component that contains one.
 */
function lifecycleGeneration(page: SnapshotListPage): number {
  if (page.lifecycleGeneration === undefined) {
    throw new Error("Snapshot lifecycle state is unavailable")
  }
  return page.lifecycleGeneration
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
      searchable={false}
      status={pageWideStatus(status)}
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
  // The Pages list is available to viewers, but health is operational settings
  // data. Skip the privileged subscription until its permission is known.
  const revalidationHealth = useQuery(
    api.cms.revalidate.getRevalidationHealth,
    canViewRevalidationHealth ? {} : "skip"
  )
  const archiveSnapshotPage = useMutation(api.cms.publication.archivePage)
  const restoreSnapshotPage = useMutation(api.cms.publication.restorePage)
  const softDeleteSnapshotPage = useMutation(api.cms.publication.softDeletePage)
  const confirm = useConfirm()
  const contentTypes = adminContentTypes()
  const locales = siteConfig?.enabledLocales ?? []

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
  const snapshotPaginated = usePaginatedQuery(
    api.cms.publication.listAdminPages,
    isSearching || publicationAuthority !== "snapshot_active"
      ? "skip"
      : { scope: status === "archived" ? "archive" : "content" },
    { initialNumItems: 25 }
  )

  async function handleArchive(page: SnapshotListPage) {
    const ok = await confirm({
      title: tList("archiveDialog.title"),
      description: tList("archiveDialog.description"),
      confirmText: tList("actions.archive"),
    })
    if (!ok) return
    try {
      await archiveSnapshotPage({
        pageId: page._id,
        expectedLifecycleGeneration: lifecycleGeneration(page),
      })
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

  async function handleUnarchive(page: SnapshotListPage, title: string) {
    try {
      await restoreSnapshotPage({
        pageId: page._id,
        expectedLifecycleGeneration: lifecycleGeneration(page),
      })
      toast.success(tList("toast.restored", { title }))
      router.refresh()
    } catch (err) {
      toast.error(
        displayError(err, tList("toast.unarchiveFailed"))
      )
    }
  }

  async function handleMoveToTrash(page: SnapshotListPage) {
    const ok = await confirm({
      title: tList("trashDialog.title"),
      description: tList("trashDialog.description"),
      confirmText: tList("trashDialog.confirm"),
      destructive: true,
    })
    if (!ok) return
    try {
      await softDeleteSnapshotPage({
        pageId: page._id,
        expectedLifecycleGeneration: lifecycleGeneration(page),
      })
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
  // An unfinished publishing setup ("invalid") keeps the list loading, as
  // before; a notice for it waits for the owner's decision.
  const isLoading = isSearching
    ? publicationAuthority === undefined
    : !snapshotMode ||
      snapshotPaginated.status === "LoadingFirstPage" ||
      siteConfig === undefined

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
  const rowCount = snapshotFiltered.length

  const isFiltering =
    q !== "" ||
    pageType !== "all" ||
    status !== "all" ||
    // Snapshot lists open on a language; only moving away from it is a filter.
    (snapshotMode
      ? effectiveLocale !== openingLocale
      : effectiveLocale !== "all")

  const canLoadMore =
    !isSearching && snapshotMode && snapshotPaginated.status === "CanLoadMore"
  const isLoadingMore =
    !isSearching && snapshotMode && snapshotPaginated.status === "LoadingMore"
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
        ) : (
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
            onUnarchive={(page, title) => void handleUnarchive(page, title)}
            onTrash={(page) => void handleMoveToTrash(page)}
          />
        )}
      </div>
      {canLoadMore && (
        <div className="flex justify-center border-t px-4 py-3">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => snapshotPaginated.loadMore(25)}
            disabled={isLoadingMore}
          >
            {isLoadingMore
              ? tList("pagination.loading")
              : tList("pagination.loadMore")}
          </Button>
        </div>
      )}
    </div>
  )
}

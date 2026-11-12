"use client"

import {
  Archive,
  ArchiveRestore,
  Languages as LanguagesIcon,
  MoreHorizontal,
  Send,
  Trash2,
  TriangleAlert,
  Undo2,
} from "lucide-react"
import { useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import type { Id } from "@/convex/_generated/dataModel"
import type { SnapshotAdminPageRow } from "@/convex/cms/publication"
import { Badge } from "@/components/ui/badge"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { toPublicPath } from "@/lib/pages/url"
import { cn } from "@/lib/utils"
import { RowTitle, RowUrlName, WrappingBadge } from "./list-row-text"
import {
  firstTitle,
  localeEntry,
  rowAddress,
  rowStatus,
  rowTitle,
  type RowStatus,
} from "./pages-list-locales"
import {
  publishTargetFor,
  rowActionKey,
  unpublishTargetFor,
  usePageRowActions,
  type UnpublishTarget,
} from "./pages-list-row-actions"

export type SnapshotListPage = SnapshotAdminPageRow

/** What the row menu can ask the list to do; the list owns the effects. */
export type RowActions = {
  publish(page: SnapshotListPage, locale: string): void
  unpublish(page: SnapshotListPage, locale: string): void
  translate(page: SnapshotListPage, locale: string): void
  archive(page: SnapshotListPage): void
  unarchive(page: SnapshotListPage): void
  trash(page: SnapshotListPage): void
}

type Common = {
  languages: readonly string[]
  defaultLocale: string
  homePageId: Id<"pages"> | null | undefined
  pending: ReadonlySet<string>
  actions: RowActions
}

function statusLabel(
  t: (key: `rowStatus.${RowStatus | "archived"}`) => string,
  status: RowStatus | "archived"
) {
  return t(`rowStatus.${status}`)
}

/** Row menu: this language on top, the whole page below. */
function RowMenu({
  page,
  locale,
  status,
  title,
  isHome,
  busy,
  actions,
}: {
  page: SnapshotListPage
  locale: string
  status: RowStatus | "archived"
  title: string
  isHome: boolean
  busy: boolean
  actions: RowActions
}) {
  const t = useTranslations("pages.list")
  const archived = status === "archived"
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("actionsFor", { title })}
        className="rounded p-1 text-muted-foreground hover:bg-accent hover:text-foreground focus:ring-1 focus:ring-ring focus:outline-none"
      >
        <MoreHorizontal className="size-4" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {status === "draft" && (
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => actions.publish(page, locale)}
          >
            <Send className="mr-2 size-4" />
            {t("actions.publish")}
          </DropdownMenuItem>
        )}
        {status === "published" && (
          <DropdownMenuItem
            disabled={busy}
            onSelect={() => actions.unpublish(page, locale)}
          >
            <Undo2 className="mr-2 size-4" />
            {t("actions.unpublish")}
          </DropdownMenuItem>
        )}
        {status === "notTranslated" && (
          <DropdownMenuItem onSelect={() => actions.translate(page, locale)}>
            <LanguagesIcon className="mr-2 size-4" />
            {t("actions.translate")}
          </DropdownMenuItem>
        )}
        {!archived && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
              {t("wholePage")}
            </DropdownMenuLabel>
          </>
        )}
        {archived ? (
          <>
            <DropdownMenuItem onSelect={() => actions.unarchive(page)}>
              <ArchiveRestore className="mr-2 size-4" />
              {t("actions.unarchive")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => actions.trash(page)}>
              <Trash2 className="mr-2 size-4" />
              {t("actions.moveToTrash")}
            </DropdownMenuItem>
          </>
        ) : isHome ? (
          <Tooltip>
            <TooltipTrigger asChild>
              {/* The disabled item takes no pointer events; its wrapper does. */}
              <span className="block">
                <DropdownMenuItem disabled>
                  <Archive className="mr-2 size-4" />
                  {t("actions.archive")}
                </DropdownMenuItem>
              </span>
            </TooltipTrigger>
            <TooltipContent side="left">
              {t("actions.homeNoArchive")}
            </TooltipContent>
          </Tooltip>
        ) : (
          <DropdownMenuItem onSelect={() => actions.archive(page)}>
            <Archive className="mr-2 size-4" />
            {t("actions.archive")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** The pieces of one language row, shared by both layouts. */
function useRowParts(
  page: SnapshotListPage,
  locale: string,
  { languages, defaultLocale, homePageId }: Common
) {
  const t = useTranslations("pages.list")
  const archived = page.status === "archived"
  const status: RowStatus | "archived" = archived
    ? "archived"
    : rowStatus(page, locale)
  const missing = status === "notTranslated"
  const own = rowTitle(page, locale)
  const fallback = firstTitle(page, languages)
  const shownTitle = missing
    ? (fallback?.title ?? t("untitled"))
    : own || fallback?.title || t("untitled")
  const titleLocale = own && !missing ? locale : fallback?.locale
  const isHome = homePageId != null && homePageId === page._id
  const address = rowAddress(page, locale, defaultLocale)
  // Muted when the title shown is not this language's own.
  const borrowed = missing || !own
  return {
    t,
    status,
    missing,
    borrowed,
    shownTitle,
    titleLocale,
    isHome,
    address,
  }
}

function TitleLink({
  page,
  locale,
  parts,
}: {
  page: SnapshotListPage
  locale: string
  parts: ReturnType<typeof useRowParts>
}) {
  const { t, missing, shownTitle, titleLocale } = parts
  return (
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
      <span className={cn("min-w-0", missing && "[&_a]:italic")}>
        <RowTitle
          href={`/admin/pages/${page._id}?locale=${locale}`}
          locale={titleLocale}
          muted={parts.borrowed}
        >
          {shownTitle}
        </RowTitle>
      </span>
      {missing && (
        <span className="text-xs text-muted-foreground">
          {t("notTranslatedSuffix")}
        </span>
      )}
    </div>
  )
}

function AddressLine({
  locale,
  parts,
}: {
  locale: string
  parts: ReturnType<typeof useRowParts>
}) {
  const { t, address, isHome, missing } = parts
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      {address.kind === "path" ? (
        <RowUrlName value={address.value} locale={locale} />
      ) : address.kind === "none" ? (
        <span className="text-xs text-muted-foreground italic">
          {t("noAddress")}
        </span>
      ) : null}
      {isHome && !missing && (
        <WrappingBadge muted>{t("homePage")}</WrappingBadge>
      )}
    </div>
  )
}

function StatusBadge({ status }: { status: RowStatus | "archived" }) {
  const t = useTranslations("pages.list")
  return (
    <Badge
      variant={status === "published" ? "default" : "secondary"}
      className="text-xs"
    >
      {statusLabel(t, status)}
    </Badge>
  )
}

/** One page, one language: the single-language view. */
function SingleRow({
  page,
  locale,
  ...common
}: Common & { page: SnapshotListPage; locale: string }) {
  const parts = useRowParts(page, locale, common)
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 px-4 py-3 transition-colors hover:bg-accent/30">
      <div className="min-w-[140px] flex-1">
        <TitleLink page={page} locale={locale} parts={parts} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <AddressLine locale={locale} parts={parts} />
        </div>
      </div>
      <div className="ms-auto flex shrink-0 items-start gap-2 sm:-mt-0.5">
        <StatusBadge status={parts.status} />
        <RowMenu
          page={page}
          locale={locale}
          status={parts.status}
          title={parts.shownTitle}
          isHome={parts.isHome}
          busy={common.pending.has(rowActionKey(page._id, locale))}
          actions={common.actions}
        />
      </div>
    </div>
  )
}

/** One language of a page inside its group: the all-languages view. */
function GroupRow({
  page,
  locale,
  ...common
}: Common & { page: SnapshotListPage; locale: string }) {
  const parts = useRowParts(page, locale, common)
  return (
    <div
      data-language={locale}
      style={{
        borderColor: "color-mix(in oklab, var(--border) 40%, transparent)",
      }}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b py-2 transition-colors first:pt-0 last:border-b-0 last:pb-0 hover:bg-accent/30"
    >
      <span className="w-6 shrink-0 text-xs font-medium text-muted-foreground">
        {locale.toUpperCase()}
      </span>
      <div className="flex min-w-[140px] flex-1 flex-col gap-0.5">
        <TitleLink page={page} locale={locale} parts={parts} />
        <AddressLine locale={locale} parts={parts} />
      </div>
      <div className="ms-auto flex shrink-0 items-center gap-2">
        <StatusBadge status={parts.status} />
        <RowMenu
          page={page}
          locale={locale}
          status={parts.status}
          title={`${parts.shownTitle} (${locale.toUpperCase()})`}
          isHome={parts.isHome}
          busy={common.pending.has(rowActionKey(page._id, locale))}
          actions={common.actions}
        />
      </div>
    </div>
  )
}

/**
 * The snapshot Pages rows. `selected` is one site language or "all". An
 * archived page is a lifecycle state, not a per-language one, so it is one
 * row (in `archivedLocale`) with only whole-page actions.
 */
export function SnapshotPageRows({
  pages,
  selected,
  archivedLocale,
  ...common
}: Common & {
  pages: readonly SnapshotListPage[]
  selected: string
  archivedLocale: string
}) {
  return pages.map((page) => {
    if (page.status === "archived") {
      return (
        <SingleRow
          key={page._id}
          page={page}
          locale={archivedLocale}
          {...common}
        />
      )
    }
    if (selected !== "all") {
      return (
        <SingleRow key={page._id} page={page} locale={selected} {...common} />
      )
    }
    return <PageGroup key={page._id} page={page} {...common} />
  })
}

/** All languages: one visually separate group per page. */
function PageGroup({ page, ...common }: Common & { page: SnapshotListPage }) {
  const t = useTranslations("pages.list")
  const fallback = firstTitle(page, common.languages)
  return (
    <div
      role="group"
      aria-label={fallback?.title ?? t("untitled")}
      className="px-4 py-5"
    >
      {common.languages.map((locale) => (
        <GroupRow key={locale} page={page} locale={locale} {...common} />
      ))}
    </div>
  )
}

export type UnpublishRequest = {
  title: string
  /** Absent when the page has no public address to name. */
  body?: string
  warning: boolean
  confirm: string
  cancel: string
}

function languageName(code: string, inLocale: string): string {
  try {
    return (
      new Intl.DisplayNames([inLocale], { type: "language" }).of(code) ?? code
    )
  } catch {
    return getLocaleDisplayName(code)
  }
}

/**
 * The question asked before one language of a page is unpublished. The Pages
 * list and the page editor both ask it, so its wording has this one owner.
 */
export function unpublishRequest(
  t: ReturnType<typeof useTranslations<"pages.list">>,
  adminLocale: string,
  {
    locale,
    path,
    defaultLocale,
    languages,
    locales,
    isHome,
  }: {
    locale: string
    /** This language's address before its language prefix; null when none. */
    path: string | null | undefined
    defaultLocale: string
    /** The site languages in site order. */
    languages: readonly string[]
    /** Each language's state and address, as the Pages list reads them. */
    locales: readonly {
      locale: string
      state?: string
      path?: string | null
    }[]
    isHome: boolean
  }
): UnpublishRequest {
  const buttons = {
    confirm: t("unpublish.confirm"),
    cancel: t("unpublish.cancel"),
  }
  if (!isHome) {
    return {
      ...buttons,
      title: t("unpublish.title"),
      warning: false,
      ...(path == null
        ? {}
        : {
            body: t("unpublish.notFound", {
              address: toPublicPath(path, locale, defaultLocale),
            }),
          }),
    }
  }
  const address = toPublicPath(path ?? "/", locale, defaultLocale)
  const published = (code: string) =>
    locales.find(
      (entry) => entry.locale === code && entry.state === "published"
    )
  // The default language's "/" falls back to the first other published home
  // in site order; any other address, or no other home, is "Page not found".
  const otherLocale =
    locale === defaultLocale
      ? languages.find((other) => other !== locale && published(other))
      : undefined
  const base = { ...buttons, title: t("unpublish.homeTitle") }
  if (otherLocale) {
    return {
      ...base,
      warning: false,
      body: t("unpublish.redirect", {
        address,
        language: languageName(otherLocale, adminLocale),
        other: toPublicPath(
          published(otherLocale)?.path ?? "/",
          otherLocale,
          defaultLocale
        ),
      }),
    }
  }
  return {
    ...base,
    warning: true,
    body:
      locale === defaultLocale
        ? t("unpublish.notFoundNoOther", { address })
        : t("unpublish.notFound", { address }),
  }
}

/** The confirmation before unpublishing one language of a page. */
export function UnpublishDialog({
  request,
  onCancel,
  onConfirm,
}: {
  request: UnpublishRequest | null
  onCancel(): void
  onConfirm(): void
}) {
  return (
    <AlertDialog
      open={request !== null}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      {request && (
        <AlertDialogContent
          className="data-[size=default]:max-w-[calc(100%-2rem)] data-[size=default]:sm:max-w-md"
          {...(request.body ? {} : { "aria-describedby": undefined })}
        >
          <AlertDialogHeader className="place-items-start text-left">
            <AlertDialogTitle className="text-sm leading-none">
              {request.title}
            </AlertDialogTitle>
            {request.body === undefined ? null : request.warning ? (
              <AlertDialogDescription className="flex items-start gap-2 rounded-md border border-destructive/40 bg-destructive/8 p-3 text-destructive">
                <TriangleAlert
                  className="mt-0.5 size-4 shrink-0"
                  aria-hidden={true}
                />
                <span>{request.body}</span>
              </AlertDialogDescription>
            ) : (
              <AlertDialogDescription>{request.body}</AlertDialogDescription>
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{request.cancel}</AlertDialogCancel>
            <AlertDialogAction
              variant={request.warning ? "destructive" : "default"}
              onClick={onConfirm}
            >
              {request.confirm}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      )}
    </AlertDialog>
  )
}

/**
 * The snapshot rows with their per-language actions and the Unpublish
 * question. Everything an action needs is captured when it is chosen.
 */
export function SnapshotPagesBody({
  pages,
  selected,
  archivedLocale,
  languages,
  defaultLocale,
  homePageId,
  onArchive,
  onUnarchive,
  onTrash,
}: {
  pages: readonly SnapshotListPage[]
  selected: string
  archivedLocale: string
  languages: readonly string[]
  defaultLocale: string
  homePageId: Id<"pages"> | null | undefined
  onArchive(page: SnapshotListPage): void
  onUnarchive(page: SnapshotListPage): void
  onTrash(page: SnapshotListPage): void
}) {
  const t = useTranslations("pages.list")
  const adminLocale = useLocale()
  const rowActions = usePageRowActions()
  const [unpublishAsk, setUnpublishAsk] = useState<{
    request: UnpublishRequest
    target: UnpublishTarget
  } | null>(null)

  const actions: RowActions = {
    publish(page, locale) {
      const entry = localeEntry(page, locale)
      if (entry) void rowActions.publish(publishTargetFor(page, entry))
    },
    unpublish(page, locale) {
      const entry = localeEntry(page, locale)
      const target = entry && unpublishTargetFor(page, entry)
      if (!entry || !target) return
      setUnpublishAsk({
        target,
        request: unpublishRequest(t, adminLocale, {
          locale,
          path: entry.path,
          defaultLocale,
          languages,
          locales: page.locales ?? [],
          isHome: homePageId != null && homePageId === page._id,
        }),
      })
    },
    translate: (page, locale) => rowActions.openEditor(page._id, locale),
    archive: onArchive,
    unarchive: onUnarchive,
    trash: onTrash,
  }

  return (
    <>
      <SnapshotPageRows
        pages={pages}
        selected={selected}
        archivedLocale={archivedLocale}
        languages={languages}
        defaultLocale={defaultLocale}
        homePageId={homePageId}
        pending={rowActions.pending}
        actions={actions}
      />
      <UnpublishDialog
        request={unpublishAsk?.request ?? null}
        onCancel={() => setUnpublishAsk(null)}
        onConfirm={() => {
          if (unpublishAsk) void rowActions.unpublish(unpublishAsk.target)
          setUnpublishAsk(null)
        }}
      />
    </>
  )
}

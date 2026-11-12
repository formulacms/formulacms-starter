"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Check,
  FileText,
  Loader2,
  Menu,
  type LucideIcon,
} from "lucide-react"
import { getLocaleDisplayName } from "@/lib/i18n/config"
import { toPublicPath } from "@/lib/pages/url"
import type { Translate } from "./errors"
import type { DisclosureItem, ImpactPreview, LanguagesQueries } from "./types"

/** The things a change touches, each with a small icon and a count. */
export function PreviewCounts({ count }: { count: ImpactPreview["count"] }) {
  const t = useTranslations("settings.multilingualLanguages")
  if (count.publicPages === 0 && count.menus === 0) return null
  return (
    <ul
      className="grid gap-1.5 text-sm sm:grid-cols-2"
      aria-label={t("preview.countsLabel")}
    >
      {count.publicPages > 0 && (
        <CountRow icon={FileText}>
          {t("preview.pages", { count: count.publicPages })}
        </CountRow>
      )}
      {count.menus > 0 && (
        <CountRow icon={Menu}>
          {t("preview.menus", { count: count.menus })}
        </CountRow>
      )}
    </ul>
  )
}

function CountRow({
  icon: Icon,
  children,
}: {
  icon: LucideIcon
  children: React.ReactNode
}) {
  return (
    <li className="flex items-center gap-2">
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      {children}
    </li>
  )
}

export function Working({ label }: { label: string }) {
  return (
    <p
      role="status"
      className="flex items-center gap-2 text-sm text-muted-foreground"
    >
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </p>
  )
}

/** What the review list knows about one page of items. */
type PageSummary = { stale: true } | { stale: false; digest: string } | null

type ReviewPageResult =
  | { stale: true }
  | { stale: false; ordinal: number; digest: string; items: DisclosureItem[] }

export type ReviewReceipt = { ordinal: number; pageDigest: string }

/**
 * Where the one confirm button stands. `ready` means every page is loaded and
 * none is out of date; `receipts` are the pages the server has not yet
 * recorded, in order.
 */
export type ReviewStatus = {
  ready: boolean
  stale: boolean
  receipts: ReviewReceipt[]
}

export type ReviewPages = {
  status: ReviewStatus
  report(ordinal: number, page: ReviewPageResult | undefined): void
}

function sameSummary(left: PageSummary, right: PageSummary): boolean {
  if (left === right) return true
  if (left === null || right === null) return false
  return (
    left.stale === right.stale &&
    (left.stale || right.stale || left.digest === right.digest)
  )
}

/**
 * Collects what each review page loaded. The pages report as they arrive; the
 * status is derived, so the confirm button needs no extra state. Only the
 * pages after `firstUnreviewed` still need a receipt.
 */
export function useReviewPages(
  pageCount: number,
  firstUnreviewed: number
): ReviewPages {
  const [pages, setPages] = useState<Record<number, PageSummary>>({})

  function report(ordinal: number, page: ReviewPageResult | undefined) {
    const next: PageSummary =
      page === undefined
        ? null
        : page.stale
          ? { stale: true }
          : { stale: false, digest: page.digest }
    setPages((previous) =>
      sameSummary(previous[ordinal] ?? null, next)
        ? previous
        : { ...previous, [ordinal]: next }
    )
  }

  let ready = true
  let stale = false
  const receipts: ReviewReceipt[] = []
  for (let ordinal = 0; ordinal < pageCount; ordinal += 1) {
    const summary = pages[ordinal] ?? null
    if (summary === null) {
      ready = false
    } else if (summary.stale) {
      stale = true
      ready = false
    } else if (ordinal >= firstUnreviewed) {
      receipts.push({ ordinal, pageDigest: summary.digest })
    }
  }
  return { status: { ready, stale, receipts }, report }
}

/**
 * Records the receipt for each unchecked page in order. Returns false when the
 * server says a page was replaced meanwhile; nothing after it is recorded.
 */
export async function recordReceipts(
  receipts: ReviewReceipt[],
  record: (receipt: ReviewReceipt) => Promise<{ stale: boolean }>
): Promise<boolean> {
  for (const receipt of receipts) {
    const result = await record(receipt)
    if (result.stale) return false
  }
  return true
}

/**
 * The language the listed addresses belong to. The server lists addresses
 * without a language prefix; with this, each shows as visitors see it.
 */
export type AddressContext = { locale: string; defaultLocale: string }

function ReviewPage<Args>({
  ordinal,
  usePage,
  pageArgs,
  report,
  addressContext,
}: {
  addressContext?: AddressContext
  ordinal: number
  usePage: (args: Args) => ReviewPageResult | undefined
  pageArgs: (ordinal: number) => Args
  report: ReviewPages["report"]
}) {
  const t = useTranslations("settings.multilingualLanguages")
  const page = usePage(pageArgs(ordinal))
  useEffect(() => {
    report(ordinal, page)
  }, [ordinal, page, report])
  if (page === undefined) return <Working label={t("review.loading")} />
  if (page.stale) return null
  return <DisclosureItems items={page.items} addressContext={addressContext} />
}

/**
 * Every page of affected items in one scrolling list. Loading a page records
 * nothing: the receipts are written when the owner presses the one confirm
 * button, and the server only lets the change run once all are recorded
 * (`LANGUAGE_PREVIEW_REVIEW_INCOMPLETE`).
 */
export function ReviewList<Args>({
  pageCount,
  usePage,
  pageArgs,
  review,
  addressContext,
}: {
  addressContext?: AddressContext
  pageCount: number
  /** The query hook that loads one page (a hook reference, not a call). */
  usePage: (args: Args) => ReviewPageResult | undefined
  pageArgs: (ordinal: number) => Args
  review: ReviewPages
}) {
  const t = useTranslations("settings.multilingualLanguages")
  if (pageCount === 0) {
    return (
      <p className="flex items-center gap-2 text-sm text-emerald-700 dark:text-emerald-400">
        <Check className="size-4" aria-hidden />
        {t("review.complete")}
      </p>
    )
  }
  return (
    <div className="space-y-2">
      {review.status.stale && (
        <p role="alert" className="text-sm text-destructive">
          {t("errors.stale")}
        </p>
      )}
      <div
        role="region"
        aria-label={t("review.listLabel")}
        className="max-h-64 space-y-3 overflow-y-auto rounded-md border p-2"
      >
        {Array.from({ length: pageCount }, (_, ordinal) => (
          <ReviewPage
            key={ordinal}
            ordinal={ordinal}
            usePage={usePage}
            pageArgs={pageArgs}
            report={review.report}
            addressContext={addressContext}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The review list for one impact preview, once the counting is done. The
 * pages of items load together; one confirm button elsewhere in the dialog
 * records them and runs the change.
 */
export function PreviewReview({
  preview,
  queries,
  review,
  addressContext,
}: {
  addressContext?: AddressContext
  preview: ImpactPreview
  queries: Pick<LanguagesQueries, "useImpactPage">
  review: ReviewPages
}) {
  const t = useTranslations("settings.multilingualLanguages")
  if (preview.phase !== "complete") {
    return <Working label={t("preview.preparing")} />
  }
  if (preview.pageCount === 0) return null
  return (
    <ReviewList
      pageCount={preview.pageCount}
      usePage={queries.useImpactPage}
      pageArgs={(ordinal) => ({ previewId: preview.previewId, ordinal })}
      review={review}
      addressContext={addressContext}
    />
  )
}

export function DisclosureItems({
  items,
  addressContext,
}: {
  items: DisclosureItem[]
  addressContext?: AddressContext
}) {
  const t = useTranslations("settings.multilingualLanguages")
  return (
    <ul className="space-y-2" data-testid="language-disclosure-items">
      {items.map((item, index) => (
        <li
          key={`${item.kind}:${index}`}
          className="rounded-md border bg-background px-3 py-2 text-sm"
        >
          {disclosureItemText(t, item, addressContext)}
          {item.truncated && (
            <span className="ml-1 text-xs text-muted-foreground">
              {t("disclosure.shortened")}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function disclosureItemText(
  t: Translate,
  item: DisclosureItem,
  context?: AddressContext
): string {
  // An address in its own language context: prefixed unless it is the
  // default language's. Without a context the path is shown as stored.
  const address = (path: string) =>
    context ? toPublicPath(path, context.locale, context.defaultLocale) : path
  switch (item.kind) {
    case "selection":
      return t("disclosure.selection", {
        title: item.title,
        path: address(item.path),
      })
    case "selection_non_routable":
      return t("disclosure.selectionWithoutAddress", { title: item.title })
    case "historical_route":
      return t("disclosure.historical", { path: address(item.fromPath) })
    case "locale_prefix_shadow":
      return t("disclosure.localePrefixShadow", { path: item.fromPath })
    case "manual_rule": {
      const destination =
        item.destination.kind === "path"
          ? address(item.destination.toPath)
          : item.destination.kind === "external"
            ? item.destination.url
            : t("disclosure.anotherPage")
      return item.newVisiblePath
        ? t("disclosure.ruleMoves", {
            from: address(item.fromPath),
            to: item.newVisiblePath,
            destination,
          })
        : t("disclosure.rule", { from: address(item.fromPath), destination })
    }
    case "menu_node":
      return t("disclosure.menu", {
        menu: item.menuName,
        item: item.nodePath,
      })
    case "menu_blocker":
      return t("disclosure.menuBlocker", {
        menu: item.menuName,
        item: item.nodePath,
      })
    case "shadowed_row":
      return t("disclosure.shadowed", {
        path: item.fromPath,
        language: getLocaleDisplayName(item.destinationLocale),
      })
    case "route_path_too_long":
      return t("disclosure.addressTooLong", { path: item.fromPath })
  }
}

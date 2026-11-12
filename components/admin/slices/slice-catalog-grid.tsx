"use client"

import { readSliceMetadata } from "@/lib/slices/builder"

import { useTranslations } from "next-intl"
import { useState } from "react"
import Link from "next/link"
import Image from "next/image"
import { useQuery } from "convex/react"
import {
  Archive,
  ArrowRight,
  Check,
  FileQuestion,
  ImageOff,
  Search,
  Sparkles,
} from "lucide-react"
import { api } from "@/convex/_generated/api"
import type { SliceCatalogItem } from "@/lib/slices/catalog"
import { SLICE_GROUPS } from "@/lib/slices/builder"
import { adminSliceGroupLabel } from "@/lib/i18n/admin-metadata"
import { SliceCardActions } from "@/components/admin/slices/slice-card-actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"

/**
 * Catalog item with its snapshot existence resolved on the server: a missing
 * `public/slice-sim/<type>.png` (e.g. a freshly-authored slice that has not
 * been captured yet) arrives as `thumbnailUrl: null` so the tile can fall back
 * to the slice's icon plate instead of a broken-image glyph. `archived` is the
 * owner's curation state (siteSettings) — archived tiles move to the Archived
 * tab and out of the authoring picker.
 */
export type SliceCatalogTile = Omit<SliceCatalogItem, "thumbnailUrl"> & {
  thumbnailUrl: string | null
  /** `null` means the authoritative archive read failed. */
  archived: boolean | null
  /** Whether this slice is marked to ship to formulacms-starter (engine-only). */
  shipped: boolean
}

/** The one results pane every tab controls. */
const RESULTS_ID = "slice-results"

type Origin = SliceCatalogItem["origin"]
/** One tab row: the two origins (slices you can still add) plus Archived. */
type Tab = Origin | "archived"

/** Which tile actions this reader and this install can perform. Resolved once
 *  for the whole grid — `canArchive` is one permission read, not one per tile. */
type TileCapabilities = {
  canArchive: boolean
  canShip: boolean
}

/** One continuous grid reads best in category order; the sort is stable, so
 *  slices keep their catalog order inside a category. */
function inCategoryOrder(items: SliceCatalogTile[]): SliceCatalogTile[] {
  const rank = (item: SliceCatalogTile) =>
    SLICE_GROUPS.findIndex((group) => group.id === item.group)
  return [...items].sort((a, b) => rank(a) - rank(b))
}

export function SliceCatalogGrid({
  items,
  canShip = false,
  isEngine = false,
}: {
  items: SliceCatalogTile[]
  /** Engine-only: the ship-list resolves *and* this is a local dev server. */
  canShip?: boolean
  /** This checkout is the engine, where authoring a slice produces a System
   *  slice rather than one of the owner's own. Distinct from `canShip`, which
   *  additionally requires a local dev server to write the ship-list. */
  isEngine?: boolean
}) {
  const t = useTranslations("slices.catalog")
  const [query, setQuery] = useState("")
  const [tab, setTab] = useState<Tab>("system")

  // Archiving is a settings-level change (admin-only), independent of the
  // dev-only file write that shipping is.
  const owner = useQuery(api.cms.owner.getOwnerSession)
  const caps: TileCapabilities = {
    canArchive: owner !== undefined && owner !== null,
    canShip,
  }

  const q = query.trim().toLowerCase()
  const matchesQuery = (item: SliceCatalogTile) =>
    !q ||
    [item.label, item.type, item.description, item.group]
      .join(" ")
      .toLowerCase()
      .includes(q)

  const lifecycleUnavailable = items.some((item) => item.archived === null)

  if (lifecycleUnavailable) {
    // The archive authority failed: one flat, read-only grid. No lifecycle
    // tabs and no tile actions, so nothing pretends every type is active.
    const matchingItems = inCategoryOrder(items.filter(matchesQuery))

    return (
      <div className="space-y-6">
        <CatalogSearch query={query} onQueryChange={setQuery} />
        <div
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 p-4"
        >
          <p className="text-sm font-medium">{t("unavailable")}</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("unavailableHint")}
          </p>
        </div>
        {matchingItems.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t("noMatch", { query })}
          </p>
        ) : (
          <TileGrid items={matchingItems} />
        )}
      </div>
    )
  }

  // Core / Custom count what you can still add (not archived); Archived counts
  // the archived slices of both origins. Search narrows only what is shown.
  const belongsTo = (item: SliceCatalogTile, t: Tab) =>
    t === "archived" ? !!item.archived : !item.archived && item.origin === t
  const countFor = (t: Tab) => items.filter((item) => belongsTo(item, t)).length
  const inTab = items.filter((item) => belongsTo(item, tab))
  const shown = inCategoryOrder(inTab.filter(matchesQuery))

  // Owner-authored slices: invite the first one, but only where authoring one
  // would actually land here. In the engine every slice authored is part of
  // what formulacms ships, so the invitation would promise something that
  // never happens.
  const invitesFirstOwn = tab === "user" && !q && !isEngine

  return (
    <div className="space-y-6">
      <CatalogSearch query={query} onQueryChange={setQuery} />

      <Tabs value={tab} onValueChange={(value) => setTab(value as Tab)}>
        <TabsList aria-label={t("originTabs")}>
          <TabsTrigger value="system" aria-controls={RESULTS_ID}>
            {t("system")} <CountBadge count={countFor("system")} />
          </TabsTrigger>
          <TabsTrigger value="user" aria-controls={RESULTS_ID}>
            {t("yourSlices")} <CountBadge count={countFor("user")} />
          </TabsTrigger>
          <TabsTrigger value="archived" aria-controls={RESULTS_ID}>
            {t("archived")} <CountBadge count={countFor("archived")} />
          </TabsTrigger>
        </TabsList>
      </Tabs>

      <div id={RESULTS_ID} className="space-y-6">
        {shown.length > 0 ? (
          <TileGrid items={shown} caps={caps} showOrigin={tab === "archived"} />
        ) : inTab.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            {tab === "archived"
              ? t("noArchivedMatch", { query })
              : t("noMatch", { query })}
          </p>
        ) : tab === "archived" ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center">
            <Archive className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">{t("emptyArchive")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("emptyArchiveHint")}{" "}
            </p>
          </div>
        ) : q ? (
          <p className="text-sm text-muted-foreground">
            {t("noMatch", { query })}
          </p>
        ) : invitesFirstOwn ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center">
            <Sparkles className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">{t("emptyOwn")}</p>
            <p className="max-w-sm text-sm text-muted-foreground">
              {t("emptyOwnHint")}{" "}
            </p>
          </div>
        ) : (
          <div className="flex flex-col items-center gap-2 rounded-xl border border-dashed bg-muted/20 px-6 py-10 text-center">
            <Sparkles className="size-6 text-muted-foreground/60" />
            <p className="text-sm font-medium">
              {tab === "user" ? t("emptyCustom") : t("emptyCore")}
            </p>
          </div>
        )}
      </div>
    </div>
  )
}

function CatalogSearch({
  query,
  onQueryChange,
}: {
  query: string
  onQueryChange: (query: string) => void
}) {
  const t = useTranslations("slices.catalog")
  return (
    <div className="relative max-w-sm">
      <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
      <Input
        type="search"
        placeholder={t("searchPlaceholder")}
        value={query}
        onChange={(event) => onQueryChange(event.target.value)}
        className="pl-9"
        aria-label={t("search")}
      />
    </div>
  )
}

function CountBadge({ count }: { count: number }) {
  return (
    <Badge variant="secondary" className="ml-1.5 rounded-full tabular-nums">
      {count}
    </Badge>
  )
}

/** One continuous grid, so the columns fill evenly whatever the categories. */
function TileGrid({
  items,
  caps,
  showOrigin = false,
}: {
  items: SliceCatalogTile[]
  /** Omitted where the archive authority failed to load — tiles stay readable
   *  but carry no lifecycle actions. */
  caps?: TileCapabilities
  /** Archived tab only: mixes both origins, so each card names its own. */
  showOrigin?: boolean
}) {
  return (
    <div
      data-testid="slice-grid"
      className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-3"
    >
      {items.map((item) => (
        <SliceTile
          key={item.type}
          item={item}
          caps={caps}
          showOrigin={showOrigin}
        />
      ))}
    </div>
  )
}

function SliceTile({
  item,
  caps,
  showOrigin = false,
}: {
  item: SliceCatalogTile
  caps?: TileCapabilities
  showOrigin?: boolean
}) {
  // A retired/removed slice type may still have a catalog entry (e.g. from
  // stale usage data); fall back to a generic icon instead of crashing.
  const Icon = readSliceMetadata(item.type)?.icon ?? FileQuestion

  const t = useTranslations("slices.catalog")
  const tMetadata = useTranslations("metadata")
  return (
    <div
      data-testid="slice-card"
      data-slice-type={item.type}
      className="group flex flex-col overflow-hidden rounded-xl border bg-card transition-shadow hover:shadow-md"
    >
      <Link
        href={`/admin/slices/${item.type}`}
        className="block focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <div className="relative aspect-video overflow-hidden border-b bg-muted/40">
          {item.thumbnailUrl ? (
            <Image
              src={item.thumbnailUrl}
              alt={t("previewAlt", { label: item.label })}
              fill
              sizes="(min-width: 1280px) 33vw, (min-width: 640px) 50vw, 100vw"
              className="object-cover object-top transition-transform duration-300 group-hover:scale-[1.02]"
              unoptimized
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-muted-foreground/60">
              <Icon className="size-8" />
              <span className="flex items-center gap-1 text-xs">
                <ImageOff className="size-3.5" />
                {t("noSnapshot")}{" "}
              </span>
            </div>
          )}
        </div>
      </Link>

      <div className="flex flex-1 flex-col gap-3 p-4">
        <div className="min-w-0 space-y-1">
          {/* One grid per tab, so the category sits on the card. */}
          <p
            data-testid="slice-category"
            className="text-xs text-muted-foreground"
          >
            {adminSliceGroupLabel(
              item.group,
              SLICE_GROUPS.find((group) => group.id === item.group)?.label ??
                item.group,
              tMetadata
            )}
          </p>
          <Link
            href={`/admin/slices/${item.type}`}
            className="block truncate font-medium hover:underline"
          >
            {item.label}
          </Link>
          <div className="flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="font-mono text-[11px]">
              {item.type}
            </Badge>
            {showOrigin && (
              <Badge
                data-testid="origin-chip"
                variant="secondary"
                className="text-[11px]"
              >
                {item.origin === "user" ? t("originCustom") : t("originCore")}
              </Badge>
            )}
            {item.shipped && (
              <Badge variant="secondary" className="gap-1 text-[11px]">
                <Check className="size-3" />
                {t("inStarter")}{" "}
              </Badge>
            )}
          </div>
        </div>

        <div className="mt-auto flex flex-wrap items-center gap-2">
          <Button asChild size="sm" variant="outline">
            <Link href={`/admin/slices/${item.type}`}>
              {t("open")} <ArrowRight className="size-4" />
            </Link>
          </Button>
          {caps && item.archived !== null && (
            <SliceCardActions
              type={item.type}
              label={item.label}
              archived={item.archived}
              canArchive={caps.canArchive}
              canShip={caps.canShip}
              shipped={item.shipped}
            />
          )}
        </div>
      </div>
    </div>
  )
}

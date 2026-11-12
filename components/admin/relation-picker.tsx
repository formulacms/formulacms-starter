"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useQuery } from "convex/react"
import { ChevronDown, ChevronUp } from "lucide-react"
import { api } from "@/convex/_generated/api"
import type { Id } from "@/convex/_generated/dataModel"
import type { PageType } from "@/convex/lib/pages/types"
import type { Locale } from "@/lib/i18n/config"
import { useDebouncedValue } from "@/lib/use-debounced-value"

export type RelationPickerCard = {
  id: Id<"pages">
  type: string
  title: string
  subtitle?: string
  href?: string
}

type RelationPickerProps = {
  /**
   * Allowed target content types — mirrors the descriptor's
   * `relation({ pageTypes })` config. Cards outside this set never appear.
   */
  pageTypes: readonly PageType[]
  /**
   * Currently selected target — `null` for an empty relation. The picker is
   * fully controlled; consumers persist changes via `onChange`.
   */
  value: Id<"pages"> | null
  onChange: (nextId: Id<"pages"> | null) => void
  /** Locale the reference cards resolve titles in. */
  locale: Locale
  /**
   * Menus / redirects / homepage constrain to routable types even when the
   * descriptor allowlist includes non-routable ones. Enforced server-side by
   * `searchTargets`; the picker mirrors the flag so the query dedupes.
   */
  routableOnly?: boolean
  /** Accessibility label — the surrounding field-editor supplies this. */
  ariaLabel?: string
  /**
   * Explicit "clear the relation" button. Defaults to on. Callers who model
   * the relation as required can pass `false` to hide it.
   */
  allowNone?: boolean
  disabled?: boolean
}

/**
 * Relation picker (plan 028 C2). Editors bind a `relation()` field to a target
 * document from the `pages` table constrained by `pageTypes`. The picker is
 * currently dormant — no shipped descriptor uses `relation()` yet (C5 wires
 * post's byline as the first live consumer). It ships now so C5 lands as pure
 * additive descriptor edits with no UI plumbing.
 *
 * Presentation is deliberately unopinionated: no dialog, no portal, no
 * dropdown chrome. Consumers place it inline in a form section. The cards
 * consumed are the `ReferenceCard` shape from `resolveReferenceCard` — one
 * dispatch point through the descriptor registry — so the picker never
 * re-derives per-type card composition.
 */
export function RelationPicker({
  pageTypes,
  value,
  onChange,
  locale,
  routableOnly,
  ariaLabel,
  allowNone = true,
  disabled = false,
}: RelationPickerProps) {
  const t = useTranslations("editor.relations")
  const [search, setSearch] = useState("")
  // Match the repo pattern (media-browser, pages-list): 250ms debounce so a
  // fast typist doesn't churn one Convex subscription per keystroke.
  const debouncedSearch = useDebouncedValue(search.trim(), 250)

  const searchResults = useQuery(api.cms.relations.searchTargets, {
    // Spread copy — the Convex validator wants a mutable array; the prop is
    // readonly so the surrounding editor can share the constant across
    // renders without a defensive copy on its side.
    pageTypes: [...pageTypes],
    locale,
    search: debouncedSearch || undefined,
    routableOnly,
    limit: 20,
  })

  const selectedCard = useQuery(
    api.cms.relations.getReferenceCard,
    value ? { id: value, locale } : "skip"
  )

  const listStatus = searchResults === undefined ? "loading" : "ready"

  return (
    <div className="space-y-2">
      {value && (
        <div className="rounded-md border bg-card p-3 text-sm">
          {selectedCard ? (
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="truncate font-medium">
                  {selectedCard.titleFallback === "untitled"
                    ? t("untitled")
                    : selectedCard.title}
                </p>
                {selectedCard.subtitle && (
                  <p className="truncate text-xs text-muted-foreground">
                    {selectedCard.subtitle}
                  </p>
                )}
                <p className="mt-1 text-[10px] tracking-wide text-muted-foreground uppercase">
                  {selectedCard.type}
                  {selectedCard.href ? t("published") : t("draft")}
                </p>
              </div>
              {allowNone && !disabled && (
                <button
                  type="button"
                  onClick={() => onChange(null)}
                  className="shrink-0 text-xs text-destructive hover:underline"
                >
                  {t("clear")}
                </button>
              )}
            </div>
          ) : selectedCard === null ? (
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-destructive">{t("missing")}</p>
              {allowNone && !disabled && (
                <button
                  type="button"
                  onClick={() => onChange(null)}
                  className="shrink-0 text-xs text-destructive hover:underline"
                >
                  {t("clear")}
                </button>
              )}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground">{t("loading")}</p>
          )}
        </div>
      )}

      <div>
        <input
          type="search"
          aria-label={ariaLabel ?? t("searchLabel")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          disabled={disabled}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none disabled:opacity-50"
        />
      </div>

      <div
        role="listbox"
        aria-label={ariaLabel ?? t("targetsLabel")}
        className="max-h-64 overflow-y-auto rounded-md border bg-background"
      >
        {listStatus === "loading" ? (
          <p className="p-3 text-xs text-muted-foreground">{t("loading")}</p>
        ) : searchResults && searchResults.length > 0 ? (
          <ul className="divide-y">
            {searchResults.map((card) => {
              const isSelected = card.id === value
              return (
                <li key={card.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isSelected}
                    disabled={disabled}
                    onClick={() => onChange(card.id)}
                    className={`flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none ${
                      isSelected ? "bg-muted" : ""
                    }`}
                  >
                    <span className="truncate font-medium">
                      {card.titleFallback === "untitled"
                        ? t("untitled")
                        : card.title}
                    </span>
                    {card.subtitle && (
                      <span className="truncate text-xs text-muted-foreground">
                        {card.subtitle}
                      </span>
                    )}
                    <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                      {card.type}
                      {card.href ? t("published") : t("draft")}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        ) : (
          <p className="p-3 text-xs text-muted-foreground">
            {search.trim() ? t("noMatches") : t("noTargets")}
          </p>
        )}
      </div>
    </div>
  )
}

type MultiRelationPickerProps = {
  /** Allowed target content types — mirrors `list(relation({ pageTypes }))`. */
  pageTypes: readonly PageType[]
  /**
   * Ordered selection. Position is meaningful — index 0 is the lead entry
   * by convention (plan 029 C10 §Q6, the post byline's lead author).
   */
  value: Id<"pages">[]
  onChange: (next: Id<"pages">[]) => void
  /** Locale the reference cards resolve titles in. */
  locale: Locale
  routableOnly?: boolean
  ariaLabel?: string
  disabled?: boolean
}

/**
 * Multi-select relation picker (plan 029 C10 task 14). Sibling of
 * `RelationPicker` for `list(relation())` fields that need an ordered,
 * add/remove/reorder UI rather than a single slot — today's only consumer
 * is the post byline's `authorIds`. Kept bespoke rather than routed through
 * the generic `list` + `RelationWidget` combo because that generic widget
 * isn't locale-aware yet (see `system-owned-fields.ts` for the full
 * rationale); this component reuses the same locale-aware
 * `getReferenceCard` / `searchTargets` queries as the single-value
 * `RelationPicker` above.
 */
export function MultiRelationPicker({
  pageTypes,
  value,
  onChange,
  locale,
  routableOnly,
  ariaLabel,
  disabled = false,
}: MultiRelationPickerProps) {
  const t = useTranslations("editor.relations")
  const [search, setSearch] = useState("")
  const debouncedSearch = useDebouncedValue(search.trim(), 250)

  const searchResults = useQuery(api.cms.relations.searchTargets, {
    pageTypes: [...pageTypes],
    locale,
    search: debouncedSearch || undefined,
    routableOnly,
    limit: 20,
  })

  const selectedIds = new Set(value)

  function addId(id: Id<"pages">) {
    if (selectedIds.has(id)) return
    onChange([...value, id])
    setSearch("")
  }

  function removeId(id: Id<"pages">) {
    onChange(value.filter((existing) => existing !== id))
  }

  function move(index: number, delta: number) {
    const target = index + delta
    if (target < 0 || target >= value.length) return
    const next = [...value]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  const availableResults = (searchResults ?? []).filter(
    (card) => !selectedIds.has(card.id)
  )
  const listStatus = searchResults === undefined ? "loading" : "ready"

  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <ul className="space-y-1.5">
          {value.map((id, index) => (
            <MultiRelationSelectedRow
              key={id}
              id={id}
              locale={locale}
              isLead={index === 0}
              isFirst={index === 0}
              isLast={index === value.length - 1}
              disabled={disabled}
              onRemove={() => removeId(id)}
              onMoveUp={() => move(index, -1)}
              onMoveDown={() => move(index, 1)}
            />
          ))}
        </ul>
      )}

      <div>
        <input
          type="search"
          aria-label={ariaLabel ?? t("searchLabel")}
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("searchPlaceholder")}
          disabled={disabled}
          className="w-full rounded-md border bg-background px-3 py-2 text-sm focus:ring-1 focus:ring-ring focus:outline-none disabled:opacity-50"
        />
      </div>

      <div
        role="listbox"
        aria-label={ariaLabel ?? t("targetsLabel")}
        className="max-h-64 overflow-y-auto rounded-md border bg-background"
      >
        {listStatus === "loading" ? (
          <p className="p-3 text-xs text-muted-foreground">{t("loading")}</p>
        ) : availableResults.length > 0 ? (
          <ul className="divide-y">
            {availableResults.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={disabled}
                  onClick={() => addId(card.id)}
                  className="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm hover:bg-muted focus:bg-muted focus:outline-none"
                >
                  <span className="truncate font-medium">
                    {card.titleFallback === "untitled"
                      ? t("untitled")
                      : card.title}
                  </span>
                  {card.subtitle && (
                    <span className="truncate text-xs text-muted-foreground">
                      {card.subtitle}
                    </span>
                  )}
                  <span className="text-[10px] tracking-wide text-muted-foreground uppercase">
                    {card.type}
                    {card.href ? t("published") : t("draft")}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="p-3 text-xs text-muted-foreground">
            {search.trim()
              ? t("noMatches")
              : value.length > 0
                ? t("noMoreTargets")
                : t("noTargets")}
          </p>
        )}
      </div>
    </div>
  )
}

function MultiRelationSelectedRow({
  id,
  locale,
  isLead,
  isFirst,
  isLast,
  disabled,
  onRemove,
  onMoveUp,
  onMoveDown,
}: {
  id: Id<"pages">
  locale: Locale
  isLead: boolean
  isFirst: boolean
  isLast: boolean
  disabled: boolean
  onRemove: () => void
  onMoveUp: () => void
  onMoveDown: () => void
}) {
  const t = useTranslations("editor.relations")
  const card = useQuery(api.cms.relations.getReferenceCard, { id, locale })

  return (
    <li className="flex items-center justify-between gap-3 rounded-md border bg-card p-2.5 text-sm">
      <div className="min-w-0">
        {card ? (
          <>
            <p className="truncate font-medium">
              {isLead && (
                <span className="mr-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-medium tracking-wide text-muted-foreground uppercase">
                  {t("lead")}
                </span>
              )}
              {card.titleFallback === "untitled" ? t("untitled") : card.title}
            </p>
            {card.subtitle && (
              <p className="truncate text-xs text-muted-foreground">
                {card.subtitle}
              </p>
            )}
          </>
        ) : card === null ? (
          <p className="text-xs text-destructive">{t("missing")}</p>
        ) : (
          <p className="text-xs text-muted-foreground">{t("loading")}</p>
        )}
      </div>
      {!disabled && (
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={onMoveUp}
            disabled={isFirst}
            aria-label={t("moveUp")}
            title={t("moveUp")}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ChevronUp className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onMoveDown}
            disabled={isLast}
            aria-label={t("moveDown")}
            title={t("moveDown")}
            className="rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-30"
          >
            <ChevronDown className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onRemove}
            className="ml-1 text-xs text-destructive hover:underline"
          >
            {t("remove")}
          </button>
        </div>
      )}
    </li>
  )
}

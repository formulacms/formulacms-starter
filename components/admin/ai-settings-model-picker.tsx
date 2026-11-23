"use client"

import { useRef, useState } from "react"
import { useLocale, useTranslations } from "next-intl"
import { Check, ChevronsUpDown, Search } from "lucide-react"
import type { FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/** `unavailable`: listed but cannot be chosen (a local tool's Fable row
 * without a Max or Ultra plan, or with the plan not detected). */
export type ModelChoice = NonNullable<FunctionReturnType<typeof api.cms.aiSettings.status>>["assistants"][number]["choices"]["anthropic"][number] & {
  unavailable?: "needsMaxOrUltra" | "needsMaxOrUltraPlanUnknown"
}

/** API services only: when the model lists were last read, and Refresh.
 * `refreshing`: the Refresh call itself is in flight. */
export type ListsUpdated = { at?: number; justUpdated: boolean; refreshing: boolean; onRefresh: () => void }

/** "Updated" only once this provider's list was read again after the owner
 * pressed Refresh: the call only schedules the reads, and a read can still
 * fail. `before` is the list's own time when Refresh was pressed (`null`:
 * never read; `undefined`: Refresh not pressed). Only server times compare. */
export function updatedSinceRefresh(lastSuccessAt: number | undefined, before: number | null | undefined): boolean {
  return before !== undefined && lastSuccessAt !== undefined && (before === null || lastSuccessAt > before)
}

/** "Retires 1 Mar 2027": the retirement day, in UTC. */
export function retireDate(at: number, locale: string) {
  return new Intl.DateTimeFormat(locale === "fr" ? "fr" : "en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(at))
}

/** The muted tag of a model row: why it cannot be chosen, else its retirement day. */
export function ModelTag({ model }: { model: ModelChoice }) {
  const t = useTranslations("settings.aiScreen")
  const locale = useLocale()
  const text = model.unavailable ? t(`picker.unavailable.${model.unavailable}`)
    : model.retiresAt !== undefined ? t("picker.retires", { date: retireDate(model.retiresAt, locale) })
    : undefined
  if (!text) return <span />
  return <span className="shrink-0 rounded-sm border bg-muted px-1.5 py-px text-[10px] leading-4 font-medium text-muted-foreground">{text}</span>
}

/** "Lists updated today at 05:10 · Refresh", then "Updated" after a refresh. */
export function ListsFooter({ lists, className, testId }: { lists: ListsUpdated; className?: string; testId: string }) {
  const t = useTranslations("settings.aiScreen")
  const locale = useLocale()
  function when(at: number) {
    const date = new Date(at)
    return date.toDateString() === new Date().toDateString()
      ? t("picker.todayAt", { time: date.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit", hour12: false }) })
      : date.toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" })
  }
  return (
    <p data-testid={testId} className={cn("text-xs text-muted-foreground", className)}>
      {lists.at !== undefined && <>{t("picker.listsUpdated", { when: when(lists.at) })} · </>}
      {lists.justUpdated ? (
        <span className="inline-flex items-center gap-1 font-medium text-foreground"><Check className="size-3" aria-hidden />{t("picker.updated")}</span>
      ) : (
        <button type="button" className="font-medium text-foreground underline underline-offset-4 disabled:opacity-50" disabled={lists.refreshing} onClick={lists.onRefresh}>{t("picker.refresh")}</button>
      )}
    </p>
  )
}

export function AiSettingsModelPicker({
  taskLabel,
  models,
  value,
  valueName,
  onChange,
  disabled,
  updated,
  describedBy,
}: {
  taskLabel: string
  models: ModelChoice[]
  value: string
  /** The name shown when `models` has no readable name for `value`. */
  valueName?: string
  onChange: (model: string) => void
  disabled: boolean
  /** API services only: the lists footer. */
  updated?: ListsUpdated
  describedBy?: string
}) {
  const t = useTranslations("settings.aiScreen")
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const searchRef = useRef<HTMLInputElement>(null)
  const normalizedQuery = query.trim().toLowerCase()
  const filtered = normalizedQuery
    ? models.filter(
        (model) =>
          model.model.toLowerCase().includes(normalizedQuery) ||
          model.name?.toLowerCase().includes(normalizedQuery)
      )
    : models
  // A saved model the plan no longer offers keeps its versioned name; the list shows no check on it.
  const selected = models.find((model) => model.model === value)

  return (
    <Popover
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen)
        if (!nextOpen) setQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`${taskLabel} ${t("model")}`}
          aria-describedby={describedBy}
          className="flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border bg-background px-3 text-left text-sm transition-colors hover:bg-muted/40"
        >
          <span
            className={cn(
              "min-w-0 truncate",
              !value && "text-muted-foreground"
            )}
          >
            {selected?.name && selected.name !== selected.model
              ? selected.name
              : valueName ?? value}
          </span>
          <ChevronsUpDown className="size-3.5 shrink-0 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(38rem,calc(100vw-2rem))] p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault()
          searchRef.current?.focus()
        }}
      >
        <div className="flex items-center gap-2 border-b px-3">
          <Search className="size-4 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label={t("picker.searchPlaceholder", { count: models.length })}
            placeholder={t("picker.searchPlaceholder", {
              count: models.length,
            })}
            className="h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
          />
        </div>
        <ul className="max-h-80 overflow-y-auto p-1" data-testid="model-list">
          {filtered.map((model) => (
            <li key={model.model}>
              <button
                type="button"
                aria-disabled={model.unavailable ? true : undefined}
                onClick={() => {
                  if (model.unavailable) return
                  onChange(model.model)
                  setOpen(false)
                }}
                className={cn(
                  "grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 rounded-sm px-2 py-2 text-left",
                  model.unavailable ? "cursor-not-allowed" : "hover:bg-muted"
                )}
              >
                <Check
                  className={cn("size-3.5", (value !== model.model || model.unavailable) && "invisible")}
                />
                <span className={cn("min-w-0", model.unavailable && "opacity-50")}>
                  <span className="block truncate text-xs font-medium">
                    {model.name ?? model.model}
                  </span>
                  {model.name && model.name !== model.model && (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {model.model}
                    </span>
                  )}
                </span>
                <ModelTag model={model} />
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("picker.noneMatch", { query })}
            </li>
          )}
        </ul>
        {updated && <ListsFooter lists={updated} testId="lists-updated" className="border-t px-3 py-2" />}
      </PopoverContent>
    </Popover>
  )
}

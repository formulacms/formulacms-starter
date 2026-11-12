"use client"

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronsUpDown, Search } from "lucide-react"
import type { FunctionReturnType } from "convex/server"
import type { api } from "@/convex/_generated/api"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type ModelChoice = FunctionReturnType<typeof api.cms.aiSettings.status>["assistants"][number]["choices"]["anthropic"][number]

export function AiSettingsModelPicker({
  taskLabel,
  models,
  value,
  onChange,
  disabled,
}: {
  taskLabel: string
  models: ModelChoice[]
  value: string
  onChange: (model: string) => void
  disabled: boolean
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
              : value}
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
        <ul className="max-h-80 overflow-y-auto p-1">
          {filtered.map((model) => (
            <li key={model.model}>
              <button
                type="button"
                onClick={() => {
                  onChange(model.model)
                  setOpen(false)
                }}
                className="grid w-full grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-sm px-2 py-2 text-left hover:bg-muted"
              >
                <Check
                  className={cn("size-3.5", value !== model.model && "invisible")}
                />
                <span className="min-w-0">
                  <span className="block truncate text-xs font-medium">
                    {model.name ?? model.model}
                  </span>
                  {model.name && model.name !== model.model && (
                    <span className="block truncate font-mono text-[10px] text-muted-foreground">
                      {model.model}
                    </span>
                  )}
                </span>
              </button>
            </li>
          ))}
          {filtered.length === 0 && (
            <li className="px-3 py-6 text-center text-xs text-muted-foreground">
              {t("picker.noneMatch", { query })}
            </li>
          )}
        </ul>
      </PopoverContent>
    </Popover>
  )
}

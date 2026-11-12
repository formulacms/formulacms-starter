"use client"

import { useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Check, ChevronsUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"
import { languageName } from "./tokens"

/** Lower-case, accent-free text, so "fran" finds "Français". */
function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
}

/**
 * The Add-language picker: the shadcn Popover + search + list pattern
 * (https://ui.shadcn.com/docs/components/radix/combobox), built on the
 * Popover already installed, with the WAI-ARIA combobox-with-listbox
 * keyboard model (https://www.w3.org/WAI/ARIA/apg/patterns/combobox/).
 * The trigger is a button labelled "Language to add"; the search field is
 * the combobox. Typing filters by language name or code; Arrow keys, Home
 * and End move the active option, Enter picks it, Escape closes.
 */
export function LanguagePicker({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string
  options: readonly string[]
  onChange: (code: string) => void
  disabled?: boolean
}) {
  const t = useTranslations("settings.multilingualLanguages")
  const listId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const [active, setActive] = useState(0)
  const needle = fold(query.trim())
  const matches = options.filter(
    (code) =>
      needle === "" ||
      fold(languageName(code)).includes(needle) ||
      fold(code).includes(needle)
  )
  const activeIndex = Math.min(active, Math.max(matches.length - 1, 0))
  const optionId = (code: string) => `${listId}-${code}`

  function move(index: number) {
    if (matches.length === 0) return
    const next = (index + matches.length) % matches.length
    setActive(next)
    document
      .getElementById(optionId(matches[next]!))
      ?.scrollIntoView?.({ block: "nearest" })
  }

  function pick(code: string) {
    onChange(code)
    setOpen(false)
    setQuery("")
    triggerRef.current?.focus()
  }

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setActive(0)
        else setQuery("")
      }}
    >
      <PopoverTrigger asChild>
        <Button
          ref={triggerRef}
          type="button"
          variant="outline"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-label={t("list.addLabel")}
          disabled={disabled}
          className="w-64 justify-between font-normal"
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              setOpen(true)
              setActive(0)
            }
          }}
        >
          <span className={cn(value === "" && "text-muted-foreground")}>
            {value === "" ? t("list.addPlaceholder") : languageName(value)}
          </span>
          <ChevronsUpDown aria-hidden className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64 p-2">
        <input
          type="text"
          role="combobox"
          aria-expanded
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={
            matches.length > 0 ? optionId(matches[activeIndex]!) : undefined
          }
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setActive(0)
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowDown") {
              event.preventDefault()
              move(activeIndex + 1)
            } else if (event.key === "ArrowUp") {
              event.preventDefault()
              move(activeIndex - 1)
            } else if (event.key === "Home") {
              event.preventDefault()
              move(0)
            } else if (event.key === "End") {
              event.preventDefault()
              move(matches.length - 1)
            } else if (event.key === "Enter") {
              event.preventDefault()
              const code = matches[activeIndex]
              if (code !== undefined) pick(code)
            } else if (event.key === "Escape") {
              event.preventDefault()
              setOpen(false)
              setQuery("")
              triggerRef.current?.focus()
            }
          }}
          placeholder={t("list.searchPlaceholder")}
          aria-label={t("list.searchPlaceholder")}
          className="mb-2 h-9 w-full rounded-md border bg-transparent px-3 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <div
          id={listId}
          role="listbox"
          aria-label={t("list.addLabel")}
          className="max-h-60 overflow-y-auto"
        >
          {matches.length === 0 ? (
            <p className="px-2 py-1.5 text-sm text-muted-foreground">
              {t("list.noMatch")}
            </p>
          ) : (
            matches.map((code, index) => (
              // Options are never focused: the search field drives them with
              // the keyboard (aria-activedescendant), so the click handler
              // needs no key listener of its own.
              // eslint-disable-next-line jsx-a11y/click-events-have-key-events
              <div
                key={code}
                id={optionId(code)}
                role="option"
                tabIndex={-1}
                aria-selected={code === value}
                data-active={index === activeIndex ? "true" : undefined}
                className="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm hover:bg-accent data-[active=true]:bg-accent"
                onClick={() => pick(code)}
                onMouseMove={() => setActive(index)}
              >
                <span>{languageName(code)}</span>
                <span className="text-xs text-muted-foreground">{code}</span>
                {code === value && (
                  <Check aria-hidden className="ml-auto size-4" />
                )}
              </div>
            ))
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}

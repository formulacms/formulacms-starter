"use client"

// components/admin/tag-field.tsx
//
// Shared content-tag input. Renders existing tags as removable chips plus an
// inline input with autocomplete suggestions sourced from `api.cms.tags.list`.
// Stores canonical slugs; displays editor-supplied labels (fallback: the slug
// itself). Validation uses the same `normalizeTagSlug` the server runs so the
// client and server agree on what counts as a valid tag.

import { useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { useQuery } from "convex/react"
import { useDebouncedValue } from "@/lib/use-debounced-value"
import { X } from "lucide-react"
import { api } from "@/convex/_generated/api"
import { normalizeTagSlug } from "@/lib/cms/tag-slug"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

const DELIMITERS = [",", "\t", "\n"]

type TagSuggestion = {
  slug: string
  label: string
}

export interface TagFieldProps {
  value: string[]
  onChange: (next: string[]) => void
  maxTags?: number
  placeholder?: string
  id?: string
  disabled?: boolean
}

export function TagField({
  value,
  onChange,
  maxTags,
  placeholder,
  id,
  disabled,
}: TagFieldProps) {
  const t = useTranslations("editor.tags")
  const effectivePlaceholder = placeholder ?? t("placeholder")
  const [input, setInput] = useState("")
  const [focused, setFocused] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // Suggestions: include slug-only search so partial typing matches new
  // candidates and previously-saved tags alike.
  //
  // Debounced because the search term is a query ARGUMENT: every distinct
  // value is a new subscription key, so an undebounced input fired one server
  // execution per keystroke ("javascript" = 10 executions). Every other search
  // input in the admin already debounces at 250ms — this was the outlier.
  const search = useDebouncedValue(input.trim(), 250)
  const suggestions =
    useQuery(api.cms.tags.list, {
      search: search || undefined,
      limit: 8,
    }) ?? []

  // Build the lookup so chips can show labels for slugs the server knows about.
  const labelBySlug = new Map<string, string>()
  for (const s of suggestions) labelBySlug.set(s.slug, s.label)

  const reachedMax = typeof maxTags === "number" && value.length >= maxTags

  const filteredSuggestions = suggestions.filter((s) => !value.includes(s.slug))

  const activeHighlight =
    filteredSuggestions.length > 0
      ? Math.min(highlight, filteredSuggestions.length - 1)
      : 0

  function tryAdd(raw: string) {
    if (reachedMax) return false
    const slug = normalizeTagSlug(raw)
    if (!slug) return false
    if (value.includes(slug)) return false
    onChange([...value, slug])
    return true
  }

  function commitCurrentInput() {
    if (!input.trim()) return
    if (tryAdd(input)) setInput("")
  }

  function commitSuggestion(s: TagSuggestion) {
    if (reachedMax || value.includes(s.slug)) return
    onChange([...value, s.slug])
    setInput("")
    inputRef.current?.focus()
  }

  function removeAt(index: number) {
    const next = value.slice()
    next.splice(index, 1)
    onChange(next)
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (disabled) return
    if (e.key === "Enter") {
      e.preventDefault()
      if (filteredSuggestions[activeHighlight]) {
        commitSuggestion(filteredSuggestions[activeHighlight])
      } else {
        commitCurrentInput()
      }
      return
    }
    if (DELIMITERS.includes(e.key)) {
      e.preventDefault()
      commitCurrentInput()
      return
    }
    if (e.key === "Backspace" && !input && value.length > 0) {
      e.preventDefault()
      removeAt(value.length - 1)
      return
    }
    if (e.key === "ArrowDown" && filteredSuggestions.length > 0) {
      e.preventDefault()
      setHighlight((h) => Math.min(h + 1, filteredSuggestions.length - 1))
      return
    }
    if (e.key === "ArrowUp" && filteredSuggestions.length > 0) {
      e.preventDefault()
      setHighlight((h) => Math.max(h - 1, 0))
      return
    }
    if (e.key === "Escape") {
      setFocused(false)
      inputRef.current?.blur()
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    const text = e.clipboardData.getData("text")
    if (!/[,\t\n]/.test(text)) return
    e.preventDefault()
    const parts = text.split(/[,\t\n]+/)
    let next = value.slice()
    const nextSet = new Set(next)
    for (const part of parts) {
      const slug = normalizeTagSlug(part)
      if (!slug) continue
      if (nextSet.has(slug)) continue
      if (typeof maxTags === "number" && next.length >= maxTags) break
      next = [...next, slug]
      nextSet.add(slug)
    }
    if (next.length !== value.length) onChange(next)
    setInput("")
  }

  // Close the suggestion panel when focus leaves the whole component.
  function handleBlur(e: React.FocusEvent<HTMLDivElement>) {
    if (
      containerRef.current &&
      !containerRef.current.contains(e.relatedTarget)
    ) {
      setFocused(false)
      // Commit any pending text so users don't lose what they typed.
      commitCurrentInput()
    }
  }

  const showSuggestions =
    focused && (filteredSuggestions.length > 0 || (search && !reachedMax))

  return (
    <div ref={containerRef} className="relative" onBlur={handleBlur}>
      {/*
        click-to-focus convenience only; the target `<input>` below is
        already independently keyboard-focusable via Tab.
      */}
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions */}
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 rounded-md border bg-background px-2 py-1.5 text-sm focus-within:ring-1 focus-within:ring-ring",
          disabled && "pointer-events-none opacity-60"
        )}
        onClick={() => inputRef.current?.focus()}
      >
        {value.map((slug, i) => (
          <Badge key={slug} variant="secondary" className="h-6 pr-1 text-xs">
            <span>{labelBySlug.get(slug) ?? slug}</span>
            <button
              type="button"
              aria-label={t("remove", { tag: slug })}
              onClick={(e) => {
                e.stopPropagation()
                removeAt(i)
              }}
              className="ml-1 rounded-sm p-0.5 hover:bg-muted-foreground/10 focus:ring-1 focus:ring-ring focus:outline-none"
            >
              <X className="size-3" />
            </button>
          </Badge>
        ))}
        <input
          ref={inputRef}
          id={id}
          type="text"
          aria-label={t("label")}
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setHighlight(0)
          }}
          onFocus={() => setFocused(true)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          disabled={disabled || reachedMax}
          placeholder={
            value.length === 0 ? effectivePlaceholder : reachedMax ? "" : "+"
          }
          className="min-w-[6rem] flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
        />
      </div>

      {showSuggestions && (
        <div
          className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-sm shadow-md"
          role="listbox"
        >
          {filteredSuggestions.map((s, idx) => (
            <button
              key={s.slug}
              type="button"
              role="option"
              aria-selected={idx === activeHighlight}
              onMouseDown={(e) => {
                // Use mousedown so the click commits before blur fires.
                e.preventDefault()
                commitSuggestion(s)
              }}
              onMouseEnter={() => setHighlight(idx)}
              className={cn(
                "flex w-full cursor-default items-center justify-between rounded-sm px-2 py-1.5 text-left",
                idx === activeHighlight && "bg-accent text-accent-foreground"
              )}
            >
              <span>{s.label}</span>
              <span className="text-xs text-muted-foreground">{s.slug}</span>
            </button>
          ))}
          {(() => {
            const previewSlug = search ? normalizeTagSlug(search) : null
            if (!previewSlug) return null
            if (filteredSuggestions.some((s) => s.slug === previewSlug))
              return null
            return (
              <button
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault()
                  commitCurrentInput()
                }}
                className={cn(
                  "flex w-full cursor-default items-center gap-1 rounded-sm px-2 py-1.5 text-left text-muted-foreground",
                  filteredSuggestions.length === 0 && "text-foreground"
                )}
              >
                <span>{t("create")}</span>
                <span className="font-medium text-foreground">
                  {previewSlug}
                </span>
              </button>
            )
          })()}
        </div>
      )}
    </div>
  )
}

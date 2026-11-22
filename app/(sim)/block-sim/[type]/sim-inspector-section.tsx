"use client"

import { useEffect, useReducer, type ReactNode } from "react"
import { ChevronRight } from "lucide-react"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"

const STORAGE_KEY = "formulacms:simulator:inspector-sections:v1"

function preferences(value: string | null): Record<string, boolean> {
  const parsed: unknown = value ? JSON.parse(value) : null
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
  return Object.fromEntries(
    Object.entries(parsed).filter(([, open]) => typeof open === "boolean")
  )
}

export function SimInspectorSection({
  name,
  label,
  headerExtras,
  children,
  className,
  contentClassName,
}: {
  name: string
  label: string
  headerExtras?: ReactNode
  children: ReactNode
  className?: string
  contentClassName?: string
}) {
  const [open, setOpen] = useReducer((_: boolean, next: boolean) => next, true)

  useEffect(() => {
    let remembered = true
    try {
      remembered =
        preferences(window.localStorage.getItem(STORAGE_KEY))[name] ?? true
    } catch {
      // Browser preferences are optional; every section starts open.
    }
    setOpen(remembered)
  }, [name])

  function changeOpen(next: boolean) {
    setOpen(next)
    try {
      const storage = window.localStorage
      let saved: Record<string, boolean> = {}
      try {
        saved = preferences(storage.getItem(STORAGE_KEY))
      } catch {
        // Replace malformed preferences only after an intentional toggle.
      }
      storage.setItem(STORAGE_KEY, JSON.stringify({ ...saved, [name]: next }))
    } catch {
      // A denied storage getter or write must not disable the disclosure.
    }
  }

  return (
    <Collapsible open={open} onOpenChange={changeOpen} asChild>
      <section
        aria-label={label}
        className={cn("flex flex-col gap-2", className)}
      >
        <div className="flex min-h-7 items-center gap-2">
          <CollapsibleTrigger className="group flex min-h-7 flex-1 items-center gap-1.5 rounded-sm text-left text-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            <ChevronRight
              aria-hidden="true"
              className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90 motion-reduce:transition-none"
            />
            {label}
          </CollapsibleTrigger>
          {headerExtras}
        </div>
        <CollapsibleContent className={contentClassName}>
          {children}
        </CollapsibleContent>
      </section>
    </Collapsible>
  )
}

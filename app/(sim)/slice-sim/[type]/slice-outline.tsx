"use client"

import { useState } from "react"
import { Layers, X } from "lucide-react"
import type { TargetEntry } from "@/lib/slices/flatten-content"
import { Button } from "@/components/ui/button"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import { cn } from "@/lib/utils"
import { SLICE_HIGHLIGHT_EVENT } from "./slice-preview"

/**
 * Collapsible jump navigation for tall slices. The outline yields canvas width
 * on laptops; the active inspector never collapses.
 */
export function SliceOutline({
  entries,
  activePath,
  embedded = false,
  open: controlledOpen,
  onOpenChange,
  onSelectPath,
}: {
  entries: TargetEntry[]
  activePath: string | null
  embedded?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  onSelectPath?: (path: string) => void
}) {
  const [localOpen, setLocalOpen] = useState(false)
  const open = controlledOpen ?? localOpen
  function setOpen(next: boolean) {
    setLocalOpen(next)
    onOpenChange?.(next)
  }
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn("min-w-0", !embedded && "sticky top-12 h-fit")}
    >
      {controlledOpen === undefined && (
        <CollapsibleTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={open ? "Hide Layers" : "Layers"}
            title="Layers"
          >
            <Layers />
          </Button>
        </CollapsibleTrigger>
      )}
      <CollapsibleContent>
        <nav
          aria-label="Block outline"
          className="max-h-[calc(100vh-4rem)] min-w-0 overflow-y-auto rounded-lg border bg-background p-2"
        >
          <div className="flex items-center justify-between pb-2">
            <span className="text-xs font-medium">Layers</span>
            <CollapsibleTrigger asChild>
              <Button variant="ghost" size="icon-sm" aria-label="Hide Layers">
                <X />
              </Button>
            </CollapsibleTrigger>
          </div>
          <ul>
            {entries.map((entry) => (
              <li key={entry.path}>
                <button
                  type="button"
                  aria-current={activePath === entry.path ? "true" : undefined}
                  title={entry.text}
                  data-layer-path={entry.path}
                  onClick={() => {
                    if (onSelectPath) onSelectPath(entry.path)
                    else
                      window.dispatchEvent(
                        new CustomEvent(SLICE_HIGHLIGHT_EVENT, {
                          detail: { path: entry.path, mode: "select" },
                        })
                      )
                  }}
                  className={cn(
                    "block w-full truncate rounded px-2 py-1.5 text-left text-xs",
                    activePath === entry.path
                      ? "bg-muted font-medium text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  {entry.fieldLabel}
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </CollapsibleContent>
    </Collapsible>
  )
}

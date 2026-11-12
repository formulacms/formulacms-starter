"use client"

import { createContext, use, useId, useState } from "react"
import { EyeOff, GripVertical } from "lucide-react"
import { useTranslations } from "next-intl"
import type { MenuFieldError, TargetIntent } from "@/lib/admin/menu/validation"
import { useDragReorder } from "@/lib/use-drag-reorder"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip"

export const MenuValidationContext = createContext({
  attempt: 0,
  errors: [] as MenuFieldError[],
  intents: {} as Record<string, TargetIntent>,
  setIntent: (() => {}) as (key: string, intent: TargetIntent) => void,
})

export function useMenuValidation() {
  return use(MenuValidationContext)
}

export function useErrorExpansion(
  matches: (error: MenuFieldError) => boolean,
  initial = false
) {
  const validation = useMenuValidation()
  const [expanded, setExpanded] = useState(initial)
  const [seen, setSeen] = useState(validation.attempt)
  if (seen !== validation.attempt) {
    setSeen(validation.attempt)
    if (validation.errors.some(matches)) setExpanded(true)
  }
  return [expanded, setExpanded] as const
}

export function EmptyLocaleIcon({ message }: { message: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={message}
          className="absolute top-1/2 right-2 -translate-y-1/2 text-amber-600"
        >
          <EyeOff className="size-4" aria-hidden />
        </button>
      </TooltipTrigger>
      <TooltipContent>{message}</TooltipContent>
    </Tooltip>
  )
}

/** Menu wording around the single shared drag implementation. */
export function useMenuReorder(
  onReorder: (from: number, to: number) => void,
  labels: string[]
) {
  const t = useTranslations("menus.reorder")
  const helpId = useId()
  const drag = useDragReorder(onReorder, {
    count: labels.length,
    announce: (action, from, to) =>
      t(action, {
        label: labels[from] || t("untitled"),
        position: to + 1,
        count: labels.length,
      }),
  })
  return {
    ...drag,
    handle: (index: number) => (
      <button
        type="button"
        {...drag.keyboardHandlers(index)}
        aria-label={t("move", { label: labels[index] || t("untitled") })}
        title={t("move", { label: labels[index] || t("untitled") })}
        aria-describedby={helpId}
        className="shrink-0 cursor-grab touch-none text-muted-foreground active:cursor-grabbing"
      >
        <GripVertical className="size-4" aria-hidden />
      </button>
    ),
    feedback: (
      <>
        <p id={helpId} className="sr-only">
          {t("help")}
        </p>
        <div
          role="status"
          aria-live="polite"
          aria-atomic
          className="sr-only"
        >
          {drag.announcement}
        </div>
      </>
    ),
  }
}

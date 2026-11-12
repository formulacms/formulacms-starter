"use client"

import {
  ArrowDownUp,
  ArrowLeftRight,
  ChevronDown,
  ChevronUp,
  Type,
} from "lucide-react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import {
  TYPOGRAPHY_ROLES,
  type TypographyRole,
} from "@/lib/slices/visual-tweak/capabilities"
import {
  computedTrackingToEm,
  shiftTypographyValue,
  type TypographyProperty,
} from "@/lib/slices/visual-tweak/typography"
import { useVisualTweak } from "./visual-tweak-store"
import type { TargetInfo } from "./slice-preview"

const fields = [
  { property: "font-size", label: "Size", icon: Type },
  { property: "line-height", label: "Line height", icon: ArrowDownUp },
  { property: "letter-spacing", label: "Letter spacing", icon: ArrowLeftRight },
] as const
const display = (value: number) => String(Number(value.toFixed(3)))

export function SimTypographyControls({
  target,
  busy,
  onStep,
}: {
  target: TargetInfo
  busy: boolean
  onStep: (property: TypographyProperty, direction: "up" | "down") => void
}) {
  const { typographyTokens, activeText } = useVisualTweak()
  // Structural headings inside prose keep that binding; S3 adds no role to them.
  const bodyHeading =
    activeText &&
    (activeText.field.contract === "basic" ||
      activeText.field.contract === "full") &&
    activeText.block === "heading"
  if (
    bodyHeading ||
    !target.metrics ||
    !(TYPOGRAPHY_ROLES as readonly string[]).includes(target.role ?? "")
  )
    return null
  const role = target.role as TypographyRole
  const metrics = target.metrics
  const fontSize = Number.parseFloat(metrics.fontSize)
  const tracking = computedTrackingToEm(metrics.letterSpacing ?? "", fontSize)
  const leading = Number.parseFloat(metrics.lineHeight) / fontSize
  const shown = {
    "font-size": Number.isFinite(fontSize)
      ? `${display(fontSize)}px`
      : metrics.fontSize,
    "line-height": Number.isFinite(leading)
      ? display(leading)
      : metrics.lineHeight,
    "letter-spacing":
      tracking === null
        ? (metrics.letterSpacing ?? "—")
        : `${display(tracking)}em`,
  }
  const missing = fields.some(
    ({ property }) => !typographyTokens[role]?.[property]
  )
  return (
    <div className="grid grid-cols-2 gap-2">
      {fields.map(({ property, label, icon: Icon }) => {
        const value = typographyTokens[role]?.[property]
        const supported =
          value &&
          shiftTypographyValue({
            property,
            value,
            delta: 0,
            rootFontSizePx: Number.parseFloat(metrics.rootFontSize ?? ""),
          }).ok
        return (
          <div
            key={property}
            className={property === "letter-spacing" ? "col-span-2" : ""}
          >
            <label
              className="mb-1 block text-[11px] text-muted-foreground"
              htmlFor={`sim-type-${property}`}
            >
              {label}
            </label>
            <div className="flex h-8 items-center rounded-md border bg-input/20 focus-within:ring-1 focus-within:ring-ring">
              <Icon
                aria-hidden="true"
                className="ml-2 size-3.5 shrink-0 text-muted-foreground"
              />
              <Input
                id={`sim-type-${property}`}
                readOnly
                value={shown[property]}
                aria-label={`${label} — site-wide ${role}`}
                title={`${label} — ${role}`}
                disabled={busy || !supported}
                className="h-full min-w-0 rounded-none border-0 bg-transparent px-2 text-xs shadow-none focus-visible:ring-0 dark:bg-transparent"
                onKeyDown={(event) => {
                  if (event.key === "ArrowUp" || event.key === "ArrowDown") {
                    event.preventDefault()
                    onStep(property, event.key === "ArrowUp" ? "up" : "down")
                  }
                }}
              />
              <div className="flex h-full shrink-0 flex-col border-l">
                {(["up", "down"] as const).map((direction) => (
                  <Button
                    key={direction}
                    variant="ghost"
                    size="icon"
                    className="h-4 w-5 rounded-none p-0"
                    aria-label={`${direction === "up" ? "Increase" : "Decrease"} ${label}`}
                    title={`${direction === "up" ? "Increase" : "Decrease"} ${label}`}
                    disabled={busy || !supported}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => onStep(property, direction)}
                  >
                    {direction === "up" ? (
                      <ChevronUp className="size-3" />
                    ) : (
                      <ChevronDown className="size-3" />
                    )}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        )
      })}
      {missing && (
        <p role="alert" className="col-span-2 text-xs text-destructive">
          Typography needs one unambiguous declaration per token in its existing
          editable context.
        </p>
      )}
    </div>
  )
}

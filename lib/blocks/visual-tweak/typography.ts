import type { TypographyRole } from "./capabilities"

/** Shared site-role properties; renderer class edits never persist these. */
export type TypographyProperty = "font-size" | "line-height" | "letter-spacing"

const suffixes = {
  "font-size": "",
  "line-height": "--line-height",
  "letter-spacing": "--letter-spacing",
} as const

export function typographyTokenName(
  role: TypographyRole,
  property: TypographyProperty
): string {
  return `--text-${role}${suffixes[property]}`
}

/** Computed tracking is a px length (or normal), relative to this element. */
export function computedTrackingToEm(
  value: string,
  fontSizePx: number
): number | null {
  if (!Number.isFinite(fontSizePx) || fontSizePx <= 0) return null
  if (value.trim() === "normal") return 0
  const match = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))px$/.exec(value.trim())
  if (!match) return null
  const px = Number(match[1])
  return Number.isFinite(px) ? px / fontSizePx : null
}

export type TypographyShiftResult =
  | { ok: true; value: string }
  | {
      ok: false
      reason:
        | "unsupported-value"
        | "invalid-delta"
        | "invalid-root"
        | "invalid-bounds"
        | "nonpositive-result"
    }

const number = "[+-]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)"
const remValue = new RegExp(`^(${number})rem$`)
const unitlessValue = new RegExp(`^(${number})$`)
const emValue = new RegExp(`^(${number})em$`)
const clampValue = new RegExp(
  `^clamp\\(\\s*(${number})rem\\s*,\\s*(${number})rem\\s*\\+\\s*(\\d+(?:\\.\\d+)?|\\.\\d+)vw\\s*,\\s*(${number})rem\\s*\\)$`
)

function decimal(value: number): string {
  return String(Number(value.toFixed(12)))
}

/**
 * A font-size delta is in preview px, converted with that document's root size.
 * Leading deltas are unitless; tracking deltas are em. Only the current token
 * grammar is supported: never flatten fluid values or rewrite arbitrary CSS.
 */
export function shiftTypographyValue({
  property,
  value,
  delta,
  rootFontSizePx,
  computedLetterSpacing,
  fontSizePx,
}: {
  property: TypographyProperty
  value: string
  delta: number
  rootFontSizePx: number
  computedLetterSpacing?: string
  fontSizePx?: number
}): TypographyShiftResult {
  if (!Number.isFinite(delta)) return { ok: false, reason: "invalid-delta" }
  const raw = value.trim()
  if (property === "letter-spacing" && raw === "inherit") {
    if (delta === 0) return { ok: true, value }
    const start = computedTrackingToEm(
      computedLetterSpacing ?? "",
      fontSizePx ?? NaN
    )
    if (start === null) return { ok: false, reason: "unsupported-value" }
    return shiftTypographyValue({
      property,
      value: `${decimal(start)}em`,
      delta,
      rootFontSizePx,
    })
  }
  if (property !== "font-size") {
    const match = (property === "line-height" ? unitlessValue : emValue).exec(
      raw
    )
    if (!match || !Number.isFinite(Number(match[1])))
      return { ok: false, reason: "unsupported-value" }
    const current = Number(match[1])
    const next = Number(decimal(current + delta))
    if (!Number.isFinite(next)) return { ok: false, reason: "invalid-delta" }
    if (property === "line-height" && (current <= 0 || next <= 0))
      return { ok: false, reason: "nonpositive-result" }
    if (delta === 0) return { ok: true, value }
    const shifted = decimal(next) + (property === "letter-spacing" ? "em" : "")
    if (!(property === "line-height" ? unitlessValue : emValue).test(shifted))
      return { ok: false, reason: "unsupported-value" }
    return { ok: true, value: shifted }
  }
  if (!Number.isFinite(rootFontSizePx) || rootFontSizePx <= 0)
    return { ok: false, reason: "invalid-root" }
  const rem = remValue.exec(raw)
  const clamp = clampValue.exec(raw)
  if (!rem && !clamp) return { ok: false, reason: "unsupported-value" }
  const values = rem
    ? [Number(rem[1])]
    : [Number(clamp![1]), Number(clamp![2]), Number(clamp![4])]
  if (
    values.some((n) => !Number.isFinite(n)) ||
    (clamp && !Number.isFinite(Number(clamp[3])))
  )
    return { ok: false, reason: "unsupported-value" }
  if (clamp && values[0] > values[2])
    return { ok: false, reason: "invalid-bounds" }
  const next = values.map((n) => Number(decimal(n + delta / rootFontSizePx)))
  if (next.some((n) => !Number.isFinite(n)))
    return { ok: false, reason: "invalid-delta" }
  if (
    values[0] <= 0 ||
    next[0] <= 0 ||
    (clamp && (values[2] <= 0 || next[2] <= 0))
  )
    return { ok: false, reason: "nonpositive-result" }
  if (delta === 0) return { ok: true, value }
  const shifted = rem
    ? `${decimal(next[0])}rem`
    : `clamp(${decimal(next[0])}rem, ${decimal(next[1])}rem + ${clamp![3]}vw, ${decimal(next[2])}rem)`
  if (!(rem ? remValue : clampValue).test(shifted))
    return { ok: false, reason: "unsupported-value" }
  return { ok: true, value: shifted }
}

export type TypographyPreviewEdits = Partial<
  Record<
    TypographyRole,
    Partial<Record<TypographyProperty, { before: string; after: string }>>
  >
>

export type TypographyStep = {
  role: TypographyRole
  property: TypographyProperty
  initialValue: string
  computedLetterSpacing?: string
  fontSizePx?: number
  delta: number
  rootFontSizePx: number
}

export type TypographyTokenValues = Partial<Record<TypographyRole, Partial<Record<TypographyProperty, string>>>>

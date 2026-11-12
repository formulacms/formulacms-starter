import type { useFormatter } from "next-intl"

type Formatter = ReturnType<typeof useFormatter>

// Preserve the existing local host/browser time zone. next-intl supplies the
// effective interface locale, while the old toLocale* calls supplied neither.
export function formatLocalDate(
  format: Formatter,
  value: Date | number
): string {
  return format.dateTime(value, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

export function formatLocalDateTime(
  format: Formatter,
  value: Date | number
): string {
  return format.dateTime(value, {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    second: "numeric",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  })
}

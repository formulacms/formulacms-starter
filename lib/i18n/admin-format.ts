export function formatMediaBytes(
  bytes: number,
  locale: string,
  translate: (
    key: "bytes" | "kilobytes" | "megabytes",
    values: { value: string }
  ) => string
): string {
  const key =
    bytes < 1024 ? "bytes" : bytes < 1024 * 1024 ? "kilobytes" : "megabytes"
  const value =
    key === "bytes"
      ? bytes
      : key === "kilobytes"
        ? bytes / 1024
        : bytes / (1024 * 1024)
  return translate(key, {
    value: new Intl.NumberFormat(locale, {
      minimumFractionDigits: key === "bytes" ? 0 : 1,
      maximumFractionDigits: key === "bytes" ? 0 : 1,
    }).format(value),
  })
}

export function formatScheduleTime(locale: string, value?: number) {
  if (!value) return ""
  return new Date(value).toLocaleString(locale, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  })
}

export function formatTranslationCount(translated: number, total: number) {
  return `${translated}/${total}`
}

import { getPublicMessages } from "@/lib/i18n/public-messages"

/** Public byline: preserve author names, cap named authors at three. */
export function formatBylineNames(names: string[], locale = "en"): string {
  if (names.length === 0) return ""
  const messages = getPublicMessages(locale).chrome
  const parts = names.slice(0, 3)
  if (names.length > 3) {
    const others = names.length - 3
    const word =
      new Intl.PluralRules(locale).select(others) === "one"
        ? messages.other
        : messages.others
    parts.push(`${new Intl.NumberFormat(locale).format(others)} ${word}`)
  }
  return `${messages.by} ${new Intl.ListFormat(locale, { style: "long", type: "conjunction" }).format(parts)}`
}

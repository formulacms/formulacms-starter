import en from "../../messages/admin/en.json"
import fr from "../../messages/admin/fr.json"

const messages = { en, fr } as const

/** The core layout exposes its resolved dictionary locale on <html lang>. */
export function adminMessagesForResolvedLocale(locale: string | null) {
  if (locale === "en" || locale === "fr") return messages[locale]
  throw new Error(
    `Browser verification expected a resolved admin locale of en or fr; <html lang> was ${JSON.stringify(locale)}.`
  )
}

/** D1 fixes Setup to English even when the chosen public language differs. */
export function setupMessagesForResolvedLocale(locale: string | null) {
  if (locale !== "en") {
    throw new Error(
      `Setup must resolve to English under D1; <html lang> was ${JSON.stringify(locale)}.`
    )
  }
  return messages.en
}

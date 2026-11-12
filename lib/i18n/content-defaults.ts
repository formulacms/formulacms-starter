import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"

export type ContentDefaultKey =
  | "button"
  | "menuItem"
  | "recentPosts"
  | "seeAll"
  | "importedPage"
  | "recoveredDraft"

/** Creation-time defaults only; never relabel stored owner content. */
export function getContentDefault(
  locale: string,
  key: ContentDefaultKey
): string {
  const messages = locale === "fr" ? fr : en
  return messages.contentDefaults[key]
}

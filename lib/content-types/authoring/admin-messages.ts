import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { ADMIN_DICTIONARY_LOCALES } from "../../i18n/admin-dictionaries"

// The content-type factory writes and checks a label in every declared admin
// language (lib/i18n/admin-dictionaries.ts), not in whatever files exist.
export { ADMIN_DICTIONARY_LOCALES }

export function adminMessagesPath(locale: string): string {
  return `messages/admin/${locale}.json`
}

/** A declared admin language must have its messages file. */
export async function readAdminMessages(
  root: string,
  locale: string
): Promise<string> {
  const path = adminMessagesPath(locale)
  try {
    return await readFile(join(root, path), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    throw new Error(
      `${path} is missing. The admin language "${locale}" is declared in lib/i18n/admin-dictionaries.ts; add the file or remove the language there.`
    )
  }
}

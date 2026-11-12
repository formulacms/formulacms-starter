import { describe, expect, test } from "vitest"
import en from "../messages/admin/en.json"
import fr from "../messages/admin/fr.json"

// Every shipped admin locale must carry the reviewed M05, Menus, dialog,
// editor-tab and checklist messages with identical placeholders.
const SHIPPED_NAMESPACES = [
  ["settings", "multilingualLanguages"],
  ["menus"],
  ["common"],
  ["editor", "page", "tabs"],
  ["editor", "prePublish"],
  ["editor", "designSystem", "publicFont"],
  ["editor", "pageSave"],
  ["slices"],
] as const

// Owner wording (2026-11-05): "Les données sont archivées. Pour les restaurer,
// activez la langue supprimée." French may omit English values for this key.
const FRENCH_PLACEHOLDER_SUBSET_KEYS = new Set([
  "settings.multilingualLanguages.remove.description",
])

function namespace(messages: unknown, path: readonly string[]): unknown {
  return path.reduce<unknown>(
    (value, segment) => (value as Record<string, unknown>)[segment],
    messages
  )
}

function leaves(value: unknown, prefix = ""): Map<string, string> {
  const result = new Map<string, string>()
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (typeof child === "string") result.set(`${prefix}${key}`, child)
    else
      for (const entry of leaves(child, `${prefix}${key}.`))
        result.set(...entry)
  }
  return result
}

function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)/g)].map((match) => match[1]!).toSorted()
}

describe("shipped admin messages", () => {
  for (const path of SHIPPED_NAMESPACES) {
    test(`French carries every ${path.join(".")} key with the same placeholders`, () => {
      const english = leaves(namespace(en, path))
      const french = leaves(namespace(fr, path))

      expect([...french.keys()].toSorted()).toEqual(
        [...english.keys()].toSorted()
      )
      for (const [key, text] of english) {
        if (FRENCH_PLACEHOLDER_SUBSET_KEYS.has([...path, key].join("."))) {
          expect(placeholders(text), key).toEqual(
            expect.arrayContaining(placeholders(french.get(key) ?? ""))
          )
          continue
        }
        expect(placeholders(french.get(key) ?? ""), key).toEqual(
          placeholders(text)
        )
      }
    })
  }
})

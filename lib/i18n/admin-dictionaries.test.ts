/// <reference types="vite/client" />

import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "../../messages/admin/en.json"
import fr from "../../messages/admin/fr.json"
import {
  ADMIN_DICTIONARY_LOCALES,
  hasAdminDictionary,
  unsetAdminLocaleFor,
} from "./admin-dictionaries"

// F09 contract proof row 27 (admin side): an unset admin preference follows
// the site language only when that language has an admin dictionary.

const mocks = vi.hoisted(() => ({
  fetchAuthQuery: vi.fn(),
  getCachedSiteConfig: vi.fn(),
}))

vi.mock("@/lib/auth-server", () => ({ fetchAuthQuery: mocks.fetchAuthQuery }))
vi.mock("./site-config", () => ({
  getCachedSiteConfig: mocks.getCachedSiteConfig,
}))

const dictionaryFiles = import.meta.glob("../../messages/admin/*.json")

function messageLeaves(
  value: Record<string, unknown>,
  prefix = ""
): Map<string, string> {
  const result = new Map<string, string>()
  for (const [key, child] of Object.entries(value)) {
    const path = prefix ? `${prefix}.${key}` : key
    if (typeof child === "string") {
      result.set(path, child)
    } else if (child && typeof child === "object" && !Array.isArray(child)) {
      for (const [nestedPath, nestedValue] of messageLeaves(
        child as Record<string, unknown>,
        path
      )) {
        result.set(nestedPath, nestedValue)
      }
    }
  }
  return result
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe("admin dictionaries", () => {
  test("the dictionary list equals the shipped messages/admin files", () => {
    const shipped = Object.keys(dictionaryFiles)
      .map((path) =>
        path
          .split("/")
          .pop()!
          .replace(/\.json$/, "")
      )
      .sort()
    expect([...ADMIN_DICTIONARY_LOCALES].sort()).toEqual(shipped)
  })

  test("English and French have identical keys and no empty values", () => {
    const english = messageLeaves(en)
    const french = messageLeaves(fr)

    expect([...french.keys()].toSorted()).toEqual(
      [...english.keys()].toSorted()
    )

    const emptyValues = [...english, ...french]
      .filter(([, value]) => value.trim().length === 0)
      .map(([key]) => key)
      .toSorted()
    expect(emptyValues).toEqual([])
  })

  test("French shipped-admin copy keeps the reviewed register and terms", () => {
    const french = messageLeaves(fr)
    const informalAddress = [...french]
      .filter(([, value]) =>
        /(?:^|[\s’'])(?:tu|ta|tes|toi)(?=$|[\s’'.,!?;:])/iu.test(value)
      )
      .map(([key]) => key)

    expect(informalAddress).toEqual([])

    const reviewedPrefixes = [
      "auth.",
      "commandPalette.",
      "editor.",
      "inventory.",
      "menus.",
      "pages.list.",
      "pages.newForm.",
      "setup.",
      "shell.",
    ]
    const exposedJargon = [...french]
      .filter(([key, value]) => {
        if (!reviewedPrefixes.some((prefix) => key.startsWith(prefix))) {
          return false
        }
        const renderedValue = value.replace(
          /\{(?:locale|prefix|slug)\}/g,
          ""
        )
        return /(?:target=_blank|noopener|noreferrer|\bUGC\b|moteur de rendu|cycle de vie|autorité de publication|\bslugs?\b|\bstatuts?\b)/iu.test(
          renderedValue
        )
      })
      .map(([key]) => key)

    expect(exposedJargon).toEqual([])
    expect(french.get("inventory.archive.noSlug")).toBe(
      "Aucun identifiant d’URL"
    )
    expect(french.get("editor.settings.slug")).toBe("Identifiant d’URL")
    expect(french.get("inventory.contentTypes.fieldLabels.metaTitle")).toBe(
      "Titre pour les moteurs de recherche"
    )
    expect(french.get("editor.seo.metaTitle")).toBe(
      "Titre pour les moteurs de recherche"
    )
  })

  test("unset preference follows a site language with a dictionary, else English", () => {
    expect(unsetAdminLocaleFor("fr")).toBe("fr")
    expect(unsetAdminLocaleFor("en")).toBe("en")
    expect(hasAdminDictionary("de")).toBe(false)
    expect(unsetAdminLocaleFor("de")).toBe("en")
    expect(unsetAdminLocaleFor(null)).toBe("en")
  })
})

describe("resolveAdminLocale", () => {
  async function resolve() {
    const { resolveAdminLocale } = await import("./admin-locale")
    return resolveAdminLocale()
  }

  test("a saved French preference wins over an English site", async () => {
    mocks.fetchAuthQuery.mockResolvedValue("fr")
    mocks.getCachedSiteConfig.mockResolvedValue({ defaultLocale: "en" })
    await expect(resolve()).resolves.toBe("fr")
  })

  test("a saved English preference wins over a French site", async () => {
    mocks.fetchAuthQuery.mockResolvedValue("en")
    mocks.getCachedSiteConfig.mockResolvedValue({ defaultLocale: "fr" })
    await expect(resolve()).resolves.toBe("en")
  })

  test("unset preference with a French site loads French", async () => {
    mocks.fetchAuthQuery.mockResolvedValue(null)
    mocks.getCachedSiteConfig.mockResolvedValue({ defaultLocale: "fr" })
    await expect(resolve()).resolves.toBe("fr")
  })

  test("unset preference with a German site, which has no dictionary, loads English", async () => {
    mocks.fetchAuthQuery.mockResolvedValue(null)
    mocks.getCachedSiteConfig.mockResolvedValue({ defaultLocale: "de" })
    await expect(resolve()).resolves.toBe("en")
  })

  test.each(["en", "fr", "es"])(
    "an older unsupported saved preference stays effectively English on a %s site",
    async (siteLocale) => {
      mocks.fetchAuthQuery.mockResolvedValue("es")
      mocks.getCachedSiteConfig.mockResolvedValue({ defaultLocale: siteLocale })
      await expect(resolve()).resolves.toBe("en")
      expect(mocks.getCachedSiteConfig).not.toHaveBeenCalled()
    }
  )

  test("an unknown saved preference also stays independent of the site", async () => {
    mocks.fetchAuthQuery.mockResolvedValue("zz")
    mocks.getCachedSiteConfig.mockResolvedValue({ defaultLocale: "fr" })
    await expect(resolve()).resolves.toBe("en")
  })
})

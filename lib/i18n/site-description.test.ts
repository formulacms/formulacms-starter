import { describe, expect, test } from "vitest"
import {
  mergeSiteDescriptions,
  readSiteDescription,
  storeLegacySiteDescription,
  swapSiteDescriptions,
  transitionSiteDescriptionFields,
} from "./site-description"

describe("readSiteDescription", () => {
  const base = { defaultLocale: "en" }

  test("a stored language wins and another language is never used", () => {
    const settings = {
      ...base,
      siteDescriptions: { en: "Hello", fr: "Bonjour" },
    }
    expect(readSiteDescription(settings, "fr")).toBe("Bonjour")
    expect(readSiteDescription(settings, "de")).toBeUndefined()
  })

  test("the legacy value stands in for the default language only", () => {
    const settings = { ...base, siteDescription: "Legacy" }
    expect(readSiteDescription(settings, "en")).toBe("Legacy")
    expect(readSiteDescription(settings, "fr")).toBeUndefined()
  })

  test("a stored key, even an empty one, hides the legacy value", () => {
    const settings = {
      ...base,
      siteDescription: "Legacy",
      siteDescriptions: { en: "" },
    }
    expect(readSiteDescription(settings, "en")).toBeUndefined()
  })

  test("whitespace-only text reads as none; prototype names are not languages", () => {
    expect(
      readSiteDescription({ ...base, siteDescriptions: { en: "  " } }, "en")
    ).toBeUndefined()
    expect(
      readSiteDescription({ ...base, siteDescriptions: {} }, "constructor")
    ).toBe(undefined)
  })
})

describe("storeLegacySiteDescription", () => {
  test("returns nothing when there is no legacy value", () => {
    expect(storeLegacySiteDescription(null, "en")).toEqual({})
    expect(
      storeLegacySiteDescription({ siteDescriptions: { en: "x" } }, "en")
    ).toEqual({})
  })

  test("files the legacy value under the outgoing language and clears it", () => {
    const fields = storeLegacySiteDescription(
      { siteDescription: "Hello", siteDescriptions: { fr: "Bonjour" } },
      "en"
    )
    expect(fields).toEqual({
      siteDescriptions: { fr: "Bonjour", en: "Hello" },
      siteDescription: undefined,
    })
    expect("siteDescription" in fields).toBe(true)
  })

  test("a stored value under that key wins; an empty legacy value just clears", () => {
    expect(
      storeLegacySiteDescription(
        { siteDescription: "Legacy", siteDescriptions: { en: "Stored" } },
        "en"
      ).siteDescriptions
    ).toEqual({ en: "Stored" })
    expect(storeLegacySiteDescription({ siteDescription: " " }, "en")).toEqual({
      siteDescription: undefined,
    })
  })
})

describe("mergeSiteDescriptions", () => {
  test("sets, trims, clears and keeps untouched languages", () => {
    expect(
      mergeSiteDescriptions(
        { siteDescriptions: { en: "Hello", fr: "Bonjour", de: "Hallo" } },
        "en",
        { fr: "  Salut ", en: "" }
      ).siteDescriptions
    ).toEqual({ fr: "Salut", de: "Hallo" })
  })

  test("clearing the last value drops the map; nothing to write adds no field", () => {
    expect(
      mergeSiteDescriptions({ siteDescriptions: { en: "Hello" } }, "en", {
        en: "",
      })
    ).toEqual({ siteDescriptions: undefined })
    expect(mergeSiteDescriptions(null, "en", { en: undefined })).toEqual({})
  })
})

describe("swapSiteDescriptions", () => {
  test("swaps both, moves one, never deletes", () => {
    expect(swapSiteDescriptions({ en: "a", fr: "b" }, "en", "fr")).toEqual({
      en: "b",
      fr: "a",
    })
    expect(swapSiteDescriptions({ en: "a" }, "en", "fr")).toEqual({ fr: "a" })
    expect(swapSiteDescriptions({ fr: "b", de: "c" }, "en", "fr")).toEqual({
      en: "b",
      de: "c",
    })
  })

  test("returns the same map when neither key holds a value", () => {
    const map = { de: "c" }
    expect(swapSiteDescriptions(map, "en", "fr")).toBe(map)
    expect(swapSiteDescriptions(undefined, "en", "fr")).toBeUndefined()
  })
})

describe("transitionSiteDescriptionFields", () => {
  const settings = {
    siteDescription: "Hello",
    siteDescriptions: { fr: "Bonjour" },
  }

  test("a relabel stores the legacy value first, then swaps", () => {
    expect(transitionSiteDescriptionFields(settings, "en", "fr", true)).toEqual(
      {
        siteDescriptions: { en: "Bonjour", fr: "Hello" },
        siteDescription: undefined,
      }
    )
  })

  test("without a swap each value keeps its own key", () => {
    expect(
      transitionSiteDescriptionFields(settings, "en", "fr", false)
    ).toEqual({
      siteDescriptions: { en: "Hello", fr: "Bonjour" },
      siteDescription: undefined,
    })
  })
})

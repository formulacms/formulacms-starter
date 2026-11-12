import { describe, expect, test } from "vitest"
import en from "../../messages/admin/en.json"
import fr from "../../messages/admin/fr.json"
import {
  adminMessagesForResolvedLocale,
  setupMessagesForResolvedLocale,
} from "./browser-admin-messages"

describe("shipped browser admin expectations", () => {
  test("selects the dictionary named by the resolved page locale", () => {
    expect(adminMessagesForResolvedLocale("en")).toBe(en)
    expect(adminMessagesForResolvedLocale("fr")).toBe(fr)
  })

  test("requires the layout to have resolved unsupported locales to English", () => {
    expect(() => adminMessagesForResolvedLocale("es")).toThrow(
      "expected a resolved admin locale of en or fr"
    )
    expect(() => adminMessagesForResolvedLocale(null)).toThrow(
      "expected a resolved admin locale of en or fr"
    )
  })

  test("accepts only English on Setup under D1", () => {
    expect(setupMessagesForResolvedLocale("en")).toBe(en)
    expect(() => setupMessagesForResolvedLocale("fr")).toThrow(
      "Setup must resolve to English under D1"
    )
  })
})

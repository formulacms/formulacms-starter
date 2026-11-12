import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "../messages/admin/en.json"
import fr from "../messages/admin/fr.json"

const mocks = vi.hoisted(() => ({ resolveAdminLocale: vi.fn() }))

vi.mock("next-intl/server", () => ({
  getRequestConfig: <T>(create: T) => create,
}))
vi.mock("@/lib/i18n/admin-locale", () => ({
  resolveAdminLocale: mocks.resolveAdminLocale,
}))

async function requestConfig() {
  const { default: create } = await import("./request")
  return (create as unknown as () => Promise<{ locale: string; messages: unknown }>)()
}

beforeEach(() => {
  mocks.resolveAdminLocale.mockReset()
})

describe("admin request config", () => {
  test("loads the French admin dictionary", async () => {
    mocks.resolveAdminLocale.mockResolvedValue("fr")
    await expect(requestConfig()).resolves.toMatchObject({ locale: "fr", messages: fr })
  })

  test("a language without an admin dictionary loads English locale and messages", async () => {
    mocks.resolveAdminLocale.mockResolvedValue("de")
    await expect(requestConfig()).resolves.toMatchObject({ locale: "en", messages: en })
  })

  test("a failed locale lookup falls back to English", async () => {
    mocks.resolveAdminLocale.mockRejectedValue(new Error("offline"))
    await expect(requestConfig()).resolves.toMatchObject({ locale: "en", messages: en })
  })
})

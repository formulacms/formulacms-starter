import { cleanup, render, screen } from "@testing-library/react"
import { createFormatter, createTranslator } from "next-intl"
import { beforeEach, expect, test, vi } from "vitest"
import type { ComponentPropsWithRef } from "react"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import Dashboard from "@/app/(core)/admin/(authenticated)/page"
import { formatLocalDate, formatLocalDateTime } from "./local-date-format"
import { PUBLIC_MESSAGES } from "./public-messages"

const state = vi.hoisted(() => ({
  locale: "fr",
  pages: [] as {
    _id: string
    localizedTitles: Record<string, string>
    updatedAt: number
    status: string
    pageType: string
  }[],
  media: [] as unknown[],
}))
vi.mock("next/server", () => ({ connection: async () => {} }))
vi.mock("@/lib/auth-server", () => ({
  fetchAuthQuery: async (ref: unknown) => {
    const { getFunctionName } = await import("convex/server")
    return getFunctionName(ref as never).includes("media")
      ? state.media
      : state.pages
  },
}))
vi.mock("next-intl/server", async () => {
  const { createFormatter, createTranslator } = await import("next-intl")
  const { default: en } = await import("@/messages/admin/en.json")
  const { default: fr } = await import("@/messages/admin/fr.json")
  return {
    getFormatter: async () => createFormatter({ locale: state.locale }),
    getTranslations: async (namespace: string) =>
      createTranslator({
        locale: state.locale,
        messages: state.locale === "fr" ? fr : en,
        namespace: namespace as never,
      }),
  }
})
vi.mock("next/link", () => ({
  default: ({ children, ...props }: ComponentPropsWithRef<"a">) => (
    <a {...props}>{children}</a>
  ),
}))

beforeEach(() => {
  cleanup()
  state.locale = "fr"
  state.pages = []
  state.media = []
})
test("French dashboard groups large counts, localizes badges/default, and preserves custom type identifiers", async () => {
  state.pages = Array.from({ length: 1001 }, (_, i): (typeof state.pages)[number] => ({
    _id: String(i),
    localizedTitles: i === 0 ? {} : { en: "Owner title" },
    pageType: i === 1 ? "custom-content" : "post",
    status: "published",
    updatedAt: 1_800_000_000_000 - i,
  }))
  state.media = Array.from({ length: 1234 })
  render(await Dashboard())
  expect(
    screen.getByText("1 001", { normalizer: (text) => text })
  ).toBeVisible()
  expect(
    screen.getByText("1 234", { normalizer: (text) => text })
  ).toBeVisible()
  expect(screen.getByRole("link", { name: "Sans titre" })).toBeVisible()
  expect(screen.getAllByText("Article")).toHaveLength(9)
  expect(screen.getByText("custom-content")).toBeVisible()
  expect(screen.getAllByText("publié")).toHaveLength(10)
  expect(
    screen.getAllByText(new Date(1_800_000_000_000).toLocaleDateString("fr"))
  ).toHaveLength(10)
})
test("English dashboard compatibility keeps owner content and existing labels", async () => {
  state.locale = "en"
  state.pages = [
    {
      _id: "a",
      localizedTitles: { fr: "Titre propriétaire" },
      updatedAt: 1_800_000_000_000,
      pageType: "author",
      status: "draft",
    },
  ]
  render(await Dashboard())
  expect(screen.getByRole("link", { name: "Titre propriétaire" })).toBeVisible()
  expect(screen.getByText("Author")).toBeVisible()
  expect(screen.getByText("draft")).toBeVisible()
})
test.each(["fr", "en"])(
  "%s effective interface date formats preserve host timezone semantics",
  (locale) => {
    const format = createFormatter({ locale, timeZone: "Pacific/Honolulu" })
    const value = new Date("2026-09-30T00:30:45.000Z")
    expect(formatLocalDate(format, value)).toBe(
      value.toLocaleDateString(locale)
    )
    expect(formatLocalDateTime(format, value)).toBe(
      value.toLocaleString(locale)
    )
  }
)
test.each(["fr", "en"])(
  "%s F09 count grammar and grouping use actual ICU messages without changing counts",
  (locale) => {
    const t = createTranslator({
      locale,
      messages: locale === "fr" ? fr : en,
      namespace: "settings.languages",
    })
    const counts = { pages: 1, ready: 1, undecided: 1, blocked: 1 }
    expect(t("counts", counts)).toBe(
      locale === "fr"
        ? "1 page · 1 prête · 1 à décider · 1 à vérifier"
        : "1 page · 1 ready · 1 needs a decision · 1 needs attention"
    )
    expect(t("counts", { ...counts, pages: 1234 })).toContain(
      locale === "fr" ? "1 234 pages" : "1,234 pages"
    )
    expect(counts).toEqual({ pages: 1, ready: 1, undecided: 1, blocked: 1 })
  }
)
test.each(["fr", "en"])(
  "%s M05 review and migration messages format large counts and singular problems",
  (locale) => {
    const t = createTranslator({
      locale,
      messages: locale === "fr" ? fr : en,
      namespace: "settings.multilingualLanguages",
    })
    expect(
      t("migration.summary", { addresses: 1, collisions: 1234, blockers: 1 })
    ).toBe(
      locale === "fr"
        ? "1 adresse · 1\u202f234 conservées derrière des redirections · 1 problème à corriger"
        : "1 address · 1,234 kept behind redirects · 1 problem to fix"
    )
  }
)
test("all supported public locales retain a complete fixed-copy shape", () => {
  for (const messages of Object.values(PUBLIC_MESSAGES)) {
    expect(Object.keys(messages.chrome)).toEqual(
      Object.keys(PUBLIC_MESSAGES.en.chrome)
    )
    for (const copy of Object.values(messages.chrome))
      expect(copy.trim()).not.toBe("")
  }
})

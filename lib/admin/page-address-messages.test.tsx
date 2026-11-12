import { describe, expect, test } from "vitest"
import { ConvexError } from "convex/values"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import {
  addressSaveRefusal,
  createPageAddressMessages,
  type AddressEntry,
} from "./page-address-messages"
import type { PageAddressCheck } from "@/convex/lib/publishing/snapshots"
import type { Id } from "@/convex/_generated/dataModel"
const check: PageAddressCheck = {
  kind: "taken",
  locale: "en",
  path: "/contact",
  holder: {
    pageId: "holder" as Id<"pages">,
    pageType: "post",
    title: "Contact",
  },
}
function messages(locale: "en" | "fr") {
  const deck = (locale === "en" ? en : fr).pageAddress
  return createPageAddressMessages(
    (key, vars = {}) =>
      deck[key].replace(/\{(\w+)\}/g, (_, key: string) => vars[key] ?? ""),
    locale,
    "en",
    (type) =>
      type === "post" ? (locale === "en" ? "Post" : "Article") : "Page"
  )
}
describe("approved address copy", () => {
  test.each(["en", "fr"] as const)(
    "%s: identifier variants, suffix condition and Save toasts",
    (locale) => {
      const m = messages(locale)
      expect(m.field(check, "page")).toContain(
        locale === "en" ? "“Contact” (Post)" : "« Contact » (Article)"
      )
      expect(m.field(check, "post")).not.toContain(
        locale === "en" ? "(Post)" : "(Article)"
      )
      expect(m.field({ ...check, kind: "free" }, "page")).toBeNull()
      expect(m.field({ ...check, kind: "archived" }, "page")).toContain(
        locale === "en" ? "archived" : "archivée"
      )
      expect(
        m.field({ ...check, kind: "historical", canRedirect: true }, "page")
      ).toContain(locale === "en" ? "still redirects" : "redirige encore")
      expect(
        m.field({ kind: "system", locale: "en", path: "/admin" }, "page")
      ).toContain("formulacms")
      expect(
        m.field(
          { kind: "language", locale: "en", path: "/fr", reservedLocale: "fr" },
          "page"
        )
      ).toContain(locale === "en" ? "French" : "française")
      for (const kind of [
        "taken",
        "archived",
        "historical",
        "system",
        "language",
      ] as const)
        expect(
          m.save(
            new ConvexError({
              code:
                kind === "language"
                  ? "LANGUAGE_LOCALE_PREFIX_RESERVED"
                  : kind === "system"
                    ? "PAGE_ADDRESS_SYSTEM_RESERVED"
                    : `PAGE_ADDRESS_${kind.toUpperCase()}`,
              source: "identifier",
            }),
            "generic"
          )
        ).toBe(locale === "en" ? en.pageAddress.S1f : fr.pageAddress.S1f)
      expect(
        addressSaveRefusal(
          new ConvexError({
            code: "PAGE_PARENT_ADDRESS_TAKEN",
            source: "parent",
          })
        )
      ).toBe("S3t")
    }
  )
  test("creation/history/trash and both publish surfaces consume the approved payloads", () => {
    const m = messages("en"),
      entry: AddressEntry = {
        locale: "en",
        changed: false,
        check: { ...check, kind: "free" },
        allocation: {
          wantedSlug: "contact",
          allocatedSlug: "contact-2",
          newPath: "/contact-2",
          check,
        },
      }
    expect(m.allocation(entry, "S2a", "generic", "page")).toContain(
      "Page created at /contact-2."
    )
    expect(m.allocation(entry, "S2b", null, "page")).toContain(
      "so this page uses /contact-2."
    )
    const notice = {
      locale: "en",
      oldPath: "/contact",
      newPath: "/contact-2",
      check,
    }
    expect(m.restored([notice], "S4", "generic", "A", "page")).toContain(
      "Published version restored to drafts."
    )
    expect(m.restored([notice], "S5", "generic", "A", "page")[0]).toContain(
      "“A” restored as /contact-2"
    )
    for (const c of [
      check,
      { ...check, kind: "historical" as const, canRedirect: true },
      { ...check, kind: "language" as const, reservedLocale: "fr" },
      { ...check, kind: "system" as const },
    ])
      expect(
        m.publish(
          new ConvexError({ ...c, code: "backstop", source: "publish" }),
          "generic",
          "page"
        )
      ).toContain("can’t be published")
    const child = new ConvexError({
      code: "PUBLISHED_CHILD_ROUTE_TAKEN",
      source: "publish",
      locale: "en",
      parentTitle: "Products",
      path: "/shop",
      childTitle: "Cards",
      check,
    })
    expect(m.publish(child, "generic", "page", false)).toBe("generic")
    expect(m.publish(child, "generic", "page", true)).toContain(
      "“Products” can’t be published"
    )
    expect(m.publish(new Error("unrelated"), "generic")).toBe("generic")
  })
})

test("R5 appends a type only to the holder when restored and holder titles match", () => {
  const result = messages("en").restored(
    [{ locale: "en", oldPath: "/contact", newPath: "/contact-2", check }],
    "S5",
    "generic",
    "Contact",
    "page"
  )
  expect(result[0]).toContain("“Contact” restored as")
  expect(result[0]).toContain("used by “Contact” (Post).")
})

test("S5f changes trash quotes only; archive copy is preserved", () => {
  expect(en.inventory.trash.restored).toBe(en.pageAddress.S5f)
  expect(en.inventory.archive.restored).toBe('"{title}" restored')
  expect(fr.inventory.archive.restored).toBe("« {title} » restauré")
})

// The backend omits the notice after rolling back a cross-language History move.
// Both selected-language directions use today's generic toast in either admin locale.
test.each([
  ["en", "en"],
  ["en", "fr"],
  ["fr", "en"],
  ["fr", "fr"],
] as const)(
  "History %s cross-language fallback stays generic in admin %s",
  (_selected, admin) => {
    const fallback =
      admin === "en"
        ? en.editor.page.snapshotHistory.restored
        : fr.editor.page.snapshotHistory.restored
    expect(
      messages(admin).restored(undefined, "S4", fallback, "Page", "page")
    ).toBe(fallback)
  }
)

describe.each(["en", "fr"] as const)(
  "approved addendum in %s admin",
  (admin) => {
    const deck = (admin === "en" ? en : fr).pageAddress
    const m = messages(admin)
    function expected(id: keyof typeof deck, values: Record<string, string>) {
      return deck[id].replace(/\{(\w+)\}/g, (_, key: string) => values[key]!)
    }
    const language =
      admin === "en"
        ? {
            languageName: "French",
            languageNameLower: "français",
            languageAdjective: "française",
          }
        : {
            languageName: "français",
            languageNameLower: "français",
            languageAdjective: "française",
          }
    const suffix = admin === "en" ? " (Post)" : " (Article)"
    const former = { ...check, kind: "historical" as const, canRedirect: false }
    const entry: AddressEntry = { locale: "en", changed: true, check }

    test.each(["S1g", "S6g"] as const)(
      "%s names the former holder on both publish surfaces",
      (id) => {
        const text = expected(id, { path: "/contact", title: "Contact" })
        const withType = text.replace(
          admin === "en" ? "“Contact”" : "« Contact »",
          (title) => title + suffix
        )
        if (id === "S1g") {
          expect(m.field(former, "post")).toBe(text)
          expect(m.field(former, "page")).toBe(withType)
        } else
          for (const editor of [true, false]) {
            const error = new ConvexError({
              ...former,
              code: "PAGE_ADDRESS_HISTORICAL",
              source: "publish",
            })
            expect(m.publish(error, "generic", "post", editor)).toBe(text)
            expect(m.publish(error, "generic", "page", editor)).toBe(withType)
          }
      }
    )
    test.each(["S3r", "S3or"] as const)(
      "%s covers root and former holders with type suffix",
      (id) => {
        const other = id === "S3or"
        const e = {
          ...entry,
          locale: other ? "fr" : "en",
          check: { ...former, locale: other ? "fr" : "en" },
        }
        const text = expected(id, {
          ...language,
          path: other ? "/fr/contact" : "/contact",
          title: "Contact",
        })
        expect(m.parent(e, "en", "post")).toBe(text)
        expect(m.parent(e, "en", "page")).toBe(
          text.replace(
            admin === "en" ? "“Contact”" : "« Contact »",
            (title) => title + suffix
          )
        )
      }
    )
    test.each(["S3rd", "S3re"] as const)(
      "%s uses the path prefix and reservation language without a lead-in",
      (id) => {
        const system = id === "S3rd"
        const e = {
          ...entry,
          locale: "fr",
          check: {
            kind: system ? ("system" as const) : ("language" as const),
            locale: "fr",
            path: system ? "/admin" : "/fr",
            reservedLocale: "fr",
          },
        }
        expect(m.parent(e, "en", "page")).toBe(
          expected(id, { ...language, path: system ? "/fr/admin" : "/fr/fr" })
        )
      }
    )
    test.each(["S2a-d", "S2a-e", "S2b-d", "S2b-e"] as const)(
      "%s describes reserved allocation",
      (id) => {
        const system = id.endsWith("d")
        const path = system ? "/jobs" : "/fr"
        const allocated = {
          ...entry,
          allocation: {
            wantedSlug: path.slice(1),
            allocatedSlug: path.slice(1) + "-2",
            newPath: path + "-2",
            check: {
              kind: system ? ("system" as const) : ("language" as const),
              locale: "en",
              path,
              reservedLocale: "fr",
            },
          },
        }
        expect(
          m.allocation(
            allocated,
            id.startsWith("S2a") ? "S2a" : "S2b",
            "generic",
            "page"
          )
        ).toBe(
          expected(id, { ...language, wantedPath: path, newPath: path + "-2" })
        )
      }
    )
    test("former holders retain S2, S3, S4 and S5; holderless restore retains today's fallback", () => {
      const allocated = {
        ...entry,
        parentTitle: "Services",
        check: former,
        allocation: {
          wantedSlug: "contact",
          allocatedSlug: "contact-2",
          newPath: "/contact-2",
          check: former,
        },
      }
      expect(m.parent(allocated, "en", "page")).toContain("Services")
      for (const kind of ["S2a", "S2b"] as const)
        expect(m.allocation(allocated, kind, "generic", "page")).not.toBe(
          "generic"
        )
      const notice = {
        locale: "en",
        oldPath: "/contact",
        newPath: "/contact-2",
        check: former,
      }
      expect(m.restored([notice], "S4", "generic", "Page", "page")).not.toBe(
        "generic"
      )
      expect(m.restored([notice], "S5", "generic", "Page", "page")[0]).not.toBe(
        "generic"
      )
      const holderless = {
        ...notice,
        check: { kind: "system" as const, locale: "en", path: "/api" },
      }
      expect(m.restored([holderless], "S4", "generic", "Page", "page")).toBe(
        "generic"
      )
      expect(
        m.restored([holderless], "S5", "fallback", "Page", "page")
      ).toEqual(["fallback"])
      expect(
        m.parent(
          { ...entry, parentTitle: "Services", check: holderless.check },
          "en",
          "page"
        )
      ).toBeNull()
    })
  }
)

test("S5 deduplicates holderless fallbacks and keeps a distinct default-language notice first", () => {
  const m = messages("fr")
  const holderless = (locale: string) => ({
    locale,
    oldPath: "/api",
    newPath: "/api-2",
    check: { kind: "system" as const, locale, path: "/api" },
  })
  const fallback = "« API » restauré"
  expect(
    m.restored(
      [holderless("fr"), holderless("en")],
      "S5",
      fallback,
      "API",
      "page"
    )
  ).toEqual([fallback])
  const held = {
    locale: "en",
    oldPath: "/contact",
    newPath: "/contact-2",
    check,
  }
  const results = m.restored(
    [holderless("fr"), held],
    "S5",
    fallback,
    "API",
    "page"
  )
  expect(results).toHaveLength(2)
  expect(results[0]).toContain("/contact-2")
  expect(results[1]).toBe(fallback)
})

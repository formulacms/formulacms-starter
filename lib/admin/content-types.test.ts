import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, test } from "vitest"
import {
  CONTENT_TYPES,
  REGISTERED_CONTENT_TYPES,
  isActiveContentType,
} from "@/convex/lib/contentTypes"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import {
  adminContentTypeDetail,
  adminContentTypePluralMessageKey,
  adminContentTypeSingularMessageKey,
  adminContentTypes,
  menuContentTypeOptionLabel,
  type MenuContentTypeOptionKey,
} from "./content-types"

// A site curates which types it activates, so "the non-routable one" is not a
// fixed slug. The engine has `testimonial`; a starter may activate none, in
// which case there is nothing for this rule to be wrong about.
const nonRoutableType = CONTENT_TYPES.find(
  (type) => adminContentTypeDetail(type)?.routable === false
)

describe("admin content-type projections", () => {
  test("enumerates the active catalog and exposes client-safe detail", () => {
    const summaries = adminContentTypes()
    const page = adminContentTypeDetail("page")

    expect(summaries.map((summary) => summary.type)).toEqual(CONTENT_TYPES)
    expect(page).toMatchObject({ type: "page", routable: true })
    expect(page?.localizedFields).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: "title" })])
    )
    expect(page).not.toHaveProperty("sharedValidator")
  })

  test.runIf(isActiveContentType("author"))("projects the Author path prefix and public shared fields", () => {
    const author = adminContentTypeDetail("author")
    expect(author).toMatchObject({
      type: "author",
      routable: true,
      pathPrefix: "authors",
    })
    expect(author?.sharedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "name",
          exposure: "Shown on the site",
        }),
      ])
    )
    expect(author).not.toHaveProperty("sharedValidator")
  })

  test.skipIf(!nonRoutableType)(
    "renders non-routable active types without inventing a URL",
    () => {
      expect(adminContentTypeDetail(nonRoutableType!)).toMatchObject({
        type: nonRoutableType,
        routable: false,
        pathPrefix: null,
      })
    }
  )

  test("does not expose unknown or registered-but-inactive slugs", () => {
    expect(adminContentTypeDetail("unknown")).toBeNull()
  })
})

describe("menu content-type option labels", () => {
  type OptionMessages = typeof en.menus.items.contentTypeOptions

  function translator(messages: OptionMessages) {
    return (key: MenuContentTypeOptionKey) =>
      messages[key.slice("contentTypeOptions.".length) as keyof OptionMessages]
  }

  test.each([
    ["author", "Authors", "Auteurs"],
    ["job", "Jobs", "Offres d’emploi"],
    ["landing-page", "Landing pages", "Pages d’atterrissage"],
    ["page", "Pages", "Pages"],
    ["post", "Posts", "Articles"],
    ["testimonial", "Testimonials", "Témoignages"],
  ])("shipped type %s keeps its translated label", (type, english, french) => {
    const entry = { type, singular: "Ignored", plural: "Ignored" }
    const enOptions = en.menus.items.contentTypeOptions
    const frOptions = fr.menus.items.contentTypeOptions
    expect(menuContentTypeOptionLabel(entry, translator(enOptions))).toBe(
      english
    )
    expect(menuContentTypeOptionLabel(entry, translator(frOptions))).toBe(
      french
    )
  })

  test("an owner-written type shows its descriptor plural label", () => {
    const entry = { type: "event", singular: "Event", plural: "Events" }
    const enOptions = en.menus.items.contentTypeOptions
    expect(menuContentTypeOptionLabel(entry, translator(enOptions))).toBe(
      "Events"
    )
  })

  test("an owner-written type with no plural label falls back to its label", () => {
    const entry = { type: "event", singular: "Event", plural: "" }
    const enOptions = en.menus.items.contentTypeOptions
    expect(menuContentTypeOptionLabel(entry, translator(enOptions))).toBe(
      "Event"
    )
  })
})

describe("admin content-type message keys", () => {
  const messagesDir = join(process.cwd(), "messages/admin")
  const labelledTypes = readdirSync(messagesDir)
    .filter((file) => file.endsWith(".json"))
    .map((file) => {
      const messages = JSON.parse(
        readFileSync(join(messagesDir, file), "utf8")
      ) as { sidebar: { contentType: Record<string, unknown> } }
      return [file, Object.keys(messages.sidebar.contentType)] as const
    })

  test.each(labelledTypes)(
    "every content type labelled in %s gets typed keys",
    (_file, types) => {
      expect(types.length).toBeGreaterThan(0)
      for (const type of types) {
        expect(adminContentTypeSingularMessageKey(type)).toBe(
          `${type}.singular`
        )
        expect(adminContentTypePluralMessageKey(type)).toBe(`${type}.plural`)
      }
    }
  )

  test("a type with no reviewed copy gets no key", () => {
    const labelled = new Set(labelledTypes.flatMap(([, types]) => types))
    const unlabelled = [
      "unknown",
      ...REGISTERED_CONTENT_TYPES.filter((type) => !labelled.has(type)),
    ]
    for (const type of unlabelled) {
      expect(adminContentTypeSingularMessageKey(type)).toBeNull()
      expect(adminContentTypePluralMessageKey(type)).toBeNull()
    }
  })
})

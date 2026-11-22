import { expectLegacyPanel as legacyPanel } from "@/test-utils/menu-panel"
import { describe, expect, test } from "vitest"
import type { Id } from "@/convex/_generated/dataModel"
import { localizeCanonicalNav } from "@/convex/lib/menu/canonical"
import type { NavItem } from "@/convex/lib/menu"
import {
  mergeLocale,
  projectLocale,
  replaceDefaultLocale,
  withAuthoredAlt,
} from "./locale-projection"

const pageId = "page_target" as Id<"pages">

function canonicalNav(): NavItem[] {
  return [
    {
      id: "services",
      label: { en: "Services", fr: "Services FR" },
      target: { type: "internal", pageId },
      panel: {
        columns: 1,
        sections: [
          {
            id: "featured",
            kind: "featured",
            image: {
              url: "https://example.com/feature.jpg",
              alt: { en: "Feature", fr: "" },
            },
            heading: { en: "Featured" },
            description: { en: "Read more", fr: "En savoir plus" },
            target: { type: "internal", pageId },
          },
        ],
      },
    },
  ]
}

function dynamicNav(): NavItem[] {
  return [
    {
      id: "content",
      label: { en: "Content", fr: "Contenu" },
      panel: {
        columns: 1,
        sections: [
          {
            id: "recent",
            kind: "dynamicList",
            heading: { en: "Recent", fr: "Récent" },
            source: { pageType: "post", limit: 4 },
            seeAll: {
              label: { en: "See all", fr: "Tout voir" },
              target: { type: "internal", pageId },
            },
          },
        ],
      },
    },
  ]
}

describe("canonical menu locale projection", () => {
  test("projects only authored secondary-language text and preserves an intentional empty image alt", () => {
    const projected = projectLocale(canonicalNav(), "fr", "en")

    expect(projected[0]?.label).toBe("Services FR")
    const section = legacyPanel(projected[0]?.panel).sections[0]
    expect(section?.kind).toBe("featured")
    if (section?.kind !== "featured") throw new Error("Expected featured section")
    expect(section.heading).toBe("")
    expect(section.description).toBe("En savoir plus")
    expect(section.image!.alt).toBe("")
  })

  test("keeps missing secondary-language text empty with a Dutch default", () => {
    const projected = projectLocale(
      [
        {
          id: "services",
          label: { nl: "Diensten" },
          panel: {
            columns: 1,
            sections: [
              {
                id: "featured",
                kind: "featured",
                image: {
                  url: "https://example.com/feature.jpg",
                  alt: { nl: "Omslag" },
                },
                heading: { nl: "Uitgelicht" },
                target: { type: "internal", pageId },
              },
            ],
          },
        },
      ],
      "fr",
      "nl"
    )

    expect(projected[0]?.label).toBe("")
    const section = legacyPanel(projected[0]?.panel).sections[0]
    expect(section?.kind).toBe("featured")
    if (section?.kind !== "featured") throw new Error("Expected featured section")
    expect(section.heading).toBe("")
    expect(section.image!.alt).toBe("")
  })

  test("merges one locale's text leaves without changing shared fields or other locale bags", () => {
    const original = canonicalNav()
    const edited = projectLocale(original, "fr", "en")
    edited[0]!.label = "Nos services"
    const editedSection = legacyPanel(edited[0]!.panel!).sections[0]!
    if (editedSection.kind !== "featured") {
      throw new Error("Expected featured section")
    }
    editedSection.heading = "À la une"
    editedSection.description = "Découvrir"
    editedSection.image!.alt = "Présentation"

    const merged = mergeLocale(original, "fr", edited)
    const section = legacyPanel(merged[0]!.panel!).sections[0]!
    if (section.kind !== "featured") throw new Error("Expected featured section")

    expect(merged[0]!.label).toEqual({
      en: "Services",
      fr: "Nos services",
    })
    expect(merged[0]!.target).toEqual(original[0]!.target)
    expect(section.heading).toEqual({ en: "Featured", fr: "À la une" })
    expect(section.description).toEqual({
      en: "Read more",
      fr: "Découvrir",
    })
    expect(section.image).toEqual({
      url: "https://example.com/feature.jpg",
      alt: { en: "Feature", fr: "Présentation" },
    })
  })

  test("omits cleared secondary-language text and preserves authored empty alt", () => {
    const original: NavItem[] = [
      {
        id: "services",
        label: { nl: "Diensten", fr: "Services" },
        panel: {
          columns: 1,
          sections: [
            {
              id: "featured",
              kind: "featured",
              image: {
                url: "https://example.com/feature.jpg",
                alt: { nl: "Omslag", fr: "Image principale" },
              },
              heading: { nl: "Uitgelicht", fr: "À la une" },
              description: { nl: "Lees meer", fr: "En savoir plus" },
              target: { type: "internal", pageId },
            },
          ],
        },
      },
    ]
    const edited = projectLocale(original, "fr", "nl")
    edited[0]!.label = ""
    const editedSection = legacyPanel(edited[0]!.panel!).sections[0]!
    if (editedSection.kind !== "featured") {
      throw new Error("Expected featured section")
    }
    editedSection.heading = ""
    editedSection.description = ""
    editedSection.image!.alt = ""

    const merged = mergeLocale(original, "fr", edited)
    const section = legacyPanel(merged[0]!.panel!).sections[0]!
    if (section.kind !== "featured") throw new Error("Expected featured section")

    expect(merged[0]!.label).toEqual({ nl: "Diensten" })
    expect(section.heading).toEqual({ nl: "Uitgelicht" })
    expect(section.description).toEqual({ nl: "Lees meer" })
    expect(section.image!.alt).toEqual({ nl: "Omslag", fr: "" })
  })

  test("accepts default-locale structure changes while preserving matching translations by stable ID", () => {
    const original = canonicalNav()
    const edited = projectLocale(original, "en", "en")
    edited[0]!.target = {
      type: "external",
      url: "https://example.com/services",
    }
    const featured = legacyPanel(edited[0]!.panel!).sections[0]!
    if (featured.kind !== "featured") throw new Error("Expected featured section")
    featured.heading = "New feature"
    featured.image = {
      url: "https://example.com/new-feature.jpg",
      alt: "New image",
    }
    legacyPanel(edited[0]!.panel!).sections.push({
      id: "new-group",
      kind: "linkGroup",
      heading: "Explore",
      links: [
        {
          id: "new-link",
          label: "Contact",
          target: { type: "internal", pageId },
        },
      ],
    })

    const replaced = replaceDefaultLocale(original, "en", edited)
    const replacedFeatured = legacyPanel(replaced[0]!.panel!).sections[0]!
    if (replacedFeatured.kind !== "featured") {
      throw new Error("Expected featured section")
    }
    const added = legacyPanel(replaced[0]!.panel!).sections[1]!
    if (added.kind !== "linkGroup") throw new Error("Expected link group")

    expect(replaced[0]!.target).toEqual(edited[0]!.target)
    expect(replacedFeatured.heading).toEqual({
      en: "New feature",
    })
    expect(replacedFeatured.image).toEqual({
      url: "https://example.com/new-feature.jpg",
      alt: { en: "New image", fr: "" },
    })
    expect(added.heading).toEqual({ en: "Explore" })
    expect(added.links[0]!.label).toEqual({ en: "Contact" })
  })

  test("round-trips dynamic-list text while preserving its source and see-all target", () => {
    const original = dynamicNav()
    const edited = projectLocale(original, "fr", "en")
    const section = legacyPanel(edited[0]!.panel!).sections[0]!
    if (section.kind !== "dynamicList") throw new Error("Expected dynamic list")
    expect(section).toMatchObject({
      heading: "Récent",
      source: { pageType: "post", limit: 4 },
      seeAll: { label: "Tout voir", target: { type: "internal", pageId } },
    })
    section.heading = "Dernières publications"
    section.seeAll!.label = "Toutes les publications"

    const merged = mergeLocale(original, "fr", edited)
    const mergedSection = legacyPanel(merged[0]!.panel!).sections[0]!
    if (mergedSection.kind !== "dynamicList") {
      throw new Error("Expected dynamic list")
    }
    expect(mergedSection.heading).toEqual({
      en: "Recent",
      fr: "Dernières publications",
    })
    expect(mergedSection.seeAll?.label).toEqual({
      en: "See all",
      fr: "Toutes les publications",
    })
    expect(mergedSection.source).toEqual({ pageType: "post", limit: 4 })
    expect(mergedSection.seeAll?.target).toEqual({ type: "internal", pageId })
  })
})

for (const region of ["main", "footer"] as const) {
  test.each(["existing-empty", "copy-empty", "missing", "cleared", "typed-cleared"] as const)(
    `decorative_alt_survives_secondary_save_and_copy: ${region} %s`,
    (mode) => {
      const nav = canonicalNav()
      const section = legacyPanel(nav[0]!.panel!).sections[0]!
      if (section.kind !== "featured") throw new Error("Expected featured")
      nav[0]!.label = { fr: "Services", en: "Services EN" }
      section.heading = { fr: "Titre", en: "Heading" }
      section.image!.alt = {
        fr: "",
        ...(mode === "existing-empty"
          ? { en: "" }
          : mode === "cleared"
            ? { en: "Authored" }
            : {}),
      }
      if (region === "footer") {
        legacyPanel(nav[0]!.panel!).sections = []
        nav[0]!.panel!.footer = { sections: [section] }
      }
      const projection = projectLocale(
        nav,
        mode === "copy-empty" ? "fr" : "en",
        "fr"
      )
      const edited =
        region === "main"
          ? legacyPanel(projection[0]!.panel!).sections[0]!
          : projection[0]!.panel!.footer!.sections[0]!
      if (edited.kind !== "featured") throw new Error("Expected featured")
      if (mode === "cleared") edited.image!.alt = ""
      if (mode === "typed-cleared") {
        const typed = withAuthoredAlt(edited, "Authored before first save")
        const cleared = withAuthoredAlt({ ...typed }, "")
        Object.assign(edited, { ...cleared, heading: edited.heading })
      }
      projection[0]!.label = "Unrelated edit"
      const merged = mergeLocale(nav, "en", projection)
      const first =
        region === "main"
          ? legacyPanel(merged[0]!.panel!).sections[0]!
          : merged[0]!.panel!.footer!.sections[0]!
      if (first.kind !== "featured") throw new Error("Expected featured")
      expect(Object.hasOwn(first.image!.alt, "en")).toBe(mode !== "missing")
      expect(first.image!.alt.fr).toBe("")
      if (mode !== "missing") expect(first.image!.alt.en).toBe("")
      // Model persistence: editor metadata must not leak to the canonical tree.
      const reloaded: NavItem[] = JSON.parse(JSON.stringify(merged))
      const again = mergeLocale(
        reloaded,
        "en",
        projectLocale(reloaded, "en", "fr")
      )
      expect(again).toEqual(reloaded)
      const publicNav = localizeCanonicalNav(again, "en")
      const sections =
        region === "main"
          ? legacyPanel(publicNav[0]!.panel!).sections
          : publicNav[0]!.panel!.footer!.sections
      expect(sections).toHaveLength(mode === "missing" ? 0 : 1)
      if (mode !== "missing")
        expect(sections?.[0]).toMatchObject({ image: { alt: "" } })
    }
  )
}

test.each(["en", "nl"])("projects absent default %s as blank and never manufactures its alt", (locale) => {
  const original = canonicalNav()
  original[0]!.label = { fr: "Services FR" }
  const section = legacyPanel(original[0]!.panel!).sections[0]!
  if (section.kind !== "featured") throw new Error("Expected featured")
  section.heading = { fr: "À la une" }
  section.image!.alt = { fr: "" }
  const edited = projectLocale(original, locale, locale)
  expect(edited[0]!.label).toBe("")
  const next = replaceDefaultLocale(original, locale, edited)
  expect(next[0]!.label).toEqual({ fr: "Services FR" })
  const saved = legacyPanel(next[0]!.panel!).sections[0]!
  if (saved.kind !== "featured") throw new Error("Expected featured")
  expect(saved.image!.alt).toEqual({ fr: "" })
})

test("blank default optional text stays absent while other-locale optional text survives", () => {
  const original = dynamicNav()
  const draft = projectLocale(original, "en", "en")
  legacyPanel(draft[0]!.panel!).sections[0]!.heading = "  "
  const result = replaceDefaultLocale(original, "en", draft)
  expect(legacyPanel(result[0]!.panel!).sections[0]!.heading).toEqual({ fr: "Récent" })
  const section = legacyPanel(result[0]!.panel!).sections[0]!
  delete section.heading
  const nextDraft = projectLocale(result, "en", "en")
  legacyPanel(nextDraft[0]!.panel!).sections[0]!.heading = ""
  expect(legacyPanel(replaceDefaultLocale(result, "en", nextDraft)[0]!.panel!).sections[0]).not.toHaveProperty("heading")
})

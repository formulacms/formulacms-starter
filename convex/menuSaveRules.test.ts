/// <reference types="vite/client" />

import { expectLegacyPanel as legacyPanel } from "@/test-utils/menu-panel"
import { convexTestWithAuth as convexTest } from "../test-utils/convexAuthFixtures"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import { api } from "./_generated/api"
import schema from "./schema"
import * as languageState from "./lib/language/state"
import { seedCommunityOwner } from "../convexTestWithExplicitAdmin"
import { isColumnPanel, legacyToColumns, menuConversionBaseline, panelSections, walkCanonicalMenuTargets, type PanelSection, type LegacyPanel, type LocaleNavItem, type NavItem } from "./lib/menu"
import {
  validateCanonicalMenu,
  validateCanonicalMenuForLocale,
} from "./lib/menu/validate"
import { targetError } from "../lib/admin/menu/validation"
import { validateCanonicalWrite } from "./lib/menu/canonicalWrite"
import { countMenuNodesMissingText, localizeCanonicalNav, menuTextKey, menuTextLeaves } from "./lib/menu/canonical"
import { menuNodePathsMissingRequiredText } from "./lib/language/defaultMigration"
import {
  mergeLocale,
  projectLocale,
  replaceDefaultLocale,
} from "../lib/admin/menu/locale-projection"

const modules = import.meta.glob("./**/*.ts")
const OWNER = {
  subject: "menu-d1-owner",
  tokenIdentifier: "menu-d1-owner",
}
const target = { type: "external" as const, url: "https://example.com/path" }

function rows(): (Omit<NavItem, "panel"> & {
  panel: Extract<NonNullable<NavItem["panel"]>, { columns: number }>
})[] {
  const sections = (region: string): PanelSection[] => [
    {
      id: `${region}-group`,
      kind: "linkGroup",
      links: [{ id: `${region}-link`, label: { fr: "Lien" }, target }],
    },
    {
      id: `${region}-recent`,
      kind: "dynamicList",
      source: { pageType: "landing-page", limit: 3 },
      seeAll: { label: { fr: "Tout voir" }, target },
    },
    {
      id: `${region}-feature`,
      kind: "featured",
      heading: { fr: "À la une" },
      image: { url: "https://example.com/image.jpg", alt: { fr: "" } },
      target,
    },
  ]
  return [
    {
      id: "menu",
      label: { fr: "Menu" },
      panel: {
        columns: 2,
        sections: sections("panel"),
        footer: { sections: sections("footer") },
      },
    },
  ]
}

async function fixture(nav: NavItem[] = rows(), defaultLocale = "fr") {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, OWNER)
  const ids = await t.run(async (ctx) => ({
    settings: await ctx.db.insert("siteSettings", {
      siteName: "Menus",
      siteUrl: "",
      defaultLocale,
      enabledLocales: ["fr", "en", "nl"],
      updatedAt: 1,
    }),
    menu: await ctx.db.insert("menus", { slug: "primary", nav, updatedAt: 1 }),
  }))
  const owner = t.withIdentity(OWNER)
  const load = () =>
    owner.query(api.cms.menus.getCanonical, { slug: "primary" })
  const effects = () =>
    t.run(async (ctx) => ({
      menus: await ctx.db.query("menus").take(4),
      refs: await ctx.db.query("menuReferences").take(20),
      freshness: await ctx.db.query("siteLanguageFreshness").take(10),
      scheduled: await ctx.db.system.query("_scheduled_functions").take(20),
    }))
  const save = (
    next: NavItem[],
    locale = defaultLocale,
    expectedUpdatedAt?: number | null
  ) =>
    owner.mutation(api.cms.menus.saveCanonical, {
      slug: "primary",
      nav: next,
      locale,
      expectedUpdatedAt,
    })
  return { t, owner, ids, load, effects, save }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe("D1 real menu saves", () => {
  test.each(["default-switch", "removed-language"])(
    "FR-only content remains saveable after %s",
    async (mode) => {
      const f = await fixture()
      await f.t.run((ctx) =>
        ctx.db.patch("siteSettings", f.ids.settings, {
          defaultLocale: "en",
          enabledLocales: mode === "removed-language" ? ["en"] : ["en", "fr"],
        })
      )
      const draft = projectLocale(rows(), "en", "en")
      expect(draft[0]!.label).toBe("")
      const payload = replaceDefaultLocale(rows(), "en", draft)
      await f.save(payload, "en", 1)
      expect((await f.load())!.nav).toEqual(rows())
    }
  )

  test.each(["panel", "footer"])(
    "optional EN add/clear and blank normalization in %s",
    async (region) => {
      const f = await fixture()
      for (const text of ['Read <more> [now] {"plain":true}', "   "]) {
        const canonical = (await f.load())!
        const draft = projectLocale(canonical.nav, "en", "fr")
        const sections =
          region === "panel"
            ? legacyPanel(draft[0]!.panel!).sections
            : draft[0]!.panel!.footer!.sections
        for (const section of sections) {
          if (section.kind === "linkGroup") {
            section.heading = text
            section.links[0]!.description = text
          } else if (section.kind === "dynamicList") section.heading = text
          else section.description = text
        }
        await f.save(
          mergeLocale(canonical.nav, "en", draft),
          "en",
          canonical.updatedAt
        )
        const saved = (await f.load())!.nav
        const leaves = menuTextLeaves(saved).filter(
          (leaf) =>
            leaf.kind === "optional" &&
            (leaf.path.startsWith(`section/${region}-`) ||
              leaf.path.startsWith(`link/${region}-`))
        )
        expect(leaves).toHaveLength(4)
        for (const leaf of leaves)
          expect(leaf.bag).toEqual(text.trim() ? { en: text } : undefined)
        expect(saved[0]!.label).toEqual({ fr: "Menu" })
      }
    }
  )

  test("new dynamic list with the editor's blank heading passes projection through saveCanonical", async () => {
    const f = await fixture([{ id: "menu", label: { fr: "Menu" } }])
    const draft = projectLocale((await f.load())!.nav, "fr", "fr")
    draft[0]!.panel = {
      columns: 1,
      sections: [
        {
          id: "new-list",
          kind: "dynamicList",
          heading: "",
          source: { pageType: "landing-page", limit: 3 },
        },
      ],
    }
    await f.save(
      replaceDefaultLocale((await f.load())!.nav, "fr", draft),
      "fr",
      1
    )
    expect(
      legacyPanel((await f.load())!.nav[0]!.panel!).sections[0]
    ).not.toHaveProperty("heading")
  })

  test("raw optional blanks are removed without changing required text or decorative alt", async () => {
    const nav = rows()
    for (const leaf of menuTextLeaves(nav))
      if (leaf.kind === "optional") leaf.set({ fr: "  ", en: "" })
    const f = await fixture(nav)
    await f.save(nav, "fr", 1)
    expect((await f.load())!.nav).toEqual(rows())
  })

  test("load-save-load preserves eight realistic text shapes and every word", async () => {
    const nav = rows()
    for (const [index, leaf] of menuTextLeaves(nav).entries()) {
      if (leaf.kind === "optional")
        leaf.set({
          fr: `Texte ${index} <b>littéral</b>`,
          en: `Text ${index} [link](plain)`,
        })
    }
    const f = await fixture(nav)
    const before = (await f.load())!
    await f.save(
      replaceDefaultLocale(
        before.nav,
        "fr",
        projectLocale(before.nav, "fr", "fr")
      ),
      "fr",
      before.updatedAt
    )
    expect((await f.load())!.nav).toEqual(before.nav)
    expect(
      menuTextLeaves(before.nav).filter((leaf) => leaf.bag !== undefined).length
    ).toBeGreaterThanOrEqual(8)
  })

  test("invalid text or target refuses before any menu, reference, freshness or scheduler write", async () => {
    const f = await fixture()
    const before = await f.effects()
    const nav = rows()
    nav[0]!.label = { fr: " ", en: "" }
    await expect(f.save(nav, "fr", 1)).rejects.toThrow(/non-blank/)
    const badTarget = rows()
    badTarget[0]!.target = { type: "external", url: "" }
    await expect(f.save(badTarget, "fr", 1)).rejects.toThrow(/URL/)
    expect(await f.effects()).toEqual(before)
  })

  test("restore accepts retained FR-only rows under EN and refuses invalid text before write", async () => {
    const f = await fixture(rows(), "en")
    await f.t.run((ctx) => ctx.db.patch("menus", f.ids.menu, { deletedAt: 2 }))
    await f.owner.mutation(api.cms.menus.restore, { id: f.ids.menu })
    expect((await f.load())!.nav).toEqual(rows())
    await f.t.run((ctx) =>
      ctx.db.patch("menus", f.ids.menu, {
        deletedAt: 3,
        nav: [{ id: "invalid", label: {} }],
      })
    )
    const before = await f.effects()
    await expect(
      f.owner.mutation(api.cms.menus.restore, { id: f.ids.menu })
    ).rejects.toThrow(/non-blank/)
    expect(await f.effects()).toEqual(before)
  })

  test("stale number, null for an existing row and missing-row number refuse without side effects", async () => {
    const f = await fixture()
    for (const token of [0, null]) {
      const before = await f.effects()
      await expect(f.save(rows(), "fr", token)).rejects.toThrow(/changed since/)
      expect(await f.effects()).toEqual(before)
    }
    await f.save(rows(), "fr", 1)
    const latest = (await f.load())!
    expect(latest.updatedAt).toBeGreaterThan(1)
    const before = await f.effects()
    await expect(f.save(rows(), "fr", 1)).rejects.toThrow(/changed since/)
    expect(await f.effects()).toEqual(before)
    await f.save(rows(), "fr", latest.updatedAt)
    expect((await f.load())!.updatedAt).toBeGreaterThan(latest.updatedAt)
    await f.save(rows(), "fr") // Omitted token remains compatible for old callers.
    await expect(
      f.owner.mutation(api.cms.menus.saveCanonical, {
        slug: "footer",
        locale: "fr",
        nav: [],
        expectedUpdatedAt: 1,
      })
    ).rejects.toThrow(/changed since/)
  })

  test.each(["existing-default", "existing-secondary", "first-save"] as const)(
    "stored acknowledgement enables the next save of newer values: %s",
    async (scenario) => {
      vi.setSystemTime(0) // Exercise the monotonic adjustment, not a guessed Date.now().
      const initial: NavItem[] = [
        { id: "item", label: { en: "Original", fr: "Original FR" } },
      ]
      const f = await fixture(initial, "en")
      const slug = scenario === "first-save" ? "footer" : "primary"
      const locale = scenario === "existing-secondary" ? "fr" : "en"
      let token = scenario === "first-save" ? null : 1
      let canonical = scenario === "first-save" ? [] : initial
      for (const label of ["Submitted", "Newer values"]) {
        const draft = projectLocale(
          canonical.length ? canonical : initial,
          locale,
          "en"
        )
        draft[0]!.label = label
        const next =
          locale === "en"
            ? replaceDefaultLocale(canonical, "en", draft)
            : mergeLocale(canonical, locale, draft)
        const saved = await f.owner.mutation(api.cms.menus.saveCanonical, {
          slug,
          locale,
          nav: next,
          expectedUpdatedAt: token,
        })
        const stored = await f.t.run((ctx) => ctx.db.get("menus", saved.id))
        expect(saved).toEqual({ id: stored!._id, updatedAt: stored!.updatedAt })
        if (token !== null) expect(stored!.updatedAt).toBeGreaterThan(token)
        expect(stored!.nav[0]!.label[locale]).toBe(label)
        token = saved.updatedAt
        canonical = stored!.nav
      }
    }
  )

  test("second first-save with a null token is refused under one owner identity", async () => {
    const f = await fixture()
    const first = await f.owner.query(api.cms.menus.getCanonical, {
      slug: "footer",
    })
    const second = await f.owner.query(api.cms.menus.getCanonical, {
      slug: "footer",
    })
    expect(first).toBeNull()
    expect(second).toBeNull()
    const payload = {
      slug: "footer",
      locale: "fr",
      nav: [],
      expectedUpdatedAt: null,
    }
    await f.owner.mutation(api.cms.menus.saveCanonical, payload)
    const before = await f.effects()
    await expect(
      f.owner.mutation(api.cms.menus.saveCanonical, payload)
    ).rejects.toThrow(/changed since/)
    expect(await f.effects()).toEqual(before)
  })
})

describe("D1 class-wide text rules", () => {
  test("every required class rejects blank in all languages; each alt requires an authored key", () => {
    const nav = rows()
    for (const [index, leaf] of menuTextLeaves(nav).entries()) {
      if (leaf.kind === "optional") continue
      const next = rows()
      menuTextLeaves(next)[index]!.set(
        leaf.kind === "alt" ? {} : { fr: " ", en: "" }
      )
      expect(() => validateCanonicalMenu(next), leaf.path).toThrow()
    }
    expect(() => validateCanonicalMenu(rows())).not.toThrow()
  })

  test("dropped other-language bags are protected on every surviving text owner in both regions", () => {
    const nav = rows()
    for (const leaf of menuTextLeaves(nav))
      leaf.set({
        ...(leaf.bag ?? {}),
        en: leaf.kind === "alt" ? "" : "English",
      })
    for (const [index, leaf] of menuTextLeaves(nav).entries()) {
      const next = structuredClone(nav)
      menuTextLeaves(next)[index]!.set(
        leaf.kind === "optional" ? undefined : { fr: "Texte" }
      )
      expect(
        () => validateCanonicalWrite(nav, next, "fr", "fr"),
        leaf.path
      ).toThrow(/preserve translations/)
    }
    expect(() => validateCanonicalWrite(nav, [], "fr", "fr")).not.toThrow()
  })

  test("non-default writes normalize absent and empty optional bags while protecting other languages", () => {
    const before = rows()
    const after = rows()
    for (const leaf of menuTextLeaves(after))
      if (leaf.kind === "optional") leaf.set({ en: "" })
    expect(() =>
      validateCanonicalWrite(before, after, "en", "fr")
    ).not.toThrow()
    expect(() =>
      validateCanonicalWrite(after, before, "en", "fr")
    ).not.toThrow()
    after[0]!.label.fr = "Corrompu"
    expect(() => validateCanonicalWrite(before, after, "en", "fr")).toThrow(
      /another locale/
    )
  })

  test("F09 and retained migration keep strict optional-heading behavior; save does not", () => {
    const nav = rows()
    legacyPanel(nav[0]!.panel!).sections[0]!.heading = { nl: "Groep" }
    expect(() => validateCanonicalMenu(nav)).not.toThrow()
    expect(() => validateCanonicalMenuForLocale(nav, "fr")).toThrow()
    expect(menuNodePathsMissingRequiredText(nav, "fr")).toContain(
      "menu/panel-group"
    )
    expect(() => validateCanonicalMenuForLocale(rows(), "fr")).not.toThrow()
  })
})

function legacyMultiRow(): NavItem[] {
  const nav = rows()
  const panel = legacyPanel(nav[0]!.panel!)
  panel.columns = 3
  panel.sections[0]!.span = 2
  panel.sections.push(
    {
      id: "fourth",
      kind: "linkGroup",
      heading: { fr: "Quatrième" },
      links: [{ id: "fourth-link", label: { fr: "Quatre" }, target }],
    },
    {
      id: "fifth",
      kind: "linkGroup",
      links: [{ id: "fifth-link", label: { fr: "Cinq" }, target }],
    }
  )
  return nav
}

test("R1a legacy multi-row resolver matches the base fixture", async () => {
  const f = await fixture(legacyMultiRow())
  await f.t.run((ctx) =>
    ctx.db.insert("pagePublicationCutover", {
      key: "published-snapshot-v1",
      phase: "legacy",
      revision: 1,
      updatedAt: 1,
    })
  )
  const config = await f.owner.query(api.cms.settings.getSiteConfig, {})
  const resolved = await f.t.query(api.cms.menus.getWithResolvedLinks, {
    slug: "primary",
    locale: "fr",
    languageVersion: config.languageVersion,
  })
  expect(resolved).toEqual({
    nav: [
      {
        id: "menu",
        label: "Menu",
        panel: {
          sections: [
            {
              id: "panel-group",
              kind: "linkGroup",
              links: [
                {
                  id: "panel-link",
                  label: "Lien",
                  target: {
                    type: "external",
                    url: "https://example.com/path",
                  },
                },
              ],
              span: 2,
            },
            {
              id: "panel-recent",
              kind: "dynamicList",
              seeAll: {
                label: "Tout voir",
                target: {
                  type: "external",
                  url: "https://example.com/path",
                },
              },
              source: {
                limit: 3,
                pageType: "landing-page",
              },
            },
            {
              heading: "À la une",
              id: "panel-feature",
              image: {
                alt: "",
                url: "https://example.com/image.jpg",
              },
              kind: "featured",
              target: {
                type: "external",
                url: "https://example.com/path",
              },
            },
            {
              heading: "Quatrième",
              id: "fourth",
              kind: "linkGroup",
              links: [
                {
                  id: "fourth-link",
                  label: "Quatre",
                  target: {
                    type: "external",
                    url: "https://example.com/path",
                  },
                },
              ],
            },
            {
              id: "fifth",
              kind: "linkGroup",
              links: [
                {
                  id: "fifth-link",
                  label: "Cinq",
                  target: {
                    type: "external",
                    url: "https://example.com/path",
                  },
                },
              ],
            },
          ],
          columns: 3,
          footer: {
            sections: [
              {
                id: "footer-group",
                kind: "linkGroup",
                links: [
                  {
                    id: "footer-link",
                    label: "Lien",
                    target: {
                      type: "external",
                      url: "https://example.com/path",
                    },
                  },
                ],
              },
              {
                id: "footer-recent",
                kind: "dynamicList",
                seeAll: {
                  label: "Tout voir",
                  target: {
                    type: "external",
                    url: "https://example.com/path",
                  },
                },
                source: {
                  limit: 3,
                  pageType: "landing-page",
                },
              },
              {
                heading: "À la une",
                id: "footer-feature",
                image: {
                  alt: "",
                  url: "https://example.com/image.jpg",
                },
                kind: "featured",
                target: {
                  type: "external",
                  url: "https://example.com/path",
                },
              },
            ],
          },
        },
      },
    ],
    slug: "primary",
  })
})


function columnRows(): NavItem[] {
  return [
    {
      id: "column-menu",
      label: { fr: "Menu", en: "Menu" },
      target: { type: "placeholder" },
      panel: {
        layout: "columns",
        title: { fr: "Explorer", en: "Explore" },
        description: { fr: "" },
        columns: [
          {
            id: "left",
            sections: [
              {
                id: "column-group",
                kind: "linkGroup",
                heading: { fr: "Liens", en: "Links" },
                links: [
                  {
                    id: "column-link",
                    label: { fr: "Ici", en: "Here" },
                    target: { type: "placeholder" },
                  },
                ],
              },
              {
                id: "column-feature",
                kind: "featured",
                heading: { fr: "À la une", en: "Featured" },
                link: {
                  label: { fr: "Lire", en: "Read" },
                  target: { type: "placeholder" },
                },
              },
            ],
          },
          {
            id: "right",
            sections: [
              {
                id: "column-list",
                kind: "dynamicList",
                source: { pageType: "landing-page", limit: 3 },
                seeAll: {
                  label: { fr: "Tout", en: "All" },
                  target: { type: "placeholder" },
                },
              },
            ],
          },
        ],
        footer: {
          sections: [
            {
              id: "column-footer",
              kind: "featured",
              heading: { fr: "Pied", en: "Footer" },
            },
          ],
        },
      },
    },
  ]
}

function columnPanel(nav: NavItem[]) {
  const panel = nav[0]!.panel!
  if (!("layout" in panel)) throw new Error("Expected column fixture")
  return panel
}

describe("R1a both stored panel shapes", () => {
  test.each(["legacy", "columns"])(
    "%s load-save-load preserves stored content and shape",
    async (shape) => {
      const nav = shape === "legacy" ? rows() : columnRows()
      // Optional blank means absent; this test checks no-op rather than normalization.
      if (shape === "columns") delete columnPanel(nav).description
      const f = await fixture(nav)
      const before = (await f.load())!
      await f.save(before.nav, "fr", before.updatedAt)
      expect(JSON.stringify((await f.load())!.nav)).toBe(
        JSON.stringify(before.nav)
      )
      await f.save(
        mergeLocale(before.nav, "en", projectLocale(before.nav, "en", "fr")),
        "en"
      )
      expect((await f.load())!.nav).toEqual(before.nav)
    }
  )

  test.each([0, 1, 2, 3, 4])("accepts %i columns without widths", (count) => {
    const nav = columnRows()
    columnPanel(nav).columns = Array.from({ length: count }, (_, index) => ({
      id: `col-${index}`,
      sections: [],
    }))
    expect(() => validateCanonicalMenu(nav)).not.toThrow()
  })

  test("refuses more than 4 columns", () => {
    const nav = columnRows()
    columnPanel(nav).columns = Array.from({ length: 5 }, (_, index) => ({
      id: `col-${index}`,
      sections: [],
    }))
    expect(() => validateCanonicalMenu(nav)).toThrow(/at most 4/)
  })

  test("save argument validator refuses a column carrying width without side effects", async () => {
    const nav = columnRows()
    const f = await fixture(nav)
    await f.save(nav, "fr", 1)
    const before = await f.effects()
    Object.assign(columnPanel(nav).columns[0]!, { width: 12 })
    // convex-test reports the enclosing panel union, not its rejected object arm.
    await expect(f.save(nav, "fr")).rejects.toThrow(/Validator error: Expected one of/)
    expect(await f.effects()).toEqual(before)
  })

  test.each(["duplicate column", "blank column", "span", "featured target", "blank Link"])(
    "refuses %s",
    (defect) => {
      const nav = columnRows(),
        panel = columnPanel(nav)
      if (defect === "duplicate column")
        panel.columns[1]!.id = panel.columns[0]!.id
      if (defect === "blank column") panel.columns[0]!.id = " "
      const feature = panel.columns[0]!.sections[1]!
      if (feature.kind !== "featured") throw new Error("fixture")
      if (defect === "span") feature.span = 1
      if (defect === "featured target") feature.target = target
      if (defect === "blank Link") feature.link!.label = { fr: " " }
      expect(() => validateCanonicalMenu(nav)).toThrow()
    }
  )

  test("legacy featured Link refused; absent featured image valid in both shapes", () => {
    const nav = rows(),
      feature = nav[0]!.panel.sections[2]!
    if (feature.kind !== "featured") throw new Error("fixture")
    delete feature.image
    expect(() => validateCanonicalMenu(nav)).not.toThrow()
    expect(() => validateCanonicalMenuForLocale(nav, "fr")).not.toThrow()
    feature.link = { label: { fr: "Lire" }, target }
    expect(() => validateCanonicalMenu(nav)).toThrow(/Legacy/)
    expect(() =>
      validateCanonicalMenuForLocale(columnRows(), "en")
    ).not.toThrow()
  })

  test("placeholder resolves to #, retains label validity, writes no references or page", async () => {
    const nav = columnRows(),
      f = await fixture(nav)
    await f.t.run((ctx) =>
      ctx.db.insert("pagePublicationCutover", {
        key: "published-snapshot-v1",
        phase: "legacy",
        revision: 1,
        updatedAt: 1,
      })
    )
    await f.save(nav, "fr", 1)
    expect((await f.effects()).refs).toEqual([])
    const config = await f.owner.query(api.cms.settings.getSiteConfig, {})
    const resolved = await f.t.query(api.cms.menus.getWithResolvedLinks, {
      slug: "primary",
      locale: "en",
      languageVersion: config.languageVersion,
    })
    expect(resolved?.nav[0]?.target).toEqual({ type: "placeholder", url: "#" })
    const panel = resolved?.nav[0]?.panel
    if (!panel || !("layout" in panel)) throw new Error("Missing column panel")
    expect(panel.columns[0]!.sections).toHaveLength(2)
    expect(panel.columns[0]!.sections[1]).toMatchObject({
      kind: "featured",
      link: { label: "Read", target: { type: "placeholder", url: "#" } },
    })
    nav[0]!.label = {}
    const before = await f.effects()
    await expect(f.save(nav)).rejects.toThrow(/non-blank/)
    expect(await f.effects()).toEqual(before)
  })

  test("columns to legacy refusal preserves the row, references and all side effects", async () => {
    const nav = columnRows(),
      f = await fixture(nav)
    const before = await f.effects()
    await expect(
      f.save([{ ...nav[0]!, panel: { columns: 1, sections: [] } }], "fr", 1)
    ).rejects.toThrow(/reload/)
    expect(await f.effects()).toEqual(before)
  })

  test.each(["legacy to columns", "columns to legacy"])(
    "secondary save refuses %s",
    async (shape) => {
      const legacy = rows(),
        columns = columnRows()
      columns[0]!.id = legacy[0]!.id
      const f = await fixture(shape.startsWith("legacy") ? legacy : columns)
      const before = await f.effects()
      await expect(
        f.save(shape.startsWith("legacy") ? columns : legacy, "en", 1)
      ).rejects.toThrow()
      expect(await f.effects()).toEqual(before)
    }
  )

  test("two-locale missing-text counts omit absent images; Link label is required", async () => {
    const nav = columnRows(),
      feature = columnPanel(nav).columns[0]!.sections[1]!
    if (feature.kind !== "featured") throw new Error("fixture")
    delete feature.link!.label.en
    const f = await fixture(nav)
    expect(
      await f.owner.query(api.cms.menus.countMenuTextMissing, {
        locales: ["fr", "en"],
      })
    ).toEqual({ fr: 0, en: 1 })
    expect(() => validateCanonicalMenuForLocale(nav, "en")).toThrow(
      /default language/
    )
    expect(menuNodePathsMissingRequiredText(nav, "en")).toEqual([
      "column-menu/column-feature",
    ])
  })
})

test("R1a column references include every target-bearing section kind and column IDs", async () => {
  const nav = columnRows(),
    f = await fixture(nav)
  const pageId = await f.t.run((ctx) =>
    ctx.db.insert("pages", {
      slug: "target",
      pageType: "page",
      status: "draft",
      content: {},
      createdAt: 1,
      updatedAt: 1,
    })
  )
  const internalTarget = { type: "internal" as const, pageId }
  const panel = columnPanel(nav)
  for (const col of panel.columns)
    for (const section of col.sections) {
      if (section.kind === "linkGroup") section.links[0]!.target = internalTarget
      if (section.kind === "featured") section.link!.target = internalTarget
      if (section.kind === "dynamicList") section.seeAll!.target = internalTarget
    }
  await f.save(nav, "fr", 1)
  expect((await f.effects()).refs.map((row) => row.path).sort()).toEqual(
    [
      "nav/id:column-menu/panel/columns/id:left/sections/id:column-group/links/id:column-link/target",
      "nav/id:column-menu/panel/columns/id:left/sections/id:column-feature/link/target",
      "nav/id:column-menu/panel/columns/id:right/sections/id:column-list/seeAll/target",
    ].sort()
  )
})

const conversionShapes: {
  name: string
  n: LegacyPanel["columns"]
  spans: (1 | 2 | 3 | 4)[]
  groups: number[][]
}[] = [
  { name: "empty", n: 3, spans: [], groups: [[], [], []] },
  { name: "footer only", n: 2, spans: [], groups: [[], []] },
  {
    name: "one track repeated",
    n: 1,
    spans: [1, 1, 1],
    groups: [[0, 1, 2]],
  },
  {
    name: "single complete row",
    n: 3,
    spans: [2, 1],
    groups: [[0], [1]],
  },
  { name: "single full span", n: 4, spans: [4], groups: [[0]] },
  {
    name: "four equal tracks",
    n: 4,
    spans: [1, 1, 1, 1],
    groups: [[0], [1], [2], [3]],
  },
  {
    name: "incomplete row",
    n: 3,
    spans: [1, 1],
    groups: [[0], [1], []],
  },
  {
    name: "wrap before a wide section",
    n: 3,
    spans: [2, 2, 1],
    groups: [[0, 1], [], [2]],
  },
  {
    name: "o6 Guides Entreprise Nouveautes Services Derniers articles",
    n: 3,
    spans: [1, 1, 1, 2, 1],
    groups: [[0, 3], [1], [2, 4]],
  },
  {
    name: "two complete rows",
    n: 2,
    spans: [1, 1, 1, 1],
    groups: [
      [0, 2],
      [1, 3],
    ],
  },
  {
    name: "wide track then multiple rows",
    n: 4,
    spans: [3, 1, 2, 2, 1],
    groups: [[0, 2, 4], [], [3], [1]],
  },
]

function conversionSection(index: number, region: string): PanelSection {
  const id = `${region}-${index}`
  const heading = { fr: `Titre ${id}`, en: `Heading ${id}`, nl: `Kop ${id}` }
  if (index % 3 === 0)
    return {
      id,
      kind: "linkGroup",
      heading,
      links: [
        {
          id: `${id}-link`,
          label: { fr: "Guides", en: "Guides", nl: "Gidsen" },
          description: {
            fr: "<p>Texte</p>",
            en: "**literal**",
            nl: '{"text":"literal"}',
          },
          target,
        },
      ],
    }
  if (index % 3 === 1)
    return {
      id,
      kind: "dynamicList",
      heading,
      source: { pageType: "page", limit: 3 },
      seeAll: { label: { fr: "Tout", en: "All", nl: "Alles" }, target },
    }
  return {
    id,
    kind: "featured",
    heading,
    description: { fr: "À lire", en: "Read this", nl: "Lees dit" },
    image: {
      url: "https://example.com/image.jpg",
      alt: { fr: "", en: "", nl: "" },
    },
    target,
  }
}

function expectConvertedSection(actual: PanelSection, original: PanelSection) {
  expect(actual.id).toBe(original.id)
  expect(actual).not.toHaveProperty("span")
  // Compare the entire surviving payload, including every locale bag and destination.
  const restored = structuredClone(actual)
  if (original.span !== undefined) restored.span = original.span
  if (
    restored.kind === "featured" &&
    original.kind === "featured" &&
    original.target
  ) {
    expect(restored.link?.label).toEqual(original.heading)
    expect(actual.kind === "featured" && actual.link?.label).not.toBe(
      original.heading
    )
    restored.target = restored.link?.target
    delete restored.link
  }
  expect(restored).toEqual(original)
  const words = (section: PanelSection) =>
    menuTextLeaves([
      { id: "words", label: {}, panel: { columns: 1, sections: [section] } },
    ]).flatMap(({ bag }) =>
      Object.values(bag ?? {}).flatMap((text) => text.match(/\S+/g) ?? [])
    )
  expect(words(restored)).toEqual(words(original))
}

function expectNoWidth(value: unknown) {
  JSON.stringify(value, (key, nested) => {
    expect(key).not.toBe("width")
    return nested
  })
}

test.each(conversionShapes)(
  "R1a legacyToColumns nothing dropped: $name",
  ({ n, spans, groups, name }) => {
    const panel: LegacyPanel = {
      columns: n,
      sections: spans.map((span, index) => ({
        ...conversionSection(index, "panel"),
        span,
      })),
    }
    if (name !== "empty")
      panel.footer = {
        sections: [1, 3, 2].map((span, index) => ({
          ...conversionSection(index, "footer"),
          span: span === 3 ? 3 : span === 2 ? 2 : 1,
        })),
      }
    if (name.startsWith("o6")) {
      const names = [
        "Guides",
        "Entreprise",
        "Nouveautés",
        "Services",
        "Derniers articles",
      ]
      panel.sections.forEach((section, index) => {
        section.heading = {
          fr: names[index]!,
          en: `EN ${names[index]!}`,
          nl: `NL ${names[index]!}`,
        }
      })
    }
    const before = JSON.stringify(panel)
    const converted = legacyToColumns(panel)
    expect(JSON.stringify(panel)).toBe(before)
    expect(legacyToColumns(panel)).toEqual(converted)
    expectNoWidth(converted)
    expect(new Set(converted.columns.map((column) => column.id)).size).toBe(
      groups.length
    )
    expect(
      converted.columns.map((column) => column.sections.map((section) => section.id))
    ).toEqual(groups.map((indices) => indices.map((index) => `panel-${index}`)))
    const convertedSections = converted.columns.flatMap((column) => column.sections)
    expect(convertedSections).toHaveLength(panel.sections.length)
    // Reconstruct approved row order by stable ID; column-major order intentionally changes at o6.
    for (const section of panel.sections) {
      const actual = convertedSections.find(
        (candidate) => candidate.id === section.id
      )
      expect(actual).toBeDefined()
      if (!actual) throw new Error("Dropped panel section")
      expectConvertedSection(actual, section)
    }
    if (panel.footer) {
      expect(converted.footer?.sections.map((section) => section.id)).toEqual(
        panel.footer.sections.map((section) => section.id)
      )
      expect(Object.keys(converted.footer!)).toEqual(["sections"])
      panel.footer.sections.forEach((section, index) =>
        expectConvertedSection(converted.footer!.sections[index]!, section)
      )
    } else expect(converted).not.toHaveProperty("footer")
    expect(() =>
      validateCanonicalMenu([
        { id: "converted", label: { fr: "Menu" }, panel: converted },
      ])
    ).not.toThrow()
  }
)

test("R1a default conversion save rebuilds column references and preserves other locales", async () => {
  const nav = rows()
  for (const leaf of menuTextLeaves(nav))
    if (leaf.bag) {
      leaf.bag.en = `English ${leaf.path}`
      leaf.bag.nl = `Nederlands ${leaf.path}`
    }
  const f = await fixture(nav)
  const pageId = await f.t.run((ctx) =>
    ctx.db.insert("pages", {
      slug: "conversion-target",
      pageType: "page",
      status: "draft",
      content: {},
      createdAt: 1,
      updatedAt: 1,
    })
  )
  const panel = nav[0]!.panel
  for (const { section } of panelSections(panel)) {
    const internalTarget = { type: "internal" as const, pageId }
    if (section.kind === "linkGroup") section.links[0]!.target = internalTarget
    if (section.kind === "dynamicList") section.seeAll!.target = internalTarget
    if (section.kind === "featured") section.target = internalTarget
  }
  await f.save(nav, "fr", 1)
  const loaded = (await f.load())!
  const oldRefs = (await f.effects()).refs
  expect(oldRefs).toHaveLength(6)
  const converted = legacyToColumns(legacyPanel(loaded.nav[0]!.panel))
  const next = [{ ...loaded.nav[0]!, panel: converted }]
  await f.save(next, "fr", loaded.updatedAt)
  expect((await f.load())!.nav).toEqual(next)
  const effects = await f.effects()
  expectNoWidth(effects.menus)
  expect(effects.refs.map((row) => row.path).sort()).toEqual(
    [
      "nav/id:menu/panel/columns/id:column-1/sections/id:panel-group/links/id:panel-link/target",
      "nav/id:menu/panel/columns/id:column-1/sections/id:panel-feature/link/target",
      "nav/id:menu/panel/columns/id:column-2/sections/id:panel-recent/seeAll/target",
      "nav/id:menu/panel/footer/sections/id:footer-group/links/id:footer-link/target",
      "nav/id:menu/panel/footer/sections/id:footer-recent/seeAll/target",
      "nav/id:menu/panel/footer/sections/id:footer-feature/link/target",
    ].sort()
  )
  expect(effects.refs.every((row) => row.targetId === pageId)).toBe(true)
  for (const { section } of panelSections(loaded.nav[0]!.panel)) {
    const saved = panelSections((await f.load())!.nav[0]!.panel).find(
      (entry) => entry.section.id === section.id
    )!.section
    expectConvertedSection(saved, section)
  }
  // Reverse-shape refusal must preserve a NONEMPTY reference set and all effects.
  await expect(f.save(loaded.nav, "fr")).rejects.toThrow(/reload/)
  expect(await f.effects()).toEqual(effects)
})


test.each(["moved link label", "featured Link label", "footer Link label", "omitted image alt"])(
  "R1a conversion still refuses other-locale mutation: %s", async (change) => {
    const nav = rows()
    for (const leaf of menuTextLeaves(nav)) if (leaf.bag) leaf.bag.en = `English ${leaf.path}`
    const f = await fixture(nav)
    const converted = legacyToColumns(nav[0]!.panel)
    const feature = converted.columns[0]!.sections[1]!
    const group = converted.columns[0]!.sections[0]!
    const footerFeature = converted.footer!.sections[2]!
    if (feature.kind !== "featured" || group.kind !== "linkGroup" || footerFeature.kind !== "featured") throw new Error("Fixture shape")
    if (change === "moved link label") group.links[0]!.label.en = "Changed"
    if (change === "featured Link label") feature.link!.label.en = "Changed"
    if (change === "footer Link label") footerFeature.link!.label.en = "Changed"
    if (change === "omitted image alt") delete feature.image!.alt.en
    const before = await f.effects()
    await expect(f.save([{ ...nav[0]!, panel: converted }], "fr", 1)).rejects.toThrow(/preserve translations/)
    expect(await f.effects()).toEqual(before)
  }
)

// R4b exercises our actual editor preparation and mutation, with nonempty refs.
function identityRows(): NavItem[] {
  const nav = columnRows()
  const panel = columnPanel(nav)
  const feature = panel.columns[0]!.sections[1]!
  if (feature.kind !== "featured") throw new Error("Fixture feature")
  feature.image = { url: "https://example.com/card.jpg", alt: { fr: "" } }
  const footerFeature = panel.footer!.sections[0]!
  if (footerFeature.kind !== "featured") throw new Error("Fixture footer")
  footerFeature.link = { label: { fr: "Pied" }, target }
  panel.footer!.sections.push({
    id: "destination-group",
    kind: "linkGroup",
    links: [{ id: "destination-link", label: { fr: "Autre" }, target }],
  })
  nav.push({
    id: "other-item",
    label: { fr: "Autre" },
    panel: {
      layout: "columns",
      columns: [
        { id: "left", sections: [] },
        { id: "right", sections: [] },
      ],
    },
  })
  for (const leaf of menuTextLeaves(nav))
    leaf.set(
      leaf.kind === "alt"
        ? { fr: "", en: "", nl: "" }
        : {
            fr: `Français ${leaf.path}`,
            en: `English ${leaf.path}`,
            nl: `Nederlands ${leaf.path}`,
          }
    )
  return nav
}

function identityPanel(nav: readonly LocaleNavItem[], index = 0) {
  const panel = nav[index]!.panel
  if (!panel || !isColumnPanel(panel)) throw new Error("Fixture columns")
  return panel
}

function identityBags(nav: readonly NavItem[]) {
  return Object.fromEntries(
    menuTextLeaves(nav)
      .filter((leaf) => leaf.bag !== undefined)
      .map((leaf) => [leaf.path, leaf.bag])
  )
}

async function identityFixture(nav = identityRows()) {
  const f = await fixture(nav)
  const pageId = await f.t.run((ctx) =>
    ctx.db.insert("pages", {
      slug: "identity-target",
      pageType: "page",
      status: "draft",
      content: {},
      createdAt: 1,
      updatedAt: 1,
    })
  )
  for (const item of nav)
    for (const { section } of panelSections(item.panel)) {
      const internal = { type: "internal" as const, pageId }
      if (section.kind === "linkGroup")
        for (const link of section.links) link.target = internal
      if (section.kind === "featured" && section.link) section.link.target = internal
      if (section.kind === "featured" && section.target) section.target = internal
      if (section.kind === "dynamicList" && section.seeAll)
        section.seeAll.target = internal
    }
  await f.save(nav, "fr", 1)
  return f
}

const identityMoves = [
  {
    move: "section column A to B",
    old: "columns/id:left/sections/id:column-feature/link/target",
    next: "columns/id:right/sections/id:column-feature/link/target",
  },
  {
    move: "column renamed",
    old: "columns/id:left/sections/id:column-feature/link/target",
    next: "columns/id:renamed/sections/id:column-feature/link/target",
  },
  {
    move: "section panel to footer",
    old: "columns/id:left/sections/id:column-feature/link/target",
    next: "footer/sections/id:column-feature/link/target",
  },
  {
    move: "section footer to panel",
    old: "footer/sections/id:column-footer/link/target",
    next: "columns/id:right/sections/id:column-footer/link/target",
  },
  {
    move: "link to another group",
    old: "columns/id:left/sections/id:column-group/links/id:column-link/target",
    next: "footer/sections/id:destination-group/links/id:column-link/target",
  },
  {
    move: "section to another item",
    old: "columns/id:left/sections/id:column-feature/link/target",
    next: "columns/id:left/sections/id:column-feature/link/target",
    item: "other-item",
  },
] as const

function moveIdentityDraft(draft: LocaleNavItem[], move: string) {
  const panel = identityPanel(draft)
  if (move === "column renamed") {
    panel.columns[0]!.id = "renamed"
    return
  }
  if (move === "link to another group") {
    const group = panel.columns[0]!.sections[0]!
    const other = panel.footer!.sections[1]!
    if (group.kind !== "linkGroup" || other.kind !== "linkGroup")
      throw new Error("Fixture groups")
    other.links.push(group.links.shift()!)
    return
  }
  if (move === "section footer to panel") {
    panel.columns[1]!.sections.push(panel.footer!.sections.shift()!)
    return
  }
  const feature = panel.columns[0]!.sections.splice(1, 1)[0]!
  if (move === "section panel to footer") panel.footer!.sections.push(feature)
  else if (move === "section to another item")
    identityPanel(draft, 1).columns[0]!.sections.push(feature)
  else panel.columns[1]!.sections.push(feature)
}

function movedIdentityPayload(nav: NavItem[], move = "section to another item") {
  const draft = projectLocale(nav, "fr", "fr")
  moveIdentityDraft(draft, move)
  return replaceDefaultLocale(nav, "fr", draft)
}

describe("R4b menu-scoped translation identity", () => {
  test.each([
    { move: "a: featured to another column, original deleted", kind: "featured", sourceFooter: false, column: true, destinationFooter: false, removeOriginal: true },
    { move: "b: featured to another column, original stays legacy", kind: "featured", sourceFooter: false, column: true, destinationFooter: false, removeOriginal: false },
    { move: "c: legacy footer featured to another column footer", kind: "featured", sourceFooter: true, column: true, destinationFooter: true, removeOriginal: false },
    { move: "d: featured to another legacy panel, no seed", kind: "featured", sourceFooter: false, column: false, destinationFooter: false, removeOriginal: false },
    { move: "e: link group to another column, no seed", kind: "linkGroup", sourceFooter: false, column: true, destinationFooter: false, removeOriginal: true },
  ] as const)("cross-item convert-and-move save path: $move", async (scenario) => {
    const nav: NavItem[] = rows()
    const sectionId = `${scenario.sourceFooter ? "footer" : "panel"}-${scenario.kind === "featured" ? "feature" : "group"}`
    panelSections(nav[0]!.panel).find(({ section }) => section.id === sectionId)!.section.span = 2
    nav.push({
      id: "destination-item",
      label: { fr: "Destination" },
      panel: scenario.column
        ? {
            layout: "columns",
            title: { fr: "Titre destination" },
            description: { fr: "Description destination" },
            columns: [{ id: "left", sections: [] }, { id: "right", sections: [] }],
            footer: { sections: [] },
          }
        : { columns: 2, sections: [], footer: { sections: [] } },
    })
    for (const leaf of menuTextLeaves(nav))
      if (leaf.bag) {
        leaf.bag.en = `English ${leaf.path}`
        leaf.bag.nl = `Nederlands ${leaf.path}`
      }
    const f = await identityFixture(nav)
    const before = (await f.load())!
    const snapshot = structuredClone(before.nav)
    const oldEffects = await f.effects()
    expect(oldEffects.refs.length).toBeGreaterThan(0)
    const storedSection = panelSections(before.nav[0]!.panel).find(
      ({ section }) => section.id === sectionId
    )!.section

    // Build the expected full-bag result with the existing converter, independently
    // of the baseline. Then perform the same structural edit on the FR projection.
    const expected = structuredClone(before.nav)
    const expectedSource = legacyPanel(expected[0]!.panel)
    const sourceSections = scenario.sourceFooter ? expectedSource.footer!.sections : expectedSource.sections
    const originalSection = sourceSections.splice(sourceSections.findIndex((section) => section.id === sectionId), 1)[0]!
    const converted = legacyToColumns(legacyPanel(before.nav[0]!.panel))
    const expectedSection = scenario.column
      ? panelSections(converted).find(({ section }) => section.id === sectionId)!.section
      : originalSection
    const expectedDestination = expected[1]!.panel!
    if (scenario.destinationFooter) expectedDestination.footer!.sections.push(expectedSection)
    else if (isColumnPanel(expectedDestination)) expectedDestination.columns[1]!.sections.push(expectedSection)
    else expectedDestination.sections.push(expectedSection)
    if (scenario.removeOriginal) expected.shift()

    const draft = projectLocale(before.nav, "fr", "fr")
    const draftSource = legacyPanel(draft[0]!.panel)
    const draftSections = scenario.sourceFooter ? draftSource.footer!.sections : draftSource.sections
    let moved = draftSections.splice(draftSections.findIndex((section) => section.id === sectionId), 1)[0]!
    if (scenario.column) {
      const projectedConversion = projectLocale([{ ...before.nav[0]!, panel: converted }], "fr", "fr")
      moved = panelSections(projectedConversion[0]!.panel).find(({ section }) => section.id === sectionId)!.section
    }
    const destination = draft[1]!.panel!
    if (scenario.destinationFooter) destination.footer!.sections.push(moved)
    else if (isColumnPanel(destination)) destination.columns[1]!.sections.push(moved)
    else destination.sections.push(moved)
    if (scenario.removeOriginal) draft.shift()
    const draftSnapshot = JSON.stringify(draft)
    const baseline = menuConversionBaseline(before.nav, draft)
    const baselineSnapshot = structuredClone(baseline)
    const next = replaceDefaultLocale(before.nav, "fr", draft)
    expect(identityBags(next)).toEqual(identityBags(expected))
    const savedSection = panelSections(next.find((item) => item.id === "destination-item")!.panel)
      .find(({ section }) => section.id === sectionId)!.section
    const baselineSection = panelSections(baseline[0]!.panel).find(({ section }) => section.id === sectionId)!.section
    if (scenario.column) {
      expect(savedSection.span).toBeUndefined()
      expect(baselineSection.span).toBeUndefined()
    } else expect(baselineSection).toEqual(storedSection)
    if (savedSection.kind === "featured" && storedSection.kind === "featured") {
      if (scenario.column) {
        expect(savedSection.target).toBeUndefined()
        expect(savedSection.link!.target).toEqual(storedSection.target)
        expect(savedSection.link!.label).toEqual(storedSection.heading)
        expect(savedSection.link!.label.en).toBe(storedSection.heading.en)
      } else {
        expect(savedSection.link).toBeUndefined()
        expect(savedSection.target).toEqual(storedSection.target)
        expect(savedSection.span).toBe(2)
      }
    }
    const seededKeys = Object.keys(identityBags(next)).filter((key) => !(key in identityBags(before.nav)))
    expect(seededKeys).toEqual(scenario.column && scenario.kind === "featured" ? [`section/${sectionId}/link/label`] : [])

    for (const change of scenario.column && scenario.kind === "featured" ? ["change seed", "omit seed"] : ["inject or tamper"]) {
      const tampered = structuredClone(next)
      const section = panelSections(tampered.find((item) => item.id === "destination-item")!.panel)
        .find(({ section }) => section.id === sectionId)!.section
      if (section.kind === "featured") {
        if (!scenario.column) section.link = { label: { ...section.heading }, target: section.target! }
        else if (change === "omit seed") delete section.link!.label.en
        else section.link!.label.en = "Tampered seed"
      } else if (section.kind === "linkGroup") section.links[0]!.label.en = "Tampered group"
      await expect(f.save(tampered, "fr", before.updatedAt)).rejects.toThrow(
        /preserve translations|Legacy featured sections cannot have a Link/
      )
      expect(await f.effects()).toEqual(oldEffects)
    }
    await expect(f.save(next, "en", before.updatedAt)).rejects.toThrow(/Non-default menu edits/)
    expect(await f.effects()).toEqual(oldEffects)
    await f.save(next, "fr", before.updatedAt)
    const loaded = (await f.load())!
    expect(loaded.nav).toEqual(next)
    expect(identityBags(loaded.nav)).toEqual(identityBags(expected))
    const newRefs = (await f.effects()).refs
    const oldPath = `nav/id:menu/panel/${scenario.sourceFooter ? "footer/sections" : "sections"}/id:${sectionId}/${scenario.kind === "featured" ? "target" : "links/id:panel-link/target"}`
    const newPath = `nav/id:destination-item/panel/${scenario.destinationFooter ? "footer/sections" : scenario.column ? "columns/id:right/sections" : "sections"}/id:${sectionId}/${scenario.kind === "featured" ? scenario.column ? "link/target" : "target" : "links/id:panel-link/target"}`
    expect(oldEffects.refs.map((ref) => ref.path)).toContain(oldPath)
    expect(newRefs.map((ref) => ref.path)).not.toContain(oldPath)
    expect(newRefs.map((ref) => ref.path)).toContain(newPath)
    expect(newRefs.map((ref) => ({ path: ref.path, targetId: ref.targetId })).sort((a, b) => a.path.localeCompare(b.path))).toEqual(
      walkCanonicalMenuTargets(loaded.nav)
        .map((ref) => ({ path: ref.path, targetId: ref.targetId }))
        .sort((a, b) => a.path.localeCompare(b.path))
    )
    expect(before.nav).toEqual(snapshot)
    expect(JSON.stringify(draft)).toBe(draftSnapshot)
    expect(baseline).toEqual(baselineSnapshot)
  })

  test.each(identityMoves)("move matrix: $move", async (scenario) => {
    const f = await identityFixture()
    const before = (await f.load())!
    const oldRefs = (await f.effects()).refs
    const next = movedIdentityPayload(before.nav, scenario.move)
    expect(identityBags(next)).toEqual(identityBags(before.nav))
    await f.save(next, "fr", before.updatedAt)
    const loaded = (await f.load())!
    expect(loaded.nav).toEqual(next)
    expect(identityBags(loaded.nav)).toEqual(identityBags(before.nav))
    const paths = (await f.effects()).refs.map((ref) => ref.path).sort()
    const oldPath = `nav/id:column-menu/panel/${scenario.old}`
    const newPath = `nav/id:${"item" in scenario ? scenario.item : "column-menu"}/panel/${scenario.next}`
    expect(oldRefs.map((ref) => ref.path)).toContain(oldPath)
    expect(paths).not.toContain(oldPath)
    expect(paths).toContain(newPath)
    expect(paths).toHaveLength(oldRefs.length)
    expect(paths).toEqual(
      walkCanonicalMenuTargets(loaded.nav)
        .map((ref) => ref.path)
        .sort()
    )
  })

  const secondaryFields = menuTextLeaves(identityRows()).map(
    (leaf) => leaf.path
  )
  test.each(
    secondaryFields.flatMap((path) => [
      { path, change: "delete" },
      { path, change: "change" },
    ])
  )(
    "preservation matrix: $change $path refuses atomically after move",
    async ({ path, change }) => {
      const f = await identityFixture()
      const loaded = (await f.load())!
      const next = movedIdentityPayload(loaded.nav)
      const leaf = menuTextLeaves(next).find(
        (candidate) => candidate.path === path
      )!
      const bag = { ...leaf.bag }
      if (change === "delete") delete bag.en
      else bag.en = "Tampered"
      leaf.set(bag)
      const before = await f.effects()
      await expect(f.save(next, "fr", loaded.updatedAt)).rejects.toThrow(
        /preserve translations/
      )
      expect(await f.effects()).toEqual(before)
    }
  )

  test.each(["item", "section", "link"])(
    "whole %s owner deletion succeeds",
    async (owner) => {
      const f = await identityFixture()
      const loaded = (await f.load())!
      const oldRefs = (await f.effects()).refs
      const draft = projectLocale(loaded.nav, "fr", "fr")
      if (owner === "item") draft.shift()
      else if (owner === "section")
        identityPanel(draft).columns[0]!.sections.splice(1, 1)
      else {
        const group = identityPanel(draft).columns[0]!.sections[0]!
        if (group.kind !== "linkGroup") throw new Error("Fixture group")
        group.links = []
      }
      const next = replaceDefaultLocale(loaded.nav, "fr", draft)
      await f.save(next, "fr", loaded.updatedAt)
      expect((await f.load())!.nav).toEqual(next)
      expect((await f.effects()).refs.length).toBeLessThan(oldRefs.length)
    }
  )

  test.each([false, true])(
    "fresh owner cannot inject secondary text (separately deleted=%s)",
    async (deleted) => {
      const f = await identityFixture()
      let loaded = (await f.load())!
      if (deleted) {
        const draft = projectLocale(loaded.nav, "fr", "fr")
        identityPanel(draft).columns[0]!.sections.splice(1, 1)
        await f.save(
          replaceDefaultLocale(loaded.nav, "fr", draft),
          "fr",
          loaded.updatedAt
        )
        loaded = (await f.load())!
      }
      const draft = projectLocale(loaded.nav, "fr", "fr")
      const id = deleted ? "column-feature" : "fresh-feature"
      identityPanel(draft).columns[0]!.sections.push({
        id,
        kind: "featured",
        heading: "Nouveau",
      })
      const next = replaceDefaultLocale(loaded.nav, "fr", draft)
      const feature = columnPanel(next).columns[0]!.sections.at(-1)!
      if (feature.kind !== "featured") throw new Error("Fixture new feature")
      expect(feature.heading).toEqual({ fr: "Nouveau" })
      feature.heading.en = "Injected"
      const before = await f.effects()
      await expect(f.save(next, "fr", loaded.updatedAt)).rejects.toThrow(
        /cannot introduce other-language/
      )
      expect(await f.effects()).toEqual(before)
    }
  )

  test.each(["item", "section", "link", "column"])(
    "duplicate %s IDs are refused atomically",
    async (kind) => {
      const f = await identityFixture()
      const loaded = (await f.load())!
      const next = movedIdentityPayload(loaded.nav)
      const panel = columnPanel(next)
      if (kind === "item") next[1]!.id = next[0]!.id
      if (kind === "section")
        panel.columns[1]!.sections.push(
          structuredClone(panel.columns[0]!.sections[0]!)
        )
      if (kind === "column") panel.columns[1]!.id = panel.columns[0]!.id
      if (kind === "link") {
        const group = panel.columns[0]!.sections[0]!
        const other = panel.footer!.sections[1]!
        if (group.kind !== "linkGroup" || other.kind !== "linkGroup")
          throw new Error("Fixture group")
        other.links.push(structuredClone(group.links[0]!))
      }
      const before = await f.effects()
      await expect(f.save(next, "fr", loaded.updatedAt)).rejects.toThrow(
        /duplicate|unique/
      )
      expect(await f.effects()).toEqual(before)
    }
  )

  test("encoded IDs preserve bags and use single encoding in text and reference keys", async () => {
    const nav = identityRows()
    const encodeId = (id: string) => `${id}/% space`
    for (const item of nav) {
      item.id = encodeId(item.id)
      if (item.panel && isColumnPanel(item.panel))
        for (const col of item.panel.columns) col.id = encodeId(col.id)
      for (const { section } of panelSections(item.panel)) {
        section.id = encodeId(section.id)
        if (section.kind === "linkGroup")
          for (const link of section.links) link.id = encodeId(link.id)
      }
    }
    const f = await identityFixture(nav)
    const loaded = (await f.load())!
    const next = movedIdentityPayload(loaded.nav)
    await f.save(next, "fr", loaded.updatedAt)
    expect(identityBags((await f.load())!.nav)).toEqual(
      identityBags(loaded.nav)
    )
    expect(menuTextKey("section", "column-feature/% space", "heading")).toBe(
      "section/column-feature%2F%25%20space/heading"
    )
    expect(menuTextLeaves(next).map((leaf) => leaf.path)).toContain(
      "section/column-feature%2F%25%20space/heading"
    )
    expect(menuTextLeaves(next).map((leaf) => leaf.path)).toContain(
      "link/column-link%2F%25%20space/label"
    )
    expect((await f.effects()).refs.map((ref) => ref.path)).toContain(
      "nav/id:other-item%2F%25%20space/panel/columns/id:left%2F%25%20space/sections/id:column-feature%2F%25%20space/link/target"
    )
  })

  test("two menus reuse node IDs without sharing translations or reference ownership", async () => {
    const f = await identityFixture()
    const primary = (await f.load())!
    const other = structuredClone(primary.nav)
    for (const leaf of menuTextLeaves(other))
      if (leaf.bag && leaf.kind !== "alt") leaf.bag.en = `Footer ${leaf.path}`
    await f.t.run((ctx) =>
      ctx.db.insert("menus", { slug: "footer", nav: other, updatedAt: 1 })
    )
    const next = movedIdentityPayload(other)
    await f.owner.mutation(api.cms.menus.saveCanonical, {
      slug: "footer",
      nav: next,
      locale: "fr",
      expectedUpdatedAt: 1,
    })
    expect((await f.load())!.nav).toEqual(primary.nav)
    expect(
      (await f.owner.query(api.cms.menus.getCanonical, { slug: "footer" }))!.nav
    ).toEqual(next)
    const refs = (await f.effects()).refs
    expect(
      refs
        .filter((ref) => ref.menuId === f.ids.menu)
        .map((ref) => ref.path)
        .sort()
    ).toEqual(
      walkCanonicalMenuTargets(primary.nav)
        .map((ref) => ref.path)
        .sort()
    )
    expect(
      refs
        .filter((ref) => ref.menuId !== f.ids.menu)
        .map((ref) => ref.path)
        .sort()
    ).toEqual(
      walkCanonicalMenuTargets(next)
        .map((ref) => ref.path)
        .sort()
    )
  })

  test("same-ID kind changes refuse in client and server; fresh replacement ID succeeds", async () => {
    const f = await identityFixture()
    const loaded = (await f.load())!
    const draft = projectLocale(loaded.nav, "fr", "fr")
    const panel = identityPanel(draft)
    panel.columns[0]!.sections[1] = {
      id: "column-feature",
      kind: "dynamicList",
      heading: "Récent",
      source: { pageType: "landing-page", limit: 3 },
    }
    expect(() => replaceDefaultLocale(loaded.nav, "fr", draft)).toThrow(
      "Use a new section to change its kind"
    )
    const raw = structuredClone(loaded.nav)
    columnPanel(raw).columns[0]!.sections[1] = {
      id: "column-feature",
      kind: "dynamicList",
      heading: { fr: "Récent" },
      source: { pageType: "landing-page", limit: 3 },
    }
    const before = await f.effects()
    await expect(f.save(raw, "fr", loaded.updatedAt)).rejects.toThrow(
      "Use a new section to change its kind"
    )
    expect(await f.effects()).toEqual(before)
    panel.columns[0]!.sections[1]!.id = "new-kind-new-id"
    const next = replaceDefaultLocale(loaded.nav, "fr", draft)
    await f.save(next, "fr", loaded.updatedAt)
    expect((await f.load())!.nav).toEqual(next)
  })

  test("conversion round trip shares stored baseline, seeds only Link labels, refuses tampered seeds", async () => {
    const nav = rows()
    for (const leaf of menuTextLeaves(nav))
      if (leaf.bag) leaf.bag.en = `English ${leaf.path}`
    const f = await fixture(nav)
    const original = structuredClone(nav)
    const converted = [{ ...nav[0]!, panel: legacyToColumns(nav[0]!.panel) }]
    const baseline = menuConversionBaseline(nav, converted)
    const beforeBags = identityBags(nav)
    const baselineBags = identityBags(baseline)
    for (const [key, bag] of Object.entries(beforeBags))
      expect(baselineBags[key], key).toEqual(bag)
    expect(
      Object.keys(baselineBags)
        .filter((key) => !(key in beforeBags))
        .sort()
    ).toEqual([
      "section/footer-feature/link/label",
      "section/panel-feature/link/label",
    ])
    for (const region of ["panel", "footer"])
      expect(baselineBags[`section/${region}-feature/link/label`]).toEqual(
        beforeBags[`section/${region}-feature/heading`]
      )
    const baselineSnapshot = structuredClone(baseline)
    const next = replaceDefaultLocale(
      nav,
      "fr",
      projectLocale(converted, "fr", "fr")
    )
    expect(identityBags(next)).toEqual(baselineBags)
    expect(nav).toEqual(original)
    expect(baseline).toEqual(baselineSnapshot)
    for (const region of ["panel", "footer"]) {
      const tampered = structuredClone(next)
      menuTextLeaves(tampered).find(
        (leaf) => leaf.path === `section/${region}-feature/link/label`
      )!.bag!.en = "Different English"
      const before = await f.effects()
      await expect(f.save(tampered, "fr", 1)).rejects.toThrow(
        /preserve translations/
      )
      expect(await f.effects()).toEqual(before)
    }
    await f.save(next, "fr", 1)
    expect((await f.load())!.nav).toEqual(next)
    expect(identityBags((await f.load())!.nav)).toEqual(baselineBags)
    expect(nav).toEqual(original)
    expect(baseline).toEqual(baselineSnapshot)
  })

  test("semantics fixture retains removable subowners, alt ownership, counts, F09 and public omission", async () => {
    const nav = identityRows()
    const panel = columnPanel(nav)
    const feature = panel.columns[0]!.sections[1]!
    const list = panel.columns[1]!.sections[0]!
    const group = panel.columns[0]!.sections[0]!
    if (
      feature.kind !== "featured" ||
      list.kind !== "dynamicList" ||
      group.kind !== "linkGroup"
    )
      throw new Error("Fixture kinds")
    delete feature.description
    delete group.links[0]!.description
    delete list.heading
    feature.image!.alt = { fr: "", en: "" }
    expect(countMenuNodesMissingText(nav, "en")).toBe(0)
    const missing = structuredClone(nav)
    const broken = columnPanel(missing).columns[0]!.sections[1]!
    const missingList = columnPanel(missing).columns[1]!.sections[0]!
    if (broken.kind !== "featured" || missingList.kind !== "dynamicList")
      throw new Error("Fixture missing")
    delete broken.heading.en
    delete broken.image!.alt.en
    delete broken.link!.label.en
    delete missingList.seeAll!.label.en
    expect(countMenuNodesMissingText(missing, "en")).toBe(2)
    const missingLinks = structuredClone(missing)
    for (const { section } of panelSections(missingLinks[0]!.panel))
      if (section.kind === "linkGroup")
        for (const link of section.links) delete link.label.en
    expect(countMenuNodesMissingText(missingLinks, "en")).toBe(4)
    group.heading = { fr: "Groupe" }
    expect(() => validateCanonicalMenuForLocale(nav, "en")).toThrow(
      /default language/
    )
    expect(menuNodePathsMissingRequiredText(nav, "en")).toContain(
      "column-menu/column-group"
    )
    const f = await identityFixture(nav)
    const loaded = (await f.load())!
    const draft = projectLocale(loaded.nav, "fr", "fr")
    const draftFeature = identityPanel(draft).columns[0]!.sections[1]!
    const draftList = identityPanel(draft).columns[1]!.sections[0]!
    if (draftFeature.kind !== "featured" || draftList.kind !== "dynamicList")
      throw new Error("Fixture draft")
    delete draftFeature.link
    delete draftList.seeAll
    const next = replaceDefaultLocale(loaded.nav, "fr", draft)
    await f.save(next, "fr", loaded.updatedAt)
    const saved = (await f.load())!
    const savedFeature = columnPanel(saved.nav).columns[0]!.sections[1]!
    if (savedFeature.kind !== "featured") throw new Error("Fixture saved")
    expect(savedFeature.image!.alt).toEqual({ fr: "", en: "" })
    expect(savedFeature).not.toHaveProperty("description")
    expect(savedFeature).not.toHaveProperty("link")
    const omittedImage = structuredClone(saved.nav)
    const withoutImage = columnPanel(omittedImage).columns[0]!.sections[1]!
    if (withoutImage.kind !== "featured") throw new Error("Fixture image")
    delete withoutImage.image
    const before = await f.effects()
    await expect(f.save(omittedImage, "fr", saved.updatedAt)).rejects.toThrow(
      /preserve translations/
    )
    expect(await f.effects()).toEqual(before)
    const blankOptional = structuredClone(saved.nav)
    const optionalGroup = columnPanel(blankOptional).columns[0]!.sections[0]!
    if (optionalGroup.kind !== "linkGroup") throw new Error("Fixture optional")
    optionalGroup.links[0]!.description = { en: " " }
    await f.save(blankOptional, "fr", saved.updatedAt)
    expect(identityBags((await f.load())!.nav)).toEqual(identityBags(saved.nav))
    const publicEn = localizeCanonicalNav(missing, "en")
    expect(
      panelSections(publicEn[0]!.panel).some(
        ({ section }) => section.id === "column-feature"
      )
    ).toBe(false)
    expect(
      panelSections(localizeCanonicalNav(missing, "fr")[0]!.panel).some(
        ({ section }) => section.id === "column-feature"
      )
    ).toBe(true)
    await f.t.run((ctx) =>
      ctx.db.insert("pagePublicationCutover", {
        key: "published-snapshot-v1",
        phase: "legacy",
        revision: 1,
        updatedAt: 1,
      })
    )
    // Persist locale-owned omissions through the real secondary save before the public query.
    const latest = (await f.load())!
    const secondary = projectLocale(latest.nav, "en", "fr")
    const secondaryFeature = identityPanel(secondary).columns[0]!.sections[1]!
    if (secondaryFeature.kind !== "featured") throw new Error("Fixture public")
    secondaryFeature.heading = ""
    await f.save(
      mergeLocale(latest.nav, "en", secondary),
      "en",
      latest.updatedAt
    )
    const config = await f.owner.query(api.cms.settings.getSiteConfig, {})
    const resolved = await f.t.query(api.cms.menus.getWithResolvedLinks, {
      slug: "primary",
      locale: "en",
      languageVersion: config.languageVersion,
    })
    expect(
      panelSections(resolved!.nav[0]!.panel).some(
        ({ section }) => section.id === "column-feature"
      )
    ).toBe(false)
  })
})

// Step 2: the same public-boundary fixtures run against base and patch.
const PUBLIC_LANGUAGE_CASES = [
  { kind: "unconfigured", locales: [], version: 0 },
  { kind: "uninitialized", locales: ["fr"], version: 0 },
  { kind: "multi_locale", locales: ["fr", "en"], version: 0 },
  { kind: "current", locales: ["fr"], version: 1 },
  { kind: "multilingual", locales: ["fr", "en"], version: 2 },
  { kind: "multilingual", locales: ["fr"], version: 2 },
] as const
const PUBLIC_PROBE_LOCALES = ["fr", "en", "nl"] as const
const PUBLIC_PROBE_NAV: NavItem[] = [{
  id: "locale-probe",
  label: { fr: "Français", en: "English", nl: "Nederlands" },
  target,
}]

type PublicLanguageCase = (typeof PUBLIC_LANGUAGE_CASES)[number]
async function publicLanguageFixture(
  spec: PublicLanguageCase,
  phase: "snapshot_active" | "legacy"
) {
  const t = convexTest(schema, modules)
  await seedCommunityOwner(t, OWNER)
  await t.run(async (ctx) => {
    await ctx.db.insert("pagePublicationCutover", {
      key: "published-snapshot-v1", phase, revision: 1, updatedAt: 1,
    })
    await ctx.db.insert("menus", {
      slug: "primary", nav: PUBLIC_PROBE_NAV, updatedAt: 1,
    })
    if (spec.kind === "unconfigured") return
    await ctx.db.insert("siteSettings", {
      siteName: "Public language facts", siteUrl: "", defaultLocale: "fr",
      enabledLocales: [...spec.locales], updatedAt: 1,
    })
    if (spec.kind === "current") {
      const owner = (await ctx.db.query("cmsOwner").unique())!
      const transitionId = await ctx.db.insert("siteLanguageTransitions", {
        mode: "replace_content", sourceLocale: "fr", targetLocale: "en",
        phase: "preparing", generation: 1, startAuthorityVersion: 1,
        startSettingsUpdatedAt: 1, shortPath: false,
        sourcePublicSetVersion: 0, preparedSetVersion: 0,
        pageCount: 0, targetCount: 0, withdrawCount: 0, redirectCount: 0,
        unresolvedCount: 0, blockedCount: 0, targetDrafts: "retained",
        attribution: { kind: "owner", ownerId: owner._id,
          authId: OWNER.subject, tokenIdentifier: OWNER.tokenIdentifier },
        createdAt: 1, updatedAt: 1,
      })
      await ctx.db.insert("siteLanguageAuthority", {
        key: "site-language-v1", version: spec.version, currentLocale: "fr",
        activeTransitionId: transitionId, updatedAt: 1,
      })
    } else if (spec.kind === "multilingual") {
      await ctx.db.insert("cmsModuleState", {
        key: "owner", configurationVersion: 1,
        enabledModules: [{ moduleId: "multilingual", configVersion: 1 }],
      })
      await ctx.db.insert("siteLanguageAuthority", {
        key: "site-language-v1", mode: "multilingual", version: spec.version,
        currentLocale: "fr", enabledLocales: [...spec.locales], updatedAt: 1,
      })
    }
  })
  const resolve = (locale: string) => t.query(api.cms.menus.getWithResolvedLinks, {
    slug: "primary", locale, languageVersion: spec.version,
  })
  return { t, resolve }
}

function expectedPublicProbe(locale: (typeof PUBLIC_PROBE_LOCALES)[number]) {
  return { slug: "primary", nav: [{
    id: "locale-probe", label: PUBLIC_PROBE_NAV[0]!.label[locale], target,
  }] }
}

describe("public menu locale compatibility", () => {
  test.each(PUBLIC_LANGUAGE_CASES.flatMap((spec) =>
    (["snapshot_active", "legacy"] as const).map((phase) => ({ ...spec, phase }))
  ))("$kind/$locales/$phase preserves the base result", async (spec) => {
    const { resolve } = await publicLanguageFixture(spec, spec.phase)
    for (const locale of PUBLIC_PROBE_LOCALES) {
      const accepted = spec.phase === "legacy" ||
        (spec.locales as readonly string[]).includes(locale)
      expect(await resolve(locale)).toEqual(accepted
        ? expectedPublicProbe(locale) : { slug: "primary", nav: [] })
    }
  })
})

test.each([PUBLIC_LANGUAGE_CASES[0], PUBLIC_LANGUAGE_CASES[3]])(
  "legacy $kind retains the default locale and en fallback for page paths",
  async (spec) => {
    const { t, resolve } = await publicLanguageFixture(spec, "legacy")
    await t.run(async (ctx) => {
      const pageId = await ctx.db.insert("pages", {
        pageType: "page", slug: "locale-target", status: "published",
        content: { en: { title: "English", blocks: [] }, fr: { title: "Français", blocks: [] } },
        createdAt: 1, updatedAt: 1,
      })
      const menu = (await ctx.db.query("menus").unique())!
      await ctx.db.patch("menus", menu._id, {
        nav: [{ ...PUBLIC_PROBE_NAV[0]!, target: { type: "internal", pageId } }],
      })
    })
    const defaultLocale = spec.kind === "unconfigured" ? "en" : "fr"
    for (const locale of ["en", "fr"]) {
      expect((await resolve(locale))!.nav[0]!.target).toEqual({
        type: "internal",
        url: `${locale === defaultLocale ? "" : `/${locale}`}/locale-target`,
      })
    }
  }
)

describe("Language-owned public locale eligibility", () => {
  test.each(PUBLIC_LANGUAGE_CASES)(
    "$kind/$locales projects only public language facts",
    async (spec) => {
      const { t } = await publicLanguageFixture(spec, "snapshot_active")
      const state = await t.run((ctx) => languageState.readPublicSiteLanguageState(ctx))
      expect(state.kind).toBe(spec.kind)
      const facts = languageState.publicLocaleEligibility(state)
      expect(facts).toEqual({
        defaultLocale: spec.kind === "unconfigured" ? null : "fr",
        publicLocales: [...spec.locales],
      })
      // For every valid classified state the old settings gate is identical.
      expect(facts.publicLocales).toEqual(
        state.kind === "unconfigured" ? [] : state.settings.enabledLocales
      )
      if (state.kind === "current") {
        const transition = await t.run((ctx) => ctx.db.get("siteLanguageTransitions", state.authority.activeTransitionId!))
        expect(transition).toMatchObject({ phase: "preparing", targetLocale: "en" })
        expect(facts.publicLocales).not.toContain(transition!.targetLocale)
      }
    }
  )

  test.each(PUBLIC_LANGUAGE_CASES)(
    "$kind/$locales resolver membership consumes the projection",
    async (spec) => {
      const { t, resolve } = await publicLanguageFixture(spec, "snapshot_active")
      const state = await t.run((ctx) => languageState.readPublicSiteLanguageState(ctx))
      const facts = languageState.publicLocaleEligibility(state)
      const accepted: string[] = []
      for (const locale of PUBLIC_PROBE_LOCALES) {
        if ((await resolve(locale))!.nav.length > 0) accepted.push(locale)
      }
      expect(accepted).toEqual(facts.publicLocales)

      // A divergent projection reaches the real public query. Recomputing from
      // settings (even if currently equivalent) must fail this class guard.
      const projected = { ...facts, publicLocales: ["nl"] }
      const projection = vi.spyOn(languageState, "publicLocaleEligibility")
        .mockReturnValue(projected)
      try {
        const acceptedFromProjection: string[] = []
        for (const locale of PUBLIC_PROBE_LOCALES) {
          if ((await resolve(locale))!.nav.length > 0) acceptedFromProjection.push(locale)
        }
        expect(projection).toHaveBeenCalledWith(state)
        expect(acceptedFromProjection).toEqual(projected.publicLocales)
      } finally {
        projection.mockRestore()
      }
    }
  )
})

test.each([
  ["tel:+15149550226", true],
  ["tel:+1 (514) 955-0226", true],
  ["tel:514-955-0226;ext=12", true],
  ["tel:5.1.4", true],
  ["tel:++15149550226", false],
  ["tel:+1+514", false],
  ["tel:+15149550226;ext=abc", false],
  ["tel:+15149550226;phone-context=x", false],
  ["tel:*#", false],
  ["tel:51;ext=234", false],
  ["tel:514;ext=", false],
  ["tel:514;ext=12;ext=34", false],
  ["mailto:hello@example.com", true],
  [" tel:+15149550226 ", true],
  [" mailto:hello@example.com ", true],
  ["TEL:+15149550226", true],
  ["MAILTO:hello@example.com", true],
  ["https://example.com", true],
  ["http://example.com", true],
  ["javascript:alert(1)", false],
  ["data:text/html,x", false],
  ["tel:", false],
  ["mailto:", false],
  ["tel:abc", false],
  ["mailto:hello", false],
  ["mailto:hello@@example.com", false],
  ["mailto:hello@example.com?body=%0d%0aBcc:other@example.com", false],
  ["tel:+1514\n9550226", false],
  ["mailto:hello%0a@example.com", false],
  ["https://localhost", false],
] as const)(
  "client and real menu save agree for %j (accepted: %s)",
  async (url, accepted) => {
    const f = await fixture([])
    // Text only in the saved (default) language, so only the destination varies.
    const nav: NavItem[] = [
      {
        id: "contact",
        label: { fr: "Contact" },
        target: { type: "external", url, openInNewTab: true },
      },
    ]
    expect(targetError({ type: "external", url })).toBe(
      accepted ? undefined : "url"
    )
    if (accepted) {
      await f.save(nav, "fr", 1)
      // Save stores the URL as typed, like web links; validation trims it.
      expect((await f.load())!.nav[0]!.target).toEqual({
        type: "external",
        url,
        openInNewTab: true,
      })
    } else {
      await expect(f.save(nav, "fr", 1)).rejects.toThrow()
      expect((await f.load())!.nav).toEqual([])
    }
  }
)

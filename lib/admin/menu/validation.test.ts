import { placeholderTarget as target } from "@/test-utils/menu-visibility"
import { expectLegacyPanel as legacyPanel } from "@/test-utils/menu-panel"
import { expect, test } from "vitest"
import type { LocaleNavItem } from "@/convex/lib/menu"
import {
  hasMenuText,
  menuDraftEqual,
  menuErrors,
  menuTextValid,
  targetError,
} from "./validation"
import { withAuthoredAlt } from "./locale-projection"
import { decideMenu } from "./public-visibility"

test.each([
  "/",
  "about",
  "localhost:3000",
  "https://localhost",
  "https://127.0.0.1",
  "https://10.0.0.1",
  "https://user:pass@example.com",
  "ftp://example.com",
])("uses the authoritative URL guard: %s", (url) => {
  expect(targetError({ type: "external", url })).toBe("url")
})

test("accepts public HTTP(S) and refuses a Page intent retaining an old URL", () => {
  expect(
    targetError({ type: "external", url: "https://exemple.com" })
  ).toBeUndefined()
  expect(
    targetError({ type: "external", url: "https://exemple.com" }, "internal")
  ).toBe("page")
})

test.each(["main", "footer"])(
  "aggregates every target-bearing node and image in %s",
  (region) => {
    const sections: Extract<NonNullable<LocaleNavItem["panel"]>, { columns: number }>["sections"] = [
      {
        id: "group",
        kind: "linkGroup",
        links: [
          {
            id: "link",
            label: "Link",
            target: { type: "external", url: "/bad" },
          },
        ],
      },
      {
        id: "list",
        kind: "dynamicList",
        source: { pageType: "post", limit: 3 },
        seeAll: { label: "All", target: { type: "external", url: "/bad" } },
      },
      {
        id: "featured",
        kind: "featured",
        heading: "Featured",
        image: { alt: "" },
        target: { type: "external", url: "/bad" },
      },
    ]
    const nav: LocaleNavItem[] = [
      {
        id: "item",
        label: "Item",
        target: { type: "external", url: "/bad" },
        panel: {
          columns: 1,
          sections: region === "main" ? sections : [],
          footer: region === "footer" ? { sections } : undefined,
        },
      },
    ]
    expect(menuErrors(nav).map((error) => [error.key, error.code])).toEqual([
      ["item", "url"],
      ["link", "url"],
      ["list-seeAll", "url"],
      ["featured-image", "image"],
      ["featured", "url"],
    ])
    expect(
      menuErrors(nav, {
        link: "internal",
        "list-seeAll": "internal",
        featured: "internal",
      })
        .filter((error) => error.code === "page")
        .map((error) => error.key)
    ).toEqual(["link", "list-seeAll", "featured"])
  }
)

test("dirty state compares content and authored-alt intent, including edits reverted to saved values", () => {
  const section = {
    id: "feature",
    kind: "featured" as const,
    heading: "",
    image: { alt: "" },
    target: { type: "external" as const, url: "https://example.com" },
  }
  const saved: LocaleNavItem[] = [
    { id: "item", label: "Saved", panel: { columns: 1, sections: [section] } },
  ]
  expect(menuDraftEqual(structuredClone(saved), saved)).toBe(true)
  expect(menuDraftEqual([{ ...saved[0]!, label: "Changed" }], saved)).toBe(
    false
  )
  expect(menuDraftEqual([{ ...saved[0]!, label: "Saved" }], saved)).toBe(true)
  expect(
    menuDraftEqual(
      [
        {
          ...saved[0]!,
          panel: { columns: 1, sections: [withAuthoredAlt(section, "")] },
        },
      ],
      saved
    )
  ).toBe(false)
})

test("copy overwrite detection includes text in both regions but ignores structure", () => {
  const nav: LocaleNavItem[] = [
    {
      id: "item",
      label: "",
      panel: {
        columns: 4,
        sections: [],
        footer: {
          sections: [
            {
              id: "list",
              kind: "dynamicList",
              source: { pageType: "post", limit: 3 },
              seeAll: {
                label: "All",
                target: { type: "external", url: "https://example.com" },
              },
            },
          ],
        },
      },
    },
  ]
  expect(hasMenuText(nav)).toBe(true)
  nav[0]!.panel!.footer!.sections = []
  expect(hasMenuText(nav)).toBe(false)
})

test("public empty-list projection preserves input and drops all-hidden panels in either region", () => {
  const item = {
    id: "item",
    label: "Item",
    panel: {
      columns: 1 as const,
      sections: [
        {
          id: "list",
          kind: "dynamicList" as const,
          heading: "Hidden",
          source: { pageType: "post" as const, limit: 3 },
        },
      ],
    },
  }
  for (const panel of [
    item.panel,
    {
      ...item.panel,
      sections: [],
      footer: { sections: legacyPanel(item.panel).sections },
    },
  ]) {
    const hidden = decideMenu([{ ...item, panel }], {})
    expect(hidden.items).toEqual([])
    expect(hidden.nodes.get(item.id)).toEqual({
      kind: "item",
      shown: false,
      reason: "Empty",
    })

    const shown = decideMenu([{ ...item, panel, target }], {})
    expect(shown.items).toEqual([{ ...item, target, panel: undefined }])
    expect(shown.nodes.get(item.id)).toEqual({
      kind: "item",
      shown: true,
      reason: null,
    })
  }
  expect(legacyPanel(item.panel).sections).toHaveLength(1)
})


test("text validity accepts any retained locale, rejects a blank new label, and keeps empty alt distinct", () => {
  expect(menuTextValid([{ id: "retained", label: { fr: "Accueil" } }])).toBe(true)
  expect(menuTextValid([{ id: "new", label: { en: "  " } }])).toBe(false)
  const nav = [{ id: "item", label: { fr: "Menu" }, panel: { columns: 1 as const, sections: [{
    id: "feature", kind: "featured" as const, heading: { fr: "À la une" }, image: { alt: {} },
    target: { type: "anchor" as const, anchor: "#feature" },
  }] } }]
  expect(menuTextValid(nav)).toBe(false)
  legacyPanel(nav[0]!.panel).sections[0]!.image.alt = { fr: "" }
  expect(menuTextValid(nav)).toBe(true)
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
  "validates menu destination %j (accepted: %s)",
  (url, accepted) => {
    expect(targetError({ type: "external", url })).toBe(
      accepted ? undefined : "url"
    )
  }
)

import { placeholderTarget as target, postCards } from "@/test-utils/menu-visibility"
import { describe, expect, test } from "vitest"
import { decideMenu } from "./public-visibility"
import {
  panelBlocks,
  type CanonicalResolvedNavItem,
  type ResolvedBlock,
  type MenuCardsBySource,
} from "@/convex/lib/menu"

type Fixture = {
  items: CanonicalResolvedNavItem[]
  cards?: MenuCardsBySource
  output?: CanonicalResolvedNavItem[]
  check?: (decision: ReturnType<typeof decideMenu>) => void
  decisions: [string, boolean, string | null][]
}

const group = (): ResolvedBlock => ({
  id: "group",
  kind: "linkGroup",
  links: [{ id: "child", label: "Child", target }],
})
const list = (): ResolvedBlock => ({
  id: "list",
  kind: "dynamicList",
  source: { pageType: "post", limit: 2 },
  seeAll: { label: "See all", target },
})
const panelItem = (blocks: ResolvedBlock[]): CanonicalResolvedNavItem => ({
  id: "item",
  label: "Panel",
  panel: { columns: 1, blocks },
})
const cases: Record<string, (locale: string) => Fixture> = {
  "disabled item suppresses every descendant": () => ({
    items: [
      {
        ...panelItem([
          group(),
          list(),
          {
            id: "feature",
            kind: "featured",
            heading: "Card",
            image: { alt: "" },
            link: { label: "", target },
          },
        ]),
        isDisabled: true,
        target: { type: "internal" },
      },
    ],
    decisions: [
      ["item", false, "Switched off"],
      ["item:panel", false, "parent hidden"],
      ["item:target", false, "parent hidden"],
      ["group", false, "parent hidden"],
      ["child", false, "parent hidden"],
      ["list", false, "parent hidden"],
      ["list:seeAll", false, "parent hidden"],
      ["feature:link", false, "parent hidden"],
      ["feature:image", false, "parent hidden"],
    ],
  }),
  "disabled link empties its group": () => ({
    items: [
      panelItem([
        {
          id: "group",
          kind: "linkGroup",
          links: [{ id: "child", label: "Child", target, isDisabled: true }],
        },
      ]),
    ],
    decisions: [
      ["child", false, "Switched off"],
      ["group", false, "Empty"],
    ],
  }),
  "unresolved internal item keeps its panel": () => ({
    items: [{ ...panelItem([group()]), target: { type: "internal" } }],
    output: [panelItem([group()])],
    decisions: [
      ["item", true, null],
      ["item:target", false, "No address"],
      ["child", true, null],
    ],
  }),
  "unresolved link is omitted": () => ({
    items: [
      panelItem([
        {
          id: "group",
          kind: "linkGroup",
          links: [
            { id: "child", label: "Child", target: { type: "internal" } },
          ],
        },
      ]),
    ],
    decisions: [
      ["child", false, "No address"],
      ["group", false, "Empty"],
    ],
  }),
  "empty external item": () => ({
    items: [
      { id: "item", label: "Empty URL", target: { type: "external", url: "" } },
    ],
    decisions: [["item", false, "No address"]],
  }),
  "invalid external item": () => ({
    items: [
      {
        id: "item",
        label: "Bad URL",
        target: { type: "external", url: "javascript:alert(1)" },
      },
    ],
    decisions: [["item", false, "No address"]],
  }),
  "placeholder stays a link": () => ({
    items: [{ id: "item", label: "Placeholder", target }],
    decisions: [["item", true, null]],
  }),
  "empty dynamic list suppresses See all": () => ({
    items: [panelItem([list()])],
    decisions: [
      ["list", false, "No published items"],
      ["list:seeAll", false, "parent hidden"],
      ["item:panel", false, "Empty"],
      ["item", false, "Empty"],
    ],
  }),
  "populated list omits unresolved See all": () => ({
    items: [
      panelItem([
        {
          ...list(),
          seeAll: { label: "See all", target: { type: "internal" } },
        } as ResolvedBlock,
      ]),
    ],
    cards: postCards({ pageId: "page", title: "Post", href: "/post" }),
    decisions: [
      ["list", true, null],
      ["list:seeAll", false, "No address"],
      ["item", true, null],
    ],
  }),
  "empty column is dropped without suppressing child reasons": () => ({
    check: (decision) => expect(decision.items[0]!.panel).toMatchObject({ columns: [{ id: "shown-col" }] }),
    items: [
      {
        id: "item",
        label: "Columns",
        panel: {
          layout: "columns",
          columns: [
            { id: "empty-col", blocks: [list()] },
            { id: "shown-col", blocks: [group()] },
          ],
        },
      },
    ],
    decisions: [
      ["empty-col", false, "Empty"],
      ["list", false, "No published items"],
      ["shown-col", true, null],
      ["item", true, null],
    ],
  }),
  "empty panel becomes its resolved link": () => ({
    check: (decision) => expect(decision.items[0]!.panel).toBeUndefined(),
    items: [{ ...panelItem([list()]), target }],
    decisions: [
      ["item:panel", false, "Empty"],
      ["item", true, null],
    ],
  }),
  "featured card keeps unlabeled Link and empty alt at launch": () => ({
    items: [
      panelItem([
        {
          id: "feature",
          kind: "featured",
          heading: "Card",
          image: { alt: "" },
          link: { label: "", target },
        },
      ]),
    ],
    decisions: [
      ["feature", true, null],
      ["feature:link", true, null],
      ["feature:image", true, null],
    ],
  }),
  "unresolved featured Link keeps its card": () => ({
    items: [
      panelItem([
        {
          id: "feature",
          kind: "featured",
          heading: "Card",
          link: { label: "Bad", target: { type: "internal" } },
        },
      ]),
    ],
    decisions: [
      ["feature", true, null],
      ["feature:link", false, "No address"],
    ],
  }),
  "unresolved legacy featured target keeps the card": () => ({
    output: [panelItem([{ id: "feature", kind: "featured", heading: "Card" }])],
    items: [
      panelItem([
        {
          id: "feature",
          kind: "featured",
          heading: "Card",
          target: { type: "internal" },
        },
      ]),
    ],
    decisions: [
      ["feature", true, null],
      ["feature:target", false, "No address"],
      ["item", true, null],
    ],
  }),
  "panel overview target resolves only in FR": (locale) => ({
    check: (decision) => {
      const owner = decision.items[0]!
      if (locale === "fr") expect(owner).toHaveProperty("target.url", "/fr")
      else expect(owner).not.toHaveProperty("target")
    },
    items: [
      {
        ...panelItem([group()]),
        target: {
          type: "internal",
          ...(locale === "fr" ? { url: "/fr" } : {}),
        },
      },
    ],
    decisions: [
      ["item", true, null],
      ["item:panel", true, null],
      ["child", true, null],
      ["item:target", locale === "fr", locale === "fr" ? null : "No address"],
    ],
  }),
  "legacy card target resolves only in FR": (locale) => ({
    check: (decision) => {
      const owner = panelBlocks(decision.items[0]!.panel)[0]!.block
      if (locale === "fr") expect(owner).toHaveProperty("target.url", "/fr")
      else expect(owner).not.toHaveProperty("target")
    },
    items: [
      panelItem([
        {
          id: "feature",
          kind: "featured",
          heading: "Card",
          image: { alt: "Card" },
          target: {
            type: "internal",
            ...(locale === "fr" ? { url: "/fr" } : {}),
          },
        },
      ]),
    ],
    decisions: [
      ["item", true, null],
      ["feature", true, null],
      ["feature:image", true, null],
      [
        "feature:target",
        locale === "fr",
        locale === "fr" ? null : "No address",
      ],
    ],
  }),
  "empty panel with unresolved target stays Empty": () => ({
    items: [{ ...panelItem([list()]), target: { type: "internal" } }],
    decisions: [
      ["item", false, "Empty"],
      ["item:target", false, "No address"],
      ["item:panel", false, "Empty"],
      ["list", false, "No published items"],
    ],
  }),
}

for (const locale of ["fr", "en"])
    describe(locale, () => {
      test.each(Object.keys(cases))("%s", (name) => {
        const fixture = cases[name](locale)
        fixture.items[0]!.label = `${locale}: ${fixture.items[0]!.label}`
        const { check, ...input } = fixture
        const before = structuredClone(input)
        const decision = decideMenu(fixture.items, fixture.cards ?? {})
        for (const [id, shown, reason] of fixture.decisions)
          expect(decision.nodes.get(id), id).toMatchObject({ shown, reason })
        expect(input).toEqual(before)
        if (fixture.output) {
          fixture.output[0]!.label = fixture.items[0]!.label
          expect(decision.items).toEqual(fixture.output)
          expect(decision.items[0]).not.toHaveProperty("target")
          for (const { block } of panelBlocks(decision.items[0]!.panel))
            if (block.kind === "featured")
              expect(block).not.toHaveProperty("target")
        }
        expect(decision.items.map((item) => item.id)).toEqual(
          fixture.items
            .filter((item) => decision.nodes.get(item.id)?.shown)
            .map((item) => item.id)
        )
        check?.(decision)
      })
    })

// One target at a time: an address failure must not become ancestor suppression.
test.each([
  "item with panel",
  "legacy featured card",
  "featured Link",
  "See all",
  "link-group link",
])(
  "%s loses only its unresolved link, preserving every other shown node",
  (kind) => {
    const live = (): NonNullable<CanonicalResolvedNavItem["target"]> => ({
      type: "internal",
      url: "/live",
    })
    const legacy: Extract<ResolvedBlock, { kind: "featured" }> = {
      id: "legacy",
      kind: "featured",
      heading: "Legacy",
      image: { alt: "Legacy" },
      target: live(),
    }
    const featureLink = { label: "Feature link", target: live() }
    const feature: Extract<ResolvedBlock, { kind: "featured" }> = {
      id: "feature",
      kind: "featured",
      heading: "Feature",
      image: { alt: "Feature" },
      link: featureLink,
    }
    const seeAll = { label: "See all", target: live() }
    const dynamic: Extract<ResolvedBlock, { kind: "dynamicList" }> = {
      id: "list",
      kind: "dynamicList",
      source: { pageType: "post", limit: 2 },
      seeAll,
    }
    const child = { id: "child", label: "Child", target: live() }
    const links: Extract<ResolvedBlock, { kind: "linkGroup" }> = {
      id: "group",
      kind: "linkGroup",
      links: [child, { id: "sibling", label: "Sibling", target: live() }],
    }
    const item = {
      ...panelItem([links, legacy, feature, dynamic]),
      target: live(),
    }
    const subjects: Record<
      string,
      {
        id: string
        owner: { target: NonNullable<CanonicalResolvedNavItem["target"]> }
      }
    > = {
      "item with panel": { id: "item:target", owner: item },
      "legacy featured card": {
        id: "legacy:target",
        owner: legacy as typeof legacy & {
          target: NonNullable<typeof legacy.target>
        },
      },
      "featured Link": { id: "feature:link", owner: featureLink },
      "See all": { id: "list:seeAll", owner: seeAll },
      "link-group link": { id: "child", owner: child },
    }
    const expected = structuredClone(item)
    const expectedBlocks = panelBlocks(expected.panel).map(({ block }) => block)
    if (kind === "item with panel")
      delete (expected as CanonicalResolvedNavItem).target
    if (kind === "legacy featured card")
      delete (expectedBlocks[1] as typeof legacy).target
    if (kind === "featured Link")
      delete (expectedBlocks[2] as typeof feature).link
    if (kind === "See all") delete (expectedBlocks[3] as typeof dynamic).seeAll
    if (kind === "link-group link")
      (expectedBlocks[0] as typeof links).links.shift()
    const subject = subjects[kind]!
    subject.owner.target = { type: "internal" }
    const input = structuredClone(item)
    const cards: MenuCardsBySource = postCards({ pageId: "post", title: "Post", href: "/post" })
    const result = decideMenu([item], cards)
      expect(result.items).toEqual([expected])
      expect(result.nodes.get(subject.id)).toMatchObject({
        shown: false,
        reason: "No address",
      })
      for (const id of [
        "item",
        "item:panel",
        "group",
        "sibling",
        "legacy",
        "legacy:image",
        "feature",
        "feature:image",
        "list",
      ])
        expect(result.nodes.get(id), id).toMatchObject({
          shown: true,
          reason: null,
        })
      expect(item).toEqual(input)
  }
)

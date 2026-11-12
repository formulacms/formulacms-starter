import { describe, expect, test } from "vitest"
import type { Id } from "../../_generated/dataModel"
import {
  DISCLOSURE_CHAIN_EMPTY_DIGEST,
  DISCLOSURE_FIELD_MAX_BYTES,
  DISCLOSURE_PAGE_ITEMS_MAX_BYTES,
  DISCLOSURE_SECTION_BATCH,
  type DisclosureItem,
  digestDisclosurePage,
  disclosureItemsBytes,
  encodeDisclosureItems,
  sha256Hex,
  truncateDisclosureItem,
  truncateUtf8,
} from "./disclosure"

// M05 P17 digest cases (contract `siteLanguageDisclosurePages` Digest and
// Oversized items; named residual 1). Pure unit proof: no Convex runtime.

const page = (n: number) => `page_${n}` as Id<"pages">
const rule = (n: number) => `rule_${n}` as Id<"redirects">
const menu = (n: number) => `menu_${n}` as Id<"menus">

const corpus = (): DisclosureItem[] => [
  { kind: "selection", pageId: page(1), path: "/about", title: "About" },
  { kind: "selection_non_routable", pageId: page(2), title: "Author" },
  { kind: "historical_route", pageId: page(3), fromPath: "/old" },
  {
    kind: "manual_rule",
    ruleId: rule(1),
    fromPath: "/promo",
    destination: { kind: "path", toPath: "/sale" },
    statusCode: 301,
    status: "silenced",
  },
  {
    kind: "menu_node",
    menuId: menu(1),
    menuName: "Main",
    nodePath: "0/2",
  },
]

const digestOf = (
  items: DisclosureItem[],
  previous = DISCLOSURE_CHAIN_EMPTY_DIGEST
) =>
  digestDisclosurePage({
    previousDigest: previous,
    subjectId: "preview_1",
    generation: 1,
    ordinal: 0,
    section: "selections",
    items,
  })

describe("M05 P17 disclosure digest", () => {
  test("the empty-chain constant is frozen to its derivation", async () => {
    expect(DISCLOSURE_CHAIN_EMPTY_DIGEST).toBe(
      `sha256:${await sha256Hex(
        new TextEncoder().encode("formulacms/m05/disclosure-chain/v1/empty")
      )}`
    )
    expect(DISCLOSURE_CHAIN_EMPTY_DIGEST).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("a corpus rebuilt unchanged has the same digest", async () => {
    expect(await digestOf(corpus())).toBe(await digestOf(corpus()))
  })

  test("a changed, added, removed or reordered item changes the digest", async () => {
    const base = await digestOf(corpus())
    const changed = corpus()
    changed[0] = {
      ...(changed[0] as { kind: "selection" } & DisclosureItem),
      title: "About us",
    } as DisclosureItem
    const added = [
      ...corpus(),
      {
        kind: "historical_route",
        pageId: page(9),
        fromPath: "/x",
      } as DisclosureItem,
    ]
    const removed = corpus().slice(1)
    const reordered = corpus()
    ;[reordered[0], reordered[1]] = [reordered[1]!, reordered[0]!]
    const digests = await Promise.all([
      digestOf(changed),
      digestOf(added),
      digestOf(removed),
      digestOf(reordered),
    ])
    for (const digest of digests) expect(digest).not.toBe(base)
    expect(new Set(digests).size).toBe(4)
  })

  test("every envelope field is bound into the digest", async () => {
    const input = {
      previousDigest: DISCLOSURE_CHAIN_EMPTY_DIGEST,
      subjectId: "preview_1",
      generation: 1,
      ordinal: 0,
      section: "selections" as const,
      items: corpus(),
    }
    const base = await digestDisclosurePage(input)
    const variants = await Promise.all([
      digestDisclosurePage({ ...input, previousDigest: base }),
      digestDisclosurePage({ ...input, subjectId: "preview_2" }),
      digestDisclosurePage({ ...input, generation: 2 }),
      digestDisclosurePage({ ...input, ordinal: 1 }),
      digestDisclosurePage({ ...input, section: "historical_routes" }),
    ])
    expect(new Set([base, ...variants]).size).toBe(6)
  })

  test("field boundaries cannot collide through concatenation", async () => {
    // Naive concatenation of path + title is identical for both items.
    const a: DisclosureItem = {
      kind: "selection",
      pageId: page(1),
      path: "/ab",
      title: "c",
    }
    const b: DisclosureItem = {
      kind: "selection",
      pageId: page(1),
      path: "/a",
      title: "bc",
    }
    expect(await digestOf([a])).not.toBe(await digestOf([b]))
    // One item versus the same text split across two items.
    const one: DisclosureItem[] = [
      { kind: "historical_route", pageId: page(1), fromPath: "/a/b" },
    ]
    const two: DisclosureItem[] = [
      { kind: "historical_route", pageId: page(1), fromPath: "/a" },
      { kind: "historical_route", pageId: page(1), fromPath: "/b" },
    ]
    expect(await digestOf(one)).not.toBe(await digestOf(two))
    // An absent optional field differs from a present empty one.
    const absent: DisclosureItem = {
      kind: "manual_rule",
      ruleId: rule(1),
      fromPath: "/p",
      destination: { kind: "path", toPath: "/q" },
      statusCode: 301,
      status: "active",
    }
    const empty: DisclosureItem = {
      ...absent,
      newVisiblePath: "",
    } as DisclosureItem
    expect(await digestOf([absent])).not.toBe(await digestOf([empty]))
    // `truncated` is part of what the owner saw.
    const truncated = { ...a, truncated: true } as DisclosureItem
    expect(await digestOf([a])).not.toBe(await digestOf([truncated]))
  })

  test("the encoding ignores property insertion order", () => {
    const a: DisclosureItem = {
      kind: "selection",
      pageId: page(1),
      path: "/a",
      title: "A",
    }
    const b = {
      title: "A",
      path: "/a",
      pageId: page(1),
      kind: "selection",
    } as DisclosureItem
    expect(encodeDisclosureItems([a])).toEqual(encodeDisclosureItems([b]))
  })
})

describe("M05 P17 oversized items", () => {
  test("UTF-8 truncation never splits a code point", () => {
    const text = "é".repeat(10) // 2 bytes each
    const cut = truncateUtf8(text, 5)
    expect(cut.truncated).toBe(true)
    expect(cut.value).toBe("éé")
    // A 4-byte code point cut 1, 2 and 3 bytes in keeps only whole points.
    const emoji = "a\u{1F600}b"
    for (const max of [2, 3, 4]) {
      expect(truncateUtf8(emoji, max)).toEqual({ value: "a", truncated: true })
    }
    expect(truncateUtf8(emoji, 5)).toEqual({
      value: "a\u{1F600}",
      truncated: true,
    })
    expect(truncateUtf8("short", 5)).toEqual({
      value: "short",
      truncated: false,
    })
  })

  test("a single field longer than 64 KiB is truncated and flagged", () => {
    const huge = "x".repeat(100 * 1024)
    const item = truncateDisclosureItem({
      kind: "selection",
      pageId: page(1),
      path: huge,
      title: huge,
    })
    expect(item).toMatchObject({ truncated: true })
    if (item.kind !== "selection") throw new Error("kind")
    expect(new TextEncoder().encode(item.path).byteLength).toBe(
      DISCLOSURE_FIELD_MAX_BYTES.path
    )
    expect(new TextEncoder().encode(item.title).byteLength).toBe(
      DISCLOSURE_FIELD_MAX_BYTES.title
    )
    const untouched = truncateDisclosureItem({
      kind: "historical_route",
      pageId: page(1),
      fromPath: "/a",
    })
    expect("truncated" in untouched).toBe(false)
  })

  test("each section's batch at its field maxima fits one page", () => {
    const max = (n: number) => "\u{1F600}".repeat(n) // 4 bytes each, over every maximum
    const long = max(4096)
    const bySection: Record<
      keyof typeof DISCLOSURE_SECTION_BATCH,
      (i: number) => DisclosureItem
    > = {
      selections: (i) => ({
        kind: "selection",
        pageId: page(i),
        path: long,
        title: long,
      }),
      historical_routes: (i) => ({
        kind: "historical_route",
        pageId: page(i),
        fromPath: long,
      }),
      locale_prefix_shadowing: (i) => ({
        kind: "locale_prefix_shadow",
        pageId: page(i),
        fromPath: long,
        origin: "current",
      }),
      manual_rules: (i) => ({
        kind: "manual_rule",
        ruleId: rule(i),
        fromPath: long,
        destination: { kind: "external", url: long },
        statusCode: 302,
        status: "shifted",
        newVisiblePath: long,
      }),
      menus: (i) => ({
        kind: "menu_blocker",
        menuId: menu(i),
        menuName: long,
        nodePath: long,
        code: "DEFAULT_MIGRATION_MENU_TEXT_MISSING",
      }),
    }
    for (const [section, make] of Object.entries(bySection)) {
      const batch =
        DISCLOSURE_SECTION_BATCH[
          section as keyof typeof DISCLOSURE_SECTION_BATCH
        ]
      const items = Array.from({ length: batch }, (_, i) =>
        truncateDisclosureItem(make(i))
      )
      expect(items.length).toBeLessThan(50)
      expect(disclosureItemsBytes(items)).toBeLessThanOrEqual(
        DISCLOSURE_PAGE_ITEMS_MAX_BYTES
      )
    }
  })
})

import { describe, expect, test } from "vitest"
import { button, group, list, relation, richText, text } from "./index"
import { walkDef, walkValue, type DefNode, type LeafVisit } from "./walk"

// A descriptor exercising both combinators (groups, lists, nesting, leaves).
const def = group({
  title: text(),
  body: richText({ profile: "basic" }),
  items: list(
    group({
      rel: relation({ pageTypes: ["page"] }),
      cta: button,
    })
  ),
})

describe("walkValue", () => {
  test("visits every leaf with index-carrying paths", () => {
    const value = {
      title: "T",
      body: "B",
      items: [
        { rel: { pageId: "p1" }, cta: { label: "A", link: { type: "none" }, variant: "primary" } },
        { rel: { pageId: "p2" }, cta: { label: "B", link: { type: "none" }, variant: "primary" } },
      ],
    }
    const seen: Array<[string, string]> = []
    walkValue(def, value, (leaf: LeafVisit) => seen.push([leaf.path, leaf.def.kind]))

    // List rows carry real indices; button (a group) is descended into.
    expect(seen).toEqual(
      expect.arrayContaining([
        ["title", "text"],
        ["body", "richText"],
        ["items[0].rel", "relation"],
        ["items[1].rel", "relation"],
        ["items[0].cta.label", "text"],
      ])
    )
    expect(seen.filter(([, kind]) => kind === "relation")).toHaveLength(2)
  })

  test("descends missing/malformed values as empty container", () => {
    const seen: string[] = []
    walkValue(def, undefined, (leaf) => seen.push(leaf.path))
    // Group descends as {} (title/body visited, value undefined); list as [].
    expect(seen).toEqual(["title", "body"])
  })

  test("strips the trailing index from key", () => {
    const value = { items: [{ rel: { pageId: "p1" } }] }
    const keys: string[] = []
    walkValue(def, value, (leaf) => {
      if (leaf.def.kind === "relation") keys.push(leaf.key)
    })
    expect(keys).toEqual(["rel"])
  })
})

describe("walkDef", () => {
  test("visits every node with positional [] paths and list-nesting depth", () => {
    const nodes: Array<[string, string, number]> = []
    walkDef(def, (n: DefNode) => {
      nodes.push([n.path, n.def.kind, n.depth])
    })

    expect(nodes).toEqual(
      expect.arrayContaining([
        ["", "group", 0],
        ["title", "text", 0],
        ["items", "list", 0],
        ["items[]", "group", 1], // descending into a list bumps depth
        ["items[].rel", "relation", 1],
      ])
    )
  })

  test('"skip" stops descent into a node', () => {
    const buttonChildren: string[] = []
    walkDef(def, (n) => {
      if (n.def === button) return "skip"
      if (n.path.includes("cta")) buttonChildren.push(n.path)
    })
    // The button's label/link/variant are never visited.
    expect(buttonChildren).toEqual([])
  })

  test("seeds path and depth from opts", () => {
    const roots: string[] = []
    walkDef(text(), (n) => {
      roots.push(n.path)
    }, { path: "items", depth: 2 })
    expect(roots).toEqual(["items"])
  })
})

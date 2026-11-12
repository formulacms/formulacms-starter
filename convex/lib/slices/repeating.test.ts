import { describe, expect, test } from "vitest"
import { group, image, link, list, relation, richText, select, text } from "./primitives"
import {
  primaryFieldProtocol,
  primaryListFields,
  primaryListInstructions,
  primaryListTagExample,
  primaryScalarTagExample,
} from "./repeating"

const primary = group({
  stories: list(
    group({
      headline: richText({ contract: "title", heading: { role: "itemTitle" } }),
      body: richText({ contract: "inline" }),
      questions: list(group({ question: text(), answer: richText({ contract: "inline" }) }), { max: 2 }),
      image: image(),
      destination: link(),
      relatedPage: relation({ pageTypes: ["page"] }),
      style: select({ options: ["plain", "featured"], default: "plain" }),
      identity: text({ editorial: false }),
    }),
    { max: 2 }
  ),
  benefits: list(group({ label: text() }), { max: 2 }),
  steps: list(group({ description: text() }), { max: 2 }),
})

describe("primary-list descriptor policy", () => {
  test("shares canonical scalar and non-row list paths across grouped descriptors", () => {
    const protocol = primaryFieldProtocol(group({
      title: richText({ contract: "title", heading: { role: "sliceTitle" } }),
      intro: group({ label: text() }),
      aside: group({ label: text() }),
      stories: list(group({ headline: richText({ contract: "title", heading: { role: "itemTitle" } }), questions: list(group({ answer: text() }), { max: 2 }) }), { max: 2 }),
      grouped: group({ benefits: list(group({ title: text() }), { max: 2 }) }),
    }))

    expect(protocol.scalars.map(({ path, legacyAlias }) => [path, legacyAlias])).toEqual([
      ["primary.title", "title"],
      ["primary.intro.label", undefined],
      ["primary.aside.label", undefined],
    ])
    expect(protocol.lists.map(({ path }) => path)).toEqual([
      "primary.stories",
      "primary.stories[].questions",
      "primary.grouped.benefits",
    ])
    expect(primaryScalarTagExample("primary.intro.label")).toBe(
      "[primary.intro.label]...editorial value...[/primary.intro.label]"
    )
    expect(primaryListTagExample("primary.grouped.benefits")).toBe(
      "[primary.grouped.benefits]...JSON rows...[/primary.grouped.benefits]"
    )
  })

  test("discovers named lists through groups and list rows", () => {
    expect(primaryListFields(primary).map(({ path }) => path)).toEqual([
      "primary.stories",
      "primary.stories[].questions",
      "primary.benefits",
      "primary.steps",
    ])
  })

  test("documents root blocks and nested JSON shape without structural fields", () => {
    const instructions = primaryListInstructions(primary)
    expect(instructions).toContain("primary.stories")
    expect(instructions).toContain("primary.benefits")
    expect(instructions).toContain("primary.steps")
    expect(instructions).toContain('"questions":[{"question":"Editorial text","answer":"Editorial text"}]')
    expect(instructions).not.toContain("[primary.stories[].questions]")
    expect(instructions).toContain("section-owned by default")
    for (const structural of ["image", "destination", "relatedPage", "style", "identity"])
      expect(instructions).not.toContain(structural)
  })
})

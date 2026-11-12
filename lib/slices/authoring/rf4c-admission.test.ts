import { describe, expect, test } from "vitest"
import { validateStrict } from "@/convex/lib/richtext/strict"
import { parseSliceSpecJson } from "./persist"
import { assertNewSlicePolicy } from "./factory-policy"
import { resolveSliceSpecPreview } from "./scaffold"

// Follow the authoring input through admission into its actual fixture builder.
function fixture(config: Record<string, unknown>) {
  const spec = parseSliceSpecJson(
    JSON.stringify({
      type: "rf4c-fixture",
      label: "RF4c fixture",
      description: "Contract admission fixture",
      icon: "Layers",
      group: "misc",
      primary: {
        kind: "group",
        fields: {
          cards: {
            kind: "list",
            config: { min: 1, max: 2 },
            item: {
              kind: "group",
              fields: { title: { kind: "richText", config } },
            },
          },
        },
      },
    })
  )
  assertNewSlicePolicy(spec)
  return resolveSliceSpecPreview(spec)
}

describe("RF4c admission into fixture generation", () => {
  test.each([
    { contract: "title", profile: "inline", heading: { role: "itemTitle" } },
    { contract: "inline", profile: "full" },
    { contract: "inline", profile: 42 },
  ])("RF4c refuses conflicting or invalid profile metadata: %j", (config) => {
    expect(() => fixture(config)).toThrow(
      /conflicts with profile|config.profile/
    )
  })

  test.each([42, null, "", "   "])(
    "RF4c refuses malformed repeated-title parent metadata: %j",
    (parent) => {
      expect(() =>
        fixture({
          contract: "title",
          heading: { role: "itemTitle", parent },
        })
      ).toThrow(/heading.parent/)
    }
  )

  test.each([
    { contract: "title", heading: { role: "itemTitle" } },
    { profile: "inline" },
    { contract: "inline", profile: "inline" },
  ])("RF4c keeps valid contract and alias fixtures canonical: %j", (config) => {
    const preview = fixture(config)
    const title = (preview.primary as { cards: Array<{ title: string }> })
      .cards[0].title
    const contract = config.contract === "title" ? "title" : "inline"
    expect(validateStrict(contract, title)).toEqual({ ok: true })
    if (contract === "title")
      expect(JSON.parse(title).content[0].attrs.level).toBe(3)
  })
})

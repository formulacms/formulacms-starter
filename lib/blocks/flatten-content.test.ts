import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import type { Block } from "@/convex/lib/blocks"
import { heroWithImageDef } from "@/convex/lib/blocks/heroWithImage"
import { flattenBlockContent } from "./flatten-content"

describe("typed block target entries", () => {
  test("retains empty text, rich text, image and repeated leaves for outline reachability", blockProfile([]), () => {
    const block: Block = {
      id: "example",
      type: "hero-with-image",
      enabled: true,
      primary: {
        ...heroWithImageDef.preview.primary,
        eyebrow: "",
        eyebrowLinkLabel: "",
        title: "",
        description: "",
        image: { url: "", alt: "" },
      },
      items: [{ ...heroWithImageDef.preview.items[0], label: "" }],
    }
    expect(flattenBlockContent(block)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "primary.eyebrow",
          text: "",
          kind: "text",
        }),
        expect.objectContaining({
          path: "primary.eyebrowLinkLabel",
          text: "",
          kind: "text",
        }),
        expect.objectContaining({
          path: "primary.title",
          text: "",
          kind: "richText",
        }),
        expect.objectContaining({
          path: "primary.image",
          text: "",
          kind: "image",
        }),
        expect.objectContaining({
          path: "items[0].label",
          text: "",
          kind: "text",
        }),
      ])
    )
  })

  test("duplicate values keep distinct typed paths", blockProfile([]), () => {
    const block: Block = {
      id: "example",
      type: "hero-with-image",
      enabled: true,
      primary: {
        ...heroWithImageDef.preview.primary,
        eyebrow: "We're hiring!",
        eyebrowLinkLabel: "We're hiring!",
      },
      items: heroWithImageDef.preview.items,
    }
    expect(
      flattenBlockContent(block)
        .filter((entry) => entry.text === "We're hiring!")
        .map((entry) => entry.path)
    ).toEqual(["primary.eyebrow", "primary.eyebrowLinkLabel"])
  })
})

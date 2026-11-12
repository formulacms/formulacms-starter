import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import type { Slice } from "@/convex/lib/slices"
import { heroWithImageDef } from "@/convex/lib/slices/heroWithImage"
import { flattenSliceContent } from "./flatten-content"

describe("typed slice target entries", () => {
  test("retains empty text, rich text, image and repeated leaves for outline reachability", sliceProfile([]), () => {
    const slice: Slice = {
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
    expect(flattenSliceContent(slice)).toEqual(
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

  test("duplicate values keep distinct typed paths", sliceProfile([]), () => {
    const slice: Slice = {
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
      flattenSliceContent(slice)
        .filter((entry) => entry.text === "We're hiring!")
        .map((entry) => entry.path)
    ).toEqual(["primary.eyebrow", "primary.eyebrowLinkLabel"])
  })
})

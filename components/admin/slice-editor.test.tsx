import { sliceProfile } from "@/test-utils/slice-profile"
import { expect, test } from "vitest"
import {
  sliceDefs,
  type HeroAgencySlice,
  type Slice,
} from "@/convex/lib/slices"
import { EMPTY_PM_DOC } from "@/convex/lib/slices/primitives"
import { mergeSliceText, sliceHasContent } from "./slice-editor-text"

function hero(id: string, buttonId: string, label: string): HeroAgencySlice {
  return {
    id,
    type: "hero-agency",
    enabled: true,
    primary: {
      eyebrow: "",
      title: EMPTY_PM_DOC,
      description: EMPTY_PM_DOC,
    },
    items: [
      {
        id: buttonId,
        label,
        link: { type: "none" },
        variant: "primary",
        withIcon: false,
        enabled: true,
      },
    ],
  }
}

test("whole-slice copy replaces button copy without replacing its identity", sliceProfile([]), () => {
  const target = hero("target-slice", "target-button", "Target label")
  const source = hero("source-slice", "source-button", "Source label")
  const changed = mergeSliceText(
    target,
    source,
    sliceDefs[target.type].primary,
    "copy"
  ) as HeroAgencySlice

  expect(changed.items[0]).toEqual(
    expect.objectContaining({ id: "target-button", label: "Source label" })
  )
})

test.each(["translate", "write"] as const)(
  "whole-slice %s replaces button copy without replacing its identity", sliceProfile([]),
  (mode) => {
    const target = hero("target-slice", "target-button", "Target label")
    const source = hero("source-slice", "source-button", "Source label")
    const changed = mergeSliceText(
      target,
      source,
      sliceDefs[target.type].primary,
      mode
    ) as HeroAgencySlice

    expect(changed.items[0]).toEqual(
      expect.objectContaining({ id: "target-button", label: "Source label" })
    )
  }
)

test("whole-slice merge keeps a source-only button and its producer identity", sliceProfile([]), () => {
  const target = hero("target-slice", "target-button", "Target label")
  const source = hero("source-slice", "source-button", "Source label")
  source.items.push({
    id: "generated-button",
    label: "Generated label",
    link: { type: "none" },
    variant: "primary",
    withIcon: false,
    enabled: true,
  })

  const changed = mergeSliceText(
    target,
    source,
    sliceDefs[target.type].primary,
    "write"
  ) as HeroAgencySlice

  expect(changed.items[1]).toEqual(
    expect.objectContaining({
      id: "generated-button",
      label: "Generated label",
    })
  )
})

test("button identity alone does not count as editor-authored copy", sliceProfile([]), () => {
  const target = hero("target-slice", "target-button", "")

  expect(sliceHasContent(target, sliceDefs[target.type].primary)).toBe(false)
})

test("hero title declares the adopted slice title contract", sliceProfile([]), () => {
  const title = (
    sliceDefs["hero-agency"].primary.config as {
      fields: Record<string, { kind: string; config: Record<string, unknown> }>
    }
  ).fields.title

  expect(title.kind).toBe("richText")
  expect(title.config.contract).toBe("title")
  expect(title.config.heading).toEqual({ role: "sliceTitle" })
})

test("slice text merge projects a registered FAQ title and preserves itemId", sliceProfile([]), () => {
  const title = JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text: "New question" }],
      },
    ],
  })
  const target: Extract<Slice, { type: "faq-simple" }> = {
    id: "faq",
    type: "faq-simple",
    enabled: true,
    primary: { heading: "FAQ", eyebrow: "", body: "" },
    items: [{ itemId: "stable", question: "Old question", answer: "" }],
  }
  const source: Extract<Slice, { type: "faq-simple" }> = {
    ...target,
    items: [{ itemId: "stable", question: title, answer: "" }],
  }
  const result = mergeSliceText(target, source, sliceDefs["faq-simple"].primary)
  if (result.type !== "faq-simple")
    throw new Error("FAQ merge must preserve the slice type")
  expect(result.items[0]).toEqual({
    itemId: "stable",
    question: title,
    answer: "",
  })
})

import { blockProfile } from "@/test-utils/block-profile"
import { expect, test } from "vitest"
import {
  blockDefs,
  type HeroAgencyBlock,
  type Block,
} from "@/convex/lib/blocks"
import { EMPTY_PM_DOC } from "@/convex/lib/blocks/primitives"
import { mergeBlockText, blockHasContent } from "./block-editor-text"

function hero(id: string, buttonId: string, label: string): HeroAgencyBlock {
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

test("whole-block copy replaces button copy without replacing its identity", blockProfile([]), () => {
  const target = hero("target-block", "target-button", "Target label")
  const source = hero("source-block", "source-button", "Source label")
  const changed = mergeBlockText(
    target,
    source,
    blockDefs[target.type].primary,
    "copy"
  ) as HeroAgencyBlock

  expect(changed.items[0]).toEqual(
    expect.objectContaining({ id: "target-button", label: "Source label" })
  )
})

test.each(["translate", "write"] as const)(
  "whole-block %s replaces button copy without replacing its identity", blockProfile([]),
  (mode) => {
    const target = hero("target-block", "target-button", "Target label")
    const source = hero("source-block", "source-button", "Source label")
    const changed = mergeBlockText(
      target,
      source,
      blockDefs[target.type].primary,
      mode
    ) as HeroAgencyBlock

    expect(changed.items[0]).toEqual(
      expect.objectContaining({ id: "target-button", label: "Source label" })
    )
  }
)

test("whole-block merge keeps a source-only button and its producer identity", blockProfile([]), () => {
  const target = hero("target-block", "target-button", "Target label")
  const source = hero("source-block", "source-button", "Source label")
  source.items.push({
    id: "generated-button",
    label: "Generated label",
    link: { type: "none" },
    variant: "primary",
    withIcon: false,
    enabled: true,
  })

  const changed = mergeBlockText(
    target,
    source,
    blockDefs[target.type].primary,
    "write"
  ) as HeroAgencyBlock

  expect(changed.items[1]).toEqual(
    expect.objectContaining({
      id: "generated-button",
      label: "Generated label",
    })
  )
})

test("button identity alone does not count as editor-authored copy", blockProfile([]), () => {
  const target = hero("target-block", "target-button", "")

  expect(blockHasContent(target, blockDefs[target.type].primary)).toBe(false)
})

test("hero title declares the adopted block title contract", blockProfile([]), () => {
  const title = (
    blockDefs["hero-agency"].primary.config as {
      fields: Record<string, { kind: string; config: Record<string, unknown> }>
    }
  ).fields.title

  expect(title.kind).toBe("richText")
  expect(title.config.contract).toBe("title")
  expect(title.config.heading).toEqual({ role: "blockTitle" })
})

test("block text merge projects a registered FAQ title and preserves itemId", blockProfile([]), () => {
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
  const target: Extract<Block, { type: "faq-simple" }> = {
    id: "faq",
    type: "faq-simple",
    enabled: true,
    primary: { heading: "FAQ", eyebrow: "", body: "" },
    items: [{ itemId: "stable", question: "Old question", answer: "" }],
  }
  const source: Extract<Block, { type: "faq-simple" }> = {
    ...target,
    items: [{ itemId: "stable", question: title, answer: "" }],
  }
  const result = mergeBlockText(target, source, blockDefs["faq-simple"].primary)
  if (result.type !== "faq-simple")
    throw new Error("FAQ merge must preserve the block type")
  expect(result.items[0]).toEqual({
    itemId: "stable",
    question: title,
    answer: "",
  })
})

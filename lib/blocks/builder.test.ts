import { blockProfileAny, blockProfile, createInstalledDefaultBlock } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { validate } from "convex-helpers/validators"
import { BLOCK_GROUPS, BLOCK_METADATA, BLOCK_TYPES, type BlockMetadata } from "./builder"
import { blockValidator } from "@/convex/lib/blocks"

describe("createDefaultBlock", () => {
  test.skipIf(BLOCK_TYPES.length === 0).each(BLOCK_TYPES)("%s default is schema-valid", blockProfileAny(BLOCK_TYPES), (type) => {
    const block = createInstalledDefaultBlock(type)
    expect(block.type).toBe(type)
    expect(typeof block.id).toBe("string")
    expect(block.enabled).toBe(true)
    // Throws (failing the test) if the default violates the block union.
    expect(validate(blockValidator, block, { throw: true })).toBe(true)
  })

  test("defaults include every registered primary field", blockProfile(["hero-agency"]), () => {
    const hero = createInstalledDefaultBlock("hero-agency")
    expect(hero.primary).toEqual({
      eyebrow: "",
      title:
        '{"type":"doc","content":[{"type":"heading","attrs":{"level":2}}]}',
      description: '{"type":"doc","content":[{"type":"paragraph"}]}',
    })
  })

  test("defaults are cloned per call — no shared references", blockProfile(["hero-agency"]), () => {
    const a = createInstalledDefaultBlock("hero-agency")
    const b = createInstalledDefaultBlock("hero-agency")
    expect(a.primary).not.toBe(b.primary)
    expect((a as { items: unknown[] }).items).not.toBe(
      (b as { items: unknown[] }).items
    )
    // Mutating one must not leak into the other.
    ;(a.primary as { title: string }).title = "changed"
    expect((b.primary as { title: string }).title).toBe(
      '{"type":"doc","content":[{"type":"heading","attrs":{"level":2}}]}'
    )
  })
})

describe("block picker taxonomy", () => {
  test("exposes the governed picker groups in scan order", () => {
    expect(BLOCK_GROUPS).toEqual([
      { id: "heroes", label: "Heroes" },
      { id: "cta", label: "CTA" },
      { id: "faq", label: "FAQ" },
      { id: "features", label: "Features" },
      { id: "forms", label: "Forms" },
      { id: "body-copy", label: "Body copy" },
      { id: "misc", label: "Misc" },
    ])
  })

  test("homes shipped forms and body copy outside the misc fallback", blockProfile(["rich-text-body"]), () => {
    expect(BLOCK_METADATA["rich-text-body"]!.group).toBe("body-copy")
    // FR2b rows S and F: the Community blueprint registers neither
    // `contact-form` nor `site-search`, so look them up through a widened key
    // and check each where it is registered.
    const optionalMetadata: Partial<Record<string, BlockMetadata>> =
      BLOCK_METADATA
    for (const [type, group] of [
      ["contact-form", "forms"],
      ["site-search", "misc"],
    ] as const) {
      const metadata = optionalMetadata[type]
      if (metadata) expect(metadata.group, type).toBe(group)
    }
  })
})

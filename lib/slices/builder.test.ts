import { sliceProfileAny, sliceProfile, createInstalledDefaultSlice } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { validate } from "convex-helpers/validators"
import { SLICE_GROUPS, SLICE_METADATA, SLICE_TYPES, type SliceMetadata } from "./builder"
import { sliceValidator } from "@/convex/lib/slices"

describe("createDefaultSlice", () => {
  test.skipIf(SLICE_TYPES.length === 0).each(SLICE_TYPES)("%s default is schema-valid", sliceProfileAny(SLICE_TYPES), (type) => {
    const slice = createInstalledDefaultSlice(type)
    expect(slice.type).toBe(type)
    expect(typeof slice.id).toBe("string")
    expect(slice.enabled).toBe(true)
    // Throws (failing the test) if the default violates the slice union.
    expect(validate(sliceValidator, slice, { throw: true })).toBe(true)
  })

  test("defaults include every registered primary field", sliceProfile(["hero-agency"]), () => {
    const hero = createInstalledDefaultSlice("hero-agency")
    expect(hero.primary).toEqual({
      eyebrow: "",
      title:
        '{"type":"doc","content":[{"type":"heading","attrs":{"level":2}}]}',
      description: '{"type":"doc","content":[{"type":"paragraph"}]}',
    })
  })

  test("defaults are cloned per call — no shared references", sliceProfile(["hero-agency"]), () => {
    const a = createInstalledDefaultSlice("hero-agency")
    const b = createInstalledDefaultSlice("hero-agency")
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

describe("slice picker taxonomy", () => {
  test("exposes the governed picker groups in scan order", () => {
    expect(SLICE_GROUPS).toEqual([
      { id: "heroes", label: "Heroes" },
      { id: "cta", label: "CTA" },
      { id: "faq", label: "FAQ" },
      { id: "features", label: "Features" },
      { id: "forms", label: "Forms" },
      { id: "body-copy", label: "Body copy" },
      { id: "misc", label: "Misc" },
    ])
  })

  test("homes shipped forms and body copy outside the misc fallback", sliceProfile(["rich-text-body"]), () => {
    expect(SLICE_METADATA["rich-text-body"]!.group).toBe("body-copy")
    // FR2b rows S and F: the Community blueprint registers neither
    // `contact-form` nor `site-search`, so look them up through a widened key
    // and check each where it is registered.
    const optionalMetadata: Partial<Record<string, SliceMetadata>> =
      SLICE_METADATA
    for (const [type, group] of [
      ["contact-form", "forms"],
      ["site-search", "misc"],
    ] as const) {
      const metadata = optionalMetadata[type]
      if (metadata) expect(metadata.group, type).toBe(group)
    }
  })
})

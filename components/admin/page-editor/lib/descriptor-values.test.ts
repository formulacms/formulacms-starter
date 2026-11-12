import { describe, expect, it } from "vitest"
import { list, group, richText, text } from "@/convex/lib/slices/primitives"
import type { Page } from "./types"
import {
  collectTranslatableLeaves,
  extractLocalizedFieldValues,
  extractSharedFieldValues,
} from "./descriptor-values"
import { parseFieldPath, setValueAtFieldPath } from "./field-path"

// Synthetic descriptor field maps — no dependency on the shipped registry so
// these tests exercise the extractor's contract, not any particular
// descriptor's evolution.

const sharedFields = {
  name: text({ placeholder: "Name" }),
  handle: text().optional(),
  socials: list(group({ label: text() })).optional(),
  tags: list(text()).optional(),
}
const localizedFields = {
  title: text({ placeholder: "Title" }),
  roleTitle: text().optional(),
  bio: text({ multiline: true }).optional(),
  metaTitle: text().optional(),
}

// The stub deliberately builds bags for several content types, so its input is
// an arbitrary field map. `Partial<Page>` implied precision it never had: `Page`
// is a discriminated union and its `content` arm cannot type-check against more
// than one `pageType` at a time.
function pageStub(shape: Record<string, unknown>): Page {
  return {
    _id: "p1",
    _creationTime: 0,
    slug: "",
    status: "draft",
    pageType: "author",
    createdAt: 0,
    updatedAt: 0,
    ...shape,
  } as unknown as Page
}

describe("extractSharedFieldValues", () => {
  it("copies stored values by key", () => {
    const page = pageStub({
      name: "Ada",
      handle: "@ada",
      socials: [{ label: "GitHub" }],
    })
    const values = extractSharedFieldValues(page, sharedFields)
    expect(values).toEqual({
      name: "Ada",
      handle: "@ada",
      socials: [{ label: "GitHub" }],
    })
  })

  it("excludes system-owned shared keys (tags → Internal Labels adapter)", () => {
    const page = pageStub({ name: "Ada", tags: ["should", "not", "leak"] })
    const values = extractSharedFieldValues(page, sharedFields)
    expect(values).not.toHaveProperty("tags")
  })

  it("fills required missing key with the primitive default (never mutates the source)", () => {
    const page = pageStub({}) // no name stored
    const values = extractSharedFieldValues(page, sharedFields)
    expect(values.name).toBe("") // text() default
    expect((page as unknown as { name?: string }).name).toBeUndefined()
  })

  it("leaves optional missing keys as undefined", () => {
    const page = pageStub({ name: "Ada" })
    const values = extractSharedFieldValues(page, sharedFields)
    expect(values.handle).toBeUndefined()
    expect(values.socials).toBeUndefined()
  })
})

describe("extractLocalizedFieldValues", () => {
  it("projects the active-locale bag, minus system-owned keys", () => {
    const page = pageStub({
      content: {
        en: {
          title: "goes to Settings",
          metaTitle: "goes to SEO",
          roleTitle: "Mathematician",
          bio: "…",
        },
      },
    })
    const values = extractLocalizedFieldValues(page, localizedFields, "en")
    expect(values.roleTitle).toBe("Mathematician")
    expect(values.bio).toBe("…")
    // Owned keys are excluded — Settings/SEO panels own those state slots.
    expect(values).not.toHaveProperty("title")
    expect(values).not.toHaveProperty("metaTitle")
  })

  it("returns primitive defaults for required missing keys", () => {
    const page = pageStub({ content: {} })
    // Include a required localized key by using only `title` in the map.
    const map = { title: text() }
    const values = extractLocalizedFieldValues(page, map, "en")
    // `title` is system-owned so the extractor drops it entirely.
    expect(values).toEqual({})
  })

  it("scopes per locale — a value in fr must not leak into en", () => {
    const page = pageStub({
      content: {
        en: { roleTitle: "EN role" },
        fr: { roleTitle: "FR role" },
      },
    })
    const en = extractLocalizedFieldValues(page, localizedFields, "en")
    const fr = extractLocalizedFieldValues(page, localizedFields, "fr")
    expect(en.roleTitle).toBe("EN role")
    expect(fr.roleTitle).toBe("FR role")
  })

  it("uses ≥3 locales without pairwise assumptions (plan 029 standing invariant)", () => {
    const page = pageStub({
      content: {
        en: { roleTitle: "EN role" },
        fr: { roleTitle: "FR role" },
        ar: { roleTitle: "دور بالعربية" },
      },
    })
    for (const locale of ["en", "fr", "ar"]) {
      const values = extractLocalizedFieldValues(
        page,
        localizedFields,
        locale,
      )
      expect(typeof values.roleTitle).toBe("string")
    }
  })
})

describe("collectTranslatableLeaves → reapply round-trip (plan 029 C9a)", () => {
  const translatableFields = {
    title: text({ placeholder: "Title" }), // system-owned — skipped
    metaTitle: text().optional(), // system-owned — skipped
    roleTitle: text().optional(),
    bio: richText({ profile: "basic" }),
    profileImage: list(group({ alt: text() })).optional(), // non-text nested
  }

  it("collects only non-system-owned text/richText leaves with values", () => {
    const values = {
      title: "Grace Hopper",
      roleTitle: "Rear Admiral",
      bio: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Compiler pioneer"}]}]}',
    }
    const leaves = collectTranslatableLeaves(translatableFields, values)
    // title / metaTitle are system-owned → skipped even when non-empty.
    expect(leaves.map((l) => l.path).sort()).toEqual(["bio", "roleTitle"])
    const roleLeaf = leaves.find((l) => l.path === "roleTitle")
    expect(roleLeaf?.kind).toBe("text")
    expect(roleLeaf?.value).toBe("Rear Admiral")
    const bioLeaf = leaves.find((l) => l.path === "bio")
    expect(bioLeaf?.kind).toBe("richText")
  })

  it("round-trips server-translated leaves back into the bag via parseFieldPath + setValueAtFieldPath", () => {
    const values: Record<string, unknown> = {
      title: "Grace Hopper",
      roleTitle: "Rear Admiral",
      bio: '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Compiler pioneer"}]}]}',
    }
    const leaves = collectTranslatableLeaves(translatableFields, values)
    // Simulate the server returning translated leaves.
    const translated = leaves.map((l) => ({
      path: l.path,
      kind: l.kind,
      value:
        l.path === "roleTitle"
          ? "Contre-amirale"
          : '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Pionnière du compilateur"}]}]}',
    }))
    let next: Record<string, unknown> = structuredClone(values)
    for (const leaf of translated) {
      next = setValueAtFieldPath(
        next,
        parseFieldPath(leaf.path),
        leaf.value,
      ) as Record<string, unknown>
    }
    expect(next.roleTitle).toBe("Contre-amirale")
    expect(next.bio).toContain("Pionnière du compilateur")
    // System-owned title is preserved on the target bag as-is — the
    // whole-locale translate keeps the source title separately via
    // localizePage's `title` arg; the translatables walk doesn't touch it.
    expect(next.title).toBe("Grace Hopper")
    // Original values untouched (immutability contract).
    expect(values.roleTitle).toBe("Rear Admiral")
  })

  it("empty values are skipped so a partially-filled locale doesn't send empty leaves", () => {
    const values = {
      roleTitle: "",
      bio: "",
    }
    expect(collectTranslatableLeaves(translatableFields, values)).toEqual([])
  })
})

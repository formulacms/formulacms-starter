import { describe, expect, it } from "vitest"
import { authorContentType } from "@/convex/lib/contentTypes/author"
import { postContentType } from "@/convex/lib/contentTypes/post"
import { pageContentType } from "@/convex/lib/contentTypes/page"
import {
  SYSTEM_OWNED_LOCALIZED_FIELDS,
  SYSTEM_OWNED_SHARED_FIELDS,
  filterOwnedFields,
  isSystemOwnedLocalizedField,
  isSystemOwnedSharedField,
} from "./system-owned-fields"

// The ownership map is load-bearing: the C8 generic Content panel skips any
// key here, so a missed system-panel key would double-render title/meta or
// duplicate a settings control. These assertions pin the guarantee against
// each registered descriptor's declared field set.

describe("system-owned-fields", () => {
  it("covers title/metaTitle/metaDescription — every registered localized panel", () => {
    for (const key of ["title", "metaTitle", "metaDescription"]) {
      expect(isSystemOwnedLocalizedField(key)).toBe(true)
    }
    expect(isSystemOwnedLocalizedField("roleTitle")).toBe(false)
    expect(isSystemOwnedLocalizedField("bio")).toBe(false)
  })

  it("marks post.tags + post.authorIds as system-owned (Internal Labels + bespoke byline picker)", () => {
    expect(isSystemOwnedSharedField("tags")).toBe(true)
    expect(isSystemOwnedSharedField("authorIds")).toBe(true)
    expect(isSystemOwnedSharedField("category")).toBe(false)
  })

  it("filterOwnedFields drops matching keys, preserves insertion order", () => {
    const input = { a: 1, b: 2, c: 3, tags: 99 }
    const filtered = filterOwnedFields(input, new Set(["b", "tags"]))
    expect(Object.keys(filtered)).toEqual(["a", "c"])
    expect(filtered).toEqual({ a: 1, c: 3 })
  })

  it("author descriptor has no system-owned shared fields (name / socials both authorable)", () => {
    for (const key of Object.keys(authorContentType.sharedFields)) {
      expect(SYSTEM_OWNED_SHARED_FIELDS.has(key)).toBe(false)
    }
  })

  it("post descriptor: tags + authorIds are system-owned; category flows through the generic panel", () => {
    expect(SYSTEM_OWNED_SHARED_FIELDS.has("tags")).toBe(true)
    expect(SYSTEM_OWNED_SHARED_FIELDS.has("authorIds")).toBe(true)
    expect(SYSTEM_OWNED_SHARED_FIELDS.has("category")).toBe(false)
  })

  it("post's byline field is really named 'authorIds' in the descriptor — guards against another stale-key drift", () => {
    // Regression guard: `SYSTEM_OWNED_SHARED_FIELDS` once held the stale
    // singular `"authorId"` after the descriptor renamed to plural
    // `authorIds`, so the set silently stopped matching and the field
    // leaked through the generic panel as a duplicate control. Assert
    // directly against the descriptor's real key set instead of a
    // hardcoded string so a future rename fails loudly here.
    expect(Object.keys(postContentType.sharedFields)).toContain("authorIds")
    expect(SYSTEM_OWNED_SHARED_FIELDS.has("authorIds")).toBe(true)
    // `featured` / `promoteToFront` are deliberately NOT system-owned —
    // they flow through the generic Content panel (task 15's badge reads
    // the same `featured` value).
    expect(SYSTEM_OWNED_SHARED_FIELDS.has("featured")).toBe(false)
    expect(SYSTEM_OWNED_SHARED_FIELDS.has("promoteToFront")).toBe(false)
  })

  it("page descriptor has no shared fields; localized title/meta stay system-owned", () => {
    // Sanity — page descriptor is empty sharedFields, three localized keys
    // that are all system-owned. Generic panel renders nothing for page.
    expect(Object.keys(pageContentType.sharedFields)).toEqual([])
    for (const key of Object.keys(pageContentType.localizedFields)) {
      expect(SYSTEM_OWNED_LOCALIZED_FIELDS.has(key)).toBe(true)
    }
  })

  it("post descriptor: every declared localized field is system-owned in C8 scope", () => {
    // Post's localized set is {title, metaTitle, metaDescription} today —
    // all owned by SEO/Settings. Generic panel's active-locale section is
    // empty for post. When C10+ adds excerpt/body, this test tightens.
    for (const key of Object.keys(postContentType.localizedFields)) {
      expect(SYSTEM_OWNED_LOCALIZED_FIELDS.has(key)).toBe(true)
    }
  })

  it("author descriptor: roleTitle + bio are NOT system-owned (generic panel renders them)", () => {
    expect(isSystemOwnedLocalizedField("roleTitle")).toBe(false)
    expect(isSystemOwnedLocalizedField("bio")).toBe(false)
  })
})

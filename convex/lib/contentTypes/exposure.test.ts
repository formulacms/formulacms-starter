import { describe, expect, it } from "vitest"
import { group, list, text } from "../slices/primitives"
import { contentTypeDefs } from "./index"
import { isDescriptorFieldPublic, publicFieldsOf } from "./exposure"

/**
 * Regression test for the ADR-0038 exposure contract.
 *
 * Two layers:
 * 1. Reader mechanics — `.public()` marks the primitive; the reader is
 *    fail-closed (undefined → false).
 * 2. Descriptor-by-descriptor classification — every currently-shipped
 *    descriptor's public fields are asserted by name. A future refactor that
 *    silently drops `.public()` on `authorIds` or `metaTitle` fails here
 *    rather than dropping the field from search/render at runtime.
 *
 * Update this test in the SAME PR as any classification change. That is the
 * point of the test — it exists to catch silent drift.
 */

describe("ADR-0038 exposure reader mechanics", () => {
  it("unmarked field is admin-only (fail-closed default)", () => {
    expect(isDescriptorFieldPublic(text())).toBe(false)
  })

  it(".public() opts a field into public surfaces", () => {
    expect(isDescriptorFieldPublic(text().public())).toBe(true)
  })

  it(".public() and .optional() compose in either order", () => {
    expect(isDescriptorFieldPublic(text().optional().public())).toBe(true)
    expect(isDescriptorFieldPublic(text().public().optional())).toBe(true)
  })

  it("preserves the leaf kind and validator through .public()", () => {
    const primitive = text({ multiline: true }).public()
    expect(primitive.kind).toBe("text")
    expect(primitive.validator).toBeDefined()
  })

  it("groups and lists are markable at the container level", () => {
    const linksList = list(
      group({
        platform: text(),
        url: text(),
      }),
    ).public()
    expect(isDescriptorFieldPublic(linksList)).toBe(true)
  })

  it("publicFieldsOf filters and preserves iteration order", () => {
    const fields = {
      a: text().public(),
      b: text(),
      c: text().public(),
      d: text(),
    }
    const filtered = publicFieldsOf(fields)
    expect(Object.keys(filtered)).toEqual(["a", "c"])
  })
})

/**
 * Behavioral regression: every descriptor's public field surface, by name.
 *
 * `publicKeys` lists the top-level `sharedFields` + `localizedFields` keys
 * that MUST be public per plan 029 C10 addendum. `adminOnlyKeys` lists the
 * keys that MUST NOT be public. Any field not listed is unconstrained (the
 * test doesn't judge it; add it explicitly to close the gap).
 *
 * Update alongside descriptor edits.
 */
type ExposureExpectation = {
  publicKeys: string[]
  adminOnlyKeys: string[]
}

const expectations: Record<string, ExposureExpectation> = {
  page: {
    publicKeys: ["title", "metaTitle", "metaDescription"],
    adminOnlyKeys: [],
  },
  "landing-page": {
    publicKeys: ["title", "metaTitle", "metaDescription"],
    adminOnlyKeys: [],
  },
  author: {
    publicKeys: ["name", "socials", "title", "metaTitle", "metaDescription", "roleTitle"],
    adminOnlyKeys: [],
  },
  post: {
    publicKeys: [
      "authorIds",
      "category",
      "featured",
      "promoteToFront",
      "title",
      "metaTitle",
      "metaDescription",
    ],
    // Plan 029 §Recommended editor seam: `tags` is presented as
    // "Internal Labels" and never crosses the public seam. ADR-0038 §Q9.b.
    adminOnlyKeys: ["tags"],
  },
  testimonial: {
    publicKeys: [
      "personName",
      "personRole",
      "personCompany",
      "personImage",
      "sourceUrl",
      "quote",
    ],
    // `title` is the internal identifier editors see in the admin
    // ("Grace Hopper @ Yale, 1980"). It must never surface publicly —
    // fail-closed default keeps it out of every descriptor-walked
    // surface (search blob, JSON-LD, public renderer). ADR-0038 §Q9.b.
    adminOnlyKeys: ["title"],
  },
  job: {
    publicKeys: [
      "department",
      "location",
      "remoteType",
      "employmentType",
      "salaryCurrency",
      "salaryMin",
      "salaryMax",
      "applyUrl",
      "applyEmail",
      "closingDate",
      "jobStatus",
      "title",
      "summary",
    ],
    adminOnlyKeys: [],
  },
}

describe("ADR-0038 descriptor field classifications", () => {
  for (const [contentType, { publicKeys, adminOnlyKeys }] of Object.entries(expectations)) {
    it(`${contentType}: expected public fields are marked public`, () => {
      const descriptor = contentTypeDefs[contentType as keyof typeof contentTypeDefs]
      if (!descriptor) throw new Error(`Descriptor not registered: ${contentType}`)
      // Descriptor registry is a discriminated union — indexing by an
      // arbitrary string can't be narrowed here. Widen the merged field
      // bag to a lookup so the test can consume any registered descriptor
      // uniformly (the classification test is the source of truth on the
      // key names, not TS).
      const all = {
        ...descriptor.sharedFields,
        ...descriptor.localizedFields,
      } as Record<string, Parameters<typeof isDescriptorFieldPublic>[0]>
      for (const key of publicKeys) {
        const def = all[key]
        expect(def, `${contentType}.${key} missing`).toBeDefined()
        expect(isDescriptorFieldPublic(def), `${contentType}.${key} should be public`).toBe(true)
      }
    })

    it(`${contentType}: expected admin-only fields are not marked public`, () => {
      if (adminOnlyKeys.length === 0) return
      const descriptor = contentTypeDefs[contentType as keyof typeof contentTypeDefs]
      if (!descriptor) throw new Error(`Descriptor not registered: ${contentType}`)
      const all = {
        ...descriptor.sharedFields,
        ...descriptor.localizedFields,
      } as Record<string, Parameters<typeof isDescriptorFieldPublic>[0]>
      for (const key of adminOnlyKeys) {
        const def = all[key]
        expect(def, `${contentType}.${key} missing`).toBeDefined()
        expect(isDescriptorFieldPublic(def), `${contentType}.${key} should be admin-only`).toBe(false)
      }
    })
  }
})

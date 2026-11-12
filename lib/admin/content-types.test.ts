import { describe, expect, test } from "vitest"
import { CONTENT_TYPES } from "@/convex/lib/contentTypes"
import {
  adminContentTypeDetail,
  adminContentTypes,
} from "./content-types"

// A site curates which types it activates, so "the non-routable one" is not a
// fixed slug. The engine has `testimonial`; a starter may activate none, in
// which case there is nothing for this rule to be wrong about.
const nonRoutableType = CONTENT_TYPES.find(
  (type) => adminContentTypeDetail(type)?.routable === false
)

describe("admin content-type projections", () => {
  test("enumerates the active catalog and exposes client-safe detail", () => {
    const summaries = adminContentTypes()
    const author = adminContentTypeDetail("author")

    expect(summaries.map((summary) => summary.type)).toContain("author")
    expect(author).toMatchObject({
      type: "author",
      routable: true,
      pathPrefix: "authors",
    })
    expect(author?.sharedFields).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "name",
          exposure: "Shown on the site",
        }),
      ])
    )
    expect(author).not.toHaveProperty("sharedValidator")
  })

  test.skipIf(!nonRoutableType)(
    "renders non-routable active types without inventing a URL",
    () => {
      expect(adminContentTypeDetail(nonRoutableType!)).toMatchObject({
        type: nonRoutableType,
        routable: false,
        pathPrefix: null,
      })
    }
  )

  test("does not expose unknown or registered-but-inactive slugs", () => {
    expect(adminContentTypeDetail("unknown")).toBeNull()
  })
})

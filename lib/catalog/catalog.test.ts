import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, it } from "vitest"
import { catalogAssets } from "./assets"
import { getCatalogAsset, listCatalog, searchCatalog } from "./query"
import { catalogSchema } from "./schema"

describe("formulacms catalog", () => {
  it("contains valid, uniquely identified public assets", () => {
    expect(() => catalogSchema.parse(catalogAssets)).not.toThrow()
    expect(new Set(catalogAssets.map((asset) => asset.id)).size).toBe(
      catalogAssets.length
    )
    expect(catalogAssets.every((asset) => asset.visibility === "public")).toBe(
      true
    )
  })

  it("searches deterministically across names, tags, and discovery metadata", () => {
    expect(listCatalog()).toHaveLength(catalogAssets.length)
    expect(
      searchCatalog({ query: "agency services" }).map(({ id }) => id)
    ).toEqual(["block:hero-agency"])
    expect(
      searchCatalog({ query: "lead capture" }).map(({ id }) => id)
    ).toEqual(["block:contact-form"])
    expect(searchCatalog({ group: "features" }).map(({ id }) => id)).toEqual([
      "block:features-icon-grid",
    ])
  })

  it("gets an asset by stable ID or slug and fails closed for unknown IDs", blockProfile([]), () => {
    expect(getCatalogAsset("block:hero-agency")?.slug).toBe("hero-agency")
    expect(getCatalogAsset("HERO-AGENCY")?.id).toBe("block:hero-agency")
    expect(getCatalogAsset("block:not-real")).toBeUndefined()
  })
})

import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, it } from "vitest"
import { comparisonSnapshotUrl, thumbnailUrl } from "./thumbnails"

describe("comparisonSnapshotUrl", () => {
  it("is a distinct artifact from the catalog thumbnail", blockProfile([]), () => {
    expect(thumbnailUrl("hero-agency")).toBe("/block-sim/hero-agency.png")
    expect(comparisonSnapshotUrl("hero-agency")).toBe(
      "/block-sim/hero-agency.full.png"
    )
  })

  it("keeps mobile and before variants separable", blockProfile([]), () => {
    expect(comparisonSnapshotUrl("hero-agency", "mobile")).toBe(
      "/block-sim/hero-agency.mobile.full.png"
    )
    expect(
      comparisonSnapshotUrl("hero-agency", "desktop", "before")
    ).toBe("/block-sim/hero-agency.full.before.png")
    expect(
      comparisonSnapshotUrl("hero-agency", "mobile", "before")
    ).toBe("/block-sim/hero-agency.mobile.full.before.png")
  })
})

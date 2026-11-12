import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it } from "vitest"
import { comparisonSnapshotUrl, thumbnailUrl } from "./thumbnails"

describe("comparisonSnapshotUrl", () => {
  it("is a distinct artifact from the catalog thumbnail", sliceProfile([]), () => {
    expect(thumbnailUrl("hero-agency")).toBe("/slice-sim/hero-agency.png")
    expect(comparisonSnapshotUrl("hero-agency")).toBe(
      "/slice-sim/hero-agency.full.png"
    )
  })

  it("keeps mobile and before variants separable", sliceProfile([]), () => {
    expect(comparisonSnapshotUrl("hero-agency", "mobile")).toBe(
      "/slice-sim/hero-agency.mobile.full.png"
    )
    expect(
      comparisonSnapshotUrl("hero-agency", "desktop", "before")
    ).toBe("/slice-sim/hero-agency.full.before.png")
    expect(
      comparisonSnapshotUrl("hero-agency", "mobile", "before")
    ).toBe("/slice-sim/hero-agency.mobile.full.before.png")
  })
})

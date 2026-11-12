import { describe, expect, it } from "vitest"
import type { Doc } from "../../_generated/dataModel"
import { hasSliceBody } from "./sliceBodyContent"

describe("hasSliceBody", () => {
  it("derives the decision from the registered descriptor capability", () => {
    expect(
      hasSliceBody({ pageType: "author" } as Doc<"pages">)
    ).toBe(true)
    expect(
      hasSliceBody({ pageType: "testimonial" } as Doc<"pages">)
    ).toBe(false)
  })
})

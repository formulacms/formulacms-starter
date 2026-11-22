import { describe, expect, it } from "vitest"
import type { Doc } from "../../_generated/dataModel"
import { hasBlockBody } from "./blockBodyContent"

describe("hasBlockBody", () => {
  it("derives the decision from the registered descriptor capability", () => {
    expect(
      hasBlockBody({ pageType: "author" } as Doc<"pages">)
    ).toBe(true)
    expect(
      hasBlockBody({ pageType: "testimonial" } as Doc<"pages">)
    ).toBe(false)
  })
})

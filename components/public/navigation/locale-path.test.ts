import { describe, expect, it } from "vitest"
import { localePath } from "./locale-path"

describe("localePath", () => {
  it("preserves a page route when switching to a non-default locale", () => {
    expect(localePath("es", "en", "/contact")).toBe("/es/contact")
  })

  it("keeps default-locale routes unprefixed and handles locale roots", () => {
    expect(localePath("en", "en", "/contact")).toBe("/contact")
    expect(localePath("es", "en", "/")).toBe("/es")
  })
})

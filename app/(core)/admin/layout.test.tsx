import { describe, expect, it } from "vitest"
import * as adminLayout from "./layout"

describe("admin layout metadata", () => {
  it("provides a document title for every admin route", () => {
    expect(adminLayout).toHaveProperty("metadata")
    expect(
      (adminLayout as typeof adminLayout & {
        metadata?: { title?: unknown }
      }).metadata?.title
    ).toBe("formulacms admin")
  })
})

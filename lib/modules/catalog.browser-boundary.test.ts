import { describe, expect, it } from "vitest"
import { MODULE_CATALOG, validateModuleCatalog } from "./catalog"

describe("browser-safe module catalog boundary", () => {
  it("imports and validates static metadata in the edge runtime", () => {
    expect(validateModuleCatalog(MODULE_CATALOG)).toEqual(MODULE_CATALOG)
    expect(MODULE_CATALOG).toHaveLength(11)
  })
})

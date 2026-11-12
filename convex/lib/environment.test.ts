import { describe, expect, test } from "vitest"
import { resolveOwnerClaim } from "./environment"

describe("Convex environment compatibility", () => {
  test("resolves a non-empty formulacms owner claim before the legacy claim", () => {
    expect(
      resolveOwnerClaim({
        FORMULACMS_OWNER_CLAIM: " current ",
        NEXTCMS_OWNER_CLAIM: "legacy",
      })
    ).toBe(" current ")
    expect(resolveOwnerClaim({ NEXTCMS_OWNER_CLAIM: " legacy " })).toBe(
      " legacy "
    )
    expect(
      resolveOwnerClaim({
        FORMULACMS_OWNER_CLAIM: " ",
        NEXTCMS_OWNER_CLAIM: "legacy",
      })
    ).toBe("legacy")
  })
})

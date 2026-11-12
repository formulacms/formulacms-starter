import { describe, expect, test } from "vitest"
import { allowsLocalIpImageOptimization } from "./next-image-config"

describe("local-IP image optimization environment compatibility", () => {
  test("development is always enabled", () => {
    expect(allowsLocalIpImageOptimization({ NODE_ENV: "development" })).toBe(
      true
    )
  })

  test("reads formulacms first and falls back to the legacy flag", () => {
    expect(
      allowsLocalIpImageOptimization({
        NODE_ENV: "production",
        FORMULACMS_ALLOW_LOCAL_IMAGE_IPS: "1",
      })
    ).toBe(true)
    expect(
      allowsLocalIpImageOptimization({
        NODE_ENV: "production",
        NEXTCMS_ALLOW_LOCAL_IMAGE_IPS: "1",
      })
    ).toBe(true)
    expect(
      allowsLocalIpImageOptimization({
        NODE_ENV: "production",
        FORMULACMS_ALLOW_LOCAL_IMAGE_IPS: "0",
        NEXTCMS_ALLOW_LOCAL_IMAGE_IPS: "1",
      })
    ).toBe(false)
  })
})

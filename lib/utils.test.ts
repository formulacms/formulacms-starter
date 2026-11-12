import { describe, expect, test } from "vitest"
import { cn } from "./utils"

describe("cn", () => {
  test("uses the shared token-aware Tailwind merger after clsx", () => {
    expect(cn("flex py-section", false && "hidden", ["py-16"])).toBe(
      "flex py-16"
    )
  })
})

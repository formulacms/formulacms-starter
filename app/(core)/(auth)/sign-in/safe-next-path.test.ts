import { describe, expect, test } from "vitest"
import { safeNextPath } from "./safe-next-path"

const ORIGIN = "https://cms.example.com"

describe("safeNextPath", () => {
  test("keeps a same-origin path, with query and hash", () => {
    expect(safeNextPath("/admin/pages?tab=drafts#top", ORIGIN)).toBe(
      "/admin/pages?tab=drafts#top"
    )
  })

  test.each([
    ["missing", null],
    ["empty", ""],
    ["protocol-relative", "//evil.com"],
    ["absolute", "https://evil.com/steal"],
    // The prefix check this replaced accepted all three: each starts with a
    // single "/", yet the URL parser resolves them to another origin.
    ["backslash", "/\\evil.com"],
    ["tab-separated", "/\t/evil.com"],
    ["carriage-return", "/\r/evil.com"],
    ["scheme-ish", "javascript:alert(1)"],
    ["line-feed", "/\n/evil.com"],
    ["normalized authority", "/section/..//evil.com/path"],
    ["same-origin absolute", `${ORIGIN}/public-page`],
    ["unrooted", "admin/pages"],
  ])("sends %s values to /admin instead", (_label, value) => {
    expect(safeNextPath(value, ORIGIN)).toBe("/admin")
  })

  test("uses the caller's safe default for rejected targets", () => {
    expect(safeNextPath("/\\evil.com", ORIGIN, "/")).toBe("/")
    expect(safeNextPath(null, ORIGIN, "/")).toBe("/")
  })

  // Belt and braces: whatever the guard returns must resolve back to the
  // origin it was given, for every input above.
  test.each([
    "/\\evil.com",
    "/\t/evil.com",
    "//evil.com",
    "https://evil.com/steal",
    "/admin",
  ])("never yields an off-origin resolution for %j", (value) => {
    const resolved = new URL(safeNextPath(value, ORIGIN), ORIGIN)
    expect(resolved.origin).toBe(ORIGIN)
  })
})

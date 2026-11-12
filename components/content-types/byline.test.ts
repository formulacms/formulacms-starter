import { describe, expect, it } from "vitest"
import { formatBylineNames } from "./byline"

describe("formatBylineNames", () => {
  it("returns empty string for no authors", () => {
    expect(formatBylineNames([])).toBe("")
  })

  it("formats a single author", () => {
    expect(formatBylineNames(["Ada Lovelace"])).toBe("By Ada Lovelace")
  })

  it("formats two authors with 'and'", () => {
    expect(formatBylineNames(["Ada Lovelace", "Grace Hopper"])).toBe(
      "By Ada Lovelace and Grace Hopper",
    )
  })

  it("formats three authors with an Oxford comma", () => {
    expect(
      formatBylineNames(["Ada Lovelace", "Grace Hopper", "Margaret Hamilton"]),
    ).toBe("By Ada Lovelace, Grace Hopper, and Margaret Hamilton")
  })

  it("collapses a fourth author into a singular overflow count", () => {
    expect(
      formatBylineNames([
        "Ada Lovelace",
        "Grace Hopper",
        "Margaret Hamilton",
        "Katherine Johnson",
      ]),
    ).toBe("By Ada Lovelace, Grace Hopper, Margaret Hamilton, and 1 other")
  })

  it("collapses five+ authors into a plural overflow count", () => {
    expect(
      formatBylineNames([
        "Ada Lovelace",
        "Grace Hopper",
        "Margaret Hamilton",
        "Katherine Johnson",
        "Radia Perlman",
      ]),
    ).toBe("By Ada Lovelace, Grace Hopper, Margaret Hamilton, and 2 others")
  })
})

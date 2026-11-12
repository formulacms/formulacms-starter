import { describe, it, expect } from "vitest"
import { parseFieldPath, setValueAtFieldPath } from "./field-path"

describe("parseFieldPath", () => {
  it("returns an empty array for an empty path", () => {
    expect(parseFieldPath("")).toEqual([])
  })

  it("parses a top-level dotted path", () => {
    expect(parseFieldPath("bio")).toEqual(["bio"])
    expect(parseFieldPath("group.name")).toEqual(["group", "name"])
  })

  it("parses list-indexed segments", () => {
    expect(parseFieldPath("socials[0].platform")).toEqual([
      "socials",
      "0",
      "platform",
    ])
    expect(parseFieldPath("items[3]")).toEqual(["items", "3"])
  })

  it("round-trips through setValueAtFieldPath for a nested descriptor field", () => {
    const source: Record<string, unknown> = {
      socials: [{ platform: "GitHub", url: "https://" }],
    }
    const next = setValueAtFieldPath(
      source,
      parseFieldPath("socials[0].platform"),
      "GitLab",
    ) as { socials: { platform: string; url: string }[] }
    expect(next.socials[0].platform).toBe("GitLab")
    expect(next.socials[0].url).toBe("https://")
  })
})

describe("setValueAtFieldPath", () => {
  it("returns the value directly for an empty path", () => {
    expect(setValueAtFieldPath({ a: 1 }, [], "x")).toBe("x")
  })

  it("sets a nested object field immutably", () => {
    const source = { a: { b: 1 }, c: 2 }
    const next = setValueAtFieldPath(source, ["a", "b"], 9) as typeof source
    expect(next).toEqual({ a: { b: 9 }, c: 2 })
    expect(source.a.b).toBe(1) // original untouched
    expect(next).not.toBe(source)
  })

  it("creates intermediate objects when the path does not exist", () => {
    expect(setValueAtFieldPath({}, ["a", "b"], 1)).toEqual({ a: { b: 1 } })
  })

  it("sets an array element by numeric index immutably", () => {
    const source = [{ v: 1 }, { v: 2 }]
    const next = setValueAtFieldPath(source, ["1", "v"], 5) as typeof source
    expect(next).toEqual([{ v: 1 }, { v: 5 }])
    expect(source[1].v).toBe(2)
  })

  it("ignores invalid array indices, returning the source unchanged", () => {
    const source = [1, 2]
    expect(setValueAtFieldPath(source, ["-1"], 9)).toBe(source)
    expect(setValueAtFieldPath(source, ["x"], 9)).toBe(source)
  })

  it("blocks prototype-pollution keys", () => {
    for (const key of ["__proto__", "constructor", "prototype"]) {
      const source = { safe: 1 }
      expect(setValueAtFieldPath(source, [key, "polluted"], true)).toBe(source)
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
  })
})

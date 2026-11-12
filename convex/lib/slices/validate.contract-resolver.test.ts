import { describe, expect, test } from "vitest"
import { convertContentFields } from "./validate"
import { group, list, richText } from "./primitives"
import type { RichTextContractConfig } from "../richtext/contracts"

const configs: { name: string; config: RichTextContractConfig; contract: "title" | "inline" | "basic" | "full" }[] = [
  { name: "title", config: { contract: "title" }, contract: "title" },
  ...(["inline", "basic", "full"] as const).flatMap((contract) => [
    { name: `${contract} contract-only`, config: { contract }, contract },
    { name: `${contract} profile-only`, config: { profile: contract }, contract },
    { name: `${contract} both equal`, config: { contract, profile: contract }, contract },
  ]),
]
const text = { type: "text", text: "Keep", marks: [{ type: "bold" }] }
const heading = { type: "doc", content: [{ type: "heading", attrs: { level: 2 }, content: [text] }] }
const paragraph = { type: "doc", content: [{ type: "paragraph", content: [text] }] }
const value = JSON.stringify(heading)

describe("RES1 conversion contract resolver", () => {
  test.each(configs)("resolves $name through nested descriptor consumers", ({ config, contract }) => {
    const field = richText(config)
    expect(field.config.contract).toBe(contract)
    const rows = list(group({ copy: field }))
    const input = { rows: [{ itemId: "stable-row", copy: value }], extra: "retained" }
    const before = structuredClone(input)
    const converted = convertContentFields({ rows }, input, "res1-probe")
    const result = converted.value.rows as { itemId: string; copy: string }[]
    expect(JSON.parse(result[0]!.copy)).toEqual(contract === "inline" ? paragraph : heading)
    expect(converted.value.extra).toBe("retained")
    expect(result[0]!.itemId).toBe("stable-row")
    expect(converted.reports).toEqual(contract === "inline" ? [{
      sliceType: "res1-probe", fieldPath: "rows[0].copy", removedLinks: [],
    }] : [])
    expect(convertContentFields({ rows }, converted.value, "res1-probe")).toEqual({ value: converted.value, reports: [] })
    expect(input).toEqual(before)
  })

  test.each([
    ["missing", {}, /require a contract or legacy profile/],
    ["conflict", { contract: "inline", profile: "full" }, /conflicts with profile/],
  ] as const)("rejects %s config before a stored-data consumer can receive a descriptor", (_name, config, error) => {
    expect(() => richText(config)).toThrow(error)
  })
})

import { describe, expect, test } from "vitest"
import { toDescriptorComparisonForm } from "./comparison"
import { group, list, richText } from "../slices/primitives"
import type { RichTextContractConfig } from "./contracts"

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

describe("RES1 comparison contract resolver", () => {
  test.each(configs)("resolves $name through nested descriptor consumers", ({ config, contract }) => {
    const field = richText(config)
    expect(field.config.contract).toBe(contract)
    const rows = list(group({ copy: field }))
    const input = { rows: [{ itemId: "stable-row", copy: value }], extra: "retained" }
    const before = structuredClone(input)
    const descriptor = group({ rows })
    const projected = toDescriptorComparisonForm(descriptor, input, { sliceType: "res1-probe", fieldPath: "primary" }) as typeof input
    expect(JSON.parse(projected.rows[0]!.copy)).toEqual(["title", "inline"].includes(contract) ? paragraph : heading)
    expect(projected.rows[0]!.itemId).toBe("stable-row")
    expect(projected.extra).toBe("retained")
    const changed = structuredClone(input)
    changed.rows[0]!.copy = value.replace("bold", "italic")
    expect(toDescriptorComparisonForm(descriptor, changed, { sliceType: "res1-probe", fieldPath: "primary" })).not.toEqual(projected)
    expect(toDescriptorComparisonForm(field, null, { sliceType: "res1-probe", fieldPath: "copy" })).toBeNull()
    expect(input).toEqual(before)
  })

  test.each([
    ["missing", {}, /require a contract or legacy profile/],
    ["conflict", { contract: "inline", profile: "full" }, /conflicts with profile/],
  ] as const)("rejects %s config before a stored-data consumer can receive a descriptor", (_name, config, error) => {
    expect(() => richText(config)).toThrow(error)
  })
})

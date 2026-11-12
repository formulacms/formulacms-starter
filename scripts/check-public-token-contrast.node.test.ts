import { existsSync, readFileSync } from "node:fs"
import { describe, expect, test } from "vitest"
import { extractProperties } from "./check-public-token-contrast"
import { scanCss, walkCss } from "../lib/design-system/css-scan"

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8")

describe("public token scope / contrast adapter", () => {
  test("every public runtime palette declaration is scoped, including demo/dark rules", () => {
    const declarations: string[] = []
    walkCss(scanCss(css).nodes, (node, ancestors) => {
      if (
        node.kind !== "declaration" ||
        ![
          "--brand",
          "--brand-foreground",
          "--accent-brand",
          "--public-heading-family",
        ].includes(node.property)
      )
        return
      const rule = ancestors.filter((parent) => parent.kind === "rule").at(-1)
      expect(rule?.kind).toBe("rule")
      if (rule?.kind !== "rule") return
      expect(
        rule.selector
          .split(",")
          .every((part) => part.includes("[data-public-ui]"))
      ).toBe(true)
      declarations.push(node.property)
    })
    expect(new Set(declarations)).toEqual(
      new Set([
        "--brand",
        "--brand-foreground",
        "--accent-brand",
        "--public-heading-family",
      ])
    )
  })

  test("reads default light/dark public colors without accidentally checking demo indigo", () => {
    const light = extractProperties(css, ":root")
    const dark = extractProperties(css, ".dark")
    expect(light.get("--brand")).toBe("oklch(0.205 0 0)")
    expect(dark.get("--brand")).toBe("oklch(0.922 0 0)")
    expect(light.get("--primary")).toBe("var(--brand)")
    expect(dark.get("--primary")).toBe("var(--brand)")
    expect(light.get("--ring")).toBe("oklch(0.708 0 0)")
    expect(dark.get("--ring")).toBe("oklch(0.556 0 0)")
  })

  test("includes the owner's scoped override layer and preserves source/overlay palette parity", () => {
    const override =
      css +
      `\n@layer public-tokens-overrides { [data-public-ui] { --brand: oklch(0.3 0.1 260); } [data-public-ui].dark { --brand: oklch(0.9 0.1 260); } }`
    expect(extractProperties(override, ":root").get("--brand")).toBe(
      "oklch(0.3 0.1 260)"
    )
    expect(extractProperties(override, ".dark").get("--brand")).toBe(
      "oklch(0.9 0.1 260)"
    )
  })
})

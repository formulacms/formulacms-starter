import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import { describe, expect, test } from "vitest"
import { scanCss, walkCss } from "./design-system/css-scan"

describe("font token wiring", () => {
  test("keeps Next font variables distinct from Tailwind theme tokens", () => {
    const fontSource = readFileSync(resolve("lib/fonts.ts"), "utf8")
    const globalStyles = readFileSync(resolve("app/globals.css"), "utf8")

    expect(fontSource).toContain('variable: "--font-inter"')
    expect(fontSource).toContain('variable: "--font-geist-mono"')
    expect(globalStyles).toContain("--font-sans: var(--font-inter);")
    expect(globalStyles).toContain("--font-mono: var(--font-geist-mono);")
    expect(globalStyles).not.toContain("--font-sans: var(--font-sans);")
    expect(globalStyles).not.toContain("--font-mono: var(--font-mono);")
  })

  test("reserves the document scrollbar gutter before hydration", () => {
    const globalStyles = readFileSync(resolve("app/globals.css"), "utf8")

    expect(globalStyles).toContain("scrollbar-gutter: stable;")
  })

  test("ships the public heading alias separately from the unchanged admin font binding", () => {
    const fontSource = readFileSync(resolve("lib/fonts.ts"), "utf8")
    expect(fontSource.match(/weight: "variable"/g)).toHaveLength(2)
    expect(fontSource.match(/style: "normal"/g)).toHaveLength(2)
    for (const path of [
      "app/globals.css",
    ]) {
      const css = readFileSync(resolve(path), "utf8")
      expect(css).toContain("--font-heading: var(--font-inter);")
      expect(css).toContain(
        "--font-public-heading: var(--public-heading-family);"
      )
      const headingScopes: string[] = []
      walkCss(scanCss(css).nodes, (node, ancestors) => {
        if (
          node.kind !== "declaration" ||
          node.property !== "--public-heading-family"
        )
          return
        expect(node.value).toBe("var(--font-inter)")
        expect(
          ancestors.some(
            (parent) =>
              parent.kind === "at-block" &&
              parent.name === "layer" &&
              parent.params === "public-tokens"
          )
        ).toBe(true)
        headingScopes.push(
          ...ancestors
            .filter((parent) => parent.kind === "rule")
            .map((parent) => parent.selector)
        )
      })
      expect(headingScopes).toEqual(["[data-public-ui]"])
    }
  })
})

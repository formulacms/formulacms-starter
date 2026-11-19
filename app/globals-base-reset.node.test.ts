import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import tailwind from "@tailwindcss/postcss"
import { describe, expect, it } from "vitest"

// Resolve PostCSS through its installed consumer; it is not a direct dependency.
const installed = createRequire(resolve("package.json"))
const postcss = createRequire(installed.resolve("@tailwindcss/postcss"))("postcss")
type TailwindPlugin = Extract<ReturnType<typeof tailwind>, { postcssPlugin: string }>
type CssRoot = Parameters<NonNullable<TailwindPlugin["Once"]>>[0]
type CssRule = Parameters<Parameters<CssRoot["walkRules"]>[0]>[0]

function layerOf(rule: CssRule): string {
  for (
    let parent: typeof rule.parent | CssRoot["parent"] = rule.parent;
    parent;
    parent = parent.parent
  ) {
    if (parent.type === "atrule" && parent.name === "layer") return parent.params
  }
  return ""
}

// shadcn's `* { border-border }` and `body` colours must sit in Tailwind's
// `base` layer, which comes before `utilities`. In a layer this file declares
// after `utilities`, the reset beats every border, outline and background
// utility (https://ui.shadcn.com/docs/tailwind-v4).
describe.each([
  "app/globals.css",
])("border and page-colour reset in %s", (path) => {
  it("compiles into the base layer, before utilities", async () => {
    const result = await postcss([
      tailwind({ base: process.cwd(), optimize: false }),
    ]).process(readFileSync(path, "utf8"), { from: resolve(path) })
    const compiled: CssRoot = result.root

    const layers: string[] = []
    compiled.walkAtRules("layer", (node) => {
      for (const name of node.params.split(",").map((name) => name.trim())) {
        if (!layers.includes(name)) layers.push(name)
      }
    })
    const resets: { selector: string; layer: string }[] = []
    compiled.walkRules((rule) => {
      if (rule.selector !== "*" && rule.selector !== "body") return
      const props = new Set<string>()
      rule.walkDecls((decl) => {
        props.add(decl.prop)
      })
      if (
        props.has("border-color") ||
        props.has("background-color") ||
        props.has("color")
      )
        resets.push({ selector: rule.selector, layer: layerOf(rule) })
    })

    expect(resets).toEqual([
      { selector: "*", layer: "base" },
      { selector: "body", layer: "base" },
    ])
    expect(layers.indexOf("base")).toBeGreaterThanOrEqual(0)
    expect(layers.indexOf("base")).toBeLessThan(layers.indexOf("utilities"))
  })
})

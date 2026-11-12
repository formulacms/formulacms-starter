import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { resolve } from "node:path"
import tailwind from "@tailwindcss/postcss"
import { describe, expect, it } from "vitest"
import { scanCss, walkCss } from "@/lib/design-system/css-scan"

// Resolve PostCSS through its installed consumer; it is not a direct dependency.
const installed = createRequire(resolve("package.json"))
const postcss = createRequire(installed.resolve("@tailwindcss/postcss"))("postcss")
type TailwindPlugin = Extract<ReturnType<typeof tailwind>, { postcssPlugin: string }>
type CssRoot = Parameters<NonNullable<TailwindPlugin["Once"]>>[0]

describe.each([
  "app/globals.css",
])(
  "public CTA focus in %s",
  (path) => {
    const source = readFileSync(path, "utf8")
    const scan = scanCss(source)

    it("defines one opaque focus token in the shared public scope", () => {
      const tokens: { value: string; scoped: boolean }[] = []
      walkCss(scan.nodes, (node, ancestors) => {
        if (
          node.kind !== "declaration" ||
          node.property !== "--public-cta-focus"
        ) {
          return
        }
        tokens.push({
          value: node.value.trim(),
          scoped:
            ancestors.some(
              (parent) =>
                parent.kind === "rule" && parent.selector === "[data-public-ui]"
            ) &&
            ancestors.some(
              (parent) =>
                parent.kind === "at-block" &&
                parent.name === "layer" &&
                parent.params === "public-tokens"
            ),
        })
      })
      expect(tokens).toEqual([{ value: "#737373", scoped: true }])
    })

    it("replaces the ring with a scoped solid offset outline in public-base", () => {
      const rules: string[][] = []
      walkCss(scan.nodes, (node, ancestors) => {
        if (
          node.kind !== "rule" ||
          node.selector !==
            "[data-public-ui] .public-cta-focus:focus-visible" ||
          !ancestors.some(
            (parent) =>
              parent.kind === "at-block" &&
              parent.name === "layer" &&
              parent.params === "public-base"
          )
        )
          return
        rules.push(
          node.children.flatMap((child) =>
            child.kind === "at-statement" && child.name === "apply"
              ? child.params.trim().split(/\s+/)
              : []
          )
        )
      })
      expect(rules).toEqual([
        [
          "ring-0",
          "outline-solid",
          "outline-2",
          "outline-offset-2",
          "outline-(--public-cta-focus)",
        ],
      ])
    })

    it("compiles the CTA outline after utilities and the admin reset", async () => {
      const result = await postcss([
        tailwind({ base: process.cwd(), optimize: false }),
      ]).process(source, { from: resolve(path) })
      const compiled: CssRoot = result.root

      const layers: string[] = []
      const outlines: { layer: string; declarations: Record<string, string> }[] = []
      compiled.walkAtRules("layer", (node) => {
        for (const name of node.params.split(",").map((name) => name.trim())) {
          if (!layers.includes(name)) layers.push(name)
        }
      })
      compiled.walkRules((rule) => {
        if (rule.selector !== "[data-public-ui] .public-cta-focus:focus-visible") {
          return
        }

        let layer = ""
        for (
          let parent: typeof rule.parent | CssRoot["parent"] = rule.parent;
          parent;
          parent = parent.parent
        ) {
          if (parent.type === "atrule" && parent.name === "layer") {
            layer = parent.params
            break
          }
        }
        const declarations: Record<string, string> = {}
        rule.walkDecls((decl) => {
          declarations[decl.prop] = decl.value.trim()
        })
        outlines.push({ layer, declarations })
      })

      expect(outlines).toHaveLength(1)
      expect(layers).toContain("admin-base")
      expect(layers).toContain("utilities")
      expect(layers.indexOf(outlines[0].layer)).toBeGreaterThan(
        layers.indexOf("admin-base")
      )
      expect(layers.indexOf(outlines[0].layer)).toBeGreaterThan(
        layers.indexOf("utilities")
      )
      expect(outlines[0].declarations).toMatchObject({
        "outline-color": "var(--public-cta-focus)",
        "outline-style": "solid",
        "outline-width": "2px",
        "outline-offset": "2px",
      })
    })
  }
)

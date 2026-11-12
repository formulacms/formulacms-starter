#!/usr/bin/env tsx
/**
 * Phase 4 - public token WCAG-AA contrast gate.
 *
 * Checks the semantic token pairs used by starter renderers in both themes.
 */

import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { scanCss, walkCss } from "../lib/design-system/css-scan"

type Rgb = { r: number; g: number; b: number }

type ContrastCheck = {
  name: string
  foreground: string
  background: string
  min: number
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const CSS_PATH = path.join(ROOT, "app/globals.css")

const CHECKS: ContrastCheck[] = [
  {
    name: "text-on-surface on bg-surface",
    foreground: "--foreground",
    background: "--background",
    min: 4.5,
  },
  {
    name: "text-on-surface-muted on bg-surface",
    foreground: "--muted-foreground",
    background: "--background",
    min: 4.5,
  },
  {
    name: "text-on-surface on bg-surface-2",
    foreground: "--foreground",
    background: "--muted",
    min: 4.5,
  },
  {
    name: "text-on-surface-muted on bg-surface-2",
    foreground: "--muted-foreground",
    background: "--muted",
    min: 4.5,
  },
  {
    name: "text-on-surface on bg-surface-3",
    foreground: "--foreground",
    background: "--card",
    min: 4.5,
  },
  {
    name: "text-on-surface-muted on bg-surface-3",
    foreground: "--muted-foreground",
    background: "--card",
    min: 4.5,
  },
  {
    name: "text-brand link on bg-surface",
    foreground: "--brand",
    background: "--background",
    min: 4.5,
  },
  {
    name: "text-brand link on bg-surface-2",
    foreground: "--brand",
    background: "--muted",
    min: 4.5,
  },
  {
    name: "text-brand-foreground on bg-brand",
    foreground: "--brand-foreground",
    background: "--brand",
    min: 4.5,
  },
  {
    name: "text-brand on bg-brand-foreground",
    foreground: "--brand",
    background: "--brand-foreground",
    min: 4.5,
  },
]

/** Read the supported default public surface, excluding simulator demo rules.
 * This is a gate adapter for our selectors, not a general CSS cascade engine. */
export function extractProperties(
  css: string,
  selector: ":root" | ".dark"
): Map<string, string> {
  const props = new Map<string, string>()
  const publicRoot =
    "[data-public-ui]:not([data-public-simulator]):not([data-public-simulator] *)"
  const allowed = new Set(
    selector === ":root"
      ? [":root", "[data-public-ui]", publicRoot]
      : [
          ".dark",
          ".dark [data-public-ui]",
          "[data-public-ui].dark",
          "[data-public-ui] .dark",
          `${publicRoot} .dark`,
        ]
  )
  const scan = scanCss(css)
  if (scan.issues.length)
    throw new Error("Cannot check public contrast: invalid stylesheet")
  walkCss(scan.nodes, (node) => {
    if (node.kind !== "rule") return
    // Supported selector lists have no commas inside their functional selectors.
    const selectors = node.selector
      .split(",")
      .map((part) => part.trim().replace(/\s+/g, " "))
    if (!selectors.some((part) => allowed.has(part))) return
    for (const child of node.children) {
      if (child.kind === "declaration" && child.property.startsWith("--")) {
        props.set(child.property, child.value)
      }
    }
  })
  return props
}

function resolveColor(
  props: Map<string, string>,
  name: string,
  stack: string[] = []
): Rgb {
  if (stack.includes(name)) {
    throw new Error(
      `Circular CSS variable reference: ${[...stack, name].join(" -> ")}`
    )
  }

  const raw = props.get(name)
  if (!raw) throw new Error(`Missing CSS variable ${name}`)

  const varRef = raw.match(/^var\((--[-\w]+)\)$/)
  if (varRef?.[1]) {
    return resolveColor(props, varRef[1], [...stack, name])
  }

  const oklch = raw.match(
    /^oklch\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:deg)?(?:\s*\/\s*[^)]+)?\s*\)$/
  )
  if (!oklch) {
    throw new Error(`Unsupported color value for ${name}: ${raw}`)
  }

  const l = Number(oklch[1])
  const c = Number(oklch[2])
  const h = Number(oklch[3])
  return oklchToLinearSrgb(l, c, h)
}

function oklchToLinearSrgb(l: number, c: number, hDegrees: number): Rgb {
  const h = (hDegrees * Math.PI) / 180
  const a = c * Math.cos(h)
  const b = c * Math.sin(h)

  const lPrime = l + 0.3963377774 * a + 0.2158037573 * b
  const mPrime = l - 0.1055613458 * a - 0.0638541728 * b
  const sPrime = l - 0.0894841775 * a - 1.291485548 * b

  const lCube = lPrime ** 3
  const mCube = mPrime ** 3
  const sCube = sPrime ** 3

  return {
    r: clamp01(
      4.0767416621 * lCube - 3.3077115913 * mCube + 0.2309699292 * sCube
    ),
    g: clamp01(
      -1.2684380046 * lCube + 2.6097574011 * mCube - 0.3413193965 * sCube
    ),
    b: clamp01(
      -0.0041960863 * lCube - 0.7034186147 * mCube + 1.707614701 * sCube
    ),
  }
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value))
}

function luminance(rgb: Rgb): number {
  return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b
}

function contrast(foreground: Rgb, background: Rgb): number {
  const a = luminance(foreground)
  const b = luminance(background)
  const lighter = Math.max(a, b)
  const darker = Math.min(a, b)
  return (lighter + 0.05) / (darker + 0.05)
}

function formatRatio(ratio: number): string {
  return `${ratio.toFixed(2)}:1`
}

function main() {
  const css = fs.readFileSync(CSS_PATH, "utf8")
  const failures: string[] = []

  const lightProps = extractProperties(css, ":root")
  const darkProps = new Map(lightProps)
  for (const [name, value] of extractProperties(css, ".dark")) {
    darkProps.set(name, value)
  }

  for (const [theme, props] of [
    ["light", lightProps],
    ["dark", darkProps],
  ] as const) {
    for (const check of CHECKS) {
      const fg = resolveColor(props, check.foreground)
      const bg = resolveColor(props, check.background)
      const ratio = contrast(fg, bg)

      if (ratio < check.min) {
        failures.push(
          `${theme} ${check.name}: ${formatRatio(ratio)} (needs ${check.min}:1)`
        )
      } else {
        console.log(`✓ ${theme} ${check.name}: ${formatRatio(ratio)}`)
      }
    }
  }

  if (failures.length > 0) {
    console.error("\n✗ Public token contrast failures:")
    for (const failure of failures) console.error(`  ${failure}`)
    process.exit(1)
  }

  console.log(
    "\n✓ Public token contrast meets WCAG-AA in light and dark themes."
  )
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()

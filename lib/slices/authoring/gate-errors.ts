import { toCamel } from "./naming"

const DEFAULT_ERROR_LINE_COUNT = 24

function firstLines(output: string, count: number): string {
  return output.split(/\r?\n/).slice(0, count).join("\n")
}

function uniqueLines(lines: string[]): string[] {
  const seen = new Set<string>()
  return lines.filter((line) => {
    const key = line.trim()
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function summarizeGateOutput(
  output: string,
  lineCount = DEFAULT_ERROR_LINE_COUNT
): string {
  return firstLines(output, lineCount)
}

export function summarizeSliceGateOutput(
  output: string,
  type: string,
  lineCount = DEFAULT_ERROR_LINE_COUNT
): string {
  const needles = [
    `convex/lib/slices/${toCamel(type)}.ts`,
    `components/slices/${type}.tsx`,
    "convex/lib/slices/index.ts",
    "lib/slices/builder.ts",
    // Every registration writes here, and it is where a bad descriptor usually
    // surfaces — without it the focused excerpt falls back to raw gate output
    // on the file slices most often break in.
    "components/slices/slice-zone-registry.tsx",
    "lib/slices/slices.manifest.json",
  ]
  const lines = output.split(/\r?\n/)
  const focused = uniqueLines(
    lines.filter((line) => needles.some((needle) => line.includes(needle)))
  )

  return firstLines(focused.length > 0 ? focused.join("\n") : output, lineCount)
}

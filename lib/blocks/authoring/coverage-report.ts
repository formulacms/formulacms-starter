/**
 * Build-mode field coverage outcomes and their report (ADR-0059, amendment
 * 2026-11-21 (7)). Pure: it imports no renderer, so the build step can still
 * report when the block renderers cannot load.
 */
export type CoverageOutcome = {
  type: string
  presentation: string
  rendererSource: string
} & (
  | { outcome: "passed"; fields: number }
  | { outcome: "legacy"; reason: string }
  | {
      outcome: "failed"
      defects: { path: string; kind?: string; problem: string }[]
    }
  | { outcome: "unverified"; error: string }
)

const COMPONENT: Record<string, string> = {
  text: "<Text>",
  richText: "<RichText>",
  image: "<KitImage>",
}

/** `items.0.title` -> `items[].title`; one line per field, not per row. */
const pattern = (path: string) => path.replace(/\.(\d+)(?=\.|$)/g, "[]")

function repair(path: string, kind: string | undefined): string {
  if (path === "*")
    return "Remove this whole-block exclusion from lib/blocks/authoring/field-coverage.ts and bind each field, then run pnpm build again."
  if (!kind)
    return "The block descriptor declares no field at this path. Use a field path the descriptor declares, then run pnpm build again."
  const value = path.includes("[]")
    ? `\`${path.replaceAll("[]", "[${index}]")}\``
    : `"${path}"`
  const prop = value.startsWith('"') ? value : `{${value}}`
  return `Bind it with ${COMPONENT[kind] ?? "<Text>/<RichText>"} fieldPath=${prop} from @/components/block-kit, or wrap its element with ctx.previewField({ fieldPath: ${value}, kind: "${kind}", rendered }), then run pnpm build again.`
}

const scope = (entry: CoverageOutcome) =>
  `${entry.rendererSource} (block ${entry.type}, presentation ${entry.presentation})`

/** Unverified is a warning: the build continues. Only a completed render that
 * shows a field without its click marker fails the build. */
export function coverageReport(
  outcomes: readonly CoverageOutcome[] | { catalogError: string }
): { passed: boolean; text: string } {
  if (!Array.isArray(outcomes)) {
    const { catalogError } = outcomes as { catalogError: string }
    return {
      passed: true,
      text: `Block field coverage unverified for the whole block catalog: the block renderers could not load.\n  ${catalogError}\n  The build continues. Fix the error, then run pnpm build again.`,
    }
  }
  const count = (outcome: CoverageOutcome["outcome"]) =>
    outcomes.filter((entry) => entry.outcome === outcome).length
  const lines = [
    `Block field coverage: ${outcomes.length} presentations, ${count("passed")} passed, ${count("legacy")} legacy, ${count("unverified")} unverified, ${count("failed")} failed.`,
  ]
  for (const entry of outcomes) {
    if (entry.outcome === "passed")
      lines.push(
        `  ${entry.type}/${entry.presentation}: passed, ${entry.fields} ${entry.fields === 1 ? "field" : "fields"} covered.`
      )
    if (entry.outcome === "legacy")
      lines.push(
        `  ${entry.type}/${entry.presentation}: legacy, 0 fields covered. ${entry.reason}`
      )
    if (entry.outcome === "unverified")
      lines.push(
        `Block field coverage unverified: ${scope(entry)} could not render.\n  ${entry.error}\n  The build continues. Fix the error, then run pnpm build again.`
      )
  }
  for (const entry of outcomes) {
    if (entry.outcome !== "failed") continue
    lines.push(
      `Block field coverage failed: ${scope(entry)}. The page editor needs one click marker on each text, rich text and image field.`
    )
    const seen = new Set<string>()
    for (const { path, kind, problem } of entry.defects) {
      const at = path === "*" ? "*" : pattern(path)
      const shown =
        problem === "missing emitted kit host"
          ? "has no click marker in the rendered block"
          : problem
      if (seen.has(`${at} ${shown}`)) continue
      seen.add(`${at} ${shown}`)
      lines.push(
        `  - ${at}${kind ? ` (${kind})` : ""}: ${shown}.\n    ${repair(at, kind)}`
      )
      if (problem === "missing emitted kit host")
        lines.push(
          `    If this field is shown only for some values, the build sample hides it: list it in COVERAGE_EXCLUSIONS in lib/blocks/authoring/field-coverage.ts with status "structural" and a reason, then run pnpm build again.`
        )
    }
  }
  return { passed: count("failed") === 0, text: lines.join("\n") }
}

/**
 * Shared shapes and helpers of the definition checks. Pure: no imports from the
 * registries, the schema or the storage-field leaf, so both the block check and
 * the content-type check can load it.
 */

export type DefinitionRule =
  | "key-mismatch"
  | "duplicate-type"
  | "reserved-field"
  | "missing-title"
  | "relation-target"
  | "validator-parity"
  | "post-only-field"
  | "duplicate-path-prefix"
  | "active-type"

export type DefinitionProblem = {
  kind: "content type" | "block"
  type: string
  field?: string
  rule: DefinitionRule
  /** One plain line that names the kind, type, field, rule and the repair. */
  message: string
}

/** A manifest row, as the build gate reads it from the manifest file. */
export function describe(
  kind: DefinitionProblem["kind"],
  type: string,
  field: string | undefined,
  rule: DefinitionRule,
  detail: string
): DefinitionProblem {
  const label = kind === "block" ? "Block" : "Content type"
  const where = field === undefined ? "" : `, field "${field}"`
  return {
    kind,
    type,
    ...(field === undefined ? {} : { field }),
    rule,
    message: `${label} "${type}"${where}: ${rule} — ${detail}`,
  }
}

/** The values that occur more than once, in first-seen order. */
export function repeated(values: readonly string[]): string[] {
  const seen = new Set<string>()
  const again = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) again.add(value)
    seen.add(value)
  }
  return [...again]
}

/** One line per problem, with a heading that counts them. */
export function formatDefinitionProblems(
  problems: readonly DefinitionProblem[]
): string {
  const noun = problems.length === 1 ? "problem" : "problems"
  return [
    `Definition check found ${problems.length} ${noun}:`,
    ...problems.map((problem) => `- ${problem.message}`),
  ].join("\n")
}

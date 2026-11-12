/**
 * The opt-in `dom` block a reference contract may declare (slice-fidelity plan
 * §5 D2). Where the pixel comparison answers "does this look like the design",
 * these answer "does this still have the shape the design was accepted for" —
 * a two-line headline is still two lines, a staggered column still starts where
 * it was meant to, a 3/7 split is still 3/7.
 *
 * Two rules shape the whole module:
 *
 * 1. **Nothing unrecognized is tolerated.** Every key is checked against a known
 *    set, at every level. A misspelled check that validated to nothing would
 *    assert nothing and still pass every gate — a contract that manufactures
 *    confidence is worse than no contract, so it is a defect instead.
 * 2. **Declared, not global.** Tolerances live on the declaration that needs
 *    them. A composition with a deliberate stagger states its expected offset;
 *    it never gets accommodated by loosening a shared threshold (plan §5 D2
 *    rule 7).
 *
 * Authored shapes leave the defaults out; the validated shapes returned to
 * callers have every default resolved, so the evaluator only ever sees numbers.
 */

/** Box edges a relation can compare. Vertical pairs answer "does this line up". */
export const DOM_ANCHOR_EDGES = ["top", "bottom", "left", "right"] as const
export type DomAnchorEdge = (typeof DOM_ANCHOR_EDGES)[number]

/**
 * CSS px within which two inline-fragment rectangles count as the same visual
 * line. A line box is far taller than this at any real type scale, so the
 * default separates lines without splitting one.
 */
export const DEFAULT_LINE_GROUP_TOLERANCE = 4
/** Plan §5 D2 rule 6: an anchor relation means equality unless it says otherwise. */
export const DEFAULT_ANCHOR_EXPECTED_DELTA = 0
export const DEFAULT_ANCHOR_TOLERANCE = 1

export type DomHeadingLinesRule = {
  selector: string
  lines: number
  groupTolerance?: number
}
export type DomAnchorRelationRule = {
  from: string
  to: string
  edge: DomAnchorEdge
  expectedDelta?: number
  tolerance?: number
}
export type DomGridRatioRule = {
  selector: string
  ratio: number
  /** Required: a ratio without a stated tolerance is a guess, not a contract. */
  tolerance: number
}

/** What an author writes in `config/slice-reference-contracts.json`. */
export type ReferenceDomContract = {
  headingLines?: DomHeadingLinesRule[]
  anchorRelations?: DomAnchorRelationRule[]
  gridRatios?: DomGridRatioRule[]
}

export type ValidatedHeadingLinesRule = Required<DomHeadingLinesRule>
export type ValidatedAnchorRelationRule = Required<DomAnchorRelationRule>
export type ValidatedGridRatioRule = Required<DomGridRatioRule>

/** The same contract with every default resolved. */
export type ValidatedDomContract = {
  headingLines: ValidatedHeadingLinesRule[]
  anchorRelations: ValidatedAnchorRelationRule[]
  gridRatios: ValidatedGridRatioRule[]
}

const CHECK_NAMES = [
  "headingLines",
  "anchorRelations",
  "gridRatios",
] as const

const RULE_KEYS: Record<(typeof CHECK_NAMES)[number], readonly string[]> = {
  headingLines: ["selector", "lines", "groupTolerance"],
  anchorRelations: ["from", "to", "edge", "expectedDelta", "tolerance"],
  gridRatios: ["selector", "ratio", "tolerance"],
}

export type DomContractDefect = { field: string; message: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function unknownKeyMessage(key: string, known: readonly string[]): string {
  return `"${key}" is not something this file understands. Use one of: ${known.join(", ")}.`
}

function rejectUnknownKeys(
  candidate: Record<string, unknown>,
  known: readonly string[],
  path: string,
  defects: DomContractDefect[]
): void {
  for (const key of Object.keys(candidate)) {
    if (known.includes(key)) continue
    defects.push({
      field: path ? `${path}.${key}` : key,
      message: unknownKeyMessage(key, known),
    })
  }
}

function requireSelector(
  candidate: Record<string, unknown>,
  key: string,
  path: string,
  defects: DomContractDefect[]
): string | null {
  const value = candidate[key]
  if (typeof value !== "string" || value.trim().length === 0) {
    defects.push({
      field: `${path}.${key}`,
      message: `"${key}" must name the part of the design to measure, such as "h2".`,
    })
    return null
  }
  return value
}

function requireNumber(
  candidate: Record<string, unknown>,
  key: string,
  path: string,
  defects: DomContractDefect[],
  {
    fallback,
    min,
    integer = false,
    describe,
  }: {
    fallback?: number
    min: number
    integer?: boolean
    describe: string
  }
): number | null {
  const value = candidate[key]
  if (value === undefined && fallback !== undefined) return fallback
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    (integer && !Number.isInteger(value))
  ) {
    defects.push({ field: `${path}.${key}`, message: describe })
    return null
  }
  return value
}

function validateHeadingLines(
  value: unknown,
  path: string,
  defects: DomContractDefect[]
): ValidatedHeadingLinesRule | null {
  if (!isPlainObject(value)) {
    defects.push({ field: path, message: "Each check must be an object." })
    return null
  }
  rejectUnknownKeys(value, RULE_KEYS.headingLines, path, defects)
  const selector = requireSelector(value, "selector", path, defects)
  const lines = requireNumber(value, "lines", path, defects, {
    min: 1,
    integer: true,
    describe:
      '"lines" must be how many lines of text the design shows — a whole number, at least 1.',
  })
  const groupTolerance = requireNumber(value, "groupTolerance", path, defects, {
    fallback: DEFAULT_LINE_GROUP_TOLERANCE,
    min: 0,
    describe:
      '"groupTolerance" must be how far apart, in pixels, two pieces of text can sit and still count as the same line.',
  })
  if (selector === null || lines === null || groupTolerance === null) return null
  return { selector, lines, groupTolerance }
}

function validateAnchorRelation(
  value: unknown,
  path: string,
  defects: DomContractDefect[]
): ValidatedAnchorRelationRule | null {
  if (!isPlainObject(value)) {
    defects.push({ field: path, message: "Each check must be an object." })
    return null
  }
  rejectUnknownKeys(value, RULE_KEYS.anchorRelations, path, defects)
  const from = requireSelector(value, "from", path, defects)
  const to = requireSelector(value, "to", path, defects)
  let edge: DomAnchorEdge | null = null
  if (
    typeof value.edge === "string" &&
    (DOM_ANCHOR_EDGES as readonly string[]).includes(value.edge)
  ) {
    edge = value.edge as DomAnchorEdge
  } else {
    defects.push({
      field: `${path}.edge`,
      message: `"edge" must be one of: ${DOM_ANCHOR_EDGES.join(", ")}.`,
    })
  }
  const expectedDelta = requireNumber(value, "expectedDelta", path, defects, {
    fallback: DEFAULT_ANCHOR_EXPECTED_DELTA,
    min: Number.NEGATIVE_INFINITY,
    describe:
      '"expectedDelta" must be how far apart, in pixels, the design puts these two edges.',
  })
  const tolerance = requireNumber(value, "tolerance", path, defects, {
    fallback: DEFAULT_ANCHOR_TOLERANCE,
    min: 0,
    describe: '"tolerance" must be how many pixels of difference are acceptable.',
  })
  if (
    from === null ||
    to === null ||
    edge === null ||
    expectedDelta === null ||
    tolerance === null
  ) {
    return null
  }
  return { from, to, edge, expectedDelta, tolerance }
}

function validateGridRatio(
  value: unknown,
  path: string,
  defects: DomContractDefect[]
): ValidatedGridRatioRule | null {
  if (!isPlainObject(value)) {
    defects.push({ field: path, message: "Each check must be an object." })
    return null
  }
  rejectUnknownKeys(value, RULE_KEYS.gridRatios, path, defects)
  const selector = requireSelector(value, "selector", path, defects)
  const ratio = requireNumber(value, "ratio", path, defects, {
    min: Number.MIN_VALUE,
    describe:
      '"ratio" must be the width of the first column divided by the width of the second — a number above zero.',
  })
  const tolerance = requireNumber(value, "tolerance", path, defects, {
    min: 0,
    describe:
      '"tolerance" must say how far the measured split may sit from the declared one. A ratio has to state its own.',
  })
  if (selector === null || ratio === null || tolerance === null) return null
  return { selector, ratio, tolerance }
}

/**
 * Validate one declared list. `count` is how many checks were *declared*,
 * including malformed ones — a block whose only check is broken has still said
 * it checks something, and reporting "you declared nothing" on top of the real
 * defect would misdescribe it.
 */
function validateList<T>(
  raw: unknown,
  name: string,
  validate: (
    value: unknown,
    path: string,
    defects: DomContractDefect[]
  ) => T | null,
  defects: DomContractDefect[]
): { count: number; items: T[] } {
  if (raw === undefined) return { count: 0, items: [] }
  if (!Array.isArray(raw)) {
    defects.push({
      field: `dom.${name}`,
      message: `"${name}" must be a list of checks.`,
    })
    return { count: 0, items: [] }
  }
  const items: T[] = []
  raw.forEach((item, index) => {
    const validated = validate(item, `dom.${name}[${index}]`, defects)
    if (validated) items.push(validated)
  })
  return { count: raw.length, items }
}

/**
 * Validate one authored `dom` block, resolving defaults. Returns `null` with at
 * least one defect recorded whenever the block cannot be trusted — including
 * when it is well-formed but checks nothing, which would otherwise read as a
 * declared contract while asserting nothing at all.
 */
export function validateDomContract(
  value: unknown,
  defects: DomContractDefect[]
): ValidatedDomContract | null {
  if (!isPlainObject(value)) {
    defects.push({
      field: "dom",
      message:
        '"dom" must be an object listing the shape checks this design declares.',
    })
    return null
  }
  const before = defects.length
  rejectUnknownKeys(value, CHECK_NAMES, "dom", defects)
  const hasUnknownCheck = defects.length > before

  const headingLines = validateList(
    value.headingLines,
    "headingLines",
    validateHeadingLines,
    defects
  )
  const anchorRelations = validateList(
    value.anchorRelations,
    "anchorRelations",
    validateAnchorRelation,
    defects
  )
  const gridRatios = validateList(
    value.gridRatios,
    "gridRatios",
    validateGridRatio,
    defects
  )
  const declared =
    headingLines.count + anchorRelations.count + gridRatios.count

  // "It checks nothing" is only the right complaint when nothing was misnamed.
  // A block holding one misspelled check has plainly tried to declare
  // something, and saying both would point the author at the wrong repair.
  if (declared === 0 && !hasUnknownCheck) {
    defects.push({
      field: "dom",
      message:
        "This design says it checks its shape, but the checks are empty, so it does not check anything. Either list a check or remove the block.",
    })
    return null
  }
  if (defects.length > before) return null
  return {
    headingLines: headingLines.items,
    anchorRelations: anchorRelations.items,
    gridRatios: gridRatios.items,
  }
}

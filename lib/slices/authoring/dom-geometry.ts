/**
 * What a run measured on the page, and what those numbers prove about a
 * declared `dom` contract (slice-fidelity plan §5 D2).
 *
 * The split is deliberate and is the module's whole design. The browser only
 * *reads* geometry — rectangles, boxes, track widths — and writes them into the
 * run directory. Every judgement about those numbers happens here, in ordinary
 * Node code with no page attached. That is what makes the plan's proof list
 * testable: "multi-node rich text on one line counts as one" is a claim about
 * grouping rectangles, and grouping rectangles does not need a browser.
 *
 * Measurements live in the run directory beside the pictures, so they inherit
 * the same freshness guarantee the pictures have: `mkdtemp` created that
 * directory, so nothing in it survives from an earlier run.
 */
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ValidatedDomContract } from "./reference-dom-contract"

/** A client rect, in CSS pixels relative to the viewport. */
export type MeasuredRect = {
  top: number
  bottom: number
  left: number
  right: number
  width: number
  height: number
}

/**
 * One variant's raw geometry. `null` means the selector matched nothing, which
 * is a different failure from "this run never measured it" — a contract naming
 * a selector the renderer no longer has must say so, not pass quietly.
 */
export type DomMeasurement = {
  /** Every client rect of the complete contents of the selector's first match. */
  lineRects: Record<string, MeasuredRect[] | null>
  /** The selector's first match's border box. */
  boxes: Record<string, MeasuredRect | null>
  /** Resolved column track widths, in CSS pixels. */
  gridTracks: Record<string, number[] | null>
}

/** Keyed by `referenceContractKey(type, variant)`. */
export type DomMeasurementFile = {
  measurements: Record<string, DomMeasurement>
}

export const DOM_MEASUREMENT_FILENAME = "dom-measurements.json"

/** The selectors a run has to look up, grouped by how each must be measured. */
export type DomMeasurementTargets = {
  lineRects: string[]
  boxes: string[]
  gridTracks: string[]
}

/**
 * Reduce a declared contract to the selectors a run must look up. Two checks
 * naming the same selector are looked up once — measuring is a page operation
 * and the answer cannot differ between two reads of the same run.
 */
export function domMeasurementTargets(
  contract: ValidatedDomContract
): DomMeasurementTargets {
  return {
    lineRects: [...new Set(contract.headingLines.map((rule) => rule.selector))],
    boxes: [
      ...new Set(
        contract.anchorRelations.flatMap((rule) => [rule.from, rule.to])
      ),
    ],
    gridTracks: [...new Set(contract.gridRatios.map((rule) => rule.selector))],
  }
}

/**
 * Group inline-fragment rectangles into visual lines (plan §5 D2 rules 2–3).
 *
 * Two rules do the work. Zero-area rectangles are discarded first: an empty
 * text node or a collapsed mark reports a rectangle, and counting those would
 * make line count depend on how the rich text happens to be split into nodes.
 * What remains is grouped by vertical position, because one line of text
 * containing bold or emphasised runs reports one rectangle per run — the raw
 * count is a count of fragments, never of lines.
 */
export function groupRectsIntoLines(
  rects: readonly MeasuredRect[],
  tolerance: number
): MeasuredRect[][] {
  const solid = rects.filter((rect) => rect.width > 0 && rect.height > 0)
  const sorted = [...solid].sort((a, b) => a.top - b.top)

  const lines: MeasuredRect[][] = []
  let lineTop = Number.NaN
  for (const rect of sorted) {
    if (lines.length === 0 || rect.top - lineTop > tolerance) {
      lines.push([rect])
      lineTop = rect.top
      continue
    }
    lines[lines.length - 1].push(rect)
  }
  return lines
}

function describeCount(count: number): string {
  return count === 1 ? "1 line" : `${count} lines`
}

function checkHeadingLines(
  contract: ValidatedDomContract,
  measurement: DomMeasurement,
  failures: string[]
): void {
  for (const rule of contract.headingLines) {
    const rects = measurement.lineRects[rule.selector]
    if (rects === undefined) {
      failures.push(
        `${rule.selector}: this run was not measured for how many lines this text takes, so the design's shape was not checked.`
      )
      continue
    }
    if (rects === null) {
      failures.push(
        `${rule.selector}: nothing on the page matched this, so there was no text to count lines in. The design expects ${describeCount(rule.lines)} here.`
      )
      continue
    }
    const measured = groupRectsIntoLines(rects, rule.groupTolerance).length
    if (measured === rule.lines) continue
    failures.push(
      `${rule.selector}: the design shows this text on ${describeCount(rule.lines)}, but it renders on ${describeCount(measured)}.`
    )
  }
}

function edgeOf(rect: MeasuredRect, edge: keyof MeasuredRect): number {
  return rect[edge]
}

function checkAnchorRelations(
  contract: ValidatedDomContract,
  measurement: DomMeasurement,
  failures: string[]
): void {
  for (const rule of contract.anchorRelations) {
    const missing = [rule.from, rule.to].filter(
      (selector) => !measurement.boxes[selector]
    )
    if (missing.length > 0) {
      const unmeasured = missing.filter(
        (selector) => measurement.boxes[selector] === undefined
      )
      failures.push(
        unmeasured.length > 0
          ? `${unmeasured.join(" and ")}: this run was not measured here, so the design's alignment was not checked.`
          : `${missing.join(" and ")}: nothing on the page matched this, so there was nothing to line up.`
      )
      continue
    }
    const from = measurement.boxes[rule.from]!
    const to = measurement.boxes[rule.to]!
    const delta = edgeOf(to, rule.edge) - edgeOf(from, rule.edge)
    if (Math.abs(delta - rule.expectedDelta) <= rule.tolerance) continue

    const intent =
      rule.expectedDelta === 0
        ? `line up along their ${rule.edge} edge`
        : `sit ${rule.expectedDelta}px apart along their ${rule.edge} edge`
    failures.push(
      `${rule.from} and ${rule.to}: the design has these ${intent}, but they render ${delta.toFixed(1)}px apart.`
    )
  }
}

function checkGridRatios(
  contract: ValidatedDomContract,
  measurement: DomMeasurement,
  failures: string[]
): void {
  for (const rule of contract.gridRatios) {
    const tracks = measurement.gridTracks[rule.selector]
    if (tracks === undefined) {
      failures.push(
        `${rule.selector}: this run was not measured here, so the design's column split was not checked.`
      )
      continue
    }
    if (tracks === null) {
      failures.push(
        `${rule.selector}: nothing on the page matched this, so there were no columns to measure.`
      )
      continue
    }
    if (tracks.length !== 2) {
      const shape =
        tracks.length === 0
          ? "does not lay out as columns at all"
          : tracks.length === 1
            ? "renders as a single column"
            : `renders as ${tracks.length} columns`
      failures.push(
        `${rule.selector}: the design splits this into two columns, but it ${shape}.`
      )
      continue
    }
    const [first, second] = tracks
    if (first <= 0 || second <= 0) {
      failures.push(
        `${rule.selector}: one of the two columns has no width, so the split could not be compared with the design.`
      )
      continue
    }
    const measured = first / second
    if (Math.abs(measured - rule.ratio) <= rule.tolerance) continue
    failures.push(
      `${rule.selector}: the design splits these columns ${rule.ratio.toFixed(2)} to 1, but they render ${measured.toFixed(2)} to 1.`
    )
  }
}

/**
 * Judge one variant's measurements against its declared contract. Returns every
 * failure rather than the first, so one run tells an author everything that
 * moved.
 */
export function evaluateDomContract(
  contract: ValidatedDomContract,
  measurement: DomMeasurement
): string[] {
  const failures: string[] = []
  checkHeadingLines(contract, measurement, failures)
  checkAnchorRelations(contract, measurement, failures)
  checkGridRatios(contract, measurement, failures)
  return failures
}

/**
 * Say what a run actually measured, in the order the contract declares it.
 *
 * This is reported on every run, passing or failing, and it is the answer to
 * "how do I know the shape checks did anything". A check that silently passes
 * looks identical to one that was never asked; a run that prints `h2 on 1 line`
 * has visibly done the work, and a reader comparing two runs can see how much
 * room a measurement has before it would land on a different answer.
 */
export function describeMeasuredShape(
  contract: ValidatedDomContract,
  measurement: DomMeasurement
): string {
  const parts: string[] = []

  for (const rule of contract.headingLines) {
    const rects = measurement.lineRects[rule.selector]
    parts.push(
      rects
        ? `${rule.selector} on ${describeCount(groupRectsIntoLines(rects, rule.groupTolerance).length)}`
        : `${rule.selector} not found`
    )
  }
  for (const rule of contract.anchorRelations) {
    const from = measurement.boxes[rule.from]
    const to = measurement.boxes[rule.to]
    parts.push(
      from && to
        ? `${rule.from}/${rule.to} ${rule.edge} edges ${(edgeOf(to, rule.edge) - edgeOf(from, rule.edge)).toFixed(1)}px apart`
        : `${rule.from}/${rule.to} not found`
    )
  }
  for (const rule of contract.gridRatios) {
    const tracks = measurement.gridTracks[rule.selector]
    parts.push(
      tracks && tracks.length === 2 && tracks[1] > 0
        ? `${rule.selector} columns ${(tracks[0] / tracks[1]).toFixed(2)} to 1`
        : `${rule.selector} not measurable as two columns`
    )
  }

  return parts.join("; ")
}

/**
 * Read the measurements a run captured. A missing file is reported as absent
 * rather than as an empty set: "this run measured nothing" and "this run
 * measured everything and found nothing" must not look the same to the caller
 * deciding whether a declared contract went unchecked.
 */
export async function readDomMeasurements(
  runDir: string
): Promise<DomMeasurementFile | null> {
  let text: string
  try {
    text = await readFile(join(runDir, DOM_MEASUREMENT_FILENAME), "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
  const parsed: unknown = JSON.parse(text)
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    typeof (parsed as DomMeasurementFile).measurements !== "object" ||
    (parsed as DomMeasurementFile).measurements === null
  ) {
    throw new Error(
      `${DOM_MEASUREMENT_FILENAME} in ${runDir} is not in the expected format, so this run's measurements cannot be trusted.`
    )
  }
  return parsed as DomMeasurementFile
}

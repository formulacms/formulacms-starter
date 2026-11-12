import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"

export type BoundedPilotReleaseGate = {
  withinEnvelope: boolean
  totalPagesBelowCap: boolean
  publishedPagesBelowCap: boolean
  totalPagesAtOrAboveWarningThreshold: boolean
  publishedPagesAtOrAboveWarningThreshold: boolean
}

function isBoundedPilotReleaseGate(
  value: unknown
): value is BoundedPilotReleaseGate {
  if (!value || typeof value !== "object") return false
  const candidate = value as Record<string, unknown>
  return (
    typeof candidate.withinEnvelope === "boolean" &&
    typeof candidate.totalPagesBelowCap === "boolean" &&
    typeof candidate.publishedPagesBelowCap === "boolean" &&
    typeof candidate.totalPagesAtOrAboveWarningThreshold === "boolean" &&
    typeof candidate.publishedPagesAtOrAboveWarningThreshold === "boolean"
  )
}

/**
 * Convex normally prints one JSON value, but accept a preceding informational
 * line so a CLI update cannot turn this release guard into a false pass.
 */
export function parseBoundedPilotReleaseGate(
  output: string
): BoundedPilotReleaseGate {
  const candidates = [
    output.trim(),
    ...output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .reverse(),
  ]
  for (const candidate of candidates) {
    try {
      const parsed: unknown = JSON.parse(candidate)
      if (isBoundedPilotReleaseGate(parsed)) return parsed
    } catch {
      // Try the next line; malformed output remains a failing condition.
    }
  }
  throw new Error(
    "Could not parse cms/pages:getBoundedPilotEnvelope output as the bounded-pilot release gate."
  )
}

export function assertBoundedPilotReleaseGate(
  gate: BoundedPilotReleaseGate
): void {
  if (
    gate.withinEnvelope &&
    gate.totalPagesBelowCap &&
    gate.publishedPagesBelowCap
  ) {
    return
  }
  throw new Error(
    "Bounded pilot release gate failed: this deployment has reached the 500-row route/sitemap sentinel. Keep both total and published page counts below 500 until ROUTE-04 is complete."
  )
}

export function checkBoundedPilotReleaseGate(output: string): void {
  assertBoundedPilotReleaseGate(parseBoundedPilotReleaseGate(output))
}

export function assertBoundedPilotCapacityAlert(
  gate: BoundedPilotReleaseGate
): void {
  const warnedScopes = [
    gate.totalPagesAtOrAboveWarningThreshold ? "total pages" : null,
    gate.publishedPagesAtOrAboveWarningThreshold ? "published pages" : null,
  ].filter((scope): scope is string => scope !== null)

  if (warnedScopes.length === 0) return

  throw new Error(
    `Bounded pilot capacity alert: ${warnedScopes.join(" and ")} ${
      warnedScopes.length === 1 ? "has" : "have"
    } reached the 80% early-warning threshold. The deployment remains within its 499-page pilot limit, but alert the deployment owner and plan ROUTE-04 before further growth.`
  )
}

export function checkBoundedPilotCapacityAlert(output: string): void {
  assertBoundedPilotCapacityAlert(parseBoundedPilotReleaseGate(output))
}

function main() {
  const output = execFileSync(
    "pnpm",
    ["exec", "convex", "run", "cms/pages:getBoundedPilotEnvelope", "{}"],
    { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }
  )
  if (process.argv.includes("--capacity-alert")) {
    checkBoundedPilotCapacityAlert(output)
    console.log(
      "✓ Bounded pilot capacity is below the early-warning threshold."
    )
    return
  }

  checkBoundedPilotReleaseGate(output)
  console.log("✓ Bounded pilot route/sitemap envelope is safe for promotion.")
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}

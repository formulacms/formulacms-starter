import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

type CheckStatus = "passed" | "warning" | "failed"
type FeedbackSeverity = "blocker" | "warning" | "info"
type FeedbackStatus = "open" | "monitoring" | "closed"
type FeedbackOwner = "operator" | "starter-maintainer"
type FeedbackSource = "preflight" | "app-creation" | "feedback"
type FeedbackType = "failure" | "friction" | "artifact"

type StarterCheck = {
  name: string
  status: CheckStatus
  message: string
}

type PreflightReport = {
  name: "starter-preflight"
  status: "passed" | "failed"
  startedAt?: string
  finishedAt?: string
  checks: StarterCheck[]
}

type AppCreationReport = {
  name: "starter-app-creation"
  status: "passed" | "failed"
  startedAt?: string
  finishedAt?: string
  baseUrl?: string
  error?: string | null
  failures: string[]
  checkedPages?: unknown[]
  checkedRedirects?: unknown[]
}

type InputArtifact = {
  label: string
  path: string
  status: "present" | "missing" | "invalid"
  reportStatus: string | null
}

export type FeedbackItem = {
  id: string
  source: FeedbackSource
  type: FeedbackType
  severity: FeedbackSeverity
  title: string
  detail: string
  proposedFollowUp: string
  owner: FeedbackOwner
  status: FeedbackStatus
}

export type StarterFeedbackReport = {
  name: "starter-feedback"
  status: "ready" | "needs-action"
  generatedAt: string
  inputs: {
    preflightReport: InputArtifact
    appCreationReport: InputArtifact
  }
  summary: {
    highestSeverity: FeedbackSeverity
    blockers: number
    warnings: number
    info: number
    openItems: number
  }
  artifacts: Array<{
    label: string
    path: string
    status: "present" | "missing" | "invalid"
  }>
  items: FeedbackItem[]
}

type LoadedReport<T> =
  | { artifact: InputArtifact; report: T | null }
  | { artifact: InputArtifact; report: null }

const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9_-]{12,}/g,
  /(SECRET|TOKEN|PASSWORD|KEY)=([^\s,]+)/gi,
]

function redact(value: string) {
  return SECRET_PATTERNS.reduce(
    (message, pattern) =>
      message.replace(pattern, (match, key: string | undefined) =>
        key ? `${key}=<redacted>` : "<redacted>"
      ),
    value
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
}

function isStarterCheck(value: unknown): value is StarterCheck {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    ["passed", "warning", "failed"].includes(String(value.status)) &&
    typeof value.message === "string"
  )
}

function parsePreflightReport(value: unknown): PreflightReport | null {
  if (!isRecord(value)) return null
  if (value.name !== "starter-preflight") return null
  if (value.status !== "passed" && value.status !== "failed") return null
  if (!Array.isArray(value.checks) || !value.checks.every(isStarterCheck)) {
    return null
  }
  return value as PreflightReport
}

function parseAppCreationReport(value: unknown): AppCreationReport | null {
  if (!isRecord(value)) return null
  if (value.name !== "starter-app-creation") return null
  if (value.status !== "passed" && value.status !== "failed") return null
  if (!isStringArray(value.failures)) return null
  return value as AppCreationReport
}

function loadReport<T>(
  label: string,
  path: string,
  parse: (value: unknown) => T | null
): LoadedReport<T> {
  if (!existsSync(path)) {
    return {
      artifact: { label, path, status: "missing", reportStatus: null },
      report: null,
    }
  }

  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"))
    const report = parse(parsed)
    if (!report) {
      return {
        artifact: { label, path, status: "invalid", reportStatus: null },
        report: null,
      }
    }
    const reportStatus = isRecord(parsed) ? String(parsed.status ?? "") : null
    return {
      artifact: { label, path, status: "present", reportStatus },
      report,
    }
  } catch {
    return {
      artifact: { label, path, status: "invalid", reportStatus: null },
      report: null,
    }
  }
}

function slugify(value: string) {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
  return slug || "item"
}

function createId(source: FeedbackSource, title: string, index: number) {
  return `${source}-${slugify(title)}-${index + 1}`
}

function ownerForPreflight(name: string): FeedbackOwner {
  if (name === ".env.local.example") return "starter-maintainer"
  if (name === "Node.js" || name === "pnpm") return "operator"
  if (name === "dependencies" || name.includes("Convex")) return "operator"
  if (name.startsWith("NEXT_PUBLIC") || name.includes("AUTH")) return "operator"
  return "operator"
}

function ownerForAppFailure(message: string): FeedbackOwner {
  const normalized = message.toLowerCase()
  if (
    normalized.includes("not reachable") ||
    normalized.includes("run `pnpm build:local`") ||
    normalized.includes("redirected to setup") ||
    normalized.includes("localhost-first")
  ) {
    return "operator"
  }
  return "starter-maintainer"
}

function followUpForPreflight(check: StarterCheck) {
  if (check.status === "failed") {
    return `Fix ${check.name} before rerunning \`pnpm check:app-creation:report\`.`
  }
  return `Review ${check.name}; document whether it is acceptable for this app-creation run.`
}

function followUpForAppFailure(message: string) {
  if (ownerForAppFailure(message) === "operator") {
    return "Fix local setup or onboarding state, then rerun `pnpm check:app-creation:report`."
  }
  return "Investigate the failing public UX contract, add or update focused coverage, then rerun the report command."
}

function addMissingArtifactItem(
  items: FeedbackItem[],
  artifact: InputArtifact,
  index: number
) {
  if (artifact.status === "present") return
  const title = `${artifact.label} ${artifact.status}`
  items.push({
    id: createId("feedback", title, index),
    source: "feedback",
    type: "artifact",
    severity: "warning",
    title,
    detail:
      artifact.status === "missing"
        ? `${artifact.path} was not found.`
        : `${artifact.path} could not be parsed as the expected JSON report.`,
    proposedFollowUp:
      "Run `pnpm check:app-creation:report` to refresh local reports before handoff.",
    owner: "operator",
    status: "open",
  })
}

export function buildFeedbackReport(options: {
  preflightPath: string
  appCreationPath: string
  generatedAt?: Date
}): StarterFeedbackReport {
  const preflight = loadReport(
    "preflight report",
    options.preflightPath,
    parsePreflightReport
  )
  const appCreation = loadReport(
    "app-creation report",
    options.appCreationPath,
    parseAppCreationReport
  )
  const items: FeedbackItem[] = []

  for (const [index, artifact] of [
    preflight.artifact,
    appCreation.artifact,
  ].entries()) {
    addMissingArtifactItem(items, artifact, index)
  }

  if (preflight.report) {
    preflight.report.checks.forEach((check, index) => {
      if (check.status === "passed") return
      items.push({
        id: createId("preflight", check.name, index),
        source: "preflight",
        type: check.status === "failed" ? "failure" : "friction",
        severity: check.status === "failed" ? "blocker" : "warning",
        title: check.name,
        detail: redact(check.message),
        proposedFollowUp: followUpForPreflight(check),
        owner: ownerForPreflight(check.name),
        status: "open",
      })
    })
  }

  if (appCreation.report) {
    const appFailures = [
      ...(appCreation.report.error ? [appCreation.report.error] : []),
      ...appCreation.report.failures,
    ]
    appFailures.forEach((failure, index) => {
      items.push({
        id: createId("app-creation", failure, index),
        source: "app-creation",
        type: "failure",
        severity: "blocker",
        title: `App creation QA ${index + 1}`,
        detail: redact(failure),
        proposedFollowUp: followUpForAppFailure(failure),
        owner: ownerForAppFailure(failure),
        status: "open",
      })
    })
  }

  if (items.length === 0) {
    items.push({
      id: "feedback-no-open-items-1",
      source: "feedback",
      type: "artifact",
      severity: "info",
      title: "No open feedback items",
      detail:
        "Preflight and app-creation reports did not contain failures or warnings.",
      proposedFollowUp:
        "Attach `.cms-starter/feedback-report.json` to the local handoff or PR notes.",
      owner: "operator",
      status: "closed",
    })
  }

  const blockers = items.filter((item) => item.severity === "blocker").length
  const warnings = items.filter((item) => item.severity === "warning").length
  const info = items.filter((item) => item.severity === "info").length
  const highestSeverity: FeedbackSeverity = blockers
    ? "blocker"
    : warnings
      ? "warning"
      : "info"

  return {
    name: "starter-feedback",
    status: blockers || warnings ? "needs-action" : "ready",
    generatedAt: (options.generatedAt ?? new Date()).toISOString(),
    inputs: {
      preflightReport: preflight.artifact,
      appCreationReport: appCreation.artifact,
    },
    summary: {
      highestSeverity,
      blockers,
      warnings,
      info,
      openItems: items.filter((item) => item.status === "open").length,
    },
    artifacts: [preflight.artifact, appCreation.artifact].map((artifact) => ({
      label: artifact.label,
      path: artifact.path,
      status: artifact.status,
    })),
    items,
  }
}

function printSummary(report: StarterFeedbackReport, outputPath: string) {
  const noun = report.summary.openItems === 1 ? "item" : "items"
  console.log(
    `Starter feedback ${report.status}: ${report.summary.openItems} open ${noun}, highest severity ${report.summary.highestSeverity}.`
  )
  console.log(`Wrote ${outputPath}`)
  for (const item of report.items.filter((entry) => entry.status === "open")) {
    console.log(
      `- [${item.severity}] ${item.title} (${item.owner}): ${item.proposedFollowUp}`
    )
  }
}

export function writeFeedbackReport(options: {
  preflightPath: string
  appCreationPath: string
  outputPath: string
}) {
  const report = buildFeedbackReport(options)
  mkdirSync(dirname(options.outputPath), { recursive: true })
  writeFileSync(options.outputPath, `${JSON.stringify(report, null, 2)}\n`)
  return report
}

function main() {
  const preflightPath =
    process.env.STARTER_PREFLIGHT_REPORT ?? ".cms-starter/preflight-report.json"
  const appCreationPath =
    process.env.STARTER_APP_QA_REPORT ?? ".cms-starter/app-creation-report.json"
  const outputPath =
    process.env.STARTER_FEEDBACK_REPORT ?? ".cms-starter/feedback-report.json"
  const report = writeFeedbackReport({
    preflightPath,
    appCreationPath,
    outputPath,
  })
  printSummary(report, outputPath)
}

const currentFile = fileURLToPath(import.meta.url)
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : ""
if (currentFile === invokedFile) main()

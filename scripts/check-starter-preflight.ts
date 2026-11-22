import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { spawnSync } from "node:child_process"
import { chromium } from "playwright"
import { checkStoredModuleIds } from "./lib/stored-module-state"

type CheckStatus = "passed" | "warning" | "failed"

type CheckResult = {
  name: string
  status: CheckStatus
  message: string
  /** The check could not run (for example, the backend could not be read). */
  inconclusive?: true
}

const startedAt = new Date()
const reportPath = process.env.STARTER_PREFLIGHT_REPORT
const allowRemote = process.env.STARTER_PREFLIGHT_ALLOW_REMOTE === "1"
const strict = process.argv.slice(2).includes("--strict")
const expectedPublicOrigin = new URL(
  process.env.PUBLIC_BASE_URL ?? "http://localhost:3000"
).origin
const checks: CheckResult[] = []

function addCheck(
  name: string,
  status: CheckStatus,
  message: string,
  inconclusive = false
) {
  checks.push(
    inconclusive
      ? { name, status, message, inconclusive: true }
      : { name, status, message }
  )
}

function readEnvFile(filePath: string) {
  const values = new Map<string, string>()
  const source = readFileSync(filePath, "utf8")
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith("#")) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    const [, key, rawValue] = match
    let value = rawValue.trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    values.set(key, value)
  }
  return values
}

function isPlaceholder(value: string) {
  const normalized = value.trim().toLowerCase()
  return (
    !normalized ||
    normalized.includes("replace-with") ||
    normalized.includes("your-") ||
    normalized.includes("example.com") ||
    normalized.includes("your-deployment")
  )
}

function parseMajorVersion(value: string) {
  const match = /^v?(\d+)/.exec(value.trim())
  return match ? Number(match[1]) : null
}

function commandOutput(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
  if (result.error) return null
  if (result.status !== 0) return null
  return result.stdout.trim()
}

function checkMajorVersion(
  name: string,
  actual: string | null,
  minimum: number
) {
  if (!actual) {
    addCheck(name, "failed", `${name} is not available on PATH.`)
    return
  }
  const major = parseMajorVersion(actual)
  if (major === null) {
    addCheck(name, "failed", `Could not parse ${name} version "${actual}".`)
    return
  }
  if (major < minimum) {
    addCheck(
      name,
      "failed",
      `${name} ${actual} is too old; use ${minimum}.x or newer.`
    )
    return
  }
  addCheck(name, "passed", `${name} ${actual} satisfies >=${minimum}.`)
}

function checkPlaywrightChromium() {
  const executablePath = chromium.executablePath()
  if (!executablePath || !existsSync(executablePath)) {
    // Only the browser checks need Chromium, so it blocks in strict mode only.
    addCheck(
      "Playwright Chromium",
      strict ? "failed" : "warning",
      'Playwright Chromium is not installed. You need it only for the browser checks; run "pnpm exec playwright install chromium" before them.'
    )
    return
  }
  addCheck("Playwright Chromium", "passed", "Playwright Chromium is installed.")
}

function parseUrl(value: string, label: string) {
  try {
    return new URL(value)
  } catch {
    addCheck(label, "failed", `${label} is not a valid URL.`)
    return null
  }
}

function isLocalUrl(url: URL) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname)
}

function warnIfDifferentOrigin(value: string, label: string) {
  const url = parseUrl(value, label)
  if (!url) return
  if (url.origin !== expectedPublicOrigin) {
    addCheck(
      label,
      "warning",
      `${label} is ${url.origin}, but local verification is checking ${expectedPublicOrigin}. Keep them aligned unless you are intentionally testing split origins.`
    )
  }
}

function checkRequiredEnv(env: Map<string, string>, key: string) {
  const value = env.get(key) ?? ""
  if (isPlaceholder(value)) {
    addCheck(key, "failed", `${key} is missing or still uses a placeholder.`)
    return
  }
  addCheck(key, "passed", `${key} is set.`)
}

// Half of this app's configuration lives in the *Convex deployment* env, which
// `.env.local` never reaches: contact-form IP proofs, publish-time
// revalidation, and the one-time owner claim all read `process.env` inside the
// Convex runtime. Checking only `.env.local` therefore passes a deployment that
// cannot sign anyone in. Read the deployment side once and compare by name.
//
// Nothing below ever prints, logs, or writes a secret VALUE — only names,
// presence, and equality.
type ConvexEnvSnapshot =
  | { available: true; values: Map<string, string> }
  | { available: false; reason: string }

function readConvexEnv(): ConvexEnvSnapshot {
  // Request values explicitly so agent detection cannot change the parser input.
  const result = spawnSync("pnpm", ["exec", "convex", "env", "list", "--include-values"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 60_000,
  })
  if (result.error) {
    return {
      available: false,
      reason: "the Convex CLI did not run (not installed, or it timed out)",
    }
  }
  if (result.status !== 0) {
    return {
      available: false,
      reason:
        'the Convex CLI found no readable deployment (run "pnpm dev" once, and sign in if prompted)',
    }
  }

  const values = new Map<string, string>()
  for (const rawLine of result.stdout.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line)
    if (!match) continue
    values.set(match[1], match[2])
  }
  return { available: true, values }
}

type PairedSecret = {
  key: string
  /** Whether an absent local value blocks preflight or only warns. */
  localRequired: boolean
  /** What breaks when the Convex side is absent or different. */
  consequence: string
}

const PAIRED_SECRETS: PairedSecret[] = [
  {
    key: "CONTACT_IP_PROOF_SECRET",
    localRequired: true,
    consequence:
      "Contact-form submissions cannot prove where they came from and are rejected.",
  },
  {
    key: "REVALIDATE_SECRET",
    localRequired: false,
    consequence: "Publishing a page never refreshes the public site.",
  },
]

function checkPairedSecret(
  env: Map<string, string>,
  convex: ConvexEnvSnapshot,
  { key, localRequired, consequence }: PairedSecret
) {
  const localValue = env.get(key) ?? ""
  if (isPlaceholder(localValue)) {
    if (localRequired) {
      addCheck(key, "failed", `${key} is missing or still uses a placeholder.`)
      return
    }
    addCheck(
      key,
      "warning",
      `${key} is not set. Run "pnpm dev" once; it sets it. Publishing needs it to refresh cached pages.`
    )
    return
  }

  if (!convex.available) {
    addCheck(
      key,
      "warning",
      `${key} is set in .env.local but could not be checked against the active Convex deployment: ${convex.reason}.`,
      true
    )
    return
  }

  const convexValue = convex.values.get(key) ?? ""
  if (isPlaceholder(convexValue)) {
    addCheck(
      key,
      "failed",
      `${key} is missing from the active Convex deployment. ${consequence} Run "pnpm dev" once; it copies the value from .env.local. To set it by hand, see docs/starter/local-setup.md.`
    )
    return
  }
  if (convexValue !== localValue) {
    addCheck(
      key,
      "failed",
      `${key} does not match the active Convex deployment. ${consequence}`
    )
    return
  }

  addCheck(key, "passed", `${key} matches the active Convex deployment.`)
}

function checkConvexOwnerClaim(
  env: Map<string, string>,
  convex: ConvexEnvSnapshot
) {
  const currentKey = "FORMULACMS_OWNER_CLAIM"
  const legacyKey = "NEXTCMS_OWNER_CLAIM"
  const label = `${currentKey} or ${legacyKey}`

  // The owner claim is a Convex-only setup code; keeping a copy in .env.local
  // risks committing it or baking it into build metadata.
  for (const key of [currentKey, legacyKey]) {
    if (isPlaceholder(env.get(key) ?? "")) continue
    addCheck(
      key,
      "warning",
      `${key} is present in .env.local. It belongs only in the Convex deployment env; remove the local copy.`
    )
  }

  if (!convex.available) {
    addCheck(
      label,
      "warning",
      `${label} could not be checked against the active Convex deployment: ${convex.reason}.`,
      true
    )
    return
  }

  const configured = !isPlaceholder(convex.values.get(currentKey) ?? "")
    ? currentKey
    : !isPlaceholder(convex.values.get(legacyKey) ?? "")
      ? legacyKey
      : null
  if (!configured) {
    addCheck(
      label,
      "failed",
      `${label} is missing from the active Convex deployment, so /setup cannot claim ownership and dead-ends at the account step. Before setup is finished, run "pnpm dev" once; it makes the code and shows it. To set it by hand, see docs/starter/local-setup.md.`
    )
    return
  }

  addCheck(
    currentKey,
    "passed",
    `${configured} is set in the active Convex deployment.`
  )
}

function writeReport(status: "passed" | "failed") {
  if (!reportPath) return
  const finishedAt = new Date()
  const report = {
    name: "starter-preflight",
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    allowRemote,
    strict,
    checks,
    // Names of the checks that could not run, in check order.
    inconclusiveChecks: checks
      .filter((check) => check.inconclusive)
      .map((check) => check.name),
  }
  try {
    mkdirSync(dirname(reportPath), { recursive: true })
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.warn(
      `Could not write preflight report to ${reportPath}: ${message}`
    )
  }
}

// The same checks as the starter build (pnpm check:factories). Loaded at run
// time so that a missing or broken gate file is reported as a check result
// instead of stopping the preflight.
async function checkFactories() {
  let checks
  try {
    const { runFactoryChecks } = await import("../lib/factories/gate")
    checks = await runFactoryChecks()
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    addCheck(
      "Factory checks",
      "failed",
      `The factory checks could not load: ${reason}\nRestore the listed file from git, then run pnpm check:factories.`
    )
    return
  }
  for (const { name, failure } of checks) {
    if (failure) addCheck(name, "failed", failure)
    else addCheck(name, "passed", `${name}: up to date.`)
  }
}

// Loaded at run time so that a missing or broken module list is reported as
// a check result instead of stopping the preflight.
async function releaseModuleIds(): Promise<string[] | undefined> {
  try {
    const { GENERATED_MODULE_CATALOG } = await import(
      "../lib/modules/catalog.generated"
    )
    return GENERATED_MODULE_CATALOG.map(({ id }) => id)
  } catch {
    return undefined
  }
}

async function main() {
  checkMajorVersion("Node.js", process.versions.node, 22)
  checkMajorVersion("pnpm", commandOutput("pnpm", ["--version"]), 11)

  if (!existsSync("node_modules")) {
    addCheck(
      "dependencies",
      "warning",
      "node_modules is missing; run `pnpm install` before local verification."
    )
  } else {
    addCheck("dependencies", "passed", "node_modules exists.")
    checkPlaywrightChromium()
  }

  await checkFactories()

  if (existsSync(".env")) {
    addCheck(
      ".env",
      "warning",
      "Found .env; starter setup expects .env.local for local development."
    )
  }

  if (!existsSync(".env.local.example")) {
    addCheck(".env.local.example", "failed", "Missing committed env template.")
  } else {
    const example = readEnvFile(".env.local.example")
    // Convex writes these on first run; the template may document them only.
    const commentedConvexExamples = new Set(
      [
        ...readFileSync(".env.local.example", "utf8").matchAll(
          /^\s*#\s*(CONVEX_DEPLOYMENT|NEXT_PUBLIC_CONVEX_URL)\s*=/gm
        ),
      ].map((match) => match[1])
    )
    for (const key of ["CONVEX_DEPLOYMENT", "NEXT_PUBLIC_CONVEX_URL"]) {
      if (!example.has(key) && !commentedConvexExamples.has(key)) {
        addCheck(
          ".env.local.example",
          "failed",
          `.env.local.example is missing ${key}.`
        )
      }
    }
  }

  if (!existsSync(".env.local")) {
    addCheck(
      ".env.local",
      "failed",
      'Missing .env.local. Run "pnpm dev" once; it creates the file.'
    )
  } else {
    addCheck(".env.local", "passed", ".env.local exists.")
    const env = readEnvFile(".env.local")
    for (const key of ["CONVEX_DEPLOYMENT", "NEXT_PUBLIC_CONVEX_URL"]) {
      checkRequiredEnv(env, key)
    }

    const nextPublicSiteUrl = env.get("NEXT_PUBLIC_SITE_URL")
    if (nextPublicSiteUrl && !allowRemote) {
      const url = parseUrl(nextPublicSiteUrl, "NEXT_PUBLIC_SITE_URL")
      if (url && !isLocalUrl(url)) {
        addCheck(
          "NEXT_PUBLIC_SITE_URL",
          "warning",
          "NEXT_PUBLIC_SITE_URL points at a remote origin; use localhost and a fresh local deployment for app-creation verification."
        )
      } else if (url) {
        warnIfDifferentOrigin(nextPublicSiteUrl, "NEXT_PUBLIC_SITE_URL")
      }
    }

    const deployment = env.get("CONVEX_DEPLOYMENT") ?? ""
    if (deployment.startsWith("prod:") && !allowRemote) {
      addCheck(
        "CONVEX_DEPLOYMENT",
        "failed",
        "CONVEX_DEPLOYMENT points at production. Use a dev/local deployment for local app creation checks."
      )
    }

    const convex = readConvexEnv()
    for (const pairing of PAIRED_SECRETS) {
      checkPairedSecret(env, convex, pairing)
    }
    checkConvexOwnerClaim(env, convex)

    const stored = checkStoredModuleIds({
      root: process.cwd(),
      knownIds: await releaseModuleIds(),
    })
    addCheck(
      "Stored modules",
      stored.status,
      stored.message,
      stored.inconclusive === true
    )
  }

  if (!existsSync(".convex/local")) {
    addCheck(
      "Convex local state",
      "warning",
      'No .convex/local directory found yet; run "pnpm dev" once before browser checks.'
    )
  } else {
    addCheck("Convex local state", "passed", ".convex/local exists.")
  }

  const failures = checks.filter((check) => check.status === "failed")
  const warnings = checks.filter((check) => check.status === "warning")
  const status =
    failures.length > 0 || (strict && warnings.length > 0) ? "failed" : "passed"
  writeReport(status)

  if (status === "failed") {
    console.error(
      strict && failures.length === 0
        ? "Starter preflight failed in strict mode:"
        : "Starter preflight failed:"
    )
    for (const failure of failures) {
      console.error(`- ${failure.name}: ${failure.message}`)
    }
    if (warnings.length > 0) {
      console.error(strict ? "Blocking warnings:" : "Warnings:")
      for (const warning of warnings) {
        console.error(`- ${warning.name}: ${warning.message}`)
      }
    }
    process.exit(1)
  }

  for (const warning of warnings) {
    console.log(`Warning: ${warning.name}: ${warning.message}`)
  }
  // A check that could not run is never reported as passed.
  const notRun = warnings.filter((warning) => warning.inconclusive)
  if (notRun.length > 0) {
    const verified = checks.filter((check) => check.status === "passed").length
    const otherWarnings = warnings.length - notRun.length
    console.log(
      `Starter preflight finished: ${verified} verified, ${notRun.length} could not run${otherWarnings > 0 ? `, ${otherWarnings} other warnings` : ""}.`
    )
    for (const check of notRun) {
      console.log(
        `- ${check.name} could not run. Start "pnpm dev", then run "pnpm check:preflight" again.`
      )
    }
    return
  }
  console.log(
    `Starter preflight passed (${checks.length - warnings.length} checks, ${warnings.length} warnings).`
  )
}

void main()

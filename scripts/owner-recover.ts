// `pnpm owner:recover`: prints a one-time owner recovery link (ADR-0056 rule
// 4). It runs `convex run cms/recovery:createRecoveryLink` on this app's own
// deployment and prints only the link and its expiry. The owner opens the link
// and creates a new username and password; ownership moves to that account.
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const FUNCTION = "cms/recovery:createRecoveryLink"
const RUN_TIMEOUT_MS = 60_000

const HELP = `Print a one-time link that lets the site owner choose a new username and password.

Usage:
  pnpm owner:recover
  pnpm owner:recover --prod
  pnpm owner:recover --deployment <name>
  pnpm owner:recover --base-url https://example.com

Options:
  --prod                  Use the project's production deployment.
  --deployment <name>     Use another Convex deployment.
  --base-url <origin>     The site address the link opens. Default: the
                          address saved in Settings.
  -h, --help              Show this help.

Without --prod or --deployment, the command uses the deployment in .env.local.
The link works once and expires after 15 minutes. A new link replaces the
previous one.`

export type RecoverOptions = {
  baseUrl: string | undefined
  deployment: string | undefined
  help: boolean
  prod: boolean
}

export type RecoverRunResult = { code: number | null; stdout: string; stderr: string }
export type RecoverRunner = (args: string[]) => Promise<RecoverRunResult>

function optionValue(args: string[], index: number, option: string) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${option} needs a value.`)
  }
  return value
}

export function parseRecoverOptions(args: string[]): RecoverOptions {
  const options: RecoverOptions = {
    baseUrl: undefined,
    deployment: undefined,
    help: false,
    prod: false,
  }
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--prod") options.prod = true
    else if (arg === "--help" || arg === "-h") options.help = true
    else if (arg === "--deployment") {
      options.deployment = optionValue(args, index, arg)
      index += 1
    } else if (arg === "--base-url") {
      const value = optionValue(args, index, arg)
      let url: URL
      try {
        url = new URL(value)
      } catch {
        throw new Error("--base-url must be a full address, like https://example.com.")
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("--base-url must start with http:// or https://.")
      }
      options.baseUrl = url.origin
      index += 1
    } else throw new Error(`Unknown option: ${arg}`)
  }
  if (options.prod && options.deployment !== undefined) {
    throw new Error("Choose either --prod or --deployment, not both.")
  }
  return options
}

/** The `convex run` arguments. No secret is ever an argument. */
export function convexRunArgs(options: RecoverOptions): string[] {
  return [
    "run",
    FUNCTION,
    JSON.stringify(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    ...(options.prod ? ["--prod"] : []),
    ...(options.deployment !== undefined ? ["--deployment", options.deployment] : []),
  ]
}

/** The lines to print, or an Error with a plain instruction. */
export function readRecoverResult(result: RecoverRunResult): string[] {
  if (result.code !== 0) {
    if (result.stderr.includes("RECOVERY_BASE_URL_MISSING")) {
      throw new Error(
        "The site has no saved address, so the link has nowhere to point. Run the command again with --base-url and your site address, for example: pnpm owner:recover --base-url http://localhost:3000"
      )
    }
    const lines = result.stderr
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
    throw new Error(
      lines.slice(-3).join(" ") ||
        (result.code === null
          ? `The Convex command did not finish within ${RUN_TIMEOUT_MS / 1000} seconds.`
          : `The Convex command ended with exit code ${result.code}.`)
    )
  }
  let parsed: { url?: unknown; expiresAt?: unknown } | null
  try {
    parsed = JSON.parse(result.stdout.trim()) as typeof parsed
  } catch {
    throw new Error("The Convex command did not return a recovery link.")
  }
  if (typeof parsed?.url !== "string" || typeof parsed.expiresAt !== "string") {
    throw new Error("The Convex command did not return a recovery link.")
  }
  return [
    "Owner recovery link (works once):",
    parsed.url,
    `It expires at ${parsed.expiresAt}.`,
  ]
}

/** Runs the installed Convex CLI with Node itself: no shell. */
function convexRunner(projectRoot: string): RecoverRunner {
  const packageRoot = join(projectRoot, "node_modules", "convex")
  const { bin } = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")) as {
    bin: string | Record<string, string>
  }
  const entry = join(packageRoot, typeof bin === "string" ? bin : bin.convex)
  return (args) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, [entry, ...args], {
        cwd: projectRoot,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: RUN_TIMEOUT_MS,
      })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
      child.once("error", (error) => resolve({ code: null, stdout, stderr: stderr || error.message }))
      child.once("close", (code) => resolve({ code, stdout, stderr }))
    })
}

export async function main(
  args = process.argv.slice(2),
  runner: RecoverRunner = convexRunner(process.cwd())
): Promise<string[]> {
  const options = parseRecoverOptions(args)
  if (options.help) return [HELP]
  return readRecoverResult(await runner(convexRunArgs(options)))
}

const invokedPath = process.argv[1]?.replaceAll("\\", "/")
if (invokedPath?.endsWith("/scripts/owner-recover.ts")) {
  main().then(
    (lines) => process.stdout.write(`${lines.join("\n")}\n`),
    (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error)
      process.stderr.write(`Owner recovery failed: ${message}\n`)
      process.exitCode = 1
    }
  )
}

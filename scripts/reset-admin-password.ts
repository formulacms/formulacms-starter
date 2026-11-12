import type { ReadStream, WriteStream } from "node:tty"
import { createRequire } from "node:module"

const MIN_PASSWORD_LENGTH = 8
const MAX_PASSWORD_LENGTH = 128
const RESET_FUNCTION = "cms/adminPassword:resetAdminPassword"

export type ResetOptions = {
  deployment: string | undefined
  envFile: string | undefined
  help: boolean
  prod: boolean
  selfHosted: boolean
}

export type RecoveryPrompts = {
  text(label: string): Promise<string>
  secret(label: string): Promise<string>
}

type ResetRequest = {
  email: string
  newPassword: string
}

const HELP = `Reset the current formulacms owner's password.

Usage:
  pnpm admin:reset-password
  pnpm admin:reset-password --prod
  pnpm admin:reset-password --deployment <selector>

Options:
  --prod                       Target the project's production deployment.
  --deployment <selector>      Target an explicit Convex deployment.
  --env-file <path>            Read Convex deployment selection from this file.
  --self-hosted                Use a loopback self-hosted deployment from --env-file.
  -h, --help                   Show this help.

The email and password are always requested interactively. Password flags,
environment variables, piped input, and unattended use are intentionally not
supported.`

function optionValue(args: string[], index: number, option: string) {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("-")) {
    throw new Error(`${option} requires a value.`)
  }
  return value
}

export function parseResetOptions(args: string[]): ResetOptions {
  const options: ResetOptions = {
    deployment: undefined,
    envFile: undefined,
    help: false,
    prod: false,
    selfHosted: false,
  }

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--prod") {
      options.prod = true
      continue
    }
    if (arg === "--deployment") {
      options.deployment = optionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg === "--env-file") {
      options.envFile = optionValue(args, index, arg)
      index += 1
      continue
    }
    if (arg === "--self-hosted") {
      options.selfHosted = true
      continue
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true
      continue
    }
    throw new Error(`Unknown option: ${arg}`)
  }

  if (options.prod && options.deployment !== undefined) {
    throw new Error("Choose either --prod or --deployment, not both.")
  }
  if (options.selfHosted && options.envFile === undefined) {
    throw new Error("Self-hosted mode requires --env-file.")
  }
  if (
    options.selfHosted &&
    (options.prod || options.deployment !== undefined)
  ) {
    throw new Error(
      "Self-hosted mode cannot be combined with deployment selectors."
    )
  }
  return options
}

export function convexTargetArgs(options: ResetOptions) {
  if (options.selfHosted) return []
  if (options.prod) return ["--prod"]
  return ["--deployment", options.deployment ?? "dev"]
}

function parseEnvironmentFile(contents: string) {
  const require = createRequire(import.meta.url)
  const convexPackageJson = require.resolve("convex/package.json")
  const requireFromConvex = createRequire(convexPackageJson)
  const dotenv = requireFromConvex("dotenv") as {
    parse(source: string): Record<string, string>
  }
  return new Map(Object.entries(dotenv.parse(contents)))
}

function isLoopbackUrl(value: string) {
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.username === "" &&
      url.password === ""
    )
  } catch {
    return false
  }
}

/** Validate in memory; never return or print configuration values. */
export function selfHostedEnvIsValid(
  contents: string,
  ambient: NodeJS.ProcessEnv = process.env
) {
  const values = parseEnvironmentFile(contents)
  const url = values.get("CONVEX_SELF_HOSTED_URL")
  const adminKey = values.get("CONVEX_SELF_HOSTED_ADMIN_KEY")
  const hasConflictingSelector = [
    "CONVEX_DEPLOYMENT",
    "CONVEX_DEPLOY_KEY",
    "CONVEX_DEPLOYMENT_TOKEN",
  ].some((name) => values.has(name) || ambient[name] !== undefined)
  return (
    url !== undefined &&
    adminKey !== undefined &&
    adminKey.length > 0 &&
    isLoopbackUrl(url) &&
    !hasConflictingSelector
  )
}

async function assertSelfHostedEnvFile(envFile: string) {
  const { readFile } = await import("node:fs/promises")
  let contents: string
  try {
    contents = await readFile(envFile, "utf8")
  } catch {
    throw new Error("Could not read the self-hosted configuration file.")
  }
  if (!selfHostedEnvIsValid(contents)) {
    throw new Error(
      "Self-hosted configuration must contain a loopback URL and admin key, with no deployment selector."
    )
  }
}

function confirmationPhrase(options: ResetOptions) {
  if (options.selfHosted) return "RESET SELF-HOSTED LOCAL"
  if (options.prod) return "RESET PRODUCTION"
  if (options.deployment !== undefined) {
    return `RESET ${options.deployment}`
  }
  return null
}

export async function collectResetRequest(
  options: ResetOptions,
  prompts: RecoveryPrompts
): Promise<ResetRequest> {
  const phrase = confirmationPhrase(options)
  if (phrase !== null) {
    const confirmation = await prompts.text(`Type ${phrase} to continue: `)
    if (confirmation !== phrase) {
      throw new Error(`Confirmation did not match "${phrase}".`)
    }
  }

  const email = (await prompts.text("Owner email: ")).trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error("Enter a valid owner email address.")
  }

  const newPassword = await prompts.secret("New password: ")
  const confirmation = await prompts.secret("Confirm new password: ")
  if (newPassword !== confirmation) {
    throw new Error("Passwords do not match.")
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    throw new Error("Password must be at least 8 characters.")
  }
  if (newPassword.length > MAX_PASSWORD_LENGTH) {
    throw new Error("Password must be at most 128 characters.")
  }

  return { email, newPassword }
}

async function createTerminalPrompts(
  input: ReadStream,
  output: WriteStream
): Promise<{ close(): void; prompts: RecoveryPrompts }> {
  const [{ createInterface }, { Writable }] = await Promise.all([
    import("node:readline/promises"),
    import("node:stream"),
  ])

  class ControlledOutput extends Writable {
    muted = false

    override _write(
      chunk: string | Uint8Array,
      encoding: BufferEncoding,
      callback: (error?: Error | null) => void
    ) {
      if (!this.muted) output.write(chunk, encoding)
      callback()
    }
  }

  const controlledOutput = new ControlledOutput()
  const readline = createInterface({
    input,
    output: controlledOutput,
    terminal: true,
  })

  return {
    close: () => readline.close(),
    prompts: {
      text: (label) => readline.question(label),
      async secret(label) {
        controlledOutput.muted = false
        const answer = readline.question(label)
        controlledOutput.muted = true
        try {
          return await answer
        } finally {
          controlledOutput.muted = false
          output.write("\n")
        }
      },
    },
  }
}

function targetDescription(options: ResetOptions) {
  if (options.selfHosted) return "the self-hosted local Convex deployment"
  if (options.prod) return "the project's production deployment"
  if (options.deployment !== undefined) {
    return `the Convex deployment selected by "${options.deployment}"`
  }
  return "this project's personal development deployment"
}

/**
 * Run the pinned Convex CLI in this process instead of spawning `convex run`.
 * The CLI still handles its normal authenticated deployment selection, but the
 * password never becomes an operating-system process argument, environment
 * variable, shell-history entry, or temporary file. CI mode also keeps this
 * sensitive invocation out of the CLI's Sentry telemetry path.
 */
async function invokeConvexReset(
  request: ResetRequest,
  options: ResetOptions
): Promise<never> {
  const [{ createRequire }, { dirname, join }, { pathToFileURL }] =
    await Promise.all([
      import("node:module"),
      import("node:path"),
      import("node:url"),
    ])
  const require = createRequire(import.meta.url)
  const convexPackageJson = require.resolve("convex/package.json")
  const convexRoot = dirname(convexPackageJson)
  const bundlePath = join(convexRoot, "dist", "cli.bundle.cjs")
  const convexBin = join(convexRoot, "bin", "main.js")

  const convexArgs = [
    "run",
    RESET_FUNCTION,
    JSON.stringify(request),
    ...convexTargetArgs(options),
    ...(options.envFile !== undefined ? ["--env-file", options.envFile] : []),
  ]

  // Assignment changes only Node's in-memory argv array. The operating system
  // continues to expose the original password-free pnpm command to `ps`.
  process.argv = [process.execPath, convexBin, ...convexArgs]
  process.env.CI = "1"
  process.env.VERCEL = "0"

  await import(/* @vite-ignore */ pathToFileURL(bundlePath).href)
  // The Convex CLI owns termination after the dynamic import starts.
  return await new Promise<never>(() => undefined)
}

export async function main(args = process.argv.slice(2)) {
  const options = parseResetOptions(args)
  if (options.help) {
    process.stdout.write(`${HELP}\n`)
    return
  }
  if (options.selfHosted && options.envFile !== undefined) {
    await assertSelfHostedEnvFile(options.envFile)
  }
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "Run this command in a trusted interactive terminal; piped input is disabled."
    )
  }

  process.stderr.write(`Target: ${targetDescription(options)}\n`)
  const terminal = await createTerminalPrompts(process.stdin, process.stderr)
  try {
    const request = await collectResetRequest(options, terminal.prompts)
    process.stderr.write(
      "Resetting the password and revoking existing sessions...\n"
    )
    await invokeConvexReset(request, options)
  } finally {
    terminal.close()
  }
}

const invokedPath = process.argv[1]?.replaceAll("\\", "/")
if (invokedPath?.endsWith("/scripts/reset-admin-password.ts")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`Password reset failed: ${message}\n`)
    process.exitCode = 1
  })
}

// The local setup step of `pnpm dev` (scripts/start-next-dev.ts). It fills the
// local secrets in .env.local, copies them to the development Convex backend
// over stdin and shows the owner setup code until the site has an owner.
// Secret, stdin and deployment-name logic copied from
// packages/create-formulacms-app/src/{env,convex,subprocess}.ts (that package
// does not ship with the starter). The placeholder and `env list` rules match
// scripts/check-starter-preflight.ts.
import { spawn } from "node:child_process"
import { randomBytes } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { parseEnv } from "node:util"

type Env = Record<string, string | undefined>

export const PAIRED_SECRET_KEYS = [
  "BETTER_AUTH_SECRET",
  "CONTACT_IP_PROOF_SECRET",
  "REVALIDATE_SECRET",
] as const
type LocalKey = (typeof PAIRED_SECRET_KEYS)[number] | "BETTER_AUTH_URL"

/** Any of these makes the Convex CLI pick a backend other than CONVEX_DEPLOYMENT. */
export const HOSTED_BACKEND_KEYS = [
  "CONVEX_DEPLOY_KEY",
  "CONVEX_DEPLOYMENT_TOKEN",
  "CONVEX_SELF_HOSTED_URL",
  "CONVEX_SELF_HOSTED_ADMIN_KEY",
] as const

const OWNER_CLAIM_KEY = "FORMULACMS_OWNER_CLAIM"
const LEGACY_OWNER_CLAIM_KEY = "NEXTCMS_OWNER_CLAIM"
const DEFAULT_ORIGIN = "http://localhost:3000"
const ALLOWED_KINDS = ["dev", "local", "anonymous"] as const
const RETRY =
  "[formulacms] Run pnpm dev again. If it keeps failing, run pnpm check:preflight."
const ENV_LINE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/

/**
 * A .env text as Node.js reads it (`util.parseEnv`, the dotenv rules that
 * Next.js and the Convex CLI also use): the last line for a key wins.
 * `env list --include-values` prints the same form
 * (convex/dist/cjs/cli/lib/formatEnvValueForDotfile.js), so it reads that too.
 */
export function parseEnvText(text: string): Map<string, string> {
  const values = new Map<string, string>()
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (value !== undefined) values.set(key, value)
  }
  return values
}

/**
 * A value as one .env.local line that dotenv (Next.js and the Convex CLI) and
 * parseEnvText read back unchanged, or null when there is no safe form.
 */
export function envLineValue(value: string): string | null {
  if (/^[A-Za-z0-9_./:+=@-]+$/.test(value)) return value
  if (/[\r\n]/.test(value)) return null
  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('"') && !value.includes("\\")) return `"${value}"`
  return null
}

/** False for a missing, empty or placeholder value (the preflight's isPlaceholder). */
export function isRealValue(value: string | undefined): value is string {
  if (value === undefined) return false
  const normalized = value.trim().toLowerCase()
  return !(
    !normalized ||
    normalized.includes("replace-with") ||
    normalized.includes("your-") ||
    normalized.includes("example.com") ||
    normalized.includes("your-deployment")
  )
}

export type DeploymentChoice =
  | {
      ok: true
      kind: (typeof ALLOWED_KINDS)[number]
      name: string
      /** The CLI's `--deployment` value. */
      selector: string
      /** `kind:name`, without the `# team: …` comment. */
      value: string
    }
  | { ok: false; kind: string | null; reason: string }

export function classifyDeployment(raw: string | undefined): DeploymentChoice {
  const value = raw?.split("#")[0].trim() ?? ""
  if (!value) return { ok: false, kind: null, reason: "missing" }
  // Team and project slugs in `local:local-<team>-<project>` may hold underscores.
  const match = /^([a-z]+):([a-z0-9_-]+)$/.exec(value)
  if (!match) return { ok: false, kind: "unknown", reason: "unparsable" }
  const [, kind, name] = match
  if (!(ALLOWED_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, kind, reason: "refused kind" }
  }
  return {
    ok: true,
    kind: kind as (typeof ALLOWED_KINDS)[number],
    name,
    // A signed-in local deployment is `local:local-<team>-<project>`, which the
    // CLI does not take as a name; its own `local` selector picks it.
    selector: kind === "local" ? "local" : name,
    value,
  }
}

type EnvFiles = {
  processEnv: Env
  envLocalText: string | null
  envText: string | null
}

function isSet(value: string | undefined): boolean {
  return Boolean(value?.trim())
}

/** Any non-empty CI value, even "false" or "0", turns the step off. */
function isCiSet(value: string | undefined): boolean {
  return value !== undefined && value !== ""
}

function describeKind(kind: string | null): string {
  if (kind === "prod") return "a production"
  if (kind === "preview") return "a preview"
  return "an unrecognized"
}

/**
 * The deployment Convex uses for this folder: `.env.local` first (on the first
 * start Convex has just written it, and the process does not have it yet),
 * then the process environment, then `.env`. Every value present must be a
 * development kind, so a stray `prod:` anywhere refuses the step.
 */
function resolveDeployment({ processEnv, envLocalText, envText }: EnvFiles) {
  const candidates = [
    parseEnvText(envLocalText ?? "").get("CONVEX_DEPLOYMENT"),
    processEnv.CONVEX_DEPLOYMENT,
    parseEnvText(envText ?? "").get("CONVEX_DEPLOYMENT"),
  ].filter(isSet)
  if (candidates.length === 0) return classifyDeployment(undefined)
  const choices = candidates.map(classifyDeployment)
  return choices.find((choice) => !choice.ok) ?? choices[0]
}

/** Null when the step may run; otherwise one plain line saying what to do. */
export function skipReason(files: EnvFiles): string | null {
  const { processEnv, envLocalText, envText } = files
  if (isCiSet(processEnv.CI)) {
    return "[formulacms] Automatic local setup is off because CI is set. Set the secrets and the owner setup code yourself, as in docs/starter/local-setup.md."
  }
  const envLocal = parseEnvText(envLocalText ?? "")
  const env = parseEnvText(envText ?? "")
  for (const key of HOSTED_BACKEND_KEYS) {
    if (isSet(processEnv[key]) || isSet(envLocal.get(key)) || isSet(env.get(key))) {
      return `[formulacms] Automatic local setup skipped: ${key} is set, so Convex could reach a hosted backend. Remove it from .env.local, .env and your shell, then run pnpm dev again.`
    }
  }
  const deployment = resolveDeployment(files)
  if (deployment.ok) return null
  if (deployment.kind === null) {
    return "[formulacms] Automatic local setup skipped: no Convex backend is set yet. Stop with Ctrl+C, run pnpm dev again and answer Convex's question."
  }
  return `[formulacms] Automatic local setup skipped: this folder uses ${describeKind(deployment.kind)} Convex backend, and the automatic setup only sets up development backends. For a hosted site, follow docs/starter/hosting.md.`
}

/** A local check only: is a secret or BETTER_AUTH_URL missing for Next.js? */
function localSetupIncomplete(processEnv: Env, envLocalText: string | null) {
  const file = parseEnvText(envLocalText ?? "")
  return [...PAIRED_SECRET_KEYS, "BETTER_AUTH_URL" as const].some(
    (key) => !isRealValue(processEnv[key]) && !isRealValue(file.get(key))
  )
}

export type LocalEnvPlan = {
  /** The new .env.local text, or null when the file stays as it is. */
  text: string | null
  /** Names written into the file (never values). */
  filled: LocalKey[]
  /** Names whose Convex value has no safe .env.local form; set by hand. */
  notCopied: LocalKey[]
  effective: Record<LocalKey, string>
}

export function planLocalEnv(options: {
  envLocalText: string | null
  templateText: string | null
  processEnv: Env
  convexValues: Map<string, string>
  generate: () => string
}): LocalEnvPlan {
  const { envLocalText, processEnv, convexValues, generate } = options
  // Never copy the template over an existing file.
  const base = envLocalText ?? options.templateText ?? ""
  const eol = base.includes("\r\n") ? "\r\n" : "\n"
  const lines = base ? base.split(/\r?\n/) : []
  const fileValues = parseEnvText(base)
  const filled: LocalKey[] = []
  const notCopied: LocalKey[] = []
  const effective = {} as Record<LocalKey, string>

  const writeLine = (key: LocalKey, value: string) => {
    effective[key] = value
    const encoded = envLineValue(value)
    if (encoded === null) {
      notCopied.push(key)
      return
    }
    const line = `${key}=${encoded}`
    let index = -1
    for (let i = lines.length - 1; i >= 0 && index === -1; i--) {
      if (ENV_LINE.exec(lines[i].trim())?.[1] === key) index = i
    }
    if (index !== -1) lines[index] = line
    else if (lines.length > 0 && lines[lines.length - 1] === "") {
      lines.splice(lines.length - 1, 0, line)
    } else lines.push(line, "")
    filled.push(key)
  }

  const keep = (key: LocalKey): boolean => {
    const fromProcess = processEnv[key]
    const fromFile = fileValues.get(key)
    if (isRealValue(fromProcess)) effective[key] = fromProcess.trim()
    else if (isRealValue(fromFile)) effective[key] = fromFile
    else return false
    return true
  }

  for (const key of PAIRED_SECRET_KEYS) {
    if (keep(key)) continue
    const fromConvex = convexValues.get(key)
    writeLine(key, isRealValue(fromConvex) ? fromConvex : generate())
  }
  if (!keep("BETTER_AUTH_URL")) writeLine("BETTER_AUTH_URL", DEFAULT_ORIGIN)

  const changed = filled.length > 0 || envLocalText === null
  return { text: changed ? lines.join(eol) : null, filled, notCopied, effective }
}

function isLocalOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1")
    )
  } catch {
    return false
  }
}

export type ConvexSyncPlan = {
  set: { key: string; value: string }[]
  /** Plain lines for the person; never values. */
  notes: string[]
}

export function planConvexSync(options: {
  effective: Record<LocalKey, string>
  convexValues: Map<string, string>
}): ConvexSyncPlan {
  const { effective, convexValues } = options
  const set: ConvexSyncPlan["set"] = []
  const notes: string[] = []
  for (const key of PAIRED_SECRET_KEYS) {
    if (convexValues.get(key) !== effective[key]) {
      set.push({ key, value: effective[key] })
    }
  }
  // BETTER_AUTH_URL is set only when Convex has none; an existing value is
  // never changed (pnpm check:preflight reports a mismatch).
  const url = effective.BETTER_AUTH_URL
  const inConvex = convexValues.get("BETTER_AUTH_URL")
  if (isRealValue(inConvex)) {
    if (inConvex !== url) {
      notes.push(
        "[formulacms] BETTER_AUTH_URL in the Convex backend differs from .env.local. The automatic setup leaves it as it is; run pnpm check:preflight for details."
      )
    }
  } else if (!isLocalOrigin(url)) {
    notes.push(
      "[formulacms] BETTER_AUTH_URL is not a localhost address, so the automatic setup did not copy it to Convex."
    )
  } else {
    set.push({ key: "BETTER_AUTH_URL", value: url })
  }
  return { set, notes }
}

export type OwnerCodeDecision =
  | { kind: "none" }
  | { kind: "unknown" }
  | { kind: "show-existing"; code: string }
  | { kind: "create" }

export function decideOwnerCode(options: {
  convexValues: Map<string, string>
  ownerEstablished: boolean | null
}): OwnerCodeDecision {
  const { convexValues, ownerEstablished } = options
  if (ownerEstablished === true) return { kind: "none" }
  if (ownerEstablished === null) return { kind: "unknown" }
  for (const key of [OWNER_CLAIM_KEY, LEGACY_OWNER_CLAIM_KEY]) {
    const code = convexValues.get(key)
    if (isRealValue(code)) return { kind: "show-existing", code }
  }
  return { kind: "create" }
}

export function ownerCodeBox(code: string, origin = DEFAULT_ORIGIN): string {
  const rule = "=".repeat(50)
  return [
    rule,
    "Owner setup code:",
    "",
    `    ${code}`,
    "",
    `Open ${origin}/setup and paste this code`,
    "when the setup asks for it. Until you finish setup,",
    "every pnpm dev shows it again.",
    rule,
  ]
    .map((line) => (line ? `[formulacms] ${line}` : "[formulacms]"))
    .join("\n")
}

/** Replaces every value of 8 characters or more with "[hidden]". */
export function redact(text: string, values: Iterable<string>): string {
  const secrets = [...new Set(values)]
    .filter((value) => value.length >= 8)
    .sort((a, b) => b.length - a.length)
  return secrets.reduce((result, value) => result.split(value).join("[hidden]"), text)
}

export type ConvexRunResult = {
  code: number | null
  stdout: string
  stderr: string
}

export type ConvexRunner = (
  args: string[],
  options: { stdin: string; convexDeployment: string }
) => Promise<ConvexRunResult>

const RUN_TIMEOUT_MS = 60_000

/**
 * Runs the installed Convex CLI with Node itself: no shell, so the same code
 * works on Windows. A value only ever travels on stdin.
 */
export function createConvexRunner(
  projectRoot: string,
  baseEnv: NodeJS.ProcessEnv = process.env
): ConvexRunner {
  const packageRoot = join(projectRoot, "node_modules", "convex")
  const { bin } = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8")
  ) as { bin: string | Record<string, string> }
  const entry = join(packageRoot, typeof bin === "string" ? bin : bin.convex)

  return (args, { stdin, convexDeployment }) =>
    new Promise((resolve) => {
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        CONVEX_DEPLOYMENT: convexDeployment,
      }
      for (const key of HOSTED_BACKEND_KEYS) delete env[key]
      const child = spawn(process.execPath, [entry, ...args], {
        cwd: projectRoot,
        env,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: RUN_TIMEOUT_MS,
      })
      let stdout = ""
      let stderr = ""
      child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk))
      child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk))
      child.stdin.on("error", () => {})
      child.once("error", (error) =>
        resolve({ code: null, stdout, stderr: stderr || error.message })
      )
      child.once("close", (code) => resolve({ code, stdout, stderr }))
      child.stdin.end(stdin)
    })
}

function childError(result: ConvexRunResult): string {
  const lines = result.stderr
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  if (lines.length > 0) return lines.slice(-5).join(" ")
  return result.code === null
    ? `the Convex command did not finish within ${RUN_TIMEOUT_MS / 1000} seconds`
    : `the Convex command ended with exit code ${result.code}`
}

function parseOwnerEstablished(result: ConvexRunResult): boolean | null {
  if (result.code !== 0) return null
  try {
    const parsed = JSON.parse(result.stdout.trim()) as { established?: unknown }
    return typeof parsed?.established === "boolean" ? parsed.established : null
  } catch {
    return null
  }
}

function originOf(value: string): string {
  try {
    return new URL(value).origin
  } catch {
    return DEFAULT_ORIGIN
  }
}

export type LocalSetupResult = {
  status: "skipped" | "ready" | "failed"
  /** Lines to print now. They never hold a secret. */
  lines: string[]
  /** The owner setup code box, to print last; null when there is none to show. */
  box: string | null
  wroteKeys: string[]
}

export type LocalSetupOptions = {
  projectRoot: string
  /** Pass `process.env` itself: filled keys are written back into it. */
  processEnv: Env
  runner?: ConvexRunner
  generate?: () => string
  readFile?: (path: string) => string | null
  writeFile?: (path: string, text: string) => void
}

function readTextFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    throw error
  }
}

/** What lib/env.ts validateNextRuntimeEnv requires before Next.js starts. */
export const NEXT_START_KEYS = [
  "BETTER_AUTH_SECRET",
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
] as const

/**
 * Whether Next.js has what lib/env.ts requires, from the process environment,
 * .env.local and .env as they are now. A failed setup step stops `pnpm dev`
 * only when this is false; otherwise Next.js starts with a warning.
 */
function canStartNext(
  processEnv: Env,
  readFile: (path: string) => string | null,
  projectRoot: string
): boolean {
  const read = (name: string) => {
    try {
      return parseEnvText(readFile(join(projectRoot, name)) ?? "")
    } catch {
      return new Map<string, string>()
    }
  }
  const files = [read(".env.local"), read(".env")]
  return NEXT_START_KEYS.every(
    (key) =>
      isRealValue(processEnv[key]) ||
      files.some((file) => isRealValue(file.get(key)))
  )
}

export async function runLocalSetup(
  options: LocalSetupOptions
): Promise<LocalSetupResult> {
  const known: string[] = []
  const wroteKeys: string[] = []
  const readFile = options.readFile ?? readTextFile
  try {
    return await setUp({ ...options, readFile }, known, wroteKeys)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const ready = canStartNext(options.processEnv, readFile, options.projectRoot)
    return {
      status: ready ? "ready" : "failed",
      lines: [
        `[formulacms] Automatic local setup failed: ${redact(message, known)}`,
        RETRY,
      ],
      box: null,
      wroteKeys,
    }
  }
}

async function setUp(
  options: LocalSetupOptions,
  known: string[],
  wroteKeys: string[]
): Promise<LocalSetupResult> {
  const { projectRoot, processEnv } = options
  const readFile = options.readFile ?? readTextFile
  const writeFile =
    options.writeFile ?? ((path, text) => writeFileSync(path, text))
  const generate = options.generate ?? (() => randomBytes(32).toString("hex"))
  const envLocalPath = join(projectRoot, ".env.local")
  const envLocalText = readFile(envLocalPath)
  const envText = readFile(join(projectRoot, ".env"))
  const files = { processEnv, envLocalText, envText }
  const done = (
    status: LocalSetupResult["status"],
    lines: string[],
    box: string | null = null
  ): LocalSetupResult => ({ status, lines, box, wroteKeys })
  // A step failed: Next.js still starts when it can, with no code box.
  const warn = (lines: string[]) =>
    done(canStartNext(processEnv, readFile, projectRoot) ? "ready" : "failed", [
      ...lines,
      RETRY,
    ])

  const skip = skipReason(files)
  if (skip !== null) {
    return done("skipped", localSetupIncomplete(processEnv, envLocalText) ? [skip] : [])
  }
  const deployment = resolveDeployment(files)
  if (!deployment.ok) return done("skipped", [])

  const localValues = parseEnvText(envLocalText ?? "")
  // Next's loadEnvConfig never overrides a variable that is already set, so a
  // placeholder in the process (from the shell, or loaded by `convex dev`
  // before it wrote .env.local) would hide the real value in the file. Done
  // before the first Convex call, so every later exit keeps it.
  for (const key of NEXT_START_KEYS) {
    const fromFile = localValues.get(key)
    if (!isRealValue(processEnv[key]) && isRealValue(fromFile)) processEnv[key] = fromFile
  }
  for (const key of PAIRED_SECRET_KEYS) {
    for (const value of [processEnv[key], localValues.get(key)]) {
      if (isRealValue(value)) known.push(value.trim())
    }
  }
  const runner = options.runner ?? createConvexRunner(projectRoot)
  const convex = (args: string[], stdin = "") =>
    runner([...args, "--deployment", deployment.selector], {
      stdin,
      convexDeployment: deployment.value,
    })

  // The values stay in memory; this output is never printed.
  const list = await convex(["env", "list", "--include-values"])
  const convexValues = parseEnvText(list.stdout)
  known.push(...convexValues.values())
  if (list.code !== 0) {
    return warn([
      `[formulacms] Automatic local setup could not read the Convex backend's settings, so it changed nothing: ${redact(childError(list), known)}`,
    ])
  }

  const plan = planLocalEnv({
    envLocalText,
    templateText:
      envLocalText === null
        ? readFile(join(projectRoot, ".env.local.example"))
        : null,
    processEnv,
    convexValues,
    generate,
  })
  known.push(...Object.values(plan.effective))
  if (plan.text !== null) writeFile(envLocalPath, plan.text)
  wroteKeys.push(...plan.filled)
  // `convex dev` loaded .env.local before this step fixed it, and Next's
  // loadEnvConfig never overrides a variable that is already set.
  for (const key of [...PAIRED_SECRET_KEYS, "BETTER_AUTH_URL" as const]) {
    if (!isRealValue(processEnv[key])) processEnv[key] = plan.effective[key]
  }

  const lines: string[] = []
  if (plan.filled.length > 0) {
    lines.push(`[formulacms] Local setup: added ${plan.filled.join(", ")} to .env.local.`)
  }
  for (const key of plan.notCopied) {
    lines.push(
      `[formulacms] Automatic local setup could not copy ${key} from the Convex backend into .env.local, because of the characters it holds. Add it to .env.local by hand, with the same value as in Convex.`
    )
  }
  const setInConvex: string[] = []
  const setValue = async (key: string, value: string) => {
    known.push(value)
    const result = await convex(["env", "set", key], value)
    if (result.code === 0) {
      setInConvex.push(key)
      return null
    }
    return warn([
      ...lines,
      `[formulacms] Automatic local setup could not set ${key} in the Convex backend: ${redact(childError(result), known)}`,
    ])
  }

  const sync = planConvexSync({ effective: plan.effective, convexValues })
  for (const { key, value } of sync.set) {
    const failure = await setValue(key, value)
    if (failure) return failure
  }

  const owner = decideOwnerCode({
    convexValues,
    ownerEstablished: parseOwnerEstablished(
      await convex(["run", "cms/owner:getOwnerEstablished"])
    ),
  })
  let code: string | null = null
  if (owner.kind === "show-existing") code = owner.code
  if (owner.kind === "create") {
    code = generate()
    const failure = await setValue(OWNER_CLAIM_KEY, code)
    if (failure) return failure
  }

  if (setInConvex.length > 0) {
    lines.push(`[formulacms] Local setup: set ${setInConvex.join(", ")} in the Convex backend.`)
  }
  lines.push(...sync.notes)
  if (owner.kind === "unknown") {
    lines.push(
      "[formulacms] Could not check whether the site has an owner, so no owner setup code is shown. Run pnpm dev again."
    )
  }
  const origin = originOf(plan.effective.BETTER_AUTH_URL)
  return done("ready", lines, code === null ? null : ownerCodeBox(code, origin))
}

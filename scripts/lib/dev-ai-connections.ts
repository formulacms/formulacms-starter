import { execFile } from "node:child_process"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  AiConnectionCheck,
  AiConnectionStatus,
  LocalToolConnectionCheck,
  LocalToolSignInMethod,
} from "@/lib/ai/connection-validation"
import { validateApiConnection } from "@/lib/ai/connection-validation"
import type { ApiProvider } from "@/lib/ai/execution-contract"
import { localApiKeysFrom, type LocalApiKeys } from "@/lib/local-api-keys"
import { readLocalApiKeys } from "@/lib/local-api-keys-file"
import type { DevAiChoice } from "./dev-ai-selection"
import {
  claudeOnPath,
  claudePlanState,
  readClaudeCodeHandshake,
  type ClaudeDiscoveryQuery,
} from "./claude-cli-discovery"
import {
  assertNativeLaunchAllowed,
  NativeLaunchBlockedError,
} from "./native-launch-guard"
import {
  localToolEnvironment,
  type ToolEnvironment,
} from "./subscription-cli-process"

// Sign-in status of the local tools (ADR-0057 step 1). The status is checked
// on Settings › AI on localhost only, with `claude auth status` and
// `codex login status`, in the same environment as a tool run
// (`localToolEnvironment`), so the reported method matches what a run bills.
// Every sign-in method stays available; none is rejected. Only the method is
// kept: "plan" (the owner's plan), "api-key", or "unknown" (not verified).
// Vendor output is read here transiently and never returned.

// A key in the tool's environment is used before the plan sign-in.
// Claude Code: ANTHROPIC_AUTH_TOKEN and ANTHROPIC_API_KEY rank above every
// sign-in, and in `-p` mode "the key is always used when present"
// (https://code.claude.com/docs/en/authentication, "Authentication precedence").
// Codex: `codex exec` uses CODEX_API_KEY when it is set
// (https://developers.openai.com/codex/noninteractive, "Use API key auth").
const CLAUDE_KEY_NAMES = ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"] as const
const CODEX_KEY_NAMES = ["CODEX_API_KEY"] as const
// The Codex docs do not say whether `codex exec` uses OPENAI_API_KEY over a
// ChatGPT sign-in, so a plan sign-in with that key present is "unknown"
// (seat decision, 2026-11-15).
const CODEX_UNCLEAR_KEY_NAMES = ["OPENAI_API_KEY"] as const

// `claude auth status` JSON `authMethod` values
// (https://code.claude.com/docs/en/cli-reference, `claude auth status`).
const CLAUDE_AUTH_METHODS: Readonly<Record<string, LocalToolSignInMethod>> = {
  "claude.ai": "plan",
  oauth_token: "plan",
  api_key: "api-key",
  api_key_helper: "api-key",
}

const API_CONNECTIONS = new Set<DevAiChoice>([
  "openrouter",
  "anthropic",
  "openai",
])

export type DevAiConnectionStatuses = Record<DevAiChoice, AiConnectionStatus>

export type CommandResult = {
  exitCode: number | null
  stdout: string
  stderr?: string
  errorCode?: string
  timedOut?: boolean
}

export type RunStatusCommand = (
  command: string,
  args: readonly string[],
  env: ToolEnvironment,
  options?: { readonly cwd?: string; readonly signal?: AbortSignal }
) => Promise<CommandResult>

export interface DevAiConnectionOptions {
  /**
   * formulacms's environment (tool paths); defaults to `process.env`. When
   * given, it is also the only source of the API keys; when omitted, the keys
   * come from .env.local at each call (`readLocalApiKeys`).
   */
  env?: Partial<NodeJS.ProcessEnv>
  /** The tool's environment; defaults to `localToolEnvironment({ env })`. */
  toolEnv?: ToolEnvironment
  runCommand?: RunStatusCommand
}

function localToolContext(options: DevAiConnectionOptions) {
  const env = options.env ?? process.env
  return {
    env,
    // Same sanitized environment and native-installer PATH fallback as an
    // actual run; keep explicit test/caller environments unchanged.
    toolEnv: options.toolEnv ?? localToolEnvironment({ env }),
    runCommand: options.runCommand ?? runStatusCommand,
  }
}

function apiKeysFor(options: DevAiConnectionOptions): LocalApiKeys {
  return options.env ? localApiKeysFrom(options.env) : readLocalApiKeys()
}

/** Cheap, non-generative readiness snapshot for one effective local route. */
export async function inspectDevAiConnection(
  choice: DevAiChoice,
  options: DevAiConnectionOptions = {}
): Promise<AiConnectionStatus> {
  if (choice === "off") return { state: "off" }
  if (choice !== "claude" && choice !== "codex") {
    return configuredApiStatus(choice, apiKeysFor(options))
  }
  const context = localToolContext(options)
  return choice === "claude"
    ? inspectClaudeCode(context)
    : inspectCodex(context)
}

/**
 * Cheap local snapshot used while rendering Settings. API connections are only
 * reported as configured until the owner explicitly tests them; the local
 * tools' status commands are local and non-generative.
 */
export async function inspectDevAiConnections(
  options: DevAiConnectionOptions = {}
): Promise<DevAiConnectionStatuses> {
  const { env, toolEnv, runCommand } = localToolContext(options)
  const keys = apiKeysFor(options)
  const [claude, codex] = await Promise.all([
    inspectDevAiConnection("claude", { env, toolEnv, runCommand }),
    inspectDevAiConnection("codex", { env, toolEnv, runCommand }),
  ])

  return {
    off: { state: "off" },
    openrouter: configuredApiStatus("openrouter", keys),
    anthropic: configuredApiStatus("anthropic", keys),
    openai: configuredApiStatus("openai", keys),
    claude,
    codex,
  }
}

/** What Settings › AI shows for one local tool: its sign-in method only. */
export type LocalToolStatus =
  | LocalToolSignInMethod
  | "signed-out"
  | "not-installed"

// `claude auth status` JSON `authMethod` values
// (https://code.claude.com/docs/en/cli-reference, 2026-11-15).
const CLAUDE_RAW_AUTH_METHODS: readonly string[] = [
  "none",
  "claude.ai",
  "oauth_token",
  "api_key",
  "api_key_helper",
  "third_party",
]

/**
 * Claude Code's sign-in as `claude auth status` reports it, without identity:
 * `loggedIn` and the exact `authMethod` (another value is "other"), and
 * whether a key in the tool's environment takes precedence (`envKey`; then
 * the JSON is not read). The plan rule compares these raw values: the
 * displayed status maps `claude.ai` and `oauth_token` both to "plan". No
 * email, organization or `configDirectory` is kept.
 */
export interface ClaudeSignIn {
  readonly status: LocalToolStatus
  readonly loggedIn: boolean | null
  readonly authMethod: string | null
  readonly envKey: boolean
}

/**
 * Both local tools' status for Settings › AI, checked in parallel. Callers run
 * it only for a request from this computer (`isLocalToolRequest`). A check
 * that times out or fails says nothing about the sign-in: "unknown".
 */
export async function inspectLocalTools(
  options: DevAiConnectionOptions = {}
): Promise<Record<"claude" | "codex", LocalToolStatus> & { claudeSignIn: ClaudeSignIn }> {
  const context = localToolContext(options)
  const [claude, codex] = await Promise.all([
    inspectClaudeSignIn(context),
    inspectCodex(context),
  ])
  return {
    claude: claude.status,
    codex: localToolStatus(codex),
    claudeSignIn: claude,
  }
}

function localToolStatus(check: LocalToolConnectionCheck): LocalToolStatus {
  if (check.state === "authenticated") return check.method
  if (check.issue === "missing-cli") return "not-installed"
  if (check.issue === "signed-out") return "signed-out"
  return "unknown"
}

/** Perform the strongest non-generative check available for one local choice. */
export async function validateDevAiConnection(
  choice: DevAiChoice,
  options: DevAiConnectionOptions & { fetch?: typeof fetch } = {}
): Promise<AiConnectionStatus> {
  if (choice === "off") return { state: "off" }
  if (choice === "claude" || choice === "codex") {
    return inspectDevAiConnection(choice, options)
  }
  if (!API_CONNECTIONS.has(choice)) {
    return { state: "unreachable", issue: "command-failed" }
  }
  const provider = choice as ApiProvider
  return validateApiConnection(
    provider,
    apiKeysFor(options)[provider],
    options.fetch ? { fetch: options.fetch } : {}
  )
}

function configuredApiStatus(
  provider: ApiProvider,
  keys: LocalApiKeys
): AiConnectionStatus {
  return keys[provider]
    ? { state: "configured", method: "api-key" }
    : { state: "not-configured", issue: "missing-key" }
}

type LocalToolContext = ReturnType<typeof localToolContext>
type ConnectionProblem = Exclude<AiConnectionCheck, { state: "authenticated" }>

function hasKey(env: ToolEnvironment, names: readonly string[]): boolean {
  return names.some((name) => Boolean(env[name]?.trim()))
}

const signedInWith = (
  method: LocalToolSignInMethod
): LocalToolConnectionCheck => ({
  state: "authenticated",
  method,
})

/** Missing tool or timeout: nothing about the sign-in is known. */
function unavailableTool(result: CommandResult): ConnectionProblem | null {
  if (result.errorCode === "ENOENT") {
    return { state: "not-configured", issue: "missing-cli" }
  }
  return result.timedOut ? { state: "unreachable", issue: "timeout" } : null
}

async function inspectClaudeCode(
  context: LocalToolContext
): Promise<LocalToolConnectionCheck> {
  return (await inspectClaudeCheck(context)).check
}

async function inspectClaudeSignIn(context: LocalToolContext): Promise<ClaudeSignIn> {
  const { check, loggedIn = null, authMethod = null, envKey = false } =
    await inspectClaudeCheck(context)
  return { status: localToolStatus(check), loggedIn, authMethod, envKey }
}

async function inspectClaudeCheck({
  toolEnv,
  runCommand,
}: LocalToolContext): Promise<{
  check: LocalToolConnectionCheck
  loggedIn?: boolean | null
  authMethod?: string | null
  envKey?: boolean
}> {
  const result = await runCommand("claude", ["auth", "status"], toolEnv)
  const unavailable = unavailableTool(result)
  if (unavailable) return { check: unavailable }
  if (hasKey(toolEnv, CLAUDE_KEY_NAMES))
    return { check: signedInWith("api-key"), envKey: true }
  const processIssue = statusProcessIssue(result)
  if (processIssue && result.stdout.trim() === "") return { check: processIssue }

  try {
    const status = JSON.parse(result.stdout) as {
      loggedIn?: unknown
      authMethod?: unknown
    }
    const raw = {
      loggedIn: typeof status.loggedIn === "boolean" ? status.loggedIn : null,
      authMethod:
        typeof status.authMethod !== "string"
          ? null
          : CLAUDE_RAW_AUTH_METHODS.includes(status.authMethod)
            ? status.authMethod
            : "other",
    }
    if (status.loggedIn !== true) {
      return { check: { state: "not-configured", issue: "signed-out" }, ...raw }
    }
    const method =
      typeof status.authMethod === "string" &&
      Object.hasOwn(CLAUDE_AUTH_METHODS, status.authMethod)
        ? CLAUDE_AUTH_METHODS[status.authMethod]
        : "unknown"
    return { check: signedInWith(method), ...raw }
  } catch {
    return { check: processIssue ?? { state: "unreachable", issue: "command-failed" } }
  }
}

async function inspectCodex({
  env,
  toolEnv,
  runCommand,
}: LocalToolContext): Promise<LocalToolConnectionCheck> {
  const command =
    env.FORMULACMS_CODEX_BIN?.trim() || env.NEXTCMS_CODEX_BIN?.trim() || "codex"
  const result = await runCommand(command, ["login", "status"], toolEnv)
  const unavailable = unavailableTool(result)
  if (unavailable) return unavailable
  if (hasKey(toolEnv, CODEX_KEY_NAMES)) return signedInWith("api-key")
  const processIssue = statusProcessIssue(result)
  // Codex versions have emitted the status line on both stdout and stderr.
  // Inspect both transiently, but never return either vendor-controlled body.
  const diagnostic = `${result.stdout} ${result.stderr ?? ""}`.toLowerCase()
  if (
    diagnostic.includes("not logged in") ||
    diagnostic.includes("logged out")
  ) {
    return { state: "not-configured", issue: "signed-out" }
  }
  if (diagnostic.includes("logged in using chatgpt")) {
    return signedInWith(
      hasKey(toolEnv, CODEX_UNCLEAR_KEY_NAMES) ? "unknown" : "plan"
    )
  }
  if (
    diagnostic.includes("logged in using") &&
    diagnostic.includes("api key")
  ) {
    return signedInWith("api-key")
  }
  if (diagnostic.includes("logged in")) return signedInWith("unknown")
  return processIssue ?? { state: "unreachable", issue: "command-failed" }
}

function statusProcessIssue(result: CommandResult): ConnectionProblem | null {
  const unavailable = unavailableTool(result)
  if (unavailable) return unavailable
  if (result.exitCode !== 0) {
    return { state: "unreachable", issue: "command-failed" }
  }
  return null
}

function runStatusCommand(
  command: string,
  args: readonly string[],
  env: ToolEnvironment,
  options: { readonly cwd?: string; readonly signal?: AbortSignal } = {}
): Promise<CommandResult> {
  assertNativeLaunchAllowed(command)
  return new Promise((resolve) => {
    execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        env: env as NodeJS.ProcessEnv,
        maxBuffer: 64 * 1024,
        timeout: 3_000,
        windowsHide: true,
        ...(options.cwd ? { cwd: options.cwd } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        const failure = error as
          | (Error & {
              code?: string | number
              killed?: boolean
            })
          | null
        resolve({
          exitCode:
            typeof failure?.code === "number" ? failure.code : error ? null : 0,
          stdout: typeof stdout === "string" ? stdout : String(stdout ?? ""),
          stderr: typeof stderr === "string" ? stderr : String(stderr ?? ""),
          ...(typeof failure?.code === "string"
            ? { errorCode: failure.code }
            : {}),
          ...(failure?.killed ? { timedOut: true } : {}),
        })
      }
    )
  })
}

// ─── Fable's run-time check (ADR-0057, amendment 2026-11-15) ────────────────
//
// A Fable run (`claude-fable-*` or a saved `fable`) calls this just before
// staging, every time. It is a fresh vendor observation under the run's
// setting sources, not a guaranteed billing identity: what the installed
// Claude Code reports now, with the run's executable and environment. The
// run passes `--setting-sources ""`, so no user, project or local settings
// file applies to it (managed policy, the keychain and `CLAUDE_CONFIG_DIR`
// still do). `claude auth status` loads those files, so it may only refuse.
// Every allow comes from the one handshake, which loads no settings file
// either. The cached plan Settings › AI shows is never read here. formulacms
// reads no credential file and calls no undocumented endpoint. Claude Code
// may itself report cached account data (anthropics/claude-code#43639,
// #88353).

// Authentication precedence
// (https://code.claude.com/docs/en/authentication#authentication-precedence):
// a cloud provider outranks every key and sign-in.
const CLAUDE_CLOUD_PROVIDER_FLAGS = [
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY",
] as const

/** What one `claude auth status` says. It loads settings files the run
 * does not, so it only refuses: a failed, unparsable, signed-out, `none`,
 * third-party, unknown or contradictory status. Anything else goes to the
 * handshake, which decides. */
function claudeStatusRefuses(result: CommandResult, env: ToolEnvironment): boolean {
  if (result.exitCode !== 0 || result.timedOut || result.errorCode) return true
  let status: unknown
  try {
    status = JSON.parse(result.stdout)
  } catch {
    return true
  }
  if (typeof status !== "object" || status === null) return true
  const { loggedIn, authMethod } = status as Record<string, unknown>
  if (loggedIn !== true || hasKey(env, CLAUDE_CLOUD_PROVIDER_FLAGS)) return true
  const apiKey = authMethod === "api_key" || authMethod === "api_key_helper"
  const signIn = authMethod === "claude.ai" || authMethod === "oauth_token"
  // Under `-p` a key in the environment always wins over a sign-in: a status
  // that reports a sign-in anyway contradicts it.
  return !(apiKey || (signIn && !hasKey(env, CLAUDE_KEY_NAMES)))
}

/**
 * The handshake's account (Agent SDK `AccountInfo`, source names only), by
 * documented precedence (https://code.claude.com/docs/en/authentication,
 * "Authentication precedence": the bearer token, then the key, then
 * `apiKeyHelper`, all above a subscription login):
 * - `tokenSource` "ANTHROPIC_AUTH_TOKEN" (the bearer token; the value the
 *   installed Claude Code 2.1.325 reports, read from its code, ADR-0057),
 *   or `apiKeySource` "ANTHROPIC_API_KEY" or "apiKeyHelper": API rates.
 * - `apiKeySource` "/login managed key" (a stored Console key) has no
 *   documented rank against a subscription login: it counts only with
 *   `tokenSource` exactly "none" and no plan reported.
 * - Otherwise only a Max or Ultra plan.
 */
export function claudeAccountAllowsFable(account: {
  readonly subscriptionType?: unknown
  readonly apiKeySource?: unknown
  readonly tokenSource?: unknown
}): boolean {
  const { subscriptionType, apiKeySource, tokenSource } = account
  if (tokenSource === "ANTHROPIC_AUTH_TOKEN") return true
  if (apiKeySource === "ANTHROPIC_API_KEY" || apiKeySource === "apiKeyHelper") return true
  const noPlan = subscriptionType === undefined || subscriptionType === null || subscriptionType === ""
  if (apiKeySource === "/login managed key" && tokenSource === "none" && noPlan) return true
  return claudePlanState(subscriptionType) === "eligible"
}

export interface ClaudeFablePlanCheckOptions {
  /** The run's tool environment; defaults to `localToolEnvironment()`. */
  readonly toolEnv?: ToolEnvironment
  /** A fake `claude auth status`; the default runs the real one. */
  readonly runCommand?: RunStatusCommand
  /** A fake SDK `query`; the default loads the SDK. */
  readonly query?: ClaudeDiscoveryQuery
  /** The `claude` to check; defaults to the one a run starts. */
  readonly executable?: string
  readonly signal?: AbortSignal
  readonly deadlineMs?: number
}

/**
 * May this Fable run start? True only when a fresh handshake (no settings
 * file, like the run) reports an account `claudeAccountAllowsFable` allows;
 * the status before it can only refuse. Any failure, timeout, cancellation
 * or unknown answer is false. It starts `claude auth status` and one SDK
 * handshake (no prompt), both closed on every exit; it never stages run
 * input. A test that reaches a real tool
 * gets `NativeLaunchBlockedError`, never a quiet refusal.
 */
export async function checkClaudeFablePlan(
  options: ClaudeFablePlanCheckOptions = {}
): Promise<boolean> {
  if (!options.runCommand || !options.query) assertNativeLaunchAllowed("claude")
  const { signal } = options
  if (signal?.aborted) return false
  const toolEnv = options.toolEnv ?? localToolEnvironment()
  const cwd = await mkdtemp(join(tmpdir(), "formulacms-claude-check-"))
  try {
    const executable = options.executable ?? claudeOnPath(toolEnv)
    const status = await (options.runCommand ?? runStatusCommand)(
      executable,
      ["auth", "status"],
      toolEnv,
      { cwd, ...(signal ? { signal } : {}) }
    )
    if (signal?.aborted) return false
    if (claudeStatusRefuses(status, toolEnv)) return false
    const account = await readClaudeCodeHandshake({
      ...(options.query ? { query: options.query } : {}),
      env: toolEnv,
      executable,
      cwd,
      // No settings file, like the run (`--setting-sources ""`).
      settingSources: [],
      ...(signal ? { signal } : {}),
      ...(options.deadlineMs ? { deadlineMs: options.deadlineMs } : {}),
    })
    return !signal?.aborted && claudeAccountAllowsFable(account)
  } catch (error) {
    if (error instanceof NativeLaunchBlockedError) throw error
    return false
  } finally {
    await rm(cwd, { recursive: true, force: true })
  }
}

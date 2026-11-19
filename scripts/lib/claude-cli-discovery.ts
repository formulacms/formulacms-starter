// What the installed Claude Code offers (AI-MODELS-1c step 3), read on
// Settings › AI on the owner's computer only. Claude Code has no list command;
// the Agent SDK's initialize handshake returns the model rows and the
// account's plan (https://code.claude.com/docs/en/agent-sdk/typescript,
// `Query.initializationResult`). The input stays open and yields no message,
// so no prompt is ever sent: no model runs and no usage is spent. The session
// runs the same `claude` and environment as a run, loads no tool, no MCP
// server and no hook (managed hooks excepted: `disableAllHooks` outside
// managed settings cannot turn them off), saves no session, and is closed on
// every exit: success, failure, deadline or cancellation. It loads no
// settings file, like a run (`--setting-sources ""`); this holds for the menu
// read and for Fable's run-time check (`checkClaudeFablePlan` in
// `dev-ai-connections.ts`). Only the model rows, `account.subscriptionType`,
// `account.apiKeySource` and `account.tokenSource` (source names, never a
// key) leave this module; never the email or the organization.

import { accessSync, constants, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { assertNativeLaunchAllowed } from "./native-launch-guard"
import {
  localToolEnvironment,
  type ToolEnvironment,
} from "./subscription-cli-process"

const DISCOVERY_DEADLINE_MS = 10_000

export interface ClaudeCodeHandshake {
  /** The SDK's `ModelInfo` rows, unchecked. */
  readonly models: readonly unknown[]
  /** `account.subscriptionType`, unchecked (e.g. "Claude Ultra", or null). */
  readonly subscriptionType: unknown
  /** `account.apiKeySource`, unchecked: where the session's API key comes
   * from ("ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"), or
   * "none" (Agent SDK reference, `ApiKeySource`). */
  readonly apiKeySource?: unknown
  /** `account.tokenSource`, unchecked: the auth token's source name (e.g.
   * "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN", "none"); absent for a
   * subscription login. */
  readonly tokenSource?: unknown
}

/** The part of the SDK's `query()` the handshake uses. */
export type ClaudeDiscoveryQuery = (params: {
  prompt: AsyncIterable<never>
  options: Options
}) => {
  initializationResult(): Promise<{
    readonly models?: unknown
    readonly account?: unknown
  }>
  close(): void
}

/** Unknown (no plan said) is kept apart from insufficient (another plan), so
 * a later wording can tell them apart; both show "Needs Max or Ultra". */
export type ClaudePlanState = "eligible" | "insufficient" | "unknown"

/** `account.subscriptionType`: "Claude Max", "Claude Ultra", "max", "ULTRA"
 * are eligible; "Claude Pro", "Claude Team" are not; null or missing is
 * unknown (anthropics/claude-code#105649: null on a Max account). */
export function claudePlanState(subscriptionType: unknown): ClaudePlanState {
  if (typeof subscriptionType !== "string") return "unknown"
  const plan = subscriptionType.trim().toLowerCase().replace(/^claude\s+/u, "")
  if (plan === "") return "unknown"
  return plan === "max" || plan === "ultra" ? "eligible" : "insufficient"
}

/** The Claude plans Settings › AI names; any other value is not named. */
export const CLAUDE_PLAN_NAMES = ["pro", "max", "ultra", "team", "enterprise"] as const
export type ClaudePlanName = (typeof CLAUDE_PLAN_NAMES)[number]

/** The plan's name for display, read like `claudePlanState`; never the raw
 * string: anything outside `CLAUDE_PLAN_NAMES` is undefined. */
export function claudePlanName(subscriptionType: unknown): ClaudePlanName | undefined {
  if (typeof subscriptionType !== "string") return undefined
  const plan = subscriptionType.trim().toLowerCase().replace(/^claude\s+/u, "")
  return (CLAUDE_PLAN_NAMES as readonly string[]).includes(plan) ? (plan as ClaudePlanName) : undefined
}

export interface ClaudeDiscoveryDeps {
  /** A fake SDK `query`; the default loads the SDK. */
  readonly query?: ClaudeDiscoveryQuery
  /** The tool's environment; defaults to `localToolEnvironment()`. */
  readonly env?: ToolEnvironment
  /** The `claude` to run; defaults to the one a run starts (on the PATH). */
  readonly executable?: string
  readonly deadlineMs?: number
  /** The caller's cancellation: aborts and closes the session. */
  readonly signal?: AbortSignal
  /** The settings files to load; defaults to none (`[]`). */
  readonly settingSources?: Options["settingSources"]
  /** The session's working directory; defaults to the SDK's. */
  readonly cwd?: string
}

/** The `claude` a run starts: the first on the tool environment's PATH. */
export function claudeOnPath(env: ToolEnvironment): string {
  const names = process.platform === "win32" ? ["claude.exe", "claude"] : ["claude"]
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const path = join(dir, name)
      try {
        if (!statSync(path).isFile()) continue
        accessSync(path, constants.X_OK)
        return path
      } catch {
        // Not here.
      }
    }
  }
  throw new Error("Claude Code is not installed on this computer.")
}

async function loadSdkQuery(): Promise<ClaudeDiscoveryQuery> {
  const { query } = await import("@anthropic-ai/claude-agent-sdk")
  return query
}

/** One handshake with the installed Claude Code; rejects after 10 seconds
 * or when the caller cancels. */
export async function readClaudeCodeHandshake(
  deps: ClaudeDiscoveryDeps = {}
): Promise<ClaudeCodeHandshake> {
  // Tests never start the real tool: this refuses before any lookup or import.
  if (!deps.query) assertNativeLaunchAllowed("claude")
  const env = deps.env ?? localToolEnvironment()
  const executable = deps.executable ?? claudeOnPath(env)
  const query = deps.query ?? (await loadSdkQuery())
  const { signal } = deps
  if (signal?.aborted) throw new Error("The Claude Code check was cancelled.")

  const abortController = new AbortController()
  let release!: () => void
  const held = new Promise<void>((resolve) => (release = resolve))
  // Yields no message; ends only after the session is closed.
  async function* noMessages(): AsyncGenerator<never> {
    await held
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      abortController.abort()
      reject(new Error("Claude Code did not answer in time."))
    }, deps.deadlineMs ?? DISCOVERY_DEADLINE_MS)
  })
  let onAbort: (() => void) | undefined
  const cancelled = new Promise<never>((_, reject) => {
    onAbort = () => {
      abortController.abort()
      reject(new Error("The Claude Code check was cancelled."))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
  let session: ReturnType<ClaudeDiscoveryQuery> | undefined
  try {
    session = query({
      prompt: noMessages(),
      options: {
        pathToClaudeCodeExecutable: executable,
        env,
        ...(deps.cwd ? { cwd: deps.cwd } : {}),
        settingSources: deps.settingSources ?? [],
        settings: { disableAllHooks: true },
        tools: [],
        strictMcpConfig: true,
        persistSession: false,
        abortController,
      },
    })
    const initialized = session.initializationResult()
    initialized.catch(() => undefined) // Settled by the deadline instead.
    const result = await Promise.race([initialized, deadline, cancelled])
    const account =
      typeof result.account === "object" && result.account !== null
        ? (result.account as {
            subscriptionType?: unknown
            apiKeySource?: unknown
            tokenSource?: unknown
          })
        : {}
    return {
      models: Array.isArray(result.models) ? result.models : [],
      subscriptionType: account.subscriptionType,
      apiKeySource: account.apiKeySource,
      tokenSource: account.tokenSource,
    }
  } finally {
    clearTimeout(timer)
    if (onAbort) signal?.removeEventListener("abort", onAbort)
    try {
      session?.close()
    } catch {
      // Already closed.
    }
    release()
  }
}

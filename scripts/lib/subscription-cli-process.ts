import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { rm } from "node:fs/promises"
import { delimiter, isAbsolute, join } from "node:path"
import type { Readable, Writable } from "node:stream"
import { parse as parseDotenv } from "dotenv"
import { LOCAL_API_KEY_NAMES } from "@/lib/local-api-keys"
import {
  assertNativeLaunchAllowed,
  NativeLaunchBlockedError,
} from "./native-launch-guard"

export const SUBSCRIPTION_CLI_CEILING_MS = 5 * 60_000
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024

export type SubscriptionCliProcessFailureKind =
  | "missing-cli"
  | "auth-required"
  | "quota-exhausted"
  | "rate-limited"
  | "unsupported-capability"
  | "input-too-large"
  | "timeout"
  | "cancelled"
  | "local-process-failed"

export class SubscriptionCliProcessError extends Error {
  readonly kind: SubscriptionCliProcessFailureKind
  readonly exitCode?: number
  /** Internal lifecycle evidence; deliberately omitted from toJSON(). */
  readonly attempts: 0 | 1

  constructor(
    kind: SubscriptionCliProcessFailureKind,
    message: string,
    exitCode?: number,
    attempts: 0 | 1 = 1
  ) {
    super(message)
    this.name = "SubscriptionCliProcessError"
    this.kind = kind
    this.exitCode = exitCode
    this.attempts = attempts
  }

  toJSON(): {
    kind: SubscriptionCliProcessFailureKind
    message: string
    exitCode?: number
  } {
    return {
      kind: this.kind,
      message: this.message,
      ...(this.exitCode === undefined ? {} : { exitCode: this.exitCode }),
    }
  }
}

// The environment of a local tool run (Claude Code, Codex) and of its status
// command: the environment of the terminal that started formulacms, without
// the values formulacms loaded from the project's .env files (seat decision,
// 2026-11-15). A key in .env.local is formulacms's, not the tool's: Claude Code
// in `-p` mode always uses ANTHROPIC_API_KEY when present
// (https://code.claude.com/docs/en/authentication), so passing it would bill it.
// A key exported in the terminal still reaches the tool.
//
// Why the .env files are read here: by the time Next.js serves a request, its
// own snapshot of the starting environment (@next/env `initialEnv`) already
// holds the .env values. `pnpm dev` runs `convex dev`, which loads .env.local
// and .env into its environment with dotenv
// (node_modules/convex/dist/cjs/cli/lib/deploymentSelection.js:95-96); its
// `--start` child, scripts/start-next-dev.ts, calls `loadEnvConfig` and spawns
// `next` with that environment; `next dev` forks its server with
// `initialEnv || process.env` (node_modules/next/dist/cli/next-dev.js:362,401);
// the server then snapshots `initialEnv` and skips the files because
// `__NEXT_PROCESSED_ENV` is set (node_modules/@next/env/dist/index.js,
// `processEnv`). So nothing in the process remembers which values came from
// the files, and the files are compared instead.
//
// The files are parsed with dotenv's own parser (`dotenv.parse`, pinned to the
// version the Convex CLI bundles), so this list of names is the one the
// loaders produced: Node's `util.parseEnv` differs (it keeps a byte-order mark
// in the first name, for example), and a name it misreads would reach the tool.
//
// The rule: a variable is removed when a project .env file names it and its
// value equals that file's value. Neither dotenv nor Next.js overrides a
// variable that already exists, so a different value came from the terminal
// and is kept. A file value with `$` may have been expanded by Next.js, so the
// variable is removed whatever its value. Values are compared in memory only
// and never logged or returned. formulacms's own development key variables
// never reach the tool.

/** Variable names to values, as passed to a child process. */
export type ToolEnvironment = Readonly<Record<string, string | undefined>>

/** The files Next.js (development) and the Convex CLI load, in Next.js order. */
export const PROJECT_ENV_FILES = Object.freeze([
  ".env.development.local",
  ".env.local",
  ".env.development",
  ".env",
] as const)

const FORMULACMS_KEY_NAMES: ReadonlySet<string> = new Set(
  Object.values(LOCAL_API_KEY_NAMES).flat()
)

export interface LocalToolEnvironmentOptions {
  /** The process environment; defaults to `process.env`. */
  readonly env?: ToolEnvironment
  /** The project root; defaults to `process.cwd()` (where `next dev` runs). */
  readonly root?: string
  /** Returns a file's text, or null when it does not exist. */
  readonly readFile?: (path: string) => string | null
}

function readProjectFile(path: string): string | null {
  try {
    return readFileSync(path, "utf8")
  } catch {
    // Missing or unreadable: Next.js and dotenv did not load it either.
    return null
  }
}

function loadedFromProjectFiles(
  root: string,
  readFile: (path: string) => string | null
): (name: string, value: string) => boolean {
  const files: Record<string, string | undefined>[] = []
  for (const file of PROJECT_ENV_FILES) {
    const text = readFile(join(root, file))
    if (text) files.push(parseDotenv(text))
  }
  return (name, value) =>
    files.some((parsed) => {
      const fileValue = parsed[name]
      return (
        fileValue !== undefined &&
        (fileValue === value || fileValue.includes("$"))
      )
    })
}

/** See the rule above. Names and in-memory comparison only. */
export function localToolEnvironment(
  options: LocalToolEnvironmentOptions = {}
): ToolEnvironment {
  const env = options.env ?? process.env
  const fromFiles = loadedFromProjectFiles(
    options.root ?? process.cwd(),
    options.readFile ?? readProjectFile
  )
  const toolEnv: Record<string, string> = {}
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined || FORMULACMS_KEY_NAMES.has(name)) continue
    if (fromFiles(name, value)) continue
    toolEnv[name] = value
  }
  // The native installer puts Claude Code here on macOS/Linux. A Next server
  // started without an interactive shell may not inherit that PATH entry.
  // Append after sanitization: keep earlier installations and never restore
  // HOME/PATH values loaded from the project's files. Status, SDK discovery,
  // executable identity and real runs all consume this same environment.
  // https://code.claude.com/docs/en/setup#auto-updates
  if (process.platform !== "win32" && toolEnv.HOME && isAbsolute(toolEnv.HOME) && toolEnv.PATH) {
    const nativeBin = join(toolEnv.HOME, ".local", "bin")
    if (!toolEnv.PATH.split(delimiter).includes(nativeBin)) {
      toolEnv.PATH += `${delimiter}${nativeBin}`
    }
  }
  return toolEnv
}

export interface SubscriptionCliChild {
  readonly pid?: number
  readonly stdin: Writable
  readonly stdout: Readable
  readonly stderr: Readable
  once(event: "error", listener: (error: NodeJS.ErrnoException) => void): this
  once(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void
  ): this
}

export interface SubscriptionCliSpawnOptions {
  cwd: string
  /** Always explicit: see `localToolEnvironment`. */
  env: ToolEnvironment
  detached: boolean
  shell: false
  stdio: ["pipe", "pipe", "pipe"]
}

export type SpawnSubscriptionCli = (
  command: string,
  args: readonly string[],
  options: SubscriptionCliSpawnOptions
) => SubscriptionCliChild

export interface SubscriptionCliProcessRequest {
  command: string
  args: readonly string[]
  stdin: string
  cwd: string
  deadlineMs: number
  signal?: AbortSignal
  cleanupPaths?: readonly string[]
  /** Vendor-specific failure parsing. Raw output is available only inside this
   * callback and is never retained on the surfaced error. */
  classifyFailure?: (failure: {
    exitCode: number
    stdout: string
    stderr: string
  }) => SubscriptionCliProcessFailureKind
}

export interface SubscriptionCliProcessDeps {
  spawn?: SpawnSubscriptionCli
  /** The tool's environment; defaults to `localToolEnvironment()`. */
  env?: ToolEnvironment
  killTree?: (pid: number, signal: NodeJS.Signals) => Promise<void>
  removePath?: (path: string) => Promise<void>
}

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: SubscriptionCliSpawnOptions
): SubscriptionCliChild {
  assertNativeLaunchAllowed(command)
  return spawn(command, [...args], {
    ...options,
    env: options.env as NodeJS.ProcessEnv,
  })
}

function ignoreMissingProcess(error: unknown): void {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "ESRCH"
  ) {
    return
  }
  throw error
}

async function defaultKillTree(
  pid: number,
  signal: NodeJS.Signals
): Promise<void> {
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn(
        "taskkill",
        ["/pid", String(pid), "/T", "/F"],
        { detached: false, env: process.env, shell: false, stdio: "ignore" }
      )
      killer.once("error", () => resolve())
      killer.once("close", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, signal)
  } catch (error) {
    try {
      process.kill(pid, signal)
    } catch (fallbackError) {
      ignoreMissingProcess(fallbackError ?? error)
    }
  }
}

async function defaultRemovePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true })
}

const SAFE_MESSAGES = {
  "missing-cli": "The selected local AI CLI is not available.",
  "auth-required": "The selected local AI CLI requires authentication.",
  "quota-exhausted": "The selected local AI subscription has no available quota.",
  "rate-limited": "The selected local AI subscription rate-limited the request.",
  "unsupported-capability":
    "The selected local AI CLI does not support the requested capability.",
  "input-too-large": "The local AI request exceeds the selected CLI input limit.",
  timeout: "The selected local AI CLI exceeded its deadline.",
  cancelled: "The selected local AI CLI run was cancelled.",
  "local-process-failed": "The selected local AI CLI process failed.",
} as const satisfies Record<SubscriptionCliProcessFailureKind, string>

function safeError(
  kind: SubscriptionCliProcessFailureKind,
  exitCode?: number,
  attempts: 0 | 1 = 1
): SubscriptionCliProcessError {
  return new SubscriptionCliProcessError(
    kind,
    SAFE_MESSAGES[kind],
    exitCode,
    attempts
  )
}

function appendBounded(current: string, chunk: unknown): string {
  const next = current + String(chunk)
  if (Buffer.byteLength(next) > MAX_CAPTURE_BYTES) {
    throw safeError("local-process-failed")
  }
  return next
}

export async function runSubscriptionCliProcess(
  request: SubscriptionCliProcessRequest,
  deps: SubscriptionCliProcessDeps = {}
): Promise<{ stdout: string }> {
  const spawnProcess = deps.spawn ?? defaultSpawn
  const killTree = deps.killTree ?? defaultKillTree
  const removePath = deps.removePath ?? defaultRemovePath
  const cleanupPaths = request.cleanupPaths ?? []

  let child: SubscriptionCliChild | undefined
  let abortListener: (() => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined

  try {
    if (request.signal?.aborted) {
      throw safeError("cancelled", undefined, 0)
    }
    const execution = new Promise<{ stdout: string }>((resolve, reject) => {
      let settled = false
      let stdout = ""
      let stderr = ""

      const finish = (
        outcome: { stdout: string } | SubscriptionCliProcessError
      ) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        if (outcome instanceof SubscriptionCliProcessError) reject(outcome)
        else resolve(outcome)
      }

      const terminate = async (
        kind: "timeout" | "cancelled" | "local-process-failed"
      ) => {
        if (settled) return
        const pid = child?.pid
        if (pid !== undefined) {
          try {
            await killTree(pid, "SIGKILL")
          } catch {
            finish(safeError("local-process-failed"))
            return
          }
        }
        finish(safeError(kind))
      }

      try {
        child = spawnProcess(request.command, request.args, {
          cwd: request.cwd,
          env: deps.env ?? localToolEnvironment(),
          detached: process.platform !== "win32",
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
        })
      } catch (error) {
        // Kept as is, so a test that reached the real tool sees why.
        if (error instanceof NativeLaunchBlockedError) {
          settled = true
          reject(error)
          return
        }
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? (error as { code?: string }).code
            : undefined
        finish(
          safeError(
            code === "ENOENT" ? "missing-cli" : "local-process-failed",
            undefined,
            0
          )
        )
        return
      }

      child.stdout.on("data", (chunk) => {
        if (settled) return
        try {
          stdout = appendBounded(stdout, chunk)
        } catch {
          void terminate("local-process-failed")
        }
      })
      child.stderr.on("data", (chunk) => {
        if (settled) return
        try {
          stderr = appendBounded(stderr, chunk)
        } catch {
          void terminate("local-process-failed")
        }
      })
      child.once("error", (error) => {
        finish(
          safeError(
            error.code === "ENOENT" ? "missing-cli" : "local-process-failed",
            undefined,
            0
          )
        )
      })
      child.once("close", (code) => {
        if (code === 0) finish({ stdout })
        else {
          const exitCode = code ?? -1
          let kind: SubscriptionCliProcessFailureKind = "local-process-failed"
          try {
            kind =
              request.classifyFailure?.({ exitCode, stdout, stderr }) ?? kind
          } catch {
            kind = "local-process-failed"
          }
          finish(safeError(kind, exitCode))
        }
      })

      abortListener = () => void terminate("cancelled")
      request.signal?.addEventListener("abort", abortListener, { once: true })
      const deadlineMs = Math.max(
        0,
        Math.min(request.deadlineMs, SUBSCRIPTION_CLI_CEILING_MS)
      )
      timer = setTimeout(() => void terminate("timeout"), deadlineMs)

      child.stdin.once("error", () => finish(safeError("local-process-failed")))
      child.stdin.end(request.stdin)
    })

    return await execution
  } finally {
    if (timer) clearTimeout(timer)
    if (abortListener) {
      request.signal?.removeEventListener("abort", abortListener)
    }
    for (const path of cleanupPaths) {
      try {
        await removePath(path)
      } catch {
        throw safeError(
          "local-process-failed",
          undefined,
          child === undefined ? 0 : 1
        )
      }
    }
  }
}

// Live `model/list` capability preflight for the Codex subscription CLI.
//
// This is the ONLY app-server-shaped interaction formulacms permits: `codex exec`
// remains the generation surface, and app-server is never used to generate
// (docs/planning/unit-e-per-cli-end-to-end-matrix-2026-07-12.md § Hard stops).
//
// `codex app-server` is a persistent stdio JSON-RPC server, not a one-shot exec,
// so it cannot ride runSubscriptionCliProcess. It therefore runs its own bounded
// lifecycle and honours the same invariants independently: hard deadline,
// process-tree kill in a finally, bounded capture, and no retained raw responses,
// diagnostics, or session identifiers.
//
// Protocol: https://developers.openai.com/codex/app-server (§ Initialization:
// "Clients must send a single `initialize` request per transport connection
// before invoking any other method on that connection, then acknowledge with
// an `initialized` notification."), checked against a real Codex 0.163.0 run
// (2026-11-16):
//   initialize   -> params { clientInfo: { name, version } }
//   initialized  -> notification in the docs' shape, no id and no jsonrpc
//                   header: { method: "initialized", params: {} }
//   model/list   -> params { cursor?: string|null, limit?: number|null,
//                            includeHidden?: boolean|null }
//                -> result { data: Model[], nextCursor: string|null }

import { spawn } from "node:child_process"
import {
  assertNativeLaunchAllowed,
  NativeLaunchBlockedError,
} from "./native-launch-guard"
import {
  localToolEnvironment,
  SubscriptionCliProcessError,
  type SpawnSubscriptionCli,
  type SubscriptionCliChild,
  type SubscriptionCliSpawnOptions,
  type ToolEnvironment,
} from "./subscription-cli-process"
import type { RequestCodexModelListPage } from "./codex-cli-catalog"

/** Bounded capture: a catalog page is small; anything larger is not a catalog. */
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024
const DEFAULT_DEADLINE_MS = 30_000

/**
 * The Codex CLI ships inside the ChatGPT desktop app and is not necessarily on
 * PATH. Developers point at it with FORMULACMS_CODEX_BIN (gitignored .env.local);
 * the committed default stays machine-agnostic. A missing binary fails closed as
 * `missing-cli` -> CONFIG_MISSING.
 */
export function resolveCodexCommand(
  env: Partial<NodeJS.ProcessEnv> = process.env
): string {
  const configured =
    env.FORMULACMS_CODEX_BIN?.trim() || env.NEXTCMS_CODEX_BIN?.trim()
  return configured !== undefined && configured !== "" ? configured : "codex"
}
export interface CodexAppServerOptions {
  readonly command?: string
  readonly deadlineMs?: number
  readonly spawn?: SpawnSubscriptionCli
  /** The tool's environment; defaults to `localToolEnvironment()`. */
  readonly env?: ToolEnvironment
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(error: Error): void
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

function killTree(child: SubscriptionCliChild): void {
  const pid = child.pid
  if (pid === undefined) return
  try {
    if (process.platform === "win32") process.kill(pid, "SIGKILL")
    else process.kill(-pid, "SIGKILL")
  } catch {
    try {
      process.kill(pid, "SIGKILL")
    } catch {
      // Already gone. Nothing to clean up.
    }
  }
}

/**
 * Opens the app server, hands a `requestPage` to the callback, and
 * unconditionally tears the process tree down afterwards. Scoping the transport
 * to a callback is what makes the cleanup guarantee structural rather than a
 * caller obligation.
 */
export async function withCodexModelListTransport<T>(
  withPage: (requestPage: RequestCodexModelListPage) => Promise<T>,
  options: CodexAppServerOptions = {}
): Promise<T> {
  const command = options.command ?? resolveCodexCommand()
  const deadlineMs = options.deadlineMs ?? DEFAULT_DEADLINE_MS
  const spawnProcess = options.spawn ?? defaultSpawn

  let child: SubscriptionCliChild
  try {
    child = spawnProcess(command, ["app-server", "--listen", "stdio://"], {
      cwd: process.cwd(),
      env: options.env ?? localToolEnvironment(),
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    })
  } catch (error) {
    if (error instanceof NativeLaunchBlockedError) throw error
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: string }).code
        : undefined
    throw new SubscriptionCliProcessError(
      code === "ENOENT" ? "missing-cli" : "local-process-failed",
      code === "ENOENT"
        ? "The selected local AI CLI is not available."
        : "The selected local AI CLI process failed.",
      undefined,
      0
    )
  }

  const pending = new Map<number, PendingRequest>()
  let nextId = 1
  let buffer = ""
  let fatal: SubscriptionCliProcessError | undefined

  const failAll = (error: SubscriptionCliProcessError) => {
    fatal ??= error
    for (const [, request] of pending) request.reject(error)
    pending.clear()
  }

  const timer = setTimeout(() => {
    failAll(
      new SubscriptionCliProcessError(
        "timeout",
        "The selected local AI CLI exceeded its deadline."
      )
    )
    killTree(child)
  }, deadlineMs)

  child.stdout.on("data", (chunk: unknown) => {
    buffer += String(chunk)
    if (Buffer.byteLength(buffer) > MAX_CAPTURE_BYTES) {
      failAll(
        new SubscriptionCliProcessError(
          "local-process-failed",
          "The selected local AI CLI process failed."
        )
      )
      killTree(child)
      return
    }
    let index: number
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === "") continue
      let message: unknown
      try {
        message = JSON.parse(line)
      } catch {
        // The server also emits non-JSONRPC chatter; it is not a diagnostic
        // channel we trust, and it is never retained.
        continue
      }
      if (typeof message !== "object" || message === null) continue
      const { id, result, error } = message as {
        id?: unknown
        result?: unknown
        error?: unknown
      }
      if (typeof id !== "number") continue
      const request = pending.get(id)
      if (!request) continue
      pending.delete(id)
      // The JSON-RPC error body may carry vendor diagnostics; only the safe
      // normalized category escapes.
      if (error !== undefined) {
        request.reject(
          new SubscriptionCliProcessError(
            "local-process-failed",
            "The selected local AI CLI process failed."
          )
        )
        continue
      }
      request.resolve(result)
    }
  })

  // stderr is inspected by nobody: it is drained so the pipe cannot fill and
  // stall the child, and never captured.
  child.stderr.on("data", () => {})

  child.once("error", () => {
    failAll(
      new SubscriptionCliProcessError(
        "local-process-failed",
        "The selected local AI CLI process failed."
      )
    )
  })
  child.once("close", () => {
    failAll(
      new SubscriptionCliProcessError(
        "local-process-failed",
        "The selected local AI CLI process failed."
      )
    )
  })

  const call = (method: string, params: unknown): Promise<unknown> => {
    if (fatal) return Promise.reject(fatal)
    const id = nextId
    nextId += 1
    return new Promise<unknown>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`,
        (error) => {
          if (!error) return
          pending.delete(id)
          reject(
            new SubscriptionCliProcessError(
              "local-process-failed",
              "The selected local AI CLI process failed."
            )
          )
        }
      )
    })
  }

  try {
    await call("initialize", {
      clientInfo: { name: "formulacms-catalog-preflight", version: "1" },
    })
    // A notification has no id, so nothing waits for a reply. A failed write
    // surfaces on the next request or on `close`.
    child.stdin.write(
      `${JSON.stringify({ method: "initialized", params: {} })}\n`
    )
    const requestPage: RequestCodexModelListPage = async ({ cursor, limit }) =>
      // `includeHidden: false` is the default, sent explicitly. Never send
      // `modelProvider`: older app-servers (0.163) do not accept it.
      call("model/list", { cursor: cursor ?? null, limit, includeHidden: false })
    return await withPage(requestPage)
  } finally {
    clearTimeout(timer)
    killTree(child)
  }
}

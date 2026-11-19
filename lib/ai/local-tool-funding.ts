import "server-only"
import type { LocalToolSignInMethod } from "@/lib/ai/connection-validation"
import { inspectDevAiConnection } from "@/scripts/lib/dev-ai-connections"
import {
  localToolEnvironment,
  type ToolEnvironment,
} from "@/scripts/lib/subscription-cli-process"

// How a local tool run was billed, for its metadata-only audit row (ADR-0057,
// Funding). It is the same value Settings › AI reports as the sign-in method:
// "plan", "api-key" or "unknown". It comes from `claude auth status` and
// `codex login status` in the tool's own environment, so it matches what the
// run bills. Vendor output is read inside `inspectDevAiConnection` and never
// returned or logged here. Any failure means "unknown".

export type LocalToolFunding = LocalToolSignInMethod
export type LocalFundingTool = "claude" | "codex"

const CACHE_TTL_MS = 60_000

type CacheEntry = { readonly at: number; readonly value: LocalToolFunding }

// One entry per tool (two in all). A pending lookup is shared, so a run that
// writes several audit rows starts one status command per tool at most.
const cache = new Map<LocalFundingTool, CacheEntry>()
const pending = new Map<LocalFundingTool, Promise<LocalToolFunding>>()

export interface LocalToolFundingOptions {
  /** Defaults to `localToolEnvironment()`. */
  readonly toolEnv?: ToolEnvironment
  /** Defaults to `inspectDevAiConnection`. */
  readonly inspect?: typeof inspectDevAiConnection
  /** Defaults to `Date.now`. */
  readonly now?: () => number
}

async function lookup(
  tool: LocalFundingTool,
  options: LocalToolFundingOptions
): Promise<LocalToolFunding> {
  try {
    const toolEnv = options.toolEnv ?? localToolEnvironment()
    const inspect = options.inspect ?? inspectDevAiConnection
    const status = await inspect(tool, { toolEnv })
    if (status.state !== "authenticated") return "unknown"
    return status.method === "plan" || status.method === "api-key"
      ? status.method
      : "unknown"
  } catch {
    return "unknown"
  }
}

/** The funding of the next run of one local tool. Never throws. */
export async function localToolFunding(
  tool: LocalFundingTool,
  options: LocalToolFundingOptions = {}
): Promise<LocalToolFunding> {
  const now = (options.now ?? Date.now)()
  const cached = cache.get(tool)
  if (cached && now - cached.at < CACHE_TTL_MS && now >= cached.at) {
    return cached.value
  }
  const inFlight = pending.get(tool)
  if (inFlight) return inFlight
  const started = lookup(tool, options)
    .then((value) => {
      cache.set(tool, { at: now, value })
      return value
    })
    .finally(() => pending.delete(tool))
  pending.set(tool, started)
  return started
}

/**
 * The `funding` field of an audit row: set for the tool engines, absent for
 * the API engines, whose runs the spending records already cover.
 */
export async function fundingForAuditEngine(
  engine: string
): Promise<LocalToolFunding | undefined> {
  if (engine === "claude-cli") return localToolFunding("claude")
  if (engine === "codex-cli") return localToolFunding("codex")
  return undefined
}

/** For tests: forget cached and pending lookups. */
export function resetLocalToolFundingCache(): void {
  cache.clear()
  pending.clear()
}

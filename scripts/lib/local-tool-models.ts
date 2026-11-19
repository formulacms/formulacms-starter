// The models Settings › AI offers for the local tools (AI-MODELS-1c), on the
// owner's computer only. Codex lists its own through `model/list`, on the
// same app-server transport the run check uses. Claude Code lists its own,
// with the account's plan, in the Agent SDK's initialize handshake
// (`claude-cli-discovery.ts`); no prompt is sent.
//
// Cache: one in-process entry per tool and server process, fresh for 1 hour,
// mirrored to `.formulacms/local/local-tool-models.json` (gitignored, machine-local
// like `.formulacms/local/dev-ai.json`). Loads that run at the same time share one
// read. A failed read keeps the last list; with none, the committed lists
// apply. The list is never stored in Convex (ADR-0057). Every read first
// adopts the lists last published to the mirror, so the page render, Save and
// a run agree on what is offered; the run's own checks stay the final gate.
// A list also counts as old once the installed tool changes (its executable's
// real path, size or modification time, `local-tool-identity.ts`).
//
// Fable rule (owner, 2026-11-15): the menu and Save offer a Fable model only
// when the plan read with the list is Max or Ultra and was read within the
// last hour, or when Claude Code uses an API key (API rates; no plan
// applies). A stale, unknown or changed-sign-in plan greys it. This plan is
// for display only: a run never reads it. A Fable run checks the installed
// Claude Code again, every time, before staging or the generation process
// (`checkClaudeFablePlan`, ADR-0057).
//
// Revisions. The mirror keeps one revision per tool. A tool read captures
// its tool's revision before it starts and publishes only if that revision is
// still current, then advances it; so an older read never overwrites a newer
// one, and a read that started before a sign-in change never restores a plan.
// An observed Claude sign-in change (raw `loggedIn`/`authMethod`, see
// `ClaudeSignIn`) advances the Claude revision and drops the plan, with or
// without a cached plan. Each write rereads the mirror and replaces only its
// own tool's part. Writers: every loader (the page render, the server
// actions, a run) lives in the one local Next.js server process, so each
// read-merge-write step is synchronous (sync fs calls, no `await`) and needs
// no file lock; nothing is held across a tool read. Another process writing
// the same mirror at the same moment is not covered.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { localStateDirectory } from "@/lib/local-state/directory"
import {
  CLAUDE_PLAN_NAMES,
  claudePlanName,
  claudePlanState,
  readClaudeCodeHandshake,
  type ClaudeCodeHandshake,
  type ClaudePlanName,
  type ClaudePlanState,
} from "./claude-cli-discovery"
import { withCodexModelListTransport } from "./codex-app-server"
import { readCodexCliCatalog } from "./codex-cli-catalog"
import { localToolIdentity } from "./local-tool-identity"
import {
  builtInLocalToolModels,
  type LocalToolMenuModel,
  type LocalToolModels,
} from "./dev-ai-selection"
import type { ClaudeSignIn, LocalToolStatus } from "./dev-ai-connections"
import { claudeModelName, claudeVersion, VERSIONED_CLAUDE_ID } from "../../lib/local-model-names"
import {
  CLAUDE_CLI_EFFORTS_BY_MODEL,
  CODEX_CLI_MODEL_NAMES,
  CODEX_CLI_MODELS,
  isClaudeFableModel,
  isOfferedCodexCliModel,
  isSafeLocalToolModelId,
  isSelectableSubscriptionCliEffort,
  SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
  type ClaudeOfferedModels,
  type ObservedCodexCatalog,
} from "./subscription-cli-capabilities"

export const LOCAL_TOOL_MODELS_RELATIVE_PATH = ".formulacms/local/local-tool-models.json"
const LOCAL_TOOL_MODELS_FILE = "local-tool-models.json"
const CACHE_TTL_MS = 60 * 60_000
const CODEX_LIST_DEADLINE_MS = 10_000

/**
 * The Codex menu rows from an installed catalog: hidden, never-offered and
 * retired models are dropped, as is a model with no effort within the
 * ceiling. Known models come first in the committed order, then new ones in
 * the tool's order. An upgrade is kept only when it points at a listed row.
 */
export function codexMenuModels(
  catalog: ObservedCodexCatalog
): LocalToolMenuModel[] {
  const offered = catalog.data.filter(
    (item) =>
      item.hidden !== true &&
      isOfferedCodexCliModel(item.model) &&
      item.supportedReasoningEfforts.length > 0
  )
  const rank = (model: string) => {
    const index = (CODEX_CLI_MODELS as readonly string[]).indexOf(model)
    return index === -1 ? CODEX_CLI_MODELS.length : index
  }
  const ids = new Set(offered.map((item) => item.model))
  return [...offered]
    .sort((a, b) => rank(a.model) - rank(b.model))
    .map((item) => {
      const efforts = item.supportedReasoningEfforts.map((e) => e.reasoningEffort)
      const { defaultReasoningEffort: defaultEffort, upgrade } = item
      return {
        model: item.model,
        name: CODEX_CLI_MODEL_NAMES[item.model] ?? item.displayName ?? item.model,
        efforts,
        ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultEffort } : {}),
        ...(upgrade && upgrade !== item.model && ids.has(upgrade) ? { upgrade } : {}),
      }
    })
}

// ─── Claude Code ────────────────────────────────────────────────────────────

const CLAUDE_FAMILIES = ["haiku", "sonnet", "opus", "fable"] as const

/** A row with its efforts within the ceiling; `efforts` may be empty. */
function claudeRow(model: string, levels: unknown): LocalToolMenuModel {
  // Missing effort levels are unknown, not "none": the committed ones apply.
  const efforts = Array.isArray(levels)
    ? SUBSCRIPTION_CLI_SELECTABLE_EFFORTS.filter((effort) => levels.includes(effort))
    : ((CLAUDE_CLI_EFFORTS_BY_MODEL as Record<string, readonly string[]>)[model] ??
        ["low", "medium", "high"])
  return { model, name: claudeModelName(model), efforts: efforts as LocalToolMenuModel["efforts"] }
}

/** Haiku, Sonnet, Opus, Fable, then other families by name; newest first. */
function compareClaudeModels(a: string, b: string): number {
  const family = (model: string) => VERSIONED_CLAUDE_ID.exec(model)![1]!
  const rank = (name: string) => {
    const index = (CLAUDE_FAMILIES as readonly string[]).indexOf(name)
    return index === -1 ? CLAUDE_FAMILIES.length : index
  }
  const [fa, fb] = [family(a), family(b)]
  if (fa !== fb) return rank(fa) - rank(fb) || fa.localeCompare(fb)
  return compareVersions(claudeVersion(b), claudeVersion(a)) || a.localeCompare(b)
}

/**
 * The Claude Code menu from the handshake's model rows (owner, 2026-11-15:
 * "all rows"): every versioned model the installed Claude Code lists, from
 * the family aliases' `resolvedModel` and the versioned rows, once each, in
 * family order and newest first. `default`, `opusplan`, `[1m]` variants and
 * unversioned rows are skipped. With no versioned row at all (an older Claude
 * Code), the committed list is the menu.
 */
export function claudeMenuModels(rows: readonly unknown[]): LocalToolMenuModel[] {
  const listed = listedClaudeModels(rows)
  return listed.length > 0 ? listed : builtInLocalToolModels().claude.models.map(unmarked)
}

/**
 * A Claude run's own fresh read (2026-11-16): the models the
 * installed Claude Code lists right now, from the handshake's rows. It is
 * `observed` only when the tool listed at least one versioned model; with
 * none (an older Claude Code), it is the committed list and not `observed`,
 * so a run uses only a list the tool itself gave.
 * Unlike the menu, it keeps a listed model whose efforts are all above the
 * ceiling (with no efforts): the tool has it, so it is not absent, and the
 * run refuses its effort with the generic error.
 */
export function claudeOfferedFromHandshake(rows: readonly unknown[]): ClaudeOfferedModels {
  const listed = listedClaudeModels(rows, { keepWithoutEfforts: true })
  const models = listed.length > 0 ? listed : builtInLocalToolModels().claude.models
  return {
    observed: listed.length > 0,
    models: models.map(({ model, efforts }) => ({ model, efforts })),
  }
}

/** Negative, zero or positive as `a` is older than, the same as or newer than `b`. */
function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const diff = (a[i] ?? -1) - (b[i] ?? -1)
    if (diff !== 0) return diff
  }
  return 0
}

/** Every versioned model the rows list, once each, in menu order; may be
 * empty. A row with no effort within the ceiling is dropped unless
 * `keepWithoutEfforts` (membership only). */
function listedClaudeModels(
  rows: readonly unknown[],
  options: { readonly keepWithoutEfforts?: boolean } = {}
): LocalToolMenuModel[] {
  const models = new Map<string, LocalToolMenuModel>()
  for (const item of rows) {
    if (typeof item !== "object" || item === null) continue
    const row = item as Record<string, unknown>
    const model = (CLAUDE_FAMILIES as readonly unknown[]).includes(row.value)
      ? row.resolvedModel
      : row.value
    if (typeof model !== "string" || !VERSIONED_CLAUDE_ID.test(model) || models.has(model)) continue
    const menuRow = claudeRow(model, row.supportedEffortLevels)
    if (menuRow.efforts.length > 0 || options.keepWithoutEfforts) models.set(model, menuRow)
  }
  return [...models.values()].sort((a, b) => compareClaudeModels(a.model, b.model))
}

/**
 * The Claude sign-in control record, kept apart from the model rows: its
 * revision, the last sign-in Settings saw, and the plan read under that
 * revision. Only the plan state, its time and the raw non-identifying
 * sign-in are stored, never the email or the organization.
 */
export interface ClaudeAuthRecord {
  readonly revision: number
  readonly signIn?: ClaudeSignIn
  readonly plan?: {
    readonly state: ClaudePlanState
    /** The plan's name for display (Settings › AI), when it is one of
     * `CLAUDE_PLAN_NAMES`; never the raw string. */
    readonly name?: ClaudePlanName
    /** When it was read (ms); kept through failed reads. */
    readonly fetchedAt: number
    /** The revision it was read under, plus one. */
    readonly revision: number
  }
}

/** The Fable rule on the control record: a plan of the current revision,
 * read within `ttlMs`, that is Max or Ultra, or was read while Claude Code
 * used an API key. A future or invalid timestamp counts as unknown. */
export function isClaudeFableAllowed(
  auth: ClaudeAuthRecord | undefined,
  now: number,
  ttlMs: number = CACHE_TTL_MS
): boolean {
  const plan = currentPlan(auth, now, ttlMs)
  return plan !== undefined && (auth!.signIn!.status === "api-key" || plan.state === "eligible")
}

/** The plan read under the current revision and sign-in within `ttlMs`;
 * else undefined (stale, unknown, or read before a sign-in change). */
function currentPlan(auth: ClaudeAuthRecord | undefined, now: number, ttlMs: number) {
  const plan = auth?.plan
  if (!plan || !auth.signIn || plan.revision !== auth.revision || !Number.isFinite(plan.fetchedAt))
    return undefined
  const age = now - plan.fetchedAt
  return age < 0 || age >= ttlMs ? undefined : plan
}

const sameSignIn = (a: ClaudeSignIn | undefined, b: ClaudeSignIn) =>
  a !== undefined &&
  a.status === b.status &&
  a.loggedIn === b.loggedIn &&
  a.authMethod === b.authMethod &&
  a.envKey === b.envKey

/** A menu row without the Fable mark; the optional parts only when set. */
function unmarked(row: LocalToolMenuModel): LocalToolMenuModel {
  const { model, name, efforts, defaultEffort, upgrade } = row
  return {
    model,
    name,
    efforts,
    ...(defaultEffort ? { defaultEffort } : {}),
    ...(upgrade ? { upgrade } : {}),
  }
}

/** Marks every Fable row the rule does not allow; the others are unmarked. */
function withFableRule(
  rows: readonly LocalToolMenuModel[],
  allowed: boolean
): LocalToolMenuModel[] {
  return rows.map((row) =>
    isClaudeFableModel(row.model) && !allowed
      ? { ...unmarked(row), unavailable: "needsMaxOrUltra" as const }
      : unmarked(row)
  )
}

// ─── Cache and mirror ───────────────────────────────────────────────────────

interface CachedList {
  readonly models: readonly LocalToolMenuModel[]
  readonly fetchedAt: number
  /** The installed tool's identity when this list's read started. */
  readonly tool?: string
}

interface Cache {
  readonly codex?: CachedList
  readonly codexRevision: number
  readonly claude?: CachedList
  readonly claudeAuth: ClaudeAuthRecord
}

const EMPTY_CACHE: Cache = { codexRevision: 0, claudeAuth: { revision: 0 } }

const isEffortList = (value: unknown): value is LocalToolMenuModel["efforts"] =>
  Array.isArray(value) &&
  value.length > 0 &&
  value.every((e) => typeof e === "string" && isSelectableSubscriptionCliEffort(e))

const isRevision = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0

/** A mirror row that is still well formed and still offered; else dropped. */
function codexMirrorRow(value: unknown): LocalToolMenuModel | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  if (
    typeof row.model !== "string" ||
    !isOfferedCodexCliModel(row.model) ||
    typeof row.name !== "string" ||
    !isEffortList(row.efforts)
  )
    return undefined
  const { defaultEffort, upgrade } = row
  const valid = row.efforts
  return {
    model: row.model,
    name: row.name,
    efforts: valid,
    ...(valid.some((effort) => effort === defaultEffort)
      ? { defaultEffort: defaultEffort as (typeof valid)[number] }
      : {}),
    ...(typeof upgrade === "string" && isOfferedCodexCliModel(upgrade) ? { upgrade } : {}),
  }
}

function claudeMirrorRow(value: unknown): LocalToolMenuModel | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const row = value as Record<string, unknown>
  if (
    typeof row.model !== "string" ||
    !VERSIONED_CLAUDE_ID.test(row.model) ||
    !isSafeLocalToolModelId(row.model) ||
    typeof row.name !== "string" ||
    !isEffortList(row.efforts)
  )
    return undefined
  return { model: row.model, name: row.name, efforts: row.efforts }
}

function mirrorList(
  fetchedAt: unknown,
  rows: unknown,
  parseRow: (value: unknown) => LocalToolMenuModel | undefined,
  tool: unknown
): CachedList | undefined {
  if (typeof fetchedAt !== "number" || !Array.isArray(rows)) return undefined
  const models = rows.map(parseRow).filter((row) => row !== undefined)
  if (models.length === 0) return undefined
  // An older mirror has no identity: the list then keeps until it expires.
  return typeof tool === "string" && tool !== "" ? { models, fetchedAt, tool } : { models, fetchedAt }
}

// Every value of the union, no more: a new one fails the typecheck.
const PLAN_STATES: readonly unknown[] = Object.keys({
  eligible: true,
  insufficient: true,
  unknown: true,
} satisfies Record<ClaudePlanState, true>)
const STATUSES: readonly unknown[] = Object.keys({
  plan: true,
  "api-key": true,
  unknown: true,
  "signed-out": true,
  "not-installed": true,
} satisfies Record<LocalToolStatus, true>)

function mirrorSignIn(value: unknown): ClaudeSignIn | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const signIn = value as Record<string, unknown>
  return STATUSES.includes(signIn.status) &&
    (signIn.loggedIn === null || typeof signIn.loggedIn === "boolean") &&
    (signIn.authMethod === null ||
      (typeof signIn.authMethod === "string" && /^[a-z0-9._]{1,32}$/u.test(signIn.authMethod))) &&
    typeof signIn.envKey === "boolean"
    ? {
        status: signIn.status as LocalToolStatus,
        loggedIn: signIn.loggedIn as boolean | null,
        authMethod: signIn.authMethod as string | null,
        envKey: signIn.envKey,
      }
    : undefined
}

/** An invalid part counts as absent; an old record without revisions as
 * revision 0 with no plan (unknown). */
function mirrorAuth(value: unknown): ClaudeAuthRecord {
  if (typeof value !== "object" || value === null) return { revision: 0 }
  const auth = value as Record<string, unknown>
  const revision = isRevision(auth.revision) ? auth.revision : 0
  const signIn = mirrorSignIn(auth.signIn)
  const plan = auth.plan as Record<string, unknown> | null | undefined
  const validPlan =
    typeof plan === "object" &&
    plan !== null &&
    PLAN_STATES.includes(plan.state) &&
    typeof plan.fetchedAt === "number" &&
    isRevision(plan.revision)
  const name = validPlan && (CLAUDE_PLAN_NAMES as readonly unknown[]).includes(plan.name)
    ? (plan.name as ClaudePlanName)
    : undefined
  return {
    revision,
    ...(signIn ? { signIn } : {}),
    ...(validPlan
      ? {
          plan: {
            state: plan.state as ClaudePlanState,
            ...(name ? { name } : {}),
            fetchedAt: plan.fetchedAt as number,
            revision: plan.revision as number,
          },
        }
      : {}),
  }
}

/** The mirror's text, or undefined when it cannot be read. */
function readMirrorText(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8")
  } catch {
    return undefined
  }
}

function parseMirror(text: string): Cache | undefined {
  try {
    const value = JSON.parse(text) as Record<string, unknown>
    if (value?.version !== 1) return undefined
    const claude = value.claude as Record<string, unknown> | undefined
    return {
      codex: mirrorList(value.fetchedAt, value.codex, codexMirrorRow, value.codexTool),
      codexRevision: isRevision(value.codexRevision) ? value.codexRevision : 0,
      claude: mirrorList(claude?.fetchedAt, claude?.models, claudeMirrorRow, claude?.tool),
      claudeAuth: mirrorAuth(value.claudeAuth),
    }
  } catch {
    return undefined // Malformed: as if absent.
  }
}

let writeSequence = 0

/** Publishes the cache; returns the text written, or undefined if it failed. */
function writeMirror(path: string, cache: Cache): string | undefined {
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.${writeSequence++}.tmp`
    const { codex, codexRevision, claude, claudeAuth } = cache
    const body = {
      version: 1,
      ...(codex
        ? { fetchedAt: codex.fetchedAt, codex: codex.models, ...(codex.tool ? { codexTool: codex.tool } : {}) }
        : {}),
      codexRevision,
      ...(claude ? { claude } : {}),
      claudeAuth,
    }
    const text = `${JSON.stringify(body, null, 2)}\n`
    writeFileSync(tmp, text, "utf8")
    renameSync(tmp, path)
    return text
  } catch {
    // The mirror only saves a later read; the in-process cache still works.
    return undefined
  }
}

export interface LocalToolModelsLoaderOptions {
  /** Reads the installed Codex catalog (starts `codex app-server`). */
  readonly readCodex: () => Promise<ObservedCodexCatalog>
  /** Reads the installed Claude Code's list and plan (starts `claude`);
   * without it the committed Claude list applies. */
  readonly readClaude?: () => Promise<ClaudeCodeHandshake>
  readonly now?: () => number
  /** The project root; read at each call, never at module load. */
  readonly root?: () => string
  readonly ttlMs?: number
  /** The installed tool's identity, or undefined when it cannot be read;
   * defaults to `localToolIdentity`. Read by `load` only, never by a peek. */
  readonly identity?: (tool: "claude" | "codex") => string | undefined
}

export interface LocalToolModelsLoader {
  /** Reads a tool when its list is older than 1 hour or the installed tool
   * changed (or, for Claude Code, when no plan was read under the current
   * sign-in). */
  load(status: {
    readonly claude?: ClaudeSignIn
    readonly codex?: LocalToolStatus
  }): Promise<LocalToolModels>
  /** The cached or committed lists; never starts a tool. */
  peek(): LocalToolModels
  /** The models a Claude run may name (membership only: no plan and no
   * greyed mark), from the cache; never starts a tool. */
  peekClaude(): ClaudeOfferedModels
}

/** A tool read in progress, with the revision it started under. */
interface Inflight {
  readonly revision: number
  done: Promise<unknown>
}

/** One tool's read in progress, if any. */
interface ReadSlot {
  inflight?: Inflight
}

/** Loads at the same time share one read; a read an older revision started
 * is left to finish and publish nothing. Only the read in the slot clears it. */
function shareRead(
  slot: ReadSlot,
  revision: number,
  read: (revision: number) => Promise<void>
): Promise<unknown> {
  let inflight = slot.inflight
  if (inflight?.revision !== revision) {
    const started: Inflight = { revision, done: read(revision) }
    started.done = started.done.finally(() => {
      if (slot.inflight === started) slot.inflight = undefined
    })
    slot.inflight = inflight = started
  }
  return inflight.done
}

// The same states in which Settings lets the owner choose the tool.
const usable = (status: LocalToolStatus | undefined) =>
  status === "plan" || status === "api-key" || status === "unknown"

export function createLocalToolModelsLoader(
  options: LocalToolModelsLoaderOptions
): LocalToolModelsLoader {
  const now = options.now ?? Date.now
  const root = options.root ?? (() => process.cwd())
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS
  const identity = options.identity ?? localToolIdentity
  const mirrorPath = () =>
    join(localStateDirectory(root()), LOCAL_TOOL_MODELS_FILE)
  let memory: Cache = EMPTY_CACHE
  // The mirror text `memory` reflects: another loader (the page render, a
  // server action) may publish at any time.
  let seen: string | undefined
  const codexRead: ReadSlot = {}
  const claudeRead: ReadSlot = {}

  /** The state last published to the mirror, else the last good one in
   * memory (a missing, malformed or unwritable mirror). Synchronous. */
  const reconcile = (): Cache => {
    const text = readMirrorText(mirrorPath())
    if (text === undefined || text === seen) return memory
    seen = text
    const published = parseMirror(text)
    if (published)
      memory = {
        ...published,
        codex: published.codex ?? memory.codex,
        claude: published.claude ?? memory.claude,
      }
    return memory
  }
  /** One read-merge-write step against the current shared state. It must
   * stay synchronous (see the header): `change` gets the current state and
   * returns the next one, or undefined to leave it as it is. */
  const transact = (change: (current: Cache) => Cache | undefined) => {
    const next = change(reconcile())
    if (!next) return
    memory = next
    // A failed write leaves the mirror as it was: memory supersedes it.
    seen = writeMirror(mirrorPath(), memory) ?? readMirrorText(mirrorPath())
  }
  const output = (cache: Cache): LocalToolModels => {
    const builtIn = builtInLocalToolModels()
    const { codex, claude } = cache
    const allowed = isClaudeFableAllowed(cache.claudeAuth, now(), ttlMs)
    // The same current plan the Fable rule reads, so the name never disagrees with it.
    const plan = currentPlan(cache.claudeAuth, now(), ttlMs)?.name
    return {
      claude: {
        ...(claude
          ? { source: "installed" as const, models: withFableRule(claude.models, allowed) }
          : { ...builtIn.claude, models: withFableRule(builtIn.claude.models, allowed) }),
        ...(plan ? { plan } : {}),
      },
      codex: codex ? { models: codex.models, source: "installed" } : builtIn.codex,
    }
  }
  /** Within the hour and read from the tool installed now. A list or a
   * current identity that is unknown counts as unchanged. */
  const fresh = (list: CachedList | undefined, tool: string | undefined) =>
    list !== undefined &&
    now() - list.fetchedAt < ttlMs &&
    (list.tool === undefined || tool === undefined || list.tool === tool)

  // `tool` is the identity read before the read started; the list keeps it.
  const refreshCodex = async (revision: number, tool: string | undefined) => {
    const models = codexMenuModels(await options.readCodex())
    // An empty list says nothing about what the tool offers: keep the last one.
    if (models.length === 0) throw new Error("The installed Codex listed no model to offer.")
    transact((current) =>
      // A read that another one overtook publishes nothing.
      current.codexRevision !== revision
        ? undefined
        : {
            ...current,
            codex: { models, fetchedAt: now(), ...(tool ? { tool } : {}) },
            codexRevision: revision + 1,
          }
    )
  }
  const refreshClaude = async (revision: number, tool: string | undefined) => {
    const handshake = await options.readClaude!()
    transact((current) => {
      // A sign-in change or a newer read since this one started: discard it.
      if (current.claudeAuth.revision !== revision) return undefined
      const fetchedAt = now()
      const name = claudePlanName(handshake.subscriptionType)
      return {
        ...current,
        claude: { models: claudeMenuModels(handshake.models), fetchedAt, ...(tool ? { tool } : {}) },
        claudeAuth: {
          ...current.claudeAuth,
          revision: revision + 1,
          plan: {
            state: claudePlanState(handshake.subscriptionType),
            ...(name ? { name } : {}),
            fetchedAt,
            revision: revision + 1,
          },
        },
      }
    })
  }
  const loadCodex = async (status: LocalToolStatus | undefined) => {
    const { codex, codexRevision } = reconcile()
    if (!usable(status)) return
    const tool = identity("codex")
    if (fresh(codex, tool)) return
    await shareRead(codexRead, codexRevision, (revision) => refreshCodex(revision, tool))
  }
  const loadClaude = async (signIn: ClaudeSignIn | undefined) => {
    if (signIn === undefined) return // Not checked: nothing to compare.
    // A sign-in change (raw values) drops the plan, here and in a run.
    transact((current) =>
      sameSignIn(current.claudeAuth.signIn, signIn)
        ? undefined
        : { ...current, claudeAuth: { revision: current.claudeAuth.revision + 1, signIn } }
    )
    if (!options.readClaude || !usable(signIn.status)) return
    const { claude, claudeAuth } = memory
    const tool = identity("claude")
    if (fresh(claude, tool) && claudeAuth.plan?.revision === claudeAuth.revision) return
    await shareRead(claudeRead, claudeAuth.revision, (revision) => refreshClaude(revision, tool))
  }

  return {
    peek: () => output(reconcile()),
    peekClaude: () => ({
      models: output(reconcile()).claude.models.map(({ model, efforts }) => ({ model, efforts })),
    }),
    async load(status) {
      // A failed read keeps the last list (or one another loader published meanwhile).
      await Promise.allSettled([loadCodex(status.codex), loadClaude(status.claude)])
      return output(reconcile())
    },
  }
}

const loader = createLocalToolModelsLoader({
  readCodex: () =>
    withCodexModelListTransport((requestPage) => readCodexCliCatalog({ requestPage }), {
      deadlineMs: CODEX_LIST_DEADLINE_MS,
    }),
  readClaude: () => readClaudeCodeHandshake(),
})

/** Settings › AI page load: the menus' model lists. */
export const loadLocalToolModels = loader.load
/** Saving a choice: the lists the owner saw, without starting a tool. */
export const peekLocalToolModels = loader.peek
/** A Claude run: the models it may name, without starting a tool. */
export const peekClaudeOfferedModels = loader.peekClaude

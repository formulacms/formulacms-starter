// Machine-local Development AI selection (ADR-0032 build lane).
//
// The Settings → AI "Development AI" card and the authoring CLI share one
// store: `.formulacms/local/dev-ai.json` (gitignored). It lives on the developer's
// machine and is written by a dev-only Next server action — NEVER by Convex,
// and never into Convex: persisting a machine-local engine choice into the
// shared deployment is the exact boundary ADR-0032 forbids.
//
// Resolution precedence for CLI runs:
//   --engine flag > FORMULACMS_DEV_AI_ENGINE env > this file > "openrouter".
// An explicit "off" in the file fails closed (the CLI refuses to run) rather
// than degrading into a fallback engine; an unknown or malformed file throws
// rather than being silently ignored.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { localStateDirectory } from "@/lib/local-state/directory"
import {
  REASONING_EFFORTS,
  type ReasoningEffort,
  type TaskProfile,
} from "@/lib/ai/execution-contract"
import {
  ENGINE_IDS,
  isEngineId,
  resolveEngineId,
  type EngineId,
} from "./ai-engine"
import {
  CLAUDE_CLI_EFFORTS_BY_MODEL,
  CLAUDE_CLI_MODEL_NAMES,
  CLAUDE_CLI_MODELS,
  CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP,
  CODEX_CLI_MODEL_NAMES,
  CODEX_CLI_MODELS,
  CODEX_SUBSCRIPTION_CLI_PROFILE_MAP,
  CODEX_CLI_SELECTABLE_EFFORTS,
  isClaudeFableModel,
  isSafeLocalToolModelId,
  isSelectableCodexCliEffort,
  isSelectableSubscriptionCliEffort,
  SUBSCRIPTION_CLI_SELECTABLE_EFFORTS,
} from "./subscription-cli-capabilities"
import type { ClaudePlanName } from "./claude-cli-discovery"

/** For labels and messages; a site from 0.2.0 may still keep it under `.nextcms/`. */
export const DEV_AI_SELECTION_RELATIVE_PATH = ".formulacms/local/dev-ai.json"
const DEV_AI_SELECTION_FILE = "dev-ai.json"

export const DEV_AI_CHOICES = Object.freeze([
  "off",
  ...ENGINE_IDS,
] as const satisfies readonly ("off" | EngineId)[])

export type DevAiChoice = (typeof DEV_AI_CHOICES)[number]

/**
 * Task profiles that the Development-lane per-task routing block can address.
 * The full agentic set that shows up as a row in Settings → AI → Development —
 * five editor-facing profiles plus the two slice-authoring profiles that live
 * in the build lane exclusively (ADR-0032 amendment 2026-07-14). The two
 * agentic-rescue profiles (`judgment-transform`, `explicit-agentic-rescue`)
 * stay internal escape hatches and never appear in the UI.
 */
export const DEV_TASK_PROFILE_KEYS = Object.freeze([
  "mechanical-translation",
  "brand-translation",
  "editorial-copy",
  "structured-outline-meta",
  "grounded-help",
  "vision-spec",
  "renderer-jsx",
] as const satisfies readonly TaskProfile[])

export type DevTaskProfileKey = (typeof DEV_TASK_PROFILE_KEYS)[number]

/**
 * Editor-facing profiles — the ones the v2 `contentLane` toggle used to gate.
 * On v2 → v3 upgrade these are the tasks that get an explicit override, so the
 * v3 file preserves the v2 file's runtime behavior byte-for-byte.
 */
export const DEV_EDITOR_TASK_PROFILE_KEYS = Object.freeze([
  "mechanical-translation",
  "brand-translation",
  "editorial-copy",
  "structured-outline-meta",
  "grounded-help",
] as const satisfies readonly DevTaskProfileKey[])

export type DevEditorTaskProfileKey =
  (typeof DEV_EDITOR_TASK_PROFILE_KEYS)[number]

export function isDevTaskProfileKey(value: string): value is DevTaskProfileKey {
  return (DEV_TASK_PROFILE_KEYS as readonly string[]).includes(value)
}

export function isDevEditorTaskProfileKey(
  value: string
): value is DevEditorTaskProfileKey {
  return (DEV_EDITOR_TASK_PROFILE_KEYS as readonly string[]).includes(value)
}

export interface DevAiTaskOverride {
  /** When set, the effective engine for this task; otherwise inherit the
   *  top-level provider. */
  readonly engine?: DevAiChoice
  readonly model?: string
  readonly effort?: ReasoningEffort
}

export type DevAiTaskOverrides = Readonly<
  Partial<Record<DevTaskProfileKey, Readonly<DevAiTaskOverride>>>
>

/**
 * Schema versions
 *
 * v1: `{ version, engine, model?, effort? }` — the original build-lane
 *     selection shipped with ADR-0032.
 * v2: adds `contentLane: "off" | "on"` — Phase-2 Option-A editor lane toggle.
 * v3: adds `tasks: { [profileKey]: { engine?, model?, effort? } }` — full
 *     per-task routing under the Development lane, replacing the coarse
 *     `contentLane` toggle. Editor tasks with per-task `engine: "off"` fall
 *     back to the Production runtime path (preserving v2 `contentLane: "off"`
 *     behavior); slice tasks with `engine: "off"` fail closed at the caller.
 *
 * `parseDevAiSelection` accepts v1 and v2 files and upgrades them in-memory
 * to v3. The on-disk file is only rewritten as v3 the next time the operator
 * saves in the UI, so a downgrade to an older repo checkout still reads its
 * own historical write.
 */
export interface DevAiSelection {
  readonly version: 3
  readonly engine: DevAiChoice
  /** Optional override on the top-level provider; engine-specific rules. */
  readonly model?: string
  readonly effort?: ReasoningEffort
  /** Per-task overrides. A key omitted here means "inherit the top-level
   *  provider"; a task set to `engine: "off"` opts out (editor tasks fall
   *  back to Production AI, slice tasks fail closed). */
  readonly tasks?: DevAiTaskOverrides
}

export type DevAiSelectionSource = "flag" | "env" | "settings" | "default"

export interface ResolvedDevAiSelection {
  readonly engineId: EngineId
  readonly model?: string
  readonly effort?: ReasoningEffort
  readonly source: DevAiSelectionSource
}

const ALLOWED_TOP_LEVEL_KEYS = new Set([
  "version",
  "engine",
  "model",
  "effort",
  "tasks",
  // v2 legacy — accepted and consumed by the v2 → v3 upgrader; the returned
  // shape never carries it forward.
  "contentLane",
])

const ALLOWED_TASK_KEYS = new Set(["engine", "model", "effort"])

const CONTENT_LANE_V2_CHOICES = new Set(["off", "on"])

function invalid(context: string, reason: string): never {
  throw new Error(`Invalid dev AI selection (${context}): ${reason}`)
}

interface EngineOverrideInput {
  engine: DevAiChoice
  model?: unknown
  effort?: unknown
}

/**
 * Validate the `model`/`effort` pair against the engine-specific rules that
 * apply to both top-level and per-task overrides:
 * - `off`: no model/effort. Off has nothing to configure.
 * - `claude` / `codex`: both-or-neither; the model must be a safe model id
 *   and the effort must sit at or below the owner's `xhigh` subscription
 *   ceiling. Whether the tool offers the model is checked on save and run.
 * - API engines: model and effort are independent; the deep catalog check
 *   stays with the engine at run time, which fails loudly (no fallback).
 */
function validateEngineOverride(
  context: string,
  input: EngineOverrideInput
): {
  model?: string
  effort?: ReasoningEffort
} {
  const { engine, model, effort } = input
  if (
    model !== undefined &&
    (typeof model !== "string" || model.trim() === "")
  ) {
    invalid(context, "model must be a non-empty string")
  }
  if (
    effort !== undefined &&
    (typeof effort !== "string" ||
      !(REASONING_EFFORTS as readonly string[]).includes(effort))
  ) {
    invalid(
      context,
      `unknown effort ${JSON.stringify(effort)}. Valid: ${REASONING_EFFORTS.join(", ")}`
    )
  }
  if (engine === "off") {
    if (model !== undefined || effort !== undefined) {
      invalid(context, "Off takes no model/effort")
    }
    return {}
  }
  if (engine === "codex") {
    // Codex takes one model and one effort, both-or-neither. The file check
    // is shape only: the installed Codex lists the models, so a model only
    // it lists, or one Settings offered before, never makes the whole file
    // unreadable. Saving checks the menu (`assertOfferedLocalToolChoices`);
    // the run checks the installed catalog.
    if ((model === undefined) !== (effort === undefined)) {
      invalid(context, "codex override requires both model and effort")
    }
    if (model !== undefined && !isSafeLocalToolModelId(model as string)) {
      invalid(context, `unsafe codex model id ${JSON.stringify(model)}`)
    }
    if (effort !== undefined && !isSelectableCodexCliEffort(effort as string)) {
      invalid(
        context,
        `effort "${String(effort)}" is above the Codex ceiling. Valid: ${CODEX_CLI_SELECTABLE_EFFORTS.join(", ")}`
      )
    }
  }
  if (engine === "claude") {
    if ((model === undefined) !== (effort === undefined)) {
      invalid(context, "claude override requires both model and effort")
    }
    // Shape only, as for Codex: a saved alias (`sonnet`, or `fable`, which
    // the run refuses) still parses. Saving checks the menu; the run checks
    // the model and its efforts (`isSelectableClaudeCliTuple`).
    if (model !== undefined && !isSafeLocalToolModelId(model as string)) {
      invalid(context, `unsafe claude model id ${JSON.stringify(model)}`)
    }
    if (
      effort !== undefined &&
      !isSelectableSubscriptionCliEffort(effort as string)
    ) {
      invalid(
        context,
        `effort "${String(effort)}" is above the subscription CLI ceiling. Valid: ${SUBSCRIPTION_CLI_SELECTABLE_EFFORTS.join(", ")}`
      )
    }
  }
  return {
    ...(model !== undefined ? { model: model as string } : {}),
    ...(effort !== undefined ? { effort: effort as ReasoningEffort } : {}),
  }
}

function parseTaskOverride(
  context: string,
  key: string,
  raw: unknown
): Readonly<DevAiTaskOverride> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid(`${context} tasks.${key}`, "expected a JSON object")
  }
  const record = raw as Record<string, unknown>
  for (const inner of Object.keys(record)) {
    if (!ALLOWED_TASK_KEYS.has(inner)) {
      invalid(`${context} tasks.${key}`, `unknown key "${inner}"`)
    }
  }
  const engineRaw = record.engine
  const modelRaw = record.model
  const effortRaw = record.effort

  if (engineRaw !== undefined) {
    if (
      typeof engineRaw !== "string" ||
      !(engineRaw === "off" || isEngineId(engineRaw))
    ) {
      invalid(
        `${context} tasks.${key}`,
        `unknown engine ${JSON.stringify(engineRaw)}. Valid: ${DEV_AI_CHOICES.join(", ")}`
      )
    }
    const validated = validateEngineOverride(`${context} tasks.${key}`, {
      engine: engineRaw as DevAiChoice,
      model: modelRaw,
      effort: effortRaw,
    })
    return Object.freeze({
      engine: engineRaw as DevAiChoice,
      ...validated,
    })
  }

  // Task override without an explicit engine — accepted only when model and
  // effort are both absent (the row exists but delegates fully to the
  // top-level provider). Anything else would ambiguously validate model/effort
  // against an unknown engine, so reject rather than guess.
  if (modelRaw !== undefined || effortRaw !== undefined) {
    invalid(
      `${context} tasks.${key}`,
      "model/effort require the task to pin an engine; either add an engine or drop the override"
    )
  }
  return Object.freeze({})
}

/**
 * Single validator for both the file on disk and the (untrusted) server-action
 * payload. Accepts v1, v2, or v3 input; always returns a v3 shape.
 *
 * v1 → v3: no per-task overrides.
 * v2 → v3: `contentLane: "on"` becomes explicit `engine: "claude"` overrides on
 *   every editor-facing task, byte-preserving today's behavior; `contentLane:
 *   "off"` (or absent, which was implicit-off on v2) becomes explicit `engine:
 *   "off"` overrides on the editor tasks — that turns the "route editor tasks
 *   through Production AI" default into a first-class per-task selection.
 *
 * The v2 `contentLane cannot be "on" when engine is "off"` invariant is not
 * re-checked here — the v2 file may have persisted a stale `contentLane: "on"`
 * with a later switch to `off`, so we always upgrade the editor rows to point
 * at claude when the toggle was on. The `validateEngineOverride` call then
 * enforces the same engine-specific rules on the resulting per-task claude
 * override, so a truly incoherent v2 file still fails loudly.
 */
export function parseDevAiSelection(
  raw: unknown,
  context: string
): DevAiSelection {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid(context, "expected a JSON object")
  }
  const record = raw as Record<string, unknown>
  for (const key of Object.keys(record)) {
    if (!ALLOWED_TOP_LEVEL_KEYS.has(key))
      invalid(context, `unknown key "${key}"`)
  }
  const version = record.version
  if (version !== 1 && version !== 2 && version !== 3) {
    invalid(context, `unsupported version ${JSON.stringify(version)}`)
  }
  const engine = record.engine
  if (typeof engine !== "string" || !(engine === "off" || isEngineId(engine))) {
    invalid(
      context,
      `unknown engine ${JSON.stringify(engine)}. Valid: ${DEV_AI_CHOICES.join(", ")}`
    )
  }

  const modelRaw = record.model
  const effortRaw = record.effort
  const validated = validateEngineOverride(context, {
    engine: engine as DevAiChoice,
    model: modelRaw,
    effort: effortRaw,
  })

  const contentLaneRaw = record.contentLane
  if (contentLaneRaw !== undefined) {
    if (version === 1 || version === 3) {
      invalid(
        context,
        version === 1
          ? "contentLane is a v2 field; v1 files must omit it"
          : "contentLane was retired in v3; use per-task overrides"
      )
    }
    if (
      typeof contentLaneRaw !== "string" ||
      !CONTENT_LANE_V2_CHOICES.has(contentLaneRaw)
    ) {
      invalid(
        context,
        `unknown contentLane ${JSON.stringify(contentLaneRaw)}. Valid: "off", "on"`
      )
    }
  }

  const tasksRaw = record.tasks
  let tasks: DevAiTaskOverrides | undefined
  if (tasksRaw !== undefined) {
    if (version !== 3) {
      invalid(context, "tasks is a v3 field; older files must omit it")
    }
    if (
      typeof tasksRaw !== "object" ||
      tasksRaw === null ||
      Array.isArray(tasksRaw)
    ) {
      invalid(context, "tasks must be a JSON object")
    }
    const parsed: {
      [K in DevTaskProfileKey]?: Readonly<DevAiTaskOverride>
    } = {}
    for (const [key, value] of Object.entries(
      tasksRaw as Record<string, unknown>
    )) {
      if (!isDevTaskProfileKey(key)) {
        invalid(
          context,
          `unknown task key "${key}". Valid: ${DEV_TASK_PROFILE_KEYS.join(", ")}`
        )
      }
      parsed[key] = parseTaskOverride(context, key, value)
    }
    // Prune fully-empty overrides — a `{}` override carries no runtime meaning
    // and would just add noise to the persisted file.
    for (const key of Object.keys(parsed) as DevTaskProfileKey[]) {
      const override = parsed[key]
      if (override && Object.keys(override).length === 0) delete parsed[key]
    }
    if (Object.keys(parsed).length > 0) tasks = Object.freeze(parsed)
  }

  if (version === 2) {
    tasks = upgradeContentLaneToTasks(
      contentLaneRaw as "off" | "on" | undefined,
      context
    )
  }

  return {
    version: 3,
    engine: engine as DevAiChoice,
    ...validated,
    ...(tasks ? { tasks } : {}),
  }
}

function upgradeContentLaneToTasks(
  contentLane: "off" | "on" | undefined,
  context: string
): DevAiTaskOverrides | undefined {
  const nextEngine: DevAiChoice = contentLane === "on" ? "claude" : "off"
  const override = Object.freeze({
    engine: nextEngine,
  } satisfies DevAiTaskOverride)
  // Validate defensively — if the upgraded shape somehow violated the
  // per-engine rules, we'd rather fail here than write a broken v3 in memory.
  validateEngineOverride(`${context} tasks.<editor>`, {
    engine: nextEngine,
  })
  const upgraded: { [K in DevTaskProfileKey]?: Readonly<DevAiTaskOverride> } =
    {}
  for (const key of DEV_EDITOR_TASK_PROFILE_KEYS) {
    upgraded[key] = override
  }
  return Object.freeze(upgraded)
}

export function devAiSelectionPath(root: string = process.cwd()): string {
  return join(localStateDirectory(root), DEV_AI_SELECTION_FILE)
}

/** `null` when no selection has ever been saved; throws on a malformed file. */
export function readDevAiSelection(
  root: string = process.cwd(),
  readText: (path: string) => string = (path) => readFileSync(path, "utf8")
): DevAiSelection | null {
  let path = devAiSelectionPath(root)
  let text: string
  try {
    text = readText(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    // The server start may have just moved `.nextcms/` to `.formulacms/local/`:
    // look once more, so a saved "off" is never read as "nothing saved".
    const again = devAiSelectionPath(root)
    if (again === path) return null
    path = again
    try {
      text = readText(path)
    } catch (retryError) {
      if ((retryError as NodeJS.ErrnoException).code === "ENOENT") return null
      throw retryError
    }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    invalid(path, error instanceof Error ? error.message : String(error))
  }
  return parseDevAiSelection(parsed, path)
}

let writeSequence = 0

/** Validates, then writes atomically (temp file + rename). */
export function writeDevAiSelection(
  raw: unknown,
  root: string = process.cwd()
): DevAiSelection {
  const selection = parseDevAiSelection(raw, "selection to save")
  const path = devAiSelectionPath(root)
  mkdirSync(dirname(path), { recursive: true })
  // pid alone can collide when the server runs actions on worker threads
  // (same pid); the sequence keeps concurrent saves on distinct temp paths.
  const tmp = `${path}.${process.pid}.${writeSequence++}.tmp`
  writeFileSync(tmp, `${JSON.stringify(selection, null, 2)}\n`, "utf8")
  renameSync(tmp, path)
  return selection
}

export interface ResolveDevAiSelectionOptions {
  /** `--engine` CLI flag. */
  flag?: string
  /** `--engine-model` CLI flag. */
  flagModel?: string
  /** `--engine-effort` CLI flag. */
  flagEffort?: ReasoningEffort
  /** Defaults to the compatible FORMULACMS_DEV_AI_ENGINE environment reader. */
  env?: string
  /** Injection seam for tests; defaults to reading the file under `root`. */
  persisted?: DevAiSelection | null
  root?: string
  /** When set, per-task overrides for this profile win over the top-level
   *  provider. Flag / env still take precedence over any per-task entry —
   *  an explicit CLI flag is a one-off intent, and per-task file overrides
   *  are a saved intent that a flag should always be able to trump. */
  profile?: TaskProfile
}

export function resolveDevAiEngineEnvironment(
  env: Partial<NodeJS.ProcessEnv> = process.env
): string | undefined {
  return env.FORMULACMS_DEV_AI_ENGINE?.trim()
    ? env.FORMULACMS_DEV_AI_ENGINE
    : env.NEXTCMS_DEV_AI_ENGINE?.trim()
      ? env.NEXTCMS_DEV_AI_ENGINE
      : undefined
}

/**
 * Engine resolution for CLI runs: flag > env > settings file > "openrouter".
 *
 * The persisted model/effort apply only when the engine itself came from the
 * settings file AND no --engine-model/--engine-effort flag was given — a
 * flag-chosen engine must never inherit a tuple that was saved for a
 * different engine, and override flags always win wholesale (never mixed
 * with persisted values, so the pair stays validated as one unit).
 *
 * When `options.profile` is set and the persisted file carries a per-task
 * override for that profile, the override composes with the top-level
 * selection under `resolveTaskOverride`: a matching engine inherits model /
 * effort from the top-level, a different engine takes only its own tuple.
 *
 * An exported-but-empty FORMULACMS_DEV_AI_ENGINE counts as unset here (it falls
 * through to the settings file) — a deliberate deviation from resolveEngineId,
 * which throws on it; "" expresses cleared intent, not a chosen engine.
 */
export function resolveDevAiSelection(
  options: ResolveDevAiSelectionOptions = {}
): ResolvedDevAiSelection {
  const env = options.env ?? resolveDevAiEngineEnvironment()
  const flagOverrides =
    options.flagModel !== undefined || options.flagEffort !== undefined

  if (options.flag !== undefined || (env !== undefined && env.trim() !== "")) {
    return {
      engineId: resolveEngineId(options.flag, env),
      ...(options.flagModel !== undefined ? { model: options.flagModel } : {}),
      ...(options.flagEffort !== undefined
        ? { effort: options.flagEffort }
        : {}),
      source: options.flag !== undefined ? "flag" : "env",
    }
  }

  const persisted =
    options.persisted !== undefined
      ? options.persisted
      : readDevAiSelection(options.root)
  if (persisted === null) {
    return {
      engineId: "openrouter",
      ...(options.flagModel !== undefined ? { model: options.flagModel } : {}),
      ...(options.flagEffort !== undefined
        ? { effort: options.flagEffort }
        : {}),
      source: "default",
    }
  }

  const resolved = resolveTaskOverride(
    persisted,
    options.profile && isDevTaskProfileKey(options.profile)
      ? options.profile
      : undefined
  )

  if (resolved.engine === "off") {
    // Same message shape the CLI has always thrown — callers that want a
    // silent fall-back (editor server actions) resolve directly against the
    // parsed selection via `resolveDevAiTaskSelection` instead of calling
    // this throw-on-off entry point.
    throw new Error(
      `Development AI is Off (${DEV_AI_SELECTION_RELATIVE_PATH}, set in /admin/settings → AI). ` +
        `Pass --engine <${ENGINE_IDS.join("|")}> for a one-off run, or select an engine in Settings.`
    )
  }
  if (flagOverrides) {
    return {
      engineId: resolved.engine,
      ...(options.flagModel !== undefined ? { model: options.flagModel } : {}),
      ...(options.flagEffort !== undefined
        ? { effort: options.flagEffort }
        : {}),
      source: "settings",
    }
  }
  return {
    engineId: resolved.engine,
    ...(resolved.model !== undefined ? { model: resolved.model } : {}),
    ...(resolved.effort !== undefined ? { effort: resolved.effort } : {}),
    source: "settings",
  }
}

/**
 * A task-aware effective selection. Never throws on `engine: "off"` — that
 * decision belongs to the caller (slice tasks fail closed, editor tasks fall
 * back to Production AI). `persisted === null` resolves to the top-level
 * default (openrouter), matching `resolveDevAiSelection`'s empty-file path.
 */
export interface DevAiTaskEffectiveSelection {
  readonly engine: DevAiChoice
  readonly model?: string
  readonly effort?: ReasoningEffort
}

export function resolveDevAiTaskSelection(
  persisted: DevAiSelection | null,
  profile: TaskProfile
): DevAiTaskEffectiveSelection {
  if (persisted === null) return { engine: "openrouter" }
  return resolveTaskOverride(
    persisted,
    isDevTaskProfileKey(profile) ? profile : undefined
  )
}

function resolveTaskOverride(
  persisted: DevAiSelection,
  profile: DevTaskProfileKey | undefined
): DevAiTaskEffectiveSelection {
  const topLevel: DevAiTaskEffectiveSelection = {
    engine: persisted.engine,
    ...(persisted.model !== undefined ? { model: persisted.model } : {}),
    ...(persisted.effort !== undefined ? { effort: persisted.effort } : {}),
  }
  if (!profile) return topLevel
  const override = persisted.tasks?.[profile]
  if (!override) return topLevel
  const engine = override.engine ?? persisted.engine
  // Same-engine overrides inherit missing model/effort from the top-level
  // provider; a different engine takes only its own tuple so we never mix a
  // model from one engine into another engine's request.
  if (override.engine === undefined || override.engine === persisted.engine) {
    return {
      engine,
      ...(override.model !== undefined
        ? { model: override.model }
        : persisted.model !== undefined
          ? { model: persisted.model }
          : {}),
      ...(override.effort !== undefined
        ? { effort: override.effort }
        : persisted.effort !== undefined
          ? { effort: persisted.effort }
          : {}),
    }
  }
  return {
    engine,
    ...(override.model !== undefined ? { model: override.model } : {}),
    ...(override.effort !== undefined ? { effort: override.effort } : {}),
  }
}

// ─── Local tool choices per assistant (ADR-0057 step 1, Settings › AI) ───────
//
// Settings › AI on localhost lets the owner run Help, the Block creator,
// Writing and Translation on a local tool (Claude Code or Codex). The choice
// is a per-task override in this same file, the same tool, model and effort
// for every task of the assistant: Help is `grounded-help`; the Block creator
// is `vision-spec` and `renderer-jsx`; Writing and Translation own the task
// profiles of `ASSISTANT_PROFILES` (`lib/ai/task-profiles.ts`). The first task
// gives the assistant's default model and effort: `editorial-copy` for
// Writing, `brand-translation` for Translation (the whole-page jobs run those
// two). Choosing an API service removes the overrides; every other key in the
// file stays as it is. Callers check the request (`isLocalToolRequest`) before
// they read or write: off localhost this file is never read.

export const LOCAL_TOOL_ASSISTANT_TASKS = Object.freeze({
  help: Object.freeze(["grounded-help"] as const),
  sliceCreator: Object.freeze(["vision-spec", "renderer-jsx"] as const),
  writing: Object.freeze(["editorial-copy", "structured-outline-meta"] as const),
  translation: Object.freeze([
    "brand-translation",
    "mechanical-translation",
  ] as const),
} satisfies Record<string, readonly DevTaskProfileKey[]>)

export type LocalToolAssistant = keyof typeof LOCAL_TOOL_ASSISTANT_TASKS
export const LOCAL_TOOL_ASSISTANTS = Object.freeze(
  Object.keys(LOCAL_TOOL_ASSISTANT_TASKS) as LocalToolAssistant[]
)
export type LocalToolChoiceEngine = "claude" | "codex"

export interface LocalToolChoice {
  readonly engine: LocalToolChoiceEngine
  readonly model: string
  readonly effort: ReasoningEffort
}

export type LocalToolChoices = Partial<
  Record<LocalToolAssistant, LocalToolChoice>
>
/** `null` removes the assistant's local tool choice (an API service runs it). */
export type LocalToolChoiceChanges = Partial<
  Record<LocalToolAssistant, LocalToolChoice | null>
>

/** The saved local tool choice of each assistant: explicit overrides only. */
export function localToolChoicesOf(
  selection: DevAiSelection | null
): LocalToolChoices {
  const choices: { [K in LocalToolAssistant]?: LocalToolChoice } = {}
  for (const assistant of LOCAL_TOOL_ASSISTANTS) {
    const override =
      selection?.tasks?.[LOCAL_TOOL_ASSISTANT_TASKS[assistant][0]]
    if (
      (override?.engine === "claude" || override?.engine === "codex") &&
      override.model !== undefined &&
      override.effort !== undefined
    ) {
      choices[assistant] = {
        engine: override.engine,
        model: override.model,
        effort: override.effort,
      }
    }
  }
  return choices
}

/**
 * Strict check of an untrusted save payload: only the assistants of
 * `LOCAL_TOOL_ASSISTANT_TASKS`, each `null` or `{ engine: "claude" | "codex", model, effort }`. The model
 * and effort are checked against the tool's lists when the file is written.
 */
export function parseLocalToolChoiceChanges(
  raw: unknown
): LocalToolChoiceChanges {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid("local tool choices", "expected a JSON object")
  }
  const changes: { [K in LocalToolAssistant]?: LocalToolChoice | null } = {}
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!(LOCAL_TOOL_ASSISTANTS as readonly string[]).includes(key)) {
      invalid("local tool choices", `unknown assistant "${key}"`)
    }
    if (value === null) {
      changes[key as LocalToolAssistant] = null
      continue
    }
    if (typeof value !== "object" || Array.isArray(value)) {
      invalid(`local tool choices ${key}`, "expected a JSON object or null")
    }
    const record = value as Record<string, unknown>
    for (const inner of Object.keys(record)) {
      if (!ALLOWED_TASK_KEYS.has(inner)) {
        invalid(`local tool choices ${key}`, `unknown key "${inner}"`)
      }
    }
    if (record.engine !== "claude" && record.engine !== "codex") {
      invalid(
        `local tool choices ${key}`,
        `unknown local tool ${JSON.stringify(record.engine)}. Valid: claude, codex`
      )
    }
    if (record.model === undefined || record.effort === undefined) {
      invalid(`local tool choices ${key}`, "model and effort are required")
    }
    const validated = validateEngineOverride(`local tool choices ${key}`, {
      engine: record.engine,
      model: record.model,
      effort: record.effort,
    })
    changes[key as LocalToolAssistant] = {
      engine: record.engine,
      model: validated.model!,
      effort: validated.effort!,
    }
  }
  return changes
}

/**
 * The file content after the changes, ready for `writeDevAiSelection`. With no
 * file yet it starts from the same default the readers use (`openrouter`), so
 * the other assistants keep their route.
 */
function withLocalToolChoices(
  selection: DevAiSelection | null,
  changes: LocalToolChoiceChanges
): DevAiSelection {
  const base: DevAiSelection = selection ?? { version: 3, engine: "openrouter" }
  const tasks: { [K in DevTaskProfileKey]?: Readonly<DevAiTaskOverride> } = {
    ...base.tasks,
  }
  for (const assistant of LOCAL_TOOL_ASSISTANTS) {
    if (!Object.hasOwn(changes, assistant)) continue
    const choice = changes[assistant]
    for (const task of LOCAL_TOOL_ASSISTANT_TASKS[assistant]) {
      if (choice) {
        tasks[task] = {
          engine: choice.engine,
          model: choice.model,
          effort: choice.effort,
        }
      } else delete tasks[task]
    }
  }
  return {
    version: 3,
    engine: base.engine,
    ...(base.model !== undefined ? { model: base.model } : {}),
    ...(base.effort !== undefined ? { effort: base.effort } : {}),
    ...(Object.keys(tasks).length > 0 ? { tasks } : {}),
  }
}

/** The saved local tool choices; throws on a malformed file. */
export function readLocalToolChoices(
  root: string = process.cwd()
): LocalToolChoices {
  return localToolChoicesOf(readDevAiSelection(root))
}

/**
 * Applies the changes and writes the file atomically. Refuses (throws) when
 * the current file is malformed, so a broken file is never overwritten.
 */
export function writeLocalToolChoices(
  changes: LocalToolChoiceChanges,
  root: string = process.cwd()
): LocalToolChoices {
  const next = withLocalToolChoices(readDevAiSelection(root), changes)
  return localToolChoicesOf(writeDevAiSelection(next, root))
}

export interface LocalToolMenuModel {
  readonly model: string
  readonly name: string
  readonly efforts: readonly ReasoningEffort[]
  /** The vendor's default effort for this model, within `efforts`. */
  readonly defaultEffort?: ReasoningEffort
  /** A listed, offered model the vendor suggests instead. */
  readonly upgrade?: string
  /** Listed but cannot be chosen: Fable without a Max or Ultra plan. */
  readonly unavailable?: "needsMaxOrUltra"
}

/** The models each local tool offers: from the installed tool, or the
 * committed lists when it cannot say (`scripts/lib/local-tool-models.ts`). */
export type LocalToolModels = Readonly<
  Record<
    LocalToolChoiceEngine,
    {
      readonly models: readonly LocalToolMenuModel[]
      readonly source: "installed" | "built-in"
      /** Claude Code only: the plan read with the list, when it is current
       * and has a known name (display only; a run never reads it). */
      readonly plan?: ClaudePlanName
    }
  >
>

export interface LocalToolMenu {
  readonly models: readonly LocalToolMenuModel[]
  /** The tool's default model and effort for each assistant. */
  readonly defaults: Readonly<
    Record<LocalToolAssistant, Omit<LocalToolChoice, "engine">>
  >
}

/**
 * The default effort the real Codex lists for each committed model
 * (`defaultReasoningEffort` in `model/list`, Codex 0.163.0, real run of
 * 2026-11-16). With them, the committed list gives the same defaults as an
 * installed list that says the same.
 */
export const CODEX_CLI_DEFAULT_EFFORTS: Readonly<
  Record<
    (typeof CODEX_CLI_MODELS)[number],
    (typeof CODEX_CLI_SELECTABLE_EFFORTS)[number]
  >
> = Object.freeze({
  "gpt-6.1-sol": "low",
  "gpt-6-astra": "medium",
  "gpt-6.1-terra": "low",
  "gpt-6-luna": "medium",
})

/** The committed model lists, used when a tool cannot list its own. */
export function builtInLocalToolModels(): LocalToolModels {
  return {
    claude: {
      source: "built-in",
      // No plan is known here, so Fable cannot be chosen.
      models: CLAUDE_CLI_MODELS.map((model) => ({
        model,
        name: CLAUDE_CLI_MODEL_NAMES[model],
        efforts: CLAUDE_CLI_EFFORTS_BY_MODEL[model],
        ...(isClaudeFableModel(model) ? { unavailable: "needsMaxOrUltra" as const } : {}),
      })),
    },
    codex: {
      source: "built-in",
      models: CODEX_CLI_MODELS.map((model) => ({
        model,
        name: CODEX_CLI_MODEL_NAMES[model] ?? model,
        efforts: CODEX_CLI_SELECTABLE_EFFORTS,
        defaultEffort: CODEX_CLI_DEFAULT_EFFORTS[model],
      })),
    },
  }
}

/**
 * Refuses (throws) a changed choice the menu does not offer at that effort,
 * or lists but does not let the owner choose. Only the changes are checked: a saved choice the menu no longer lists is
 * never rewritten and does not block saving another assistant.
 */
export function assertOfferedLocalToolChoices(
  changes: LocalToolChoiceChanges,
  models: LocalToolModels
): void {
  for (const [assistant, choice] of Object.entries(changes)) {
    if (!choice) continue
    const row = models[choice.engine].models.find(
      (item) => item.model === choice.model
    )
    if (!row) {
      invalid(
        `local tool choices ${assistant}`,
        `${choice.engine} model ${JSON.stringify(choice.model)} is not offered`
      )
    }
    if (row.unavailable) {
      invalid(
        `local tool choices ${assistant}`,
        `${choice.engine} model ${JSON.stringify(choice.model)} cannot be chosen: it needs a Max or Ultra plan`
      )
    }
    if (!row.efforts.includes(choice.effort)) {
      invalid(
        `local tool choices ${assistant}`,
        `effort "${choice.effort}" is not available for ${choice.engine} model "${choice.model}"`
      )
    }
  }
}

/**
 * What Settings › AI offers for each local tool: the loaded model lists, and
 * each assistant's default from the committed task profiles (the first task
 * of the assistant). A default the list lacks shows its id, as a saved
 * off-list choice does. A Codex default takes the effort the loaded Codex
 * list gives for that model (`defaultEffort`: the installed list, or the
 * committed `CODEX_CLI_DEFAULT_EFFORTS`), else the task profile's effort.
 */
export function localToolMenus(
  models: LocalToolModels = builtInLocalToolModels()
): Readonly<Record<LocalToolChoiceEngine, LocalToolMenu>> {
  const defaults = (
    map: Partial<
      Record<
        TaskProfile,
        { readonly model: string; readonly effort: ReasoningEffort }
      >
    >,
    rows: readonly LocalToolMenuModel[] = []
  ) => {
    const result = {} as Record<
      LocalToolAssistant,
      Omit<LocalToolChoice, "engine">
    >
    for (const assistant of LOCAL_TOOL_ASSISTANTS) {
      const tuple = map[LOCAL_TOOL_ASSISTANT_TASKS[assistant][0]]!
      const listed = rows.find(
        (row) => row.model === tuple.model
      )?.defaultEffort
      result[assistant] = { model: tuple.model, effort: listed ?? tuple.effort }
    }
    return result
  }
  return {
    claude: {
      models: models.claude.models,
      defaults: defaults(CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP),
    },
    codex: {
      models: models.codex.models,
      defaults: defaults(
        CODEX_SUBSCRIPTION_CLI_PROFILE_MAP,
        models.codex.models
      ),
    },
  }
}

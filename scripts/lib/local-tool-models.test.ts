// @vitest-environment node
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, test, vi } from "vitest"
import { assertOfferedLocalToolChoices, builtInLocalToolModels } from "./dev-ai-selection"
import { claudePlanName, claudePlanState, type ClaudeCodeHandshake, type ClaudePlanState } from "./claude-cli-discovery"
import {
  claudeMenuModels,
  claudeOfferedFromHandshake,
  codexMenuModels,
  createLocalToolModelsLoader,
  isClaudeFableAllowed,
  LOCAL_TOOL_MODELS_RELATIVE_PATH,
  type ClaudeAuthRecord,
} from "./local-tool-models"
import type { ClaudeSignIn } from "./dev-ai-connections"
import type { ObservedCodexCatalog } from "./subscription-cli-capabilities"

const efforts = (...values: string[]) => values.map((reasoningEffort) => ({ reasoningEffort })) as ObservedCodexCatalog["data"][number]["supportedReasoningEfforts"]
const row = (model: string, extra: Partial<ObservedCodexCatalog["data"][number]> = {}) => ({
  model,
  supportedReasoningEfforts: efforts("low", "medium", "high", "xhigh"),
  inputModalities: ["text", "image"] as const,
  ...extra,
})

// The shape `model/list` returns once parsed (efforts already within the ceiling).
const CATALOG: ObservedCodexCatalog = {
  data: [
    row("gpt-6.2-nova", { displayName: "GPT-6.2-Nova", defaultReasoningEffort: "medium" }),
    row("gpt-6-luna", { displayName: "GPT-6-Luna", defaultReasoningEffort: "medium" }),
    row("gpt-6.1-sol", { displayName: "GPT-6.1-Sol", hidden: false }),
    row("gpt-6-sol", { displayName: "GPT-6-Sol" }),
    row("gpt-daybreak-blue-latest", { displayName: "Daybreak Blue", hidden: true }),
    row("gpt-5.6-sol", { displayName: "GPT-5.6-Sol", upgrade: "gpt-6-sol" }),
    row("gpt-6-astra", { upgrade: "gpt-6-sol" }),
    row("gpt-6.1-terra", { upgrade: "gpt-6.2-nova" }),
    row("gpt-only-max", { supportedReasoningEfforts: [] }),
  ],
}

// Hermetic: no test reads the installed tools; an unknown identity keeps today's behaviour.
const noTool = () => undefined

describe("codexMenuModels", () => {
  test("drops hidden, never-offered, retired and effortless models; keeps versioned names", () => {
    expect(codexMenuModels(CATALOG)).toEqual([
      { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] },
      // An upgrade to gpt-6-sol (never offered) is dropped.
      { model: "gpt-6-astra", name: "GPT-6 Astra", efforts: ["low", "medium", "high", "xhigh"] },
      { model: "gpt-6.1-terra", name: "GPT-6.1 Terra", efforts: ["low", "medium", "high", "xhigh"], upgrade: "gpt-6.2-nova" },
      { model: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
      // A model the committed list does not know: the tool's own name, after the known ones.
      { model: "gpt-6.2-nova", name: "GPT-6.2-Nova", efforts: ["low", "medium", "high", "xhigh"], defaultEffort: "medium" },
    ])
  })
})

describe("createLocalToolModelsLoader", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const setup = (readCodex: () => Promise<ObservedCodexCatalog>) => {
    const root = mkdtempSync(join(tmpdir(), "formulacms-local-models-"))
    roots.push(root)
    let clock = 1_000_000
    const loader = createLocalToolModelsLoader({ readCodex, now: () => clock, root: () => root, identity: noTool })
    return { root, loader, tick: (ms: number) => (clock += ms) }
  }
  const signedIn = { codex: "plan" } as const
  const codexIds = (models: ReturnType<typeof builtInLocalToolModels>) => models.codex.models.map((m) => m.model)

  test("with no list yet and a failed read, the committed lists apply", async () => {
    const { loader } = setup(async () => Promise.reject(new Error("no codex")))
    await expect(loader.load(signedIn)).resolves.toEqual(builtInLocalToolModels())
    expect(loader.peek()).toEqual(builtInLocalToolModels())
  })

  test("a fresh list is reused for 1 hour, then read again", async () => {
    const readCodex = vi.fn(async () => CATALOG)
    const { loader, tick } = setup(readCodex)
    const first = await loader.load(signedIn)
    expect(first.codex.source).toBe("installed")
    expect(codexIds(first)).toContain("gpt-6.2-nova")
    tick(59 * 60_000)
    await loader.load(signedIn)
    expect(readCodex).toHaveBeenCalledTimes(1)
    tick(2 * 60_000)
    await loader.load(signedIn)
    expect(readCodex).toHaveBeenCalledTimes(2)
  })

  test("a failed refresh keeps the stale list", async () => {
    const readCodex = vi.fn<() => Promise<ObservedCodexCatalog>>().mockResolvedValueOnce(CATALOG).mockRejectedValue(new Error("timeout"))
    const { loader, tick } = setup(readCodex)
    const first = await loader.load(signedIn)
    tick(2 * 60 * 60_000)
    await expect(loader.load(signedIn)).resolves.toEqual(first)
    expect(readCodex).toHaveBeenCalledTimes(2)
  })

  test("loads that run at the same time share one read", async () => {
    let finish!: (catalog: ObservedCodexCatalog) => void
    const readCodex = vi.fn(() => new Promise<ObservedCodexCatalog>((resolve) => (finish = resolve)))
    const { loader } = setup(readCodex)
    const both = Promise.all([loader.load(signedIn), loader.load(signedIn)])
    finish(CATALOG)
    const [a, b] = await both
    expect(readCodex).toHaveBeenCalledTimes(1)
    expect(a).toEqual(b)
  })

  test("a tool the owner cannot use is not started", async () => {
    const readCodex = vi.fn(async () => CATALOG)
    const { loader } = setup(readCodex)
    for (const codex of ["not-installed", "signed-out", undefined] as const)
      await expect(loader.load({ codex })).resolves.toEqual(builtInLocalToolModels())
    expect(readCodex).not.toHaveBeenCalled()
  })

  test("the mirror file serves another process without starting the tool", async () => {
    const { root, loader } = setup(async () => CATALOG)
    const loaded = await loader.load(signedIn)
    const path = join(root, LOCAL_TOOL_MODELS_RELATIVE_PATH)
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1, fetchedAt: 1_000_000 })
    const readCodex = vi.fn(async () => CATALOG)
    const other = createLocalToolModelsLoader({ readCodex, now: () => 1_000_000, root: () => root, identity: noTool })
    expect(other.peek()).toEqual(loaded)
    await expect(other.load(signedIn)).resolves.toEqual(loaded)
    expect(readCodex).not.toHaveBeenCalled()
  })

  test("a malformed mirror counts as absent; a mirror row now never offered is dropped", () => {
    const { root, loader } = setup(async () => CATALOG)
    const path = join(root, LOCAL_TOOL_MODELS_RELATIVE_PATH)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, "{ not json", "utf8")
    expect(loader.peek()).toEqual(builtInLocalToolModels())
    const rows = [
      { model: "gpt-6-sol", name: "GPT-6-Sol", efforts: ["high"] },
      { model: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low"], upgrade: "gpt-6-sol" },
    ]
    writeFileSync(path, JSON.stringify({ version: 1, fetchedAt: 1, codex: rows }), "utf8")
    const fresh = createLocalToolModelsLoader({ readCodex: async () => CATALOG, root: () => root, identity: noTool })
    expect(fresh.peek().codex.models).toEqual([{ model: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low"] }])
  })
})

// Guard for the defect class "cache coherence across loader instances": the
// page render and Save each hold a loader; both follow the list last
// published to the shared mirror, whatever its timestamp.
describe("two loaders sharing one mirror", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const LIST_1: ObservedCodexCatalog = { data: [row("gpt-6-luna"), row("gpt-6.1-sol")] }
  const LIST_2: ObservedCodexCatalog = { data: [row("gpt-6.1-sol"), row("gpt-6.2-nova", { displayName: "GPT-6.2-Nova" })] }
  const signedIn = { codex: "plan" } as const
  const setup = (ttlMs?: number) => {
    const root = mkdtempSync(join(tmpdir(), "formulacms-local-models-"))
    roots.push(root)
    let clock = 1_000_000
    const make = (readCodex: () => Promise<ObservedCodexCatalog>) =>
      createLocalToolModelsLoader({ readCodex, now: () => clock, root: () => root, ttlMs, identity: noTool })
    return { make, tick: (ms: number) => (clock += ms) }
  }
  const ids = (models: ReturnType<typeof builtInLocalToolModels>) => models.codex.models.map((m) => m.model)
  const save = (model: string, models: ReturnType<typeof builtInLocalToolModels>) => () =>
    assertOfferedLocalToolChoices({ help: { engine: "codex", model, effort: "low" } }, models)

  test("a warm reader sees a model the other added and loses one it removed; Save follows", async () => {
    const { make, tick } = setup()
    const page = make(vi.fn<() => Promise<ObservedCodexCatalog>>().mockResolvedValueOnce(LIST_1).mockResolvedValueOnce(LIST_2))
    const saveReadCodex = vi.fn(async () => LIST_1)
    const saver = make(saveReadCodex)
    await page.load(signedIn)
    await saver.load(signedIn)
    expect(ids(saver.peek())).toEqual(["gpt-6.1-sol", "gpt-6-luna"])
    tick(2 * 60 * 60_000)
    expect(ids(await page.load(signedIn))).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    expect(ids(saver.peek())).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    expect(save("gpt-6.2-nova", saver.peek())).not.toThrow()
    expect(save("gpt-6-luna", saver.peek())).toThrow(/not offered/)
    // The saver's own load uses the fresh published list without starting the tool.
    expect(ids(await saver.load(signedIn))).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    expect(saveReadCodex).not.toHaveBeenCalled()
  })

  test("a list published with the same timestamp still replaces the reader's", async () => {
    const { make } = setup(0) // Every load reads the tool; the clock never moves.
    const page = make(vi.fn<() => Promise<ObservedCodexCatalog>>().mockResolvedValueOnce(LIST_1).mockResolvedValueOnce(LIST_2))
    const saver = make(async () => LIST_1)
    await page.load(signedIn)
    expect(ids(saver.peek())).toEqual(["gpt-6.1-sol", "gpt-6-luna"])
    await page.load(signedIn)
    expect(ids(saver.peek())).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    expect(save("gpt-6-luna", saver.peek())).toThrow(/not offered/)
  })

  test("a failed refresh returns the list another loader published meanwhile", async () => {
    const { make, tick } = setup()
    let fail!: (error: Error) => void
    const saver = make(
      vi.fn<() => Promise<ObservedCodexCatalog>>()
        .mockResolvedValueOnce(LIST_1)
        .mockImplementationOnce(() => new Promise((_, reject) => (fail = reject)))
    )
    const page = make(async () => LIST_2)
    await saver.load(signedIn)
    tick(2 * 60 * 60_000)
    const refreshing = saver.load(signedIn)
    await page.load(signedIn)
    fail(new Error("timeout"))
    expect(ids(await refreshing)).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    expect(ids(saver.peek())).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
  })

  test("a mirror that disappears or turns malformed keeps the last good list", async () => {
    const { make } = setup()
    const page = make(async () => LIST_2)
    await page.load(signedIn)
    const saver = make(async () => LIST_1)
    expect(ids(saver.peek())).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    const path = join(roots[0]!, LOCAL_TOOL_MODELS_RELATIVE_PATH)
    writeFileSync(path, "{ not json", "utf8")
    expect(ids(saver.peek())).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    rmSync(path)
    expect(ids(saver.peek())).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
  })
})

// ─── Claude Code (AI-MODELS-1c step 3) ──────────────────────────────────────

// The model rows of walk (a), 2026-11-15: Claude Code 2.1.325, SDK 0.3.325.
const E5 = ["low", "medium", "high", "xhigh", "max"]
const WALK_ROWS = [
  { value: "default", resolvedModel: "claude-fable-5-2", displayName: "Default (recommended)", supportedEffortLevels: E5 },
  { value: "opus", resolvedModel: "claude-opus-5-5", displayName: "Opus 5.5", supportedEffortLevels: E5 },
  { value: "fable", resolvedModel: "claude-fable-5-2", displayName: "Fable 5.2", supportedEffortLevels: E5 },
  { value: "sonnet", resolvedModel: "claude-sonnet-5-5", displayName: "Sonnet 5.5", supportedEffortLevels: E5 },
  { value: "haiku", resolvedModel: "claude-haiku-5-5", displayName: "Haiku 5.5", supportedEffortLevels: E5 },
  { value: "claude-fable-5-1", resolvedModel: "claude-fable-5-1", displayName: "Fable 5.1", supportedEffortLevels: E5 },
  { value: "claude-haiku-4-5-20251001", resolvedModel: "claude-haiku-4-5-20251001", displayName: "Haiku 4.5" },
  { value: "claude-sonnet-5", resolvedModel: "claude-sonnet-5", displayName: "Sonnet 5", supportedEffortLevels: E5 },
  { value: "claude-opus-5", resolvedModel: "claude-opus-5", displayName: "Opus 5", supportedEffortLevels: E5 },
  { value: "claude-fable-5", resolvedModel: "claude-fable-5", displayName: "Fable 5", supportedEffortLevels: E5 },
  { value: "claude-opus-4-8", resolvedModel: "claude-opus-4-8", displayName: "Opus 4.8", supportedEffortLevels: E5 },
  { value: "claude-opus-4-7", resolvedModel: "claude-opus-4-7", displayName: "Opus 4.7", supportedEffortLevels: E5 },
  { value: "claude-opus-4-6", resolvedModel: "claude-opus-4-6", displayName: "Opus 4.6", supportedEffortLevels: ["low", "medium", "high", "max"] },
  { value: "claude-sonnet-4-6", resolvedModel: "claude-sonnet-4-6", displayName: "Sonnet 4.6", supportedEffortLevels: ["low", "medium", "high", "max"] },
]
const UP_TO_XHIGH = ["low", "medium", "high", "xhigh"]

describe("claudeMenuModels", () => {
  // Owner, 2026-11-15: "all rows".
  test("lists every versioned model once, by family and newest first", () => {
    expect(claudeMenuModels(WALK_ROWS)).toEqual([
      { model: "claude-haiku-5-5", name: "Haiku 5.5", efforts: UP_TO_XHIGH },
      // No effort levels listed: unknown, so the default efforts apply.
      { model: "claude-haiku-4-5-20251001", name: "Haiku 4.5", efforts: ["low", "medium", "high"] },
      { model: "claude-sonnet-5-5", name: "Sonnet 5.5", efforts: UP_TO_XHIGH },
      { model: "claude-sonnet-5", name: "Sonnet 5", efforts: UP_TO_XHIGH },
      { model: "claude-sonnet-4-6", name: "Sonnet 4.6", efforts: ["low", "medium", "high"] },
      { model: "claude-opus-5-5", name: "Opus 5.5", efforts: UP_TO_XHIGH },
      { model: "claude-opus-5", name: "Opus 5", efforts: UP_TO_XHIGH },
      { model: "claude-opus-4-8", name: "Opus 4.8", efforts: UP_TO_XHIGH },
      { model: "claude-opus-4-7", name: "Opus 4.7", efforts: UP_TO_XHIGH },
      { model: "claude-opus-4-6", name: "Opus 4.6", efforts: ["low", "medium", "high"] },
      { model: "claude-fable-5-2", name: "Fable 5.2", efforts: UP_TO_XHIGH },
      { model: "claude-fable-5-1", name: "Fable 5.1", efforts: UP_TO_XHIGH },
      { model: "claude-fable-5", name: "Fable 5", efforts: UP_TO_XHIGH },
    ])
  })

  test("skips default, opusplan, [1m] variants, unversioned and duplicate rows; another family comes last", () => {
    expect(
      claudeMenuModels([
        { value: "default", resolvedModel: "claude-opus-5-5[1m]" },
        { value: "opus", resolvedModel: "claude-opus-5-5[1M]" },
        { value: "claude-opus-5-5[1m]" },
        { value: "opusplan", resolvedModel: "claude-opus-5-5" },
        { value: "claude-mythos-1" },
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5" },
        { value: "claude-sonnet-5-5", resolvedModel: "claude-sonnet-5-5" },
        { value: "haiku" },
        { value: "claude-only-max-1", supportedEffortLevels: ["max"] },
        "not a row",
        null,
      ]).map((m) => m.model)
    ).toEqual(["claude-sonnet-5-5", "claude-mythos-1"])
  })

  test("versioned rows without aliases are listed as they are; with none, the committed list applies", () => {
    expect(claudeMenuModels([{ value: "claude-opus-4-8" }]).map((m) => m.model)).toEqual(["claude-opus-4-8"])
    expect(claudeMenuModels([{ value: "sonnet" }]).map((m) => m.model)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-2",
    ])
  })
})

// A run's fresh read (2026-11-16): only the tool's own rows count
// as observed; the committed fallback never does.
describe("claudeOfferedFromHandshake", () => {
  test("versioned rows from the tool: observed, membership only", () => {
    expect(
      claudeOfferedFromHandshake([
        { value: "sonnet", resolvedModel: "claude-sonnet-5-5", supportedEffortLevels: ["low", "high", "max"] },
        { value: "claude-opus-4-8" },
      ])
    ).toEqual({
      observed: true,
      models: [
        { model: "claude-sonnet-5-5", efforts: ["low", "high"] },
        { model: "claude-opus-4-8", efforts: ["low", "medium", "high"] },
      ],
    })
  })

  test("a listed model whose efforts are all above the ceiling stays, with no efforts", () => {
    expect(
      claudeOfferedFromHandshake([{ value: "claude-sonnet-5-5", supportedEffortLevels: ["max"] }])
    ).toEqual({ observed: true, models: [{ model: "claude-sonnet-5-5", efforts: [] }] })
  })

  test("no versioned row (an older Claude Code): the committed list, not observed", () => {
    const offered = claudeOfferedFromHandshake([{ value: "sonnet" }, { value: "default" }])
    expect(offered.observed).toBe(false)
    expect(offered.models.map((m) => m.model)).toEqual([
      "claude-haiku-5-5",
      "claude-sonnet-5-5",
      "claude-opus-5-5",
      "claude-fable-5-2",
    ])
  })
})

const signIn = (status: ClaudeSignIn["status"], authMethod: string | null = "claude.ai", extra: Partial<ClaudeSignIn> = {}): ClaudeSignIn => ({
  status,
  loggedIn: status === "signed-out" ? false : authMethod === null ? null : true,
  authMethod,
  envKey: false,
  ...extra,
})
const PLAN = signIn("plan")
const SIGNED_OUT = signIn("signed-out", "none")

describe("the Fable rule", () => {
  test.each([
    ["Claude Max", "eligible"],
    ["Claude Ultra", "eligible"],
    ["max", "eligible"],
    ["ULTRA", "eligible"],
    [" claude ultra ", "eligible"],
    ["Claude Pro", "insufficient"],
    ["pro", "insufficient"],
    ["team", "insufficient"],
    ["Claude Team", "insufficient"],
    [null, "unknown"],
    [undefined, "unknown"],
    ["", "unknown"],
    [42, "unknown"],
  ])("subscriptionType %j is %s", (value, state) => {
    expect(claudePlanState(value)).toBe(state)
  })

  // Settings › AI names the plan from a closed list only, never the raw string.
  test.each([
    ["Claude Max", "max"], [" claude ultra ", "ultra"], ["Claude Pro", "pro"], ["TEAM", "team"], ["Claude Enterprise", "enterprise"],
    ["Claude Free", undefined], ["<b>max</b>", undefined], ["", undefined], [null, undefined], [42, undefined],
  ])("subscriptionType %j is named %s", (value, name) => {
    expect(claudePlanName(value)).toBe(name)
  })

  const NOW = 10_000_000
  const auth = (state: ClaudePlanState, ageMs: number, who: ClaudeSignIn = PLAN, planRevision = 2): ClaudeAuthRecord => ({
    revision: 2,
    signIn: who,
    plan: { state, fetchedAt: NOW - ageMs, revision: planRevision },
  })
  test.each([
    ["a fresh Max or Ultra plan", auth("eligible", 0), true],
    ["a Max plan read 59 minutes ago", auth("eligible", 59 * 60_000), true],
    ["Claude Code using an API key (API rates, no plan applies)", auth("unknown", 0, signIn("api-key", null, { envKey: true })), true],
    ["Pro", auth("insufficient", 0), false],
    ["an unknown plan (null on Max: claude-code#105649)", auth("unknown", 0), false],
    ["a Max plan read 1 hour ago", auth("eligible", 60 * 60_000), false],
    ["a Max plan read in the future", auth("eligible", -1), false],
    ["a Max plan of an earlier revision", auth("eligible", 0, PLAN, 1), false],
    ["an invalid timestamp", { ...auth("eligible", 0), plan: { state: "eligible" as const, fetchedAt: Number.NaN, revision: 2 } }, false],
    ["no plan", { revision: 2, signIn: PLAN }, false],
    ["no record", undefined, false],
  ])("%s: %s", (_label, record, allowed) => {
    expect(isClaudeFableAllowed(record, NOW)).toBe(allowed)
  })
})

// Guards for three defect classes (review 1c3 round 1): an obsolete read
// restoring a revoked plan; lost updates between two loaders on one mirror;
// a lossy sign-in comparison. Real loaders, fake clock, fake reads, temp dir.
describe("the Claude Code list in the loader", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const handshake = (subscriptionType: unknown): ClaudeCodeHandshake => ({ models: WALK_ROWS, subscriptionType })
  /** A read the test finishes by hand. */
  function deferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (error: Error) => void
    const promise = new Promise<T>((ok, fail) => ((resolve = ok), (reject = fail)))
    return { promise, resolve, reject }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "formulacms-local-models-"))
    roots.push(root)
    let clock = 1_000_000
    const make = (
      readClaude: () => Promise<ClaudeCodeHandshake> = async () => handshake("Claude Ultra"),
      readCodex: () => Promise<ObservedCodexCatalog> = async () => CATALOG
    ) => createLocalToolModelsLoader({ readCodex, readClaude, now: () => clock, root: () => root, identity: noTool })
    return { root, make, tick: (ms: number) => (clock += ms) }
  }
  const fable = (models: ReturnType<typeof builtInLocalToolModels>) =>
    models.claude.models.filter((m) => m.model.startsWith("claude-fable-"))
  const greyed = (models: ReturnType<typeof builtInLocalToolModels>) =>
    fable(models).length > 0 && fable(models).every((m) => m.unavailable === "needsMaxOrUltra")
  const selectable = (models: ReturnType<typeof builtInLocalToolModels>) =>
    fable(models).length > 0 && fable(models).every((m) => m.unavailable === undefined)

  test("the committed list greys Fable: no plan is known", () => {
    expect(fable(builtInLocalToolModels()).map((m) => m.model)).toEqual(["claude-fable-5-2"])
    expect(greyed(builtInLocalToolModels())).toBe(true)
  })

  test.each([
    ["Claude Ultra", PLAN, true],
    ["Claude Max", PLAN, true],
    ["Claude Pro", PLAN, false],
    [null, PLAN, false],
    [undefined, signIn("unknown", "other"), false],
    [null, signIn("api-key", "api_key"), true],
    [null, signIn("api-key", null, { envKey: true }), true],
  ] as const)("plan %j with sign-in %j: Fable selectable %s, in the menu and on Save", async (type, who, allowed) => {
    const { make } = setup()
    const loader = make(async () => handshake(type))
    const models = await loader.load({ claude: who })
    expect(models.claude.source).toBe("installed")
    expect(models.claude.models).toHaveLength(13)
    expect(fable(models).map((m) => m.model)).toEqual(["claude-fable-5-2", "claude-fable-5-1", "claude-fable-5"])
    expect(allowed ? selectable(models) : greyed(models)).toBe(true)
    expect(selectable(make().peek())).toBe(allowed)
    const save = () => assertOfferedLocalToolChoices({ help: { engine: "claude", model: "claude-fable-5-2", effort: "high" } }, loader.peek())
    if (allowed) expect(save).not.toThrow()
    else expect(save).toThrow(/needs a Max or Ultra plan/)
  })

  test("a stale plan greys Fable; a failed refresh keeps the original timestamp; no identity is stored", async () => {
    const { make, root, tick } = setup()
    const readClaude = vi.fn<() => Promise<ClaudeCodeHandshake>>().mockResolvedValueOnce(handshake("Claude Max")).mockRejectedValue(new Error("timeout"))
    const loader = make(readClaude)
    expect(selectable(await loader.load({ claude: PLAN }))).toBe(true)
    tick(61 * 60_000)
    const stale = await loader.load({ claude: PLAN })
    expect(readClaude).toHaveBeenCalledTimes(2)
    expect(stale.claude.source).toBe("installed") // The stale list still shows…
    expect(greyed(stale)).toBe(true) // …but its plan no longer allows Fable.
    const mirror = JSON.parse(readFileSync(join(root, LOCAL_TOOL_MODELS_RELATIVE_PATH), "utf8"))
    expect(mirror.claudeAuth).toEqual({ revision: 2, signIn: PLAN, plan: { state: "eligible", name: "max", fetchedAt: 1_000_000, revision: 2 } })
    expect(JSON.stringify(mirror)).not.toMatch(/email|organization|configDirectory/u)
  })

  test("the plan's name comes with a current plan only: fresh, then stale, then unknown", async () => {
    const { make, tick } = setup()
    const readClaude = vi.fn<() => Promise<ClaudeCodeHandshake>>().mockResolvedValueOnce(handshake("Claude Pro")).mockRejectedValue(new Error("timeout"))
    const loader = make(readClaude)
    expect((await loader.load({ claude: PLAN })).claude.plan).toBe("pro")
    expect(make().peek().claude.plan).toBe("pro") // Read back from the mirror.
    tick(61 * 60_000)
    expect((await loader.load({ claude: PLAN })).claude).not.toHaveProperty("plan")
    const unnamed = setup().make(async () => handshake(null))
    expect((await unnamed.load({ claude: PLAN })).claude).not.toHaveProperty("plan")
  })

  test("P2: a raw sign-in change the displayed status hides (oauth_token → claude.ai) drops the plan; the same values keep it", async () => {
    const { make } = setup()
    const readClaude = vi.fn<() => Promise<ClaudeCodeHandshake>>().mockResolvedValueOnce(handshake("Claude Ultra")).mockRejectedValue(new Error("timeout"))
    const loader = make(readClaude)
    await loader.load({ claude: signIn("plan", "oauth_token") })
    await loader.load({ claude: signIn("plan", "oauth_token") })
    expect(readClaude).toHaveBeenCalledTimes(1)
    expect(selectable(make().peek())).toBe(true)
    expect(greyed(await loader.load({ claude: signIn("plan", "claude.ai") }))).toBe(true)
    expect(selectable(make().peek())).toBe(false)
  })

  test("P1: a read that started before a sign-out never restores the plan (warm cache)", async () => {
    const { make, tick } = setup()
    const late = deferred<ClaudeCodeHandshake>()
    const readClaude = vi.fn<() => Promise<ClaudeCodeHandshake>>().mockResolvedValueOnce(handshake("Claude Ultra")).mockReturnValueOnce(late.promise)
    const loader = make(readClaude)
    await loader.load({ claude: PLAN })
    tick(61 * 60_000) // The plan needs a new read; it starts, then the owner signs out.
    const refreshing = loader.load({ claude: PLAN })
    await flush()
    await loader.load({ claude: SIGNED_OUT })
    late.resolve(handshake("Claude Ultra"))
    await refreshing
    expect(readClaude).toHaveBeenCalledTimes(2)
    expect(selectable(make().peek())).toBe(false)
    expect(selectable(loader.peek())).toBe(false)
  })

  test("P1: cold cache, and plan → signed-out → plan: the first read is discarded; a fresh read recovers", async () => {
    const { make } = setup()
    const first = deferred<ClaudeCodeHandshake>()
    const second = deferred<ClaudeCodeHandshake>()
    const readClaude = vi.fn<() => Promise<ClaudeCodeHandshake>>().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = make(readClaude)
    const b = make(vi.fn())
    const loadA = a.load({ claude: PLAN })
    await flush()
    await b.load({ claude: SIGNED_OUT }) // Another loader observes the sign-out.
    const loadA2 = a.load({ claude: PLAN }) // Back to the same sign-in: a new revision, a new read.
    await flush()
    first.resolve(handshake("Claude Ultra"))
    await loadA
    expect(selectable(make().peek())).toBe(false)
    second.resolve(handshake("Claude Ultra"))
    await loadA2
    expect(readClaude).toHaveBeenCalledTimes(2)
    expect(selectable(make().peek())).toBe(true)
  })

  test("P1: a Codex refresh in one loader keeps another loader's Claude revocation", async () => {
    const { make, tick } = setup()
    const codex = deferred<ObservedCodexCatalog>()
    const readCodex = vi.fn<() => Promise<ObservedCodexCatalog>>().mockResolvedValueOnce(CATALOG).mockReturnValueOnce(codex.promise)
    const a = make(async () => handshake("Claude Ultra"), readCodex)
    await a.load({ codex: "plan" })
    tick(61 * 60_000) // The Codex list is now stale; the Claude plan is read fresh.
    await a.load({ claude: PLAN })
    expect(selectable(a.peek())).toBe(true)
    const codexRefresh = a.load({ codex: "plan" })
    await flush()
    const b = make(vi.fn())
    await b.load({ claude: SIGNED_OUT })
    codex.resolve({ data: [row("gpt-6.1-sol")] })
    await codexRefresh
    for (const loader of [a, b, make()]) expect(selectable(loader.peek())).toBe(false)
    expect(make().peek().codex.models.map((m) => m.model)).toEqual(["gpt-6.1-sol"])
  })

  test("overlapping reads of one tool in two loaders: the older result never overwrites the newer", async () => {
    const { make } = setup()
    const slowClaude = deferred<ClaudeCodeHandshake>()
    const slowCodex = deferred<ObservedCodexCatalog>()
    const a = make(() => slowClaude.promise, () => slowCodex.promise)
    const b = make(async () => handshake("Claude Pro"), async () => ({ data: [row("gpt-6-luna")] }))
    const loadA = a.load({ claude: PLAN, codex: "plan" })
    await flush()
    await b.load({ claude: PLAN, codex: "plan" })
    slowClaude.resolve(handshake("Claude Ultra"))
    slowCodex.resolve({ data: [row("gpt-6.1-sol")] })
    await loadA
    const reader = make()
    expect(selectable(reader.peek())).toBe(false) // B's Pro stands.
    expect(reader.peek().codex.models.map((m) => m.model)).toEqual(["gpt-6-luna"])
  })

  // Class guard: every order of three events across two loaders. After the
  // latest observed revocation, no loader's menu offers Fable.
  const EVENTS = ["claude read ends", "sign-out observed", "other loader's Codex read ends"] as const
  const orders = (items: readonly string[]): string[][] =>
    items.length <= 1 ? [[...items]] : items.flatMap((item, i) => orders(items.filter((_, j) => j !== i)).map((rest) => [item, ...rest]))
  test.each(orders(EVENTS).map((order) => [order.join(" → "), order] as const))("%s: Fable stays refused", async (_label, order) => {
    const { make } = setup()
    const claude = deferred<ClaudeCodeHandshake>()
    const codex = deferred<ObservedCodexCatalog>()
    const a = make(() => claude.promise)
    const b = make(vi.fn(), () => codex.promise)
    const pending = [a.load({ claude: PLAN }), b.load({ codex: "plan" })]
    await flush()
    for (const event of order) {
      if (event === "claude read ends") claude.resolve(handshake("Claude Ultra"))
      else if (event === "sign-out observed") pending.push(b.load({ claude: SIGNED_OUT }))
      else codex.resolve(CATALOG)
      await flush()
    }
    await Promise.all(pending)
    for (const loader of [a, b, make()]) {
      expect(selectable(loader.peek())).toBe(false)
      expect(greyed(loader.peek())).toBe(true)
    }
  })

  test("an old plan record (a sign-in string, no revision) and a future plan time count as unknown", () => {
    const { root, make } = setup()
    const path = join(root, LOCAL_TOOL_MODELS_RELATIVE_PATH)
    mkdirSync(dirname(path), { recursive: true })
    const claude = { fetchedAt: 1_000_000, models: [{ model: "claude-fable-5-2", name: "Fable 5.2", efforts: ["high"] }] }
    const write = (body: object) => writeFileSync(path, JSON.stringify({ version: 1, claude, ...body }), "utf8")
    write({ claude: { ...claude, plan: { state: "eligible", fetchedAt: 1_000_000, signIn: "plan" } } })
    expect(selectable(make().peek())).toBe(false)
    write({ claudeAuth: { revision: 1, signIn: PLAN, plan: { state: "eligible", fetchedAt: 1_000_001, revision: 1 } } })
    expect(selectable(make().peek())).toBe(false)
    write({ claudeAuth: { revision: 1, signIn: { ...PLAN, email: "x" }, plan: { state: "eligible", fetchedAt: 1_000_000, revision: 1 } } })
    expect(selectable(make().peek())).toBe(true) // Extra keys are dropped, not stored.
    write({ claudeAuth: { revision: 1, signIn: "plan", plan: { state: "eligible", fetchedAt: 1_000_000, revision: 1 } } })
    expect(selectable(make().peek())).toBe(false)
    write({ claudeAuth: { revision: 1, signIn: PLAN, plan: { state: "eligible", fetchedAt: 1_000_000, revision: 1 } } })
    expect(selectable(make().peek())).toBe(true)
  })

  test("a run's list is membership only: no plan and no greyed mark, whatever the cached plan says", async () => {
    for (const type of ["Claude Ultra", "Claude Pro"]) {
      const { make } = setup()
      await make(async () => handshake(type)).load({ claude: PLAN })
      const offered = make().peekClaude()
      expect(Object.keys(offered)).toEqual(["models"])
      expect(offered.models.map((m) => m.model)).toContain("claude-fable-5-2")
      for (const row of offered.models) expect(Object.keys(row)).toEqual(["model", "efforts"])
    }
  })

  test("loads that run at the same time share one Claude read; a Claude read keeps the Codex list", async () => {
    const { make } = setup()
    const read = deferred<ClaudeCodeHandshake>()
    const readClaude = vi.fn(() => read.promise)
    const readCodex = vi.fn(async () => CATALOG)
    const loader = make(readClaude, readCodex)
    await loader.load({ codex: "plan" })
    const both = Promise.all([loader.load({ claude: PLAN }), loader.load({ claude: PLAN })])
    await flush()
    read.resolve(handshake("Claude Ultra"))
    const [x, y] = await both
    expect(readClaude).toHaveBeenCalledTimes(1)
    expect(x).toEqual(y)
    expect(make().peek().codex.source).toBe("installed")
    expect(readCodex).toHaveBeenCalledTimes(1)
  })

  test("an older read that ends never clears the newer one: a load during the newer read shares it", async () => {
    const { make } = setup()
    const older = deferred<ClaudeCodeHandshake>()
    const newer = deferred<ClaudeCodeHandshake>()
    const readClaude = vi.fn<() => Promise<ClaudeCodeHandshake>>().mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise).mockResolvedValue(handshake("Claude Pro"))
    const loader = make(readClaude)
    const first = loader.load({ claude: PLAN })
    await flush()
    const OTHER = signIn("plan", "oauth_token")
    const second = loader.load({ claude: OTHER }) // A sign-in change: a new revision, a new read.
    await flush()
    older.resolve(handshake("Claude Pro"))
    await first
    const third = loader.load({ claude: OTHER }) // Same revision as the newer read: it shares it.
    await flush()
    expect(readClaude).toHaveBeenCalledTimes(2)
    newer.resolve(handshake("Claude Ultra"))
    await Promise.all([second, third])
    expect(selectable(make().peek())).toBe(true)
  })
})

// Item 11 (AI-SETTINGS-BUGS): an upgraded or newly installed tool shows its own
// list on the next page load. Fake identities, fake reads, fake clock, temp dir.
describe("a changed installed tool", () => {
  const roots: string[] = []
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  })
  const OLD: ObservedCodexCatalog = { data: [row("gpt-6-luna"), row("gpt-6.1-sol")] }
  const NEW: ObservedCodexCatalog = { data: [row("gpt-6.1-sol"), row("gpt-6.2-nova", { displayName: "GPT-6.2-Nova" })] }
  const handshake = (subscriptionType: unknown, rows: ClaudeCodeHandshake["models"] = WALK_ROWS): ClaudeCodeHandshake => ({ models: rows, subscriptionType })
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  const setup = () => {
    const root = mkdtempSync(join(tmpdir(), "formulacms-local-models-"))
    roots.push(root)
    let clock = 1_000_000
    const tools: { claude?: string; codex?: string } = { claude: "claude-1", codex: "codex-1" }
    const identity = vi.fn((tool: "claude" | "codex") => tools[tool])
    const make = (
      readCodex: () => Promise<ObservedCodexCatalog> = async () => OLD,
      readClaude: () => Promise<ClaudeCodeHandshake> = async () => handshake("Claude Max")
    ) => createLocalToolModelsLoader({ readCodex, readClaude, now: () => clock, root: () => root, identity })
    const mirror = () => JSON.parse(readFileSync(join(root, LOCAL_TOOL_MODELS_RELATIVE_PATH), "utf8"))
    return { root, tools, identity, make, mirror, tick: (ms: number) => (clock += ms), now: () => clock }
  }
  const ids = (models: ReturnType<typeof builtInLocalToolModels>) => models.codex.models.map((m) => m.model)
  const both = { codex: "plan", claude: PLAN } as const
  const fableSelectable = (models: ReturnType<typeof builtInLocalToolModels>) =>
    models.claude.models.filter((m) => m.model.startsWith("claude-fable-")).every((m) => m.unavailable === undefined)

  test("a fresh list from the same installed tool is not read again", async () => {
    const readCodex = vi.fn(async () => OLD)
    const readClaude = vi.fn(async () => handshake("Claude Max"))
    const { make, tick } = setup()
    const loader = make(readCodex, readClaude)
    await loader.load(both)
    tick(30 * 60_000)
    await loader.load(both)
    expect(readCodex).toHaveBeenCalledTimes(1)
    expect(readClaude).toHaveBeenCalledTimes(1)
  })

  test("a fresh list from a tool that changed since is read again on the next load, and shows the new list", async () => {
    const readCodex = vi.fn<() => Promise<ObservedCodexCatalog>>().mockResolvedValueOnce(OLD).mockResolvedValue(NEW)
    const fewer = WALK_ROWS.filter((r) => r.resolvedModel !== "claude-opus-4-6")
    const readClaude = vi.fn<() => Promise<ClaudeCodeHandshake>>().mockResolvedValueOnce(handshake("Claude Pro")).mockResolvedValue(handshake("Claude Max", fewer))
    const { make, tools, tick, mirror } = setup()
    const loader = make(readCodex, readClaude)
    const before = await loader.load(both)
    expect(ids(before)).toEqual(["gpt-6.1-sol", "gpt-6-luna"])
    expect(fableSelectable(before)).toBe(false)
    tick(60_000)
    tools.codex = "codex-2"
    tools.claude = "claude-2"
    const after = await loader.load(both)
    expect(readCodex).toHaveBeenCalledTimes(2)
    expect(readClaude).toHaveBeenCalledTimes(2)
    expect(ids(after)).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    expect(after.claude.models.map((m) => m.model)).not.toContain("claude-opus-4-6")
    // The re-read refreshes the plan as an expired-list re-read does.
    expect(fableSelectable(after)).toBe(true)
    expect(mirror()).toMatchObject({ codexTool: "codex-2", claude: { tool: "claude-2" } })
  })

  test("an installed tool that cannot be read now (undefined) keeps a fresh list", async () => {
    const readCodex = vi.fn(async () => OLD)
    const readClaude = vi.fn(async () => handshake("Claude Max"))
    const { make, tools } = setup()
    const loader = make(readCodex, readClaude)
    await loader.load(both)
    delete tools.codex
    delete tools.claude
    await loader.load(both)
    expect(readCodex).toHaveBeenCalledTimes(1)
    expect(readClaude).toHaveBeenCalledTimes(1)
  })

  test("a mirror written without the tool keeps its list until the hour ends", async () => {
    const { root, make, tick, now } = setup()
    const path = join(root, LOCAL_TOOL_MODELS_RELATIVE_PATH)
    mkdirSync(dirname(path), { recursive: true })
    const rows = [{ model: "gpt-6-luna", name: "GPT-6 Luna", efforts: ["low"] }]
    // An invalid identity value counts as absent too.
    writeFileSync(path, JSON.stringify({ version: 1, fetchedAt: now(), codex: rows, codexTool: 42 }), "utf8")
    const readCodex = vi.fn(async () => NEW)
    const loader = make(readCodex)
    expect(ids(await loader.load({ codex: "plan" }))).toEqual(["gpt-6-luna"])
    expect(readCodex).not.toHaveBeenCalled()
    tick(61 * 60_000)
    expect(ids(await loader.load({ codex: "plan" }))).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    expect(readCodex).toHaveBeenCalledTimes(1)
  })

  test("the list keeps the identity read when its read started, so a change during the read is caught next time", async () => {
    let finish!: (catalog: ObservedCodexCatalog) => void
    const readCodex = vi.fn<() => Promise<ObservedCodexCatalog>>()
      .mockImplementationOnce(() => new Promise((resolve) => (finish = resolve)))
      .mockResolvedValue(NEW)
    const { make, tools, mirror } = setup()
    const loader = make(readCodex)
    const first = loader.load({ codex: "plan" })
    await flush()
    tools.codex = "codex-2" // The tool is upgraded while the old one answers.
    finish(OLD)
    await first
    expect(mirror().codexTool).toBe("codex-1")
    expect(ids(await loader.load({ codex: "plan" }))).toEqual(["gpt-6.1-sol", "gpt-6.2-nova"])
    expect(readCodex).toHaveBeenCalledTimes(2)
    expect(mirror().codexTool).toBe("codex-2")
  })

  test("the mirror keeps codexTool and claude.tool; another loader reads them back", async () => {
    const { make, mirror, tools } = setup()
    const loaded = await make().load(both)
    expect(mirror()).toMatchObject({ version: 1, codexTool: "codex-1", claude: { tool: "claude-1" } })
    const readCodex = vi.fn(async () => NEW)
    const readClaude = vi.fn(async () => handshake("Claude Max"))
    const other = make(readCodex, readClaude)
    await expect(other.load(both)).resolves.toEqual(loaded)
    expect(readCodex).not.toHaveBeenCalled()
    expect(readClaude).not.toHaveBeenCalled()
    tools.codex = "codex-2"
    await other.load(both)
    expect(readCodex).toHaveBeenCalledTimes(1)
    expect(readClaude).not.toHaveBeenCalled()
  })

  test("a peek never reads the installed tool's identity", async () => {
    const { make, identity } = setup()
    await make().load(both)
    identity.mockClear()
    const reader = make()
    reader.peek()
    reader.peekClaude()
    expect(identity).not.toHaveBeenCalled()
  })
})

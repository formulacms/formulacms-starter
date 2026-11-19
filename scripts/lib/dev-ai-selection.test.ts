// @vitest-environment node
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, test } from "vitest"
import {
  CODEX_CLI_DEFAULT_EFFORTS,
  DEV_AI_CHOICES,
  DEV_EDITOR_TASK_PROFILE_KEYS,
  assertOfferedLocalToolChoices,
  builtInLocalToolModels,
  devAiSelectionPath,
  localToolChoicesOf,
  localToolMenus,
  parseDevAiSelection,
  parseLocalToolChoiceChanges,
  readLocalToolChoices,
  readDevAiSelection,
  resolveDevAiSelection,
  resolveDevAiTaskSelection,
  writeDevAiSelection,
  writeLocalToolChoices,
  type DevAiSelection,
  type DevAiTaskOverrides,
} from "./dev-ai-selection"
import { API_TASK_PROFILES } from "@/lib/ai/task-profiles"
import { isNotOffered } from "@/lib/ai/model-catalog"
import { codexMenuModels } from "./local-tool-models"
import {
  CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP,
  CODEX_CLI_MODELS,
  CODEX_CLI_RETIRED_MODELS,
  CODEX_CLI_SELECTABLE_EFFORTS,
  CODEX_SUBSCRIPTION_CLI_PROFILE_MAP,
  isSelectableClaudeCliTuple,
  isSelectableCodexCliEffort,
  resolveSubscriptionCliTuple,
} from "./subscription-cli-capabilities"

const roots: string[] = []

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "dev-ai-selection-"))
  roots.push(root)
  return root
}

function editorTaskMap(override: {
  engine: "claude" | "off"
}): DevAiTaskOverrides {
  const result: Record<string, { engine: "claude" | "off" }> = {}
  for (const key of DEV_EDITOR_TASK_PROFILE_KEYS) result[key] = { ...override }
  return result as DevAiTaskOverrides
}

afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true })
})

describe("parseDevAiSelection", () => {
  test("accepts every engine choice without overrides (normalized to v3)", () => {
    for (const engine of DEV_AI_CHOICES) {
      expect(parseDevAiSelection({ version: 3, engine }, "t")).toEqual({
        version: 3,
        engine,
      })
    }
  })

  test("accepts v1 input and upgrades in-memory to v3 with no per-task overrides", () => {
    // Files written under the original ADR-0032 build lane predate contentLane
    // and per-task routing. Reading one produces a v3 shape in memory; the
    // version tag is normalised so callers never see the legacy number.
    expect(
      parseDevAiSelection(
        { version: 1, engine: "claude", model: "opus", effort: "high" },
        "t"
      )
    ).toEqual({
      version: 3,
      engine: "claude",
      model: "opus",
      effort: "high",
    })
    expect(
      parseDevAiSelection({ version: 1, engine: "openrouter" }, "t")
    ).toEqual({
      version: 3,
      engine: "openrouter",
    })
  })

  test("v1 files may not carry the v2 contentLane field", () => {
    expect(() =>
      parseDevAiSelection(
        {
          version: 1,
          engine: "claude",
          model: "opus",
          effort: "high",
          contentLane: "on",
        },
        "t"
      )
    ).toThrow(/contentLane is a v2 field/)
  })

  test("v2 contentLane: on upgrades to per-task claude overrides on the editor rows", () => {
    // Byte-preserves the v2 runtime intent: with the toggle on, the editor's
    // Translate/Write button routes through claude.
    const parsed = parseDevAiSelection(
      {
        version: 2,
        engine: "claude",
        model: "opus",
        effort: "xhigh",
        contentLane: "on",
      },
      "t"
    )
    expect(parsed).toEqual({
      version: 3,
      engine: "claude",
      model: "opus",
      effort: "xhigh",
      tasks: editorTaskMap({ engine: "claude" }),
    })
    // Slice tasks stay unset — the v2 file never expressed a slice preference.
    expect(parsed.tasks).not.toHaveProperty("vision-spec")
    expect(parsed.tasks).not.toHaveProperty("renderer-jsx")
  })

  test("v2 contentLane: off upgrades to per-task engine: off on the editor rows", () => {
    // Byte-preserves the v2 runtime intent: with the toggle off, translate/
    // write falls back to Production AI. In v3 that's spelled out as an
    // explicit off override per editor task, which the callers then read as
    // "fall back to the runtime path".
    expect(
      parseDevAiSelection(
        { version: 2, engine: "openrouter", contentLane: "off" },
        "t"
      )
    ).toEqual({
      version: 3,
      engine: "openrouter",
      tasks: editorTaskMap({ engine: "off" }),
    })
  })

  test("v2 without contentLane upgrades identically to contentLane: off (implicit off)", () => {
    expect(
      parseDevAiSelection({ version: 2, engine: "anthropic" }, "t")
    ).toEqual({
      version: 3,
      engine: "anthropic",
      tasks: editorTaskMap({ engine: "off" }),
    })
  })

  test("v3 file with tasks is preserved verbatim", () => {
    const parsed = parseDevAiSelection(
      {
        version: 3,
        engine: "claude",
        model: "sonnet",
        effort: "high",
        tasks: {
          "vision-spec": { engine: "claude", model: "opus", effort: "xhigh" },
          "renderer-jsx": { engine: "codex" },
          "mechanical-translation": { engine: "off" },
        },
      },
      "t"
    )
    expect(parsed).toEqual({
      version: 3,
      engine: "claude",
      model: "sonnet",
      effort: "high",
      tasks: {
        "vision-spec": { engine: "claude", model: "opus", effort: "xhigh" },
        "renderer-jsx": { engine: "codex" },
        "mechanical-translation": { engine: "off" },
      },
    })
  })

  test("v3 rejects unknown task keys and unknown inner keys", () => {
    expect(() =>
      parseDevAiSelection(
        { version: 3, engine: "openrouter", tasks: { "unknown-profile": {} } },
        "t"
      )
    ).toThrow(/unknown task key "unknown-profile"/)
    expect(() =>
      parseDevAiSelection(
        {
          version: 3,
          engine: "openrouter",
          tasks: { "vision-spec": { engine: "codex", extra: true } },
        },
        "t"
      )
    ).toThrow(/unknown key "extra"/)
  })

  test("v3 rejects per-task tuples above the ceiling", () => {
    expect(() =>
      parseDevAiSelection(
        {
          version: 3,
          engine: "claude",
          tasks: {
            "vision-spec": { engine: "claude", model: "opus", effort: "max" },
          },
        },
        "t"
      )
    ).toThrow(/above the subscription CLI ceiling/)
  })

  test("v3 accepts a per-task codex tuple from the committed catalog", () => {
    const parsed = parseDevAiSelection(
      {
        version: 3,
        engine: "codex",
        tasks: {
          "vision-spec": {
            engine: "codex",
            model: "gpt-5.6-terra",
            effort: "medium",
          },
        },
      },
      "t"
    )
    expect(parsed.tasks?.["vision-spec"]).toEqual({
      engine: "codex",
      model: "gpt-5.6-terra",
      effort: "medium",
    })
  })

  // The file check is shape only: a model only the installed Codex lists
  // parses; saving checks the menu (assertOfferedLocalToolChoices) and the
  // run checks the installed catalog.
  test("v3 accepts xhigh and a live-only codex id, and rejects an unsafe id or an effort above the ceiling", () => {
    expect(
      parseDevAiSelection(
        {
          version: 3,
          engine: "codex",
          tasks: {
            "vision-spec": { engine: "codex", model: "gpt-9", effort: "high" },
          },
        },
        "t"
      ).tasks?.["vision-spec"]
    ).toEqual({ engine: "codex", model: "gpt-9", effort: "high" })
    expect(() =>
      parseDevAiSelection(
        {
          version: 3,
          engine: "codex",
          tasks: {
            "vision-spec": { engine: "codex", model: "gpt 9; rm -rf", effort: "high" },
          },
        },
        "t"
      )
    ).toThrow(/unsafe codex model id/)
    expect(
      parseDevAiSelection(
        {
          version: 3,
          engine: "codex",
          tasks: {
            "vision-spec": {
              engine: "codex",
              model: "gpt-5.6-sol",
              effort: "xhigh",
            },
          },
        },
        "t"
      ).tasks?.["vision-spec"]
    ).toEqual({ engine: "codex", model: "gpt-5.6-sol", effort: "xhigh" })
    expect(() =>
      parseDevAiSelection(
        {
          version: 3,
          engine: "codex",
          tasks: {
            "vision-spec": {
              engine: "codex",
              model: "gpt-5.6-sol",
              effort: "max",
            },
          },
        },
        "t"
      )
    ).toThrow(/above the Codex ceiling/)
    // Both-or-neither.
    expect(() =>
      parseDevAiSelection(
        {
          version: 3,
          engine: "codex",
          tasks: { "vision-spec": { engine: "codex", model: "gpt-5.6-sol" } },
        },
        "t"
      )
    ).toThrow(/codex override requires both model and effort/)
  })

  test("v3 rejects a task override that carries model/effort without pinning an engine", () => {
    // Without an engine, we can't validate the tuple against the engine's
    // rules — refuse rather than guess.
    expect(() =>
      parseDevAiSelection(
        {
          version: 3,
          engine: "claude",
          tasks: { "vision-spec": { model: "opus", effort: "high" } },
        },
        "t"
      )
    ).toThrow(/require the task to pin an engine/)
  })

  test("v3 collapses fully-empty task overrides", () => {
    // A `tasks: { "vision-spec": {} }` shape carries no runtime intent and
    // would just churn the file. The parser drops the entry and (when it's
    // the only one) drops the `tasks` field entirely.
    expect(
      parseDevAiSelection(
        { version: 3, engine: "openrouter", tasks: { "vision-spec": {} } },
        "t"
      )
    ).toEqual({ version: 3, engine: "openrouter" })
  })

  test("v3 files may not carry the retired contentLane field", () => {
    expect(() =>
      parseDevAiSelection(
        { version: 3, engine: "openrouter", contentLane: "off" },
        "t"
      )
    ).toThrow(/contentLane was retired in v3/)
  })

  test("rejects non-objects, unknown keys, and bad versions", () => {
    expect(() => parseDevAiSelection(null, "t")).toThrow(
      /expected a JSON object/
    )
    expect(() => parseDevAiSelection([], "t")).toThrow(/expected a JSON object/)
    expect(() =>
      parseDevAiSelection({ version: 3, engine: "claude", extra: true }, "t")
    ).toThrow(/unknown key "extra"/)
    expect(() =>
      parseDevAiSelection({ version: 4, engine: "claude" }, "t")
    ).toThrow(/unsupported version 4/)
  })

  test("rejects unknown engines and efforts loudly", () => {
    expect(() =>
      parseDevAiSelection({ version: 3, engine: "gpt5" }, "t")
    ).toThrow(/unknown engine "gpt5"/)
    expect(() =>
      parseDevAiSelection(
        { version: 3, engine: "openrouter", effort: "turbo" },
        "t"
      )
    ).toThrow(/unknown effort "turbo"/)
  })

  test("off takes no overrides; codex takes a catalog tuple", () => {
    expect(() =>
      parseDevAiSelection({ version: 3, engine: "off", model: "sonnet" }, "t")
    ).toThrow(/Off takes no model\/effort/)
    // Codex now accepts a committed model + selectable effort at the top level.
    const parsed = parseDevAiSelection(
      { version: 3, engine: "codex", model: "gpt-5.6-sol", effort: "high" },
      "t"
    )
    expect(parsed).toMatchObject({
      engine: "codex",
      model: "gpt-5.6-sol",
      effort: "high",
    })
  })

  test("claude override is both-or-neither, shape-checked, and effort-capped", () => {
    expect(
      parseDevAiSelection(
        { version: 3, engine: "claude", model: "claude-opus-5-5", effort: "xhigh" },
        "t"
      )
    ).toEqual({ version: 3, engine: "claude", model: "claude-opus-5-5", effort: "xhigh" })
    expect(
      parseDevAiSelection(
        { version: 3, engine: "claude", model: "opus", effort: "xhigh" },
        "t"
      )
    ).toEqual({ version: 3, engine: "claude", model: "opus", effort: "xhigh" })
    expect(
      parseDevAiSelection(
        { version: 3, engine: "claude", model: "haiku", effort: "high" },
        "t"
      )
    ).toEqual({ version: 3, engine: "claude", model: "haiku", effort: "high" })
    expect(() =>
      parseDevAiSelection({ version: 3, engine: "claude", model: "opus" }, "t")
    ).toThrow(/both model and effort/)
    expect(() =>
      parseDevAiSelection({ version: 3, engine: "claude", effort: "high" }, "t")
    ).toThrow(/both model and effort/)
    expect(
      parseDevAiSelection(
        { version: 3, engine: "claude", model: "fable", effort: "high" },
        "t"
      )
    ).toEqual({ version: 3, engine: "claude", model: "fable", effort: "high" })
    // Shape only: an unknown model parses, and the run refuses it.
    expect(
      parseDevAiSelection(
        { version: 3, engine: "claude", model: "mythos", effort: "high" },
        "t"
      ).model
    ).toBe("mythos")
    expect(() =>
      resolveSubscriptionCliTuple({ engine: "claude-cli", profile: "grounded-help", override: { model: "mythos", effort: "high" } })
    ).toThrow(/UNSUPPORTED_CAPABILITY: override mythos\/high is not source-verified/)
    expect(() =>
      parseDevAiSelection(
        { version: 3, engine: "claude", model: "claude/opus", effort: "high" },
        "t"
      )
    ).toThrow(/unsafe claude model id "claude\/opus"/)
    expect(() =>
      parseDevAiSelection(
        { version: 3, engine: "claude", model: "opus", effort: "max" },
        "t"
      )
    ).toThrow(/above the subscription CLI ceiling/)
    expect(
      parseDevAiSelection(
        { version: 3, engine: "claude", model: "haiku", effort: "xhigh" },
        "t"
      )
    ).toEqual({ version: 3, engine: "claude", model: "haiku", effort: "xhigh" })
  })

  test("API engines allow independent model/effort overrides", () => {
    expect(
      parseDevAiSelection(
        {
          version: 3,
          engine: "openrouter",
          model: "google/gemini-3-flash-preview",
        },
        "t"
      )
    ).toMatchObject({
      engine: "openrouter",
      model: "google/gemini-3-flash-preview",
    })
    expect(
      parseDevAiSelection(
        { version: 3, engine: "anthropic", effort: "max" },
        "t"
      )
    ).toMatchObject({ engine: "anthropic", effort: "max" })
  })
})

describe("read/write round-trip", () => {
  test("write then read returns the same selection", () => {
    const root = tempRoot()
    const selection: DevAiSelection = {
      version: 3,
      engine: "claude",
      model: "sonnet",
      effort: "high",
    }
    expect(writeDevAiSelection(selection, root)).toEqual(selection)
    expect(readDevAiSelection(root)).toEqual(selection)
  })

  test("v1 file on disk upgrades to v3 on read", () => {
    const root = tempRoot()
    mkdirSync(join(root, ".formulacms", "local"), { recursive: true })
    writeFileSync(
      devAiSelectionPath(root),
      JSON.stringify({ version: 1, engine: "openai" }),
      "utf8"
    )
    expect(readDevAiSelection(root)).toEqual({ version: 3, engine: "openai" })
  })

  test("v2 file with contentLane: on upgrades to v3 with per-task claude overrides", () => {
    const root = tempRoot()
    mkdirSync(join(root, ".formulacms", "local"), { recursive: true })
    writeFileSync(
      devAiSelectionPath(root),
      JSON.stringify({
        version: 2,
        engine: "claude",
        model: "sonnet",
        effort: "high",
        contentLane: "on",
      }),
      "utf8"
    )
    expect(readDevAiSelection(root)).toEqual({
      version: 3,
      engine: "claude",
      model: "sonnet",
      effort: "high",
      tasks: editorTaskMap({ engine: "claude" }),
    })
  })

  test("v2 file with contentLane: off upgrades to v3 with per-task off overrides", () => {
    const root = tempRoot()
    mkdirSync(join(root, ".formulacms", "local"), { recursive: true })
    writeFileSync(
      devAiSelectionPath(root),
      JSON.stringify({ version: 2, engine: "openrouter", contentLane: "off" }),
      "utf8"
    )
    expect(readDevAiSelection(root)).toEqual({
      version: 3,
      engine: "openrouter",
      tasks: editorTaskMap({ engine: "off" }),
    })
  })

  test("write persists v3 tasks and reads them back verbatim", () => {
    const root = tempRoot()
    const selection: DevAiSelection = {
      version: 3,
      engine: "claude",
      model: "opus",
      effort: "xhigh",
      tasks: {
        "vision-spec": { engine: "claude", model: "opus", effort: "xhigh" },
        "mechanical-translation": { engine: "off" },
      },
    }
    expect(writeDevAiSelection(selection, root)).toEqual(selection)
    expect(readDevAiSelection(root)).toEqual(selection)
  })

  test("the old .nextcms folder is read and written in place", () => {
    const root = tempRoot()
    mkdirSync(join(root, ".nextcms"), { recursive: true })
    writeFileSync(
      join(root, ".nextcms", "dev-ai.json"),
      JSON.stringify({ version: 3, engine: "openai" }),
      "utf8"
    )
    expect(readDevAiSelection(root)).toEqual({ version: 3, engine: "openai" })
    writeDevAiSelection({ version: 3, engine: "claude" }, root)
    expect(
      JSON.parse(readFileSync(join(root, ".nextcms", "dev-ai.json"), "utf8"))
    ).toEqual({ version: 3, engine: "claude" })
    expect(existsSync(join(root, ".formulacms", "local"))).toBe(false)
  })

  test("a saved Off survives the folder moving between lookup and read", () => {
    const root = tempRoot()
    mkdirSync(join(root, ".nextcms"), { recursive: true })
    writeFileSync(
      join(root, ".nextcms", "dev-ai.json"),
      JSON.stringify({ version: 3, engine: "off" }),
      "utf8"
    )
    let moved = false
    const persisted = readDevAiSelection(root, (path) => {
      // The server start moves the folder after the CLI looked it up.
      if (!moved) {
        moved = true
        mkdirSync(join(root, ".formulacms"))
        renameSync(join(root, ".nextcms"), join(root, ".formulacms", "local"))
      }
      return readFileSync(path, "utf8")
    })
    expect(persisted).toEqual({ version: 3, engine: "off" })
    expect(() => resolveDevAiSelection({ persisted, env: "" })).toThrow(
      /Development AI is Off/
    )
  })

  test("absent file reads as null", () => {
    expect(readDevAiSelection(tempRoot())).toBeNull()
  })

  test("malformed JSON and invalid content throw with the file path", () => {
    const root = tempRoot()
    mkdirSync(join(root, ".formulacms", "local"), { recursive: true })
    writeFileSync(devAiSelectionPath(root), "{not json", "utf8")
    expect(() => readDevAiSelection(root)).toThrow(/dev-ai\.json/)
    writeFileSync(
      devAiSelectionPath(root),
      JSON.stringify({ version: 3, engine: "bogus" }),
      "utf8"
    )
    expect(() => readDevAiSelection(root)).toThrow(/unknown engine "bogus"/)
  })

  test("write validates before touching disk", () => {
    const root = tempRoot()
    expect(() =>
      writeDevAiSelection({ version: 3, engine: "claude", model: "opus" }, root)
    ).toThrow(/both model and effort/)
    expect(readDevAiSelection(root)).toBeNull()
  })

  test("written file is stable JSON ending in a newline", () => {
    const root = tempRoot()
    writeDevAiSelection({ version: 3, engine: "openai" }, root)
    const text = readFileSync(devAiSelectionPath(root), "utf8")
    expect(text.endsWith("\n")).toBe(true)
    expect(JSON.parse(text)).toEqual({ version: 3, engine: "openai" })
  })
})

describe("resolveDevAiSelection precedence", () => {
  const persistedClaude: DevAiSelection = {
    version: 3,
    engine: "claude",
    model: "opus",
    effort: "high",
  }

  test("reads the formulacms engine first and falls back to the legacy name", () => {
    const current = process.env.FORMULACMS_DEV_AI_ENGINE
    const legacy = process.env.NEXTCMS_DEV_AI_ENGINE
    try {
      process.env.NEXTCMS_DEV_AI_ENGINE = "claude"
      process.env.FORMULACMS_DEV_AI_ENGINE = "codex"
      expect(resolveDevAiSelection({ persisted: null })).toMatchObject({
        engineId: "codex",
        source: "env",
      })

      process.env.FORMULACMS_DEV_AI_ENGINE = ""
      expect(resolveDevAiSelection({ persisted: null })).toMatchObject({
        engineId: "claude",
        source: "env",
      })
    } finally {
      if (current === undefined) delete process.env.FORMULACMS_DEV_AI_ENGINE
      else process.env.FORMULACMS_DEV_AI_ENGINE = current
      if (legacy === undefined) delete process.env.NEXTCMS_DEV_AI_ENGINE
      else process.env.NEXTCMS_DEV_AI_ENGINE = legacy
    }
  })

  test("flag > env > settings > default", () => {
    expect(
      resolveDevAiSelection({
        flag: "codex",
        env: "anthropic",
        persisted: persistedClaude,
      })
    ).toMatchObject({ engineId: "codex", source: "flag" })
    expect(
      resolveDevAiSelection({ env: "anthropic", persisted: persistedClaude })
    ).toMatchObject({ engineId: "anthropic", source: "env" })
    expect(
      resolveDevAiSelection({ env: "", persisted: persistedClaude })
    ).toEqual({
      engineId: "claude",
      model: "opus",
      effort: "high",
      source: "settings",
    })
    expect(resolveDevAiSelection({ env: "", persisted: null })).toEqual({
      engineId: "openrouter",
      source: "default",
    })
  })

  test("reads the settings file from root when persisted is not injected", () => {
    const root = tempRoot()
    writeDevAiSelection({ version: 3, engine: "openai" }, root)
    expect(resolveDevAiSelection({ root, env: "" })).toEqual({
      engineId: "openai",
      source: "settings",
    })
  })

  test("off fails closed with an actionable message, never a fallback", () => {
    const off: DevAiSelection = { version: 3, engine: "off" }
    expect(() => resolveDevAiSelection({ env: "", persisted: off })).toThrow(
      /Development AI is Off .*Pass --engine/
    )
  })

  test("an explicit flag or env overrides off", () => {
    const off: DevAiSelection = { version: 3, engine: "off" }
    expect(
      resolveDevAiSelection({ flag: "openrouter", persisted: off })
    ).toMatchObject({
      engineId: "openrouter",
      source: "flag",
    })
    expect(
      resolveDevAiSelection({ env: "claude", persisted: off })
    ).toMatchObject({
      engineId: "claude",
      source: "env",
    })
  })

  test("persisted model/effort never leak onto a flag- or env-chosen engine", () => {
    const resolved = resolveDevAiSelection({
      flag: "claude",
      persisted: {
        version: 3,
        engine: "anthropic",
        model: "x",
        effort: "high",
      },
    })
    expect(resolved).toEqual({ engineId: "claude", source: "flag" })
    const viaEnv = resolveDevAiSelection({
      env: "openai",
      persisted: persistedClaude,
    })
    expect(viaEnv).toEqual({ engineId: "openai", source: "env" })
  })

  test("override flags replace the persisted tuple wholesale", () => {
    const resolved = resolveDevAiSelection({
      env: "",
      flagModel: "sonnet",
      flagEffort: "low",
      persisted: persistedClaude,
    })
    expect(resolved).toEqual({
      engineId: "claude",
      model: "sonnet",
      effort: "low",
      source: "settings",
    })
    const partial = resolveDevAiSelection({
      env: "",
      flagModel: "sonnet",
      persisted: persistedClaude,
    })
    expect(partial).toEqual({
      engineId: "claude",
      model: "sonnet",
      source: "settings",
    })
  })

  test("unknown flag or env values still fail loudly", () => {
    expect(() =>
      resolveDevAiSelection({ flag: "gpt5", persisted: null })
    ).toThrow(/Unknown AI engine/)
    expect(() =>
      resolveDevAiSelection({ env: "bogus", persisted: null })
    ).toThrow(/Unknown AI engine/)
  })

  test("per-task override for a matching profile takes over the file resolution", () => {
    const persisted: DevAiSelection = {
      version: 3,
      engine: "openrouter",
      tasks: {
        "vision-spec": { engine: "claude", model: "opus", effort: "xhigh" },
      },
    }
    // Without a profile, the top-level engine wins.
    expect(resolveDevAiSelection({ env: "", persisted })).toEqual({
      engineId: "openrouter",
      source: "settings",
    })
    // With the profile, the per-task override composes onto the settings tuple.
    expect(
      resolveDevAiSelection({ env: "", persisted, profile: "vision-spec" })
    ).toEqual({
      engineId: "claude",
      model: "opus",
      effort: "xhigh",
      source: "settings",
    })
  })

  test("per-task override with matching engine inherits the top-level tuple", () => {
    const persisted: DevAiSelection = {
      version: 3,
      engine: "claude",
      model: "sonnet",
      effort: "high",
      tasks: {
        // engine unspecified — inherits from top-level.
        "renderer-jsx": {},
      },
    }
    // Empty override is collapsed by the parser, so build one that IS
    // meaningful even though the effort tracks the top-level.
    const withOverride: DevAiSelection = {
      ...persisted,
      tasks: {
        "renderer-jsx": { engine: "claude", model: "opus", effort: "high" },
      },
    }
    expect(
      resolveDevAiSelection({
        env: "",
        persisted: withOverride,
        profile: "renderer-jsx",
      })
    ).toEqual({
      engineId: "claude",
      model: "opus",
      effort: "high",
      source: "settings",
    })
  })

  test("per-task engine: off on a profile still throws the same off message", () => {
    const persisted: DevAiSelection = {
      version: 3,
      engine: "claude",
      model: "sonnet",
      effort: "high",
      tasks: {
        "mechanical-translation": { engine: "off" },
      },
    }
    expect(() =>
      resolveDevAiSelection({
        env: "",
        persisted,
        profile: "mechanical-translation",
      })
    ).toThrow(/Development AI is Off/)
  })
})

describe("resolveDevAiTaskSelection", () => {
  const persisted: DevAiSelection = {
    version: 3,
    engine: "openrouter",
    tasks: {
      "vision-spec": { engine: "claude", model: "opus", effort: "xhigh" },
      "mechanical-translation": { engine: "off" },
    },
  }

  test("null file resolves to the openrouter default (matches resolveDevAiSelection)", () => {
    expect(resolveDevAiTaskSelection(null, "vision-spec")).toEqual({
      engine: "openrouter",
    })
  })

  test("returns off (never throws) so editor callers can fall back to Production AI", () => {
    expect(
      resolveDevAiTaskSelection(persisted, "mechanical-translation")
    ).toEqual({ engine: "off" })
  })

  test("returns the composed per-task tuple when the task overrides the engine", () => {
    expect(resolveDevAiTaskSelection(persisted, "vision-spec")).toEqual({
      engine: "claude",
      model: "opus",
      effort: "xhigh",
    })
  })

  test("with no per-task override, returns the top-level tuple", () => {
    expect(resolveDevAiTaskSelection(persisted, "brand-translation")).toEqual({
      engine: "openrouter",
    })
  })

  test("threads a brand-translation override's model+effort through — the tunable Translation row actually reaches execution", () => {
    // The honesty linchpin: `translateFieldDev` resolves `brand-translation`, so
    // the model+effort the Settings Translation row saves under that key must
    // survive resolution and reach the Claude CLI, not be silently dropped.
    const claude: DevAiSelection = {
      version: 3,
      engine: "claude",
      tasks: {
        "brand-translation": {
          engine: "claude",
          model: "opus",
          effort: "high",
        },
      },
    }
    expect(resolveDevAiTaskSelection(claude, "brand-translation")).toEqual({
      engine: "claude",
      model: "opus",
      effort: "high",
    })
  })
})

describe("local tool choices (Settings › AI on localhost)", () => {
  const sonnet = { engine: "claude", model: "claude-sonnet-5-5", effort: "high" } as const
  const luna = { engine: "codex", model: "gpt-6-luna", effort: "low" } as const

  test("with no file, a choice starts from the readers' default and keeps every other task unchanged", () => {
    const root = tempRoot()
    expect(writeLocalToolChoices({ sliceCreator: sonnet }, root)).toEqual({ sliceCreator: sonnet })
    const saved = readDevAiSelection(root)!
    expect(saved).toEqual({
      version: 3,
      engine: "openrouter",
      tasks: { "vision-spec": sonnet, "renderer-jsx": sonnet },
    })
    expect(resolveDevAiTaskSelection(saved, "editorial-copy")).toEqual({ engine: "openrouter" })
    expect(resolveDevAiTaskSelection(saved, "renderer-jsx")).toEqual(sonnet)
  })

  test("writes and clears each assistant separately, leaving other keys as they were", () => {
    const root = tempRoot()
    writeDevAiSelection({ version: 3, engine: "anthropic", tasks: { "editorial-copy": { engine: "off" } } }, root)
    expect(writeLocalToolChoices({ help: luna, sliceCreator: sonnet }, root)).toEqual({ help: luna, sliceCreator: sonnet })
    expect(readLocalToolChoices(root)).toEqual({ help: luna, sliceCreator: sonnet })
    expect(writeLocalToolChoices({ help: null }, root)).toEqual({ sliceCreator: sonnet })
    expect(readDevAiSelection(root)).toEqual({
      version: 3,
      engine: "anthropic",
      tasks: { "editorial-copy": { engine: "off" }, "vision-spec": sonnet, "renderer-jsx": sonnet },
    })
    expect(writeLocalToolChoices({ sliceCreator: null }, root)).toEqual({})
    expect(readDevAiSelection(root)).toEqual({ version: 3, engine: "anthropic", tasks: { "editorial-copy": { engine: "off" } } })
  })

  test("an API engine override or a top-level tool is not a local tool choice", () => {
    expect(localToolChoicesOf(null)).toEqual({})
    expect(localToolChoicesOf({ version: 3, engine: "claude", tasks: { "grounded-help": { engine: "anthropic" } } })).toEqual({})
  })

  test.each([
    ["an unknown assistant", { blog: sonnet }],
    ["an API service as a local tool", { help: { engine: "anthropic", model: "x", effort: "low" } }],
    ["Off as a local tool", { help: { engine: "off" } }],
    ["an unsafe model id", { help: { ...sonnet, model: "sonnet 9" } }],
    ["an unsafe codex model id", { help: { ...luna, model: "../gpt-4o" } }],
    ["an effort above the ceiling", { sliceCreator: { ...luna, effort: "max" } }],
    ["a missing effort", { help: { engine: "claude", model: "sonnet" } }],
    ["an extra key", { help: { ...sonnet, apiKey: "x" } }],
    ["a list", [sonnet]],
  ])("refuses %s", (_name, raw) => {
    expect(() => parseLocalToolChoiceChanges(raw)).toThrow(/Invalid dev AI selection/)
  })

  test("accepts a valid payload and null clears", () => {
    expect(parseLocalToolChoiceChanges({ help: luna, sliceCreator: null })).toEqual({ help: luna, sliceCreator: null })
  })

  test("refuses to save over a malformed file and leaves it as it was", () => {
    const root = tempRoot()
    mkdirSync(join(root, ".formulacms", "local"), { recursive: true })
    writeFileSync(devAiSelectionPath(root), "{ not json", "utf8")
    expect(() => writeLocalToolChoices({ help: luna }, root)).toThrow(/Invalid dev AI selection/)
    expect(readFileSync(devAiSelectionPath(root), "utf8")).toBe("{ not json")
  })

  test("every menu default is a choice the file accepts", () => {
    const root = tempRoot()
    for (const [engine, menu] of Object.entries(localToolMenus()) as ["claude" | "codex", ReturnType<typeof localToolMenus>["claude"]][]) {
      for (const assistant of ["help", "sliceCreator", "writing", "translation"] as const) {
        const choice = { engine, ...menu.defaults[assistant] }
        expect(menu.models.find((m) => m.model === choice.model)?.efforts).toContain(choice.effort)
        expect(writeLocalToolChoices({ [assistant]: choice }, root)[assistant]).toEqual(choice)
      }
    }
    expect(localToolMenus().claude.defaults).toEqual({
      help: { model: "claude-haiku-5-5", effort: "low" },
      sliceCreator: { model: "claude-sonnet-5-5", effort: "high" },
      writing: { model: "claude-sonnet-5-5", effort: "medium" },
      translation: { model: "claude-sonnet-5-5", effort: "medium" },
    })
  })

  // Guard: a hard-coded local tool model that the vendor retired or that is
  // missing from the menu. Checked 2026-11-15 against
  // https://learn.chatgpt.com/codex/models (with the Codex CLI 0.169.0 bundled
  // catalog) and https://code.claude.com/docs/en/model-config.
  test("each tool offers the vendors' current models and defaults", () => {
    const xhigh = ["low", "medium", "high", "xhigh"]
    const menus = localToolMenus()
    // Owner 2026-11-15: "use full model with version"; Fable is listed but,
    // with no plan known, cannot be chosen.
    expect(menus.claude.models).toEqual([
      { model: "claude-haiku-5-5", name: "Haiku 5.5", efforts: xhigh },
      { model: "claude-sonnet-5-5", name: "Sonnet 5.5", efforts: xhigh },
      { model: "claude-opus-5-5", name: "Opus 5.5", efforts: xhigh },
      { model: "claude-fable-5-2", name: "Fable 5.2", efforts: xhigh, unavailable: "needsMaxOrUltra" },
    ])
    // Owner 2026-11-15: versioned names, and gpt-6-sol is never offered.
    // Default efforts: the real Codex 0.163.0 `model/list`, 2026-11-16.
    expect(menus.codex.models).toEqual([
      { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: xhigh, defaultEffort: "low" },
      { model: "gpt-6-astra", name: "GPT-6 Astra", efforts: xhigh, defaultEffort: "medium" },
      { model: "gpt-6.1-terra", name: "GPT-6.1 Terra", efforts: xhigh, defaultEffort: "low" },
      { model: "gpt-6-luna", name: "GPT-6 Luna", efforts: xhigh, defaultEffort: "medium" },
    ])
    expect(menus.codex.defaults).toEqual({
      help: { model: "gpt-6-luna", effort: "medium" },
      sliceCreator: { model: "gpt-6.1-sol", effort: "low" },
      writing: { model: "gpt-6.1-terra", effort: "low" },
      translation: { model: "gpt-6.1-terra", effort: "low" },
    })
    // Codex defaults mirror the OpenAI API defaults for every profile.
    for (const [profile, tuple] of Object.entries(CODEX_SUBSCRIPTION_CLI_PROFILE_MAP)) {
      const api = API_TASK_PROFILES.openai[profile as keyof typeof API_TASK_PROFILES.openai]
      expect({ profile, model: tuple.model, effort: tuple.effort }).toEqual({ profile, model: api.model, effort: api.reasoning?.kind === "effort" ? api.reasoning.effort : undefined })
    }
    // Fable is never a default (under -p it may bill usage credits without
    // asking), and in the committed list it is never selectable.
    expect(Object.values(CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP).map((t) => t.model).filter((m) => m.includes("fable"))).toEqual([])
    expect(menus.claude.models.filter((m) => m.model.includes("fable") && m.unavailable !== "needsMaxOrUltra")).toEqual([])
    // Every default is a committed row that can be chosen.
    for (const tool of ["codex", "claude"] as const)
      for (const { model } of Object.values(menus[tool].defaults))
        expect(menus[tool].models.find((m) => m.model === model && !m.unavailable), model).toBeDefined()
    for (const retired of CODEX_CLI_RETIRED_MODELS) expect(menus.codex.models.map((m) => m.model)).not.toContain(retired)
    // Every default of every profile is offered, at an effort its menu allows.
    for (const [profile, { model, effort }] of Object.entries(CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP))
      expect({ profile, model, effort, ok: isSelectableClaudeCliTuple(model, effort) }).toEqual({ profile, model, effort, ok: true })
    for (const [profile, { model, effort }] of Object.entries(CODEX_SUBSCRIPTION_CLI_PROFILE_MAP))
      expect({ profile, model, effort, ok: (CODEX_CLI_MODELS as readonly string[]).includes(model) && isSelectableCodexCliEffort(effort) }).toEqual({ profile, model, effort, ok: true })
    // Guard: no committed local default or fallback row is never offered.
    for (const tool of ["codex", "claude"] as const) {
      const committed = [...menus[tool].models.map((m) => m.model), ...Object.values(tool === "codex" ? CODEX_SUBSCRIPTION_CLI_PROFILE_MAP : CLAUDE_SUBSCRIPTION_CLI_PROFILE_MAP).map((t) => t.model)]
      expect(committed.filter((model) => isNotOffered(tool, model))).toEqual([])
    }
  })

  // Work item 3 (AI-SETTINGS-REDESIGN): a Codex default takes the effort the
  // installed Codex lists for that model; the committed effort otherwise.
  test("a Codex default starts at the installed Codex's own effort for its model", () => {
    const listed = { ...builtInLocalToolModels(), codex: { source: "installed" as const, models: [
      { model: "gpt-6.1-sol", name: "GPT-6.1 Sol", efforts: ["low", "medium", "high", "xhigh"] as const, defaultEffort: "medium" as const },
      { model: "gpt-6.1-terra", name: "GPT-6.1 Terra", efforts: ["low", "medium", "high"] as const },
    ] } }
    expect(localToolMenus(listed).codex.defaults).toEqual({
      help: { model: "gpt-6-luna", effort: "low" },
      sliceCreator: { model: "gpt-6.1-sol", effort: "medium" },
      writing: { model: "gpt-6.1-terra", effort: "low" },
      translation: { model: "gpt-6.1-terra", effort: "low" },
    })
    expect(localToolMenus(listed).claude.defaults).toEqual(localToolMenus().claude.defaults)
  })

  // AI-FOLLOW-UPS item 2: when Codex cannot list its models, the committed
  // list carries the efforts the real Codex lists, so the defaults match.
  test("the committed Codex list gives the same defaults as an installed list", () => {
    for (const model of CODEX_CLI_MODELS)
      expect(CODEX_CLI_SELECTABLE_EFFORTS, model).toContain(CODEX_CLI_DEFAULT_EFFORTS[model])
    // The same four models as the real Codex 0.163.0 `model/list` lists them.
    const listed = codexMenuModels({
      data: CODEX_CLI_MODELS.map((model) => ({
        model,
        defaultReasoningEffort: CODEX_CLI_DEFAULT_EFFORTS[model],
        supportedReasoningEfforts: CODEX_CLI_SELECTABLE_EFFORTS.map((reasoningEffort) => ({ reasoningEffort })),
        inputModalities: ["text" as const],
      })),
    })
    const builtIn = builtInLocalToolModels()
    const installed = { ...builtIn, codex: { source: "installed" as const, models: listed } }
    expect(builtIn.codex.models).toEqual(listed)
    expect(localToolMenus(builtIn).codex.defaults).toEqual(localToolMenus(installed).codex.defaults)
    // The listed effort applies to every assistant, Translation included.
    for (const [assistant, choice] of Object.entries(localToolMenus().codex.defaults))
      expect({ assistant, effort: choice.effort }).toEqual({
        assistant,
        effort: CODEX_CLI_DEFAULT_EFFORTS[choice.model as (typeof CODEX_CLI_MODELS)[number]],
      })
  })

  test("a saved Claude alias still parses, is never rewritten, and still runs", () => {
    const root = tempRoot()
    const alias = { engine: "claude", model: "sonnet", effort: "high" } as const
    mkdirSync(join(root, ".formulacms", "local"), { recursive: true })
    writeFileSync(devAiSelectionPath(root), JSON.stringify({ version: 3, engine: "openrouter", tasks: { "grounded-help": alias } }), "utf8")
    expect(readLocalToolChoices(root)).toEqual({ help: alias })
    expect(localToolMenus().claude.models.map((m) => m.model)).not.toContain("sonnet")
    expect(writeLocalToolChoices({ sliceCreator: sonnet }, root)).toEqual({ help: alias, sliceCreator: sonnet })
    expect(
      resolveSubscriptionCliTuple({ engine: "claude-cli", profile: "grounded-help", override: { model: "sonnet", effort: "high" } })
    ).toEqual({ engine: "claude-cli", model: "sonnet", effort: "high" })
  })

  test("a saved Claude fable choice still parses, stays saved, and is refused at run time without the plan", () => {
    const root = tempRoot()
    const fable = { engine: "claude", model: "fable", effort: "high" } as const
    mkdirSync(join(root, ".formulacms", "local"), { recursive: true })
    writeFileSync(devAiSelectionPath(root), JSON.stringify({ version: 3, engine: "openrouter", tasks: { "grounded-help": fable } }), "utf8")
    expect(readLocalToolChoices(root)).toEqual({ help: fable })
    expect(localToolMenus().claude.models.map((m) => m.model)).not.toContain("fable")
    expect(writeLocalToolChoices({ sliceCreator: sonnet }, root)).toEqual({ help: fable, sliceCreator: sonnet })
    expect(() =>
      resolveSubscriptionCliTuple({ engine: "claude-cli", profile: "grounded-help", override: { model: "fable", effort: "high" } })
    ).toThrow(/UNSUPPORTED_CAPABILITY: override fable\/high is not source-verified for claude-cli/)
    // The effort ceiling still applies to a saved alias.
    expect(() => parseDevAiSelection({ version: 3, engine: "claude", model: "fable", effort: "max" }, "t")).toThrow(/above the subscription CLI ceiling/)
  })

  test("saving refuses a changed choice the menu does not offer", () => {
    const row = (model: string, hidden?: boolean) => ({ model, hidden, supportedReasoningEfforts: [{ reasoningEffort: "high" as const }], inputModalities: ["text" as const] })
    const installed = {
      ...builtInLocalToolModels(),
      codex: { source: "installed" as const, models: codexMenuModels({ data: [row("gpt-6.1-sol"), row("gpt-6.2-nova"), row("gpt-6-sol"), row("gpt-secret", true)] }) },
    }
    const pick = (model: string, effort = "high") => ({ help: { engine: "codex" as const, model, effort: effort as "high" } })
    // A model only the installed Codex lists can be saved.
    expect(() => assertOfferedLocalToolChoices(pick("gpt-6.2-nova"), installed)).not.toThrow()
    for (const model of ["gpt-6-sol", "gpt-secret", "gpt-9-unlisted"])
      expect(() => assertOfferedLocalToolChoices(pick(model), installed)).toThrow(/is not offered/)
    expect(() => assertOfferedLocalToolChoices(pick("gpt-6.1-sol", "low"), installed)).toThrow(/effort "low" is not available/)
    // Claude: an alias saved before is not chosen anew; a greyed Fable row is refused.
    for (const model of ["sonnet", "fable"])
      expect(() => assertOfferedLocalToolChoices({ help: { engine: "claude", model, effort: "high" } }, installed)).toThrow(/is not offered/)
    expect(() =>
      assertOfferedLocalToolChoices({ help: { engine: "claude", model: "claude-fable-5-2", effort: "high" } }, installed)
    ).toThrow(/cannot be chosen: it needs a Max or Ultra plan/)
    expect(() => assertOfferedLocalToolChoices({ help: sonnet }, installed)).not.toThrow()
    // Removing a choice, or leaving one unchanged, is never refused.
    expect(() => assertOfferedLocalToolChoices({ help: null }, installed)).not.toThrow()
    expect(() => assertOfferedLocalToolChoices({}, installed)).not.toThrow()
  })

  test("a saved model that is no longer offered still parses, stays saved, and is refused at run time", () => {
    const root = tempRoot()
    const old = { engine: "codex", model: "gpt-5.6-sol", effort: "high" } as const
    mkdirSync(join(root, ".formulacms", "local"), { recursive: true })
    writeFileSync(
      devAiSelectionPath(root),
      JSON.stringify({ version: 3, engine: "openrouter", tasks: { "vision-spec": old, "renderer-jsx": old } }),
      "utf8"
    )
    expect(readLocalToolChoices(root)).toEqual({ sliceCreator: old })
    expect(localToolMenus().codex.models.map((m) => m.model)).not.toContain(old.model)
    // Saving another assistant never replaces it.
    expect(writeLocalToolChoices({ help: luna }, root)).toEqual({ help: luna, sliceCreator: old })
    expect(readLocalToolChoices(root)).toEqual({ help: luna, sliceCreator: old })
    // The installed catalog check refuses it when the machine no longer lists it.
    expect(() =>
      resolveSubscriptionCliTuple({
        engine: "codex-cli",
        profile: "vision-spec",
        override: { model: old.model, effort: old.effort },
        observedCodexCatalog: {
          data: [{ model: "gpt-6.1-sol", supportedReasoningEfforts: [{ reasoningEffort: "high" }], inputModalities: ["text", "image"] }],
        },
      })
    ).toThrow(/UNSUPPORTED_CAPABILITY: installed Codex catalog does not expose exact tuple gpt-5\.6-sol\/high/)
    // An id that is not a model id at all still makes the file malformed.
    writeFileSync(
      devAiSelectionPath(root),
      JSON.stringify({ version: 3, engine: "openrouter", tasks: { "vision-spec": { ...old, model: "gpt 4o" } } }),
      "utf8"
    )
    expect(() => readLocalToolChoices(root)).toThrow(/unsafe codex model id "gpt 4o"/)
  })
})

// Menu names of local-tool models (Claude Code, Codex). No imports: the
// admin bundle and the local scripts both read this file.

/** A versioned Claude id: `claude-opus-5-5`, `claude-haiku-4-5-20251001`.
 * Not `default`, `opusplan`, an alias or a `[1m]` variant. */
export const VERSIONED_CLAUDE_ID = /^claude-([a-z]+)-(\d+(?:-\d+)*)$/u

/** The version numbers of a versioned id; a trailing date is not one. */
export function claudeVersion(model: string): number[] {
  const parts = VERSIONED_CLAUDE_ID.exec(model)![2]!.split("-")
  if (parts.length > 1 && /^\d{8}$/u.test(parts.at(-1)!)) parts.pop()
  return parts.map(Number)
}

/** The menu name from the id: "Opus 5.5", "Haiku 4.5" (a date is dropped). */
export function claudeModelName(model: string): string {
  const match = VERSIONED_CLAUDE_ID.exec(model)
  if (!match) return model
  return `${match[1]![0]!.toUpperCase()}${match[1]!.slice(1)} ${claudeVersion(model).join(".")}`
}

/** Menu names of known Codex models (approved prototype, 2026-11-15); any
 * other listed model shows the installed tool's own name. */
export const CODEX_CLI_MODEL_NAMES: Readonly<Record<string, string>> =
  Object.freeze({
    "gpt-6.1-sol": "GPT-6.1 Sol",
    "gpt-6-astra": "GPT-6 Astra",
    "gpt-6.1-terra": "GPT-6.1 Terra",
    "gpt-6-luna": "GPT-6 Luna",
  })

/** The readable name of a saved local-tool model the installed tool no longer
 * lists; `undefined` when the id has no known name. */
export function localToolModelName(engine: "claude" | "codex", model: string): string | undefined {
  if (engine === "codex") return CODEX_CLI_MODEL_NAMES[model]
  const name = claudeModelName(model)
  return name === model ? undefined : name
}

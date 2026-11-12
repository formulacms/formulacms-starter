// convex/lib/help/intents.ts
// Suggested-action intent registry for the in-app help assistant (Phase 2 of
// the agentic command bar).
//
// The model answering a "how do I…" question optionally proposes ONE intent at
// the end of its answer, encoded as a trailing fenced JSON block. We parse it
// here, validate against this registry, and return a resolved
// `{ id, label, href }` the panel can render as a "do it for me" button.
//
// Why a registry + trailing JSON (not a second model call, not structured
// outputs):
//   - keeps Phase 2 to one model call per question (cost discipline)
//   - lets us drop unknown/malformed suggestions silently — the answer text is
//     still useful even if the suggestion fails to parse
//   - intent ids are a closed enum; the model cannot invent a destination
//
// Trust boundary (ADR-0013): every intent is a *navigation* into the existing
// admin surface. The help assistant never writes content or invokes another
// agent directly — it routes the owner to the screen that already owns the
// gated action. That keeps writes flowing through their established
// permission gates and avoids re-implementing orchestration in the panel.
//
// Every href below must be a screen the release 0.1 starter ships. The test
// scripts/starter/help-intents-routes.node.test.ts checks that.
//
// Server-safe: no UI / React imports, so the Convex action can import it.

/** Stable id for one suggested action. Closed enum — adding an intent means
 *  adding it here AND teaching the prompt in convex/lib/agents/registry.ts. */
export type HelpIntentId =
  | "create-page"
  | "open-pages"
  | "open-media"
  | "open-menus"
  | "open-redirects"
  | "open-trash"
  | "open-settings"
  | "open-settings-modules"
  | "open-settings-ai"
  | "open-settings-languages"
  | "open-settings-email"

export interface HelpIntent {
  id: HelpIntentId
  /** Verb-led button label shown in the panel. */
  label: string
  /** Admin route the button navigates to. Must be a screen the starter ships. */
  href: string
  /** One-line description used in the prompt so the model can pick correctly. */
  hint: string
}

/** The closed registry. Order is irrelevant; the prompt enumerates ids only. */
export const HELP_INTENTS: Record<HelpIntentId, HelpIntent> = {
  "create-page": {
    id: "create-page",
    label: "Create a new page",
    href: "/admin/pages/new",
    hint: "Owner wants to start a new page (empty page, imported .md file, or Write page with AI).",
  },
  "open-pages": {
    id: "open-pages",
    label: "Open Content",
    href: "/admin/pages",
    hint: "Owner wants to find, edit, publish, unpublish, or archive an existing page, or move an archived page to trash.",
  },
  "open-media": {
    id: "open-media",
    label: "Open Media",
    href: "/admin/media",
    hint: "Owner wants to upload, organize, or edit images.",
  },
  "open-menus": {
    id: "open-menus",
    label: "Open Menus",
    href: "/admin/menus",
    hint: "Owner wants to edit the Main navigation (header) or Footer navigation menu.",
  },
  "open-redirects": {
    id: "open-redirects",
    label: "Open Redirects",
    href: "/admin/redirects",
    hint: "Owner wants to add or manage redirects from an old address to a new one.",
  },
  "open-trash": {
    id: "open-trash",
    label: "Open Trash",
    href: "/admin/trash",
    hint: "Owner wants to restore a page that was moved to trash.",
  },
  "open-settings": {
    id: "open-settings",
    label: "Open Settings",
    href: "/admin/settings",
    hint: "Owner wants to change the site name, description, site address, contact details, logo, or other general site settings.",
  },
  "open-settings-modules": {
    id: "open-settings-modules",
    label: "Open Modules settings",
    href: "/admin/settings/modules",
    hint: "Owner wants to turn an optional module (Multilingual, Redirects, AI) on or off.",
  },
  "open-settings-ai": {
    id: "open-settings-ai",
    label: "Open AI settings",
    href: "/admin/settings/ai",
    hint: "Owner wants to check AI keys, or choose the provider, model, or instructions of an AI assistant.",
  },
  "open-settings-languages": {
    id: "open-settings-languages",
    label: "Open Languages settings",
    href: "/admin/settings/languages",
    hint: "Owner wants to add or remove a language, or change the default language.",
  },
  "open-settings-email": {
    id: "open-settings-email",
    label: "Open Email settings",
    href: "/admin/settings/email",
    hint: "Owner wants to set up email delivery for the site.",
  },
}

/** Compact enum listing for the system prompt: one line per intent, id + hint.
 *  Sorted by id so the prompt is stable across runs. */
export function intentEnumForPrompt(): string {
  return Object.values(HELP_INTENTS)
    .slice()
    .sort((a, b) => a.id.localeCompare(b.id))
    .map((i) => `- ${i.id}: ${i.hint}`)
    .join("\n")
}

export interface ResolvedSuggestedAction {
  id: HelpIntentId
  label: string
  href: string
}

/** Result of splitting a raw model answer into prose + (maybe) a suggestion. */
export interface ParsedHelpAnswer {
  answer: string
  suggestedAction?: ResolvedSuggestedAction
}

// Matches a *trailing* fenced JSON block (optionally labelled ```json) at the
// very end of the answer, allowing trailing whitespace. We only honour trailing
// blocks so a mid-answer JSON example (e.g. quoted in a how-to) is never
// mistaken for a suggestion.
const TRAILING_JSON_FENCE = /\n?\s*```(?:json)?\s*\n([\s\S]+?)\n```\s*$/i

/** Server-side narrowing: anything is a JSON value before validation. */
function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
}

/**
 * Pull a trailing ```json {…}``` block off the end of `raw`, validate it
 * against the intent registry, and return `{ answer, suggestedAction? }`.
 *
 * Drop the suggestion (but keep the answer prose) when:
 *  - there is no trailing fence
 *  - the fence body isn't valid JSON
 *  - the object lacks a string `intent`
 *  - the `intent` isn't in HELP_INTENTS
 *
 * Always returns the answer with the fence stripped, even when the suggestion
 * is dropped — so a hallucinated trailing block doesn't leak raw JSON to the
 * owner.
 */
export function parseHelpAnswer(raw: string): ParsedHelpAnswer {
  const trimmed = raw.trim()
  const match = trimmed.match(TRAILING_JSON_FENCE)
  if (!match) return { answer: trimmed }

  const fenceBody = match[1].trim()
  const answer = trimmed.slice(0, match.index).trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(fenceBody)
  } catch {
    return { answer }
  }

  if (!isRecord(parsed)) return { answer }
  const intentId = parsed.intent
  if (typeof intentId !== "string") return { answer }
  if (!(intentId in HELP_INTENTS)) return { answer }

  const intent = HELP_INTENTS[intentId as HelpIntentId]
  return {
    answer,
    suggestedAction: {
      id: intent.id,
      label: intent.label,
      href: intent.href,
    },
  }
}

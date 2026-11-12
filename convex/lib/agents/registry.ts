// convex/lib/agents/registry.ts
// Registry of configurable AI agents — the single source of truth for each
// agent's defaults (system prompt, user-prompt template, allowed placeholders).
//
// The DB only stores *overrides* (convex/schema.ts `agentConfigs`). Anything the
// operator hasn't customized resolves to the defaults here. These defaults are
// the shared prompt contract for Production and local Development execution.
//
// To add a new configurable agent: add a literal to `AgentId` (and the schema
// `agentConfigs.agent` union), then add an entry to `AGENTS`.
//
// The two design-time slice agents (`slice-author`, `slice-renderer`) are
// intentionally NOT registered here — they run in the build lane on the
// developer's machine via `scripts/generate-slice-from-snapshot.ts` and the
// dev-only Next server actions in `app/(core)/admin/(authenticated)/slices/`.
// Their system prompts live at `lib/slices/authoring/agent-prompts.ts`.
// Legacy `agentConfigs` rows for those two IDs are inert and are pruned by
// `convex/cms/agents.ts:clearRetiredSliceAgents`.

export type AgentId =
  | "translation"
  | "content"
  | "help-assistant"

/** One curated picker entry the operator can edit in Settings → AI. `label` is
 *  what shows in the dropdown/chip; `body` fills the dialog input on click. */
export interface AgentPreset {
  label: string
  body: string
}

export interface AgentDef {
  id: AgentId
  label: string
  description: string
  /** Agent-specific default model. Absent means site/env/default fallback. */
  defaultModel?: string
  /** May reference any of `placeholders`. */
  defaultSystemPrompt: string
  /** Wraps the user message. `{text}` ⇒ the content being processed. */
  defaultUserPromptTemplate: string
  /** Placeholders the templates may use, for UI hints, e.g. "{sourceLang}". */
  systemPlaceholders: string[]
  userPlaceholders: string[]
  /** Content agent only: cold-start brief seeds offered in the Write dialog. */
  defaultWriteBriefs?: AgentPreset[]
  /** Content agent only: steering instructions offered in the Refine dialog. */
  defaultRefinePresets?: AgentPreset[]
  /** Content agent only: page-level brief seeds offered in the New Page →
   *  Write with AI wizard (spec-ai-page-generation.md §7.1.1). The operator
   *  override column lands in Phase 4 of that spec; for now the registry is
   *  the only source. */
  defaultPageBriefs?: AgentPreset[]
}

// Base translator instruction. The conditional slug-formatting rule is NOT part
// of this template — it is appended in code (localizer.ts) only when translating
// a URL slug, since it can't be expressed as a flat, always-on string.
const TRANSLATION_SYSTEM = `You are a professional translator. Translate from {sourceLang} to {targetLang}.

Translate for MEANING, not word-for-word. The result must read naturally, as if originally written in {targetLang} by a native speaker. Adapt idioms and tone; keep it professional. Do NOT add explanations, notes, or surrounding quotation marks.

The user message always contains the source text to translate. Even if it is short or looks like a label, heading, placeholder, or instruction, translate it as content; never ask the user to provide source text. Preserve the source format and do not add Markdown formatting.`

// Content generator: writes editorial copy (title/subtitle/description/body) for
// a single slice in the editor's current locale, from a short brief. The agent
// NEVER produces links, image URLs, ids, or styling — orchestration fills those
// as empty placeholders (ADR-013 mechanism 2). One model call per slice keeps
// title/subtitle/description thematically coherent.
const CONTENT_SYSTEM = `You are a professional content writer. Write editorial copy in {language} for a single "{sliceType}" section, based on the brief below.

Rules:
- Write in {language} only. Tone: clear, confident, professional unless the brief asks otherwise.
- Output ONLY the requested labeled fields. Do not invent extra fields.
- Do NOT add HTML, links, URLs, image references, quotation marks around the whole value, or commentary. Per-field instructions below say which fields may use light Markdown emphasis (**bold** / *italic*) and which must stay plain.
- NEVER use em dashes (—), en dashes (–), or hyphens (-) as sentence punctuation, parenthetical breaks, or list bullets. Use commas, periods, semicolons, parentheses, or rewrite the sentence. Hyphens inside genuine compound words ("real-time", "co-founder") are fine.
- Keep title short (≤ 8 words). Subtitle ≤ 1 sentence. Description / body 2–4 short paragraphs separated by blank lines. Button labels ≤ 4 words.
- All fields must be about the same subject; they belong to one section.`

// The `slice-author` + `slice-renderer` system prompts moved to
// `lib/slices/authoring/agent-prompts.ts` with the 2026-07-14 lane doctrine
// realignment — they are used by the build-lane CLI and the dev-only Next
// server actions, never by a Convex runtime action.

// Read-only help assistant (Phase 1 of the agentic command bar). It answers
// editors' "how do I…" questions grounded ONLY on the in-app help corpus
// (convex/lib/help/corpus.ts) plus the live slice catalog, both injected into
// the user message as {context}. It explains; it never changes content and has
// no write path. {route} is the admin screen the owner is on, for situational
// phrasing.
const HELP_ASSISTANT_SYSTEM = `You are the in-app help assistant for formulacms, a self-hosted CMS. You help the site owner, who is using the admin and asks "how do I…" questions.

Current screen: {route}

Answer ONLY from the context provided in the user message (the help corpus entries and the list of available block types). The admin calls page sections "blocks"; always say "block", never "slice". Rules:
- If the answer is not in the context, say you are not sure and point the owner to the most relevant admin area (for example "check Settings › Languages") instead of inventing an answer.
- NEVER claim a capability, menu, field, or feature that is not in the context. Do not invent menu names, field names, or features.
- Be concise: a short paragraph, or a few numbered steps when the task has clear steps.
- Address the owner directly as "you". Keep the tone clear and practical.
- Answer in the language of the question.
- Write plain text only. No Markdown: no asterisks, no backticks, no headings, no [text](link) syntax, no web addresses or paths. Name a screen by its on-screen name, for example Settings › Languages.
- You may use the current screen above to phrase the answer for where the owner already is.

After your answer, if exactly one of the admin destinations below clearly matches what the owner is trying to do, propose it as a "do it for me" shortcut. Output the shortcut as a SINGLE fenced JSON block on its own at the very end of your response, in this exact shape:

\`\`\`json
{"intent": "<one id from the list>"}
\`\`\`

Rules for the shortcut:
- Choose AT MOST one intent. Omit the block entirely when no intent clearly matches — it is better to skip than to guess.
- The "intent" value MUST be one of the listed ids exactly. Do not invent new ids.
- Do not put any text after the fenced block.
- Do not put a fenced JSON block anywhere except as the final element of your response.

Allowed intents:
{intentEnum}`

const HELP_ASSISTANT_USER_TEMPLATE = `Current screen: {route}

Context you may use to answer:
{context}

Question: {question}`

export const AGENTS: Record<AgentId, AgentDef> = {
  translation: {
    id: "translation",
    label: "Translation",
    description:
      "Translates page titles, block copy and rich text into a target locale. Used by the editor's Translate actions.",
    defaultModel: "google/gemini-2.5-flash-lite",
    defaultSystemPrompt: TRANSLATION_SYSTEM,
    // The user message is the text itself today; `{text}` reproduces that exactly.
    defaultUserPromptTemplate: "{text}",
    systemPlaceholders: ["{sourceLang}", "{targetLang}"],
    userPlaceholders: ["{text}"],
  },
  content: {
    id: "content",
    label: "Content writer",
    description:
      "Drafts editorial copy (titles, subtitles, descriptions, body, button labels) for a single block in the editor's current locale, from a short brief. Never produces links, images, or styling — humans fill those.",
    defaultModel: "google/gemini-2.5-flash",
    defaultSystemPrompt: CONTENT_SYSTEM,
    // The user message is the brief. The per-slice field list is appended by
    // contentWriter.ts (it varies by slice type and can't be a flat template).
    defaultUserPromptTemplate: "Brief: {brief}",
    systemPlaceholders: ["{language}", "{sliceType}"],
    userPlaceholders: ["{brief}"],
    defaultWriteBriefs: [
      {
        label: "Hero for {audience}",
        body: "Hero for {audience} doing {job to be done}. Reassuring, concrete tone.",
      },
      {
        label: "CTA after a section",
        body: "CTA after the {section} section. Primary action: {action}. Warm and confident.",
      },
      {
        label: "Explainer in 3 steps",
        body: "Explainer: how {thing} works in 3 steps. Calm, factual, no hype.",
      },
      {
        label: "Reassurance",
        body: "Reassurance for visitors worried about {hesitation}. Concrete, not hand-wavy.",
      },
      {
        label: "Comparison without naming names",
        body: "Comparison: us vs {alternative}, without naming any product. Lead with what changes for the reader.",
      },
      {
        label: "Social proof framing",
        body: "Social-proof framing for {audience}. Leave a placeholder for the quote, don't invent one.",
      },
    ],
    // Page-level briefs describe a whole page; the New Page → Write with AI
    // wizard fills its textarea from these. Each seed names its placeholders
    // in `{curly}` form so the existing first-placeholder-autoselect UI hooks
    // up unchanged. Operators can override in Phase 4 of the page-gen spec.
    defaultPageBriefs: [
      {
        label: "Landing — product",
        body: "Landing page for {product}. Audience: {who they are and what they want}. Lead with a clear value proposition; close with a single primary action.",
      },
      {
        label: "Landing — service",
        body: "Landing page for the {service} we offer. Audience: {who they are}. Highlight outcomes, not features; close with a 'book / inquire' action.",
      },
      {
        label: "About",
        body: "About page for {organization}. Cover the mission, who we are, and what we believe. No fake stats, no invented founder quotes.",
      },
      {
        label: "Contact",
        body: "Contact page for {organization}. Brief lead-in, then the channels (email / phone / hours), then a primary action ('send a message' or similar).",
      },
      {
        label: "Service detail",
        body: "Page describing the {service} in depth. Audience: someone already considering buying. Explain the process in 2 to 3 steps; close with a CTA.",
      },
      {
        label: "Pricing — single tier",
        body: "Pricing page for {product} with one tier. Audience: {who they are}. Explain what's included and who it's for; close with the purchase action.",
      },
      {
        label: "Case study",
        body: "Case study about {customer} using {product}. Tell it as a short narrative: situation, what we did, what changed. Leave a placeholder for quotes; never invent one.",
      },
      {
        label: "Coming soon",
        body: "Coming-soon page for {product}. One-line promise, one paragraph of context, one primary action (waitlist signup, notify-me, etc.).",
      },
    ],
    defaultRefinePresets: [
      {
        label: "Tighten",
        body: "Cut filler. Keep every concrete claim. Aim for ~25% shorter.",
      },
      {
        label: "Plainer language",
        body: "Rewrite at a grade-8 reading level. Replace jargon with everyday words. Keep meaning intact.",
      },
      {
        label: "Warmer / more human",
        body: "Rewrite in a warm, conversational tone, like you're talking to one person, not a crowd.",
      },
      {
        label: "More confident",
        body: "Remove hedging ('we believe', 'might', 'can help'). State things directly.",
      },
      {
        label: "Active voice, second person",
        body: "Rewrite in active voice, addressing the reader as 'you'.",
      },
      {
        label: "Benefit-led, not feature-led",
        body: "Lead with what the reader gets, not what we built. Keep the same facts.",
      },
    ],
  },
  "help-assistant": {
    id: "help-assistant",
    label: "Help assistant",
    description:
      "Answers editors' how-do-I questions about using the CMS, grounded on the in-app help corpus and the live block catalog. Explains; never changes content.",
    defaultModel: "google/gemini-2.5-flash",
    defaultSystemPrompt: HELP_ASSISTANT_SYSTEM,
    defaultUserPromptTemplate: HELP_ASSISTANT_USER_TEMPLATE,
    systemPlaceholders: ["{route}", "{intentEnum}"],
    userPlaceholders: ["{question}", "{context}", "{route}"],
  },
}

/** Substitute `{key}` tokens in `tpl` with `vars[key]`. Unknown tokens are left
 *  untouched so a typo is visible rather than silently dropped. */
export function renderTemplate(
  tpl: string,
  vars: Record<string, string>
): string {
  return tpl.replace(/\{(\w+)\}/g, (match, key: string) =>
    key in vars ? vars[key] : match
  )
}

// Module-level cache: `Intl.DisplayNames` construction is expensive and the
// instance is stateless, so one instance serves every call.
let languageDisplayNames: Intl.DisplayNames | undefined

/** English display name of a locale code for prompts, e.g. "fr" → "French".
 *  Falls back to the code itself when the runtime can't resolve it. */
export function languageName(code: string): string {
  try {
    languageDisplayNames ??= new Intl.DisplayNames(["en"], {
      type: "language",
    })
    return languageDisplayNames.of(code) ?? code
  } catch {
    return code
  }
}

/** Build the translation system message: fill the registry default template
 *  with the language names, then auto-append the slug-formatting rule when
 *  translating a URL slug. The slug rule is conditional, so it lives in code
 *  rather than the template. */
export function buildTranslationSystemPrompt(
  sourceCode: string,
  targetCode: string,
  isSlug: boolean
): string {
  const base = renderTemplate(AGENTS.translation.defaultSystemPrompt, {
    sourceLang: languageName(sourceCode),
    targetLang: languageName(targetCode),
  })
  return isSlug
    ? `${base}\n\nThis is a URL slug: output lowercase, hyphen-separated, ASCII only (é→e, ç→c), no spaces.`
    : base
}

/** The placeholders an agent's default user template actually interpolates —
 *  i.e. the ones that carry the model's input. They are load-bearing: because
 *  `renderTemplate` leaves unknown tokens intact, a template that drops
 *  `{specJson}` sends the model the literal string "{specJson}" instead of the
 *  spec, and the agent degrades silently. `updateAgent` rejects an override that
 *  loses any of them. Derived from the default template rather than from
 *  `userPlaceholders`, which also lists optional ones. */
export function requiredUserPlaceholders(def: AgentDef): string[] {
  return [
    ...new Set(
      // Braced form ("{text}"), matching the `userPlaceholders` convention — so
      // the two lists are directly comparable and the UI can subtract one from
      // the other instead of listing the same token twice.
      [...def.defaultUserPromptTemplate.matchAll(/\{\w+\}/g)].map((m) => m[0])
    ),
  ]
}

import { SLICE_GROUPS } from "@/lib/slices/builder"
import { SLICE_ICON_NAMES } from "@/lib/slices/icon-names"
import {
  DEFAULT_ACTION_LIST_PATH,
  PRIMARY_LIST_AUTHORING_POLICY,
  primaryListTagExample,
  primaryScalarTagExample,
} from "@/convex/lib/slices/repeating"

export const SPEC_START = "BEGIN_SLICE_SPEC_JSON"
export const SPEC_END = "END_SLICE_SPEC_JSON"

/**
 * Pull the updated SliceSpec JSON out of an agent reply.
 *
 * The output contract asks the model to wrap the spec in the
 * {@link SPEC_START} / {@link SPEC_END} sentinels, but models routinely ignore
 * that and emit the spec inside a Markdown ```json fence (or bare in the
 * prose), which is what makes "Apply" report "No editable update returned".
 * This extractor is deliberately tolerant and tries, in order:
 *   1. the exact sentinel-delimited block (the contract's preferred shape),
 *   2. any Markdown-fenced code block (```json / ```jsonc / bare ```),
 *   3. any brace-balanced object anywhere in the text (unfenced JSON).
 * It accepts the first tier that yields a SliceSpec-shaped object — a non-array
 * object with a string "type" — and returns it pretty-printed, or null when
 * nothing spec-shaped is found. For the fenced/scan tiers it prefers the LAST
 * candidate, since a model that recaps the current spec before its update puts
 * the update last.
 */
export function extractSliceSpecJson(text: string): string | null {
  const tagged = text.match(
    new RegExp(`${SPEC_START}\\s*([\\s\\S]*?)\\s*${SPEC_END}`)
  )
  const fromSentinels = normalizeSliceSpecJson(tagged?.[1])
  if (fromSentinels) return fromSentinels

  let fromFence: string | null = null
  for (const match of text.matchAll(
    /```(?:json|jsonc)?[ \t]*\r?\n([\s\S]*?)```/g
  )) {
    const candidate = normalizeSliceSpecJson(match[1])
    if (candidate) fromFence = candidate
  }
  if (fromFence) return fromFence

  return findLastSliceSpecObject(text)
}

function normalizeSliceSpecJson(raw: string | undefined | null): string | null {
  const body = raw?.trim()
  if (!body) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(body)
  } catch {
    return null
  }
  if (!isSliceSpecShaped(parsed)) return null
  return JSON.stringify(parsed, null, 2)
}

function isSliceSpecShaped(value: unknown): value is { type: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as { type?: unknown }).type === "string"
  )
}

/**
 * Scan `text` for brace-balanced `{…}` spans and return the last one that
 * parses as a SliceSpec-shaped object. String contents (including escaped
 * quotes) are skipped so braces inside string values don't unbalance the scan.
 */
function findLastSliceSpecObject(text: string): string | null {
  let best: string | null = null
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "{") continue
    let depth = 0
    let inString = false
    let escaped = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{") depth++
      else if (ch === "}") {
        depth--
        if (depth === 0) {
          const candidate = normalizeSliceSpecJson(text.slice(i, j + 1))
          if (candidate) best = candidate
          i = j // skip this object's interior; continue after it
          break
        }
      }
    }
  }
  return best
}

/** Read semantic JSON containers using the SliceSpec fallback's structural
 * string/escape scan, independent of Markdown labels. An invalid outer span
 * must not hide a valid nested JSON payload. Malformed candidates remain
 * observable so author responses cannot hide ambiguity behind later JSON.
 * This never evaluates or repairs source. */
export function* extractJsonObjectCandidates(
  text: string
): Generator<
  { valid: true; value: unknown; raw: string } | { valid: false; raw: string }
> {
  for (let i = 0; i < text.length; i++) {
    // A complete scalar discussion line is JSON too. Its braces/brackets are
    // string data, not container starts. Parse the whole line so a stray prose
    // quote cannot hide a later real proposal object on that line.
    if (
      text[i] === '"' &&
      text.slice(text.lastIndexOf("\n", i - 1) + 1, i).trim() === ""
    ) {
      const nextLine = text.indexOf("\n", i)
      const end = nextLine < 0 ? text.length : nextLine
      try {
        if (typeof JSON.parse(text.slice(i, end)) === "string") {
          i = end - 1
          continue
        }
      } catch {
        // Malformed scalar/proposal text remains visible to the scan below.
      }
    }
    if (text[i] !== "{" && text[i] !== "[") continue
    let depth = 0
    let inString = false
    let escaped = false
    let closed = false
    for (let j = i; j < text.length; j++) {
      const ch = text[j]
      if (inString) {
        if (escaped) escaped = false
        else if (ch === "\\") escaped = true
        else if (ch === '"') inString = false
        continue
      }
      if (ch === '"') inString = true
      else if (ch === "{" || ch === "[") depth++
      else if ((ch === "}" || ch === "]") && --depth === 0) {
        const raw = text.slice(i, j + 1)
        try {
          const value: unknown = JSON.parse(raw)
          yield { valid: true, value, raw }
          i = j
        } catch {
          yield { valid: false, raw }
          // Inspect inner candidates on subsequent iterations.
        }
        closed = true
        break
      }
    }
    if (!closed) yield { valid: false, raw: text.slice(i) }
  }
}

export const OUTPUT_CONTRACT = `

## Output Contract

Return exactly one outcome:
Malformed JSON proposal blocks refuse even when a later SliceSpec is valid.

1. For one independently placeable section, return Markdown review first,
   then include exactly one create-spec block using the SliceSpec shape below.
2. For a page, exact-match reuse, new-presentation, or app-shell input, return a fenced JSON decomposition shaped as
   {"sections":[{"slug":"kebab-case","purpose":"one line","triage":{"decision":"new-slice"}}]} in page order.
   Return no SliceSpec block for this outcome.

For a compatible new design, use only
{"decision":"new-presentation","type":"registered-type","contractSha256":"sha256:<exact supplied reference>"}
inside the section's triage. This requests presentation review without generating
or writing source. Copy the registered contract reference supplied by the local
controller; do not invent one. It binds input identity, not semantic equivalence.
Do not include proposed fields, defaults or renderer code in this classification.
Return only its one fenced JSON envelope, with no other prose or payload.
Even an optional added editorial field requires a new/sibling Slice Type.

Single-section SliceSpec outcome:

${SPEC_START}
{
  "type": "kebab-case-slug",
  "label": "Human label",
  "description": "Picker one-liner",
  "icon": "Layers",
  "group": "heroes",
  "primary": {
    "kind": "group",
    "fields": {
      "title": {
        "kind": "richText",
        "config": {
          "contract": "title",
          "heading": { "role": "sliceTitle" },
          "placeholder": "Readable headline from the snapshot"
        }
      },
      "ctas": {
        "kind": "list",
        "item": { "kind": "ref", "ref": "button" },
        "config": { "max": 4 }
      }
    }
  },
  "aiHint": {
    "purpose": "One-line purpose",
    "fields": [
      "Return the fields below, each wrapped in matching fenced tags.",
      "${primaryScalarTagExample("primary.title", "…short heading with optional light emphasis…")}",
      "${DEFAULT_ACTION_LIST_PATH}: provide a JSON array of button labels; use the full-path list block ${primaryListTagExample(DEFAULT_ACTION_LIST_PATH)}."
    ]
  }
}
${SPEC_END}

The JSON block must be strict JSON, not TypeScript. Use only the SliceSpec shape
compatible with lib/slices/authoring/scaffold.ts.

${PRIMARY_LIST_AUTHORING_POLICY}

The optional "preview" object contains complete stored field values for the
simulator under "primary", including any named primary-list arrays.
Supply a value only when it is a faithful, deterministic fixture for the
declared field contract. Values are checked against the generated validators and
field bounds before any source is written; do not include storage IDs, random
IDs, dates based on the current time, or fields not declared by the spec. If
"preview" is omitted, the generator emits deterministic provisional values from
the primitive defaults. A provisional preview makes the slice renderable; it is
not visual approval and does not make a reference-fidelity comparison pass.

The top-level "group" field is required. Choose exactly one existing picker
group: ${SLICE_GROUPS.map((g) => `"${g.id}"`).join(", ")}.

Run the ADR-0044 reuse triage before authoring. Reuse an existing registered
type only when its editorial job and structural contract match exactly, without
schema changes. A new design with the same exact editorial contract may request
new-presentation review; styling stays in renderer/CSS. A structural
sibling or genuinely new contract may earn a new type; never extend an existing
type to absorb a different design.

The type slug must not collide with any existing slice type in the catalog. If
the suggested name collides, make it more specific to the snapshot.

For text fields, set config.placeholder to the visible sample copy from the
snapshot when it is readable. The sample renderer uses placeholders as preview
copy, so this makes the first sample render resemble the snapshot without
requiring high-fidelity design code.

Every field intended as a heading must be richText with contract "title" and an
explicit heading role ("sliceTitle" or "itemTitle"). Basic/full body fields
that may contain headings declare headingFloor.parent pointing to a title field.
Plain text fields must never be interpolated inside semantic headings.

Every primitive has a schema-valid default. Required image fields are allowed:
they default to the local placeholder image at
"/slice-placeholders/placeholder.png" until an editor chooses real media. Do
not mark fields optional just to avoid default values.

For aiHint.fields, describe scalar content with fenced tags and each named
primary list as a full-path JSON-array block. For example,
${primaryListTagExample(DEFAULT_ACTION_LIST_PATH, "...JSON array rows...")}.
Nested list arrays belong inside their parent JSON rows. Use the full field path
and preserve the section-owned default; use relations only for independently
addressable or independently reusable content.

Primitive spelling is exact:
- New repeating content belongs in descriptively named lists inside "primary";
  do not author the legacy top-level "items" field for a new SliceSpec. The
  default button list path is "${DEFAULT_ACTION_LIST_PATH}".
- Use "richText", never "rich-text".
- Rich text config must use { "profile": "inline" | "basic" | "full" }, never
  { "inline": true }.
- Rich text config may include "placeholder" for readable snapshot copy.
- Use "relation" for cards/lists of other content (articles, testimonials,
  team members, related pages). Relation config must be
  { "pageTypes": ["landing-page" | "page" | "post"], "tag"?: "optional-tag" }.
- Relation aiHint guidance must say content agents may search and link existing
  pages, never fabricate targets or copy referenced content inline.
- Use "date" for calendar dates, "datetime" for event timestamps, "geopoint"
  for latitude/longitude, "embed" for URL-only external embeds, and "table" for
  editor-controlled rows/columns with plain-text cells.
- Table decision rule: known/card-like columns belong in list(group); tables in
  flowing prose belong in full rich text; editor-controlled grids use table.
- "select" config is { "options": ["a", "b"], "default": "a", "labels"?: { "a": "A" } }.
  "options" is a FLAT array of string values — never [{ "label", "value" }] objects,
  and "default" is REQUIRED and must be one of the options.
- "boolean" config is { "default": true|false, "label"?: "…", "description"?: "…" }.
  "number" config is { "default": 0, "min"?, "max"?, "step"? }. Both require "default".
- Editorial icons (one per row in a feature/benefit list) are a "select" whose options
  are chosen from this exact curated set, spelled PascalCase:
  ${SLICE_ICON_NAMES.join(", ")}. Pick the
  closest names for the design; the renderer maps them to icons via <SliceIcon>. Never use
  hyphen-case (e.g. "cloud-upload") and never copy raw SVG markup.
`

// ─── Additional output contracts for the from-text / tweak / refine flows ────
//
// The primary OUTPUT_CONTRACT above targets the "create from a snapshot" path.
// These three variants are appended to the same author/renderer system prompts
// for the specialized dev-lane flows and were extracted from the retired
// runtime Convex actions so both the CLI and the dev-only Next server actions
// consume identical instructions.

export const TEXT_OUTPUT_CONTRACT = OUTPUT_CONTRACT.replaceAll(
  "snapshot",
  "brief"
).replaceAll("Snapshot", "Text brief")

export const TWEAK_OUTPUT_CONTRACT = `

## Tweak Output Contract

The current slice's full SliceSpec JSON is included below. Return Markdown
review first, then include exactly one complete updated SliceSpec block for the
same slice type:

${SPEC_START}
{
  "type": "same-kebab-case-slug",
  "label": "Human label",
  "description": "Picker one-liner",
  "icon": "Layers",
  "group": "heroes",
  "primary": {
    "kind": "group",
    "fields": {
      "title": {
        "kind": "richText",
        "config": {
          "profile": "inline",
          "placeholder": "Readable headline"
        }
      }
    }
  },
  "items": {
    "item": { "kind": "ref", "ref": "button" },
    "max": 4
  },
  "aiHint": {
    "purpose": "One-line purpose",
    "fields": [
      "Return the fields below, each wrapped in matching fenced tags.",
      "[title]\\n…short heading with optional light emphasis…\\n[/title]"
    ]
  }
}
${SPEC_END}

The JSON block must be strict JSON, not TypeScript. Use only the SliceSpec shape
compatible with lib/slices/authoring/scaffold.ts. Return the complete updated
SliceSpec, never a partial patch.

The top-level "group" field is required. Keep the current group unless the
requested tweak explicitly changes the slice's picker category.

The "type" must not change. Do not remove or re-kind existing fields. Every
added field must have "optional": true. Existing select fields may only gain
options. Existing richText fields may only widen profiles.

Every primitive has a schema-valid default. Required image fields are allowed:
they default to the local placeholder image at
"/slice-placeholders/placeholder.png" until an editor chooses real media.

Every newly added field intended as a heading uses richText contract "title"
with an explicit heading role. New title renderers use kit RichText without an
"as" prop; preserve existing legacy renderer bindings during a tweak.
Every newly added repeating field uses a named list in "primary". Preserve an
existing top-level "items" field byte-for-byte; never relocate its data.

Primitive spelling is exact:
- Use "richText", never "rich-text".
- Rich text config must use { "profile": "inline" | "basic" | "full" }, never
  { "inline": true }.
- Rich text config may include "placeholder" for readable snapshot copy.
- Use "relation" for cards/lists of other content (articles, testimonials,
  team members, related pages). Relation config must be
  { "pageTypes": ["landing-page" | "page" | "post"], "tag"?: "optional-tag" }.
- Relation aiHint guidance must say content agents may search and link existing
  pages, never fabricate targets or copy referenced content inline.
- Use "date" for calendar dates, "datetime" for event timestamps, "geopoint"
  for latitude/longitude, "embed" for URL-only external embeds, and "table" for
  editor-controlled rows/columns with plain-text cells.
- Table decision rule: known/card-like columns belong in list(group); tables in
  flowing prose belong in full rich text; editor-controlled grids use table.
`

export const REFINE_OUTPUT_CONTRACT = `

## Refine Output Contract

You are refining an EXISTING renderer, not creating one from scratch. The
current JSX body is included below. Return the FULL updated JSX body (not a
diff/patch). Preserve everything that already works; change only what the
brief asks for.

Rules:
- The body MUST still start with \`<section\` and be a single root element.
- Do NOT add, remove, or rename props/fields — the SliceSpec is frozen.
- Preserve existing renderer bindings while refining a legacy Slice Type. Do
  not add literal h1–h6 wrappers or as="hN" props. Any newly introduced title
  field uses the title contract and the outline-owned host; never place plain
  text directly in a semantic heading.
- You may change Tailwind classes, container structure, responsive breakpoints,
  ordering, spacing, and alignment. You may NOT add \`onClick\`, hooks, or
  \`dangerouslySetInnerHTML\`.
- Treat the current slice render as the baseline. If an image is attached, use
  it only as optional design context, not as a pixel-perfect target.
- Stay within the viewport scope in the editor's brief: desktop, mobile, or
  both.
- Bind to the site design-system tokens (color, type, section rhythm). Layout
  geometry may use any standard Tailwind utilities.
- First a one-paragraph plain-text plan describing what you changed and why.
- Then exactly one fenced code block tagged \`jsx\` containing the COMPLETE
  updated body.
`

// ─── Input caps + small helpers shared between the CLI and dev server actions ──

/** Input caps for the four dev-lane slice-authoring surface areas. Every free-
 *  text arg gets an explicit ceiling so a runaway client can't blow the prompt
 *  budget before the model is even called. Values held here rather than at
 *  each caller so the CLI and the in-admin dev actions cannot drift. */
export const SLICE_INPUT_CAPS = {
  brief: 2_000,
  specJson: 100_000,
  rendererSource: 200_000,
  previousAttempt: 200_000,
  previousError: 20_000,
  targetText: 2_000,
  imageDataUrl: 950_000,
  suggestedName: 120,
} as const

const CREATE_SLICE_SOURCE_LINES = {
  description:
    "No design image or source markup is attached. The description below is the only source for this slice; where these instructions mention a snapshot, use the description instead.",
  snapshot: "A snapshot of the design is attached as an image.",
  markupWithImage:
    "The design's source markup is included below, and a screenshot of the same design is attached as a visual cross-check.",
  markupOnly:
    "The design's source markup is included below. No screenshot is attached.",
} as const

/** Build the Create-slice request text from the user's own input. The admin
 *  screen sends only what the user typed; the server adds every rule. */
export function buildCreateSliceBrief(input: {
  source: "description" | "snapshot" | "markup"
  hasImage: boolean
  userText: string
  suggestedName?: string
}): string {
  const sourceLine =
    input.source === "markup"
      ? input.hasImage
        ? CREATE_SLICE_SOURCE_LINES.markupWithImage
        : CREATE_SLICE_SOURCE_LINES.markupOnly
      : CREATE_SLICE_SOURCE_LINES[input.source]
  const name = input.suggestedName?.replace(/\s+/g, " ").trim()
  const text = input.userText.trim()
  const userLines =
    input.source === "description"
      ? ["Description:", text]
      : text
        ? ["Note from the user:", text]
        : ["Note from the user: none"]
  return [sourceLine, `Suggested name: ${name || "none"}`, ...userLines].join(
    "\n"
  )
}

/** Extract the first \`\`\`jsx (or \`\`\`tsx) fenced block from the renderer
 *  agent's reply. Returns the body string with surrounding whitespace trimmed,
 *  or null when no block is present (caller falls back / retries). */
export function extractRendererJsxBody(text: string): string | null {
  const fenced = text.match(/```(?:jsx|tsx)\s*\n([\s\S]*?)\n```/)
  const body = fenced?.[1]?.trim()
  return body && body.length > 0 ? body : null
}

/** Render the editor's click-to-target selection as a prompt section. The path
 *  is authoritative (it came from the flattened SliceSpec), so the model is
 *  told to scope the change there unless the brief clearly points elsewhere.
 *  Returns "" when no element was targeted, so the caller can filter it out. */
export function describeTargetSection(target?: {
  fieldPath: string
  humanLabel: string
  text?: string
}): string {
  if (!target) return ""
  const lines = [
    "",
    "## Targeted element",
    "",
    "The editor pointed at a specific part of the live preview. Scope the change",
    "to this field unless the brief clearly refers to something else.",
    "",
    `- Field path: ${target.fieldPath}`,
    `- Human label: ${target.humanLabel}`,
  ]
  if (target.text?.trim()) {
    lines.push(`- Current text: ${target.text.trim()}`)
  }
  return lines.join("\n")
}

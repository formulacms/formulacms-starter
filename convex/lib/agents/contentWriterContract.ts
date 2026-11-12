import { readInstalledSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { withSlugFallback } from "../contentTypes/routing"
import { writeSliceFields } from "../richtext/write"
import { validate } from "convex-helpers/validators"
import { ConvexError } from "convex/values"
import { buildContextBlock, type PageContext } from "./pageContext"
import { renderTemplate } from "./registry"
import { buildFieldDoc } from "../richtext/build"
import { resolveFieldContract, type FieldContract } from "../richtext/contracts"
import { validateStrict } from "../richtext/strict"
import {
  collectTextSegments,
  parsePMDoc,
  replaceTextSegments,
} from "../richtext/pmText"
import {
  createDefaultSlice,
  installedSliceValidator,
  INSTALLED_SLICE_TYPES,
  type Primitive,
  type InstalledSlice,
  type InstalledSliceType,
} from "../slices"
import {
  primaryFieldProtocol,
  primaryListInstructions,
} from "../slices/repeating"
import { isEditorialTextPrimitive } from "../slices/primitives"
import { MAX_CONCURRENT_LLM_CALLS, Semaphore } from "../semaphore"

export type PageMeta = {
  metaTitle: string
  metaDescription: string
}

export type ContentSystemInput = {
  systemTemplate: string
  language: string
  sliceType: string
  context?: PageContext
  brandVoice?: string
}

export function buildContentSystemInstructions({
  systemTemplate,
  language,
  sliceType,
  context,
  brandVoice,
}: ContentSystemInput): string {
  const head = renderTemplate(systemTemplate, { language, sliceType })
  const tail = buildContextBlock(context, brandVoice)
  return tail ? `${head}\n\n${tail}` : head
}

export type ContentGenerationInput = {
  instructions: string
  prompt: string
}

export type FieldGenerationInput = ContentSystemInput & {
  userTemplate: string
  brief: string
  fieldLabel: string
  format: "plain" | "richText"
  contract?: FieldContract
}

export function buildFieldGenerationInput(
  input: FieldGenerationInput
): ContentGenerationInput {
  const fieldInstructions =
    input.format === "richText" && input.contract === "title"
      ? `Write one concise title for the "${input.fieldLabel}" field only. Output plain text, with optional light **bold** or *italic* emphasis and line breaks if useful. Do NOT use labels, links, heading tags, JSON, or Markdown structure.`
      : input.format === "richText"
        ? `Write the "${input.fieldLabel}" field only. Output 1–3 short paragraphs separated by blank lines. You may use **bold** and *italic* for light emphasis (sparingly). Do NOT use links, headings, lists, code, or any other Markdown.`
        : `Write the "${input.fieldLabel}" field only. Output one short plain-text value, no labels, no quotes, no Markdown.`
  return {
    instructions: buildContentSystemInstructions(input),
    prompt: `${renderTemplate(input.userTemplate, { brief: input.brief })}\n\n${fieldInstructions}`,
  }
}

export type RefinementGenerationInput = Omit<
  ContentSystemInput,
  "sliceType"
> & {
  text: string
  instruction: string
  fieldLabel: string
}

export function buildRefinementGenerationInput(
  input: RefinementGenerationInput
): ContentGenerationInput | undefined {
  if (!input.text.trim()) return undefined
  return {
    instructions: buildContentSystemInstructions({
      ...input,
      sliceType: "section",
    }),
    prompt: [
      `Rewrite the "${input.fieldLabel}" content below in ${input.language}, following the user's instruction. Preserve the meaning and keep it on-topic.`,
      "",
      `Instruction: ${input.instruction.trim()}`,
      "",
      "Output ONLY the revised value — no commentary, no labels, no quotes, no Markdown, no links.",
      "",
      "Content:",
      input.text.trim(),
    ].join("\n"),
  }
}

export function assembleRefinedText(
  original: string,
  rawOutput: string
): string {
  const leading = original.match(/^\s*/)?.[0] ?? ""
  const trailing = original.match(/\s*$/)?.[0] ?? ""
  const refined = stripWrappingQuotes(rawOutput.trim())
  return refined ? leading + refined + trailing : original
}

export type SliceGenerationInput = Omit<ContentSystemInput, "sliceType"> & {
  userTemplate: string
  sliceType: InstalledSliceType
  brief: string
}

export function buildSliceGenerationInput(
  input: SliceGenerationInput
): ContentGenerationInput {
  return {
    instructions: buildContentSystemInstructions(input),
    prompt: `${renderTemplate(input.userTemplate, { brief: input.brief })}\n\n${buildSliceFieldInstructions(input.sliceType)}`,
  }
}

export type PageFillGenerationInput = Omit<SliceGenerationInput, "brief"> & {
  pageBrief: string
  purpose: string
}

export function buildPageFillGenerationInput(
  input: PageFillGenerationInput
): ContentGenerationInput {
  const brief = [
    `Page-level brief: ${input.pageBrief.trim()}`,
    "",
    `This "${input.sliceType}" section's purpose on the page: ${input.purpose.trim()}`,
  ].join("\n")
  return buildSliceGenerationInput({
    systemTemplate: input.systemTemplate,
    userTemplate: input.userTemplate,
    language: input.language,
    sliceType: input.sliceType,
    brief,
    context: input.context,
    brandVoice: input.brandVoice,
  })
}

export const META_TITLE_MAX = 60
export const META_DESCRIPTION_MAX = 160
export const OUTLINE_MAX_SLICES = 8

/** Mechanical metadata constraints appended after the page summary. */
export const META_INSTRUCTIONS = [
  "Write SEO metadata for the page summarised above (page title + section",
  "contents). Output ONLY the two fenced blocks below — no preamble, no",
  "explanation, no Markdown, no quotes, no labels other than the tags.",
  "",
  `[metaTitle]`,
  `One line, ≤ ${META_TITLE_MAX} characters, no trailing punctuation,`,
  `no site name suffix. Lead with the page's topic, not the brand.`,
  `[/metaTitle]`,
  "",
  `[metaDescription]`,
  `One line, ≤ ${META_DESCRIPTION_MAX} characters. A neutral, factual`,
  `summary of what the page covers. No clickbait, no marketing fluff,`,
  `no questions, no first person.`,
  `[/metaDescription]`,
].join("\n")

export function buildPageMetaGenerationInput(
  input: Omit<ContentSystemInput, "sliceType" | "context"> & {
    context: PageContext
  }
): ContentGenerationInput {
  return {
    instructions: buildContentSystemInstructions({
      ...input,
      sliceType: "page",
    }),
    prompt: META_INSTRUCTIONS,
  }
}

/** Assemble page metadata from the content writer's labeled response format. */
export function assembleMeta(raw: string): PageMeta {
  const blocks = parseLabeled(raw, ["metaTitle", "metaDescription"])
  return {
    metaTitle: capWords(
      stripWrappingQuotes(blocks.metaTitle ?? ""),
      META_TITLE_MAX
    ),
    metaDescription: capWords(
      stripWrappingQuotes(blocks.metaDescription ?? ""),
      META_DESCRIPTION_MAX
    ),
  }
}

export type PageOutline = PageMeta & {
  title: string
  slug: string
  outline: { type: InstalledSliceType; purpose: string }[]
}

export function buildOutlineInstructions(): string {
  return [
    "Plan a single page for the brief above. Output ONLY the fenced blocks below.",
    "Do not add explanation, Markdown, or quotes around values.",
    "",
    "Available section types (pick from these exact slugs — no others):",
    renderSliceCatalog(),
    "",
    "[title]",
    "Page title in ≤ 8 words, plain text.",
    "[/title]",
    "",
    "[slug]",
    "kebab-case URL slug, lowercase, ASCII letters/digits/hyphens only.",
    "[/slug]",
    "",
    `[metaTitle]`,
    `≤ ${META_TITLE_MAX} characters, plain text.`,
    `[/metaTitle]`,
    "",
    `[metaDescription]`,
    `≤ ${META_DESCRIPTION_MAX} characters, plain text, factual.`,
    `[/metaDescription]`,
    "",
    "[outline]",
    `Between 2 and ${OUTLINE_MAX_SLICES} sections, one per line, in this exact format:`,
    "- <slice-type> | <one short sentence describing this section's purpose on the page>",
    "Pick the slice mix that best fits the brief. Each slice type may repeat if useful.",
    "[/outline]",
  ].join("\n")
}

export type PageOutlineGenerationInput = Omit<
  ContentSystemInput,
  "sliceType" | "context"
> & {
  userTemplate: string
  brief: string
}

export function buildPageOutlineGenerationInput(
  input: PageOutlineGenerationInput
): ContentGenerationInput {
  return {
    instructions: buildContentSystemInstructions({
      systemTemplate: input.systemTemplate,
      language: input.language,
      sliceType: "page",
      brandVoice: input.brandVoice,
    }),
    prompt: `${renderTemplate(input.userTemplate, { brief: input.brief })}\n\n${buildOutlineInstructions()}`,
  }
}

export function assembleOutline(raw: string): PageOutline {
  const blocks = parseLabeled(raw, [
    "title",
    "slug",
    "metaTitle",
    "metaDescription",
    "outline",
  ])

  const title = capWords(
    stripWrappingQuotes(blocks.title ?? ""),
    META_TITLE_MAX
  )
  const metaTitle = capWords(
    stripWrappingQuotes(blocks.metaTitle ?? ""),
    META_TITLE_MAX
  )
  const metaDescription = capWords(
    stripWrappingQuotes(blocks.metaDescription ?? ""),
    META_DESCRIPTION_MAX
  )
  const slugSource = stripWrappingQuotes(blocks.slug ?? "") || title
  // The fallback is keyed on the title, never on the AI's slug block, so a
  // non-ASCII slug cannot hash to a different address than create's
  // generateSlug(title) would give the same page.
  const slug =
    slugifyServer(slugSource) || withSlugFallback(title, slugifyServer(title))

  const outline: PageOutline["outline"] = []
  if (blocks.outline) {
    for (const line of parseList(blocks.outline)) {
      const match = line.match(/^([\w-]+)\s*[|—–-]\s*(.+)$/)
      if (!match) continue
      const rawType = match[1]!.toLowerCase()
      const purpose = stripWrappingQuotes(match[2]!.trim())
      if (!purpose) continue
      if ((INSTALLED_SLICE_TYPES as readonly string[]).includes(rawType)) {
        outline.push({ type: rawType as InstalledSliceType, purpose })
      }
      if (outline.length >= OUTLINE_MAX_SLICES) break
    }
  }

  if (outline.length === 0) {
    throw new ConvexError(
      "OUTLINE_EMPTY: the model did not propose any valid sections. Try a different brief."
    )
  }

  return { title, slug, metaTitle, metaDescription, outline }
}

export function buildSliceFieldInstructions(
  sliceType: InstalledSliceType
): string {
  const definition = readInstalledSliceDefinition(sliceType)
  const listInstructions = primaryListInstructions(definition.primary)
  return listInstructions
    ? `${definition.aiHint.fields}\n\n${listInstructions}`
    : definition.aiHint.fields
}

export function assertSliceType(value: string): InstalledSliceType {
  if ((INSTALLED_SLICE_TYPES as readonly string[]).includes(value)) {
    return value as InstalledSliceType
  }
  throw new ConvexError(`UNKNOWN_SLICE_TYPE: ${value}`)
}

/** Assemble model-authored editorial fields onto trusted structural defaults. */
export function assembleSlice(
  sliceType: InstalledSliceType,
  raw: string
): InstalledSlice {
  const def = readInstalledSliceDefinition(sliceType)
  const defaults = createDefaultSlice(sliceType)
  const primary = structuredClone(readSlice(defaults).primary) as Record<
    string,
    unknown
  >
  const protocol = primaryFieldProtocol(def.primary)
  const blocks = parseLabeled(
    raw,
    protocol.scalars.flatMap(({ path, legacyAlias }) =>
      legacyAlias ? [path, legacyAlias] : [path]
    )
  )
  fillGeneratedPrimary(primary, protocol.scalars, blocks)
  const declaredLists = protocol.lists.filter(
    ({ path }) => !path.includes("[]")
  )
  const listBlocks = parseLabeled(
    raw,
    declaredLists.map(({ path }) => path)
  )
  for (const { path, definition } of declaredLists) {
    if (!Object.hasOwn(listBlocks, path)) continue
    const value = parsePrimaryList(listBlocks[path]!, path, definition)
    assignPrimaryPath(primary, path, value)
  }

  const slice: Record<string, unknown> = {
    id: crypto.randomUUID(),
    type: sliceType,
    enabled: true,
    primary,
  }
  if (def.items !== undefined) {
    const generatedItems = assembleGeneratedItems(sliceType, raw)
    slice.items =
      generatedItems.length > 0
        ? generatedItems
        : structuredClone((defaults as { items?: unknown[] }).items ?? [])
  }
  const normalized = writeSliceFields(slice as InstalledSlice).value
  if (!validate(installedSliceValidator, normalized)) {
    throw new ConvexError(
      `INVALID_GENERATED_SLICE: ${String(sliceType)} does not match its installed contract.`
    )
  }
  return normalized
}

export async function refineRichTextSegments(
  json: string,
  refiner: (segment: string) => Promise<string>,
  maxConcurrent: number = MAX_CONCURRENT_LLM_CALLS
): Promise<string> {
  const doc = parsePMDoc(json)
  if (!doc) return json
  const segments = collectTextSegments(doc)
  if (segments.length === 0) return json
  const semaphore = new Semaphore(maxConcurrent)
  const refined = await Promise.all(
    segments.map(async (segment) => {
      await semaphore.acquire()
      try {
        return await refiner(segment)
      } finally {
        semaphore.release()
      }
    })
  )
  return JSON.stringify(replaceTextSegments(doc, refined))
}

function fillGeneratedPrimary(
  primary: Record<string, unknown>,
  fields: ReturnType<typeof primaryFieldProtocol>["scalars"],
  blocks: Record<string, string>
): void {
  for (const { path, definition: field, legacyAlias } of fields) {
    const hasCanonical = Object.hasOwn(blocks, path)
    const sourceKey = hasCanonical ? path : legacyAlias
    if (!sourceKey || !Object.hasOwn(blocks, sourceKey)) continue
    const value = blocks[sourceKey]!
    if (!hasCanonical && !value) continue
    let authoredValue: unknown
    if (field.kind === "text") {
      authoredValue = stripWrappingQuotes(value)
    } else if (field.kind === "richText") {
      authoredValue = JSON.stringify(
        buildFieldDoc(
          value,
          field.config,
          resolveFieldContract(field.config).headingRole,
          {
            emphasis: true,
            markdown: true,
          }
        )
      )
    } else {
      continue
    }
    assignPrimaryPath(primary, path, authoredValue)
  }
}

function parsePrimaryList(
  block: string,
  path: string,
  definition: Primitive
): unknown[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(block)
  } catch {
    throw new ConvexError(`PRIMARY_LIST_INVALID_JSON: ${path}`)
  }
  if (!Array.isArray(parsed))
    throw new ConvexError(`PRIMARY_LIST_EXPECTED_ARRAY: ${path}`)
  return shapePrimaryList(parsed, path, definition)
}

function shapePrimaryList(
  rows: unknown[],
  path: string,
  definition: Primitive
): unknown[] {
  const minimum = (definition.config.min as number | undefined) ?? 0
  const maximum = (definition.config.max as number | undefined) ?? 24
  if (rows.length < minimum)
    throw new ConvexError(`PRIMARY_LIST_TOO_FEW_ROWS: ${path}`)
  const item = definition.config.item as Primitive
  return rows.slice(0, maximum).map((row) => shapePrimaryValue(row, item, path))
}

function shapePrimaryValue(
  value: unknown,
  definition: Primitive,
  path: string
): unknown {
  if (
    definition.kind !== "group" &&
    definition.kind !== "list" &&
    !isEditorialTextPrimitive(definition)
  )
    return structuredClone(definition.default)

  if (definition.kind === "text") {
    if (typeof value !== "string")
      throw new ConvexError(`PRIMARY_LIST_EXPECTED_STRING: ${path}`)
    return stripWrappingQuotes(value)
  }

  if (definition.kind === "richText") {
    if (typeof value !== "string")
      throw new ConvexError(`PRIMARY_LIST_EXPECTED_STRING: ${path}`)
    const contract = resolveFieldContract(definition.config)
    return JSON.stringify(
      buildFieldDoc(
        stripWrappingQuotes(value),
        definition.config,
        contract.headingRole,
        { emphasis: true, markdown: true }
      )
    )
  }

  if (definition.kind === "list") {
    if (!Array.isArray(value))
      throw new ConvexError(`PRIMARY_LIST_EXPECTED_ARRAY: ${path}`)
    return shapePrimaryList(value, path, definition)
  }

  if (definition.kind === "group") {
    if (!isRecordValue(value))
      throw new ConvexError(`PRIMARY_LIST_EXPECTED_OBJECT: ${path}`)
    const result = structuredClone(definition.default) as Record<
      string,
      unknown
    >
    const fields = definition.config.fields as Record<string, Primitive>
    for (const [key, child] of Object.entries(fields)) {
      if (!Object.hasOwn(value, key)) continue
      result[key] = shapePrimaryValue(value[key], child, `${path}.${key}`)
    }
    return result
  }

  return structuredClone(definition.default)
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function assignPrimaryPath(
  primary: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const segments = path.split(".").slice(1)
  let target = primary
  for (const segment of segments.slice(0, -1)) {
    const next = target[segment]
    if (!isRecordValue(next)) return
    target = next
  }
  const key = segments.at(-1)
  if (key !== undefined) target[key] = value
}

function assembleGeneratedItems(
  sliceType: InstalledSliceType,
  raw: string
): unknown[] {
  const def = readInstalledSliceDefinition(sliceType)
  if (!def.items) return []
  const item = def.items.config.item as Primitive
  if (item.kind !== "group") return structuredClone(def.items.default) as unknown[]
  const fields = item.config.fields as Record<string, Primitive>
  const max = (def.items.config.max as number | undefined) ?? 24
  const hasButtonShape = "label" in fields && "link" in fields
  const blocks = parseLabeled(raw, ["items", "buttons"])
  const rows: Array<Record<string, unknown>> = []
  for (const line of parseList(blocks.items ?? blocks.buttons ?? "")) {
    // `key: value | key: value` lines (the format the aiHint teaches) first;
    // a line with no declared key is a button label when the item is a button.
    const keyed = parseKeyedItemLine(line, fields)
    const row = keyed
      ? shapeKeyedItem(keyed, item)
      : hasButtonShape
        ? buttonLineToItem(line, item)
        : undefined
    if (row) rows.push(row)
  }
  return rows.slice(0, max)
}

/** Split `key: value | key: value` at ` | `, then each pair at its first `:`.
 * Only keys the item declares start a pair; any other piece continues the
 * previous value, so a value may hold ` | ` or a `word:` of its own. */
function parseKeyedItemLine(
  line: string,
  fields: Record<string, Primitive>
): Record<string, string> | undefined {
  const names = new Map(Object.keys(fields).map((key) => [key.toLowerCase(), key]))
  const values: Record<string, string> = {}
  let current: string | undefined
  for (const piece of line.replace(/^\d+[.)]\s+/, "").split(" | ")) {
    const pair = piece.match(/^\s*([A-Za-z][A-Za-z0-9_]*)\s*:([\s\S]*)$/)
    const key = pair ? names.get(pair[1]!.toLowerCase()) : undefined
    if (pair && key) {
      values[key] = pair[2]!.trim()
      current = key
    } else if (current) {
      values[current] += ` | ${piece.trim()}`
    } else {
      return undefined
    }
  }
  return current ? values : undefined
}

/** Shape one keyed line with the rules the primary list rows use. A line that
 * carries no copy, or whose copy the save validation would refuse, is skipped
 * (undefined) instead of failing the slice. */
function shapeKeyedItem(
  values: Record<string, string>,
  item: Primitive
): Record<string, unknown> | undefined {
  const fields = item.config.fields as Record<string, Primitive>
  const copy: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    const field = fields[key]!
    if (!isEditorialTextPrimitive(field)) continue
    // `icon` names one of the curated icons; anything that is not a single
    // name keeps the default (the renderer shows nothing for an unknown name).
    if (key === "icon" && !/^[A-Za-z][A-Za-z0-9]*$/.test(stripWrappingQuotes(value)))
      continue
    copy[key] = value
  }
  if (!Object.values(copy).some((value) => value.trim())) return undefined
  try {
    const row = shapePrimaryValue(copy, item, "items") as Record<string, unknown>
    for (const key of Object.keys(copy)) {
      const field = fields[key]!
      if (
        field.kind === "richText" &&
        !validateStrict(
          resolveFieldContract(field.config),
          row[key] as string
        ).ok
      )
        return undefined
    }
    return row
  } catch {
    return undefined
  }
}

/** `Label` or `Label (variant)`: a trailing `(word)` is removed and sets the
 * button variant only when the word is an option of the button's `variant`
 * field (case-insensitive). Any other parenthesis stays in the label. The link
 * is left empty: the model must not invent destinations. */
function buttonLineToItem(
  line: string,
  item: Primitive
): Record<string, unknown> | undefined {
  const fields = item.config.fields as Record<string, Primitive>
  const options = (fields.variant?.config.options as string[] | undefined) ?? []
  const unquoted = stripWrappingQuotes(line)
  const suffix = unquoted.match(/^([\s\S]*?)\s*\(([A-Za-z-]+)\)\s*$/)
  const variant = suffix
    ? options.find((option) => option === suffix[2]!.toLowerCase())
    : undefined
  const label = stripWrappingQuotes(variant ? suffix![1]! : unquoted).trim()
  if (!label) return undefined
  return {
    ...(structuredClone(item.default) as Record<string, unknown>),
    id: crypto.randomUUID(),
    label,
    ...(variant ? { variant } : {}),
  }
}

function stripWrappingQuotes(text: string): string {
  const match = text.match(/^[\s]*["“'']([\s\S]*?)["”'']\s*$/)
  return match?.[1] !== undefined ? match[1].trim() : text
}

function parseList(block: string): string[] {
  return block
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*[-*•]\s*/, "").trim())
    .filter((line) => line.length > 0)
}

function renderSliceCatalog(): string {
  return INSTALLED_SLICE_TYPES.map(
    (type) => `- ${type} — ${readInstalledSliceDefinition(type).aiHint.purpose}`
  ).join("\n")
}

function slugifyServer(text: string): string {
  return text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

export function capWords(text: string, max: number): string {
  const trimmed = text.trim()
  if (trimmed.length <= max) return trimmed
  const cut = trimmed.slice(0, max)
  const lastSpace = cut.lastIndexOf(" ")
  return (
    lastSpace > Math.floor(max / 2) ? cut.slice(0, lastSpace) : cut
  ).trim()
}

function parseLabeled(
  text: string,
  keys: readonly string[]
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const escapedKey = escapeRegExp(key)
    const match = text.match(
      new RegExp(`\\[${escapedKey}\\]([\\s\\S]*?)\\[\\/${escapedKey}\\]`, "i")
    )
    if (match?.[1] !== undefined) out[key] = match[1].trim()
  }
  return out
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

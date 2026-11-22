import { readBlockDefinition } from "@/convex/lib/blocks"
import { readBlock, type BlockStructure } from "@/convex/lib/blocks/identity"
import { ConvexError, v } from "convex/values"
import { contentTypeDefs } from "../contentTypes"
import { type Block, type Primitive } from "../blocks"
import { resolveFieldContract, type ResolvedFieldContract } from "./contracts"
import { toFieldShape, type RemovedRichTextLink } from "./shape"
import { validateLegacy, validateStrict } from "./strict"
import { convertTransitionTitle } from "./transitions"

export const removedTitleLinksValidator = v.array(
  v.object({
    locale: v.string(),
    blockId: v.string(),
    fieldPath: v.string(),
    removedLinks: v.array(
      v.object({ href: v.optional(v.string()), pageId: v.optional(v.string()) })
    ),
  })
)
export type TitleWriteReport = {
  locale: string
  blockId: string
  fieldPath: string
  removedLinks: RemovedRichTextLink[]
}
/** Created only from an authorised record read inside the current mutation.
 * The record identity/version and content travel together; never a public arg.
 * A locale mapping is explicit, operation-owned (F09), never inferred by bytes.
 */
export type TrustedTitleSource = {
  recordId: string
  version: string | number
  content: unknown
  sourceLocale?: string
  destinationLocale?: string
  /** Internal identity-only view, bound to this original record/version. */
  repairedIdentityContent?: unknown
}
export type WriteOptions = {
  /** Server-owned descriptor address for registered primitive transitions. */
  blockType?: string
  duplicate?: boolean
  identitiesOnly?: boolean
  allocateItemIds?: boolean
  readLegacyShapes?: boolean
  createId?: () => string
  trustedSource?: TrustedTitleSource
  preserveHtml?: (path: string, value: string) => boolean
  preserveLegacy?: (
    path: string,
    original: string,
    candidate: string,
    contract: ResolvedFieldContract
  ) => boolean
}
export function isLegacyTitleHtml(value: string): boolean {
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    /* Raw stored HTML. */
  }
  return (
    !isRecord(parsed) &&
    /<\/?[a-z][^>]*>/i.test(typeof parsed === "string" ? parsed : value)
  )
}

export function preservesTitleAt(
  options: WriteOptions,
  locale: string,
  block: Pick<Block, "id" | "type">,
  path: string,
  value: string
): boolean {
  return preservesTitleAtStructure(options, locale, block, path, value)
}

function preservesTitleAtStructure(
  options: WriteOptions,
  locale: string,
  block: Pick<BlockStructure, "id" | "type">,
  path: string,
  value: string
): boolean {
  return trustedOriginalAt(options, locale, block, path) === value
}

function trustedOriginalAt(
  options: WriteOptions,
  locale: string,
  block: Pick<BlockStructure, "id" | "type">,
  path: string
): unknown {
  const source = options.trustedSource
  if (
    !source?.recordId ||
    source.version === undefined ||
    !isRecord(source.content)
  )
    return undefined
  if (
    source.destinationLocale !== undefined &&
    source.destinationLocale !== locale
  )
    return undefined
  const localeContent = source.content[source.sourceLocale ?? locale]
  if (!isRecord(localeContent) || !Array.isArray(localeContent.blocks)) return undefined
  const matches = localeContent.blocks.filter(
    (row) => isRecord(row) && row.id === block.id && row.type === block.type
  )
  if (matches.length !== 1) return undefined
  let found: unknown = matches[0]
  for (const segment of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (!found || typeof found !== "object") return undefined
    found = (found as Record<string, unknown>)[segment]
  }
  return found
}

/** Recover an original occurrence by ordinal only after proving that the
 * server-owned repaired view differs solely in invalid sibling IDs. Titles
 * deliberately keep the original unique-ID lookup above.
 */
function repairedOriginalAt(
  options: WriteOptions,
  locale: string,
  block: Pick<BlockStructure, "id" | "type">,
  path: string
): unknown {
  const source = options.trustedSource
  if (
    !source?.recordId ||
    source.version === undefined ||
    !isRecord(source.content) ||
    !isRecord(source.repairedIdentityContent) ||
    (source.destinationLocale !== undefined &&
      source.destinationLocale !== locale)
  )
    return undefined
  const original = source.content[source.sourceLocale ?? locale]
  const repaired = source.repairedIdentityContent[source.sourceLocale ?? locale]
  if (
    !isRecord(original) ||
    !isRecord(repaired) ||
    !Array.isArray(original.blocks) ||
    !Array.isArray(repaired.blocks) ||
    original.blocks.length !== repaired.blocks.length
  )
    return undefined
  const originalRows = original.blocks
  const repairedRows = repaired.blocks
  if (!originalRows.every(isRecord) || !repairedRows.every(isRecord))
    return undefined
  const withoutIds = (rows: Record<string, unknown>[]) =>
    rows.map(({ id: _id, ...row }) => row)
  if (
    JSON.stringify({ ...original, blocks: withoutIds(originalRows) }) !==
    JSON.stringify({ ...repaired, blocks: withoutIds(repairedRows) })
  )
    return undefined
  const reserved = new Set(
    originalRows
      .map((row) => row.id)
      .filter((id): id is string => typeof id === "string" && !!id.trim())
  )
  const seenOriginal = new Set<string>()
  const seenRepaired = new Set<string>()
  for (let index = 0; index < originalRows.length; index++) {
    const originalId = originalRows[index].id
    const repairedId = repairedRows[index].id
    if (
      typeof repairedId !== "string" ||
      !repairedId.trim() ||
      seenRepaired.has(repairedId)
    )
      return undefined
    seenRepaired.add(repairedId)
    if (
      typeof originalId === "string" &&
      originalId.trim() &&
      !seenOriginal.has(originalId)
    ) {
      if (repairedId !== originalId) return undefined
      seenOriginal.add(originalId)
    } else if (reserved.has(repairedId)) return undefined
  }
  const index = repairedRows.findIndex(
    (row) => row.id === block.id && row.type === block.type
  )
  if (index < 0) return undefined
  let found: unknown = originalRows[index]
  for (const segment of path.replace(/\[(\d+)\]/g, ".$1").split(".")) {
    if (!found || typeof found !== "object") return undefined
    found = (found as Record<string, unknown>)[segment]
  }
  return found
}
/** The same source-bound exception is used before and after deterministic shaping.
 * The writer additionally supplies its original input, so a changed input can
 * never borrow a source's legacy exemption just by converging to its shape.
 */
export function preservesLegacyRichTextAt(
  options: WriteOptions,
  locale: string,
  block: Pick<BlockStructure, "id" | "type">,
  path: string,
  candidate: string,
  contract: ResolvedFieldContract,
  originalInput?: string
): boolean {
  if (!options.readLegacyShapes || contract.contract === "title") return false
  const source = options.trustedSource
  if (
    source?.sourceLocale !== undefined &&
    source.destinationLocale === undefined
  )
    return false
  const original = options.trustedSource?.repairedIdentityContent !== undefined
    ? repairedOriginalAt(options, locale, block, path)
    : trustedOriginalAt(options, locale, block, path)
  return (
    typeof original === "string" &&
    (originalInput === undefined || original === originalInput) &&
    validateLegacy(contract, original).ok &&
    toFieldShape(contract, original).value === candidate
  )
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

/** Descriptor-bound write conversion. Text values never pass through a parser. */
export function writePrimitive(
  def: Primitive,
  value: unknown,
  options: WriteOptions = {},
  report: (fieldPath: string, links: RemovedRichTextLink[]) => void = () => {},
  path = ""
): unknown {
  if (def.kind === "group") {
    if (!isRecord(value)) return value
    const next = { ...value }
    for (const [key, child] of Object.entries(
      def.config.fields as Record<string, Primitive>
    )) {
      if (key in value)
        next[key] = writePrimitive(
          child,
          value[key],
          options,
          report,
          path ? `${path}.${key}` : key
        )
    }
    return next
  }
  if (def.kind === "list") {
    if (!Array.isArray(value)) return value
    const item = def.config.item as Primitive
    return value.map((row, index) => {
      const source =
        item.validator.kind === "object" && (row === undefined || row === null)
          ? structuredClone(item.default ?? {})
          : row
      let next = writePrimitive(
        item,
        source,
        options,
        report,
        `${path}[${index}]`
      )
      if (item.validator.kind === "object") {
        next = isRecord(next) ? { ...next } : {}
        const record = next as Record<string, unknown>
        if (
          options.allocateItemIds !== false &&
          (options.duplicate ||
            typeof record.itemId !== "string" ||
            !record.itemId.trim())
        )
          record.itemId = (options.createId ?? (() => crypto.randomUUID()))()
      }
      return next
    })
  }
  if (
    options.identitiesOnly ||
    def.kind !== "richText" ||
    typeof value !== "string"
  )
    return value
  const contract = resolveFieldContract(def.config)
  if (contract.contract !== "title") {
    const candidate = options.readLegacyShapes
      ? toFieldShape(contract, value).value
      : value
    const checked = validateStrict(contract, candidate)
    if (
      !checked.ok &&
      !options.preserveLegacy?.(path, value, candidate, contract)
    )
      throw new ConvexError(`Invalid rich-text content: ${checked.error}`)
    return candidate
  }
  const transitioned = options.blockType
    ? convertTransitionTitle(
        { blockType: options.blockType, fieldPath: path },
        value
      )
    : undefined
  if (!transitioned && isLegacyTitleHtml(value)) {
    if (options.preserveHtml?.(path, value)) return value
    throw new ConvexError("TITLE_HTML_REQUIRES_EDITOR_ADOPTION")
  }
  const converted = transitioned ?? toFieldShape(contract, value)
  const checked = validateStrict(contract, converted.value)
  if (!checked.ok) throw new ConvexError(`Invalid title: ${checked.error}`)
  if (converted.removedLinks.length) report(path, converted.removedLinks)
  return converted.value
}

function writeBlockFields<T extends BlockStructure>(
  block: T,
  locale = "",
  options: WriteOptions = {}
) {
  const def = readBlockDefinition(readBlock(block).type)
  const reports: TitleWriteReport[] = []
  if (!def) return { value: block, reports }
  const report = (fieldPath: string, removedLinks: RemovedRichTextLink[]) =>
    reports.push({
      locale,
      blockId: readBlock(block).id,
      fieldPath,
      removedLinks,
    })
  const scoped = {
    ...options,
    blockType: readBlock(block).type,
    preserveHtml: (path: string, value: string) =>
      preservesTitleAtStructure(options, locale, block, path, value),
    preserveLegacy: (
      path: string,
      original: string,
      candidate: string,
      contract: ResolvedFieldContract
    ) =>
      preservesLegacyRichTextAt(
        options,
        locale,
        block,
        path,
        candidate,
        contract,
        original
      ),
  }
  const value = Object.assign({}, block, {
    primary: writePrimitive(
      def.primary,
      readBlock(block).primary,
      scoped,
      report,
      "primary"
    ),
  })
  if (def.items !== undefined && "items" in block)
    Object.assign(value, {
      items: writePrimitive(
        def.items,
        readBlock(block).items,
        scoped,
        report,
        "items"
      ),
    })
  return { value, reports }
}

const writeAdmittedBlockFields: (
  block: Block,
  locale?: string,
  options?: WriteOptions
) => { value: Block; reports: TitleWriteReport[] } = writeBlockFields

export { writeAdmittedBlockFields as writeBlockFields }

export function writeFieldMap(
  fields: Record<string, Primitive>,
  values: Record<string, unknown>,
  options: WriteOptions = {}
) {
  const next = { ...values }
  for (const [key, def] of Object.entries(fields))
    if (key in values)
      next[key] = writePrimitive(def, values[key], options, undefined, key)
  return next
}

export function writeLocaleContent(
  pageType: keyof typeof contentTypeDefs,
  content: Record<string, unknown>,
  locale: string,
  options: WriteOptions = {}
) {
  const value = writeFieldMap(
    contentTypeDefs[pageType].localizedFields,
    content,
    options
  )
  const reports: TitleWriteReport[] = []
  if (Array.isArray(content.blocks))
    value.blocks = content.blocks.map((block: BlockStructure) => {
      const converted = writeBlockFields(block, locale, options)
      reports.push(...converted.reports)
      return converted.value
    })
  return { value, reports }
}

export function writePageContent<T>(
  pageType: keyof typeof contentTypeDefs,
  content: T,
  options: WriteOptions = {}
): { value: T; reports: TitleWriteReport[] } {
  if (!isRecord(content)) return { value: content, reports: [] }
  const reports: TitleWriteReport[] = []
  const value = Object.fromEntries(
    Object.entries(content).map(([locale, localeContent]) => {
      if (!isRecord(localeContent)) return [locale, localeContent]
      const converted = writeLocaleContent(pageType, localeContent, locale, options)
      reports.push(...converted.reports)
      return [locale, converted.value]
    })
  )
  return { value: value as T, reports }
}

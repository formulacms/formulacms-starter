import { readSliceDefinition } from "@/convex/lib/slices"
import { readSlice } from "@/convex/lib/slices/identity"
import { walkValue } from "../slices/walk"
import { isLegacyTitleHtml } from "../richtext/write"
/**
 * Provider-neutral translation traversal shared by the Production Convex
 * localizer and local-development server actions.
 *
 * The caller owns authorization, model/process execution, concurrency,
 * auditing, persistence, and provider-specific limits. This module owns only
 * the structural contract for applying an async text translator to CMS data.
 */
import {
  collectTextSegments,
  parsePMDoc,
  replaceTextSegments,
} from "../richtext/pmText"
import { type Primitive, type Slice } from "../slices"
import { isTranslatableTextPrimitive } from "../slices/primitives"
import {
  readFieldText,
  readTransitionField,
  transitionForField,
  convertTransitionTitle,
} from "../richtext/transitions"
import { resolveFieldContract, type FieldAddress } from "../richtext/contracts"
import { toFieldShape } from "../richtext/shape"

export type TranslateText = (text: string) => Promise<string>

export interface TranslationTraversal {
  translateText: TranslateText
  /** Optional addressed port used to enumerate/replay the very same traversal. */
  atSegment?: (
    segment: Omit<PageTranslationSegment, "index">
  ) => Promise<string>
  path?: string
  segmentKind?: "text" | "richText"
  /** Preserve the input byte-for-byte when translation is a locale no-op. */
  enabled?: boolean
  /** Optional caller-owned limits/errors for a plain translatable segment. */
  validateText?: (text: string) => void
  /** Optional caller-owned limits/errors for a stored PM-JSON value. */
  validateRichText?: (json: string) => void
}

export interface TranslatableLeaf {
  path: string
  kind: "text" | "richText"
  value: string
}

export interface PageTranslationContent {
  title: string
  metaTitle?: string
  metaDescription?: string
  slices: readonly Slice[]
  translatables?: readonly TranslatableLeaf[]
}

/** Translate a plain string while preserving significant edge whitespace. */
export async function translatePlainText(
  text: string,
  traversal: TranslationTraversal
): Promise<string> {
  return translateSegmentText(text, traversal, true)
}

async function translateSegmentText(
  text: string,
  traversal: TranslationTraversal,
  preserveOnEmpty: boolean
): Promise<string> {
  if (traversal.enabled === false || !text.trim()) return text
  traversal.validateText?.(text)
  const leading = text.match(/^\s*/)?.[0] ?? ""
  const trailing = text.match(/\s*$/)?.[0] ?? ""
  const translated = (
    await (traversal.atSegment
      ? traversal.atSegment({
          text: text.trim(),
          address: traversal.path ?? "text",
          kind: traversal.segmentKind ?? "text",
        })
      : traversal.translateText(text.trim()))
  ).trim()
  return translated
    ? leading + translated + trailing
    : preserveOnEmpty
      ? text
      : ""
}

/** Translate PM text nodes while preserving every non-text node and mark. */
export async function translateRichText(
  json: string,
  traversal: TranslationTraversal
): Promise<string> {
  if (traversal.enabled === false) return json
  traversal.validateRichText?.(json)
  const doc = parsePMDoc(json)
  if (!doc) return json
  const segments = collectTextSegments(doc)
  if (segments.length === 0) return json
  const translated = await Promise.all(
    segments.map((segment, index) =>
      translateSegmentText(
        segment,
        {
          ...traversal,
          path: `${traversal.path ?? "text"}.text[${index}]`,
          segmentKind: "richText",
        },
        false
      )
    )
  )
  return JSON.stringify(replaceTextSegments(doc, translated))
}

/** Apply translation only to translatable leaves of one primitive value. */
export function assertTranslationInput(
  definition: Primitive,
  value: unknown,
  address?: FieldAddress
): void {
  walkValue(definition, value, (leaf) => {
    if (
      leaf.def.kind === "richText" &&
      resolveFieldContract(leaf.def.config).contract === "title" &&
      typeof leaf.value === "string" &&
      isLegacyTitleHtml(leaf.value) &&
      !transitionForField(
        address
          ? {
              ...address,
              fieldPath:
                address.fieldPath +
                (leaf.path
                  ? (leaf.path.startsWith("[") ? "" : ".") + leaf.path
                  : ""),
            }
          : undefined
      )
    )
      throw new Error("RICH_TEXT_REQUIRES_EDITOR_ADOPTION")
  })
}

export async function translatePrimitiveValue(
  definition: Primitive,
  value: unknown,
  traversal: TranslationTraversal,
  address?: FieldAddress
): Promise<unknown> {
  if (traversal.enabled === false) return value
  assertTranslationInput(definition, value, address)
  const leafTraversal = {
    ...traversal,
    path: `${traversal.path ?? "slice"}.${address?.fieldPath ?? "value"}`,
  }
  switch (definition.kind) {
    case "text":
      if (!isTranslatableTextPrimitive(definition)) return value
      return typeof value === "string"
        ? translatePlainText(readFieldText(address, value), leafTraversal)
        : value
    case "richText":
      if (
        resolveFieldContract(definition.config).contract === "title" &&
        typeof value === "string" &&
        isLegacyTitleHtml(value) &&
        !transitionForField(address)
      )
        throw new Error("RICH_TEXT_REQUIRES_EDITOR_ADOPTION")
      return typeof value === "string"
        ? translateRichText(
            // Parent title adoption owns diagnostics; retain PM links through translation.
            resolveFieldContract(definition.config).contract === "title"
              ? readTransitionField(address, value).kind === "plain"
                ? (convertTransitionTitle(address, value)?.value ?? value)
                : value
              : toFieldShape(
                  resolveFieldContract(
                    definition.config as {
                      profile?: "inline" | "basic" | "full"
                      contract?: "title" | "inline" | "basic" | "full"
                    }
                  ),
                  value
                ).value,
            leafTraversal
          )
        : value
    case "table": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return value
      }
      const tableValue = value as { headerRow?: unknown; rows?: unknown }
      return {
        ...(Array.isArray(tableValue.headerRow)
          ? {
              headerRow: await Promise.all(
                tableValue.headerRow.map((cell, index) =>
                  typeof cell === "string"
                    ? translatePlainText(cell, {
                        ...leafTraversal,
                        path: `${leafTraversal.path}.headerRow[${index}]`,
                      })
                    : cell
                )
              ),
            }
          : {}),
        rows: Array.isArray(tableValue.rows)
          ? await Promise.all(
              tableValue.rows.map((row, rowIndex) =>
                Array.isArray(row)
                  ? Promise.all(
                      row.map((cell, cellIndex) =>
                        typeof cell === "string"
                          ? translatePlainText(cell, {
                              ...leafTraversal,
                              path: `${leafTraversal.path}.rows[${rowIndex}][${cellIndex}]`,
                            })
                          : cell
                      )
                    )
                  : row
              )
            )
          : [],
      }
    }
    case "group": {
      const fields = definition.config.fields as Record<string, Primitive>
      const objectValue =
        value && typeof value === "object" && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : {}
      const translated: Record<string, unknown> = { ...objectValue }
      for (const [key, child] of Object.entries(fields)) {
        const childValue = await translatePrimitiveValue(
          child,
          objectValue[key],
          traversal,
          address
            ? { ...address, fieldPath: `${address.fieldPath}.${key}` }
            : undefined
        )
        if (childValue !== undefined) translated[key] = childValue
      }
      return translated
    }
    case "list": {
      const item = definition.config.item as Primitive
      return Promise.all(
        (Array.isArray(value) ? value : []).map((row, index) =>
          translatePrimitiveValue(
            item,
            row,
            traversal,
            address
              ? { ...address, fieldPath: `${address.fieldPath}[${index}]` }
              : undefined
          )
        )
      )
    }
    default:
      return value
  }
}

/** Translate the descriptor-declared content fields of one slice. */
export async function translateSlice(
  slice: Slice,
  traversal: TranslationTraversal
): Promise<Slice> {
  const definition = readSliceDefinition(readSlice(slice).type)
  if (!definition) throw new Error("Slice descriptor is unavailable.")
  const primary = (await translatePrimitiveValue(
    definition.primary,
    readSlice(slice).primary,
    traversal,
    { sliceType: readSlice(slice).type, fieldPath: "primary" }
  )) as Slice["primary"] | undefined
  const translated: Record<string, unknown> = Object.assign({}, slice, {
    primary: primary ?? readSlice(slice).primary,
  })
  if (definition.items !== undefined && "items" in slice) {
    translated.items = await translatePrimitiveValue(
      definition.items,
      (slice as { items?: unknown[] }).items,
      traversal,
      { sliceType: readSlice(slice).type, fieldPath: "items" }
    )
  }
  return translated as Slice
}

/** Translate one descriptor-provided text leaf while retaining its identity. */
export async function translateTranslatableLeaf(
  leaf: TranslatableLeaf,
  traversal: TranslationTraversal
): Promise<TranslatableLeaf> {
  return {
    path: leaf.path,
    kind: leaf.kind,
    value:
      leaf.kind === "richText"
        ? await translateRichText(leaf.value, traversal)
        : await translatePlainText(leaf.value, traversal),
  }
}

/** Translate one editor page payload without owning persistence or routing. */
export async function translatePageContent(
  page: PageTranslationContent,
  traversal: TranslationTraversal
): Promise<{
  title: string
  metaTitle?: string
  metaDescription?: string
  slices: Slice[]
  translatables: TranslatableLeaf[]
}> {
  if (traversal.enabled !== false)
    for (const slice of page.slices) {
      const definition = readSliceDefinition(readSlice(slice).type)
      if (!definition) throw new Error("Slice descriptor is unavailable.")
      assertTranslationInput(definition.primary, readSlice(slice).primary, {
        sliceType: readSlice(slice).type,
        fieldPath: "primary",
      })
      if (definition.items !== undefined && "items" in slice)
        assertTranslationInput(definition.items, readSlice(slice).items, {
          sliceType: readSlice(slice).type,
          fieldPath: "items",
        })
    }
  const [title, metaTitle, metaDescription, slices, translatables] =
    await Promise.all([
      translatePlainText(page.title, { ...traversal, path: "title" }),
      page.metaTitle !== undefined
        ? translatePlainText(page.metaTitle, {
            ...traversal,
            path: "metaTitle",
          })
        : undefined,
      page.metaDescription !== undefined
        ? translatePlainText(page.metaDescription, {
            ...traversal,
            path: "metaDescription",
          })
        : undefined,
      Promise.all(
        page.slices.map((slice, index) =>
          translateSlice(slice, { ...traversal, path: `slices[${index}]` })
        )
      ),
      Promise.all(
        (page.translatables ?? []).map((leaf, index) =>
          translateTranslatableLeaf(leaf, {
            ...traversal,
            path: `translatables[${index}].${leaf.path}`,
          })
        )
      ),
    ])
  return {
    title,
    ...(page.metaTitle !== undefined ? { metaTitle } : {}),
    ...(page.metaDescription !== undefined ? { metaDescription } : {}),
    slices,
    translatables,
  }
}

export interface PageTranslationSegment {
  index: number
  address: string
  kind: "text" | "richText"
  text: string
}

/** A source beyond the supported size; callers map it to their own refusal code. */
export class TranslationLimitError extends Error {}

/** Pin only actual provider calls, retaining the existing address/format rules. */
export async function enumerateSegments(
  page: PageTranslationContent
): Promise<PageTranslationSegment[]> {
  const segments: PageTranslationSegment[] = []
  await translatePageContent(page, {
    translateText: async (text) => text,
    validateText: (text) => {
      if (text.length > 5_000) throw new TranslationLimitError("Text too long.")
    },
    validateRichText: (json) => {
      if (json.length > 200_000)
        throw new TranslationLimitError("Rich text too large.")
    },
    atSegment: async (segment) => {
      segments.push({ ...segment, index: segments.length })
      return segment.text
    },
  })
  if (segments.length > 60)
    throw new TranslationLimitError("Too many translation segments.")
  return segments
}

export async function translateSegment(
  segment: PageTranslationSegment,
  translator: TranslateText
): Promise<string> {
  return translator(segment.text)
}

export async function assembleTranslation(
  page: PageTranslationContent,
  outputs: readonly { address: string; text: string }[]
): ReturnType<typeof translatePageContent> {
  const byAddress = new Map(
    outputs.map((output) => [output.address, output.text])
  )
  if (byAddress.size !== outputs.length)
    throw new Error("Duplicate translation address.")
  const consumed = new Set<string>()
  const result = await translatePageContent(page, {
    translateText: async (text) => text,
    atSegment: async (segment) => {
      const output = byAddress.get(segment.address)
      if (output === undefined) throw new Error("Missing translation output.")
      consumed.add(segment.address)
      return output
    },
  })
  if (consumed.size !== outputs.length)
    throw new Error("Unexpected translation output.")
  return result
}

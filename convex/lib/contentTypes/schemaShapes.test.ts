import { describe, expect, it } from "vitest"
import { v } from "convex/values"
import { text } from "../blocks/primitives"
import type { ContentTypeDescriptor } from "./types"
import type { Id } from "../../_generated/dataModel"
import { contentTypeDefs, REGISTERED_CONTENT_TYPES } from "./index"
import {
  armLocalizedContentValidator,
  armLocalizedContentValidatorFor,
  armLocalizedContentValidatorNoBlocks,
  buildPageLocaleDraftsValidator,
  buildPageSharedDraftsValidator,
} from "./schemaShapes"
import schema, {
  pageLocaleDraftsTableValidator,
  pageSharedDraftsTableValidator,
} from "../../schema"

/**
 * Synthetic testimonial-shaped descriptor — mirrors the shape plan 029 §C10
 * will register: `blockBody:false`, single localized `quote` field. Built here
 * so the pure-form path is exercised without shipping the real descriptor.
 */
const localizedFields = {
  quote: text({ multiline: true, placeholder: "Their words" }),
} as const

const testimonialDescriptor: ContentTypeDescriptor<
  Record<string, never>,
  typeof localizedFields
> = {
  type: "testimonial",
  label: { singular: "Testimonial", plural: "Testimonials" },
  sharedFields: {},
  localizedFields,
  sharedValidator: v.object({}),
  localizedValidator: v.object({ quote: localizedFields.quote.validator }),
  capabilities: {
    blockBody: false,
    revisions: false,
    scheduling: false,
    presence: false,
    requiresBodyContent: false,
  },
  referenceCard: (doc) => ({
    id: doc._id as Id<"pages">,
    type: "testimonial",
    title: "Testimonial",
  }),
}

describe("armLocalizedContentValidatorNoBlocks (plan 029 C8 dark-ship)", () => {
  it("omits `blocks` from the produced object shape", () => {
    const arm = armLocalizedContentValidatorNoBlocks(testimonialDescriptor)
    // Convex `v.object({...})` exposes its shape via `.fields`.
    // `seo` and `cardExcerpt` are the per-language fields every arm carries
    // (ADR-0037 amendment, 2026-11-17).
    expect(Object.keys(arm.fields)).toEqual(["quote", "seo", "cardExcerpt"])
    expect(arm.fields).not.toHaveProperty("blocks")
  })

  it("preserves the descriptor's declared localized fields", () => {
    const arm = armLocalizedContentValidatorNoBlocks(testimonialDescriptor)
    // Same validator reference (structural identity — no wrapping).
    expect(arm.fields.quote).toBe(localizedFields.quote.validator)
  })

  it("stays in lockstep with the block-bearing counterpart: same fields minus `blocks`", () => {
    const withBlocks = armLocalizedContentValidator(testimonialDescriptor)
    const pure = armLocalizedContentValidatorNoBlocks(testimonialDescriptor)
    const withBlocksKeys = Object.keys(withBlocks.fields).filter((k) => k !== "blocks")
    const pureKeys = Object.keys(pure.fields)
    expect(pureKeys).toEqual(withBlocksKeys)
    expect(withBlocks.fields).toHaveProperty("blocks")
    expect(pure.fields).not.toHaveProperty("blocks")
  })
})

// ─── Publication draft tables are derived from the registry ──────────────

type ArmJson = {
  type: "object"
  value: Record<string, { fieldType: { type: string; value?: unknown } }>
}

function arms(validator: unknown): ArmJson[] {
  return (validator as { json: { value: ArmJson[] } }).json.value
}

const pageTypesOf = (validator: unknown) =>
  arms(validator).map((arm) => arm.value.pageType.fieldType.value)

const bookkeeping = { pageId: v.id("pages") } as const

const formFields = { question: text({ placeholder: "Question" }) } as const

/** A content type added after the shipped six: a block body and a form-only one. */
const newTypes = {
  ...contentTypeDefs,
  "faq-item": {
    ...testimonialDescriptor,
    type: "faq-item",
    localizedValidator: v.object({ question: formFields.question.validator }),
    capabilities: { ...testimonialDescriptor.capabilities, blockBody: true },
  },
  "form-only": {
    ...testimonialDescriptor,
    type: "form-only",
  },
}

describe("draft table validators", () => {
  it("armLocalizedContentValidatorFor follows the blockBody capability", () => {
    expect(
      armLocalizedContentValidatorFor(testimonialDescriptor).fields
    ).not.toHaveProperty("blocks")
    expect(
      armLocalizedContentValidatorFor(contentTypeDefs.post).fields
    ).toHaveProperty("blocks")
  })

  it("the schema's draft tables have one arm per registered type, in registry order", () => {
    expect(pageTypesOf(pageSharedDraftsTableValidator)).toEqual(
      REGISTERED_CONTENT_TYPES
    )
    expect(pageTypesOf(pageLocaleDraftsTableValidator)).toEqual(
      REGISTERED_CONTENT_TYPES
    )
  })

  it("the schema's locale draft arms carry blocks exactly for blockBody types", () => {
    for (const arm of arms(pageLocaleDraftsTableValidator)) {
      const type = arm.value.pageType.fieldType.value as string
      const content = arm.value.content.fieldType as unknown as ArmJson
      expect("blocks" in content.value).toBe(
        contentTypeDefs[type as keyof typeof contentTypeDefs].capabilities
          .blockBody
      )
    }
  })

  it("a type added to the registry gets a shared and a locale draft arm", () => {
    const shared = buildPageSharedDraftsValidator(bookkeeping, newTypes)
    const locale = buildPageLocaleDraftsValidator<
      typeof bookkeeping,
      { pageType: string }
    >(bookkeeping, newTypes)
    expect(pageTypesOf(shared)).toEqual([...REGISTERED_CONTENT_TYPES, "faq-item", "form-only"])
    expect(pageTypesOf(locale)).toEqual([...REGISTERED_CONTENT_TYPES, "faq-item", "form-only"])
    const byType = (validator: unknown, type: string) =>
      arms(validator).find((a) => a.value.pageType.fieldType.value === type)!
    const faqContent = byType(locale, "faq-item").value.content
      .fieldType as unknown as ArmJson
    expect(faqContent.value).toHaveProperty("question")
    expect(faqContent.value).toHaveProperty("blocks")
    const formContent = byType(locale, "form-only").value.content
      .fieldType as unknown as ArmJson
    expect(formContent.value).not.toHaveProperty("blocks")
    expect(byType(shared, "faq-item").value).toHaveProperty("descriptor")
  })
})

// ─── Draft table index paths ──────────────────────────────────────────────

// The draft tables are typed with `FieldPaths = string`, so tsc does not catch
// a typo in an index field. Convex index fields may be dot-separated paths
// into nested objects (https://docs.convex.dev/database/reading-data/indexes/).
type JsonNode = {
  type: string
  value?: unknown
}

function hasFieldPath(node: JsonNode, segments: readonly string[]): boolean {
  if (segments.length === 0) return true
  if (node.type === "union") {
    const members = node.value as JsonNode[]
    return members.length > 0 && members.every((m) => hasFieldPath(m, segments))
  }
  if (node.type !== "object") return false
  const [head, ...rest] = segments
  const field = (node.value as Record<string, { fieldType: JsonNode }>)[head]
  return field !== undefined && hasFieldPath(field.fieldType, rest)
}

/** Index field paths missing from at least one union arm of the table. */
function missingIndexPaths(
  validator: unknown,
  indexes: readonly { indexDescriptor: string; fields: string[] }[]
): string[] {
  const missing: string[] = []
  for (const index of indexes) {
    for (const path of index.fields) {
      for (const arm of arms(validator)) {
        if (!hasFieldPath(arm as JsonNode, path.split("."))) {
          missing.push(
            `${index.indexDescriptor}.${path} (${String(arm.value.pageType.fieldType.value)})`
          )
        }
      }
    }
  }
  return missing
}

describe("draft table index paths", () => {
  for (const table of ["pageSharedDrafts", "pageLocaleDrafts"] as const) {
    it(`every ${table} index field exists in every arm`, () => {
      const definition = schema.tables[table]
      // Experimental public accessor of the table's declared indexes.
      const indexes = definition[" indexes"]()
      expect(indexes.length).toBeGreaterThan(0)
      expect(arms(definition.validator).length).toBe(
        REGISTERED_CONTENT_TYPES.length
      )
      expect(missingIndexPaths(definition.validator, indexes)).toEqual([])
    })
  }

  it("reports a misspelled or missing index path", () => {
    const validator = schema.tables.pageSharedDrafts.validator
    expect(
      missingIndexPaths(validator, [
        { indexDescriptor: "by_typo", fields: ["system.parentid", "pageId"] },
      ])
    ).toEqual(
      REGISTERED_CONTENT_TYPES.map((type) => `by_typo.system.parentid (${type})`)
    )
  })
})

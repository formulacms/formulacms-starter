import { describe, expect, it } from "vitest"
import { v } from "convex/values"
import { text } from "../blocks/primitives"
import { contentTypeDefs, REGISTERED_CONTENT_TYPES } from "./index"
import { publicFieldsOf } from "./exposure"
import {
  buildPublicPageValidator,
  publicPageValidator,
  publicSeoValidator,
} from "./publicValidator"
import type { ContentTypeDescriptor } from "./types"
import type { Id } from "../../_generated/dataModel"

type Json = {
  type: string
  value: Record<string, { fieldType: { type: string; value?: unknown } }>
}

const armsOf = (validator: unknown) =>
  (validator as { json: { value: Json[] } }).json.value

const typeOf = (arm: Json) => arm.value.pageType.fieldType.value as string

/** The field map of `content[locale]` of one arm. */
const localeBody = (arm: Json) =>
  (
    arm.value.content.fieldType as unknown as {
      values: { fieldType: { value: Record<string, unknown> } }
    }
  ).values.fieldType.value

describe("public page validator (derived from the descriptors)", () => {
  it("has one strict arm per registered type, in registry order", () => {
    expect(armsOf(publicPageValidator).map(typeOf)).toEqual(
      REGISTERED_CONTENT_TYPES
    )
  })

  it("each arm holds the system allowlist, pageType and the .public() shared fields only", () => {
    for (const arm of armsOf(publicPageValidator)) {
      const type = typeOf(arm) as keyof typeof contentTypeDefs
      const shared = Object.keys(
        publicFieldsOf(contentTypeDefs[type].sharedFields)
      )
      expect(Object.keys(arm.value).sort()).toEqual(
        [
          "_id",
          "updatedAt",
          "publishedAt",
          "seo",
          "pageType",
          "content",
          ...shared,
        ].sort()
      )
    }
  })

  it("each locale body holds the .public() localized fields, plus blocks for block-body types", () => {
    for (const arm of armsOf(publicPageValidator)) {
      const type = typeOf(arm) as keyof typeof contentTypeDefs
      const descriptor = contentTypeDefs[type]
      const body = localeBody(arm)
      const expected = [
        ...Object.keys(publicFieldsOf(descriptor.localizedFields)),
        ...(descriptor.capabilities.blockBody ? ["blocks"] : []),
      ]
      expect(Object.keys(body).sort()).toEqual(expected.sort())
    }
  })

  it("keeps admin-only fields out of the public SEO shape", () => {
    const keys = Object.keys(publicSeoValidator.fields)
    expect(keys).not.toContain("focusKeyword")
    expect(keys).not.toContain("canonicalUrl")
    expect(keys).not.toContain("seoScore")
    expect(keys).toContain("metaTitle")
  })

  it("a content type added to the registry gets its own arm with no edit", () => {
    const quote = text().public()
    const internal = text()
    const fake: ContentTypeDescriptor = {
      type: "faq-item",
      label: { singular: "FAQ", plural: "FAQs" },
      sharedFields: { topic: quote },
      localizedFields: { answer: quote, note: internal },
      sharedValidator: v.object({
        topic: quote.validator,
      }) as never,
      localizedValidator: v.object({
        answer: quote.validator,
        note: internal.validator,
      }) as never,
      capabilities: {
        blockBody: false,
        revisions: false,
        scheduling: false,
        presence: false,
        requiresBodyContent: false,
      },
      referenceCard: (doc) => ({
        id: doc._id as Id<"pages">,
        type: "faq-item",
        title: "FAQ",
      }),
    }
    const arms = armsOf(
      buildPublicPageValidator({ ...contentTypeDefs, "faq-item": fake })
    )
    const faq = arms.find((arm) => typeOf(arm) === "faq-item")
    expect(faq).toBeDefined()
    expect(faq!.value).toHaveProperty("topic")
    expect(Object.keys(localeBody(faq!))).toEqual(["answer"])
  })
})

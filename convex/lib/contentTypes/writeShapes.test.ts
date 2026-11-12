import { describe, expect, it } from "vitest"
import { v } from "convex/values"
import { boolean, text } from "../slices/primitives"
import { jobContentType } from "./job"
import { postContentType } from "./post"
import { SYSTEM_OWNED_SHARED_FIELDS } from "./fieldOwnership"
import type { ContentTypeDescriptor } from "./types"
import {
  buildInitialLocalizedContent,
  copyDescriptorSharedFields,
  descriptorDefaults,
  parseDescriptorSharedFieldPatch,
} from "./writeShapes"

const sharedFields = {
  venue: text(),
  featured: boolean({ default: false }).optional(),
} as const
const localizedFields = {
  title: text(),
  summary: text({ multiline: true }).optional(),
} as const

const eventDescriptor = {
  type: "event",
  label: { singular: "Event", plural: "Events" },
  sharedFields,
  localizedFields,
  sharedValidator: v.object({
    venue: sharedFields.venue.validator,
    featured: sharedFields.featured.validator,
  }),
  localizedValidator: v.object({
    title: localizedFields.title.validator,
    summary: localizedFields.summary.validator,
  }),
  routing: { pathPrefix: "events" },
  capabilities: {
    sliceBody: true,
    revisions: true,
    scheduling: true,
    presence: true,
    requiresBodyContent: false,
  },
  referenceCard: (doc) => ({
    id: doc._id,
    type: "event",
    title: "Event",
  }),
} satisfies ContentTypeDescriptor<typeof sharedFields, typeof localizedFields>

describe("descriptor-driven write shapes", () => {
  it("materializes defaults and builds a slice-body locale without type branches", () => {
    expect(descriptorDefaults(eventDescriptor.sharedFields)).toEqual({
      venue: "",
      featured: false,
    })
    expect(
      buildInitialLocalizedContent(
        eventDescriptor,
        { en: { title: "Launch", slices: [] } },
        "en",
        "Ignored"
      )
    ).toEqual({
      en: {
        title: "Launch",
        slices: [],
      },
    })
  })

  it("copies and decodes arbitrary descriptor shared fields", () => {
    expect(
      copyDescriptorSharedFields(eventDescriptor, {
        venue: "Hall A",
        featured: true,
        unrelated: "drop me",
      })
    ).toEqual({ venue: "Hall A", featured: true })

    expect(
      parseDescriptorSharedFieldPatch(
        eventDescriptor,
        JSON.stringify({ venue: "Hall B", featured: null })
      )
    ).toEqual({ venue: "Hall B", featured: null })
  })

  it("rejects undeclared, excluded, and empty required fields", () => {
    expect(() =>
      parseDescriptorSharedFieldPatch(
        eventDescriptor,
        JSON.stringify({ productSku: "not an event field" })
      )
    ).toThrow('Shared field "productSku" is not declared')

    expect(() =>
      parseDescriptorSharedFieldPatch(
        eventDescriptor,
        JSON.stringify({ featured: true }),
        new Set(["featured"])
      )
    ).toThrow('Shared field "featured" must use its dedicated mutation')

    expect(() =>
      parseDescriptorSharedFieldPatch(
        eventDescriptor,
        JSON.stringify({ venue: "" })
      )
    ).toThrow('Required shared field "venue" cannot be empty')
  })

  it("accepts generic post flags while preserving dedicated post fields", () => {
    expect(
      parseDescriptorSharedFieldPatch(
        postContentType,
        JSON.stringify({ featured: true, promoteToFront: true }),
        SYSTEM_OWNED_SHARED_FIELDS
      )
    ).toEqual({ featured: true, promoteToFront: true })

    expect(() =>
      parseDescriptorSharedFieldPatch(
        postContentType,
        JSON.stringify({ tags: ["news"] }),
        SYSTEM_OWNED_SHARED_FIELDS
      )
    ).toThrow('Shared field "tags" must use its dedicated mutation')
  })

  it("writes the job salary range on create instead of leaving it absent", () => {
    // `createPage` seeds shared fields with `includeOptional: false`, so an
    // optional field is skipped even when it has a default. That is what let a
    // job row exist with no `salaryMin` at all while the descriptor claimed a
    // default of 0 — two ways to mean "no salary given", indistinguishable to
    // every reader. Marking them required is what makes the default reach the
    // row; this pins that so `.optional()` cannot quietly come back.
    const created = descriptorDefaults(jobContentType.sharedFields, {
      includeOptional: false,
    })

    expect(created.salaryMin).toBe(0)
    expect(created.salaryMax).toBe(0)
    expect(jobContentType.sharedFields.salaryMin.validator.isOptional).toBe(
      "required"
    )
    expect(jobContentType.sharedFields.salaryMax.validator.isOptional).toBe(
      "required"
    )
  })
})

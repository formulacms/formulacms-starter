import { describe, expect, it } from "vitest"
import { v } from "convex/values"
import { text } from "../slices/primitives"
import type { ContentTypeDescriptor } from "./types"
import type { Id } from "../../_generated/dataModel"
import {
  armLocalizedContentValidator,
  armLocalizedContentValidatorNoSlices,
} from "./schemaShapes"

/**
 * Synthetic testimonial-shaped descriptor — mirrors the shape plan 029 §C10
 * will register: `sliceBody:false`, single localized `quote` field. Built here
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
    sliceBody: false,
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

describe("armLocalizedContentValidatorNoSlices (plan 029 C8 dark-ship)", () => {
  it("omits `slices` from the produced object shape", () => {
    const arm = armLocalizedContentValidatorNoSlices(testimonialDescriptor)
    // Convex `v.object({...})` exposes its shape via `.fields`.
    expect(Object.keys(arm.fields)).toEqual(["quote"])
    expect(arm.fields).not.toHaveProperty("slices")
  })

  it("preserves the descriptor's declared localized fields", () => {
    const arm = armLocalizedContentValidatorNoSlices(testimonialDescriptor)
    // Same validator reference (structural identity — no wrapping).
    expect(arm.fields.quote).toBe(localizedFields.quote.validator)
  })

  it("stays in lockstep with the sliced counterpart: same fields minus `slices`", () => {
    const sliced = armLocalizedContentValidator(testimonialDescriptor)
    const pure = armLocalizedContentValidatorNoSlices(testimonialDescriptor)
    const slicedKeys = Object.keys(sliced.fields).filter((k) => k !== "slices")
    const pureKeys = Object.keys(pure.fields)
    expect(pureKeys).toEqual(slicedKeys)
    expect(sliced.fields).toHaveProperty("slices")
    expect(pure.fields).not.toHaveProperty("slices")
  })
})

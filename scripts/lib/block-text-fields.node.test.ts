import { describe, expect, test } from "vitest"
import { INSTALLED_BLOCK_TYPES } from "@/convex/lib/blocks"
import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { sampleFields } from "@/app/(sim)/block-sim/[type]/sim-sample-state"
import {
  SIM_TEXT_FIELD_LIMIT,
  describeTextFields,
  sampleTextPaths,
} from "./block-text-fields"

describe("block text fields for the click check", () => {
  // The check's field 11 must be the simulator's field 11.
  test("lists every installed block's fields in the simulator's order", () => {
    for (const type of INSTALLED_BLOCK_TYPES) {
      const paths = sampleTextPaths(type)
      expect(paths.length, type).toBeGreaterThan(0)
      expect(paths.slice(0, SIM_TEXT_FIELD_LIMIT), type).toEqual(
        sampleFields(createSampleBlock(type)).map((field) => field.path)
      )
    }
  })

  test("lets a block without text pass with a note", () => {
    expect(describeTextFields("image-band", [])).toEqual({
      note: "image-band: no text field to click; click checks skipped.",
    })
  })

  test("names the fields past the simulator's limit instead of passing them silently", () => {
    const paths = Array.from({ length: 12 }, (_, index) => `items.${index}.label`)
    expect(describeTextFields("long-list", paths)).toEqual({
      warning: "long-list: fields 11+ not clicked: items.10.label, items.11.label",
    })
    expect(describeTextFields("long-list", paths.slice(0, 10))).toEqual({})
  })
})

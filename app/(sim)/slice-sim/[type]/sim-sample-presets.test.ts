import { sliceProfile } from "@/test-utils/slice-profile"
import { expect, test } from "vitest"
import { createSampleSlice } from "@/lib/slices/sample"
import { sampleFields, validSampleValue } from "./sim-sample-state"
import { buildSamplePresets, sampleTextLength } from "./sim-sample-presets"
for (const profileRow of [
  "hero-agency",
  "hero-with-image",
  "features-icon-grid",
  "faq-simple",
  "rich-text-body",
] as const) {
  test.each([profileRow])("%s presets use actual fields/contracts and French copy is about1.4x Short", sliceProfile([]),
    (type) => {
      const fields = sampleFields(createSampleSlice(type))
      const presets = buildSamplePresets(type, fields)
      for (const values of Object.values(presets)) {
        expect(Object.keys(values).length).toBeLessThanOrEqual(10)
        expect(Object.keys(values).length).toBeGreaterThan(0)
        for (const [path, value] of Object.entries(values)) {
          expect(path).not.toMatch(/\.id$/)
          expect(
            validSampleValue(
              fields.find((field) => field.path === path)!,
              value
            )
          ).toBe(true)
        }
      }
      expect(sampleTextLength(presets.stress, fields)).toBeGreaterThan(
        sampleTextLength(presets.default, fields)
      )
      const ratio =
        sampleTextLength(presets.french, fields) /
        sampleTextLength(presets.default, fields)
      expect(ratio).toBeGreaterThanOrEqual(1.35)
      expect(ratio).toBeLessThanOrEqual(1.45)
      expect(Object.values(presets.french).join(" ")).toMatch(/[éèêàçùîœ]/)
      const cards = Object.entries(presets.default)
        .filter(([path]) => /^items\.\d+\.(title|question)$/.test(path))
        .map(([, value]) => value)
      expect(new Set(cards).size).toBe(cards.length)
    }
  )
}

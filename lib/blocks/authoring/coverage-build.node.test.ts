import { createElement } from "react"
import { describe, expect, test } from "vitest"
import { group, list, text, richText, type Block } from "@/convex/lib/blocks"
import { bindBlockFields, RichText, Text } from "@/components/block-kit"
import type { BlockRenderContext } from "@/lib/blocks/links"
import { COVERAGE_EXCLUSIONS, LEGACY_WHOLE_BLOCK_TYPE } from "./field-coverage"
import { coverageReport } from "./coverage-report"
import {
  checkBlockFieldCoverage,
  checkPresentationCoverage,
} from "./verify-coverage"

// Synthetic owner block: the build step must hold for blocks an owner writes,
// so these cases never depend on the shipped example catalog.
const def = {
  primary: group({
    eyebrow: text().optional(),
    heading: richText({ profile: "inline" }),
  }),
  items: list(group({ title: text() })),
}
const entry = {
  type: "owner-steps",
  presentation: "default",
  rendererSource: "components/blocks/owner-steps.tsx",
}
const renderer = (
  options: {
    skipEyebrow?: boolean
    hideEyebrow?: boolean
    skipRows?: boolean
    throws?: boolean
  } = {}
) =>
  function renderOwnerSteps(block: Block, ctx: BlockRenderContext) {
    if (options.throws)
      throw new Error("Cannot read properties of undefined (reading 'map')")
    const fields = bindBlockFields(def, block)
    const rows = (block as unknown as { items: unknown[] }).items
    return createElement(
      "section",
      null,
      options.hideEyebrow
        ? null
        : options.skipEyebrow
          ? createElement(
              "p",
              null,
              (block as unknown as { primary: { eyebrow: string } }).primary
                .eyebrow
            )
          : createElement(Text, {
              fields,
              fieldPath: "primary.eyebrow" as never,
              ctx,
            }),
      createElement(RichText, {
        fields,
        fieldPath: "primary.heading" as never,
        ctx,
      }),
      rows.map((row, index) =>
        options.skipRows
          ? createElement(
              "span",
              { key: index },
              (row as { title: string }).title
            )
          : createElement(Text, {
              key: index,
              fields,
              fieldPath: `items[${index}].title` as never,
              ctx,
            })
      )
    )
  }

describe("block field coverage in pnpm build", () => {
  test("a block that binds every field passes", () => {
    const outcome = checkPresentationCoverage(entry, def, renderer())
    expect(outcome).toMatchObject({ outcome: "passed", fields: 4 })
    expect(coverageReport([outcome]).passed).toBe(true)
  })

  test("a field without its click marker fails and names the file, presentation, path and repair", () => {
    const outcome = checkPresentationCoverage(
      entry,
      def,
      renderer({ skipEyebrow: true })
    )
    expect(outcome.outcome).toBe("failed")
    const { passed, text } = coverageReport([outcome])
    expect(passed).toBe(false)
    expect(text).toContain(
      "Block field coverage failed: components/blocks/owner-steps.tsx (block owner-steps, presentation default)."
    )
    expect(text).toContain(
      "primary.eyebrow (text): has no click marker in the rendered block."
    )
    expect(text).toContain(
      'Bind it with <Text> fieldPath="primary.eyebrow" from @/components/block-kit, or wrap its element with ctx.previewField({ fieldPath: "primary.eyebrow", kind: "text", rendered }), then run pnpm build again.'
    )
    expect(text).toContain(
      'If this field is shown only for some values, the build sample hides it: list it in COVERAGE_EXCLUSIONS in lib/blocks/authoring/field-coverage.ts with status "structural" and a reason, then run pnpm build again.'
    )
    expect(text).not.toContain("items[].title")
  })

  test("a structural exclusion clears a field the build sample hides", () => {
    const hidden = renderer({ hideEyebrow: true })
    expect(checkPresentationCoverage(entry, def, hidden).outcome).toBe("failed")
    const outcome = checkPresentationCoverage(entry, def, hidden, [
      ...COVERAGE_EXCLUSIONS,
      {
        type: "owner-steps",
        path: "primary.eyebrow",
        status: "structural",
        reason: "Shown only on the launch campaign.",
      },
    ])
    expect(outcome).toMatchObject({ outcome: "passed", fields: 3 })
  })

  test("a list field without its marker is reported once, with the row path", () => {
    const { text } = coverageReport([
      checkPresentationCoverage(entry, def, renderer({ skipRows: true })),
    ])
    expect(
      text.split("items[].title (text): has no click marker")
    ).toHaveLength(2)
    expect(text).toContain(
      'Bind it with <Text> fieldPath={`items[${index}].title`} from @/components/block-kit, or wrap its element with ctx.previewField({ fieldPath: `items[${index}].title`, kind: "text", rendered })'
    )
  })

  test("a renderer that throws is unverified, never a failure", () => {
    const outcome = checkPresentationCoverage(
      entry,
      def,
      renderer({ throws: true })
    )
    expect(outcome).toMatchObject({
      outcome: "unverified",
      error: "Cannot read properties of undefined (reading 'map')",
    })
    const { passed, text } = coverageReport([outcome])
    expect(passed).toBe(true)
    expect(text).toContain(
      "Block field coverage unverified: components/blocks/owner-steps.tsx (block owner-steps, presentation default) could not render."
    )
    expect(text).toContain("The build continues.")
  })

  test("renderers that cannot load leave the whole catalog unverified", () => {
    const { passed, text } = coverageReport({
      catalogError: "Cannot find module './promo'",
    })
    expect(passed).toBe(true)
    expect(text).toContain("unverified for the whole block catalog")
    expect(text).toContain("Cannot find module './promo'")
  })

  // A starter that prunes the legacy block may not name it in a test: read
  // its type from the field-coverage source.
  test("the legacy CTA band is reported with 0 fields covered", () => {
    const outcome = checkPresentationCoverage(
      { ...entry, type: LEGACY_WHOLE_BLOCK_TYPE },
      def,
      renderer({ throws: true })
    )
    expect(outcome.outcome).toBe("legacy")
    expect(coverageReport([outcome]).text).toContain(
      `${LEGACY_WHOLE_BLOCK_TYPE}/default: legacy, 0 fields covered.`
    )
  })

  test("only the legacy CTA band may skip coverage as a whole", () => {
    expect(
      COVERAGE_EXCLUSIONS.filter((exclusion) => exclusion.path === "*").map(
        ({ type }) => type
      )
    ).toEqual([LEGACY_WHOLE_BLOCK_TYPE])
    const outcome = checkPresentationCoverage(entry, def, renderer(), [
      ...COVERAGE_EXCLUSIONS,
      { type: "owner-steps", path: "*", status: "legacy", reason: "Skip it." },
    ])
    expect(outcome.outcome).toBe("failed")
    expect(coverageReport([outcome]).text).toContain(
      `only the legacy ${LEGACY_WHOLE_BLOCK_TYPE} block may skip field coverage as a whole`
    )
  })

  test("every registered presentation passes or is the legacy CTA band", async () => {
    const outcomes = await checkBlockFieldCoverage()
    expect(outcomes.length).toBeGreaterThan(0)
    for (const outcome of outcomes)
      expect([outcome.type, outcome.outcome]).toEqual([
        outcome.type,
        outcome.type === LEGACY_WHOLE_BLOCK_TYPE ? "legacy" : "passed",
      ])
  })
})

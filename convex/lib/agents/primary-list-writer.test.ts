import { describe, expect, test, vi } from "vitest"
import { v } from "convex/values"
import { validate } from "convex-helpers/validators"
import * as writeModule from "../richtext/write"
import { validateStrict } from "../richtext/strict"
import { resolveFieldContract } from "../richtext/contracts"
import { installedSliceDefs, installedSliceValidator, sliceDefs } from "../slices"
import { button } from "../slices/fields"
import { group, image, link, list, relation, richText, select, text } from "../slices/primitives"
import {
  assembleSlice,
  buildPageFillGenerationInput,
  buildSliceGenerationInput,
} from "./contentWriterContract"

// These tests install complete synthetic descriptors; keep their real schema live.
vi.mock("../slices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../slices")>()
  const { v } = await import("convex/values")
  const { withSliceOccurrencePresentation } = await import("../slices/occurrencePresentation")
  return {
    ...actual,
    get installedSliceValidator() {
      return v.union(...actual.INSTALLED_SLICE_TYPES.map((type) =>
        withSliceOccurrencePresentation<unknown, Record<string, import("convex/values").GenericValidator>>(
          actual.installedSliceDefs[type].validator
        )
      ))
    },
  }
})

const testType = "rich-text-body" as const

function withSyntheticLists<T>(run: (primary: ReturnType<typeof makePrimary>) => T): T {
  const previousSlice = sliceDefs[testType]
  const previousInstalled = installedSliceDefs[testType]
  const primary = makePrimary()
  const synthetic = {
    ...previousInstalled,
    primary,
    validator: v.object({ ...previousInstalled.validator.fields, primary: primary.validator }),
    aiHint: {
      ...previousInstalled.aiHint,
      fields: "Write the section's scalar content.",
    },
  }
  Reflect.set(sliceDefs, testType, synthetic)
  Reflect.set(installedSliceDefs, testType, synthetic)
  try {
    return run(primary)
  } finally {
    Reflect.set(sliceDefs, testType, previousSlice)
    Reflect.set(installedSliceDefs, testType, previousInstalled)
  }
}

function makePrimary() {
  return group({
    headline: richText({ contract: "title", heading: { role: "sliceTitle" } }),
    cards: list(
      group({
        cardName: richText({ contract: "title", heading: { role: "itemTitle" } }),
        body: richText({ contract: "inline" }),
        questions: list(
          group({ question: text(), answer: richText({ contract: "inline" }) }),
          { max: 2, min: 1 }
        ),
        image: image(),
        destination: link(),
        relatedPage: relation({ pageTypes: ["page"] }),
        style: select({ options: ["plain", "featured"], default: "plain" }),
        identity: text({ editorial: false }),
        action: button,
      }),
      { max: 2, min: 1 }
    ),
    benefits: list(group({ label: text() }), { max: 2, min: 1 }),
    steps: list(group({ description: text() }), { max: 2 }),
  })
}

function withEditorialValidationLists<T>(run: (primary: ReturnType<typeof makeEditorialValidationPrimary>) => T): T {
  const previousSlice = sliceDefs[testType]
  const previousInstalled = installedSliceDefs[testType]
  const primary = makeEditorialValidationPrimary()
  const synthetic = {
    ...previousInstalled,
    primary,
    validator: v.object({ ...previousInstalled.validator.fields, primary: primary.validator }),
    aiHint: {
      ...previousInstalled.aiHint,
      fields: "Write the section's scalar content.",
    },
  }
  Reflect.set(sliceDefs, testType, synthetic)
  Reflect.set(installedSliceDefs, testType, synthetic)
  try {
    return run(primary)
  } finally {
    Reflect.set(sliceDefs, testType, previousSlice)
    Reflect.set(installedSliceDefs, testType, previousInstalled)
  }
}

function makeEditorialValidationPrimary() {
  const editorialLeaves = () => ({
    plainText: text(),
    titleText: richText({ contract: "title", heading: { role: "itemTitle" } }),
    inlineText: richText({ contract: "inline" }),
    basicText: richText({ contract: "basic" }),
    fullText: richText({ contract: "full" }),
  })
  return group({
    depthOne: list(group(editorialLeaves()), { max: 2, min: 1 }),
    depthTwo: list(
      group({ nested: list(group(editorialLeaves()), { max: 2, min: 1 }) }),
      { max: 2, min: 1 }
    ),
  })
}

function requireTestRecord(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Expected ${context} to be an object`)
  return value as Record<string, unknown>
}

function validateEditorialRichTextBeforeWrite(
  definition: unknown,
  value: unknown,
  validate: (config: Record<string, unknown>, json: string) => void
): void {
  const visit = (currentDefinition: unknown, currentValue: unknown): void => {
    const primitive = requireTestRecord(currentDefinition, "primitive descriptor")
    const config = requireTestRecord(primitive.config, "primitive config")
    if (primitive.kind === "list") {
      if (Array.isArray(currentValue))
        for (const row of currentValue) visit(config.item, row)
      return
    }
    if (primitive.kind === "group") {
      if (!currentValue || typeof currentValue !== "object" || Array.isArray(currentValue)) return
      const fields = requireTestRecord(config.fields, "group fields")
      const values = requireTestRecord(currentValue, "group value")
      for (const [key, child] of Object.entries(fields))
        if (Object.hasOwn(values, key)) visit(child, values[key])
      return
    }
    if (primitive.kind === "richText" && typeof currentValue === "string")
      validate(config, currentValue)
  }
  visit(definition, value)
}

function primaryListRows(value: unknown, depth: 1 | 2): unknown[] {
  const primary = requireTestRecord(value, "slice primary value")
  const rows = primary[depth === 1 ? "depthOne" : "depthTwo"]
  if (!Array.isArray(rows)) throw new Error(`Expected depth ${depth} rows`)
  if (depth === 1) return rows
  const first = rows[0]
  const nested = requireTestRecord(first, "depth two row").nested
  if (!Array.isArray(nested)) throw new Error("Expected nested depth two rows")
  return nested
}

function decodedRichText(value: unknown): { text: string; content: unknown[] } {
  if (typeof value !== "string") throw new Error("Expected canonical rich-text JSON")
  const document = requireTestRecord(JSON.parse(value) as unknown, "rich-text document")
  if (!Array.isArray(document.content)) throw new Error("Expected rich-text content")
  const textNodes: string[] = []
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (!node || typeof node !== "object") return
    const record = requireTestRecord(node, "rich-text node")
    if (record.type === "text" && typeof record.text === "string") textNodes.push(record.text)
    if (Array.isArray(record.content)) visit(record.content)
  }
  visit(document.content)
  return { text: textNodes.join(""), content: document.content }
}

function richTextLeaves(
  definition: ReturnType<typeof makePrimary>,
  value: unknown,
  beforeConversion: (config: Record<string, unknown>, json: string) => void
): void {
  function visit(def: Parameters<typeof resolveFieldContract>[0] & { kind?: string; config?: Record<string, unknown> }, current: unknown): void {
    if (def.kind === "list") {
      if (Array.isArray(current))
        for (const row of current)
          visit(def.config!.item as typeof def, row)
      return
    }
    if (def.kind === "group") {
      const fields = def.config!.fields as Record<string, typeof def>
      if (current && typeof current === "object" && !Array.isArray(current))
        for (const [key, child] of Object.entries(fields))
          visit(child, (current as Record<string, unknown>)[key])
      return
    }
    if (def.kind === "richText" && typeof current === "string")
      beforeConversion(def.config!, current)
  }
  visit(definition as never, value)
}

const card = (name: string, questions: Array<{ question: string; answer: string }>) => ({
  cardName: name,
  body: "<b>literal</b> and {\"looks\":\"like JSON\"}",
  questions,
  image: { url: "https://evil.invalid/image.png" },
  destination: { type: "external", url: "https://evil.invalid" },
  relatedPage: { pageId: "evil-page-id" },
  style: "featured",
  identity: "model-id",
  action: { label: "Continue", link: { type: "external", url: "https://evil.invalid" } },
})

describe("primary-list content writer", () => {
  test.each(["content", "editorial"] as const)("restores the live genuine schema after the %s fixture", (kind) => {
    const previousSlice = sliceDefs[testType]
    const previousInstalled = installedSliceDefs[testType]
    const originalValue = {
      id: "original-schema-control", type: testType, enabled: true,
      primary: structuredClone(previousInstalled.primary.default),
    }
    expect(validate(installedSliceValidator, originalValue)).toBe(true)
    let syntheticValue: unknown
    const withFixture = kind === "content" ? withSyntheticLists : withEditorialValidationLists
    withFixture(() => {
      syntheticValue = assembleSlice(testType, "no list labels")
      expect(validate(installedSliceValidator, syntheticValue)).toBe(true)
      expect(validate(installedSliceValidator, { ...originalValue, primary: null })).toBe(false)
      expect(validate(installedSliceValidator, originalValue)).toBe(false)
      expect(validate(previousInstalled.validator, syntheticValue)).toBe(false)
    })
    expect(sliceDefs[testType]).toBe(previousSlice)
    expect(installedSliceDefs[testType]).toBe(previousInstalled)
    expect(validate(installedSliceValidator, originalValue)).toBe(true)
    expect(validate(installedSliceValidator, syntheticValue)).toBe(false)
  })

  test("refuses supplied non-string editorial leaves at both list depths before canonical write", () => {
    withEditorialValidationLists((primary) => {
      const originalWrite = writeModule.writeSliceFields.bind(writeModule)
      const spy = vi.spyOn(writeModule, "writeSliceFields").mockImplementation((slice, locale, options) =>
        originalWrite(slice, locale, options)
      )
      const invalidValues = [
        ["object", { authored: true }],
        ["array", ["authored"]],
        ["number", 42],
        ["boolean", false],
        ["null", null],
      ] as const
      const fields = ["plainText", "titleText", "inlineText", "basicText", "fullText"] as const
      try {
        for (const depth of [1, 2] as const) {
          for (const field of fields) {
            for (const [kind, value] of invalidValues) {
              const row = depth === 1
                ? { [field]: value }
                : { nested: [{ [field]: value }] }
              const listPath = depth === 1 ? "depthOne" : "depthTwo"
              const leafPath = depth === 1 ? `${listPath}.${field}` : `${listPath}.nested.${field}`
              const rows = [row]
              const rowsBefore = structuredClone(rows)
              const beforeDefault = structuredClone(primary.default)
              const raw = `[primary.${listPath}]\n${JSON.stringify(rows)}\n[/primary.${listPath}]`

              spy.mockClear()
              expect(() => assembleSlice(testType, raw), `${kind} ${field} depth ${depth}`).toThrow(
                `PRIMARY_LIST_EXPECTED_STRING: primary.${leafPath}`
              )
              expect(spy, `${kind} ${field} depth ${depth} must refuse before writeSliceFields`).not.toHaveBeenCalled()
              expect(rows).toEqual(rowsBefore)
              expect(primary.default).toEqual(beforeDefault)
            }
          }
        }
      } finally {
        spy.mockRestore()
      }
    })
  })

  test("keeps omitted defaults and writes valid literal text at both list depths", () => {
    withEditorialValidationLists((primary) => {
      const originalWrite = writeModule.writeSliceFields.bind(writeModule)
      let activeSuppliedDepth: 1 | 2 | undefined
      let strictChecks = 0
      const spy = vi.spyOn(writeModule, "writeSliceFields").mockImplementation((slice, locale, options) => {
        if (slice.type !== testType) throw new Error(`Unexpected slice type: ${slice.type}`)
        if (activeSuppliedDepth !== undefined) {
          const primaryFields = requireTestRecord(primary.config.fields, "primary fields")
          const rootList = requireTestRecord(
            primaryFields[activeSuppliedDepth === 1 ? "depthOne" : "depthTwo"],
            "active list descriptor"
          )
          const rootItem = requireTestRecord(
            requireTestRecord(rootList.config, "active list config").item,
            "active list item"
          )
          let activeItem = rootItem
          if (activeSuppliedDepth === 2) {
            const itemFields = requireTestRecord(requireTestRecord(rootItem.config, "outer item config").fields, "outer item fields")
            const nestedList = requireTestRecord(itemFields.nested, "nested list descriptor")
            activeItem = requireTestRecord(requireTestRecord(nestedList.config, "nested list config").item, "nested list item")
          }
          const rows = primaryListRows(slice.primary, activeSuppliedDepth)
          expect(rows).toHaveLength(1)
          for (const row of rows)
            validateEditorialRichTextBeforeWrite(activeItem, row, (config, json) => {
              expect(validateStrict(resolveFieldContract(config), json)).toEqual({ ok: true })
              strictChecks += 1
            })
        }
        return originalWrite(slice, locale, options)
      })
      const fields = ["plainText", "titleText", "inlineText", "basicText", "fullText"] as const
      const payloads = ["", '{"literal":"json"}', "<b>literal HTML</b>"] as const
      const primaryFields = requireTestRecord(primary.config.fields, "primary fields")
      const depthOneDefinition = requireTestRecord(primaryFields.depthOne, "depth one descriptor")
      const depthOneItem = requireTestRecord(requireTestRecord(depthOneDefinition.config, "depth one config").item, "depth one item")
      const leafDefinitions = requireTestRecord(requireTestRecord(depthOneItem.config, "depth one item config").fields, "leaf definitions")
      const defaults = Object.fromEntries(fields.map((field) => {
        const definition = requireTestRecord(leafDefinitions[field], `${field} descriptor`)
        return [field, structuredClone(definition.default)]
      }))

      const assembleRows = (depth: 1 | 2, rows: unknown[]): ReturnType<typeof assembleSlice> => {
        const path = depth === 1 ? "depthOne" : "depthTwo"
        const raw = `[primary.${path}]\n${JSON.stringify(rows)}\n[/primary.${path}]`
        const output = assembleSlice(testType, raw)
        if (output.type !== testType) throw new Error(`Unexpected slice type: ${output.type}`)
        return output
      }

      try {
        for (const depth of [1, 2] as const) {
          const beforeDefault = structuredClone(primary.default)
          const omittedRows = depth === 1 ? [{}] : [{ nested: [{}] }]
          const omittedRowsBefore = structuredClone(omittedRows)
          const checksBeforeOmission = strictChecks
          spy.mockClear()
          activeSuppliedDepth = undefined
          const omitted = assembleRows(depth, omittedRows)
          expect(spy).toHaveBeenCalledOnce()
          expect(strictChecks).toBe(checksBeforeOmission)
          expect(omittedRows).toEqual(omittedRowsBefore)
          expect(primary.default).toEqual(beforeDefault)
          const omittedValues = requireTestRecord(primaryListRows(omitted.primary, depth)[0], "omitted editorial row")
          for (const field of fields) expect(omittedValues[field]).toEqual(defaults[field])

          for (const payload of payloads) {
            const leaf = Object.fromEntries(fields.map((field) => [field, payload]))
            const rows = depth === 1 ? [leaf] : [{ nested: [leaf] }]
            const rowsBefore = structuredClone(rows)
            const defaultBeforeAssembly = structuredClone(primary.default)
            const checksBeforeSupplied = strictChecks
            spy.mockClear()
            activeSuppliedDepth = depth
            const output = assembleRows(depth, rows)
            activeSuppliedDepth = undefined
            expect(spy).toHaveBeenCalledOnce()
            expect(strictChecks - checksBeforeSupplied).toBe(4)
            expect(rows).toEqual(rowsBefore)
            expect(primary.default).toEqual(defaultBeforeAssembly)
            const values = requireTestRecord(primaryListRows(output.primary, depth)[0], "written editorial row")

            expect(values.plainText).toBe(payload)
            for (const field of ["titleText", "inlineText", "basicText", "fullText"] as const) {
              const value = values[field]
              expect(value).not.toBe("")
              const decoded = decodedRichText(value)
              expect(decoded.text).toBe(payload)
              expect(decoded.content).toHaveLength(1)
              const firstBlock = requireTestRecord(decoded.content[0], `${field} canonical block`)
              expect(firstBlock.type).toBe(field === "titleText" ? "heading" : "paragraph")
              if (field === "titleText") {
                const attrs = requireTestRecord(firstBlock.attrs, "title heading attributes")
                expect(attrs.level).toBe(3)
              }
            }
          }
        }
        expect(strictChecks).toBe(24)
      } finally {
        activeSuppliedDepth = undefined
        spy.mockRestore()
      }
    })
  })

  test("generation prompts and assembly use declared lists and canonical rich text", () => {
    withSyntheticLists((primary) => {
      const generated = buildSliceGenerationInput({
        systemTemplate: "System {language} {sliceType}",
        userTemplate: "Brief: {brief}",
        language: "English",
        sliceType: testType,
        brief: "A useful section",
      })
      const pageFill = buildPageFillGenerationInput({
        systemTemplate: "System {language} {sliceType}",
        userTemplate: "Brief: {brief}",
        language: "English",
        sliceType: testType,
        pageBrief: "A page about useful sections",
        purpose: "Explain the product",
      })
      for (const prompt of [generated.prompt, pageFill.prompt]) {
        expect(prompt).toContain("[primary.cards]")
        expect(prompt).toContain("[primary.benefits]")
        expect(prompt).toContain("[primary.steps]")
        expect(prompt).toContain('"questions":[{"question":"Editorial text","answer":"Editorial text"}]')
        expect(prompt).not.toContain("[primary.cards[].questions]")
        expect(prompt).not.toContain("destination")
        expect(prompt).not.toContain("identity")
      }

      const originalWrite = writeModule.writeSliceFields.bind(writeModule)
      const spy = vi.spyOn(writeModule, "writeSliceFields").mockImplementation((slice, locale, options) => {
        const sliceValue = slice as unknown as { primary: unknown }
        richTextLeaves(primary, sliceValue.primary, (config, json) => {
          expect(validateStrict(resolveFieldContract(config), json)).toEqual({ ok: true })
        })
        return originalWrite(slice, locale, options)
      })
      try {
        const defaultBeforeAssembly = structuredClone(primary.default)
        const output = assembleSlice(
          testType,
          [
            "[headline]",
            "A canonical headline",
            "[/headline]",
            "[primary.cards]",
            JSON.stringify([
              card("{\"title\":\"literal\"}", [
                { question: "First question", answer: "First answer" },
                { question: "Second question", answer: "Second answer" },
                { question: "Dropped question", answer: "Dropped answer" },
              ]),
              card("<b>Second title</b>", [{ question: "Third question", answer: "Third answer" }]),
              card("Dropped card", [{ question: "Dropped", answer: "Dropped" }]),
            ]),
            "[/primary.cards]",
            "[primary.benefits]",
            JSON.stringify([{ label: "Clear benefit" }]),
            "[/primary.benefits]",
            "[primary.steps]",
            JSON.stringify([
              { description: "First step" },
              { description: "Second step" },
              { description: "Dropped step" },
            ]),
            "[/primary.steps]",
          ].join("\n")
        ) as unknown as { primary: Record<string, unknown> }
        expect(spy).toHaveBeenCalledOnce()

        const headline = JSON.parse(output.primary.headline as string)
        const cards = output.primary.cards as Array<Record<string, unknown>>
        expect(headline.content[0].attrs.level).toBe(2)
        expect(JSON.parse(cards[0]!.cardName as string).content[0].attrs.level).toBe(3)
        expect(cards).toHaveLength(2)
        expect(JSON.parse(cards[0]!.body as string).content[0].content[0].text).toBe(
          '<b>literal</b> and {"looks":"like JSON"}'
        )
        expect(cards[0]!.image).toEqual(primary.config.fields.cards!.config.item.config.fields.image!.default)
        expect(cards[0]!.destination).toEqual({ type: "none" })
        expect(cards[0]!.relatedPage).toEqual({})
        expect(cards[0]!.style).toBe("plain")
        expect(cards[0]!.identity).toBe("")
        expect(cards[0]!.action).toMatchObject({ label: "Continue", link: { type: "none" } })
        const questions = cards[0]!.questions as Array<Record<string, unknown>>
        expect(questions.map((row) => row.question)).toEqual(["First question", "Second question"])
        expect(new Set(cards.map((row) => row.itemId)).size).toBe(2)
        expect(new Set(questions.map((row) => row.itemId)).size).toBe(2)
        expect(output.primary.benefits).toEqual([
          { label: "Clear benefit", itemId: expect.any(String) },
        ])
        expect(output.primary.steps).toEqual([
          { description: "First step", itemId: expect.any(String) },
          { description: "Second step", itemId: expect.any(String) },
        ])
        const benefits = output.primary.benefits as Array<Record<string, unknown>>
        const steps = output.primary.steps as Array<Record<string, unknown>>
        const generatedIds = [
          ...cards.map((row) => row.itemId),
          ...questions.map((row) => row.itemId),
          ...benefits.map((row) => row.itemId),
          ...steps.map((row) => row.itemId),
        ]
        expect(generatedIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true)
        expect(new Set(generatedIds).size).toBe(generatedIds.length)
        expect(primary.default).toEqual(defaultBeforeAssembly)
      } finally {
        spy.mockRestore()
      }
    })
  })

  test("missing blocks retain defaults; malformed JSON, wrong rows, and min violations refuse without mutation", () => {
    withSyntheticLists((primary) => {
      const before = structuredClone(primary.default)
      const missing = assembleSlice(testType, "no list labels") as unknown as { primary: Record<string, unknown> }
      expect(missing.primary.cards).toEqual([])
      expect(missing.primary.benefits).toEqual([])
      expect(primary.default).toEqual(before)

      const cases = [
        ["[primary.cards]\nnot json\n[/primary.cards]", "PRIMARY_LIST_INVALID_JSON: primary.cards"],
        ["[primary.cards]\n{\"cardName\":\"x\"}\n[/primary.cards]", "PRIMARY_LIST_EXPECTED_ARRAY: primary.cards"],
        ["[primary.cards]\n[1]\n[/primary.cards]", "PRIMARY_LIST_EXPECTED_OBJECT: primary.cards"],
        ["[primary.cards]\n[]\n[/primary.cards]", "PRIMARY_LIST_TOO_FEW_ROWS: primary.cards"],
        ["[primary.cards]\n[{\"cardName\":\"x\",\"questions\":[]} ]\n[/primary.cards]", "PRIMARY_LIST_TOO_FEW_ROWS: primary.cards.questions"],
      ] as const
      for (const [raw, message] of cases) {
        expect(() => assembleSlice(testType, raw)).toThrow(message)
        expect(primary.default).toEqual(before)
      }
    })
  })

  test("accepts a supported 10000-character editorial title through assembly", () => {
    withSyntheticLists((primary) => {
      const title = "a".repeat(10000)
      const assembled = assembleSlice(
        testType,
        `[headline]\n${title}\n[/headline]`
      ) as unknown as { primary: Record<string, unknown> }
      const headline = assembled.primary.headline as string
      const headlineDefinition = primary.config.fields.headline!
      expect(
        validateStrict(resolveFieldContract(headlineDefinition.config), headline)
      ).toEqual({ ok: true })
      expect(JSON.parse(headline).content[0].content[0].text).toBe(title)
    })
  })

  test("the existing items response still fills installed legacy button lists", () => {
    const result = assembleSlice("hero-agency", "[items]\n- Existing action\n[/items]") as unknown as { items: Array<{ label: string }> }
    expect(result.items.map((item) => item.label)).toEqual(["Existing action"])
  })
})

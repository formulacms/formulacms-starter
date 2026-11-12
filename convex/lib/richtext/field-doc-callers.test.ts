import { readInstalledSliceDefinition } from "@/convex/lib/slices"
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { createSampleSlice } from "../slices/sample"
import { installedSliceDefs, sliceDefs } from "../slices"
import { group, list, richText } from "../slices/primitives"
import {
  resolveSliceSpecPreview,
  type FieldSpec,
  type SliceSpec,
} from "@/lib/slices/authoring/scaffold"
import { resolveFieldContract, type RichTextContractConfig } from "./contracts"
import { validateStrict } from "./strict"
import { writeSliceFields } from "./write"
import { validateSlicesRichText } from "../slices/validate"
import { validate } from "convex-helpers/validators"
import { v } from "convex/values"
import { walkValue } from "../slices/walk"

// Snapshot an optional descriptor without requiring it to be installed.
const installedSliceDefinition = (type: string) => readInstalledSliceDefinition(type)

const syntheticSpec: SliceSpec = {
  type: "field-doc-callers",
  label: "Field Doc Callers",
  description: "Synthetic configured title callers",
  icon: "Type",
  group: "content",
  primary: {
    kind: "group",
    fields: {
      headline: {
        kind: "richText",
        config: { contract: "title", heading: { role: "sliceTitle" } },
      },
      cards: {
        kind: "list",
        config: { min: 1, max: 2 },
        item: {
          kind: "group",
          fields: {
            heading: {
              kind: "richText",
              config: { contract: "title", heading: { role: "itemTitle" } },
            },
            copy: { kind: "richText", config: { contract: "inline" } },
          },
        },
      },
    },
  },
}

function richTextChecks(field: FieldSpec, value: unknown): Array<[RichTextContractConfig, string]> {
  if (field.kind === "richText") {
    return typeof value === "string" ? [[field.config, value]] : []
  }
  if (field.kind === "group" && value && typeof value === "object") {
    return Object.entries(field.fields).flatMap(([key, child]) =>
      richTextChecks(child, (value as Record<string, unknown>)[key])
    )
  }
  if (field.kind === "list" && Array.isArray(value)) {
    return value.flatMap((item) => richTextChecks(field.item, item))
  }
  return []
}

describe("field document callers", () => {
  test("scaffold previews use every configured rich-text role", () => {
    const preview = resolveSliceSpecPreview(syntheticSpec)
    const checks = richTextChecks(syntheticSpec.primary, preview.primary)
    expect(checks.length).toBeGreaterThan(0)
    for (const [config, json] of checks) {
      expect(validateStrict(resolveFieldContract(config), json)).toEqual({ ok: true })
    }
  })

  test("the installed Hero sample title is strict for its descriptor role", sliceProfile([]), () => {
    const sample = createSampleSlice("hero-with-image")
    const titleField = (sliceDefs["hero-with-image"].primary.config.fields as Record<string, { config: RichTextContractConfig }>).title
    expect(titleField).toBeDefined()
    expect(validateStrict(resolveFieldContract(titleField!.config), sample.primary.title)).toEqual({ ok: true })
  })

  test("synthesizes no-preview nested rich text and accepts its canonical write", sliceProfile([]), () => {
    const type = "rich-text-body" as const
    const markers = {
      sliceTitle: "sample-slice-title-marker",
      itemTitle: "sample-item-title-marker",
      inlineBody: "sample-inline-body-marker",
      basicBody: "sample-basic-body-marker",
      fullBody: "sample-full-body-marker",
      nestedTitle: "sample-nested-title-marker",
      nestedInline: "sample-nested-inline-marker",
      nestedBasic: "sample-nested-basic-marker",
      nestedFull: "sample-nested-full-marker",
    }
    const previous = sliceDefs[type]
    const previousInstalled = installedSliceDefinition(type)
    const primary = group({
      title: richText({
        contract: "title",
        heading: { role: "sliceTitle" },
        placeholder: markers.sliceTitle,
      }),
      entries: list(
        group({
          itemTitle: richText({
            contract: "title",
            heading: { role: "itemTitle", parent: "entries" },
            placeholder: markers.itemTitle,
          }),
          inlineBody: richText({ contract: "inline", placeholder: markers.inlineBody }),
          basicBody: richText({ contract: "basic", placeholder: markers.basicBody }),
          fullBody: richText({ contract: "full", placeholder: markers.fullBody }),
          nested: list(
            group({
              nestedTitle: richText({
                contract: "title",
                heading: { role: "itemTitle", parent: "entries.nested" },
                placeholder: markers.nestedTitle,
              }),
              nestedInline: richText({ contract: "inline", placeholder: markers.nestedInline }),
              nestedBasic: richText({ contract: "basic", placeholder: markers.nestedBasic }),
              nestedFull: richText({ contract: "full", placeholder: markers.nestedFull }),
            }),
            { min: 1, max: 1 }
          ),
        }),
        { min: 1, max: 1 }
      ),
    })
    const synthetic = {
      type,
      primary,
      validator: v.object({
        id: v.string(),
        type: v.literal(type),
        enabled: v.boolean(),
        primary: primary.validator,
      }),
    }

    Reflect.set(sliceDefs, type, synthetic)
    Reflect.set(installedSliceDefs, type, synthetic)
    try {
      expect("preview" in sliceDefs[type]).toBe(false)
      const sample = createSampleSlice(type)
      const sourceBefore = JSON.stringify(sample)
      expect(sample.type).toBe(type)
      expect(validate(sliceDefs[type].validator, sample)).toBe(true)

      const leaves: Array<{ path: string; marker: string; config: RichTextContractConfig; value: string }> = []
      walkValue(primary, sample.primary, (leaf) => {
        if (leaf.def.kind === "richText" && typeof leaf.value === "string") {
          leaves.push({
            path: leaf.path,
            marker: leaf.value,
            config: leaf.def.config as RichTextContractConfig,
            value: leaf.value,
          })
        }
      })
      const expected = [
        ["title", markers.sliceTitle],
        ["entries[0].itemTitle", markers.itemTitle],
        ["entries[0].inlineBody", markers.inlineBody],
        ["entries[0].basicBody", markers.basicBody],
        ["entries[0].fullBody", markers.fullBody],
        ["entries[0].nested[0].nestedTitle", markers.nestedTitle],
        ["entries[0].nested[0].nestedInline", markers.nestedInline],
        ["entries[0].nested[0].nestedBasic", markers.nestedBasic],
        ["entries[0].nested[0].nestedFull", markers.nestedFull],
      ]
      expect(leaves.map(({ path }) => path)).toEqual(expected.map(([path]) => path))
      expect(leaves).toHaveLength(9)
      for (const [index, leaf] of leaves.entries()) {
        const marker = expected[index]?.[1]
        expect(marker).toBeDefined()
        expect(leaf.marker).toContain(marker)
        const parsed: unknown = JSON.parse(leaf.value)
        const textNodes = (node: unknown): string[] => {
          if (Array.isArray(node)) return node.flatMap(textNodes)
          if (!node || typeof node !== "object") return []
          const record = node as Record<string, unknown>
          const ownText = record.type === "text" && typeof record.text === "string" ? [record.text] : []
          return [...ownText, ...textNodes(record.content)]
        }
        expect(textNodes(parsed)).toEqual([marker])
        expect(validateStrict(resolveFieldContract(leaf.config), leaf.value)).toEqual({ ok: true })
        const document = parsed as { content?: Array<{ type?: string; attrs?: { level?: number } }> }
        const expectedLevel = leaf.config.contract === "title"
          ? leaf.config.heading?.role === "itemTitle" ? 3 : 2
          : undefined
        if (expectedLevel !== undefined) {
          expect(document.content?.[0]?.type).toBe("heading")
          expect(document.content?.[0]?.attrs?.level).toBe(expectedLevel)
        } else {
          expect(document.content?.[0]?.type).toBe("paragraph")
        }
      }

      validateSlicesRichText([sample])
      const canonical = writeSliceFields(sample, "en")
      expect(canonical.reports).toEqual([])
      expect(validate(sliceDefs[type].validator, canonical.value)).toBe(true)
      validateSlicesRichText([canonical.value])
      const writtenPrimary = canonical.value.primary
      expect(validate(primary.validator, writtenPrimary)).toBe(true)
      if (!validate(primary.validator, writtenPrimary)) {
        throw new Error("Canonical primary failed its synthetic descriptor validator")
      }
      const entries = writtenPrimary.entries
      expect(entries).toHaveLength(1)
      const entry = entries[0]
      if (!entry) throw new Error("Canonical sample is missing its entries row")
      expect(entry.nested).toHaveLength(1)
      const nestedEntry = entry.nested[0]
      if (!nestedEntry) throw new Error("Canonical sample is missing its nested row")
      const entryId = entry.itemId
      const nestedId = nestedEntry.itemId
      if (typeof entryId !== "string" || entryId.length === 0) {
        throw new Error("Canonical entries row is missing its allocated itemId")
      }
      if (typeof nestedId !== "string" || nestedId.length === 0) {
        throw new Error("Canonical nested row is missing its allocated itemId")
      }
      expect(new Set([entryId, nestedId]).size).toBe(2)
      const canonicalLeaves: Array<{ path: string; value: string }> = []
      walkValue(primary, writtenPrimary, (leaf) => {
        if (leaf.def.kind === "richText" && typeof leaf.value === "string") {
          canonicalLeaves.push({ path: leaf.path, value: leaf.value })
        }
      })
      expect(canonicalLeaves).toEqual(
        leaves.map(({ path, value }) => ({ path, value }))
      )
      expect(JSON.stringify(sample)).toBe(sourceBefore)
    } finally {
      Reflect.set(sliceDefs, type, previous)
      Reflect.set(installedSliceDefs, type, previousInstalled)
      expect(sliceDefs[type]).toBe(previous)
      expect(installedSliceDefinition(type)).toBe(previousInstalled)
    }
  })
})

import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { afterEach, describe, expect, it, vi } from "vitest"
import * as shapeModule from "./shape"
import { buildFieldDoc } from "./build"
import { resolveFieldContract } from "./contracts"
import { validateStrict } from "./strict"
import { writeSliceFields } from "./write"

import type { Slice } from "../slices"

type JsonRecord = Record<string, unknown>

function decodedText(node: unknown): string {
  const current = node as JsonRecord
  if (current.type === "text") return current.text as string
  if (current.type === "hardBreak") return "\n"
  return Array.isArray(current.content)
    ? current.content.map(decodedText).join("")
    : ""
}

function expectGeneratedInputHasOnlyPlainTitleNodes(value: string): void {
  const root = JSON.parse(value) as JsonRecord
  expect(root.type).toBe("doc")
  expect(root.attrs).toBeUndefined()
  expect(Array.isArray(root.content)).toBe(true)
  const pending: unknown[] = root.content as unknown[]
  while (pending.length) {
    const node = pending.pop()
    expect(node).toEqual(expect.objectContaining({ type: expect.any(String) }))
    const current = node as JsonRecord
    expect(["paragraph", "text", "hardBreak"]).toContain(current.type)
    expect(current.attrs).toBeUndefined()
    if (current.type === "text") {
      expect(typeof current.text).toBe("string")
      if (current.marks !== undefined) {
        expect(current.marks).toEqual(
          expect.arrayContaining(
            (current.marks as JsonRecord[]).map(() =>
              expect.objectContaining({ type: expect.stringMatching(/^(bold|italic)$/) })
            )
          )
        )
        for (const mark of current.marks as JsonRecord[]) {
          expect(["bold", "italic"]).toContain(mark.type)
          expect(mark.attrs).toBeUndefined()
        }
      }
    }
    if (current.content !== undefined) {
      expect(Array.isArray(current.content)).toBe(true)
      pending.push(...(current.content as unknown[]))
    }
  }
}

describe("generated title conversion proof", () => {
  afterEach(() => vi.restoreAllMocks())

  it("passes generated text through the real shape converter without link reports", sliceProfile([]), () => {
    const generatedText =
      '[guide](https://example.test) <a href="https://example.test">HTML</a> {"url":"https://example.test"} **bold** *italic*\nsecond line'
    const hero = createSampleSlice("hero-with-image")
    const fixture: Slice = {
      ...hero,
      primary: {
        ...hero.primary,
        title: "",
      },
    }
    const realConverter = shapeModule.toFieldShape
    const converterInputs: Array<{ contract: string; value: string }> = []
    const converterResults: shapeModule.FieldShapeResult[] = []
    const converterSpy = vi
      .spyOn(shapeModule, "toFieldShape")
      .mockImplementation((contract, value) => {
        converterInputs.push({ contract: contract.contract, value })
        const result = realConverter(contract, value)
        converterResults.push(result)
        return result
      })

    try {
      const sliceTitleConfig = {
        contract: "title" as const,
        heading: { role: "sliceTitle" as const },
      }
      const itemTitleConfig = {
        contract: "title" as const,
        heading: { role: "itemTitle" as const },
      }
      const generatedTitle = buildFieldDoc(generatedText, sliceTitleConfig, undefined, {
        emphasis: true,
      })
      const generatedItemTitle = buildFieldDoc(
        "A **bold** item title\nsecond line",
        itemTitleConfig,
        undefined,
        { emphasis: true }
      )

      expect(converterInputs).toHaveLength(2)
      expect(converterInputs[0]?.contract).toBe("title")
      expectGeneratedInputHasOnlyPlainTitleNodes(converterInputs[0]!.value)
      const converterInput = JSON.parse(converterInputs[0]!.value) as JsonRecord
      // A title is one line: the generated newline arrives as a space.
      expect(decodedText(converterInput)).toBe(
        generatedText.replaceAll("*", "").replaceAll("\n", " ")
      )
      expectGeneratedInputHasOnlyPlainTitleNodes(converterInputs[1]!.value)
      expect(decodedText(JSON.parse(converterInputs[1]!.value))).toBe(
        "A bold item title second line"
      )
      expect(converterResults[0]?.removedLinks).toEqual([])
      expect(converterResults[1]?.removedLinks).toEqual([])
      expect(
        (generatedTitle as { content: Array<{ type: string; attrs?: { level: number } }> })
          .content[0]
      ).toMatchObject({ type: "heading", attrs: { level: 2 } })
      expect(
        (generatedItemTitle as { content: Array<{ type: string; attrs?: { level: number } }> })
          .content[0]
      ).toMatchObject({ type: "heading", attrs: { level: 3 } })
      expect(
        validateStrict(resolveFieldContract(sliceTitleConfig), JSON.stringify(generatedTitle))
      ).toEqual({ ok: true })
      expect(
        validateStrict(resolveFieldContract(itemTitleConfig), JSON.stringify(generatedItemTitle))
      ).toEqual({ ok: true })

      const canonicalBytes = JSON.stringify(generatedTitle)
      fixture.primary.title = canonicalBytes
      const written = writeSliceFields(fixture, "en")
      const writtenValue = written.value
      expect(writtenValue.type).toBe("hero-with-image")
      if (writtenValue.type !== "hero-with-image")
        throw new Error("Expected the written Hero fixture")
      expect(writtenValue.primary.title).toBe(canonicalBytes)
      expect(written.reports).toEqual([])
      expect(converterSpy).toHaveBeenCalledTimes(3)
      expect(converterInputs[2]?.contract).toBe("title")
      expect(converterResults[2]?.removedLinks).toEqual([])
    } finally {
      converterSpy.mockRestore()
    }
  })
})

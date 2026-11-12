import { describe, expect, test } from "vitest"
import { isRichTextEmpty } from "./emptiness"
import { isPrimitiveValueEmpty, richText } from "../slices/primitives"
import { fieldHasContent } from "@/components/admin/fields/field-utils"

describe("shared rich-text emptiness", () => {
  test.each([
    [undefined, true],
    ["  ", true],
    ['{"type":"doc","content":[]}', true],
    [
      '{"type":"doc","content":[{"type":"paragraph"},{"type":"heading","attrs":{"level":2}}]}',
      true,
    ],
    [
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"hardBreak"}]}]}',
      true,
    ],
    [
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"visible"}]}]}',
      false,
    ],
    [
      '{"type":"doc","content":[{"type":"image","attrs":{"src":"/x.png"}}]}',
      false,
    ],
    ['{"type":"doc","content":[{"type":"horizontalRule"}]}', false],
    ['{"type":"doc","content":[{"type":"unknownNode"}]}', false],
    ['{"type":"doc","content":"malformed"}', false],
    ["<p>legacy</p>", false],
    ["{malformed", false],
  ] as Array<[unknown, boolean]>)(
    "classifies %s as empty=%s",
    (value, expected) => {
      expect(isRichTextEmpty(value)).toBe(expected)
    }
  )
  test("primitive and editor field predicates share the rich-text definition", () => {
    const emptyPara = '{"type":"doc","content":[{"type":"paragraph"}]}'
    const def = richText({ profile: "inline" })
    expect(isPrimitiveValueEmpty(def, emptyPara)).toBe(true)
    expect(fieldHasContent(emptyPara)).toBe(false)
    expect(fieldHasContent("legacy copy")).toBe(true)
  })
})

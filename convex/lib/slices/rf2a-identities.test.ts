import { describe, expect, test } from "vitest"
import { richTextToPlainText } from "../richtext/pmText"
import { convertContentFields } from "./validate"
import {
  group,
  image,
  link,
  list,
  relation,
  richText,
  text,
  type Primitive,
} from "./primitives"

describe("RF2a descriptor row identity compatibility", () => {
  test("object rows accept optional itemId while retaining their declared fields", () => {
    const rows = list(
      group({ title: text(), nested: list(group({ label: text() })) })
    )
    const rowValidator = rows.validator.element
    expect(rowValidator.kind).toBe("object")
    if (rowValidator.kind !== "object") return
    expect(rowValidator.fields.title.kind).toBe("string")
    expect(rowValidator.fields.itemId?.kind).toBe("string")
    expect(rowValidator.fields.itemId?.isOptional).toBe("optional")
    const nested = rowValidator.fields.nested
    expect(nested.kind).toBe("array")
    if (nested.kind === "array" && nested.element.kind === "object") {
      expect(nested.element.fields.label.kind).toBe("string")
      expect(nested.element.fields.itemId?.isOptional).toBe("optional")
    } else {
      throw new Error("nested group rows must remain object validators")
    }
  })

  test("scalar lists remain scalar and allocate no row identity", () => {
    const values = list(text())
    expect(values.validator.element.kind).toBe("string")
    expect(values.default).toEqual([])
  })

  test("relation object rows accept itemId without changing target fields", () => {
    const rows = list(relation({ pageTypes: ["author"] }))
    const validator = rows.validator.element
    expect(validator.kind).toBe("object")
    if (validator.kind !== "object") return
    expect(validator.fields.pageId?.kind).toBe("id")
    expect(validator.fields.itemId?.kind).toBe("string")
    expect(validator.fields.itemId?.isOptional).toBe("optional")
  })

  test("image object rows accept itemId while retaining image metadata", () => {
    const rows = list(image())
    const validator = rows.validator.element
    expect(validator.kind).toBe("object")
    if (validator.kind !== "object") return
    expect(validator.fields.url?.kind).toBe("string")
    expect(validator.fields.alt?.kind).toBe("string")
    expect(validator.fields.itemId?.kind).toBe("string")
    expect(validator.fields.itemId?.isOptional).toBe("optional")
  })

  test("link object rows accept itemId while retaining their target shape", () => {
    const rows = list(link())
    const validator = rows.validator.element
    expect(validator.kind).toBe("object")
    if (validator.kind !== "object") return
    expect(validator.fields.type?.kind).toBe("union")
    expect(validator.fields.pageId?.kind).toBe("id")
    expect(validator.fields.itemId?.kind).toBe("string")
    expect(validator.fields.itemId?.isOptional).toBe("optional")
  })

  test("title fields have a role-shaped empty default and conversion preserves row metadata", () => {
    const fields = {
      rows: list(
        group({
          title: richText({
            contract: "title",
            heading: { role: "itemTitle" },
          }),
        })
      ),
    }
    const definition = group(fields)
    expect(definition.validator.kind).toBe("object")
    const rows = fields.rows
    const item = (rows.config as { item: Primitive }).item
    const defaultTitle = (item.config as { fields: Record<string, Primitive> })
      .fields.title!.default
    expect(JSON.parse(defaultTitle as string)).toEqual({
      type: "doc",
      content: [{ type: "heading", attrs: { level: 3 } }],
    })

    const input = { rows: [{ itemId: "row-1", title: "Question" }] }
    const converted = convertContentFields(fields, input, "test-content")
    expect(converted.value.rows).toEqual([
      {
        itemId: "row-1",
        title: JSON.stringify({
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: 3 },
              content: [{ type: "text", text: "Question" }],
            },
          ],
        }),
      },
    ])
    expect(converted.reports).toHaveLength(1)
    expect(
      richTextToPlainText(
        '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"a"}]},{"type":"paragraph","content":[{"type":"text","text":"b"}]}]}'
      )
    ).toBe("a b")
  })
})

import { getSchema } from "@tiptap/core"
import { Node as PMNode } from "@tiptap/pm/model"
import { describe, expect, test } from "vitest"
import { extensionsForContract } from "@/lib/rich-text/extensions"
import { resolveFieldContract, type FieldContract } from "./contracts"
import { validateLegacy, validateStrict } from "./strict"

const validByContract: Record<FieldContract, unknown> = {
  title: {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Title" }],
      },
    ],
  },
  inline: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Caption" }] },
    ],
  },
  basic: {
    type: "doc",
    content: [
      { type: "paragraph", content: [{ type: "text", text: "Body" }] },
      {
        type: "heading",
        attrs: { level: 2 },
        content: [{ type: "text", text: "Section" }],
      },
    ],
  },
  full: {
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 1 },
        content: [{ type: "text", text: "Article" }],
      },
      { type: "paragraph", content: [{ type: "text", text: "Body" }] },
    ],
  },
}

const validExamples: Array<[FieldContract, unknown]> = [
  ["title", validByContract.title],
  [
    "title",
    {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 4 },
          content: [
            { type: "text", text: "Bold", marks: [{ type: "bold" }] },
            { type: "text", text: " title" },
          ],
        },
      ],
    },
  ],
  [
    "title",
    {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 1 },
          content: [{ type: "text", text: "Top" }],
        },
      ],
    },
  ],
  ["inline", validByContract.inline],
  [
    "inline",
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "One" },
            { type: "hardBreak" },
            { type: "text", text: "Two" },
          ],
        },
      ],
    },
  ],
  [
    "inline",
    {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "First" }] },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Second", marks: [{ type: "italic" }] },
          ],
        },
      ],
    },
  ],
  ["basic", validByContract.basic],
  [
    "basic",
    {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Item" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  [
    "basic",
    {
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: 2 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "Numbered" }],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
  ["full", validByContract.full],
  [
    "full",
    {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Quote" }] },
          ],
        },
        { type: "codeBlock", content: [{ type: "text", text: "const x = 1" }] },
        { type: "horizontalRule" },
        { type: "image", attrs: { src: "/image.png" } },
      ],
    },
  ],
  [
    "full",
    {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Head" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  ],
]

const invalidExamples: Array<[FieldContract, unknown]> = (
  Object.keys(validByContract) as FieldContract[]
).flatMap((contract) => {
  const paragraph = {
    type: "paragraph",
    content: [{ type: "text", text: "x" }],
  }
  const heading = {
    type: "heading",
    attrs: { level: 2 },
    content: [{ type: "text", text: "x" }],
  }
  const malformed: unknown[] = [
    { type: "wrongDoc", content: [paragraph] },
    { type: "doc", content: "not-array" },
    { type: "doc", content: [] },
    { type: "doc", content: [{ type: "unknownNode" }] },
    {
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "" }] }],
    },
    {
      type: "doc",
      content: [
        contract === "title"
          ? paragraph
          : contract === "inline"
            ? heading
            : contract === "basic"
              ? { ...heading, attrs: { level: 1 } }
              : { type: "text", text: "x" },
      ],
    },
    { type: "doc", content: [{ ...heading, attrs: { level: "2" } }] },
    // ADR-0055 amendment: a title is one line, so a break under it is invalid.
    ...(contract === "title"
      ? [
          {
            type: "doc",
            content: [
              {
                ...heading,
                content: [
                  { type: "text", text: "x" },
                  { type: "hardBreak" },
                  { type: "text", text: "y" },
                ],
              },
            ],
          },
        ]
      : []),
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "x", marks: [{ type: "unknownMark" }] },
          ],
        },
      ],
    },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "x",
              marks: [{ type: "link", attrs: { href: 42 } }],
            },
          ],
        },
      ],
    },
    {
      type: "doc",
      content: [{ type: "heading", attrs: { level: 2 }, content: [paragraph] }],
    },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          marks: [{ type: "bold" }],
          content: [{ type: "text", text: "x" }],
        },
      ],
    },
    {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          content: [{ type: "text", text: "x", marks: [{ type: "bold" }] }],
        },
      ],
    },
    {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "x" }] },
          ],
        },
      ],
    },
  ]
  if (contract === "title") {
    malformed.push(
      { type: "doc", content: [heading, heading] },
      {
        type: "doc",
        content: [
          {
            ...heading,
            content: [
              {
                type: "text",
                text: "x",
                marks: [{ type: "link", attrs: { href: "/x" } }],
              },
            ],
          },
        ],
      }
    )
  }
  return malformed.map((doc) => [contract, doc] as [FieldContract, unknown])
})

function oracleAccepts(contract: FieldContract, doc: unknown): boolean {
  try {
    const schema = getSchema(extensionsForContract(contract))
    const node = PMNode.fromJSON(schema, doc)
    node.check()
    return independentSemantics(contract, doc)
  } catch {
    return false
  }
}

function independentSemantics(contract: FieldContract, doc: unknown): boolean {
  if (!isRecord(doc) || !Array.isArray(doc.content) || doc.content.length === 0)
    return false
  if (
    contract === "title" &&
    !(
      doc.content.length === 1 &&
      isRecord(doc.content[0]) &&
      doc.content[0].type === "heading"
    )
  )
    return false
  if (
    contract === "inline" &&
    !doc.content.every((node) => isRecord(node) && node.type === "paragraph")
  )
    return false
  const marks = new Set(
    contract === "title"
      ? [
          "bold",
          "italic",
          "strike",
          "underline",
          "highlight",
          "subscript",
          "superscript",
        ]
      : contract === "full"
        ? [
            "bold",
            "italic",
            "strike",
            "underline",
            "highlight",
            "subscript",
            "superscript",
            "link",
            "code",
          ]
        : [
            "bold",
            "italic",
            "strike",
            "underline",
            "highlight",
            "subscript",
            "superscript",
            "link",
          ]
  )
  const visit = (node: unknown): boolean => {
    if (!isRecord(node)) return false
    if (
      node.type === "text" &&
      (typeof node.text !== "string" || !node.text.trim())
    )
      return false
    if (node.marks !== undefined && !Array.isArray(node.marks)) return false
    if (
      node.marks !== undefined &&
      node.type !== "text" &&
      node.type !== "hardBreak"
    )
      return false
    if (node.type === "heading") {
      const level = isRecord(node.attrs) ? node.attrs.level : undefined
      if (
        typeof level !== "number" ||
        !Number.isInteger(level) ||
        (contract === "basic" ? level < 2 || level > 3 : level < 1 || level > 6)
      )
        return false
    }
    if (
      node.type === "image" &&
      (!isRecord(node.attrs) || typeof node.attrs.src !== "string")
    )
      return false
    if (Array.isArray(node.marks)) {
      for (const mark of node.marks) {
        if (
          !isRecord(mark) ||
          typeof mark.type !== "string" ||
          !marks.has(mark.type)
        )
          return false
        if (mark.type === "link") {
          const attrs = isRecord(mark.attrs) ? mark.attrs : {}
          if (
            typeof attrs.href !== "string" &&
            typeof attrs.pageId !== "string"
          )
            return false
        }
      }
    }
    if (
      node.type === "codeBlock" &&
      Array.isArray(node.content) &&
      node.content.some(
        (child) => !isRecord(child) || child.type !== "text" || child.marks
      )
    )
      return false
    return !Array.isArray(node.content) || node.content.every(visit)
  }
  return doc.content.every(visit)
}

describe("RF2a contract oracle and legacy reader", () => {
  test.each(validExamples)(
    "oracle accepts valid %s example",
    (contract, doc) => {
      const json = JSON.stringify(doc)
      expect(oracleAccepts(contract, doc)).toBe(true)
      expect(validateStrict(contract, json)).toEqual({ ok: true })
      expect(validateLegacy(resolveFieldContract(contract), json)).toEqual({
        ok: true,
      })
    }
  )

  test("strictly accepted documents are also accepted by the legacy reader", () => {
    for (const [contract, doc] of validExamples) {
      const json = JSON.stringify(doc)
      if (validateStrict(contract, json).ok) {
        expect(validateLegacy(resolveFieldContract(contract), json)).toEqual({
          ok: true,
        })
      }
    }
  })

  test("title legacy reads stay lenient where canonical writes are strict", () => {
    const emptyText = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: "legacy" },
          content: [{ type: "text", text: "" }],
        },
      ],
    })
    expect(validateStrict("title", emptyText).ok).toBe(false)
    expect(validateLegacy("title", emptyText)).toEqual({ ok: true })
  })

  test.each(invalidExamples)(
    "rejects malformed %s value in both independent validators",
    (contract, doc) => {
      expect(oracleAccepts(contract, doc)).toBe(false)
      expect(validateStrict(contract, JSON.stringify(doc)).ok).toBe(false)
    }
  )

  test("rejects conflicting aliases and supports title role defaults", () => {
    expect(() =>
      resolveFieldContract({ contract: "title", profile: "inline" })
    ).toThrow(/conflicts/)
    expect(
      resolveFieldContract({
        contract: "title",
        heading: { role: "sliceTitle", parent: "primary" },
      }).headingDefaultLevel
    ).toBe(2)
    expect(
      resolveFieldContract({
        contract: "title",
        heading: { role: "itemTitle", parent: "items.title" },
        headingFloor: { parent: "items" },
      }).headingDefaultLevel
    ).toBe(3)
  })
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

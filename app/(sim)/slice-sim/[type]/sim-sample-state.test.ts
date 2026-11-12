import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it } from "vitest"
import { createSampleSlice } from "@/lib/slices/sample"
import {
  sampleFields,
  projectSamples,
  validSampleValue,
  readSampleStorage,
  sampleStorageKey,
  writeSampleStorage,
} from "./sim-sample-state"

const paragraph = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  })
describe("real simulator sample contracts", () => {
  it("derives at most ten text fields from each real curated descriptor", sliceProfile([]), () => {
    const expected = {
      "hero-agency": 5,
      "hero-with-image": 6,
      "features-icon-grid": 9,
      "faq-simple": 9,
      "rich-text-body": 1,
    }
    for (const type of [
      "hero-agency",
      "hero-with-image",
      "features-icon-grid",
      "faq-simple",
      "rich-text-body",
    ] as const) {
      const fields = sampleFields(createSampleSlice(type))
      expect(fields.length).toBeGreaterThan(0)
      expect(fields.length).toBeLessThanOrEqual(10)
      expect(fields.length).toBe(expected[type])
      expect(fields.some((field) => /\.(id|itemId)$/.test(field.path))).toBe(
        false
      )
      expect(fields.some((field) => /icon|image|url/.test(field.path))).toBe(
        false
      )
    }
  })
  it("refuses internal button ID injection through projection and storage while preserving labels and identity", sliceProfile([]), () => {
    const seed = createSampleSlice("hero-agency")
    const fields = sampleFields(seed)
    const values = {
      "items.0.id": "changed-identity",
      "items.0.label": "A real label",
    }
    const next = projectSamples(seed, values)
    expect(next.items[0].id).toBe(seed.items[0].id)
    expect(next.items[0].label).toBe("A real label")
    expect(next.items[0].itemId).toBe(projectSamples(seed, {}).items[0].itemId)
    expect(
      readSampleStorage(
        { getItem: () => JSON.stringify(values) },
        "key",
        fields
      )
    ).toEqual({})
  })
  it("projects real slice values, retaining stable row identity", sliceProfile([]), () => {
    const seed = createSampleSlice("faq-simple")
    const fields = sampleFields(seed)
    const field = fields.find((field) => field.path === "items.0.question")!
    const title = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Changed" }],
        },
      ],
    })
    const next = projectSamples(seed, { [field.path]: title })
    expect(next.items[0].question).toBe(title)
    expect(next.items[0].itemId).toBe(projectSamples(seed, {}).items[0].itemId)
    expect(seed.items[0].question).not.toBe(next.items[0].question)
    expect(projectSamples(seed, { "primary.noSuchField": "bad" })).toEqual(
      projectSamples(seed, {})
    )
  })
  it("admits canonical real-profile bodies and rejects structure in inline fields", sliceProfile([]), () => {
    const fields = sampleFields(createSampleSlice("faq-simple"))
    const answer = fields.find((field) => field.path === "items.0.answer")!
    const intro = fields.find((field) => field.path === "primary.body")!
    const doc = JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Paragraph" }] },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Heading" }],
        },
        {
          type: "heading",
          attrs: { level: 3 },
          content: [{ type: "text", text: "Subheading" }],
        },
        ...["bulletList", "orderedList"].map((type) => ({
          type,
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
        })),
      ],
    })
    expect(validSampleValue(answer, doc)).toBe(true)
    expect(validSampleValue(intro, doc)).toBe(false)
    for (const value of [
      "not json",
      "{}",
      '{"type":"doc","content":[{"type":"text","text":"bad"}]}',
      paragraph("X").replace(
        '"type":"paragraph"',
        '"type":"paragraph","attrs":{"class":"bad"}'
      ),
    ]) {
      expect(validSampleValue(answer, value)).toBe(false)
    }
  })
  it("uses versioned storage and safely refuses malformed or blocked storage", sliceProfile([]), () => {
    const fields = sampleFields(createSampleSlice("hero-agency"))
    expect(
      sampleStorageKey("hero-agency", "default", "en", "default")
    ).toContain(":v1:")
    expect(
      readSampleStorage(
        {
          getItem() {
            throw Error("blocked")
          },
        },
        "key",
        fields
      )
    ).toEqual({})
    expect(
      readSampleStorage(
        { getItem: () => JSON.stringify({ unknown: "bad" }) },
        "key",
        fields
      )
    ).toEqual({})
  })
  it("isolates storage by slice, presentation, locale and preset and refuses partial corruption", sliceProfile([]), () => {
    const base = ["hero-agency", "default", "en", "default"] as const
    const keys = [
      sampleStorageKey(...base),
      ...base.map((_, index) =>
        sampleStorageKey(
          ...(base.map((part, at) =>
            index === at ? `${part}:different` : part
          ) as [string, string, string, string])
        )
      ),
    ]
    expect(new Set(keys).size).toBe(5)
    const fields = sampleFields(createSampleSlice("hero-agency"))
    const plain = fields.find((field) => field.path === "primary.eyebrow")!
    const values = { [plain.path]: '<b>{"literal":true}</b>' }
    let stored = ""
    const storage = {
      getItem: () => stored,
      setItem: (_key: string, value: string) => {
        stored = value
      },
    }
    expect(writeSampleStorage(storage, keys[0], values, fields)).toBe(true)
    expect(readSampleStorage(storage, keys[0], fields)).toEqual(values)
    expect(
      writeSampleStorage(
        storage,
        keys[0],
        { ...values, unknown: "corrupt" },
        fields
      )
    ).toBe(false)
    expect(
      readSampleStorage(
        { getItem: () => JSON.stringify({ ...values, unknown: "corrupt" }) },
        keys[0],
        fields
      )
    ).toEqual({})
    expect(
      readSampleStorage({ getItem: () => '{"bad' }, keys[0], fields)
    ).toEqual({})
    expect(
      writeSampleStorage(
        {
          setItem() {
            throw Error("blocked")
          },
        },
        keys[0],
        values,
        fields
      )
    ).toBe(false)
  })
})

for (const profileRow of ["features-icon-grid", "hero-with-image", "hero-agency"] as const) {
  it.each([profileRow])("%s simulator projects basic body blocks and reset preserves one-paragraph defaults", sliceProfile([]),
    (type) => {
      const seed = createSampleSlice(type)
      const fields = sampleFields(seed).filter(
        (field) => field.contract === "basic"
      )
      expect(fields.length).toBeGreaterThan(0)
      const value = JSON.stringify({
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "First" }] },
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
          { type: "paragraph", content: [{ type: "text", text: "Last" }] },
        ],
      })
      for (const field of fields)
        expect(validSampleValue(field, value)).toBe(true)
      const edited = projectSamples(
        seed,
        Object.fromEntries(fields.map((field) => [field.path, value]))
      )
      expect(JSON.stringify(edited)).toContain("bulletList")
      expect(sampleFields(projectSamples(seed, {}))).toEqual(sampleFields(seed))
      for (const field of fields)
        expect(JSON.parse(field.value).content).toHaveLength(1)
    }
  )
}

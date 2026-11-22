import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { richText, group, list, text, EMPTY_PM_DOC } from "../blocks/primitives"

import {
  validateFieldMapRichText,
  validateBlocksRichText,
} from "../blocks/validate"
import { writeFieldMap, writePrimitive, writeBlockFields } from "./write"
import { validateStrict } from "./strict"
import { isRichTextEmpty } from "./emptiness"
import { richTextToPlainText } from "./pmText"
import { prepareLegacyRichText } from "../../../lib/rich-text/legacy-html"
import { adoptHeroTitles } from "../../../lib/rich-text/adopt-hero-titles"

const profiles = ["inline", "basic", "full"] as const
const paragraph = (value = "Body") =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text: value }] }],
  })
const nested = JSON.stringify({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "paragraph" }] }],
})
const invalid = [
  "<p>Legacy</p>",
  "plain body",
  "",
  '{"type":',
  '"not a doc"',
  nested,
]
function blockWith(value: string) {
  const sample = createSampleBlock("hero-with-image")
  if (sample.type !== "hero-with-image")
    throw new Error("Expected Hero with Image")
  return { ...sample, primary: { ...sample.primary, description: value } }
}

describe("RF5 canonical authored strict tier", () => {
  test.each(profiles)(
    "%s rejects malformed, non-doc and nested authored input at writer and field-map admission",
    (profile) => {
      const fields = { body: richText({ profile }) }
      for (const value of invalid) {
        expect(() => writeFieldMap(fields, { body: value })).toThrow()
        expect(() =>
          validateFieldMapRichText(fields, { body: value })
        ).toThrow()
        expect(() =>
          validateFieldMapRichText(fields, { body: value }, "legacy")
        ).not.toThrow()
      }
    }
  )
  test.each(profiles)(
    "%s preserves canonical bytes and literal text through nested groups/lists",
    (profile) => {
      const value = paragraph()
      const def = group({
        rows: list(group({ body: richText({ profile }), label: text() })),
      })
      const source = {
        rows: [{ itemId: "old-row", body: value, label: '{"type":"doc"}' }],
      }
      expect(writePrimitive(def, source)).toEqual(source)
      expect(() =>
        writePrimitive(def, { rows: [{ ...source.rows[0], body: nested }] })
      ).toThrow()
      expect(writePrimitive(def, source, { identitiesOnly: true })).toEqual(
        source
      )
      expect(writePrimitive(text(), "<p>literal</p>")).toBe("<p>literal</p>")
    }
  )
  test("block descriptor and writer reject the same realistic invalid body", blockProfile([]), () => {
    const block = blockWith(nested)
    expect(() => writeBlockFields(block, "en")).toThrow()
    expect(() => validateBlocksRichText([block])).toThrow()
  })
  test("registered legacy items enforce strict body admission too", blockProfile([]), () => {
    const sample = createSampleBlock("faq-simple")
    if (sample.type !== "faq-simple") throw new Error("Expected FAQ")
    const invalid = {
      ...sample,
      items: [{ ...sample.items[0], answer: nested }],
    }
    expect(() => writeBlockFields(invalid, "en")).toThrow()
    expect(() => validateBlocksRichText([invalid])).toThrow()
  })
})

describe("RF5 exact trusted legacy copy", () => {
  test.each([
    "plain",
    "",
    EMPTY_PM_DOC,
    "<p>Body</p>",
    JSON.stringify("<p>Body</p>"),
    nested,
    JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Old" }],
        },
      ],
    }),
  ])(
    "preserves accepted original or deterministic inline shape: %s", blockProfile([]),
    (original) => {
      const block = blockWith(original)
      const options = {
        readLegacyShapes: true,
        trustedSource: {
          recordId: "server-read",
          version: 7,
          content: { en: { blocks: [block] } },
        },
      }
      const written = writeBlockFields(block, "en", options).value
      expect(() =>
        validateBlocksRichText([written], "write", { options, locale: "en" })
      ).not.toThrow()
      expect(block.primary.description).toBe(original)
      expect(
        writeBlockFields(written, "en", { identitiesOnly: true }).value
      ).toEqual(written)
    }
  )
  for (const profileRow of [
    "mode",
    "record",
    "version",
    "locale",
    "occurrence",
    "type",
    "duplicate",
    "path",
    "bytes",
  ]) {
    test.each([profileRow])("refuses %s provenance mismatch", blockProfile([]), (attack) => {
      const block = blockWith("<p>Stored</p>")
      const source = structuredClone(block)
      const options = {
        readLegacyShapes: true,
        trustedSource: {
          recordId: "server-read",
          version: 7 as number | undefined,
          content: { en: { blocks: [source] } },
        },
      }
      if (attack === "mode") options.readLegacyShapes = false
      if (attack === "record") options.trustedSource.recordId = ""
      if (attack === "version") options.trustedSource.version = undefined
      if (attack === "occurrence") source.id = "other"
      if (attack === "type") Reflect.set(source, "type", "hero-agency")
      if (attack === "duplicate")
        options.trustedSource.content.en.blocks.push(structuredClone(source))
      if (attack === "path") Reflect.set(source.primary, "description", undefined)
      if (attack === "bytes")
        source.primary.description =
          "<p>Different link <a href='/other'>target</a></p>"
      const locale = attack === "locale" ? "fr" : "en"
      expect(() =>
        writeBlockFields(
          block,
          locale,
          options as Parameters<typeof writeBlockFields>[2]
        )
      ).toThrow()
      expect(() =>
        validateBlocksRichText([block], "write", {
          options: options as Parameters<typeof writeBlockFields>[2] & {},
          locale,
        })
      ).toThrow()
    })
  }
  test("an explicit locale mapping preserves canonical basic heading bytes", blockProfile([]), () => {
    const original = blockWith(
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 2 },
            content: [{ type: "text", text: "Source" }],
          },
        ],
      })
    )
    const options = {
      readLegacyShapes: true,
      trustedSource: {
        recordId: "source",
        version: 9,
        content: { en: { blocks: [original] } },
        sourceLocale: "en",
        destinationLocale: "fr",
      },
    }
    const written = writeBlockFields(original, "fr", options).value
    if (written.type !== "hero-with-image")
      throw new Error("Expected Hero with Image")
    expect(validateStrict("basic", written.primary.description)).toEqual({
      ok: true,
    })
    expect(() =>
      validateBlocksRichText([written], "write", { options, locale: "fr" })
    ).not.toThrow()
    expect(original.primary.description).toBe(written.primary.description)
    expect(() =>
      writeBlockFields(blockWith("<p>Changed</p>"), "fr", options)
    ).toThrow()
  })
  test("trusted legacy HTML requires the exact explicit EN to FR mapping and source bytes", blockProfile([]), () => {
    const original = blockWith("<p>Stored <a href='/source'>source</a></p>")
    const before = JSON.stringify(original)
    const trustedSource = {
      recordId: "source",
      version: 9,
      content: { en: { blocks: [original] } },
      sourceLocale: "en",
      destinationLocale: "fr",
    }
    const options = { readLegacyShapes: true, trustedSource }
    const written = writeBlockFields(original, "fr", options).value
    if (written.type !== "hero-with-image")
      throw new Error("Expected Hero with Image")
    expect(written.primary.description).toBe(original.primary.description)
    expect(() =>
      validateBlocksRichText([written], "write", { options, locale: "fr" })
    ).not.toThrow()
    expect(JSON.stringify(original)).toBe(before)
    for (const mapping of [
      {
        ...trustedSource,
        sourceLocale: undefined,
        destinationLocale: undefined,
      },
      { ...trustedSource, sourceLocale: "de" },
      { ...trustedSource, destinationLocale: "de" },
    ])
      expect(() =>
        writeBlockFields(original, "fr", {
          readLegacyShapes: true,
          trustedSource: mapping,
        })
      ).toThrow()
    expect(() =>
      writeBlockFields(
        {
          ...original,
          primary: { ...original.primary, description: "<p>Changed</p>" },
        },
        "fr",
        options
      )
    ).toThrow()
  })

  test("genuine FAQ inline body still converts heading shape into a paragraph", blockProfile([]), () => {
    const original = createSampleBlock("faq-simple")
    const heading = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Source" }],
        },
      ],
    })
    original.primary.body = heading
    const written = writeBlockFields(original, "fr", {
      readLegacyShapes: true,
      trustedSource: {
        recordId: "faq-source",
        version: 9,
        content: { en: { blocks: [original] } },
        sourceLocale: "en",
        destinationLocale: "fr",
      },
    }).value
    if (written.type !== "faq-simple") throw new Error("Expected FAQ Simple")
    expect(JSON.parse(written.primary.body!).content[0].type).toBe("paragraph")
    expect(validateStrict("inline", written.primary.body!)).toEqual({
      ok: true,
    })
    expect(original.primary.body).toBe(heading)
  })
})

describe("RF5 parent preparation", () => {
  test.each([
    "<p><strong>Hello</strong> <a data-page-id='target' rel='nofollow sponsored ugc'>CMS</a> <a href='/other' target='_blank'>Other</a></p>",
    JSON.stringify("<p>JSON HTML</p>"),
    "plain body",
    "",
    "# plain markdown",
  ])(
    "canonicalizes a supported legacy body before authored save: %s", blockProfile([]),
    (body) => {
      const source = blockWith(body)
      const adopted = adoptHeroTitles([source], "en")
      const output = adopted.value[0].primary as typeof source.primary
      expect(validateStrict("basic", output.description)).toEqual({ ok: true })
      expect(source.primary.description).toBe(body)
      expect(adoptHeroTitles(adopted.value, "en", adopted.reports)).toEqual(
        adopted
      )
      if (body.includes("data-page-id")) {
        expect(output.description).toContain('"pageId":"target"')
        expect(output.description).toContain('"noFollow":true')
        expect(output.description).toContain('"sponsored":true')
        expect(output.description).toContain('"ugc":true')
        expect(output.description).toContain('"href":"/other"')
        expect(output.description).toContain('"target":"_blank"')
      }
    }
  )
  test("keeps canonical PM bytes and text fields, and refuses malformed PM rather than reinterpreting it", blockProfile([]), () => {
    const source = blockWith(paragraph())
    source.primary.eyebrow = "<p>literal text</p>"
    expect(adoptHeroTitles([source], "en").value[0]).toEqual(source)
    for (const value of ['{"type":', JSON.stringify({ type: "doc" }), nested])
      expect(() => adoptHeroTitles([blockWith(value)], "en")).toThrow()
  })
})

describe("RF5 canonical empty producer contract", () => {
  test.each(profiles)(
    "%s default and narrow legacy parent empty-doc adoption produce strict empty paragraphs",
    (profile) => {
      const empty = '{"type":"doc","content":[{"type":"paragraph"}]}'
      expect(richText({ profile }).default).toBe(empty)
      expect(validateStrict(profile, richText({ profile }).default!)).toEqual({
        ok: true,
      })
      expect(isRichTextEmpty(empty)).toBe(true)
      expect(richTextToPlainText(empty)).toBe("")
      expect(EMPTY_PM_DOC).toBe('{"type":"doc","content":[]}')
      expect(richText({ contract: "title" }).default).toBe(
        '{"type":"doc","content":[{"type":"heading","attrs":{"level":2}}]}'
      )
      for (const legacy of [
        EMPTY_PM_DOC,
        ' { "content" : [], "type" : "doc" } ',
      ]) {
        expect(prepareLegacyRichText(legacy, profile)).toBe(empty)
        expect(
          prepareLegacyRichText(prepareLegacyRichText(legacy, profile), profile)
        ).toBe(empty)
      }
      for (const invalid of [
        '{"type":"doc"}',
        '{"type":"doc","content":[],"metadata":"retain"}',
        nested,
      ]) {
        expect(prepareLegacyRichText(invalid, profile)).toBe(invalid)
        expect(() => writePrimitive(richText({ profile }), invalid)).toThrow()
      }
    }
  )
})

test("RF5 parent prepares registered full primary and basic item bodies", blockProfile([]), () => {
  const full = createSampleBlock("rich-text-body")
  const faq = createSampleBlock("faq-simple")
  if (full.type !== "rich-text-body" || faq.type !== "faq-simple")
    throw new Error("Expected registered body descriptors")
  const body = "<h2>Heading</h2><p><em>Body</em> <a href='/target'>link</a></p>"
  const incoming = [
    { ...full, primary: { ...full.primary, body } },
    { ...faq, items: [{ ...faq.items[0], answer: body }] },
  ]
  const before = JSON.stringify(incoming)
  const adopted = adoptHeroTitles(incoming, "en")
  const nextFull = adopted.value[0]
  const nextFaq = adopted.value[1]
  if (nextFull.type !== "rich-text-body" || nextFaq.type !== "faq-simple")
    throw new Error("Expected registered body descriptors")
  expect(validateStrict("full", nextFull.primary.body)).toEqual({ ok: true })
  expect(validateStrict("basic", nextFaq.items[0].answer)).toEqual({ ok: true })
  expect(nextFull.primary.body).toContain('"href":"/target"')
  expect(nextFaq.items[0].answer).toContain('"type":"italic"')
  expect(JSON.stringify(incoming)).toBe(before)
  expect(adoptHeroTitles(adopted.value, "en", adopted.reports)).toEqual(adopted)
})

test("RF5 repaired occurrence provenance preserves distinct original legacy bodies", blockProfile([]), async () => {
  const { repairLocalizedBlockIds } = await import("../blocks/identity")
  const original = {
    en: {
      blocks: [
        { ...blockWith("<p>First <a href='/one'>body</a></p>"), id: "kept" },
        { ...blockWith("<p>Second <a href='/two'>body</a></p>"), id: "kept" },
        { ...blockWith("<p>Third</p>"), id: "" },
      ],
    },
  }
  let n = 0
  const repaired = repairLocalizedBlockIds(original, () => `repaired-${++n}`)!
  const options = {
    readLegacyShapes: true,
    trustedSource: {
      recordId: "actual-record",
      version: 3,
      content: original,
      repairedIdentityContent: repaired,
    },
  }
  const written = writeFieldMap(
    { rows: list(group({ body: richText({ profile: "inline" }) })) },
    { rows: [] }
  )
  expect(written).toEqual({ rows: [] })
  for (const block of repaired.en.blocks) {
    const output = writeBlockFields(block, "en", options).value
    expect(output.primary).toEqual(block.primary)
    expect(() =>
      validateBlocksRichText([output], "write", { options, locale: "en" })
    ).not.toThrow()
  }
  expect(repaired.en.blocks.map((row) => row.id)).toEqual([
    "kept",
    "repaired-1",
    "repaired-2",
  ])
  expect(original.en.blocks.map((row) => row.id)).toEqual(["kept", "kept", ""])
  for (const attack of [
    "payload",
    "reorder",
    "duplicate",
    "locale",
    "changed-valid-id",
  ] as const) {
    const view = structuredClone(repaired)
    if (attack === "payload")
      view.en.blocks[1].primary.description = "<p>Changed</p>"
    if (attack === "reorder") view.en.blocks.reverse()
    if (attack === "duplicate") view.en.blocks[1].id = view.en.blocks[0].id
    if (attack === "changed-valid-id") view.en.blocks[0].id = "forged"
    const untrusted = {
      ...options,
      trustedSource: {
        ...options.trustedSource,
        repairedIdentityContent: view,
      },
    }
    expect(() =>
      writeBlockFields(
        view.en.blocks[1],
        attack === "locale" ? "fr" : "en",
        untrusted
      )
    ).toThrow()
  }
})

test("RF5 repaired identity view cannot broaden original title HTML preservation", blockProfile([]), async () => {
  const { repairLocalizedBlockIds } = await import("../blocks/identity")
  const original = {
    en: {
      blocks: [blockWith("Body"), blockWith("Other body")].map((row) => ({
        ...row,
        id: "duplicate",
        primary: { ...row.primary, title: "<p>Legacy title</p>" },
      })),
    },
  }
  const repaired = repairLocalizedBlockIds(original, () => "repaired")!
  const options = {
    readLegacyShapes: true,
    trustedSource: {
      recordId: "record",
      version: 3,
      content: original,
      repairedIdentityContent: repaired,
    },
  }
  expect(() => writeBlockFields(repaired.en.blocks[1], "en", options)).toThrow(
    "TITLE_HTML_REQUIRES_EDITOR_ADOPTION"
  )
})

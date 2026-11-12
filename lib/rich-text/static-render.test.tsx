import { sliceProfile } from "@/test-utils/slice-profile"
import { act, createElement } from "react"
import { hydrateRoot, type Root } from "react-dom/client"
import { renderToStaticMarkup, renderToString } from "react-dom/server"
import type { JSONContent } from "@tiptap/core"
import { getSchema } from "@tiptap/core"
import { Node as ProseMirrorNode } from "@tiptap/pm/model"
import { describe, expect, it, vi } from "vitest"

import {
  REGISTERED_SLICE_TYPES,
  sliceDefs,
  type Slice,
} from "@/convex/lib/slices"
import { walkValue } from "@/convex/lib/slices/walk"
import type { Primitive } from "@/convex/lib/slices/primitives"
import {
  PROFILE_SPECS,
  type RichTextProfile,
  validateDoc,
} from "@/convex/lib/richtext/profiles"
import { resolveFieldContract } from "@/convex/lib/richtext/contracts"
import { toFieldShape } from "@/convex/lib/richtext/shape"
import { RichTextContent } from "@/components/slices/rich-text-content"
import { createSampleSlice } from "@/lib/slices/sample"
import type { SliceRenderContext } from "@/lib/slices/links"
import { richTextToDocument } from "./render"
import { extensionsForProfile } from "./extensions"
import {
  frozenDocumentFor,
  LegacyRichTextWalkerOracle,
  renderFrozenDocument,
} from "./static-render.oracle"
import { renderStaticRichTextDocument } from "./static-render"

type CorpusCase = {
  readonly label: string
  readonly profile: RichTextProfile
  readonly value: string
  readonly ctx?: SliceRenderContext
  readonly fieldPath?: string
}

function descriptorContentCases(): CorpusCase[] {
  const cases: CorpusCase[] = []
  for (const type of REGISTERED_SLICE_TYPES) {
    const descriptor = sliceDefs[type]
    const defaults = registeredDefaultSlice(type) as unknown as Record<
      string,
      unknown
    >
    const sample = createSampleSlice(type) as unknown as Record<string, unknown>
    const collect = (label: string, def: Primitive, value: unknown) => {
      walkValue(def, value, (leaf) => {
        if (leaf.def.kind !== "richText" || typeof leaf.value !== "string")
          return
        const profile = resolveFieldContract(leaf.def.config).contract
        if (profile !== "inline" && profile !== "basic" && profile !== "full")
          return
        cases.push({
          label: `${label} ${type}.${leaf.path}`,
          profile,
          value: leaf.value,
        })
      })
    }
    collect("descriptor default", descriptor.primary, defaults.primary)
    collect("descriptor sample", descriptor.primary, sample.primary)
    if ("items" in descriptor) {
      collect("descriptor default list", descriptor.items, defaults.items)
      collect("descriptor sample list", descriptor.items, sample.items)
    }
  }
  return cases
}

const sampleDocs: ReadonlyArray<{
  label: string
  profile: RichTextProfile
  document: JSONContent
}> = [
  {
    label: "basic paragraphs, marks, and current page path",
    profile: "basic",
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Hello " },
            {
              type: "text",
              text: "world",
              marks: [
                { type: "bold" },
                {
                  type: "link",
                  attrs: {
                    href: "/cached",
                    pageId: "about",
                    target: "_blank",
                    noFollow: true,
                    sponsored: true,
                    ugc: true,
                    title: "About",
                  },
                },
              ],
            },
          ],
        },
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "Heading" }],
        },
        {
          type: "orderedList",
          attrs: { start: 3 },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "item" }],
                },
              ],
            },
          ],
        },
      ],
    },
  },
  {
    label: "inline paragraphs, hard break, and all inline marks",
    profile: "inline",
    document: {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "one", marks: [{ type: "italic" }] },
            { type: "hardBreak" },
            { type: "text", text: "two", marks: [{ type: "underline" }] },
          ],
        },
        {
          type: "paragraph",
          content: [
            { type: "text", text: "three", marks: [{ type: "highlight" }] },
          ],
        },
      ],
    },
  },
  {
    label: "full-profile blocks, tables, and media",
    profile: "full",
    document: {
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 6 },
          content: [{ type: "text", text: "Title" }],
        },
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "quote" }] },
          ],
        },
        { type: "codeBlock", content: [{ type: "text", text: "const x = 1" }] },
        { type: "horizontalRule" },
        {
          type: "image",
          attrs: {
            src: "/media/a.png",
            alt: "A",
            title: "Media",
            width: 640,
            height: 480,
          },
        },
        {
          type: "table",
          content: [
            {
              type: "tableRow",
              content: [
                {
                  type: "tableHeader",
                  attrs: { colspan: 2, rowspan: 1 },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "head" }],
                    },
                  ],
                },
                {
                  type: "tableCell",
                  attrs: { colspan: 1 },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "cell" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
  },
]

const existingTestFixtures: ReadonlyArray<CorpusCase> = [
  {
    label: "render.test plain link",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link",
              marks: [{ type: "link", attrs: { href: "https://example.com" } }],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "render.test composed rel and pageId",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "/cached",
                    pageId: "about",
                    target: "_blank",
                    noFollow: true,
                    sponsored: true,
                    ugc: true,
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
    ctx: {
      locale: "fr",
      defaultLocale: "en",
      pagePaths: { about: "/fr/about" },
    },
  },
  {
    label: "render-helpers XSS structured value",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: '<img src=x onerror="alert(1)">' },
            {
              type: "text",
              text: "bad link",
              marks: [{ type: "link", attrs: { href: "javascript:alert(2)" } }],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "render-helpers inline paragraph separation",
    profile: "inline",
    value: JSON.stringify({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "one" }] },
        { type: "paragraph", content: [{ type: "text", text: "two" }] },
      ],
    }),
  },
  {
    label: "render-helpers full-profile table",
    profile: "full",
    value: JSON.stringify({
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
                  attrs: { colspan: 2 },
                  content: [
                    {
                      type: "paragraph",
                      content: [{ type: "text", text: "Heading" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "HeroAgency inline emphasis fixture",
    profile: "inline",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Bold", marks: [{ type: "bold" }] },
            { type: "text", text: " italic", marks: [{ type: "italic" }] },
            { type: "text", text: " retired", marks: [{ type: "strike" }] },
            {
              type: "text",
              text: " highlighted",
              marks: [{ type: "highlight" }],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "HeroWithImage long title and hardBreak fixture",
    profile: "inline",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "SupercalifragilisticexpialidociousSupercalifragilisticexpialidocious",
              marks: [{ type: "bold" }],
            },
            { type: "hardBreak" },
            {
              type: "text",
              text: "A continued title",
              marks: [{ type: "italic" }],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "centered Hero localized links and stored mark order",
    profile: "inline",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "Une équipe", marks: [{ type: "bold" }] },
            { type: "text", text: " attentive", marks: [{ type: "italic" }] },
            {
              type: "text",
              text: " — découvrir",
              marks: [
                {
                  type: "link",
                  attrs: { href: "/stale", pageId: "learn", noFollow: true },
                },
              ],
            },
          ],
        },
      ],
    }),
    ctx: {
      locale: "fr",
      defaultLocale: "en",
      pagePaths: { learn: "/fr/apprendre" },
    },
  },
  {
    label: "centered Hero description typography fixture",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "Une description traduite assez longue pour conserver tous les détails utiles.",
              marks: [{ type: "italic" }],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "roundtrip.test pageId and rel fixture",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "/cached",
                    pageId: "pageABC",
                    noFollow: true,
                    sponsored: true,
                    ugc: true,
                    target: "_blank",
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "empty PM doc",
    profile: "basic",
    value: '{"type":"doc","content":[]}',
  },
  { label: "empty value", profile: "basic", value: "" },
  { label: "whitespace value", profile: "basic", value: "   " },
  {
    label: "raw legacy HTML",
    profile: "basic",
    value:
      '<p><strong>Bold</strong> <a href="/about" title="About" target="_blank">link</a></p>',
  },
  {
    label: "JSON encoded legacy HTML",
    profile: "basic",
    value: JSON.stringify("<p>Legacy <em>text</em></p>"),
  },
  {
    label: "invalid JSON legacy HTML",
    profile: "basic",
    value: '<p onclick="bad()">legacy<script>bad()</script></p>',
  },
  {
    label: "JSON that is not a doc",
    profile: "basic",
    value: JSON.stringify({ title: "not a rich text document" }),
  },
  {
    label: "empty paragraph doc",
    profile: "inline",
    value: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [] }],
    }),
  },
  {
    label: "render.test stale empty text node",
    profile: "full",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "" },
            { type: "text", text: "kept" },
          ],
        },
      ],
    }),
  },
  {
    label: "render-helpers rejected malformed child",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [null, { content: "not-an-array" }],
    }),
  },
  {
    label: "unknown node rejected by validation",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [{ type: "unknown", content: [] }],
    }),
  },
  {
    label: "out-of-profile heading rejected by validation",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 6 },
          content: [{ type: "text", text: "not allowed" }],
        },
      ],
    }),
  },
  {
    label: "out-of-profile code mark rejected by validation",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "unknown mark", marks: [{ type: "code" }] },
          ],
        },
      ],
    }),
  },
  {
    label: "stored link then bold mark order",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "order",
              marks: [
                { type: "link", attrs: { href: "/x" } },
                { type: "bold" },
              ],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "adjacent identical marks stay segmented",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "one", marks: [{ type: "bold" }] },
            { type: "text", text: "two", marks: [{ type: "bold" }] },
          ],
        },
      ],
    }),
  },
  {
    label: "marks on nontext node are ignored",
    profile: "full",
    value: JSON.stringify({
      type: "doc",
      content: [
        { type: "hardBreak", marks: [{ type: "bold" }] },
        {
          type: "image",
          attrs: { src: "/x.png", alt: "x" },
          marks: [{ type: "italic" }],
        },
      ],
    }),
  },
  {
    label: "unsafe image source and missing alt",
    profile: "full",
    value: JSON.stringify({
      type: "doc",
      content: [
        { type: "image", attrs: { src: "javascript:alert(1)" } },
        { type: "image", attrs: { src: "/safe.png" } },
      ],
    }),
  },
  {
    label: "ordered list numeric string and invalid start cases",
    profile: "full",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "orderedList",
          attrs: { start: "3" },
          content: [
            {
              type: "listItem",
              content: [
                {
                  type: "paragraph",
                  content: [{ type: "text", text: "three" }],
                },
              ],
            },
          ],
        },
        { type: "orderedList", attrs: { start: 0 }, content: [] },
        { type: "orderedList", attrs: { start: 2.5 }, content: [] },
      ],
    }),
  },
  {
    label: "heading numeric-string level and invalid level cases",
    profile: "full",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: "2" },
          content: [{ type: "text", text: "two" }],
        },
        { type: "heading", attrs: { level: -1 }, content: [] },
        { type: "heading", attrs: { level: 2.5 }, content: [] },
      ],
    }),
  },
  {
    label: "table spans including explicit one",
    profile: "full",
    value: JSON.stringify({
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
                  attrs: { colspan: 1, rowspan: "2" },
                  content: [],
                },
                {
                  type: "tableCell",
                  attrs: { colspan: -1, rowspan: 2.5 },
                  content: [],
                },
              ],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "codeBlock language attr has no class",
    profile: "full",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const x = 1" }],
        },
      ],
    }),
  },
]

const additionalExactSourceFixtures: ReadonlyArray<CorpusCase> = [
  {
    label: "render.test openInNewTab link exact document",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: { href: "https://example.com", target: "_blank" },
                },
              ],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "render.test nofollow sponsored ugc exact document",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: {
                    href: "https://example.com",
                    noFollow: true,
                    sponsored: true,
                    ugc: true,
                  },
                },
              ],
            },
          ],
        },
      ],
    }),
  },
  {
    label: "render.test pageId cached-href fallback",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: { href: "/cached", pageId: "abc123" },
                },
              ],
            },
          ],
        },
      ],
    }),
    ctx: { locale: "fr", defaultLocale: "fr", pagePaths: {} },
  },
  {
    label: "render.test pageId localized prefix and ancestry",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: { href: "/cached", pageId: "abc123" },
                },
              ],
            },
          ],
        },
      ],
    }),
    ctx: {
      locale: "en",
      defaultLocale: "fr",
      pagePaths: { abc123: "/en/company/about" },
    },
  },
  {
    label: "render.test pageId current-path replacement",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "link",
              marks: [
                {
                  type: "link",
                  attrs: { href: "/old-cached-slug", pageId: "abc123" },
                },
              ],
            },
          ],
        },
      ],
    }),
    ctx: {
      locale: "fr",
      defaultLocale: "fr",
      pagePaths: { abc123: "/renamed-page" },
    },
  },
  {
    label: "render.test inline flatten exact document",
    profile: "inline",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hello " },
            { type: "text", text: "world", marks: [{ type: "bold" }] },
          ],
        },
      ],
    }),
  },
  {
    label: "render.test legacy inline paragraph exact value",
    profile: "inline",
    value: "<p>legacy</p>",
  },
  {
    label: "render.test safe legacy HTML exact value",
    profile: "basic",
    value: "<p>hi</p>",
  },
  {
    label: "render.test legacy HTML sanitization exact value",
    profile: "basic",
    value:
      '<p onclick="alert(1)">Hi<script>alert(1)</script><a href="javascript:alert(1)" onmouseover="alert(2)">bad</a><a href="/safe" target="_blank">safe</a></p>',
  },
  {
    label: "render-helpers unsafe legacy image exact value",
    profile: "full",
    value:
      '<p>Hello<img src="x" onerror="alert(1)"><script>alert(2)</script></p>',
  },
  {
    label: "render.test exact two-row full table document",
    profile: "full",
    value: JSON.stringify({
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
              ],
            },
            {
              type: "tableRow",
              content: [
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
    }),
  },
  {
    label: "render-helpers page-1 localized link exact document",
    profile: "basic",
    value: JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "About",
              marks: [
                {
                  type: "link",
                  attrs: { href: "/old", pageId: "page-1" },
                },
              ],
            },
          ],
        },
      ],
    }),
    ctx: {
      locale: "fr",
      defaultLocale: "en",
      pagePaths: { "page-1": "/fr/a-propos" },
    },
  },
  {
    label: "slice-kit empty paragraph rich text value",
    profile: "inline",
    value: '{"type":"doc","content":[{"type":"paragraph"}]}',
  },
  {
    label: "slice-kit descriptor heading exact document",
    profile: "inline",
    value:
      '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"text","text":"Heading"}]}]}',
  },
  {
    label: "HeroAgency legacy plain title",
    profile: "inline",
    value: "Existing plain title",
  },
  {
    label: "rich-text-content uninstrumented raw text",
    profile: "inline",
    value: "Text",
  },
]

const pageLivePreviewTextFixtures = [
  "Firstac",
  "external",
  "Firsta",
  "Firstabc",
  "Firstabcd",
  "Repeated headline",
  "Repeated headline [native Escape] again",
  "external apply",
  "Copy",
  "First",
  "Ghost",
  "List title",
  "Different supporting copy",
  "RepeXated headline",
  "Repeated hXeadline",
] as const

const pageLivePreviewFixtures: ReadonlyArray<CorpusCase> =
  pageLivePreviewTextFixtures.map((text) => ({
    label: `page-live-preview pm helper: ${text}`,
    profile: "inline",
    value: JSON.stringify({
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    }),
  }))

const corpus: CorpusCase[] = [
  ...descriptorContentCases(),
  ...sampleDocs.map(({ label, profile, document }) => ({
    label: `descriptor/default sample: ${label}`,
    profile,
    value: JSON.stringify(document),
  })),
  ...existingTestFixtures,
  ...additionalExactSourceFixtures,
  ...pageLivePreviewFixtures,
]
const comparisonProfiles = ["inline", "basic", "full"] as const
const classifiedComparisons = corpus
  .flatMap((testCase) =>
    comparisonProfiles.map((profile) => ({
      ...testCase,
      profile,
      label: `${testCase.label}/${profile}`,
    }))
  )
  .map((testCase) => ({ testCase, qualified: isOldValidSubset(testCase) }))
const qualifiedComparisons = classifiedComparisons
  .filter(({ qualified }) => qualified)
  .map(({ testCase }) => testCase)
const excludedComparisonLabels = classifiedComparisons
  .filter(({ qualified }) => !qualified)
  .map(({ testCase }) => testCase.label)
const excludedComparisonCases = excludedComparisonLabels.length

function parityMarkup(
  testCase: CorpusCase,
  Component: typeof RichTextContent | typeof LegacyRichTextWalkerOracle
): string {
  const props = {
    value: testCase.value,
    profile: testCase.profile,
    ...(testCase.fieldPath ? { fieldPath: testCase.fieldPath } : {}),
    ...(testCase.ctx ? { ctx: testCase.ctx } : {}),
  }
  return renderToStaticMarkup(createElement(Component, props))
}

const oracleSchemas = new Map<RichTextProfile, ReturnType<typeof getSchema>>()

function copiedBaselineShape(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(copiedBaselineShape).filter((child) => child !== undefined)
  }
  if (typeof value !== "object" || value === null) return value

  const record = value as Record<string, unknown>
  if (
    record.type === "text" &&
    (typeof record.text !== "string" || record.text.length === 0)
  ) {
    return undefined
  }

  const copy: Record<string, unknown> = { ...record }
  if (!Array.isArray(record.content)) {
    delete copy.content
  } else {
    copy.content = copiedBaselineShape(record.content)
  }
  if (!Array.isArray(record.marks)) {
    delete copy.marks
  } else {
    copy.marks = record.marks.map((candidate) => {
      if (typeof candidate !== "object" || candidate === null) return candidate
      const mark = candidate as Record<string, unknown>
      if (mark.type !== "link") return { ...mark }
      const attrs =
        typeof mark.attrs === "object" && mark.attrs !== null
          ? { ...(mark.attrs as Record<string, unknown>) }
          : {}
      if (!Object.prototype.hasOwnProperty.call(attrs, "target"))
        attrs.target = null
      return { ...mark, attrs }
    })
  }
  return copy
}

function baselinePositiveInteger(value: unknown): number | undefined {
  try {
    const parsed = typeof value === "number" ? value : Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  } catch {
    return undefined
  }
}

function canonicalOracleMarkup(testCase: CorpusCase): string {
  const document = copiedBaselineShape(
    JSON.parse(
      JSON.stringify(
        frozenDocumentFor(testCase.value, testCase.profile, testCase.ctx)
      )
    )
  ) as JSONContent
  let schema = oracleSchemas.get(testCase.profile)
  if (!schema) {
    schema = getSchema(extensionsForProfile(testCase.profile))
    oracleSchemas.set(testCase.profile, schema)
  }
  const parsed = ProseMirrorNode.fromJSON(schema, document)
  const canonical = parsed.toJSON() as JSONContent
  const pruneDefaults = (node: JSONContent): void => {
    if (node.attrs) {
      if (
        node.type === "orderedList" &&
        baselinePositiveInteger(node.attrs.start) === 1
      )
        delete node.attrs.start
      if (
        (node.type === "tableCell" || node.type === "tableHeader") &&
        baselinePositiveInteger(node.attrs.colspan) === 1
      )
        delete node.attrs.colspan
      if (
        (node.type === "tableCell" || node.type === "tableHeader") &&
        baselinePositiveInteger(node.attrs.rowspan) === 1
      )
        delete node.attrs.rowspan
    }
    node.content?.forEach(pruneDefaults)
  }
  pruneDefaults(canonical)
  return renderToStaticMarkup(
    renderFrozenDocument(canonical, testCase.profile, undefined, {
      value: testCase.value,
      ctx: testCase.ctx,
      fieldPath: testCase.fieldPath,
    })
  )
}

function isOldValidSubset(testCase: CorpusCase): boolean {
  try {
    const frozenDocument = frozenDocumentFor(
      testCase.value,
      testCase.profile,
      testCase.ctx
    )
    renderToStaticMarkup(renderFrozenDocument(frozenDocument, testCase.profile))

    let parsedValue: unknown
    try {
      parsedValue = JSON.parse(testCase.value)
    } catch {
      parsedValue = undefined
    }
    const isStoredDocument =
      typeof parsedValue === "object" &&
      parsedValue !== null &&
      (parsedValue as { type?: unknown }).type === "doc"
    if (!isStoredDocument) return true

    const shaped = toFieldShape(
      resolveFieldContract(testCase.profile),
      testCase.value
    )
    if (!validateDoc(shaped.value, testCase.profile).ok) return false
    const document = JSON.parse(shaped.value) as unknown
    if (typeof document !== "object" || document === null) return false
    const profileSpec = PROFILE_SPECS[testCase.profile]
    const allowedLevels = profileSpec.headingLevels
    const visit = (value: unknown): boolean => {
      if (typeof value !== "object" || value === null) return true
      const record = value as {
        type?: unknown
        attrs?: unknown
        content?: unknown
        marks?: unknown
      }
      if (
        typeof record.type !== "string" ||
        !profileSpec.nodes.has(record.type)
      )
        return false
      if (
        Array.isArray(record.marks) &&
        !record.marks.every(
          (mark) =>
            typeof mark === "object" &&
            mark !== null &&
            typeof (mark as { type?: unknown }).type === "string" &&
            profileSpec.marks.has((mark as { type: string }).type)
        )
      ) {
        return false
      }
      if (record.type === "heading") {
        if (typeof record.attrs !== "object" || record.attrs === null)
          return false
        const level = (record.attrs as { level?: unknown }).level
        if (level === undefined) return false
        const parsed =
          typeof level === "number" || typeof level === "string"
            ? Number(level)
            : Number.NaN
        if (
          !Number.isInteger(parsed) ||
          parsed <= 0 ||
          !allowedLevels.has(parsed)
        )
          return false
      }
      return !Array.isArray(record.content) || record.content.every(visit)
    }
    return visit(document)
  } catch {
    return false
  }
}

type SemanticMark = {
  tag: string
  attributes: ReadonlyArray<readonly [string, string]>
}

type SemanticSnapshot = {
  elements: ReadonlyArray<{
    tag: string
    attributes: ReadonlyArray<readonly [string, string]>
  }>
  textNodes: ReadonlyArray<string>
  characters: ReadonlyArray<{
    character: string
    marks: ReadonlyArray<SemanticMark>
  }>
}

const semanticMarkTags = new Set([
  "a",
  "code",
  "em",
  "mark",
  "s",
  "strong",
  "sub",
  "sup",
  "u",
])

function semanticSnapshot(markup: string): SemanticSnapshot {
  const container = document.createElement("div")
  container.innerHTML = markup
  const elements: Array<{
    tag: string
    attributes: Array<readonly [string, string]>
  }> = []
  const textNodes: string[] = []
  const characters: Array<{ character: string; marks: SemanticMark[] }> = []
  const visit = (node: Node, inheritedMarks: SemanticMark[]): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent ?? ""
      textNodes.push(text)
      for (const character of Array.from(text)) {
        characters.push({ character, marks: [...inheritedMarks] })
      }
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return
    const element = node as Element
    const tag = element.localName
    const attributes = Array.from(element.attributes)
      .map((attribute) => [attribute.name, attribute.value] as const)
      .sort(([left], [right]) => left.localeCompare(right))
    elements.push({ tag, attributes })
    const nextMarks = semanticMarkTags.has(tag)
      ? [...inheritedMarks, { tag, attributes }]
      : inheritedMarks
    for (const child of Array.from(element.childNodes)) visit(child, nextMarks)
  }
  for (const child of Array.from(container.childNodes)) visit(child, [])
  return { elements, textNodes, characters }
}

describe("static renderer compatibility adapter", () => {
  it("retains descriptor-owned supporting body cases in the renderer corpus", sliceProfile([]), () => {
    const cases = descriptorContentCases()
    for (const [type, path] of [
      ["features-icon-grid", "body"],
      ["features-icon-grid", "[0].body"],
      ["hero-with-image", "description"],
      ["hero-agency", "description"],
    ]) {
      const sample = cases.find(
        (entry) =>
          entry.label ===
          `descriptor sample${path.startsWith("[") ? " list" : ""} ${type}.${path}`
      )
      expect(sample).toBeDefined()
      expect(sample?.profile).toBe("basic")
    }
  })

  it.each(qualifiedComparisons)(
    "preserves canonicalized markup for $label",
    (testCase) => {
      expect(parityMarkup(testCase, RichTextContent), testCase.label).toBe(
        canonicalOracleMarkup(testCase)
      )
    }
  )

  it("keeps every corpus fixture identical in public, localized, and preview-hook contexts", () => {
    const pagePaths = { about: "/fr/a-propos", careers: "/fr/carrieres" }
    for (const testCase of qualifiedComparisons) {
      const publicValue = {
        ...testCase,
        ctx: undefined,
        label: `${testCase.label}/public`,
      }
      expect(publicValue.ctx, publicValue.label).toBeUndefined()
      expect(
        parityMarkup(publicValue, RichTextContent),
        publicValue.label
      ).toBe(canonicalOracleMarkup(publicValue))

      const localized: CorpusCase = {
        ...testCase,
        label: `${testCase.label}/pagePaths`,
        ctx: {
          locale: "fr",
          defaultLocale: "en",
          pagePaths,
          relationCards: {},
        },
      }
      expect(parityMarkup(localized, RichTextContent), localized.label).toBe(
        canonicalOracleMarkup(localized)
      )
      const previewHook = vi.fn<
        NonNullable<SliceRenderContext["previewRichText"]>
      >(({ rendered }) => rendered)
      const preview: CorpusCase = {
        ...testCase,
        label: `${testCase.label}/preview`,
        fieldPath: "primary.body",
        ctx: {
          locale: "fr",
          defaultLocale: "en",
          pagePaths,
          previewRichText: previewHook,
        },
      }
      expect(parityMarkup(preview, RichTextContent), preview.label).toBe(
        canonicalOracleMarkup(preview)
      )
      expect(previewHook).toHaveBeenCalledTimes(2)
      expect(previewHook).toHaveBeenCalledWith(
        expect.objectContaining({
          fieldPath: "primary.body",
          profile: testCase.profile,
        })
      )
    }
    console.info(
      JSON.stringify({
        event: "R2b old-valid subset",
        sourceValues: corpus.length,
        excludedProfileComparisons: excludedComparisonCases,
        qualifiedComparisons: qualifiedComparisons.length,
        contexts: 3,
        totalComparisons: qualifiedComparisons.length * 3,
        qualifiedLabels: qualifiedComparisons.map(({ label }) => label),
        excludedLabels: excludedComparisonLabels,
      })
    )
  })

  it("matches jsdom-normalized semantics for text marks and rich-text elements", () => {
    const pagePaths = {
      about: "/fr/a-propos",
      careers: "/fr/carrieres",
      learn: "/fr/apprendre",
    }
    const elementEvidence = new Set<string>()
    const characterEvidence = new Set<string>()
    for (const testCase of qualifiedComparisons) {
      const variants: CorpusCase[] = [
        { ...testCase, ctx: undefined },
        {
          ...testCase,
          fieldPath: "primary.body",
          ctx: {
            locale: "fr",
            defaultLocale: "en",
            pagePaths,
            previewRichText: ({ rendered }) => rendered,
          },
        },
        {
          ...testCase,
          ctx: {
            locale: "fr",
            defaultLocale: "en",
            pagePaths,
            relationCards: {},
          },
        },
      ]
      for (const variant of variants) {
        const expected = semanticSnapshot(canonicalOracleMarkup(variant))
        const actual = semanticSnapshot(parityMarkup(variant, RichTextContent))
        expect(actual, variant.label).toEqual(expected)
        for (const element of actual.elements) {
          elementEvidence.add(`tag:${element.tag}`)
          for (const [name, value] of element.attributes) {
            elementEvidence.add(`attr:${element.tag}:${name}`)
            elementEvidence.add(`value:${element.tag}:${name}=${value}`)
          }
        }
        for (const { character, marks } of actual.characters) {
          characterEvidence.add(
            `${character}:${marks.map((mark) => mark.tag).join(">")}`
          )
        }
      }
    }
    for (const tag of [
      "span",
      "h2",
      "h6",
      "ol",
      "th",
      "td",
      "img",
      "a",
      "strong",
      "em",
    ]) {
      expect(elementEvidence, `semantic tag ${tag}`).toContain(`tag:${tag}`)
    }
    for (const attribute of [
      "a:href",
      "a:rel",
      "a:target",
      "a:title",
      "a:data-page-id",
      "ol:start",
      "th:colspan",
      "th:rowspan",
      "img:src",
      "img:alt",
      "img:title",
      "img:width",
      "img:height",
    ]) {
      expect(elementEvidence, `semantic attribute ${attribute}`).toContain(
        `attr:${attribute}`
      )
    }
    expect(characterEvidence).toContain("B:strong")
    expect(characterEvidence).toContain("i:em")
  })

  it("renders a malformed inline root as an empty host without throwing", () => {
    const value = JSON.stringify({ type: "doc", content: { invalid: true } })
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const html = parityMarkup(
        { label: "inline malformed root", profile: "inline", value },
        RichTextContent
      )
      expect(html).toMatch(/^<span class="[^"]*"><\/span>$/)
    } finally {
      warn.mockRestore()
    }
  })

  it("covers every allowlisted node and mark in each profile", () => {
    const counts: Record<RichTextProfile, { nodes: number; marks: number }> = {
      inline: { nodes: 0, marks: 0 },
      basic: { nodes: 0, marks: 0 },
      full: { nodes: 0, marks: 0 },
    }
    for (const profile of ["inline", "basic", "full"] as const) {
      const spec = PROFILE_SPECS[profile]
      counts[profile] = { nodes: spec.nodes.size, marks: spec.marks.size }
      for (const type of spec.nodes) {
        const node: JSONContent =
          type === "doc"
            ? {
                type,
                content: [
                  { type: "paragraph", content: [{ type: "text", text: "x" }] },
                ],
              }
            : type === "text"
              ? { type, text: "x" }
              : type === "paragraph" ||
                  type === "listItem" ||
                  type === "table" ||
                  type === "tableRow" ||
                  type === "tableHeader" ||
                  type === "tableCell" ||
                  type === "blockquote" ||
                  type === "codeBlock"
                ? { type, content: [{ type: "text", text: "x" }] }
                : type === "heading"
                  ? {
                      type,
                      attrs: { level: profile === "basic" ? 2 : 3 },
                      content: [{ type: "text", text: "x" }],
                    }
                  : type === "image"
                    ? { type, attrs: { src: "/x.png", alt: "x" } }
                    : type === "orderedList"
                      ? {
                          type,
                          content: [
                            {
                              type: "listItem",
                              content: [
                                {
                                  type: "paragraph",
                                  content: [{ type: "text", text: "x" }],
                                },
                              ],
                            },
                          ],
                        }
                      : type === "bulletList"
                        ? {
                            type,
                            content: [
                              {
                                type: "listItem",
                                content: [
                                  {
                                    type: "paragraph",
                                    content: [{ type: "text", text: "x" }],
                                  },
                                ],
                              },
                            ],
                          }
                        : { type, content: [] }
        const value = JSON.stringify({ type: "doc", content: [node] })
        const testCase = { label: `${profile}.${type}`, profile, value }
        expect(
          parityMarkup(testCase, RichTextContent),
          `${profile}.${type}`
        ).toBe(canonicalOracleMarkup(testCase))
      }
      for (const type of spec.marks) {
        const attrs =
          type === "link"
            ? { href: "/safe", pageId: "about", noFollow: true }
            : undefined
        const value = JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "marked",
                  marks: [{ type, ...(attrs ? { attrs } : {}) }],
                },
              ],
            },
          ],
        })
        const testCase = { label: `${profile}.${type}`, profile, value }
        expect(
          parityMarkup(testCase, RichTextContent),
          `${profile}.${type}`
        ).toBe(canonicalOracleMarkup(testCase))
      }
    }
    expect(counts).toEqual({
      inline: {
        nodes: PROFILE_SPECS.inline.nodes.size,
        marks: PROFILE_SPECS.inline.marks.size,
      },
      basic: {
        nodes: PROFILE_SPECS.basic.nodes.size,
        marks: PROFILE_SPECS.basic.marks.size,
      },
      full: {
        nodes: PROFILE_SPECS.full.nodes.size,
        marks: PROFILE_SPECS.full.marks.size,
      },
    })
  })

  it("classifies hostile stored JSON attributes by their authored rendering contract", () => {
    const warning = vi
      .spyOn(console, "warn")
      .mockImplementation(() => undefined)
    const hostile = { valueOf: null, toString: null }
    const render = (document: JSONContent) =>
      renderToStaticMarkup(
        createElement(
          "div",
          null,
          renderStaticRichTextDocument(document, "full")
        )
      )
    try {
      expect(
        render({
          type: "doc",
          content: [
            {
              type: "heading",
              attrs: { level: hostile },
              content: [{ type: "text", text: "repaired" }],
            },
            { type: "paragraph", content: [{ type: "text", text: "sibling" }] },
          ],
        })
      ).toBe("<div><h1>repaired</h1><p>sibling</p></div>")
      expect(warning).not.toHaveBeenCalled()

      const hostileHandlers: ReadonlyArray<readonly [string, JSONContent]> = [
        [
          "list start",
          {
            type: "doc",
            content: [
              {
                type: "orderedList",
                attrs: { start: hostile },
                content: [
                  {
                    type: "listItem",
                    content: [
                      {
                        type: "paragraph",
                        content: [{ type: "text", text: "item" }],
                      },
                    ],
                  },
                ],
              },
              {
                type: "paragraph",
                content: [{ type: "text", text: "sibling" }],
              },
            ],
          },
        ],
        [
          "table colspan",
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
                        type: "tableCell",
                        attrs: { colspan: hostile },
                        content: [
                          {
                            type: "paragraph",
                            content: [{ type: "text", text: "cell" }],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
              {
                type: "paragraph",
                content: [{ type: "text", text: "sibling" }],
              },
            ],
          },
        ],
        [
          "image width",
          {
            type: "doc",
            content: [
              { type: "image", attrs: { src: "/safe.png", width: hostile } },
              {
                type: "paragraph",
                content: [{ type: "text", text: "sibling" }],
              },
            ],
          },
        ],
        [
          "image height",
          {
            type: "doc",
            content: [
              { type: "image", attrs: { src: "/safe.png", height: hostile } },
              {
                type: "paragraph",
                content: [{ type: "text", text: "sibling" }],
              },
            ],
          },
        ],
      ]
      for (const [label, document] of hostileHandlers) {
        warning.mockClear()
        const html = render(document)
        expect(html, label).toContain("sibling")
        expect(warning, label).toHaveBeenCalledTimes(1)
        if (label.startsWith("image")) expect(html, label).not.toContain("<img")
        if (label === "list start") expect(html).not.toContain("<ol>")
        if (label === "table colspan")
          expect(html).toContain("<table><tbody><tr></tr></tbody></table>")
      }
    } finally {
      warning.mockRestore()
    }
  })

  it("contains coercion failures to the affected node and warns once", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined)
    try {
      const hostile = { valueOf: null, toString: null }
      const tree = renderStaticRichTextDocument(
        {
          type: "doc",
          content: [
            { type: "image", attrs: { src: "/bad.png", width: hostile } },
            {
              type: "paragraph",
              content: [{ type: "text", text: "sibling survives" }],
            },
          ],
        },
        "full"
      )
      const html = renderToStaticMarkup(createElement("div", null, tree))
      expect(html).not.toContain("<img")
      expect(html).toContain("sibling survives")
      expect(warn).toHaveBeenCalledTimes(1)
    } finally {
      warn.mockRestore()
    }
  })

  it("prepares parsed documents and resolves links before static rendering", () => {
    const value = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "About",
              marks: [
                { type: "link", attrs: { href: "/old", pageId: "about" } },
              ],
            },
          ],
        },
      ],
    })
    const ctx = {
      locale: "fr",
      defaultLocale: "en",
      pagePaths: { about: "/fr/a-propos" },
    }
    const document = richTextToDocument(value, "basic", ctx)
    expect(document.content?.[0]?.content?.[0]?.marks?.[0]?.attrs?.href).toBe(
      "/fr/a-propos"
    )
    expect(
      renderToStaticMarkup(
        createElement(
          "div",
          null,
          renderStaticRichTextDocument(document, "basic")
        )
      )
    ).toContain('href="/fr/a-propos"')
  })

  it("repairs persisted malformed nodes while preserving their valid siblings", () => {
    const document = richTextToDocument(
      JSON.stringify({
        type: "doc",
        content: [
          {
            type: "unknownWrapper",
            content: [
              {
                type: "heading",
                attrs: { level: { valueOf: null, toString: null } },
                content: [{ type: "text", text: "repaired" }],
              },
            ],
          },
          { type: "paragraph", content: [{ type: "text", text: "sibling" }] },
        ],
      }),
      "basic"
    )
    expect(document).toEqual({
      type: "doc",
      content: [
        {
          type: "heading",
          attrs: { level: 2 },
          content: [{ type: "text", text: "repaired" }],
        },
        { type: "paragraph", content: [{ type: "text", text: "sibling" }] },
      ],
    })
    expect(richTextToDocument("{not-json", "basic")).toEqual({
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "{not-json" }] },
      ],
    })
  })

  it("uses explicit unknown node and mark fallbacks without losing sibling text", () => {
    const unknown = renderStaticRichTextDocument(
      {
        type: "doc",
        content: [
          {
            type: "unknownNode",
            content: [{ type: "text", text: "not rendered" }],
          },
          {
            type: "paragraph",
            content: [
              {
                type: "text",
                text: "marked",
                marks: [{ type: "unknownMark" }],
              },
              { type: "text", text: " sibling" },
            ],
          },
        ],
      },
      "basic"
    )
    expect(renderToStaticMarkup(createElement("div", null, unknown))).toContain(
      "marked sibling"
    )
  })

  it("hydrates the server markup without React recoverable errors", async () => {
    const value = corpus.find(({ label }) => label.includes("pageId"))?.value
    if (!value) throw new Error("The pageId parity fixture is missing")
    const element = createElement(RichTextContent, {
      value,
      profile: "basic",
      ctx: {
        locale: "fr",
        defaultLocale: "en",
        pagePaths: { about: "/fr/a-propos" },
      },
    })
    const container = document.createElement("div")
    container.innerHTML = renderToString(element)
    const errors = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined)
    let root: Root | undefined
    try {
      await act(async () => {
        root = hydrateRoot(container, element)
      })
      expect(errors).not.toHaveBeenCalled()
    } finally {
      if (root) {
        await act(async () => root?.unmount())
      }
      errors.mockRestore()
    }
  })
})

// Reader coverage includes parked source Types; installed-only creation must not
// be used to manufacture content for a disabled Type.
function registeredDefaultSlice(type: Slice["type"]): Slice {
  const def = sliceDefs[type]
  return {
    id: crypto.randomUUID(),
    type,
    enabled: true,
    primary: structuredClone(def.primary.default),
    ...("items" in def ? { items: structuredClone(def.items.default) } : {}),
  } as Slice
}

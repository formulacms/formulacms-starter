import { readInstalledBlockDefinition } from "@/convex/lib/blocks"
import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, it } from "vitest"
import { installedBlockDefs, blockDefs } from "@/convex/lib/blocks"
import { v } from "convex/values"
import { group, list, richText, text } from "@/convex/lib/blocks/primitives"
import { createSampleBlock } from "@/lib/blocks/sample"
import { markStructuralListOperation } from "@/lib/editor-structure"
import { repeatedItemIdentity } from "./repeated-item-identity"
import {
  capturePageField,
  applyPageField,
  rebasePageField,
  pageFieldEcho,
  reconcilePageFieldEcho,
  hasStructuralBlockChange,
  isPrimaryListPath,
} from "./page-inline-draft"

// Snapshot an optional descriptor without requiring it to be installed.
const installedBlockDefinition = (type: string) => readInstalledBlockDefinition(type)

const pm = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          {
            type: "text",
            text,
            marks: [
              { type: "bold" },
              { type: "link", attrs: { href: "https://example.invalid/" } },
            ],
          },
          { type: "hardBreak" },
          { type: "text", text: "tail" },
        ],
      },
    ],
  })
type PmMark = { type: "italic" } | { type: "link"; attrs: { href: string } }
const markedPm = (text: string, marks: PmMark[]) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [
          { type: "text", text, marks },
          { type: "hardBreak" },
          { type: "text", text: "tail" },
        ],
      },
    ],
  })
function pmVisibleText(value: string) {
  return JSON.parse(value).content[0].content[0].text
}
type RootTestBlock = Extract<
  ReturnType<typeof createSampleBlock>,
  { type: "features-icon-grid" }
>
function requireRootTestBlock(
  value: ReturnType<typeof createSampleBlock> | undefined
): RootTestBlock {
  if (!value || value.type !== "features-icon-grid") {
    throw new Error("Expected a features icon grid block")
  }
  return value
}
function fixture() {
  const block = { ...createSampleBlock("hero-agency"), id: "hero" }
  const binding = capturePageField(
    [block],
    "en",
    "hero",
    "primary.description",
    3,
    "catalog-a"
  )!
  return { block, binding }
}
function editNestedAncestor(block: ReturnType<typeof createSampleBlock>) {
  const root = requireRootTestBlock(block)
  const edited = structuredClone(root)
  const items = structuredClone(root.items)
  Reflect.set(items[0], "label", "parent changed")
  Reflect.set(edited, "items", items)
  return edited
}
function withNestedRootItems(
  run: (block: ReturnType<typeof createSampleBlock>) => void
) {
  const original = blockDefs["features-icon-grid"]
  const installedOriginal = installedBlockDefinition("features-icon-grid")
  const details = list(
    group({
      title: richText({ profile: "inline" }),
      body: richText({ profile: "inline" }),
    }),
    { max: 2 }
  )
  const items = list(
    group({
      label: text(),
      summary: richText({ profile: "inline" }),
      details,
    }),
    { max: 2 }
  )
  const def = {
    ...original,
    items,
    validator: v.object({
      id: v.string(),
      type: v.literal("features-icon-grid"),
      enabled: v.boolean(),
      primary: original.primary.validator,
      items: items.validator,
    }),
  }
  Reflect.set(blockDefs, "features-icon-grid", def)
  Reflect.set(installedBlockDefs, "features-icon-grid", def)
  try {
    const block = createSampleBlock("features-icon-grid")
    Reflect.set(block, "items", [
      {
        label: "parent",
        summary: markedPm("parent summary", [
          { type: "link", attrs: { href: "/parent" } },
        ]),
        details: [
          { title: pm("target"), body: pm("body") },
          { title: pm("sibling"), body: pm("sibling body") },
        ],
      },
      {
        label: "other parent",
        summary: pm("other summary"),
        details: [{ title: pm("other"), body: pm("other body") }],
      },
    ])
    run(block)
  } finally {
    Reflect.set(blockDefs, "features-icon-grid", original)
    Reflect.set(installedBlockDefs, "features-icon-grid", installedOriginal)
  }
}
function withNestedPrimary(
  run: (block: ReturnType<typeof createSampleBlock>) => void
) {
  const original = blockDefs["features-icon-grid"]
  const installedOriginal = installedBlockDefinition("features-icon-grid")
  const details = list(
    group({
      copy: richText({ profile: "inline" }),
      title: richText({ profile: "inline" }),
    }),
    { max: 2 }
  )
  const cards = list(
    group({
      label: text(),
      summary: richText({ profile: "inline" }),
      details,
    }),
    { max: 2 }
  )
  const primary = group({ ...original.primary.config.fields, cards })
  const def = {
    ...original,
    primary,
    validator: v.object({
      id: v.string(),
      type: v.literal("features-icon-grid"),
      enabled: v.boolean(),
      primary: primary.validator,
      items: original.items.validator,
    }),
  }
  Reflect.set(blockDefs, "features-icon-grid", def)
  Reflect.set(installedBlockDefs, "features-icon-grid", def)
  try {
    const block = createSampleBlock("features-icon-grid")
    Reflect.set(block.primary, "cards", [
      {
        label: "parent",
        summary: markedPm("parent summary", [
          { type: "link", attrs: { href: "/parent" } },
        ]),
        details: [
          { copy: pm("target"), title: pm("title") },
          { copy: pm("sibling"), title: pm("sibling title") },
        ],
      },
      {
        label: "other",
        summary: pm("other summary"),
        details: [{ copy: pm("other"), title: pm("other title") }],
      },
    ])
    run(block)
  } finally {
    Reflect.set(blockDefs, "features-icon-grid", original)
    Reflect.set(installedBlockDefs, "features-icon-grid", installedOriginal)
  }
}
describe("B1 parent-owned field draft", () => {
  it("NEW captures a qualified primary list path while preserving root items paths", blockProfile([]), () => {
    const originalDef = blockDefs["hero-with-image"]
    const listTitle = richText({ profile: "inline" })
    const syntheticPrimary = group({
      ...originalDef.primary.config.fields,
      features: list(group({ title: listTitle })),
    })
    expect(
      isPrimaryListPath(syntheticPrimary, "primary.features.0.title")
    ).toBe(true)
    expect(isPrimaryListPath(syntheticPrimary, "primary.title")).toBe(false)
    expect(isPrimaryListPath(syntheticPrimary, "items.0.title")).toBe(false)
    expect(isPrimaryListPath(syntheticPrimary, "primary.features.title")).toBe(
      false
    )

    const block = createSampleBlock("hero-with-image")
    Reflect.set(block.primary, "features", [{ title: pm("List title") }])
    Reflect.set(blockDefs, "hero-with-image", {
      ...originalDef,
      primary: syntheticPrimary,
      validator: v.object({
        id: v.string(),
        type: v.literal("hero-with-image"),
        enabled: v.boolean(),
        primary: syntheticPrimary.validator,
        items: originalDef.items.validator,
      }),
    })
    try {
      expect(
        capturePageField([block], "en", block.id, "primary.features.0.title", 3)
          ?.repeatedTarget
      ).toMatchObject({
        listPath: "primary.features",
        itemIndex: 0,
        contentEpoch: 3,
      })
      const valid = capturePageField(
        [block],
        "en",
        block.id,
        "primary.title",
        3
      )
      if (!valid) throw new Error("Expected the root title to remain writable")
      if (!valid.fieldBinding)
        throw new Error("Expected the root title binding to remain qualified")
      const forged = {
        ...valid,
        fieldPath: "primary.features.0.title",
        value: pm("forged list write"),
        fieldBinding: {
          ...valid.fieldBinding,
          descriptor: JSON.stringify(listTitle),
          lastApplied: pm("List title"),
          itemFingerprint: undefined,
        },
      }
      expect(applyPageField([block], "en", forged, 3)).toBeNull()
      expect(JSON.stringify(block.primary)).toContain("List title")
    } finally {
      Reflect.set(blockDefs, "hero-with-image", originalDef)
    }
  })

  it("NEW advances only its own last-applied value through consecutive exact PM intents", blockProfile([]), () => {
    const { block, binding } = fixture()
    const first = { ...binding, value: pm("one") }
    const changed = applyPageField([block], "en", first, 3, "catalog-a")!
    const second = {
      ...first,
      fieldBinding: { ...first.fieldBinding!, lastApplied: first.value },
      value: pm("two"),
    }
    const final = applyPageField(changed, "en", second, 3, "catalog-a")!
    if (final[0].type !== "hero-agency")
      throw new Error("Expected hero fixture")
    expect(final[0].primary.description).toBe(second.value)
    expect(
      JSON.parse(final[0].primary.description as string).content[0].content
    ).toHaveLength(3)
  })
  it("NEW accepts unrelated sidebar fields without replacing their values", blockProfile([]), () => {
    const { block, binding } = fixture()
    const unrelated = {
      ...block,
      primary: { ...block.primary, eyebrow: "manual" },
    }
    const next = applyPageField(
      [unrelated],
      "en",
      { ...binding, value: pm("inline") },
      3,
      "catalog-a"
    )!
    if (next[0].type !== "hero-agency") throw new Error("Expected hero fixture")
    expect(next[0].primary.eyebrow).toBe("manual")
  })
  it.each([
    "locale",
    "epoch",
    "catalog",
    "same-field",
    "presentation",
    "removed",
    "duplicate",
    "disabled",
  ])("NEW refuses %s without changing the original draft", blockProfile([]), (kind) => {
    const { block, binding } = fixture()
    const current =
      kind === "same-field"
        ? { ...block, primary: { ...block.primary, title: pm("external") } }
        : kind === "presentation"
          ? { ...block, presentationIdV1: "centered" }
          : kind === "disabled"
            ? { ...block, enabled: false }
            : block
    const blocks =
      kind === "removed"
        ? []
        : kind === "duplicate"
          ? [block, block]
          : [current]
    const before = JSON.stringify(blocks)
    expect(
      applyPageField(
        blocks,
        kind === "locale" ? "fr" : "en",
        { ...binding, value: pm("late") },
        kind === "epoch" ? 4 : 3,
        kind === "catalog" ? "catalog-b" : "catalog-a"
      )
    ).toBeNull()
    expect(JSON.stringify(blocks)).toBe(before)
  })
  it("NEW refuses a changed descriptor/profile, type and noncanonical field path", blockProfile([]), () => {
    const { block, binding } = fixture()
    for (const commit of [
      {
        ...binding,
        fieldBinding: {
          ...binding.fieldBinding!,
          descriptor: JSON.stringify({
            kind: "richText",
            config: { profile: "basic" },
          }),
        },
      },
      { ...binding, blockType: "rich-text-body" as typeof binding.blockType },
      { ...binding, fieldPath: "primary..title" },
      { ...binding, kind: "text" as typeof binding.kind },
    ])
      expect(
        applyPageField(
          [block],
          "en",
          { ...commit, value: pm("late") },
          3,
          "catalog-a"
        )
      ).toBeNull()
  })
  it("captures a one-line plain text field and writes only one line within its max length", blockProfile([]), () => {
    const { block } = fixture()
    // PR A3 (owner, 2026-11-21): a plain text field opens in place too.
    const eyebrow = capturePageField([block], "en", block.id, "primary.eyebrow", 3)
    expect(eyebrow).toMatchObject({
      kind: "text",
      value: (block.primary as Record<string, unknown>).eyebrow,
    })
    const next = applyPageField([block], "en", { ...eyebrow!, value: "New eyebrow" }, 3)
    expect((next?.[0].primary as Record<string, unknown>).eyebrow).toBe("New eyebrow")
    expect(applyPageField([block], "en", { ...eyebrow!, value: "two\nlines" }, 3)).toBeNull()
  })
  it("NEW increments structural epochs for identical item reorder but not a sibling field edit", blockProfile([]), () => {
    const { block } = fixture()
    const repeated = createSampleBlock("features-icon-grid")
    if (repeated.type !== "features-icon-grid")
      throw new Error("Expected repeated fixture")
    const a = { ...repeated.items[0], title: pm("equal") },
      b = { ...a }
    const base = { ...repeated, items: [a, b] }
    expect(hasStructuralBlockChange([base], [{ ...base, items: [b, a] }])).toBe(
      true
    )
    expect(
      hasStructuralBlockChange(
        [block],
        [{ ...block, primary: { ...block.primary, eyebrow: "manual" } }]
      )
    ).toBe(false)
    // Synthetic traversal fixture; no attempt to apply this invalid Block.
    const primitive = {
      ...block,
      items: ["equal", "equal"],
    } as unknown as typeof block
    expect(
      hasStructuralBlockChange(
        [primitive],
        [{ ...primitive, primary: { ...primitive.primary, eyebrow: "manual" } }]
      )
    ).toBe(false)
    expect(
      hasStructuralBlockChange(
        [primitive],
        [
          {
            ...primitive,
            items: markStructuralListOperation(["equal", "equal"]),
          } as unknown as typeof block,
        ]
      )
    ).toBe(true)
  })
  it("NEW requalifies known same-item sibling edits but never retargets remove/reorder/equal duplicate items", blockProfile([]), () => {
    const block = { ...createSampleBlock("features-icon-grid"), id: "features" }
    block.items = [0, 1, 2].map(() => ({ ...block.items[0] }))
    const binding = capturePageField(
      [block],
      "en",
      block.id,
      "items.1.title",
      7
    )!
    const edited = {
      ...binding,
      value: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: "middle" }],
          },
        ],
      }),
    }
    const sibling = {
      ...block,
      items: block.items.map((item, index) =>
        index === 1 ? { ...item, body: pm("manual sibling") } : item
      ),
    }
    expect(applyPageField([sibling], "en", edited, 7)).toBeNull()
    const qualified = rebasePageField([sibling], "en", edited, 7)
    const applied = applyPageField([sibling], "en", qualified, 7)!
    expect((applied[0] as typeof block).items[1].title).toBe(edited.value)
    expect((applied[0] as typeof block).items[1].body).toBe(
      sibling.items[1].body
    )
    for (const items of [
      block.items.toReversed(),
      block.items.slice(1),
      [...block.items, block.items[1]],
    ]) {
      expect(hasStructuralBlockChange([block], [{ ...block, items }])).toBe(
        true
      )
      expect(
        applyPageField(
          [{ ...block, items }],
          "en",
          rebasePageField([{ ...block, items }], "en", edited, 8),
          8
        )
      ).toBeNull()
    }
  })
  it("NEW P3 real apply refuses an ancestor edit at the same epoch", blockProfile([]), () => {
    withNestedRootItems((block) => {
      const path = "items.0.details.0.title"
      const binding = capturePageField([block], "en", block.id, path, 7)
      if (!binding) throw new Error("Expected real nested items capture")
      expect(binding.repeatedTarget?.ancestors).toHaveLength(1)
      const parentEdited = editNestedAncestor(block)
      expect(
        applyPageField(
          [parentEdited],
          "en",
          { ...binding, value: pm("own edit") },
          7
        )
      ).toBeNull()
    })
  })
  it("NEW P3 real rebase preserves the old complete ancestor identity", blockProfile([]), () => {
    withNestedRootItems((block) => {
      const path = "items.0.details.0.title"
      const binding = capturePageField([block], "en", block.id, path, 7)
      if (!binding) throw new Error("Expected real nested items capture")
      const parentEdited = editNestedAncestor(block)
      expect(
        rebasePageField([parentEdited], "en", binding, 7).repeatedTarget
      ).toEqual(binding.repeatedTarget)
    })
  })
  const echoCases = [
    {
      mode: "root",
      depth: 1,
      fieldPath: "items.0.summary",
      otherPath: "items.1.summary",
    },
    {
      mode: "root",
      depth: 2,
      fieldPath: "items.0.details.0.title",
      otherPath: "items.1.details.0.title",
    },
    {
      mode: "primary",
      depth: 1,
      fieldPath: "primary.cards.0.summary",
      otherPath: "primary.cards.1.summary",
    },
    {
      mode: "primary",
      depth: 2,
      fieldPath: "primary.cards.0.details.0.copy",
      otherPath: "primary.cards.1.details.0.copy",
    },
  ] as const
  it.each(echoCases)(
    "NEW P3 authentic own echo requires complete identity for $mode depth $depth", blockProfile([]),
    ({ mode, depth, fieldPath, otherPath }) => {
      expect.assertions(6)
      const exercise = (block: ReturnType<typeof createSampleBlock>) => {
        const sourceBefore = JSON.stringify(block)
        const binding = capturePageField([block], "en", block.id, fieldPath, 7)
        if (!binding?.repeatedTarget)
          throw new Error("Expected a real repeated-field capture")
        const commit = {
          ...binding,
          inlineSessionId: `echo-${mode}-${depth}`,
          frameBinding: {
            sessionId: "page-session",
            pageId: "page-id",
            generation: "frame-generation",
            buildId: "build-id",
            languageVersion: 1,
          },
          value: pm("accepted own edit"),
        }
        const receiptBlocks = applyPageField([block], "en", commit, 7)
        if (!receiptBlocks)
          throw new Error("Expected an accepted parent apply result")
        const receipt = pageFieldEcho(receiptBlocks)
        if (!receipt) throw new Error("Expected the authentic WeakMap receipt")
        expect(
          reconcilePageFieldEcho(receiptBlocks, "en", commit, receipt, 7)
        ).not.toBeNull()
        const otherField = capturePageField(
          receiptBlocks,
          "en",
          block.id,
          otherPath,
          7
        )
        if (!otherField?.repeatedTarget)
          throw new Error("Expected another real repeated-field target")
        const missingTargetReceipt = { ...receipt }
        delete missingTargetReceipt.repeatedTarget
        expect(
          reconcilePageFieldEcho(
            receiptBlocks,
            "en",
            commit,
            missingTargetReceipt,
            7
          )
        ).toBeNull()
        expect(
          reconcilePageFieldEcho(
            receiptBlocks,
            "en",
            commit,
            { ...receipt, repeatedTarget: otherField.repeatedTarget },
            7
          )
        ).toBeNull()
        const changed = structuredClone(requireRootTestBlock(receiptBlocks[0]))
        if (mode === "root") {
          const rows = structuredClone(changed.items)
          Reflect.set(rows[0], "label", "changed parent label")
          Reflect.set(changed, "items", rows)
        } else {
          const rows = Reflect.get(changed.primary, "cards")
          if (!Array.isArray(rows)) throw new Error("Expected primary cards")
          const clonedRows = structuredClone(rows)
          Reflect.set(clonedRows[0], "label", "changed parent label")
          Reflect.set(changed.primary, "cards", clonedRows)
        }
        receiptBlocks[0] = changed
        expect(
          reconcilePageFieldEcho(receiptBlocks, "en", commit, receipt, 7)
        ).toBeNull()
        expect(pageFieldEcho(receiptBlocks)).toBe(receipt)
        expect(JSON.stringify(block)).toBe(sourceBefore)
      }
      if (mode === "root") withNestedRootItems(exercise)
      else withNestedPrimary(exercise)
    }
  )
  it("NEW P3 primary consumer refuses missing, borrowed, incomplete and stale identities", blockProfile([]), () => {
    expect.assertions(8)
    withNestedPrimary((block) => {
      const path = "primary.cards.0.details.0.copy"
      const binding = capturePageField(
        [block],
        "en",
        block.id,
        path,
        7,
        "catalog-a"
      )
      const otherRow = capturePageField(
        [block],
        "en",
        block.id,
        "primary.cards.1.details.0.copy",
        7,
        "catalog-a"
      )
      if (!binding?.repeatedTarget || !otherRow?.repeatedTarget)
        throw new Error("Expected both real primary row captures")
      const sourceBefore = JSON.stringify(block)
      const commit = { ...binding, value: pm("primary edit") }
      const missingTarget = { ...commit }
      delete missingTarget.repeatedTarget
      expect(
        applyPageField([block], "en", missingTarget, 7, "catalog-a")
      ).toBeNull()
      expect(
        applyPageField(
          [block],
          "en",
          { ...commit, repeatedTarget: otherRow.repeatedTarget },
          7,
          "catalog-a"
        )
      ).toBeNull()
      const target = binding.repeatedTarget
      const missingAncestry = { ...commit, repeatedTarget: { ...target } }
      delete missingAncestry.repeatedTarget.ancestors
      expect(
        applyPageField([block], "en", missingAncestry, 7, "catalog-a")
      ).toBeNull()
      expect(applyPageField([block], "en", commit, 8, "catalog-a")).toBeNull()
      expect(applyPageField([block], "fr", commit, 7, "catalog-a")).toBeNull()
      expect(applyPageField([block], "en", commit, 7, "catalog-b")).toBeNull()
      expect(binding.repeatedTarget.ancestors).toHaveLength(1)
      expect(JSON.stringify(block)).toBe(sourceBefore)
    })
  })
  it.each(["mark", "link target"] as const)(
    "NEW P3 nested primary refuses an ancestor %s edit for apply and rebase", blockProfile([]),
    (change) => {
      expect.assertions(6)
      withNestedPrimary((block) => {
        const path = "primary.cards.0.details.0.copy"
        const binding = capturePageField([block], "en", block.id, path, 7)
        if (!binding?.repeatedTarget?.ancestors?.[0])
          throw new Error("Expected a real nested primary capture")
        const sourceBefore = JSON.stringify(block)
        const originalCards = Reflect.get(block.primary, "cards")
        if (!Array.isArray(originalCards))
          throw new Error("Expected original primary cards")
        const beforeSummary = Reflect.get(originalCards[0], "summary")
        if (typeof beforeSummary !== "string")
          throw new Error("Expected the original marked summary")
        const parentEdited = structuredClone(block)
        const cards = Reflect.get(parentEdited.primary, "cards")
        if (!Array.isArray(cards)) throw new Error("Expected primary cards")
        Reflect.set(
          cards[0],
          "summary",
          change === "mark"
            ? markedPm("parent summary", [
                { type: "italic" },
                { type: "link", attrs: { href: "/parent" } },
              ])
            : markedPm("parent summary", [
                { type: "link", attrs: { href: "/changed-parent" } },
              ])
        )
        Reflect.set(parentEdited.primary, "cards", cards)
        const afterSummary = Reflect.get(cards[0], "summary")
        if (typeof afterSummary !== "string")
          throw new Error("Expected the updated marked summary")
        expect(afterSummary).not.toBe(beforeSummary)
        expect(pmVisibleText(afterSummary)).toBe(pmVisibleText(beforeSummary))
        const afterTarget = repeatedItemIdentity(block, path, 7, {
          maskField: true,
        })
        if (!afterTarget?.ancestors?.[0])
          throw new Error("Expected the updated masked ancestor identity")
        const editedTarget = repeatedItemIdentity(parentEdited, path, 7, {
          maskField: true,
        })
        if (!editedTarget?.ancestors?.[0])
          throw new Error("Expected the edited masked ancestor identity")
        expect(editedTarget.ancestors[0].itemFingerprint).not.toBe(
          afterTarget.ancestors[0].itemFingerprint
        )
        expect(
          applyPageField(
            [parentEdited],
            "en",
            { ...binding, value: pm("refused edit") },
            7
          )
        ).toBeNull()
        expect(
          rebasePageField([parentEdited], "en", binding, 7).repeatedTarget
        ).toEqual(binding.repeatedTarget)
        expect(JSON.stringify(block)).toBe(sourceBefore)
      })
    }
  )
  it("NEW P3 depth-two primary capture, apply and rebase retain complete ancestry", blockProfile([]), () => {
    expect.assertions(5)
    withNestedPrimary((block) => {
      const path = "primary.cards.0.details.0.copy"
      const binding = capturePageField([block], "en", block.id, path, 7)
      expect(binding).not.toBeNull()
      if (!binding) throw new Error("Expected a real depth-two primary capture")
      expect(binding.repeatedTarget?.ancestors).toHaveLength(1)
      const edited = applyPageField(
        [block],
        "en",
        { ...binding, value: pm("primary own edit") },
        7
      )
      expect(edited).not.toBeNull()
      const parentEdited = structuredClone(block)
      const cards = Reflect.get(parentEdited.primary, "cards")
      if (!Array.isArray(cards)) throw new Error("Expected primary cards")
      Reflect.set(cards[0], "label", "parent changed")
      Reflect.set(parentEdited.primary, "cards", cards)
      expect(
        applyPageField(
          [parentEdited],
          "en",
          { ...binding, value: pm("primary stale edit") },
          7
        )
      ).toBeNull()
      expect(
        rebasePageField([parentEdited], "en", binding, 7).repeatedTarget
      ).toEqual(binding.repeatedTarget)
    })
  })
})

describe("registered basic field draft consumers", () => {
  for (const profileRow of [
    ["hero-agency", "primary.description"],
    ["hero-with-image", "primary.description"],
    ["features-icon-grid", "primary.body"],
    ["features-icon-grid", "items.0.body"],
  ] as const) {
    it.each([profileRow])("captures and applies %s %s blocks without mutating or weakening stale bindings", blockProfile([]),
      (type, path) => {
        const block = createSampleBlock(type)
        const before = JSON.stringify(block)
        const binding = capturePageField(
          [block],
          "en",
          block.id,
          path,
          7,
          "catalog"
        )!
        expect(binding).not.toBeNull()
        const document = JSON.stringify({
          type: "doc",
          content: [
            {
              type: "paragraph",
              content: [
                {
                  type: "text",
                  text: "First",
                  marks: [
                    { type: "bold" },
                    { type: "link", attrs: { href: "https://example.com" } },
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
        const result = applyPageField(
          [block],
          "en",
          { ...binding, value: document },
          7,
          "catalog"
        )
        expect(result).not.toBeNull()
        expect(JSON.stringify(result)).toContain("bulletList")
        expect(
          applyPageField(
            [block],
            "en",
            { ...binding, value: document },
            8,
            "catalog"
          )
        ).toBeNull()
        expect(
          applyPageField(
            [block],
            "en",
            {
              ...binding,
              value: JSON.stringify({
                type: "doc",
                content: [{ type: "text", text: "invalid" }],
              }),
            },
            7,
            "catalog"
          )
        ).toBeNull()
        expect(JSON.stringify(block)).toBe(before)
      }
    )
  }
})

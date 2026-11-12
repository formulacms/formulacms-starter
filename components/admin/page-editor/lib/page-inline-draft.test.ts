import { readInstalledSliceDefinition } from "@/convex/lib/slices"
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it } from "vitest"
import { installedSliceDefs, sliceDefs } from "@/convex/lib/slices"
import { v } from "convex/values"
import { group, list, richText, text } from "@/convex/lib/slices/primitives"
import { createSampleSlice } from "@/lib/slices/sample"
import { markStructuralListOperation } from "@/lib/editor-structure"
import { repeatedItemIdentity } from "./repeated-item-identity"
import {
  capturePageField,
  applyPageField,
  rebasePageField,
  pageFieldEcho,
  reconcilePageFieldEcho,
  hasStructuralSliceChange,
  isPrimaryListPath,
} from "./page-inline-draft"

// Snapshot an optional descriptor without requiring it to be installed.
const installedSliceDefinition = (type: string) => readInstalledSliceDefinition(type)

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
type RootTestSlice = Extract<
  ReturnType<typeof createSampleSlice>,
  { type: "features-icon-grid" }
>
function requireRootTestSlice(
  value: ReturnType<typeof createSampleSlice> | undefined
): RootTestSlice {
  if (!value || value.type !== "features-icon-grid") {
    throw new Error("Expected a features icon grid slice")
  }
  return value
}
function fixture() {
  const slice = { ...createSampleSlice("hero-agency"), id: "hero" }
  const binding = capturePageField(
    [slice],
    "en",
    "hero",
    "primary.description",
    3,
    "catalog-a"
  )!
  return { slice, binding }
}
function editNestedAncestor(slice: ReturnType<typeof createSampleSlice>) {
  const root = requireRootTestSlice(slice)
  const edited = structuredClone(root)
  const items = structuredClone(root.items)
  Reflect.set(items[0], "label", "parent changed")
  Reflect.set(edited, "items", items)
  return edited
}
function withNestedRootItems(
  run: (slice: ReturnType<typeof createSampleSlice>) => void
) {
  const original = sliceDefs["features-icon-grid"]
  const installedOriginal = installedSliceDefinition("features-icon-grid")
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
  Reflect.set(sliceDefs, "features-icon-grid", def)
  Reflect.set(installedSliceDefs, "features-icon-grid", def)
  try {
    const slice = createSampleSlice("features-icon-grid")
    Reflect.set(slice, "items", [
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
    run(slice)
  } finally {
    Reflect.set(sliceDefs, "features-icon-grid", original)
    Reflect.set(installedSliceDefs, "features-icon-grid", installedOriginal)
  }
}
function withNestedPrimary(
  run: (slice: ReturnType<typeof createSampleSlice>) => void
) {
  const original = sliceDefs["features-icon-grid"]
  const installedOriginal = installedSliceDefinition("features-icon-grid")
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
  Reflect.set(sliceDefs, "features-icon-grid", def)
  Reflect.set(installedSliceDefs, "features-icon-grid", def)
  try {
    const slice = createSampleSlice("features-icon-grid")
    Reflect.set(slice.primary, "cards", [
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
    run(slice)
  } finally {
    Reflect.set(sliceDefs, "features-icon-grid", original)
    Reflect.set(installedSliceDefs, "features-icon-grid", installedOriginal)
  }
}
describe("B1 parent-owned field draft", () => {
  it("NEW captures a qualified primary list path while preserving root items paths", sliceProfile([]), () => {
    const originalDef = sliceDefs["hero-with-image"]
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

    const slice = createSampleSlice("hero-with-image")
    Reflect.set(slice.primary, "features", [{ title: pm("List title") }])
    Reflect.set(sliceDefs, "hero-with-image", {
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
        capturePageField([slice], "en", slice.id, "primary.features.0.title", 3)
          ?.repeatedTarget
      ).toMatchObject({
        listPath: "primary.features",
        itemIndex: 0,
        contentEpoch: 3,
      })
      const valid = capturePageField(
        [slice],
        "en",
        slice.id,
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
      expect(applyPageField([slice], "en", forged, 3)).toBeNull()
      expect(JSON.stringify(slice.primary)).toContain("List title")
    } finally {
      Reflect.set(sliceDefs, "hero-with-image", originalDef)
    }
  })

  it("NEW advances only its own last-applied value through consecutive exact PM intents", sliceProfile([]), () => {
    const { slice, binding } = fixture()
    const first = { ...binding, value: pm("one") }
    const changed = applyPageField([slice], "en", first, 3, "catalog-a")!
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
  it("NEW accepts unrelated sidebar fields without replacing their values", sliceProfile([]), () => {
    const { slice, binding } = fixture()
    const unrelated = {
      ...slice,
      primary: { ...slice.primary, eyebrow: "manual" },
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
  ])("NEW refuses %s without changing the original draft", sliceProfile([]), (kind) => {
    const { slice, binding } = fixture()
    const current =
      kind === "same-field"
        ? { ...slice, primary: { ...slice.primary, title: pm("external") } }
        : kind === "presentation"
          ? { ...slice, presentationIdV1: "centered" }
          : kind === "disabled"
            ? { ...slice, enabled: false }
            : slice
    const slices =
      kind === "removed"
        ? []
        : kind === "duplicate"
          ? [slice, slice]
          : [current]
    const before = JSON.stringify(slices)
    expect(
      applyPageField(
        slices,
        kind === "locale" ? "fr" : "en",
        { ...binding, value: pm("late") },
        kind === "epoch" ? 4 : 3,
        kind === "catalog" ? "catalog-b" : "catalog-a"
      )
    ).toBeNull()
    expect(JSON.stringify(slices)).toBe(before)
  })
  it("NEW refuses a changed descriptor/profile, type and noncanonical field path", sliceProfile([]), () => {
    const { slice, binding } = fixture()
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
      { ...binding, sliceType: "rich-text-body" as typeof binding.sliceType },
      { ...binding, fieldPath: "primary..title" },
      { ...binding, kind: "text" as typeof binding.kind },
    ])
      expect(
        applyPageField(
          [slice],
          "en",
          { ...commit, value: pm("late") },
          3,
          "catalog-a"
        )
      ).toBeNull()
    expect(
      capturePageField([slice], "en", slice.id, "primary.eyebrow", 3)
    ).toBeNull()
  })
  it("NEW increments structural epochs for identical item reorder but not a sibling field edit", sliceProfile([]), () => {
    const { slice } = fixture()
    const repeated = createSampleSlice("features-icon-grid")
    if (repeated.type !== "features-icon-grid")
      throw new Error("Expected repeated fixture")
    const a = { ...repeated.items[0], title: pm("equal") },
      b = { ...a }
    const base = { ...repeated, items: [a, b] }
    expect(hasStructuralSliceChange([base], [{ ...base, items: [b, a] }])).toBe(
      true
    )
    expect(
      hasStructuralSliceChange(
        [slice],
        [{ ...slice, primary: { ...slice.primary, eyebrow: "manual" } }]
      )
    ).toBe(false)
    // Synthetic traversal fixture; no attempt to apply this invalid Slice.
    const primitive = {
      ...slice,
      items: ["equal", "equal"],
    } as unknown as typeof slice
    expect(
      hasStructuralSliceChange(
        [primitive],
        [{ ...primitive, primary: { ...primitive.primary, eyebrow: "manual" } }]
      )
    ).toBe(false)
    expect(
      hasStructuralSliceChange(
        [primitive],
        [
          {
            ...primitive,
            items: markStructuralListOperation(["equal", "equal"]),
          } as unknown as typeof slice,
        ]
      )
    ).toBe(true)
  })
  it("NEW requalifies known same-item sibling edits but never retargets remove/reorder/equal duplicate items", sliceProfile([]), () => {
    const slice = { ...createSampleSlice("features-icon-grid"), id: "features" }
    slice.items = [0, 1, 2].map(() => ({ ...slice.items[0] }))
    const binding = capturePageField(
      [slice],
      "en",
      slice.id,
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
      ...slice,
      items: slice.items.map((item, index) =>
        index === 1 ? { ...item, body: pm("manual sibling") } : item
      ),
    }
    expect(applyPageField([sibling], "en", edited, 7)).toBeNull()
    const qualified = rebasePageField([sibling], "en", edited, 7)
    const applied = applyPageField([sibling], "en", qualified, 7)!
    expect((applied[0] as typeof slice).items[1].title).toBe(edited.value)
    expect((applied[0] as typeof slice).items[1].body).toBe(
      sibling.items[1].body
    )
    for (const items of [
      slice.items.toReversed(),
      slice.items.slice(1),
      [...slice.items, slice.items[1]],
    ]) {
      expect(hasStructuralSliceChange([slice], [{ ...slice, items }])).toBe(
        true
      )
      expect(
        applyPageField(
          [{ ...slice, items }],
          "en",
          rebasePageField([{ ...slice, items }], "en", edited, 8),
          8
        )
      ).toBeNull()
    }
  })
  it("NEW P3 real apply refuses an ancestor edit at the same epoch", sliceProfile([]), () => {
    withNestedRootItems((slice) => {
      const path = "items.0.details.0.title"
      const binding = capturePageField([slice], "en", slice.id, path, 7)
      if (!binding) throw new Error("Expected real nested items capture")
      expect(binding.repeatedTarget?.ancestors).toHaveLength(1)
      const parentEdited = editNestedAncestor(slice)
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
  it("NEW P3 real rebase preserves the old complete ancestor identity", sliceProfile([]), () => {
    withNestedRootItems((slice) => {
      const path = "items.0.details.0.title"
      const binding = capturePageField([slice], "en", slice.id, path, 7)
      if (!binding) throw new Error("Expected real nested items capture")
      const parentEdited = editNestedAncestor(slice)
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
    "NEW P3 authentic own echo requires complete identity for $mode depth $depth", sliceProfile([]),
    ({ mode, depth, fieldPath, otherPath }) => {
      expect.assertions(6)
      const exercise = (slice: ReturnType<typeof createSampleSlice>) => {
        const sourceBefore = JSON.stringify(slice)
        const binding = capturePageField([slice], "en", slice.id, fieldPath, 7)
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
        const receiptSlices = applyPageField([slice], "en", commit, 7)
        if (!receiptSlices)
          throw new Error("Expected an accepted parent apply result")
        const receipt = pageFieldEcho(receiptSlices)
        if (!receipt) throw new Error("Expected the authentic WeakMap receipt")
        expect(
          reconcilePageFieldEcho(receiptSlices, "en", commit, receipt, 7)
        ).not.toBeNull()
        const otherField = capturePageField(
          receiptSlices,
          "en",
          slice.id,
          otherPath,
          7
        )
        if (!otherField?.repeatedTarget)
          throw new Error("Expected another real repeated-field target")
        const missingTargetReceipt = { ...receipt }
        delete missingTargetReceipt.repeatedTarget
        expect(
          reconcilePageFieldEcho(
            receiptSlices,
            "en",
            commit,
            missingTargetReceipt,
            7
          )
        ).toBeNull()
        expect(
          reconcilePageFieldEcho(
            receiptSlices,
            "en",
            commit,
            { ...receipt, repeatedTarget: otherField.repeatedTarget },
            7
          )
        ).toBeNull()
        const changed = structuredClone(requireRootTestSlice(receiptSlices[0]))
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
        receiptSlices[0] = changed
        expect(
          reconcilePageFieldEcho(receiptSlices, "en", commit, receipt, 7)
        ).toBeNull()
        expect(pageFieldEcho(receiptSlices)).toBe(receipt)
        expect(JSON.stringify(slice)).toBe(sourceBefore)
      }
      if (mode === "root") withNestedRootItems(exercise)
      else withNestedPrimary(exercise)
    }
  )
  it("NEW P3 primary consumer refuses missing, borrowed, incomplete and stale identities", sliceProfile([]), () => {
    expect.assertions(8)
    withNestedPrimary((slice) => {
      const path = "primary.cards.0.details.0.copy"
      const binding = capturePageField(
        [slice],
        "en",
        slice.id,
        path,
        7,
        "catalog-a"
      )
      const otherRow = capturePageField(
        [slice],
        "en",
        slice.id,
        "primary.cards.1.details.0.copy",
        7,
        "catalog-a"
      )
      if (!binding?.repeatedTarget || !otherRow?.repeatedTarget)
        throw new Error("Expected both real primary row captures")
      const sourceBefore = JSON.stringify(slice)
      const commit = { ...binding, value: pm("primary edit") }
      const missingTarget = { ...commit }
      delete missingTarget.repeatedTarget
      expect(
        applyPageField([slice], "en", missingTarget, 7, "catalog-a")
      ).toBeNull()
      expect(
        applyPageField(
          [slice],
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
        applyPageField([slice], "en", missingAncestry, 7, "catalog-a")
      ).toBeNull()
      expect(applyPageField([slice], "en", commit, 8, "catalog-a")).toBeNull()
      expect(applyPageField([slice], "fr", commit, 7, "catalog-a")).toBeNull()
      expect(applyPageField([slice], "en", commit, 7, "catalog-b")).toBeNull()
      expect(binding.repeatedTarget.ancestors).toHaveLength(1)
      expect(JSON.stringify(slice)).toBe(sourceBefore)
    })
  })
  it.each(["mark", "link target"] as const)(
    "NEW P3 nested primary refuses an ancestor %s edit for apply and rebase", sliceProfile([]),
    (change) => {
      expect.assertions(6)
      withNestedPrimary((slice) => {
        const path = "primary.cards.0.details.0.copy"
        const binding = capturePageField([slice], "en", slice.id, path, 7)
        if (!binding?.repeatedTarget?.ancestors?.[0])
          throw new Error("Expected a real nested primary capture")
        const sourceBefore = JSON.stringify(slice)
        const originalCards = Reflect.get(slice.primary, "cards")
        if (!Array.isArray(originalCards))
          throw new Error("Expected original primary cards")
        const beforeSummary = Reflect.get(originalCards[0], "summary")
        if (typeof beforeSummary !== "string")
          throw new Error("Expected the original marked summary")
        const parentEdited = structuredClone(slice)
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
        const afterTarget = repeatedItemIdentity(slice, path, 7, {
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
        expect(JSON.stringify(slice)).toBe(sourceBefore)
      })
    }
  )
  it("NEW P3 depth-two primary capture, apply and rebase retain complete ancestry", sliceProfile([]), () => {
    expect.assertions(5)
    withNestedPrimary((slice) => {
      const path = "primary.cards.0.details.0.copy"
      const binding = capturePageField([slice], "en", slice.id, path, 7)
      expect(binding).not.toBeNull()
      if (!binding) throw new Error("Expected a real depth-two primary capture")
      expect(binding.repeatedTarget?.ancestors).toHaveLength(1)
      const edited = applyPageField(
        [slice],
        "en",
        { ...binding, value: pm("primary own edit") },
        7
      )
      expect(edited).not.toBeNull()
      const parentEdited = structuredClone(slice)
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
    it.each([profileRow])("captures and applies %s %s blocks without mutating or weakening stale bindings", sliceProfile([]),
      (type, path) => {
        const slice = createSampleSlice(type)
        const before = JSON.stringify(slice)
        const binding = capturePageField(
          [slice],
          "en",
          slice.id,
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
          [slice],
          "en",
          { ...binding, value: document },
          7,
          "catalog"
        )
        expect(result).not.toBeNull()
        expect(JSON.stringify(result)).toContain("bulletList")
        expect(
          applyPageField(
            [slice],
            "en",
            { ...binding, value: document },
            8,
            "catalog"
          )
        ).toBeNull()
        expect(
          applyPageField(
            [slice],
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
        expect(JSON.stringify(slice)).toBe(before)
      }
    )
  }
})

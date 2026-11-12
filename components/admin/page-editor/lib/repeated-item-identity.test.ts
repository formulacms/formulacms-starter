import { readInstalledSliceDefinition } from "@/convex/lib/slices"
import { createSampleSlice } from "@/convex/lib/slices/sample"
const itemTitle = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      {
        type: "heading",
        attrs: { level: 3 },
        content: [{ type: "text", text, marks: [{ type: "bold" }] }],
      },
    ],
  })
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it } from "vitest"
import { v } from "convex/values"

import { installedSliceDefs, sliceDefs, type Slice } from "@/convex/lib/slices"
import {
  group,
  image,
  link,
  list,
  relation,
  richText,
  text,
} from "@/convex/lib/slices/primitives"
import { capturePageField } from "./page-inline-draft"
import {
  captureSliceOccurrence,
  applyPreviewInlineEdit,
} from "./slice-occurrence"
import {
  acceptPreviewCapture,
  validatedPreviewCommit,
  type PreviewInlineSession,
} from "@/components/admin/preview-inline-session"
import {
  repeatedItemIdentity,
  repeatedTargetMatches,
} from "./repeated-item-identity"

// Snapshot an optional descriptor without requiring it to be installed.
const installedSliceDefinition = (type: string) => readInstalledSliceDefinition(type)

const pm = (
  text: string,
  marks: Array<{ type: string; attrs?: Record<string, unknown> }> = [
    { type: "bold" },
  ]
) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text, marks }] }],
  })

// Frozen addressing oracles upcast only the adopted title grammar/descriptor;
// sibling bodies, links, IDs, epochs and field addresses remain exact.
const frozenRootOracle = {
  edit: {
    field: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
    fieldBindingFingerprint:
      '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
    occurrence: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
    preview: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
  },
  reorder: {
    field: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
    fieldBindingFingerprint:
      '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
    occurrence: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
    preview: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
  },
  marksAndLinkSibling: {
    field: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/changed\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
    fieldBindingFingerprint:
      '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/changed\\"}}]}]}]}"}',
    occurrence: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/changed\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
    preview: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/changed\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
  },
  equalValuedSwap: {
    before: {
      field: {
        itemIndex: 1,
        itemFingerprint:
          '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-0\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/0\\"}}]}]}]}"}',
        contentEpoch: 7,
      },
      fieldBindingFingerprint:
        '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-0\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/0\\"}}]}]}]}"}',
      occurrence: {
        itemIndex: 1,
        itemFingerprint:
          '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-0\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/0\\"}}]}]}]}"}',
        contentEpoch: 7,
      },
      preview: {
        itemIndex: 1,
        itemFingerprint:
          '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-0\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/0\\"}}]}]}]}"}',
        contentEpoch: 7,
      },
    },
    after: {
      field: {
        itemIndex: 1,
        itemFingerprint:
          '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-0\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/0\\"}}]}]}]}"}',
        contentEpoch: 7,
      },
      fieldBindingFingerprint:
        '{"icon":"Zap","title":null,"body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-0\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/0\\"}}]}]}]}"}',
      occurrence: {
        itemIndex: 1,
        itemFingerprint:
          '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-0\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/0\\"}}]}]}]}"}',
        contentEpoch: 7,
      },
      preview: {
        itemIndex: 1,
        itemFingerprint:
          '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-0\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/0\\"}}]}]}]}"}',
        contentEpoch: 7,
      },
    },
  },
  emptyRowList: {
    field: null,
    fieldBindingFingerprint: null,
    occurrence: null,
    preview: null,
  },
  staleEpoch: {
    captured: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
      contentEpoch: 7,
    },
    previewAt8: {
      itemIndex: 1,
      itemFingerprint:
        '{"icon":"Zap","title":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"equal\\",\\"marks\\":[{\\"type\\":\\"bold\\"}]}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"body-1\\",\\"marks\\":[{\\"type\\":\\"link\\",\\"attrs\\":{\\"href\\":\\"/p/1\\"}}]}]}]}"}',
      contentEpoch: 8,
    },
  },
}
const frozenEmptyRowOracle = {
  page: {
    locale: "en",
    sliceId: "empty-row-oracle",
    sliceType: "features-icon-grid",
    expectedSlice: "",
    fieldPath: "items.0.title",
    kind: "richText",
    value: "",
    repeatedTarget: {
      itemIndex: 0,
      itemFingerprint: '{"icon":"","title":null,"body":""}',
      contentEpoch: 11,
    },
    fieldBinding: {
      contentEpoch: 11,
      presentation: "",
      catalogRevision: "",
      descriptor:
        '{"kind":"richText","config":{"contract":"title","heading":{"role":"itemTitle","parent":"primary.heading"},"placeholder":"Blazing Fast Performance"},"validator":{"isOptional":"required","isConvexValidator":true,"kind":"string"},"default":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":3}}]}"}',
      lastApplied: "",
      itemFingerprint: '{"icon":"","title":null,"body":""}',
    },
  },
  occurrence: {
    repeatedTarget: {
      itemIndex: 0,
      itemFingerprint: '{"icon":"","title":"","body":""}',
      contentEpoch: 11,
    },
    locale: "en",
    sliceId: "empty-row-oracle",
    sliceType: "features-icon-grid",
    expectedSlice:
      '{"id":"empty-row-oracle","type":"features-icon-grid","enabled":true,"primary":{"eyebrow":"Features","heading":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":2},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Designed to scale\\"}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Spend less time configuring and more time creating.\\"}]}]}"},"items":[{"icon":"","title":"","body":""}]}',
  },
  preview: {
    repeatedTarget: {
      itemIndex: 0,
      itemFingerprint: '{"icon":"","title":"","body":""}',
      contentEpoch: 11,
    },
    locale: "en",
    sliceId: "empty-row-oracle",
    sliceType: "features-icon-grid",
    expectedSlice:
      '{"id":"empty-row-oracle","type":"features-icon-grid","enabled":true,"primary":{"eyebrow":"Features","heading":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":2},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Designed to scale\\"}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Spend less time configuring and more time creating.\\"}]}]}"},"items":[{"icon":"","title":"","body":""}]}',
    fieldPath: "items.0.title",
    kind: "richText",
    value:
      '{"type":"doc","content":[{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"changed"}]}]}',
  },
}

type RootTestSlice = Extract<Slice, { type: "features-icon-grid" }>

function rootFixture(): RootTestSlice {
  const slice = createSampleSlice("features-icon-grid")
  slice.id = "oracle"
  slice.items = [0, 1, 2].map((index) => ({
    ...slice.items[0],
    title: itemTitle("equal"),
    body: pm(`body-${index}`, [
      { type: "link", attrs: { href: `/p/${index}` } },
    ]),
  }))
  return slice as RootTestSlice
}

function rootOutputs(slice: ReturnType<typeof rootFixture>, epoch = 7) {
  const field = capturePageField(
    [slice],
    "en",
    slice.id,
    "items.1.title",
    epoch
  )
  const occurrence = captureSliceOccurrence(
    [slice],
    "en",
    slice.id,
    "items.1.title",
    epoch
  )
  const session: PreviewInlineSession = {
    ...occurrence!,
    fieldPath: "items.1.title",
    kind: "richText",
    draft: itemTitle("changed"),
    cancellationValue: itemTitle("equal"),
    label: "Title",
  }
  return {
    field,
    occurrence,
    preview: validatedPreviewCommit([slice], "en", session, epoch),
  }
}

describe("shared repeated item identity", () => {
  it("retains the frozen root-items outputs from all three existing producers", sliceProfile([]), () => {
    const base = rootFixture()
    const equalRows = {
      ...base,
      items: [0, 1, 2].map(() => ({ ...base.items[0] })),
    }
    const reordered = { ...base, items: [...base.items].reverse() }
    const changedLink = {
      ...base,
      items: base.items.map((item, index) =>
        index === 1
          ? {
              ...item,
              body: pm("body-1", [
                { type: "link", attrs: { href: "/changed" } },
              ]),
            }
          : item
      ),
    }
    const exact = (output: ReturnType<typeof rootOutputs>) => ({
      field: output.field?.repeatedTarget ?? null,
      fieldBindingFingerprint:
        output.field?.fieldBinding?.itemFingerprint ?? null,
      occurrence: output.occurrence?.repeatedTarget ?? null,
      preview: output.preview?.repeatedTarget ?? null,
    })
    expect(exact(rootOutputs(base))).toEqual(frozenRootOracle.edit)
    expect(exact(rootOutputs(reordered))).toEqual(frozenRootOracle.reorder)
    expect(exact(rootOutputs(equalRows))).toEqual(
      frozenRootOracle.equalValuedSwap.before
    )
    expect(
      exact(
        rootOutputs({ ...equalRows, items: [...equalRows.items].reverse() })
      )
    ).toEqual(frozenRootOracle.equalValuedSwap.after)
    expect(exact(rootOutputs(changedLink))).toEqual(
      frozenRootOracle.marksAndLinkSibling
    )
    const empty = { ...base, items: [] }
    expect(
      capturePageField([empty], "en", empty.id, "items.1.title", 7)
    ).toBeNull()
    expect({
      field: null,
      fieldBindingFingerprint: null,
      occurrence:
        captureSliceOccurrence([empty], "en", empty.id, "items.1.title", 7)
          ?.repeatedTarget ?? null,
      preview: null,
    }).toEqual(frozenRootOracle.emptyRowList)
    expect(rootOutputs(base, 7).occurrence?.repeatedTarget).toEqual(
      frozenRootOracle.staleEpoch.captured
    )
    expect(
      rootOutputs(base, 7).occurrence?.repeatedTarget?.contentEpoch
    ).not.toBe(8)
    expect({
      field:
        capturePageField([base], "en", base.id, "items.1.title", 8)
          ?.repeatedTarget ?? null,
      fieldBindingFingerprint:
        capturePageField([base], "en", base.id, "items.1.title", 8)
          ?.fieldBinding?.itemFingerprint ?? null,
      occurrence:
        captureSliceOccurrence([base], "en", base.id, "items.1.title", 8)
          ?.repeatedTarget ?? null,
      preview: rootOutputs(base, 8).preview?.repeatedTarget ?? null,
    }).toEqual({
      field: {
        ...frozenRootOracle.edit.field,
        contentEpoch: 8,
      },
      fieldBindingFingerprint: frozenRootOracle.edit.fieldBindingFingerprint,
      occurrence: frozenRootOracle.staleEpoch.previewAt8,
      preview: frozenRootOracle.staleEpoch.previewAt8,
    })
  })

  it("retains the frozen cleared root row in masked and full producer modes", sliceProfile([]), () => {
    const base = rootFixture()
    const row = { ...base.items[0], title: "", body: "", icon: "" }
    const slice = { ...base, id: "empty-row-oracle", items: [row] }
    const field = capturePageField([slice], "en", slice.id, "items.0.title", 11)
    const occurrence = captureSliceOccurrence(
      [slice],
      "en",
      slice.id,
      "items.0.title",
      11
    )
    const session: PreviewInlineSession = {
      ...occurrence!,
      fieldPath: "items.0.title",
      kind: "richText",
      draft: "changed",
      cancellationValue: "",
      label: "Title",
    }
    expect({
      page: field,
      occurrence,
      preview: validatedPreviewCommit([slice], "en", session, 11),
    }).toEqual(frozenEmptyRowOracle)
  })

  it("constructs root-items identity with the legacy target shape", sliceProfile([]), () => {
    const slice = rootFixture()
    const target = repeatedItemIdentity(slice, "items.1.title", 7, {
      maskField: true,
    })
    expect(target).toEqual(frozenRootOracle.edit.field)
    expect(Object.keys(target!)).toEqual([
      "itemIndex",
      "itemFingerprint",
      "contentEpoch",
    ])
  })

  it("matches a masked complete nested items target after its own leaf edit", sliceProfile([]), () => {
    const original = sliceDefs["features-icon-grid"]
    const installedOriginal = installedSliceDefinition("features-icon-grid")
    const details = list(
      group({
        copy: richText({ profile: "inline" }),
        title: richText({ profile: "inline" }),
      }),
      { max: 2 }
    )
    const items = list(group({ label: text(), details }), { max: 2 })
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
          details: [
            { copy: pm("captured"), title: pm("title") },
            { copy: pm("sibling"), title: pm("sibling title") },
          ],
        },
        {
          label: "other",
          details: [{ copy: pm("other"), title: pm("other title") }],
        },
      ])
      const path = "items.0.details.0.copy"
      const target = repeatedItemIdentity(slice, path, 5, {
        maskField: true,
      })
      if (!target) throw new Error("Expected a complete nested target")
      const ownLeafEdit = structuredClone(slice)
      const ownItems = structuredClone(slice.items)
      const ownDetails = Reflect.get(ownItems[0]!, "details")
      if (!Array.isArray(ownDetails))
        throw new Error("Expected nested item values")
      Reflect.set(ownDetails[0], "copy", pm("edited own leaf"))
      Reflect.set(ownItems[0], "details", ownDetails)
      Reflect.set(ownLeafEdit, "items", ownItems)
      expect(
        repeatedTargetMatches(ownLeafEdit, target, 5, {
          fieldPath: path,
          maskField: true,
        })
      ).toBe(true)
    } finally {
      Reflect.set(sliceDefs, "features-icon-grid", original)
      Reflect.set(installedSliceDefs, "features-icon-grid", installedOriginal)
    }
  })

  it("matches full-row leaves by row and masked leaves by exact field path", sliceProfile([]), () => {
    expect.assertions(4)
    const original = sliceDefs["features-icon-grid"]
    const installedOriginal = installedSliceDefinition("features-icon-grid")
    const details = list(
      group({
        copy: richText({ profile: "inline" }),
        title: richText({ profile: "inline" }),
      }),
      { max: 2 }
    )
    const items = list(group({ label: text(), details }), { max: 2 })
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
          details: [{ copy: pm("copy"), title: pm("title") }],
        },
        {
          label: "other",
          details: [{ copy: pm("other"), title: pm("other title") }],
        },
      ])
      const target = repeatedItemIdentity(slice, "items.0.details.0.copy", 5)
      if (!target) throw new Error("Expected a complete nested target")
      expect(
        repeatedTargetMatches(slice, target, 5, {
          fieldPath: "items.1.details.0.copy",
          maskField: false,
        })
      ).toBe(false)
      expect(
        repeatedTargetMatches(slice, target, 5, {
          fieldPath: "items.0.details.0.title",
          maskField: false,
        })
      ).toBe(true)
      const maskedCopy = repeatedItemIdentity(
        slice,
        "items.0.details.0.copy",
        5,
        { maskField: true }
      )
      if (!maskedCopy) throw new Error("Expected a masked leaf target")
      expect(
        repeatedTargetMatches(slice, maskedCopy, 5, {
          fieldPath: "items.0.details.0.title",
          maskField: true,
        })
      ).toBe(false)
      expect(
        repeatedTargetMatches(slice, maskedCopy, 5, {
          fieldPath: "items.0.details.0.copy",
          maskField: true,
        })
      ).toBe(true)
    } finally {
      Reflect.set(sliceDefs, "features-icon-grid", original)
      Reflect.set(installedSliceDefs, "features-icon-grid", installedOriginal)
    }
  })

  it("resolves nested primary-list identities across mixed object row kinds", sliceProfile([]), () => {
    const original = sliceDefs["features-icon-grid"]
    const details = list(group({ copy: richText({ profile: "inline" }) }), {
      max: 2,
    })
    const cards = list(
      group({
        title: richText({ profile: "inline" }),
        details,
      }),
      { max: 2 }
    )
    const assets = list(image(), { max: 2 })
    const primary = group({ ...original.primary.config.fields, cards, assets })
    const slice = {
      ...createSampleSlice("features-icon-grid"),
      id: "nested",
      primary: {
        ...createSampleSlice("features-icon-grid").primary,
        cards: [
          {
            title: pm("parent"),
            details: [{ copy: pm("first") }, { copy: pm("second") }],
          },
          { title: pm("other"), details: [{ copy: pm("third") }] },
        ],
        assets: [{ url: "/image.png", alt: "Image" }],
      },
      items: [
        {
          ...createSampleSlice("features-icon-grid").items[0],
          itemId: undefined,
        },
      ],
    } as unknown as Slice
    Reflect.set(sliceDefs, "features-icon-grid", {
      ...original,
      primary,
      validator: v.object({
        id: v.string(),
        type: v.literal("features-icon-grid"),
        enabled: v.boolean(),
        primary: primary.validator,
        items: original.items.validator,
      }),
    })
    try {
      const nested = repeatedItemIdentity(
        slice,
        "primary.cards.1.details.0.copy",
        4
      )
      expect(nested).toMatchObject({
        itemIndex: 0,
        listPath: "primary.cards.1.details",
        contentEpoch: 4,
        ancestors: [{ listPath: "primary.cards", itemIndex: 1 }],
      })
      expect(repeatedTargetMatches(slice, nested!, 4)).toBe(true)
      expect(repeatedItemIdentity(slice, "primary.assets.0", 4)).toMatchObject({
        itemIndex: 0,
        listPath: "primary.assets",
        contentEpoch: 4,
      })
      expect(repeatedItemIdentity(slice, "items.0.title", 4)).toMatchObject({
        itemIndex: 0,
      })
      expect(
        repeatedItemIdentity(slice, "items.0.title", 4)
      ).not.toHaveProperty("listPath")
      const linkAssets = list(link(), { max: 2 })
      const linkPrimary = group({
        ...original.primary.config.fields,
        cards,
        assets: linkAssets,
      })
      Reflect.set(sliceDefs, "features-icon-grid", {
        ...original,
        primary: linkPrimary,
      })
      const linked = {
        ...slice,
        primary: {
          ...slice.primary,
          assets: [{ type: "external", url: "/target" }],
        },
      } as unknown as Slice
      expect(repeatedItemIdentity(linked, "primary.assets.0", 4)).toMatchObject(
        { listPath: "primary.assets" }
      )
      const relationAssets = list(relation({ pageTypes: ["page"] }), { max: 2 })
      const relationPrimary = group({
        ...original.primary.config.fields,
        cards,
        assets: relationAssets,
      })
      Reflect.set(sliceDefs, "features-icon-grid", {
        ...original,
        primary: relationPrimary,
      })
      const related = {
        ...slice,
        primary: { ...slice.primary, assets: [{ pageId: "relation-target" }] },
      } as unknown as Slice
      expect(
        repeatedItemIdentity(related, "primary.assets.0", 4)
      ).toMatchObject({ listPath: "primary.assets" })
      expect(
        repeatedItemIdentity(slice, "primary.cards.1.details.0.copy", 4, {
          maskField: true,
        })?.itemFingerprint
      ).toContain('"copy":null')
      expect(
        (
          slice.primary as unknown as {
            cards: Array<{ details: Array<{ copy: string }> }>
          }
        ).cards[1]!.details[0]!.copy
      ).toBe(pm("third"))
    } finally {
      Reflect.set(sliceDefs, "features-icon-grid", original)
    }
  })

  it("masks the edited leaf in every ancestor while retaining sibling identity", sliceProfile([]), () => {
    const original = sliceDefs["features-icon-grid"]
    const rows = list(group({ copy: richText({ profile: "inline" }) }), {
      max: 2,
    })
    const cards = list(
      group({
        title: richText({ profile: "inline" }),
        details: rows,
      }),
      { max: 2 }
    )
    const primary = group({ ...original.primary.config.fields, cards })
    const descriptorDefault = original.primary.default
    Reflect.set(sliceDefs, "features-icon-grid", { ...original, primary })
    const slice = {
      ...createSampleSlice("features-icon-grid"),
      id: "ancestor-mask",
      primary: {
        ...createSampleSlice("features-icon-grid").primary,
        cards: [
          { title: pm("card"), details: [{ copy: pm("leaf") }] },
          { title: pm("sibling"), details: [{ copy: pm("other") }] },
        ],
      },
    } as unknown as Slice
    const before = JSON.stringify(slice)
    try {
      const path = "primary.cards.0.details.0.copy"
      const masked = repeatedItemIdentity(slice, path, 12, { maskField: true })
      const edited = {
        ...slice,
        primary: {
          ...slice.primary,
          cards: [
            {
              ...(
                slice.primary as unknown as {
                  cards: Array<Record<string, unknown>>
                }
              ).cards[0],
              details: [{ copy: pm("edited") }],
            },
            ...(
              slice.primary as unknown as {
                cards: Array<Record<string, unknown>>
              }
            ).cards.slice(1),
          ],
        },
      } as unknown as Slice
      expect(
        repeatedItemIdentity(edited, path, 12, { maskField: true })
      ).toEqual(masked)
      expect(repeatedItemIdentity(edited, path, 12)).not.toEqual(
        repeatedItemIdentity(slice, path, 12)
      )

      const changedSibling = {
        ...slice,
        primary: {
          ...slice.primary,
          cards: [
            {
              ...(
                slice.primary as unknown as {
                  cards: Array<Record<string, unknown>>
                }
              ).cards[0],
              title: pm("changed sibling", [{ type: "italic" }]),
              details: [{ copy: pm("leaf") }, { copy: pm("inserted") }],
            },
            ...(
              slice.primary as unknown as {
                cards: Array<Record<string, unknown>>
              }
            ).cards.slice(1),
          ],
        },
      } as unknown as Slice
      expect(
        repeatedItemIdentity(changedSibling, path, 12, { maskField: true })
      ).not.toEqual(masked)
      expect(JSON.stringify(slice)).toBe(before)
      expect(original.primary.default).toEqual(descriptorDefault)
    } finally {
      Reflect.set(sliceDefs, "features-icon-grid", original)
    }
  })

  it("refuses missing rows, malformed paths, prototype paths, and stale epochs", sliceProfile([]), () => {
    const slice = rootFixture()
    for (const path of [
      "items.9.title",
      "items.-1.title",
      "items.01.title",
      "items.1.__proto__",
      "items.1.constructor",
      "items[1].title",
      "items..1.title",
    ])
      expect(repeatedItemIdentity(slice, path, 1)).toBeNull()
    expect(repeatedItemIdentity(slice, "primary.heading", -1)).toBeNull()
    expect(repeatedItemIdentity(slice, "primary.heading", 1)).toBeUndefined()
    const target = repeatedItemIdentity(slice, "items.1.title", 7)!
    expect(repeatedTargetMatches(slice, target, 8)).toBe(false)
    expect(
      repeatedTargetMatches(slice, { ...target, extra: true } as never, 7)
    ).toBe(false)
  })

  it("masks only the edited leaf and detects marks, link targets, siblings, and row changes", sliceProfile([]), () => {
    const slice = rootFixture()
    const path = "items.1.title"
    const initial = repeatedItemIdentity(slice, path, 3, { maskField: true })!
    const editedOwnLeaf = {
      ...slice,
      items: slice.items.map((item, index) =>
        index === 1 ? { ...item, title: pm("changed") } : item
      ),
    }
    expect(
      repeatedItemIdentity(editedOwnLeaf, path, 3, { maskField: true })
    ).toEqual(initial)
    const changedSibling = {
      ...slice,
      items: slice.items.map((item, index) =>
        index === 1
          ? {
              ...item,
              body: pm("changed", [{ type: "link", attrs: { href: "/new" } }]),
            }
          : item
      ),
    }
    expect(
      repeatedItemIdentity(changedSibling, path, 3, { maskField: true })
    ).not.toEqual(initial)
    expect(repeatedItemIdentity(changedSibling, path, 3)).not.toEqual(
      repeatedItemIdentity(slice, path, 3)
    )
    const changedMark = {
      ...slice,
      items: slice.items.map((item, index) =>
        index === 1
          ? { ...item, body: pm("body-1", [{ type: "italic" }]) }
          : item
      ),
    }
    expect(
      repeatedItemIdentity(changedMark, path, 3, { maskField: true })
    ).not.toEqual(initial)
    expect(
      repeatedItemIdentity(
        { ...slice, items: slice.items.slice(0, 1) },
        path,
        3
      )
    ).toBeNull()
    const dupes = {
      ...slice,
      items: [{ ...slice.items[0] }, { ...slice.items[0] }],
    }
    const duplicateTarget = repeatedItemIdentity(dupes, path, 3)!
    expect(duplicateTarget).toEqual(
      repeatedItemIdentity(
        { ...dupes, items: [...dupes.items].reverse() },
        path,
        3
      )
    )
    expect(
      repeatedTargetMatches(
        { ...dupes, items: [...dupes.items].reverse() },
        duplicateTarget,
        4
      )
    ).toBe(false)
    expect(repeatedItemIdentity(dupes, path, 4)?.contentEpoch).toBe(4)
  })

  it("invalidates nested parent and child structure while retaining the source values", sliceProfile([]), () => {
    const original = sliceDefs["features-icon-grid"]
    const rows = list(group({ title: richText({ profile: "inline" }) }), {
      max: 2,
    })
    const cards = list(group({ rows }), { max: 2 })
    const primary = group({ ...original.primary.config.fields, cards })
    const slice = {
      ...createSampleSlice("features-icon-grid"),
      id: "structure",
      primary: {
        ...createSampleSlice("features-icon-grid").primary,
        cards: [
          { rows: [{ title: pm("same") }, { title: pm("same") }] },
          { rows: [{ title: pm("other") }] },
        ],
      },
    } as unknown as Slice
    const descriptorDefault = structuredClone(original.primary.default)
    Reflect.set(sliceDefs, "features-icon-grid", { ...original, primary })
    const before = JSON.stringify(slice)
    try {
      const path = "primary.cards.0.rows.0.title"
      const target = repeatedItemIdentity(slice, path, 2)!
      const parentReordered = {
        ...slice,
        primary: {
          ...slice.primary,
          cards: [
            ...(slice.primary as unknown as { cards: unknown[] }).cards,
          ].reverse(),
        },
      } as unknown as Slice
      const childReordered = {
        ...slice,
        primary: {
          ...slice.primary,
          cards: (
            slice.primary as unknown as { cards: Array<{ rows: unknown[] }> }
          ).cards.map((card, i) =>
            i === 0 ? { ...card, rows: [...card.rows].reverse() } : card
          ),
        },
      } as unknown as Slice
      const removed = {
        ...slice,
        primary: {
          ...slice.primary,
          cards: (slice.primary as unknown as { cards: unknown[] }).cards.slice(
            1
          ),
        },
      } as unknown as Slice
      expect(repeatedTargetMatches(parentReordered, target, 2)).toBe(false)
      expect(repeatedTargetMatches(childReordered, target, 2)).toBe(true)
      expect(repeatedTargetMatches(childReordered, target, 3)).toBe(false)
      expect(repeatedTargetMatches(removed, target, 2)).toBe(false)
      expect(repeatedTargetMatches(slice, target, 3)).toBe(false)
      const small = {
        ...slice,
        primary: {
          ...slice.primary,
          cards: [{ rows: [{ title: pm("same") }] }],
        },
      } as unknown as Slice
      const smallTarget = repeatedItemIdentity(small, path, 2)!
      const insertedChild = {
        ...small,
        primary: {
          ...small.primary,
          cards: [{ rows: [{ title: pm("same") }, { title: pm("same") }] }],
        },
      } as unknown as Slice
      expect(repeatedTargetMatches(insertedChild, smallTarget, 2)).toBe(false)
      expect(repeatedTargetMatches(insertedChild, smallTarget, 3)).toBe(false)
      const insertedParent = {
        ...small,
        primary: {
          ...small.primary,
          cards: [
            ...(small.primary as unknown as { cards: unknown[] }).cards,
            { rows: [{ title: pm("sibling") }] },
          ],
        },
      } as unknown as Slice
      expect(repeatedTargetMatches(insertedParent, smallTarget, 2)).toBe(true)
      expect(repeatedTargetMatches(insertedParent, smallTarget, 3)).toBe(false)
      const removedChild = {
        ...small,
        primary: { ...small.primary, cards: [{ rows: [] }] },
      } as unknown as Slice
      expect(repeatedTargetMatches(removedChild, smallTarget, 3)).toBe(false)
      expect(JSON.stringify(slice)).toBe(before)
      expect(original.primary.default).toEqual(descriptorDefault)
    } finally {
      Reflect.set(sliceDefs, "features-icon-grid", original)
    }
  })

  it("binds preview commits to the nested path and advances two consecutive commits", sliceProfile([]), () => {
    const original = sliceDefs["features-icon-grid"]
    const primary = group({
      ...original.primary.config.fields,
      cards: list(
        group({
          rows: list(group({ title: richText({ profile: "inline" }) }), {
            max: 2,
          }),
        }),
        { max: 2 }
      ),
    })
    const item = { title: pm("same") }
    const slice = {
      ...createSampleSlice("features-icon-grid"),
      id: "sequence",
      primary: {
        ...createSampleSlice("features-icon-grid").primary,
        cards: [
          { rows: [item, { ...item }] },
          { rows: [{ title: pm("other card") }] },
        ],
      },
    } as unknown as Slice
    Reflect.set(sliceDefs, "features-icon-grid", {
      ...original,
      primary,
      validator: v.object({
        id: v.string(),
        type: v.literal("features-icon-grid"),
        enabled: v.boolean(),
        primary: primary.validator,
        items: original.items.validator,
      }),
    })
    try {
      const fieldPath = "primary.cards.0.rows.0.title"
      const baseline = captureSliceOccurrence(
        [slice],
        "en",
        slice.id,
        fieldPath,
        5
      )!
      const session: PreviewInlineSession = {
        ...baseline,
        fieldPath,
        kind: "richText",
        draft: pm("one"),
        cancellationValue: pm("same"),
        label: "Title",
      }
      const first = validatedPreviewCommit([slice], "en", session, 5)!
      const originalSlices = [slice]
      const directlyApplied = applyPreviewInlineEdit(
        originalSlices,
        "en",
        first,
        5
      )
      expect(
        (
          directlyApplied[0]!.primary as unknown as {
            cards: Array<{ rows: Array<{ title: string }> }>
          }
        ).cards[0]!.rows[0]!.title
      ).toBe(pm("one"))
      expect(
        (
          slice.primary as unknown as {
            cards: Array<{ rows: Array<{ title: string }> }>
          }
        ).cards[0]!.rows[0]!.title
      ).toBe(pm("same"))
      expect(
        applyPreviewInlineEdit(
          originalSlices,
          "en",
          { ...first, repeatedTarget: undefined },
          5
        )
      ).toBe(originalSlices)
      const sourceBeforeWrongBinding = JSON.stringify(slice)
      expect(
        applyPreviewInlineEdit(
          originalSlices,
          "en",
          {
            ...first,
            fieldPath: "primary.cards.0.rows.1.title",
          },
          5
        )
      ).toBe(originalSlices)
      const validSiblingTarget = repeatedItemIdentity(
        slice,
        "primary.cards.0.rows.1.title",
        5
      )
      expect(validSiblingTarget).not.toBeNull()
      expect(validSiblingTarget).not.toEqual(first.repeatedTarget)
      expect(JSON.stringify(slice)).toBe(sourceBeforeWrongBinding)
      const accepted = acceptPreviewCapture(session, first)
      const saved = JSON.parse(accepted.expectedSlice) as unknown as Slice
      expect(accepted.repeatedTarget).toEqual(
        repeatedItemIdentity(saved, fieldPath, 5)
      )
      const secondCommit = validatedPreviewCommit(
        [saved],
        "en",
        { ...accepted, draft: pm("two") },
        5
      )!
      const secondAccepted = acceptPreviewCapture(
        { ...accepted, draft: pm("two") },
        secondCommit
      )
      const secondSaved = JSON.parse(
        secondAccepted.expectedSlice
      ) as unknown as Slice
      expect(
        (
          secondSaved.primary as unknown as {
            cards: Array<{ rows: Array<{ title: string }> }>
          }
        ).cards[0]!.rows[0]!.title
      ).toBe(pm("two"))
      expect(
        (
          secondSaved.primary as unknown as {
            cards: Array<{ rows: Array<{ title: string }> }>
          }
        ).cards[0]!.rows[1]!.title
      ).toBe(pm("same"))
      expect(secondAccepted.repeatedTarget?.ancestors).toHaveLength(1)
      expect(secondAccepted.repeatedTarget).toEqual(
        repeatedItemIdentity(secondSaved, fieldPath, 5)
      )
      const changedSibling = {
        ...saved,
        primary: {
          ...saved.primary,
          cards: (
            saved.primary as unknown as {
              cards: Array<{ rows: Array<{ title: string }> }>
            }
          ).cards.map((card, index) =>
            index === 0
              ? {
                  ...card,
                  rows: card.rows.map((row, rowIndex) =>
                    rowIndex === 1 ? { title: pm("sibling changed") } : row
                  ),
                }
              : card
          ),
        },
      } as unknown as Slice
      expect(
        validatedPreviewCommit(
          [changedSibling],
          "en",
          { ...accepted, draft: pm("refused") },
          5
        )
      ).toBeNull()
      const siblingSlices = [changedSibling]
      const siblingBefore = JSON.stringify(changedSibling)
      expect(applyPreviewInlineEdit(siblingSlices, "en", secondCommit, 5)).toBe(
        siblingSlices
      )
      expect(JSON.stringify(changedSibling)).toBe(siblingBefore)
    } finally {
      Reflect.set(sliceDefs, "features-icon-grid", original)
    }
  })

  it("preserves legacy root two-commit behavior and refuses sibling changes", sliceProfile([]), () => {
    const slice = rootFixture()
    const fieldPath = "items.1.title"
    const baseline = captureSliceOccurrence(
      [slice],
      "en",
      slice.id,
      fieldPath,
      7
    )!
    const session: PreviewInlineSession = {
      ...baseline,
      fieldPath,
      kind: "richText",
      draft: itemTitle("one"),
      cancellationValue: itemTitle("equal"),
      label: "Title",
    }
    const first = validatedPreviewCommit([slice], "en", session, 7)!
    const accepted = acceptPreviewCapture(session, first)
    const saved = JSON.parse(accepted.expectedSlice) as unknown as RootTestSlice
    const second = validatedPreviewCommit(
      [saved],
      "en",
      { ...accepted, draft: itemTitle("two") },
      7
    )!
    const secondAccepted = acceptPreviewCapture(
      { ...accepted, draft: itemTitle("two") },
      second
    )
    const secondSaved = JSON.parse(secondAccepted.expectedSlice) as ReturnType<
      typeof rootFixture
    >
    expect(secondSaved.items[1].title).toBe(itemTitle("two"))

    const changedSibling = {
      ...saved,
      items: saved.items.map((item, index) =>
        index === 2 ? { ...item, body: pm("sibling") } : item
      ),
    }
    const refused = validatedPreviewCommit(
      [changedSibling],
      "en",
      { ...accepted, draft: itemTitle("refused") },
      7
    )
    expect(refused).toBeNull()
    const siblingSlices = [changedSibling]
    const unchangedBytes = JSON.stringify(changedSibling)
    expect(applyPreviewInlineEdit(siblingSlices, "en", second, 7)).toBe(
      siblingSlices
    )
    expect((changedSibling.items[2] as { body: string }).body).toBe(
      pm("sibling")
    )
    expect(JSON.stringify(changedSibling)).toBe(unchangedBytes)
  })
})

import { readInstalledBlockDefinition } from "@/convex/lib/blocks"
import { createSampleBlock } from "@/convex/lib/blocks/sample"
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
import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, it } from "vitest"
import { v } from "convex/values"

import { installedBlockDefs, blockDefs, type Block } from "@/convex/lib/blocks"
import {
  group,
  image,
  link,
  list,
  relation,
  richText,
  text,
} from "@/convex/lib/blocks/primitives"
import { capturePageField } from "./page-inline-draft"
import {
  captureBlockOccurrence,
  applyPreviewInlineEdit,
} from "./block-occurrence"
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
const installedBlockDefinition = (type: string) => readInstalledBlockDefinition(type)

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
    blockId: "empty-row-oracle",
    blockType: "features-icon-grid",
    expectedBlock: "",
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
    blockId: "empty-row-oracle",
    blockType: "features-icon-grid",
    expectedBlock:
      '{"id":"empty-row-oracle","type":"features-icon-grid","enabled":true,"primary":{"eyebrow":"Features","heading":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":2},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Designed to scale\\"}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Spend less time configuring and more time creating.\\"}]}]}"},"items":[{"icon":"","title":"","body":""}]}',
  },
  preview: {
    repeatedTarget: {
      itemIndex: 0,
      itemFingerprint: '{"icon":"","title":"","body":""}',
      contentEpoch: 11,
    },
    locale: "en",
    blockId: "empty-row-oracle",
    blockType: "features-icon-grid",
    expectedBlock:
      '{"id":"empty-row-oracle","type":"features-icon-grid","enabled":true,"primary":{"eyebrow":"Features","heading":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"heading\\",\\"attrs\\":{\\"level\\":2},\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Designed to scale\\"}]}]}","body":"{\\"type\\":\\"doc\\",\\"content\\":[{\\"type\\":\\"paragraph\\",\\"content\\":[{\\"type\\":\\"text\\",\\"text\\":\\"Spend less time configuring and more time creating.\\"}]}]}"},"items":[{"icon":"","title":"","body":""}]}',
    fieldPath: "items.0.title",
    kind: "richText",
    value:
      '{"type":"doc","content":[{"type":"heading","attrs":{"level":3},"content":[{"type":"text","text":"changed"}]}]}',
  },
}

type RootTestBlock = Extract<Block, { type: "features-icon-grid" }>

function rootFixture(): RootTestBlock {
  const block = createSampleBlock("features-icon-grid")
  block.id = "oracle"
  block.items = [0, 1, 2].map((index) => ({
    ...block.items[0],
    title: itemTitle("equal"),
    body: pm(`body-${index}`, [
      { type: "link", attrs: { href: `/p/${index}` } },
    ]),
  }))
  return block as RootTestBlock
}

function rootOutputs(block: ReturnType<typeof rootFixture>, epoch = 7) {
  const field = capturePageField(
    [block],
    "en",
    block.id,
    "items.1.title",
    epoch
  )
  const occurrence = captureBlockOccurrence(
    [block],
    "en",
    block.id,
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
    preview: validatedPreviewCommit([block], "en", session, epoch),
  }
}

describe("shared repeated item identity", () => {
  it("retains the frozen root-items outputs from all three existing producers", blockProfile([]), () => {
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
        captureBlockOccurrence([empty], "en", empty.id, "items.1.title", 7)
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
        captureBlockOccurrence([base], "en", base.id, "items.1.title", 8)
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

  it("retains the frozen cleared root row in masked and full producer modes", blockProfile([]), () => {
    const base = rootFixture()
    const row = { ...base.items[0], title: "", body: "", icon: "" }
    const block = { ...base, id: "empty-row-oracle", items: [row] }
    const field = capturePageField([block], "en", block.id, "items.0.title", 11)
    const occurrence = captureBlockOccurrence(
      [block],
      "en",
      block.id,
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
      preview: validatedPreviewCommit([block], "en", session, 11),
    }).toEqual(frozenEmptyRowOracle)
  })

  it("constructs root-items identity with the legacy target shape", blockProfile([]), () => {
    const block = rootFixture()
    const target = repeatedItemIdentity(block, "items.1.title", 7, {
      maskField: true,
    })
    expect(target).toEqual(frozenRootOracle.edit.field)
    expect(Object.keys(target!)).toEqual([
      "itemIndex",
      "itemFingerprint",
      "contentEpoch",
    ])
  })

  it("matches a masked complete nested items target after its own leaf edit", blockProfile([]), () => {
    const original = blockDefs["features-icon-grid"]
    const installedOriginal = installedBlockDefinition("features-icon-grid")
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
    Reflect.set(blockDefs, "features-icon-grid", def)
    Reflect.set(installedBlockDefs, "features-icon-grid", def)
    try {
      const block = createSampleBlock("features-icon-grid")
      Reflect.set(block, "items", [
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
      const target = repeatedItemIdentity(block, path, 5, {
        maskField: true,
      })
      if (!target) throw new Error("Expected a complete nested target")
      const ownLeafEdit = structuredClone(block)
      const ownItems = structuredClone(block.items)
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
      Reflect.set(blockDefs, "features-icon-grid", original)
      Reflect.set(installedBlockDefs, "features-icon-grid", installedOriginal)
    }
  })

  it("matches full-row leaves by row and masked leaves by exact field path", blockProfile([]), () => {
    expect.assertions(4)
    const original = blockDefs["features-icon-grid"]
    const installedOriginal = installedBlockDefinition("features-icon-grid")
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
    Reflect.set(blockDefs, "features-icon-grid", def)
    Reflect.set(installedBlockDefs, "features-icon-grid", def)
    try {
      const block = createSampleBlock("features-icon-grid")
      Reflect.set(block, "items", [
        {
          label: "parent",
          details: [{ copy: pm("copy"), title: pm("title") }],
        },
        {
          label: "other",
          details: [{ copy: pm("other"), title: pm("other title") }],
        },
      ])
      const target = repeatedItemIdentity(block, "items.0.details.0.copy", 5)
      if (!target) throw new Error("Expected a complete nested target")
      expect(
        repeatedTargetMatches(block, target, 5, {
          fieldPath: "items.1.details.0.copy",
          maskField: false,
        })
      ).toBe(false)
      expect(
        repeatedTargetMatches(block, target, 5, {
          fieldPath: "items.0.details.0.title",
          maskField: false,
        })
      ).toBe(true)
      const maskedCopy = repeatedItemIdentity(
        block,
        "items.0.details.0.copy",
        5,
        { maskField: true }
      )
      if (!maskedCopy) throw new Error("Expected a masked leaf target")
      expect(
        repeatedTargetMatches(block, maskedCopy, 5, {
          fieldPath: "items.0.details.0.title",
          maskField: true,
        })
      ).toBe(false)
      expect(
        repeatedTargetMatches(block, maskedCopy, 5, {
          fieldPath: "items.0.details.0.copy",
          maskField: true,
        })
      ).toBe(true)
    } finally {
      Reflect.set(blockDefs, "features-icon-grid", original)
      Reflect.set(installedBlockDefs, "features-icon-grid", installedOriginal)
    }
  })

  it("resolves nested primary-list identities across mixed object row kinds", blockProfile([]), () => {
    const original = blockDefs["features-icon-grid"]
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
    const block = {
      ...createSampleBlock("features-icon-grid"),
      id: "nested",
      primary: {
        ...createSampleBlock("features-icon-grid").primary,
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
          ...createSampleBlock("features-icon-grid").items[0],
          itemId: undefined,
        },
      ],
    } as unknown as Block
    Reflect.set(blockDefs, "features-icon-grid", {
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
        block,
        "primary.cards.1.details.0.copy",
        4
      )
      expect(nested).toMatchObject({
        itemIndex: 0,
        listPath: "primary.cards.1.details",
        contentEpoch: 4,
        ancestors: [{ listPath: "primary.cards", itemIndex: 1 }],
      })
      expect(repeatedTargetMatches(block, nested!, 4)).toBe(true)
      expect(repeatedItemIdentity(block, "primary.assets.0", 4)).toMatchObject({
        itemIndex: 0,
        listPath: "primary.assets",
        contentEpoch: 4,
      })
      expect(repeatedItemIdentity(block, "items.0.title", 4)).toMatchObject({
        itemIndex: 0,
      })
      expect(
        repeatedItemIdentity(block, "items.0.title", 4)
      ).not.toHaveProperty("listPath")
      const linkAssets = list(link(), { max: 2 })
      const linkPrimary = group({
        ...original.primary.config.fields,
        cards,
        assets: linkAssets,
      })
      Reflect.set(blockDefs, "features-icon-grid", {
        ...original,
        primary: linkPrimary,
      })
      const linked = {
        ...block,
        primary: {
          ...block.primary,
          assets: [{ type: "external", url: "/target" }],
        },
      } as unknown as Block
      expect(repeatedItemIdentity(linked, "primary.assets.0", 4)).toMatchObject(
        { listPath: "primary.assets" }
      )
      const relationAssets = list(relation({ pageTypes: ["page"] }), { max: 2 })
      const relationPrimary = group({
        ...original.primary.config.fields,
        cards,
        assets: relationAssets,
      })
      Reflect.set(blockDefs, "features-icon-grid", {
        ...original,
        primary: relationPrimary,
      })
      const related = {
        ...block,
        primary: { ...block.primary, assets: [{ pageId: "relation-target" }] },
      } as unknown as Block
      expect(
        repeatedItemIdentity(related, "primary.assets.0", 4)
      ).toMatchObject({ listPath: "primary.assets" })
      expect(
        repeatedItemIdentity(block, "primary.cards.1.details.0.copy", 4, {
          maskField: true,
        })?.itemFingerprint
      ).toContain('"copy":null')
      expect(
        (
          block.primary as unknown as {
            cards: Array<{ details: Array<{ copy: string }> }>
          }
        ).cards[1]!.details[0]!.copy
      ).toBe(pm("third"))
    } finally {
      Reflect.set(blockDefs, "features-icon-grid", original)
    }
  })

  it("masks the edited leaf in every ancestor while retaining sibling identity", blockProfile([]), () => {
    const original = blockDefs["features-icon-grid"]
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
    Reflect.set(blockDefs, "features-icon-grid", { ...original, primary })
    const block = {
      ...createSampleBlock("features-icon-grid"),
      id: "ancestor-mask",
      primary: {
        ...createSampleBlock("features-icon-grid").primary,
        cards: [
          { title: pm("card"), details: [{ copy: pm("leaf") }] },
          { title: pm("sibling"), details: [{ copy: pm("other") }] },
        ],
      },
    } as unknown as Block
    const before = JSON.stringify(block)
    try {
      const path = "primary.cards.0.details.0.copy"
      const masked = repeatedItemIdentity(block, path, 12, { maskField: true })
      const edited = {
        ...block,
        primary: {
          ...block.primary,
          cards: [
            {
              ...(
                block.primary as unknown as {
                  cards: Array<Record<string, unknown>>
                }
              ).cards[0],
              details: [{ copy: pm("edited") }],
            },
            ...(
              block.primary as unknown as {
                cards: Array<Record<string, unknown>>
              }
            ).cards.slice(1),
          ],
        },
      } as unknown as Block
      expect(
        repeatedItemIdentity(edited, path, 12, { maskField: true })
      ).toEqual(masked)
      expect(repeatedItemIdentity(edited, path, 12)).not.toEqual(
        repeatedItemIdentity(block, path, 12)
      )

      const changedSibling = {
        ...block,
        primary: {
          ...block.primary,
          cards: [
            {
              ...(
                block.primary as unknown as {
                  cards: Array<Record<string, unknown>>
                }
              ).cards[0],
              title: pm("changed sibling", [{ type: "italic" }]),
              details: [{ copy: pm("leaf") }, { copy: pm("inserted") }],
            },
            ...(
              block.primary as unknown as {
                cards: Array<Record<string, unknown>>
              }
            ).cards.slice(1),
          ],
        },
      } as unknown as Block
      expect(
        repeatedItemIdentity(changedSibling, path, 12, { maskField: true })
      ).not.toEqual(masked)
      expect(JSON.stringify(block)).toBe(before)
      expect(original.primary.default).toEqual(descriptorDefault)
    } finally {
      Reflect.set(blockDefs, "features-icon-grid", original)
    }
  })

  it("refuses missing rows, malformed paths, prototype paths, and stale epochs", blockProfile([]), () => {
    const block = rootFixture()
    for (const path of [
      "items.9.title",
      "items.-1.title",
      "items.01.title",
      "items.1.__proto__",
      "items.1.constructor",
      "items[1].title",
      "items..1.title",
    ])
      expect(repeatedItemIdentity(block, path, 1)).toBeNull()
    expect(repeatedItemIdentity(block, "primary.heading", -1)).toBeNull()
    expect(repeatedItemIdentity(block, "primary.heading", 1)).toBeUndefined()
    const target = repeatedItemIdentity(block, "items.1.title", 7)!
    expect(repeatedTargetMatches(block, target, 8)).toBe(false)
    expect(
      repeatedTargetMatches(block, { ...target, extra: true } as never, 7)
    ).toBe(false)
  })

  it("masks only the edited leaf and detects marks, link targets, siblings, and row changes", blockProfile([]), () => {
    const block = rootFixture()
    const path = "items.1.title"
    const initial = repeatedItemIdentity(block, path, 3, { maskField: true })!
    const editedOwnLeaf = {
      ...block,
      items: block.items.map((item, index) =>
        index === 1 ? { ...item, title: pm("changed") } : item
      ),
    }
    expect(
      repeatedItemIdentity(editedOwnLeaf, path, 3, { maskField: true })
    ).toEqual(initial)
    const changedSibling = {
      ...block,
      items: block.items.map((item, index) =>
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
      repeatedItemIdentity(block, path, 3)
    )
    const changedMark = {
      ...block,
      items: block.items.map((item, index) =>
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
        { ...block, items: block.items.slice(0, 1) },
        path,
        3
      )
    ).toBeNull()
    const dupes = {
      ...block,
      items: [{ ...block.items[0] }, { ...block.items[0] }],
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

  it("invalidates nested parent and child structure while retaining the source values", blockProfile([]), () => {
    const original = blockDefs["features-icon-grid"]
    const rows = list(group({ title: richText({ profile: "inline" }) }), {
      max: 2,
    })
    const cards = list(group({ rows }), { max: 2 })
    const primary = group({ ...original.primary.config.fields, cards })
    const block = {
      ...createSampleBlock("features-icon-grid"),
      id: "structure",
      primary: {
        ...createSampleBlock("features-icon-grid").primary,
        cards: [
          { rows: [{ title: pm("same") }, { title: pm("same") }] },
          { rows: [{ title: pm("other") }] },
        ],
      },
    } as unknown as Block
    const descriptorDefault = structuredClone(original.primary.default)
    Reflect.set(blockDefs, "features-icon-grid", { ...original, primary })
    const before = JSON.stringify(block)
    try {
      const path = "primary.cards.0.rows.0.title"
      const target = repeatedItemIdentity(block, path, 2)!
      const parentReordered = {
        ...block,
        primary: {
          ...block.primary,
          cards: [
            ...(block.primary as unknown as { cards: unknown[] }).cards,
          ].reverse(),
        },
      } as unknown as Block
      const childReordered = {
        ...block,
        primary: {
          ...block.primary,
          cards: (
            block.primary as unknown as { cards: Array<{ rows: unknown[] }> }
          ).cards.map((card, i) =>
            i === 0 ? { ...card, rows: [...card.rows].reverse() } : card
          ),
        },
      } as unknown as Block
      const removed = {
        ...block,
        primary: {
          ...block.primary,
          cards: (block.primary as unknown as { cards: unknown[] }).cards.slice(
            1
          ),
        },
      } as unknown as Block
      expect(repeatedTargetMatches(parentReordered, target, 2)).toBe(false)
      expect(repeatedTargetMatches(childReordered, target, 2)).toBe(true)
      expect(repeatedTargetMatches(childReordered, target, 3)).toBe(false)
      expect(repeatedTargetMatches(removed, target, 2)).toBe(false)
      expect(repeatedTargetMatches(block, target, 3)).toBe(false)
      const small = {
        ...block,
        primary: {
          ...block.primary,
          cards: [{ rows: [{ title: pm("same") }] }],
        },
      } as unknown as Block
      const smallTarget = repeatedItemIdentity(small, path, 2)!
      const insertedChild = {
        ...small,
        primary: {
          ...small.primary,
          cards: [{ rows: [{ title: pm("same") }, { title: pm("same") }] }],
        },
      } as unknown as Block
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
      } as unknown as Block
      expect(repeatedTargetMatches(insertedParent, smallTarget, 2)).toBe(true)
      expect(repeatedTargetMatches(insertedParent, smallTarget, 3)).toBe(false)
      const removedChild = {
        ...small,
        primary: { ...small.primary, cards: [{ rows: [] }] },
      } as unknown as Block
      expect(repeatedTargetMatches(removedChild, smallTarget, 3)).toBe(false)
      expect(JSON.stringify(block)).toBe(before)
      expect(original.primary.default).toEqual(descriptorDefault)
    } finally {
      Reflect.set(blockDefs, "features-icon-grid", original)
    }
  })

  it("binds preview commits to the nested path and advances two consecutive commits", blockProfile([]), () => {
    const original = blockDefs["features-icon-grid"]
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
    const block = {
      ...createSampleBlock("features-icon-grid"),
      id: "sequence",
      primary: {
        ...createSampleBlock("features-icon-grid").primary,
        cards: [
          { rows: [item, { ...item }] },
          { rows: [{ title: pm("other card") }] },
        ],
      },
    } as unknown as Block
    Reflect.set(blockDefs, "features-icon-grid", {
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
      const baseline = captureBlockOccurrence(
        [block],
        "en",
        block.id,
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
      const first = validatedPreviewCommit([block], "en", session, 5)!
      const originalBlocks = [block]
      const directlyApplied = applyPreviewInlineEdit(
        originalBlocks,
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
          block.primary as unknown as {
            cards: Array<{ rows: Array<{ title: string }> }>
          }
        ).cards[0]!.rows[0]!.title
      ).toBe(pm("same"))
      expect(
        applyPreviewInlineEdit(
          originalBlocks,
          "en",
          { ...first, repeatedTarget: undefined },
          5
        )
      ).toBe(originalBlocks)
      const sourceBeforeWrongBinding = JSON.stringify(block)
      expect(
        applyPreviewInlineEdit(
          originalBlocks,
          "en",
          {
            ...first,
            fieldPath: "primary.cards.0.rows.1.title",
          },
          5
        )
      ).toBe(originalBlocks)
      const validSiblingTarget = repeatedItemIdentity(
        block,
        "primary.cards.0.rows.1.title",
        5
      )
      expect(validSiblingTarget).not.toBeNull()
      expect(validSiblingTarget).not.toEqual(first.repeatedTarget)
      expect(JSON.stringify(block)).toBe(sourceBeforeWrongBinding)
      const accepted = acceptPreviewCapture(session, first)
      const saved = JSON.parse(accepted.expectedBlock) as unknown as Block
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
        secondAccepted.expectedBlock
      ) as unknown as Block
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
      } as unknown as Block
      expect(
        validatedPreviewCommit(
          [changedSibling],
          "en",
          { ...accepted, draft: pm("refused") },
          5
        )
      ).toBeNull()
      const siblingBlocks = [changedSibling]
      const siblingBefore = JSON.stringify(changedSibling)
      expect(applyPreviewInlineEdit(siblingBlocks, "en", secondCommit, 5)).toBe(
        siblingBlocks
      )
      expect(JSON.stringify(changedSibling)).toBe(siblingBefore)
    } finally {
      Reflect.set(blockDefs, "features-icon-grid", original)
    }
  })

  it("preserves legacy root two-commit behavior and refuses sibling changes", blockProfile([]), () => {
    const block = rootFixture()
    const fieldPath = "items.1.title"
    const baseline = captureBlockOccurrence(
      [block],
      "en",
      block.id,
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
    const first = validatedPreviewCommit([block], "en", session, 7)!
    const accepted = acceptPreviewCapture(session, first)
    const saved = JSON.parse(accepted.expectedBlock) as unknown as RootTestBlock
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
    const secondSaved = JSON.parse(secondAccepted.expectedBlock) as ReturnType<
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
    const siblingBlocks = [changedSibling]
    const unchangedBytes = JSON.stringify(changedSibling)
    expect(applyPreviewInlineEdit(siblingBlocks, "en", second, 7)).toBe(
      siblingBlocks
    )
    expect((changedSibling.items[2] as { body: string }).body).toBe(
      pm("sibling")
    )
    expect(JSON.stringify(changedSibling)).toBe(unchangedBytes)
  })
})

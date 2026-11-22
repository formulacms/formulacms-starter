import { readInstalledBlockDefinition } from "@/convex/lib/blocks"
import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, it, vi } from "vitest"
import { v, type GenericValidator, type VObject } from "convex/values"
import {
  installedBlockDefs,
  blockDefs,
  blockValidator,
  type Block,
} from "@/convex/lib/blocks"
import { withBlockOccurrencePresentation } from "@/convex/lib/blocks/occurrencePresentation"
import { group, list, richText, text } from "@/convex/lib/blocks/primitives"

import enAdminMessages from "@/messages/admin/en.json"
import frAdminMessages from "@/messages/admin/fr.json"
import {
  applyPageField,
  capturePageField,
  pageFieldEcho,
} from "./page-editor/lib/page-inline-draft"
import {
  createLiveFrameController,
  liveFrameFieldValues,
  liveFrameMessageMatches,
  LIVE_FRAME_SOURCE,
  validLiveFrameInput,
  type LiveFrameBridge,
  type LiveFrameCallbacks,
  type LiveFrameInput,
} from "./live-preview-frame-bridge"

// Snapshot an optional descriptor without requiring it to be installed.
const installedBlockDefinition = (type: string) => readInstalledBlockDefinition(type)

const pm = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  })
const block: Block = {
  id: "hero",
  type: "hero-agency",
  enabled: true,
  primary: {
    eyebrow: "Agency",
    title:
      '{"type":"doc","content":[{"type":"heading","attrs":{"level":2},"content":[{"type":"text","text":"Agency"}]}]}',
    description: pm("First"),
  },
  items: [],
}
const input: LiveFrameInput = {
  buildId: "build-a",
  sessionId: "session-id",
  pageId: "page-id",
  locale: "en",
  pageType: "landing-page",
  defaultLocale: "en",
  languageVersion: 2,
  title: "Title",
  blocks: [block],
  selectedBlockId: null,
  inlineEditingEnabled: true,
  mode: "light",
}

function requireBlockFallback(callbacks: LiveFrameCallbacks) {
  const handler = callbacks.selectBlockFallback
  if (!handler) throw new Error("Expected the frame to provide block fallback")
  return handler
}

type BlockValidatorSnapshot = {
  members: GenericValidator[]
  originalMembers: GenericValidator[]
}

function registerSyntheticFrameBlock<
  Type,
  Fields extends Record<string, GenericValidator>,
>(validator: VObject<Type, Fields>) {
  const members: GenericValidator[] = blockValidator.members
  const originalMembers = members.slice()
  const matches = members.flatMap((member, index) => {
    if (member.kind !== "object") return []
    const type = member.fields.type
    return type?.kind === "literal" && type.value === "features-icon-grid"
      ? [index]
      : []
  })
  if (matches.length !== 1)
    throw new Error("Expected exactly one registered features-icon-grid member")
  const [index] = matches
  if (index === undefined)
    throw new Error("Expected a registered features-icon-grid member")
  members[index] = withBlockOccurrencePresentation(validator)
  return { members, originalMembers } satisfies BlockValidatorSnapshot
}

function restoreSyntheticFrameBlock(snapshot: BlockValidatorSnapshot) {
  snapshot.members.splice(
    0,
    snapshot.members.length,
    ...snapshot.originalMembers
  )
}

function expectSyntheticFrameBlockRestored(snapshot: BlockValidatorSnapshot) {
  expect(blockValidator.members).toBe(snapshot.members)
  expect(blockValidator.members).toHaveLength(snapshot.originalMembers.length)
  snapshot.originalMembers.forEach((member, index) => {
    expect(blockValidator.members[index]).toBe(member)
  })
}

it.each(["centered\n", "centered\r", "centered\u2028", "centered\u2029"])(
  "refuses malformed presentation metadata before a frame accepts input %j", blockProfile([]),
  (presentationIdV1) => {
    expect(
      validLiveFrameInput({
        ...input,
        blocks: [{ ...block, presentationIdV1 }],
      })
    ).toBe(false)
  }
)

it("accepts a well-formed retained choice without rewriting frame input", blockProfile([]), () => {
  const retained = {
    ...input,
    blocks: [{ ...block, presentationIdV1: "removed-choice" }],
  }
  const before = JSON.stringify(retained)
  expect(validLiveFrameInput(retained)).toBe(true)
  expect(JSON.stringify(retained)).toBe(before)
})

it.each(["page", "landing-page", "post", "author"])("accepts a %s frame input", blockProfile([]), (pageType) => {
  expect(validLiveFrameInput({ ...input, pageType })).toBe(true)
})

it.each([
  { sharedFields: null },
  { localizedFields: ["roleTitle"] },
  { authorIds: "author-1" },
  { authorIds: ["author-1", ""] },
])("refuses malformed unsaved field values %j", blockProfile([]), (extra) => {
  expect(validLiveFrameInput({ ...input, pageType: "post", ...extra })).toBe(
    false
  )
})

it("keeps only declared fields with valid values", () => {
  expect(
    liveFrameFieldValues("author", "sharedFields", {
      name: "Ada",
      socials: [{ platform: "GitHub" }],
      pageType: "post",
    })
  ).toEqual({ name: "Ada" })
  expect(liveFrameFieldValues("post", "localizedFields", undefined)).toEqual({})
})

it.each(["testimonial", "job", "", undefined])(
  "refuses a frame input of type %j",
  blockProfile([]),
  (pageType) => {
    expect(validLiveFrameInput({ ...input, pageType })).toBe(false)
  }
)

it("keeps every shown inline refusal reason available in both admin dictionaries", () => {
  // A form-only field ("unsupported") shows no notice (owner, 2026-11-21).
  const refusalCopy = (messages: {
    editor: {
      blocksPanel: {
        inlineRefusal: Record<"begin" | "capture" | "stale", string>
      }
    }
  }) => messages.editor.blocksPanel.inlineRefusal

  expect(refusalCopy(enAdminMessages)).not.toHaveProperty("unsupported")
  expect(refusalCopy(frAdminMessages)).not.toHaveProperty("unsupported")
  for (const reason of ["begin", "capture", "stale"] as const) {
    expect(refusalCopy(enAdminMessages)[reason]).toMatch(/form/i)
    expect(refusalCopy(frAdminMessages)[reason]).toMatch(/formulaire/i)
  }
})

function setup(editorBuildId = input.buildId) {
  let parent = { ...input, buildId: editorBuildId }
  const calls = {
    selectBlock: vi.fn(),
    selectBlockFallback: vi.fn(),
    selectField: vi.fn(),
    change: vi.fn(),
    conflict: vi.fn(),
    save: vi.fn(),
    context: vi.fn(),
    unavailable: vi.fn(),
    commit: vi.fn((commit) => {
      const blocks = applyPageField(
        parent.blocks,
        parent.locale,
        commit,
        parent.contentEpoch ?? 0,
        parent.catalogRevision ?? ""
      )
      if (!blocks) return false
      parent = { ...parent, blocks }
      return true
    }),
  } satisfies LiveFrameCallbacks
  const controller = createLiveFrameController(parent, calls)
  const make = (generation: string, buildId = editorBuildId) => {
    let callbacks!: LiveFrameCallbacks
    const bridge: LiveFrameBridge = {
      ...input,
      generation,
      buildId,
      connect: vi.fn((_next, cb) => {
        callbacks = cb
        return true
      }),
      replaceInput: vi.fn(() => true),
      disconnect: vi.fn(),
      capture: () => null,
      acceptCapture() {},
      isComposing: () => false,
      hasActiveSession: () => false,
    }
    return { bridge, callbacks: () => callbacks }
  }
  const first = make("child-1")
  expect(controller.connect(first.bridge)).toBe(true)
  const binding = {
    ...capturePageField(input.blocks, "en", "hero", "primary.description", 0)!,
    frameBinding: {
      sessionId: input.sessionId,
      pageId: input.pageId,
      generation: "child-1",
      buildId: editorBuildId,
      languageVersion: input.languageVersion,
    },
  }
  first.callbacks().change(binding)
  return {
    controller,
    calls,
    first,
    make,
    binding,
    parent: () => parent,
    replace(next: LiveFrameInput) {
      parent = next
      return controller.replaceInput(next)
    },
  }
}
describe("B1 serializable frame admission", () => {
  it("NEW forwards only finite field-selection activation results from the current child", blockProfile([]), () => {
    const view = setup()
    const field = { blockId: "hero", fieldPath: "primary.description" }
    view.first.callbacks().selectField(field, {
      status: "refused",
      reason: "capture",
    })
    expect(view.calls.selectField).toHaveBeenCalledExactlyOnceWith(field, {
      status: "refused",
      reason: "capture",
    })

    view.first.callbacks().selectField(field, {
      status: "refused",
      reason: "unexpected",
    } as never)
    view.first.callbacks().selectField(field, {
      status: "activated",
    })
    expect(view.calls.selectField).toHaveBeenCalledExactlyOnceWith(field, {
      status: "refused",
      reason: "capture",
    })
  })

  it("NEW forwards explicit transient Discard once without changing accepted parent content", blockProfile([]), () => {
    const view = setup()
    view.first.callbacks().commit({ ...view.binding, value: pm("accepted") })
    view.first.callbacks().change({ ...view.binding, composing: true })
    const discardActiveEdit = vi.fn()
    view.first.bridge.discardActiveEdit = discardActiveEdit
    const before = JSON.stringify(view.parent())
    view.controller.handle.discardActiveEdit?.()
    expect(discardActiveEdit).toHaveBeenCalledTimes(1)
    expect(view.controller.handle.hasActiveSession()).toBe(false)
    expect(view.controller.handle.isComposing()).toBe(false)
    expect(view.calls.change).toHaveBeenLastCalledWith(null)
    expect(JSON.stringify(view.parent())).toBe(before)
  })

  it("NEW applies each own keystroke exactly once into the parent and advances its field baseline", blockProfile([]), () => {
    const view = setup()
    const one = { ...view.binding, value: pm("one") }
    expect(view.first.callbacks().commit(one)).toBe(true)
    const two = {
      ...one,
      fieldBinding: { ...one.fieldBinding!, lastApplied: one.value },
      value: pm("two"),
    }
    expect(view.first.callbacks().commit(two)).toBe(true)
    expect(view.calls.commit).toHaveBeenCalledTimes(2)
    expect(
      (view.parent().blocks[0].primary as Record<string, unknown>).description
    ).toBe(two.value)
    expect(view.first.bridge.replaceInput).not.toHaveBeenCalled()
  })
  it("NEW B-C0 retires no unsaved draft, admits a fresh child and drops all old callbacks", blockProfile([]), () => {
    const view = setup()
    view.first.callbacks().commit({ ...view.binding, value: pm("kept") })
    const parent = JSON.stringify(view.parent())
    view.controller.retire()
    const fresh = view.make("child-2")
    expect(view.controller.connect(fresh.bridge)).toBe(true)
    expect(fresh.bridge.connect).toHaveBeenCalledWith(
      expect.objectContaining({ blocks: view.parent().blocks }),
      expect.any(Object)
    )
    view.first.callbacks().commit({ ...view.binding, value: pm("late") })
    view.first.callbacks().save()
    view.first.callbacks().selectBlock("late")
    requireBlockFallback(view.first.callbacks())("late-fallback")
    view.first.callbacks().unavailable()
    expect(JSON.stringify(view.parent())).toBe(parent)
    expect(view.calls.save).not.toHaveBeenCalled()
    expect(view.calls.selectBlock).not.toHaveBeenCalled()
    expect(view.calls.selectBlockFallback).not.toHaveBeenCalled()
  })

  it("forwards first-control fallback only from the current frame", blockProfile([]), () => {
    const view = setup()
    const selectFallback = requireBlockFallback(view.first.callbacks())
    selectFallback("hero")
    expect(view.calls.selectBlockFallback).toHaveBeenCalledExactlyOnceWith(
      "hero"
    )
    view.controller.retire()
    selectFallback("stale-hero")
    expect(view.calls.selectBlockFallback).toHaveBeenCalledExactlyOnceWith(
      "hero"
    )
  })

  it("preserves block selection for current legacy callers without fallback callback", blockProfile([]), () => {
    const view = setup()
    const legacyCallbacks: LiveFrameCallbacks = {
      ...view.calls,
      selectBlockFallback: undefined,
    }
    view.controller.replaceCallbacks(legacyCallbacks)
    requireBlockFallback(view.first.callbacks())("legacy-hero")
    expect(view.calls.selectBlock).toHaveBeenCalledExactlyOnceWith(
      "legacy-hero"
    )
  })
  it.each([
    "sessionId",
    "pageId",
    "generation",
    "buildId",
    "languageVersion",
  ] as const)(
    "NEW refuses a stale %s intent without changing the draft", blockProfile([]),
    (key) => {
      const view = setup()
      const before = JSON.stringify(view.parent())
      const frameBinding = {
        ...view.binding.frameBinding!,
        [key]: key === "languageVersion" ? 99 : "wrong",
      }
      expect(
        view.first
          .callbacks()
          .commit({ ...view.binding, frameBinding, value: pm("bad") })
      ).toBe(false)
      expect(JSON.stringify(view.parent())).toBe(before)
    }
  )
  it.each(["old-editor/new-frame", "new-editor/old-frame"])(
    "NEW refuses build skew on %s reconnect without removing parent text", blockProfile([]),
    (direction) => {
      const editorIsOld = direction === "old-editor/new-frame"
      const view = setup(editorIsOld ? "old-build" : "new-build")
      view.first.callbacks().commit({ ...view.binding, value: pm("retained") })
      view.controller.retire()
      const skew = view.make(
        "child-skew",
        editorIsOld ? "new-build" : "old-build"
      )
      expect(view.controller.connect(skew.bridge)).toBe(false)
      expect(skew.bridge.connect).not.toHaveBeenCalled()
      expect(
        (view.parent().blocks[0].primary as Record<string, unknown>).description
      ).toBe(pm("retained"))
    }
  )
  it("NEW refuses same-field external changes and permits an unrelated value edit", blockProfile([]), () => {
    const view = setup()
    view.replace({
      ...view.parent(),
      blocks: [{ ...block, primary: { ...block.primary, eyebrow: "manual" } }],
    })
    expect(
      view.first.callbacks().commit({ ...view.binding, value: pm("inline") })
    ).toBe(true)
    const latest = {
      ...view.binding,
      fieldBinding: {
        ...view.binding.fieldBinding!,
        lastApplied: pm("inline"),
      },
    }
    view.first.callbacks().change(latest)
    view.replace({
      ...view.parent(),
      blocks: [
        {
          ...block,
          primary: { ...block.primary, description: pm("external") },
        },
      ],
    })
    expect(
      view.first.callbacks().commit({ ...latest, value: pm("outdated") })
    ).toBe(false)
    expect(
      (view.parent().blocks[0].primary as Record<string, unknown>).description
    ).toBe(pm("external"))
    expect(view.calls.conflict).toHaveBeenCalled()
    expect(view.calls.change).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: pm("outdated") })
    )
  })
  it("NEW reports composition/refuses authority changes and preserves serialized exact data", blockProfile([]), () => {
    const view = setup()
    view.first.callbacks().change({ ...view.binding, composing: true })
    expect(view.controller.handle.isComposing()).toBe(true)
    expect(
      view.controller.replaceInput({ ...view.parent(), languageVersion: 3 })
    ).toBe(false)
    view.first.callbacks().change({ ...view.binding, composing: false })
    expect(view.controller.handle.isComposing()).toBe(false)
  })
  it("NEW checks message origin, WindowProxy, identity, generation and build shape", blockProfile([]), () => {
    const frame = {} as Window
    const data = {
      ...input,
      source: LIVE_FRAME_SOURCE,
      type: "ready",
      generation: "fresh",
    }
    for (const type of ["ready", "retired", "unloading"])
      expect(
        liveFrameMessageMatches(
          { origin: "origin", source: frame, data: { ...data, type } },
          "origin",
          frame,
          input
        )
      ).toBe(true)
    for (const event of [
      { origin: "other", source: frame, data },
      { origin: "origin", source: {} as Window, data },
      { origin: "origin", source: frame, data: { ...data, generation: "" } },
      {
        origin: "origin",
        source: frame,
        data: { ...data, buildId: undefined },
      },
    ])
      expect(liveFrameMessageMatches(event, "origin", frame, input)).toBe(false)
  })
})

it("NEW P3 real frame commit refuses a changed root-items ancestor", blockProfile([]), () => {
  expect.assertions(8 + blockValidator.members.length)
  const original = blockDefs["features-icon-grid"]
  const installedOriginal = installedBlockDefinition("features-icon-grid")
  const details = list(
    group({
      title: richText({ profile: "inline" }),
      body: richText({ profile: "inline" }),
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
  const validatorSnapshot = registerSyntheticFrameBlock(def.validator)
  Reflect.set(blockDefs, "features-icon-grid", def)
  Reflect.set(installedBlockDefs, "features-icon-grid", def)
  try {
    const block = createSampleBlock("features-icon-grid")
    Reflect.set(block, "items", [
      {
        label: "parent",
        details: [
          { title: pm("target"), body: pm("body") },
          { title: pm("sibling"), body: pm("sibling body") },
        ],
      },
      {
        label: "other",
        details: [{ title: pm("other"), body: pm("other body") }],
      },
    ])
    const parent: LiveFrameInput = {
      ...input,
      blocks: [block],
      contentEpoch: 7,
    }
    expect(validLiveFrameInput(parent)).toBe(true)
    const callbacks: LiveFrameCallbacks = {
      selectBlock: vi.fn(),
      selectField: vi.fn(),
      commit: vi.fn((commit) => {
        const next = applyPageField(
          parent.blocks,
          parent.locale,
          commit,
          parent.contentEpoch ?? 0
        )
        if (!next) return false
        parent.blocks = next
        return true
      }),
      change: vi.fn(),
      conflict: vi.fn(),
      save: vi.fn(),
      unavailable: vi.fn(),
      context: vi.fn(),
    }
    const controller = createLiveFrameController(parent, callbacks)
    let childCallbacks!: LiveFrameCallbacks
    const bridge: LiveFrameBridge = {
      ...parent,
      generation: "nested-generation",
      connect: vi.fn((_next, nextCallbacks) => {
        childCallbacks = nextCallbacks
        return true
      }),
      replaceInput: vi.fn(() => true),
      disconnect: vi.fn(),
      capture: () => null,
      acceptCapture() {},
      isComposing: () => false,
      hasActiveSession: () => false,
    }
    expect(controller.connect(bridge)).toBe(true)
    const binding = capturePageField(
      parent.blocks,
      parent.locale,
      block.id,
      "items.0.details.0.title",
      7
    )
    if (!binding) throw new Error("Expected real nested items capture")
    const frameBinding = {
      sessionId: input.sessionId,
      pageId: input.pageId,
      generation: bridge.generation,
      buildId: input.buildId,
      languageVersion: input.languageVersion,
    }
    childCallbacks.change({ ...binding, frameBinding })
    const parentBlock = parent.blocks[0]
    if (!parentBlock || parentBlock.type !== "features-icon-grid") {
      throw new Error("Expected the features icon grid parent block")
    }
    const changed = structuredClone(parentBlock)
    const changedItems = structuredClone(parentBlock.items)
    Reflect.set(changedItems[0], "label", "parent changed")
    Reflect.set(changed, "items", changedItems)
    parent.blocks[0] = changed
    expect(
      childCallbacks.commit({
        ...binding,
        frameBinding,
        value: pm("bridge edit"),
      })
    ).toBe(false)
    expect(callbacks.commit).not.toHaveBeenCalled()
    expect(callbacks.conflict).toHaveBeenCalledOnce()
    const refusedBlock = parent.blocks[0]
    if (!refusedBlock || refusedBlock.type !== "features-icon-grid") {
      throw new Error("Expected the refused features icon grid parent block")
    }
    expect(JSON.stringify(refusedBlock.items)).toContain(
      '"label":"parent changed"'
    )
  } finally {
    restoreSyntheticFrameBlock(validatorSnapshot)
    Reflect.set(blockDefs, "features-icon-grid", original)
    Reflect.set(installedBlockDefs, "features-icon-grid", installedOriginal)
    expectSyntheticFrameBlockRestored(validatorSnapshot)
  }
})

function withPrimaryRepeatedField(
  depth: 1 | 2,
  run: (block: Block, fieldPath: string) => void
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
  const cards =
    depth === 1
      ? list(
          group({
            title: richText({ profile: "inline" }),
            body: richText({ profile: "inline" }),
          }),
          { max: 2 }
        )
      : list(group({ label: text(), details }), { max: 2 })
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
  const validatorSnapshot = registerSyntheticFrameBlock(def.validator)
  Reflect.set(blockDefs, "features-icon-grid", def)
  Reflect.set(installedBlockDefs, "features-icon-grid", def)
  try {
    const block = createSampleBlock("features-icon-grid")
    const fieldPath =
      depth === 1 ? "primary.cards.0.title" : "primary.cards.0.details.0.copy"
    if (depth === 1) {
      Reflect.set(block.primary, "cards", [
        { title: pm("primary target"), body: pm("primary body") },
        { title: pm("primary sibling"), body: pm("primary sibling body") },
      ])
    } else {
      Reflect.set(block.primary, "cards", [
        {
          label: "parent",
          details: [
            { copy: pm("primary target"), title: pm("primary title") },
            { copy: pm("primary sibling"), title: pm("primary sibling title") },
          ],
        },
        {
          label: "other",
          details: [{ copy: pm("other"), title: pm("other title") }],
        },
      ])
    }
    run(block, fieldPath)
  } finally {
    restoreSyntheticFrameBlock(validatorSnapshot)
    Reflect.set(blockDefs, "features-icon-grid", original)
    Reflect.set(installedBlockDefs, "features-icon-grid", installedOriginal)
    expectSyntheticFrameBlockRestored(validatorSnapshot)
  }
}

function frameHarness(initial: LiveFrameInput, generation: string) {
  let parent = initial
  let frameCallbacks: LiveFrameCallbacks | null = null
  let deliveredInput: LiveFrameInput | undefined
  const callbacks: LiveFrameCallbacks = {
    selectBlock: vi.fn(),
    selectField: vi.fn(),
    commit: vi.fn((commit) => {
      const next = applyPageField(
        parent.blocks,
        parent.locale,
        commit,
        parent.contentEpoch ?? 0,
        parent.catalogRevision ?? ""
      )
      if (!next) return false
      parent = { ...parent, blocks: next }
      return true
    }),
    change: vi.fn(),
    conflict: vi.fn(),
    save: vi.fn(),
    unavailable: vi.fn(),
    context: vi.fn(),
  }
  const controller = createLiveFrameController(parent, callbacks)
  const bridge: LiveFrameBridge = {
    ...parent,
    generation,
    connect: vi.fn((_next, nextCallbacks) => {
      frameCallbacks = nextCallbacks
      return true
    }),
    replaceInput: vi.fn((next) => {
      deliveredInput = next
      return true
    }),
    disconnect: vi.fn(),
    capture: () => null,
    acceptCapture() {},
    isComposing: () => false,
    hasActiveSession: () => false,
  }
  return {
    callbacks,
    controller,
    bridge,
    connect: () => controller.connect(bridge),
    frameCallbacks() {
      if (!frameCallbacks) throw new Error("Expected connected frame callbacks")
      return frameCallbacks
    },
    parent: () => parent,
    replaceParent(next: LiveFrameInput) {
      parent = next
      return controller.replaceInput(next)
    },
    deliveredInput: () => deliveredInput,
  }
}

it.each([1, 2] as const)(
  "NEW P3 primary depth-%i controller captures, echoes and accepts two commits", blockProfile([]),
  (depth) => {
    expect.assertions(17 + blockValidator.members.length)
    withPrimaryRepeatedField(depth, (block, fieldPath) => {
      const sourceBefore = JSON.stringify(block)
      let parent: LiveFrameInput = {
        ...input,
        blocks: [block],
        contentEpoch: 7,
      }
      const callbacks: LiveFrameCallbacks = {
        selectBlock: vi.fn(),
        selectField: vi.fn(),
        commit: vi.fn((commit) => {
          const next = applyPageField(
            parent.blocks,
            parent.locale,
            commit,
            parent.contentEpoch ?? 0
          )
          if (!next) return false
          parent = { ...parent, blocks: next }
          return true
        }),
        change: vi.fn(),
        conflict: vi.fn(),
        save: vi.fn(),
        unavailable: vi.fn(),
        context: vi.fn(),
      }
      const controller = createLiveFrameController(parent, callbacks)
      let childCallbacks!: LiveFrameCallbacks
      const bridge: LiveFrameBridge = {
        ...parent,
        generation: `primary-depth-${depth}`,
        connect: vi.fn((_next, nextCallbacks) => {
          childCallbacks = nextCallbacks
          return true
        }),
        replaceInput: vi.fn(() => true),
        disconnect: vi.fn(),
        capture: () => null,
        acceptCapture() {},
        isComposing: () => false,
        hasActiveSession: () => false,
      }
      expect(validLiveFrameInput(parent)).toBe(true)
      expect(controller.connect(bridge)).toBe(true)
      const captured = capturePageField(
        parent.blocks,
        parent.locale,
        block.id,
        fieldPath,
        7
      )
      expect(captured).not.toBeNull()
      if (!captured) throw new Error("Expected a real primary capture")
      expect(captured.repeatedTarget?.ancestors ?? []).toHaveLength(
        depth === 2 ? 1 : 0
      )
      const frameBinding = {
        sessionId: input.sessionId,
        pageId: input.pageId,
        generation: bridge.generation,
        buildId: input.buildId,
        languageVersion: input.languageVersion,
      }
      const sessionCommit = {
        ...captured,
        inlineSessionId: `primary-session-${depth}`,
        frameBinding,
      }
      childCallbacks.change(sessionCommit)
      expect(callbacks.change).toHaveBeenCalledOnce()
      const first = { ...sessionCommit, value: pm("first primary commit") }
      expect(childCallbacks.commit(first)).toBe(true)
      const receipt = pageFieldEcho(parent.blocks)
      expect(receipt).toBeDefined()
      expect(receipt?.inlineSessionId).toBe(`primary-session-${depth}`)
      expect(receipt?.repeatedTarget).toEqual(captured.repeatedTarget)
      expect(controller.replaceInput(parent)).toBe(true)
      const active = controller.handle.capture()
      expect(active).not.toBeNull()
      if (!active) throw new Error("Expected accepted active field capture")
      expect(
        childCallbacks.commit({ ...active, value: pm("second primary commit") })
      ).toBe(true)
      expect(callbacks.commit).toHaveBeenCalledTimes(2)
      expect(JSON.stringify(parent.blocks[0].primary)).toContain(
        "second primary commit"
      )
      expect(JSON.stringify(block)).toBe(sourceBefore)
    })
  }
)

it("NEW P3 root-items controller acknowledges its own echo and accepts two commits", blockProfile([]), () => {
  expect.assertions(12)
  const block = createSampleBlock("features-icon-grid")
  const sourceBefore = JSON.stringify(block)
  let parent: LiveFrameInput = {
    ...input,
    blocks: [block],
    contentEpoch: 7,
  }
  const callbacks: LiveFrameCallbacks = {
    selectBlock: vi.fn(),
    selectField: vi.fn(),
    commit: vi.fn((commit) => {
      const next = applyPageField(
        parent.blocks,
        parent.locale,
        commit,
        parent.contentEpoch ?? 0
      )
      if (!next) return false
      parent = { ...parent, blocks: next }
      return true
    }),
    change: vi.fn(),
    conflict: vi.fn(),
    save: vi.fn(),
    unavailable: vi.fn(),
    context: vi.fn(),
  }
  const controller = createLiveFrameController(parent, callbacks)
  let childCallbacks!: LiveFrameCallbacks
  const bridge: LiveFrameBridge = {
    ...parent,
    generation: "own-echo-generation",
    connect: vi.fn((_next, nextCallbacks) => {
      childCallbacks = nextCallbacks
      return true
    }),
    replaceInput: vi.fn(() => true),
    disconnect: vi.fn(),
    capture: () => null,
    acceptCapture() {},
    isComposing: () => false,
    hasActiveSession: () => false,
  }
  expect(controller.connect(bridge)).toBe(true)
  const binding = capturePageField(
    parent.blocks,
    parent.locale,
    block.id,
    "items.0.body",
    7
  )
  expect(binding).not.toBeNull()
  if (!binding) throw new Error("Expected a real root-items capture")
  const frameBinding = {
    sessionId: input.sessionId,
    pageId: input.pageId,
    generation: bridge.generation,
    buildId: input.buildId,
    languageVersion: input.languageVersion,
  }
  const sessionCommit = {
    ...binding,
    inlineSessionId: "root-items-session",
    frameBinding,
  }
  childCallbacks.change(sessionCommit)
  expect(callbacks.change).toHaveBeenCalledOnce()
  const first = { ...sessionCommit, value: pm("first own commit") }
  expect(childCallbacks.commit(first)).toBe(true)
  const receipt = pageFieldEcho(parent.blocks)
  expect(receipt).toBeDefined()
  expect(receipt?.inlineSessionId).toBe("root-items-session")
  expect(controller.replaceInput(parent)).toBe(true)
  const active = controller.handle.capture()
  expect(active).not.toBeNull()
  if (!active) throw new Error("Expected the acknowledged active capture")
  const second = { ...active, value: pm("second own commit") }
  expect(childCallbacks.commit(second)).toBe(true)
  expect(callbacks.commit).toHaveBeenCalledTimes(2)
  const updated = parent.blocks[0]
  if (!updated || updated.type !== "features-icon-grid") {
    throw new Error("Expected the updated features icon grid")
  }
  expect(JSON.stringify(updated.items)).toContain("second own commit")
  expect(JSON.stringify(block)).toBe(sourceBefore)
})

it.each([
  "missing target",
  "borrowed target",
  "missing ancestry",
  "stale epoch",
] as const)(
  "NEW P3 active primary session refuses an incoming %s identity", blockProfile([]),
  (kind) => {
    expect.assertions(11 + blockValidator.members.length)
    withPrimaryRepeatedField(2, (block, fieldPath) => {
      const sourceBefore = JSON.stringify(block)
      const initial: LiveFrameInput = {
        ...input,
        blocks: [block],
        contentEpoch: 7,
        catalogRevision: "catalog-a",
      }
      const view = frameHarness(initial, `active-${kind}`)
      expect(validLiveFrameInput(initial)).toBe(true)
      expect(view.connect()).toBe(true)
      const binding = capturePageField(
        initial.blocks,
        initial.locale,
        block.id,
        fieldPath,
        7,
        "catalog-a"
      )
      const borrowed = capturePageField(
        initial.blocks,
        initial.locale,
        block.id,
        "primary.cards.1.details.0.copy",
        7,
        "catalog-a"
      )
      if (!binding?.repeatedTarget || !borrowed?.repeatedTarget)
        throw new Error("Expected real nested primary captures")
      const frameBinding = {
        sessionId: initial.sessionId,
        pageId: initial.pageId,
        generation: view.bridge.generation,
        buildId: initial.buildId,
        languageVersion: initial.languageVersion,
      }
      const active = {
        ...binding,
        inlineSessionId: `active-${kind}-session`,
        frameBinding,
      }
      view.frameCallbacks().change(active)
      expect(view.callbacks.change).toHaveBeenCalledOnce()
      const bad = { ...active }
      if (kind === "missing target") delete bad.repeatedTarget
      if (kind === "borrowed target")
        bad.repeatedTarget = borrowed.repeatedTarget
      if (kind === "missing ancestry") {
        bad.repeatedTarget = { ...binding.repeatedTarget }
        delete bad.repeatedTarget.ancestors
      }
      if (kind === "stale epoch")
        bad.repeatedTarget = {
          ...binding.repeatedTarget,
          contentEpoch: binding.repeatedTarget.contentEpoch + 1,
        }
      view.frameCallbacks().change(bad)
      expect(view.callbacks.change).toHaveBeenCalledTimes(2)
      const before = JSON.stringify(view.parent())
      expect(
        view
          .frameCallbacks()
          .commit({ ...bad, value: pm("refused active edit") })
      ).toBe(false)
      expect(view.callbacks.commit).not.toHaveBeenCalled()
      expect(view.callbacks.conflict).toHaveBeenCalledOnce()
      expect(JSON.stringify(view.parent())).toBe(before)
      expect(JSON.stringify(block)).toBe(sourceBefore)
    })
  }
)

it.each(["locale", "frame", "catalog"] as const)(
  "NEW P3 active primary session refuses a wrong %s update", blockProfile([]),
  (kind) => {
    expect.assertions(11 + blockValidator.members.length)
    withPrimaryRepeatedField(2, (block, fieldPath) => {
      const sourceBefore = JSON.stringify(block)
      const initial: LiveFrameInput = {
        ...input,
        blocks: [block],
        contentEpoch: 7,
        catalogRevision: "catalog-a",
      }
      const view = frameHarness(initial, `wrong-${kind}`)
      expect(validLiveFrameInput(initial)).toBe(true)
      expect(view.connect()).toBe(true)
      const binding = capturePageField(
        initial.blocks,
        initial.locale,
        block.id,
        fieldPath,
        7,
        "catalog-a"
      )
      if (!binding) throw new Error("Expected a real nested primary capture")
      const active = {
        ...binding,
        inlineSessionId: `wrong-${kind}-session`,
        frameBinding: {
          sessionId: initial.sessionId,
          pageId: initial.pageId,
          generation: view.bridge.generation,
          buildId: initial.buildId,
          languageVersion: initial.languageVersion,
        },
      }
      view.frameCallbacks().change(active)
      expect(view.callbacks.change).toHaveBeenCalledOnce()
      const invalid = {
        ...active,
        ...(kind === "locale" ? { locale: "fr" as const } : {}),
        ...(kind === "frame"
          ? {
              frameBinding: {
                ...active.frameBinding,
                generation: "foreign-generation",
              },
            }
          : {}),
      }
      if (kind === "catalog") {
        expect(
          view.replaceParent({
            ...view.parent(),
            catalogRevision: "catalog-b",
          })
        ).toBe(true)
      } else {
        view.frameCallbacks().change(invalid)
        expect(view.callbacks.change).toHaveBeenCalledOnce()
      }
      const before = JSON.stringify(view.parent())
      expect(
        view.frameCallbacks().commit({
          ...invalid,
          value: pm("wrong authority edit"),
        })
      ).toBe(false)
      expect(view.callbacks.commit).not.toHaveBeenCalled()
      if (kind === "catalog")
        expect(view.callbacks.conflict).toHaveBeenCalledOnce()
      else expect(view.callbacks.conflict).not.toHaveBeenCalled()
      expect(JSON.stringify(view.parent())).toBe(before)
      expect(JSON.stringify(block)).toBe(sourceBefore)
    })
  }
)

it("NEW P3 primary own echo with changed ancestor refuses the next frame commit", blockProfile([]), () => {
  expect.assertions(12 + blockValidator.members.length)
  withPrimaryRepeatedField(2, (block, fieldPath) => {
    const sourceBefore = JSON.stringify(block)
    const initial: LiveFrameInput = {
      ...input,
      blocks: [block],
      contentEpoch: 7,
      catalogRevision: "catalog-a",
    }
    const view = frameHarness(initial, "primary-echo-ancestor")
    expect(validLiveFrameInput(initial)).toBe(true)
    expect(view.connect()).toBe(true)
    const binding = capturePageField(
      initial.blocks,
      initial.locale,
      block.id,
      fieldPath,
      7,
      "catalog-a"
    )
    if (!binding) throw new Error("Expected a real nested primary capture")
    const active = {
      ...binding,
      inlineSessionId: "primary-echo-session",
      frameBinding: {
        sessionId: initial.sessionId,
        pageId: initial.pageId,
        generation: view.bridge.generation,
        buildId: initial.buildId,
        languageVersion: initial.languageVersion,
      },
    }
    view.frameCallbacks().change(active)
    expect(
      view.frameCallbacks().commit({ ...active, value: pm("first") })
    ).toBe(true)
    const receipt = pageFieldEcho(view.parent().blocks)
    expect(receipt).toMatchObject({
      inlineSessionId: "primary-echo-session",
      repeatedTarget: binding.repeatedTarget,
    })
    const acknowledged = structuredClone(view.parent())
    const cards = Reflect.get(acknowledged.blocks[0]!.primary, "cards")
    if (!Array.isArray(cards)) throw new Error("Expected primary cards")
    Reflect.set(cards[0], "label", "external ancestor change")
    Reflect.set(acknowledged.blocks[0]!.primary, "cards", cards)
    expect(view.replaceParent(acknowledged)).toBe(true)
    const beforeRefusal = JSON.stringify(view.parent())
    const activeAfterReplace = view.controller.handle.capture()
    if (!activeAfterReplace)
      throw new Error("Expected the active primary capture after replace")
    expect(
      view.frameCallbacks().commit({
        ...activeAfterReplace,
        value: pm("must refuse after ancestor change"),
      })
    ).toBe(false)
    expect(view.callbacks.commit).toHaveBeenCalledOnce()
    expect(view.callbacks.conflict).toHaveBeenCalledOnce()
    expect(JSON.stringify(view.parent())).toBe(beforeRefusal)
    expect(JSON.stringify(block)).toBe(sourceBefore)
  })
})

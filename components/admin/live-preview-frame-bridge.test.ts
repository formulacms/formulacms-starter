import { readInstalledSliceDefinition } from "@/convex/lib/slices"
import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, it, vi } from "vitest"
import { v, type GenericValidator, type VObject } from "convex/values"
import {
  installedSliceDefs,
  sliceDefs,
  sliceValidator,
  type Slice,
} from "@/convex/lib/slices"
import { withSliceOccurrencePresentation } from "@/convex/lib/slices/occurrencePresentation"
import { group, list, richText, text } from "@/convex/lib/slices/primitives"

import enAdminMessages from "@/messages/admin/en.json"
import frAdminMessages from "@/messages/admin/fr.json"
import {
  applyPageField,
  capturePageField,
  pageFieldEcho,
} from "./page-editor/lib/page-inline-draft"
import {
  createLiveFrameController,
  liveFrameMessageMatches,
  LIVE_FRAME_SOURCE,
  validLiveFrameInput,
  type LiveFrameBridge,
  type LiveFrameCallbacks,
  type LiveFrameInput,
} from "./live-preview-frame-bridge"

// Snapshot an optional descriptor without requiring it to be installed.
const installedSliceDefinition = (type: string) => readInstalledSliceDefinition(type)

const pm = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [{ type: "paragraph", content: [{ type: "text", text }] }],
  })
const slice: Slice = {
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
  slices: [slice],
  selectedSliceId: null,
  inlineEditingEnabled: true,
  mode: "light",
}

function requireSliceFallback(callbacks: LiveFrameCallbacks) {
  const handler = callbacks.selectSliceFallback
  if (!handler) throw new Error("Expected the frame to provide slice fallback")
  return handler
}

type SliceValidatorSnapshot = {
  members: GenericValidator[]
  originalMembers: GenericValidator[]
}

function registerSyntheticFrameSlice<
  Type,
  Fields extends Record<string, GenericValidator>,
>(validator: VObject<Type, Fields>) {
  const members: GenericValidator[] = sliceValidator.members
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
  members[index] = withSliceOccurrencePresentation(validator)
  return { members, originalMembers } satisfies SliceValidatorSnapshot
}

function restoreSyntheticFrameSlice(snapshot: SliceValidatorSnapshot) {
  snapshot.members.splice(
    0,
    snapshot.members.length,
    ...snapshot.originalMembers
  )
}

function expectSyntheticFrameSliceRestored(snapshot: SliceValidatorSnapshot) {
  expect(sliceValidator.members).toBe(snapshot.members)
  expect(sliceValidator.members).toHaveLength(snapshot.originalMembers.length)
  snapshot.originalMembers.forEach((member, index) => {
    expect(sliceValidator.members[index]).toBe(member)
  })
}

it.each(["centered\n", "centered\r", "centered\u2028", "centered\u2029"])(
  "refuses malformed presentation metadata before a frame accepts input %j", sliceProfile([]),
  (presentationIdV1) => {
    expect(
      validLiveFrameInput({
        ...input,
        slices: [{ ...slice, presentationIdV1 }],
      })
    ).toBe(false)
  }
)

it("accepts a well-formed retained choice without rewriting frame input", sliceProfile([]), () => {
  const retained = {
    ...input,
    slices: [{ ...slice, presentationIdV1: "removed-choice" }],
  }
  const before = JSON.stringify(retained)
  expect(validLiveFrameInput(retained)).toBe(true)
  expect(JSON.stringify(retained)).toBe(before)
})

it.each(["page", "landing-page"])("accepts a %s frame input", sliceProfile([]), (pageType) => {
  expect(validLiveFrameInput({ ...input, pageType })).toBe(true)
})

it.each(["post", "author", "testimonial", "", undefined])(
  "refuses a frame input of type %j",
  sliceProfile([]),
  (pageType) => {
    expect(validLiveFrameInput({ ...input, pageType })).toBe(false)
  }
)

it("keeps every inline refusal reason available in both admin dictionaries", () => {
  const refusalCopy = (messages: {
    editor: {
      slicesPanel: {
        inlineRefusal: Record<
          "unsupported" | "begin" | "capture" | "stale",
          string
        >
      }
    }
  }) => messages.editor.slicesPanel.inlineRefusal

  for (const reason of ["unsupported", "begin", "capture", "stale"] as const) {
    expect(refusalCopy(enAdminMessages)[reason]).toMatch(/form/i)
    expect(refusalCopy(frAdminMessages)[reason]).toMatch(/formulaire/i)
  }
})

function setup(editorBuildId = input.buildId) {
  let parent = { ...input, buildId: editorBuildId }
  const calls = {
    selectSlice: vi.fn(),
    selectSliceFallback: vi.fn(),
    selectField: vi.fn(),
    change: vi.fn(),
    conflict: vi.fn(),
    save: vi.fn(),
    context: vi.fn(),
    unavailable: vi.fn(),
    commit: vi.fn((commit) => {
      const slices = applyPageField(
        parent.slices,
        parent.locale,
        commit,
        parent.contentEpoch ?? 0,
        parent.catalogRevision ?? ""
      )
      if (!slices) return false
      parent = { ...parent, slices }
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
    ...capturePageField(input.slices, "en", "hero", "primary.description", 0)!,
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
  it("NEW forwards only finite field-selection activation results from the current child", sliceProfile([]), () => {
    const view = setup()
    const field = { sliceId: "hero", fieldPath: "primary.description" }
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

  it("NEW forwards explicit transient Discard once without changing accepted parent content", sliceProfile([]), () => {
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

  it("NEW applies each own keystroke exactly once into the parent and advances its field baseline", sliceProfile([]), () => {
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
      (view.parent().slices[0].primary as Record<string, unknown>).description
    ).toBe(two.value)
    expect(view.first.bridge.replaceInput).not.toHaveBeenCalled()
  })
  it("NEW B-C0 retires no unsaved draft, admits a fresh child and drops all old callbacks", sliceProfile([]), () => {
    const view = setup()
    view.first.callbacks().commit({ ...view.binding, value: pm("kept") })
    const parent = JSON.stringify(view.parent())
    view.controller.retire()
    const fresh = view.make("child-2")
    expect(view.controller.connect(fresh.bridge)).toBe(true)
    expect(fresh.bridge.connect).toHaveBeenCalledWith(
      expect.objectContaining({ slices: view.parent().slices }),
      expect.any(Object)
    )
    view.first.callbacks().commit({ ...view.binding, value: pm("late") })
    view.first.callbacks().save()
    view.first.callbacks().selectSlice("late")
    requireSliceFallback(view.first.callbacks())("late-fallback")
    view.first.callbacks().unavailable()
    expect(JSON.stringify(view.parent())).toBe(parent)
    expect(view.calls.save).not.toHaveBeenCalled()
    expect(view.calls.selectSlice).not.toHaveBeenCalled()
    expect(view.calls.selectSliceFallback).not.toHaveBeenCalled()
  })

  it("forwards first-control fallback only from the current frame", sliceProfile([]), () => {
    const view = setup()
    const selectFallback = requireSliceFallback(view.first.callbacks())
    selectFallback("hero")
    expect(view.calls.selectSliceFallback).toHaveBeenCalledExactlyOnceWith(
      "hero"
    )
    view.controller.retire()
    selectFallback("stale-hero")
    expect(view.calls.selectSliceFallback).toHaveBeenCalledExactlyOnceWith(
      "hero"
    )
  })

  it("preserves slice selection for current legacy callers without fallback callback", sliceProfile([]), () => {
    const view = setup()
    const legacyCallbacks: LiveFrameCallbacks = {
      ...view.calls,
      selectSliceFallback: undefined,
    }
    view.controller.replaceCallbacks(legacyCallbacks)
    requireSliceFallback(view.first.callbacks())("legacy-hero")
    expect(view.calls.selectSlice).toHaveBeenCalledExactlyOnceWith(
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
    "NEW refuses a stale %s intent without changing the draft", sliceProfile([]),
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
    "NEW refuses build skew on %s reconnect without removing parent text", sliceProfile([]),
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
        (view.parent().slices[0].primary as Record<string, unknown>).description
      ).toBe(pm("retained"))
    }
  )
  it("NEW refuses same-field external changes and permits an unrelated value edit", sliceProfile([]), () => {
    const view = setup()
    view.replace({
      ...view.parent(),
      slices: [{ ...slice, primary: { ...slice.primary, eyebrow: "manual" } }],
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
      slices: [
        {
          ...slice,
          primary: { ...slice.primary, description: pm("external") },
        },
      ],
    })
    expect(
      view.first.callbacks().commit({ ...latest, value: pm("outdated") })
    ).toBe(false)
    expect(
      (view.parent().slices[0].primary as Record<string, unknown>).description
    ).toBe(pm("external"))
    expect(view.calls.conflict).toHaveBeenCalled()
    expect(view.calls.change).toHaveBeenLastCalledWith(
      expect.objectContaining({ value: pm("outdated") })
    )
  })
  it("NEW reports composition/refuses authority changes and preserves serialized exact data", sliceProfile([]), () => {
    const view = setup()
    view.first.callbacks().change({ ...view.binding, composing: true })
    expect(view.controller.handle.isComposing()).toBe(true)
    expect(
      view.controller.replaceInput({ ...view.parent(), languageVersion: 3 })
    ).toBe(false)
    view.first.callbacks().change({ ...view.binding, composing: false })
    expect(view.controller.handle.isComposing()).toBe(false)
  })
  it("NEW checks message origin, WindowProxy, identity, generation and build shape", sliceProfile([]), () => {
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

it("NEW P3 real frame commit refuses a changed root-items ancestor", sliceProfile([]), () => {
  expect.assertions(8 + sliceValidator.members.length)
  const original = sliceDefs["features-icon-grid"]
  const installedOriginal = installedSliceDefinition("features-icon-grid")
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
  const validatorSnapshot = registerSyntheticFrameSlice(def.validator)
  Reflect.set(sliceDefs, "features-icon-grid", def)
  Reflect.set(installedSliceDefs, "features-icon-grid", def)
  try {
    const slice = createSampleSlice("features-icon-grid")
    Reflect.set(slice, "items", [
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
      slices: [slice],
      contentEpoch: 7,
    }
    expect(validLiveFrameInput(parent)).toBe(true)
    const callbacks: LiveFrameCallbacks = {
      selectSlice: vi.fn(),
      selectField: vi.fn(),
      commit: vi.fn((commit) => {
        const next = applyPageField(
          parent.slices,
          parent.locale,
          commit,
          parent.contentEpoch ?? 0
        )
        if (!next) return false
        parent.slices = next
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
      parent.slices,
      parent.locale,
      slice.id,
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
    const parentSlice = parent.slices[0]
    if (!parentSlice || parentSlice.type !== "features-icon-grid") {
      throw new Error("Expected the features icon grid parent slice")
    }
    const changed = structuredClone(parentSlice)
    const changedItems = structuredClone(parentSlice.items)
    Reflect.set(changedItems[0], "label", "parent changed")
    Reflect.set(changed, "items", changedItems)
    parent.slices[0] = changed
    expect(
      childCallbacks.commit({
        ...binding,
        frameBinding,
        value: pm("bridge edit"),
      })
    ).toBe(false)
    expect(callbacks.commit).not.toHaveBeenCalled()
    expect(callbacks.conflict).toHaveBeenCalledOnce()
    const refusedSlice = parent.slices[0]
    if (!refusedSlice || refusedSlice.type !== "features-icon-grid") {
      throw new Error("Expected the refused features icon grid parent slice")
    }
    expect(JSON.stringify(refusedSlice.items)).toContain(
      '"label":"parent changed"'
    )
  } finally {
    restoreSyntheticFrameSlice(validatorSnapshot)
    Reflect.set(sliceDefs, "features-icon-grid", original)
    Reflect.set(installedSliceDefs, "features-icon-grid", installedOriginal)
    expectSyntheticFrameSliceRestored(validatorSnapshot)
  }
})

function withPrimaryRepeatedField(
  depth: 1 | 2,
  run: (slice: Slice, fieldPath: string) => void
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
  const validatorSnapshot = registerSyntheticFrameSlice(def.validator)
  Reflect.set(sliceDefs, "features-icon-grid", def)
  Reflect.set(installedSliceDefs, "features-icon-grid", def)
  try {
    const slice = createSampleSlice("features-icon-grid")
    const fieldPath =
      depth === 1 ? "primary.cards.0.title" : "primary.cards.0.details.0.copy"
    if (depth === 1) {
      Reflect.set(slice.primary, "cards", [
        { title: pm("primary target"), body: pm("primary body") },
        { title: pm("primary sibling"), body: pm("primary sibling body") },
      ])
    } else {
      Reflect.set(slice.primary, "cards", [
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
    run(slice, fieldPath)
  } finally {
    restoreSyntheticFrameSlice(validatorSnapshot)
    Reflect.set(sliceDefs, "features-icon-grid", original)
    Reflect.set(installedSliceDefs, "features-icon-grid", installedOriginal)
    expectSyntheticFrameSliceRestored(validatorSnapshot)
  }
}

function frameHarness(initial: LiveFrameInput, generation: string) {
  let parent = initial
  let frameCallbacks: LiveFrameCallbacks | null = null
  let deliveredInput: LiveFrameInput | undefined
  const callbacks: LiveFrameCallbacks = {
    selectSlice: vi.fn(),
    selectField: vi.fn(),
    commit: vi.fn((commit) => {
      const next = applyPageField(
        parent.slices,
        parent.locale,
        commit,
        parent.contentEpoch ?? 0,
        parent.catalogRevision ?? ""
      )
      if (!next) return false
      parent = { ...parent, slices: next }
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
  "NEW P3 primary depth-%i controller captures, echoes and accepts two commits", sliceProfile([]),
  (depth) => {
    expect.assertions(17 + sliceValidator.members.length)
    withPrimaryRepeatedField(depth, (slice, fieldPath) => {
      const sourceBefore = JSON.stringify(slice)
      let parent: LiveFrameInput = {
        ...input,
        slices: [slice],
        contentEpoch: 7,
      }
      const callbacks: LiveFrameCallbacks = {
        selectSlice: vi.fn(),
        selectField: vi.fn(),
        commit: vi.fn((commit) => {
          const next = applyPageField(
            parent.slices,
            parent.locale,
            commit,
            parent.contentEpoch ?? 0
          )
          if (!next) return false
          parent = { ...parent, slices: next }
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
        parent.slices,
        parent.locale,
        slice.id,
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
      const receipt = pageFieldEcho(parent.slices)
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
      expect(JSON.stringify(parent.slices[0].primary)).toContain(
        "second primary commit"
      )
      expect(JSON.stringify(slice)).toBe(sourceBefore)
    })
  }
)

it("NEW P3 root-items controller acknowledges its own echo and accepts two commits", sliceProfile([]), () => {
  expect.assertions(12)
  const slice = createSampleSlice("features-icon-grid")
  const sourceBefore = JSON.stringify(slice)
  let parent: LiveFrameInput = {
    ...input,
    slices: [slice],
    contentEpoch: 7,
  }
  const callbacks: LiveFrameCallbacks = {
    selectSlice: vi.fn(),
    selectField: vi.fn(),
    commit: vi.fn((commit) => {
      const next = applyPageField(
        parent.slices,
        parent.locale,
        commit,
        parent.contentEpoch ?? 0
      )
      if (!next) return false
      parent = { ...parent, slices: next }
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
    parent.slices,
    parent.locale,
    slice.id,
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
  const receipt = pageFieldEcho(parent.slices)
  expect(receipt).toBeDefined()
  expect(receipt?.inlineSessionId).toBe("root-items-session")
  expect(controller.replaceInput(parent)).toBe(true)
  const active = controller.handle.capture()
  expect(active).not.toBeNull()
  if (!active) throw new Error("Expected the acknowledged active capture")
  const second = { ...active, value: pm("second own commit") }
  expect(childCallbacks.commit(second)).toBe(true)
  expect(callbacks.commit).toHaveBeenCalledTimes(2)
  const updated = parent.slices[0]
  if (!updated || updated.type !== "features-icon-grid") {
    throw new Error("Expected the updated features icon grid")
  }
  expect(JSON.stringify(updated.items)).toContain("second own commit")
  expect(JSON.stringify(slice)).toBe(sourceBefore)
})

it.each([
  "missing target",
  "borrowed target",
  "missing ancestry",
  "stale epoch",
] as const)(
  "NEW P3 active primary session refuses an incoming %s identity", sliceProfile([]),
  (kind) => {
    expect.assertions(11 + sliceValidator.members.length)
    withPrimaryRepeatedField(2, (slice, fieldPath) => {
      const sourceBefore = JSON.stringify(slice)
      const initial: LiveFrameInput = {
        ...input,
        slices: [slice],
        contentEpoch: 7,
        catalogRevision: "catalog-a",
      }
      const view = frameHarness(initial, `active-${kind}`)
      expect(validLiveFrameInput(initial)).toBe(true)
      expect(view.connect()).toBe(true)
      const binding = capturePageField(
        initial.slices,
        initial.locale,
        slice.id,
        fieldPath,
        7,
        "catalog-a"
      )
      const borrowed = capturePageField(
        initial.slices,
        initial.locale,
        slice.id,
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
      expect(JSON.stringify(slice)).toBe(sourceBefore)
    })
  }
)

it.each(["locale", "frame", "catalog"] as const)(
  "NEW P3 active primary session refuses a wrong %s update", sliceProfile([]),
  (kind) => {
    expect.assertions(11 + sliceValidator.members.length)
    withPrimaryRepeatedField(2, (slice, fieldPath) => {
      const sourceBefore = JSON.stringify(slice)
      const initial: LiveFrameInput = {
        ...input,
        slices: [slice],
        contentEpoch: 7,
        catalogRevision: "catalog-a",
      }
      const view = frameHarness(initial, `wrong-${kind}`)
      expect(validLiveFrameInput(initial)).toBe(true)
      expect(view.connect()).toBe(true)
      const binding = capturePageField(
        initial.slices,
        initial.locale,
        slice.id,
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
      expect(JSON.stringify(slice)).toBe(sourceBefore)
    })
  }
)

it("NEW P3 primary own echo with changed ancestor refuses the next frame commit", sliceProfile([]), () => {
  expect.assertions(12 + sliceValidator.members.length)
  withPrimaryRepeatedField(2, (slice, fieldPath) => {
    const sourceBefore = JSON.stringify(slice)
    const initial: LiveFrameInput = {
      ...input,
      slices: [slice],
      contentEpoch: 7,
      catalogRevision: "catalog-a",
    }
    const view = frameHarness(initial, "primary-echo-ancestor")
    expect(validLiveFrameInput(initial)).toBe(true)
    expect(view.connect()).toBe(true)
    const binding = capturePageField(
      initial.slices,
      initial.locale,
      slice.id,
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
    const receipt = pageFieldEcho(view.parent().slices)
    expect(receipt).toMatchObject({
      inlineSessionId: "primary-echo-session",
      repeatedTarget: binding.repeatedTarget,
    })
    const acknowledged = structuredClone(view.parent())
    const cards = Reflect.get(acknowledged.slices[0]!.primary, "cards")
    if (!Array.isArray(cards)) throw new Error("Expected primary cards")
    Reflect.set(cards[0], "label", "external ancestor change")
    Reflect.set(acknowledged.slices[0]!.primary, "cards", cards)
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
    expect(JSON.stringify(slice)).toBe(sourceBefore)
  })
})

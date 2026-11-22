import { blockProfile } from "@/test-utils/block-profile"
import { beforeAll, describe, expect, test } from "vitest"
import {
  decideBlockPresentationMutation,
  hasExplicitBlockPresentations,
} from "./presentationMutations"
import {
  readBlockPresentationCatalog,
  type BlockPresentationCatalog,
  type BlockPresentationEntry,
} from "./presentations"

let catalog: BlockPresentationCatalog
beforeAll(async () => {
  catalog = await readBlockPresentationCatalog()
})

function block(
  presentationIdV1?: unknown,
  id = "hero-1",
  type = "hero-with-image"
) {
  return {
    id,
    type,
    enabled: true,
    primary: { title: "Editable content" },
    ...(presentationIdV1 === undefined ? {} : { presentationIdV1 }),
  }
}
function content(value = block(), locale = "en") {
  return { [locale]: { title: "Page", blocks: [value] } }
}
function centered(changes: Partial<BlockPresentationEntry>) {
  return {
    ...catalog,
    entries: catalog.entries.map((entry) =>
      entry.type === "hero-with-image" && entry.id === "centered"
        ? { ...entry, ...changes }
        : entry
    ),
  } as BlockPresentationCatalog
}

describe("whole-content presentation mutation decisions", () => {
  test("keeps legacy absence absent without modifying either bag", blockProfile(["hero-with-image"]), () => {
    const existingContent = content()
    const incoming = content({ ...block(), primary: { title: "Changed" } })
    const original = JSON.stringify([existingContent, incoming])
    expect(
      decideBlockPresentationMutation(catalog, {
        existingContent,
        content: incoming,
      })
    ).toMatchObject({
      status: "allowed",
      occurrences: [
        {
          intent: "existing",
          resolution: { requestedId: null, legacyDefault: true },
        },
      ],
    })
    expect(JSON.stringify([existingContent, incoming])).toBe(original)
    expect(Object.hasOwn(incoming.en.blocks[0], "presentationIdV1")).toBe(false)
    expect(hasExplicitBlockPresentations([existingContent, incoming])).toBe(
      false
    )
  })

  test.each(["default", "centered"])(
    "accepts new explicit %s only at the current source revision", blockProfile(["hero-with-image"]),
    (id) => {
      for (const expectedPresentationCatalogRevision of [undefined, "stale"]) {
        expect(
          decideBlockPresentationMutation(catalog, {
            content: content(block(id)),
            expectedPresentationCatalogRevision,
          })
        ).toMatchObject({ status: "refused", reason: "catalog-stale" })
      }
      expect(
        decideBlockPresentationMutation(catalog, {
          content: content(block(id)),
          expectedPresentationCatalogRevision: catalog.revision,
        })
      ).toMatchObject({
        status: "allowed",
        occurrences: [{ intent: "new-assignment" }],
      })
    }
  )

  test("unchanged occurrence choice remains editable and reorderable without a revision", blockProfile(["hero-with-image"]), () => {
    const first = block("centered")
    const second = block("default", "hero-2")
    expect(
      decideBlockPresentationMutation(catalog, {
        existingContent: { en: { blocks: [first, second] } },
        content: {
          en: { blocks: [second, { ...first, primary: { title: "Changed" } }] },
        },
      })
    ).toMatchObject({
      status: "allowed",
      occurrences: [{ intent: "existing" }, { intent: "existing" }],
    })
  })

  for (const profileRow of ["locale", "id", "type", "choice"]) {
    test.each([profileRow])(
      "a changed %s cannot borrow retained assignment authority", blockProfile(profileRow === "type" ? ["hero-with-image", "hero-agency"] : ["hero-with-image"]),
      (change) => {
        const incoming = block("centered")
        if (change === "id") incoming.id = "new-occurrence"
        if (change === "type") incoming.type = "hero-agency"
        if (change === "choice") incoming.presentationIdV1 = "default"
        expect(
          decideBlockPresentationMutation(catalog, {
            existingContent: content(block("centered")),
            content: content(incoming, change === "locale" ? "fr" : "en"),
          })
        ).toMatchObject({ status: "refused", reason: "catalog-stale" })
      }
    )
  }

  test("a new explicit occurrence is new even when its Type and choice exist elsewhere", blockProfile(["hero-with-image"]), () => {
    expect(
      decideBlockPresentationMutation(catalog, {
        existingContent: content(block("centered")),
        content: {
          en: { blocks: [block("centered"), block("centered", "hero-2")] },
        },
      })
    ).toMatchObject({
      status: "refused",
      path: "content.en.blocks[1]",
      reason: "catalog-stale",
    })
  })

  test("a changed choice or occurrence ID succeeds as a new assignment at the current revision", blockProfile(["hero-with-image"]), () => {
    for (const incoming of [block("default"), block("centered", "new-id")]) {
      expect(
        decideBlockPresentationMutation(catalog, {
          existingContent: content(block("centered")),
          content: content(incoming),
          expectedPresentationCatalogRevision: catalog.revision,
        })
      ).toMatchObject({
        status: "allowed",
        occurrences: [{ intent: "new-assignment" }],
      })
    }
  })

  test.each([
    {
      changes: { state: "archived" as const },
      reason: "presentation-archived",
      retainedStatus: "resolved",
    },
    {
      changes: { state: "unavailable" as const },
      reason: "presentation-unavailable",
      retainedStatus: "fallback",
    },
    {
      changes: { installed: false },
      reason: "presentation-unavailable",
      retainedStatus: "fallback",
    },
    {
      changes: { contractSha256: "old" },
      reason: "contract-incompatible",
      retainedStatus: "fallback",
    },
  ])(
    "retains $reason choices with qualified resolution but refuses new assignments", blockProfile(["hero-with-image"]),
    ({ changes, reason, retainedStatus }) => {
      const current = centered(changes)
      const retained = content(block("centered"))
      expect(
        decideBlockPresentationMutation(current, {
          existingContent: retained,
          content: retained,
        })
      ).toMatchObject({
        status: "allowed",
        occurrences: [
          {
            resolution: {
              requestedId: "centered",
              status: retainedStatus,
              newAssignable: false,
            },
          },
        ],
      })
      expect(
        decideBlockPresentationMutation(current, {
          content: retained,
          expectedPresentationCatalogRevision: current.revision,
        })
      ).toMatchObject({ status: "refused", reason })
    }
  )

  test("retained unknown IDs remain stored with explicit default fallback, but cannot be assigned anew", blockProfile(["hero-with-image"]), () => {
    const retained = content(block("old-choice"))
    expect(
      decideBlockPresentationMutation(catalog, {
        existingContent: retained,
        content: retained,
      })
    ).toMatchObject({
      status: "allowed",
      occurrences: [
        {
          resolution: {
            status: "fallback",
            requestedId: "old-choice",
            resolvedId: "default",
            reason: "presentation-missing",
          },
        },
      ],
    })
    expect(
      decideBlockPresentationMutation(catalog, {
        content: retained,
        expectedPresentationCatalogRevision: catalog.revision,
      })
    ).toMatchObject({ status: "refused", reason: "presentation-missing" })
    expect(retained.en.blocks[0].presentationIdV1).toBe("old-choice")
  })

  test.each(["centered", "old-choice"])(
    "trusted restore preserves historical %s without treating it as a new assignment", blockProfile(["hero-with-image"]),
    (id) => {
      const historical = content(block(id))
      expect(
        decideBlockPresentationMutation(centered({ state: "archived" }), {
          existingContent: content(),
          content: historical,
          operation: "restore",
        })
      ).toMatchObject({
        status: "allowed",
        occurrences: [
          { intent: "historical", resolution: { requestedId: id } },
        ],
      })
      expect(historical.en.blocks[0].presentationIdV1).toBe(id)
      expect(
        decideBlockPresentationMutation(catalog, {
          content: historical,
          operation: "historical",
        })
      ).toMatchObject({ status: "refused", reason: "catalog-stale" })
    }
  )

  test.each([
    null,
    2,
    "",
    "../default",
    "Centered",
    "default\n",
    "a".repeat(65),
  ])("rejects malformed %j in both old and incoming bags", blockProfile([]), (id) => {
    const malformed = content(block(id))
    expect(hasExplicitBlockPresentations([malformed])).toBe(true)
    expect(
      decideBlockPresentationMutation(catalog, {
        existingContent: malformed,
        content: {},
        operation: "restore",
      })
    ).toMatchObject({
      status: "refused",
      bag: "existing",
      reason: "invalid-presentation-id",
    })
    expect(
      decideBlockPresentationMutation(catalog, {
        content: malformed,
        operation: "restore",
      })
    ).toMatchObject({
      status: "refused",
      bag: "incoming",
      reason: "invalid-presentation-id",
    })
  })

  test("absent Type blocks both bags even with historical intent or legacy absence", blockProfile([]), () => {
    const absent = {
      ...catalog,
      installedTypes: catalog.installedTypes.filter(
        (type) => type !== "hero-with-image"
      ),
    }
    for (const id of [undefined, "centered"]) {
      expect(
        decideBlockPresentationMutation(absent, {
          existingContent: content(block(id)),
          content: {},
        })
      ).toMatchObject({
        status: "refused",
        bag: "existing",
        reason: "type-unavailable",
      })
      expect(
        decideBlockPresentationMutation(absent, {
          content: content(block(id)),
          operation: "restore",
        })
      ).toMatchObject({
        status: "refused",
        bag: "incoming",
        reason: "type-unavailable",
      })
    }
  })

  test("one unavailable fallback refuses the whole operation", blockProfile(["hero-with-image"]), () => {
    const unavailable = {
      ...catalog,
      entries: catalog.entries.filter(
        (entry) => !(entry.type === "hero-with-image" && entry.id === "default")
      ),
    }
    expect(
      decideBlockPresentationMutation(unavailable, {
        existingContent: content(block("old-choice")),
        content: {
          en: { blocks: [block("centered", "valid"), block("old-choice")] },
        },
        expectedPresentationCatalogRevision: catalog.revision,
      })
    ).toMatchObject({
      status: "refused",
      path: "content.en.blocks[1]",
      reason: "fallback-unavailable",
    })
  })

  test("removing explicit metadata is a default assignment requiring current revision while preserving absence", blockProfile(["hero-with-image"]), () => {
    const incoming = content()
    expect(
      decideBlockPresentationMutation(catalog, {
        existingContent: content(block("centered")),
        content: incoming,
      })
    ).toMatchObject({ status: "refused", reason: "catalog-stale" })
    expect(
      decideBlockPresentationMutation(catalog, {
        existingContent: content(block("centered")),
        content: incoming,
        expectedPresentationCatalogRevision: catalog.revision,
      })
    ).toMatchObject({
      status: "allowed",
      occurrences: [
        {
          intent: "new-assignment",
          resolution: { requestedId: null, legacyDefault: true },
        },
      ],
    })
    expect(Object.hasOwn(incoming.en.blocks[0], "presentationIdV1")).toBe(false)
  })

  test.each([
    { state: "archived" as const },
    { installed: false },
    { contractSha256: "old" },
  ])(
    "metadata omission cannot assign an ineligible default $state/$installed/$contractSha256", blockProfile([]),
    (changes) => {
      const current = {
        ...catalog,
        entries: catalog.entries.map((entry) =>
          entry.type === "hero-with-image" && entry.id === "default"
            ? { ...entry, ...changes }
            : entry
        ),
      }
      expect(
        decideBlockPresentationMutation(current, {
          existingContent: content(block("centered")),
          content: content(),
          expectedPresentationCatalogRevision: current.revision,
        }).status
      ).toBe("refused")
    }
  )
})

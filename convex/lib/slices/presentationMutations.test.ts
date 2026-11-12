import { sliceProfile } from "@/test-utils/slice-profile"
import { beforeAll, describe, expect, test } from "vitest"
import {
  decideSlicePresentationMutation,
  hasExplicitSlicePresentations,
} from "./presentationMutations"
import {
  readSlicePresentationCatalog,
  type SlicePresentationCatalog,
  type SlicePresentationEntry,
} from "./presentations"

let catalog: SlicePresentationCatalog
beforeAll(async () => {
  catalog = await readSlicePresentationCatalog()
})

function slice(
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
function content(value = slice(), locale = "en") {
  return { [locale]: { title: "Page", slices: [value] } }
}
function centered(changes: Partial<SlicePresentationEntry>) {
  return {
    ...catalog,
    entries: catalog.entries.map((entry) =>
      entry.type === "hero-with-image" && entry.id === "centered"
        ? { ...entry, ...changes }
        : entry
    ),
  } as SlicePresentationCatalog
}

describe("whole-content presentation mutation decisions", () => {
  test("keeps legacy absence absent without modifying either bag", sliceProfile(["hero-with-image"]), () => {
    const existingContent = content()
    const incoming = content({ ...slice(), primary: { title: "Changed" } })
    const original = JSON.stringify([existingContent, incoming])
    expect(
      decideSlicePresentationMutation(catalog, {
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
    expect(Object.hasOwn(incoming.en.slices[0], "presentationIdV1")).toBe(false)
    expect(hasExplicitSlicePresentations([existingContent, incoming])).toBe(
      false
    )
  })

  test.each(["default", "centered"])(
    "accepts new explicit %s only at the current source revision", sliceProfile(["hero-with-image"]),
    (id) => {
      for (const expectedPresentationCatalogRevision of [undefined, "stale"]) {
        expect(
          decideSlicePresentationMutation(catalog, {
            content: content(slice(id)),
            expectedPresentationCatalogRevision,
          })
        ).toMatchObject({ status: "refused", reason: "catalog-stale" })
      }
      expect(
        decideSlicePresentationMutation(catalog, {
          content: content(slice(id)),
          expectedPresentationCatalogRevision: catalog.revision,
        })
      ).toMatchObject({
        status: "allowed",
        occurrences: [{ intent: "new-assignment" }],
      })
    }
  )

  test("unchanged occurrence choice remains editable and reorderable without a revision", sliceProfile(["hero-with-image"]), () => {
    const first = slice("centered")
    const second = slice("default", "hero-2")
    expect(
      decideSlicePresentationMutation(catalog, {
        existingContent: { en: { slices: [first, second] } },
        content: {
          en: { slices: [second, { ...first, primary: { title: "Changed" } }] },
        },
      })
    ).toMatchObject({
      status: "allowed",
      occurrences: [{ intent: "existing" }, { intent: "existing" }],
    })
  })

  for (const profileRow of ["locale", "id", "type", "choice"]) {
    test.each([profileRow])(
      "a changed %s cannot borrow retained assignment authority", sliceProfile(profileRow === "type" ? ["hero-with-image", "hero-agency"] : ["hero-with-image"]),
      (change) => {
        const incoming = slice("centered")
        if (change === "id") incoming.id = "new-occurrence"
        if (change === "type") incoming.type = "hero-agency"
        if (change === "choice") incoming.presentationIdV1 = "default"
        expect(
          decideSlicePresentationMutation(catalog, {
            existingContent: content(slice("centered")),
            content: content(incoming, change === "locale" ? "fr" : "en"),
          })
        ).toMatchObject({ status: "refused", reason: "catalog-stale" })
      }
    )
  }

  test("a new explicit occurrence is new even when its Type and choice exist elsewhere", sliceProfile(["hero-with-image"]), () => {
    expect(
      decideSlicePresentationMutation(catalog, {
        existingContent: content(slice("centered")),
        content: {
          en: { slices: [slice("centered"), slice("centered", "hero-2")] },
        },
      })
    ).toMatchObject({
      status: "refused",
      path: "content.en.slices[1]",
      reason: "catalog-stale",
    })
  })

  test("a changed choice or occurrence ID succeeds as a new assignment at the current revision", sliceProfile(["hero-with-image"]), () => {
    for (const incoming of [slice("default"), slice("centered", "new-id")]) {
      expect(
        decideSlicePresentationMutation(catalog, {
          existingContent: content(slice("centered")),
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
    "retains $reason choices with qualified resolution but refuses new assignments", sliceProfile(["hero-with-image"]),
    ({ changes, reason, retainedStatus }) => {
      const current = centered(changes)
      const retained = content(slice("centered"))
      expect(
        decideSlicePresentationMutation(current, {
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
        decideSlicePresentationMutation(current, {
          content: retained,
          expectedPresentationCatalogRevision: current.revision,
        })
      ).toMatchObject({ status: "refused", reason })
    }
  )

  test("retained unknown IDs remain stored with explicit default fallback, but cannot be assigned anew", sliceProfile(["hero-with-image"]), () => {
    const retained = content(slice("old-choice"))
    expect(
      decideSlicePresentationMutation(catalog, {
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
      decideSlicePresentationMutation(catalog, {
        content: retained,
        expectedPresentationCatalogRevision: catalog.revision,
      })
    ).toMatchObject({ status: "refused", reason: "presentation-missing" })
    expect(retained.en.slices[0].presentationIdV1).toBe("old-choice")
  })

  test.each(["centered", "old-choice"])(
    "trusted restore preserves historical %s without treating it as a new assignment", sliceProfile(["hero-with-image"]),
    (id) => {
      const historical = content(slice(id))
      expect(
        decideSlicePresentationMutation(centered({ state: "archived" }), {
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
      expect(historical.en.slices[0].presentationIdV1).toBe(id)
      expect(
        decideSlicePresentationMutation(catalog, {
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
  ])("rejects malformed %j in both old and incoming bags", sliceProfile([]), (id) => {
    const malformed = content(slice(id))
    expect(hasExplicitSlicePresentations([malformed])).toBe(true)
    expect(
      decideSlicePresentationMutation(catalog, {
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
      decideSlicePresentationMutation(catalog, {
        content: malformed,
        operation: "restore",
      })
    ).toMatchObject({
      status: "refused",
      bag: "incoming",
      reason: "invalid-presentation-id",
    })
  })

  test("absent Type blocks both bags even with historical intent or legacy absence", sliceProfile([]), () => {
    const absent = {
      ...catalog,
      installedTypes: catalog.installedTypes.filter(
        (type) => type !== "hero-with-image"
      ),
    }
    for (const id of [undefined, "centered"]) {
      expect(
        decideSlicePresentationMutation(absent, {
          existingContent: content(slice(id)),
          content: {},
        })
      ).toMatchObject({
        status: "refused",
        bag: "existing",
        reason: "type-unavailable",
      })
      expect(
        decideSlicePresentationMutation(absent, {
          content: content(slice(id)),
          operation: "restore",
        })
      ).toMatchObject({
        status: "refused",
        bag: "incoming",
        reason: "type-unavailable",
      })
    }
  })

  test("one unavailable fallback refuses the whole operation", sliceProfile(["hero-with-image"]), () => {
    const unavailable = {
      ...catalog,
      entries: catalog.entries.filter(
        (entry) => !(entry.type === "hero-with-image" && entry.id === "default")
      ),
    }
    expect(
      decideSlicePresentationMutation(unavailable, {
        existingContent: content(slice("old-choice")),
        content: {
          en: { slices: [slice("centered", "valid"), slice("old-choice")] },
        },
        expectedPresentationCatalogRevision: catalog.revision,
      })
    ).toMatchObject({
      status: "refused",
      path: "content.en.slices[1]",
      reason: "fallback-unavailable",
    })
  })

  test("removing explicit metadata is a default assignment requiring current revision while preserving absence", sliceProfile(["hero-with-image"]), () => {
    const incoming = content()
    expect(
      decideSlicePresentationMutation(catalog, {
        existingContent: content(slice("centered")),
        content: incoming,
      })
    ).toMatchObject({ status: "refused", reason: "catalog-stale" })
    expect(
      decideSlicePresentationMutation(catalog, {
        existingContent: content(slice("centered")),
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
    expect(Object.hasOwn(incoming.en.slices[0], "presentationIdV1")).toBe(false)
  })

  test.each([
    { state: "archived" as const },
    { installed: false },
    { contractSha256: "old" },
  ])(
    "metadata omission cannot assign an ineligible default $state/$installed/$contractSha256", sliceProfile([]),
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
        decideSlicePresentationMutation(current, {
          existingContent: content(slice("centered")),
          content: content(),
          expectedPresentationCatalogRevision: current.revision,
        }).status
      ).toBe("refused")
    }
  )
})

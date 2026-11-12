import { sliceProfile } from "@/test-utils/slice-profile"
import { beforeAll, describe, expect, test } from "vitest"
import { sliceAuthoringContractState } from "./authoringState"
import { digestLocalePublicationCandidate } from "../publishing/localeCandidate"
import {
  HERO_PRESENTATION_CONTRACT_SHA256,
  readSlicePresentationCatalog,
  resolveSlicePresentation,
  slicePresentationCatalogRevision,
  type SlicePresentationCatalog,
  type SlicePresentationEntry,
  type SlicePresentationRequest,
} from "./presentations"

let catalog: SlicePresentationCatalog
const hero = "hero-with-image"

beforeAll(async () => {
  catalog = await readSlicePresentationCatalog()
})

async function changedCatalog(
  changes: Partial<Omit<SlicePresentationCatalog, "revision">>
): Promise<SlicePresentationCatalog> {
  const next = { ...catalog, ...changes }
  return { ...next, revision: await slicePresentationCatalogRevision(next) }
}

function changedEntry(
  id: "default" | "centered",
  changes: Partial<
    Pick<
      SlicePresentationEntry,
      "state" | "installed" | "contractSha256" | "label"
    >
  >
) {
  return changedCatalog({
    entries: catalog.entries.map((entry) =>
      entry.type === hero && entry.id === id ? { ...entry, ...changes } : entry
    ),
  })
}

function request(
  intent: "new-assignment" | "existing" | "historical",
  snapshot = catalog,
  presentationId?: string
): SlicePresentationRequest {
  return intent === "new-assignment"
    ? {
        type: hero,
        intent,
        presentationId,
        expectedCatalogRevision: snapshot.revision,
      }
    : { type: hero, intent, presentationId }
}

describe("owned source presentation catalog", () => {
  test("pins the exact existing Hero serialization without React or renderer values", sliceProfile([]), async () => {
    const descriptors = JSON.parse(sliceAuthoringContractState().contracts)
    expect(
      await digestLocalePublicationCandidate(JSON.stringify(descriptors[hero]))
    ).toBe(HERO_PRESENTATION_CONTRACT_SHA256)
    expect(catalog.contractDigests[hero]).toBe(
      HERO_PRESENTATION_CONTRACT_SHA256
    )
    expect(
      catalog.entries
        .filter((entry) => entry.type === hero)
        .map((entry) => entry.id)
    ).toEqual(["default", "centered"])
    for (const entry of catalog.entries.filter((entry) => entry.type === hero))
      expect(entry.contractSha256).toBe(catalog.contractDigests[hero])
    expect(JSON.parse(JSON.stringify(catalog))).toEqual(catalog)
    expect(Object.isFrozen(catalog)).toBe(true)
    expect(Object.isFrozen(catalog.entries[0])).toBe(true)
  })

  test("has deterministic revisions independent of map/entry ordering", sliceProfile(["hero-with-image"]), async () => {
    expect((await readSlicePresentationCatalog()).revision).toBe(
      catalog.revision
    )
    const reordered = await changedCatalog({
      entries: [...catalog.entries].reverse(),
      installedTypes: [...catalog.installedTypes].reverse(),
      contractDigests: Object.fromEntries(
        Object.entries(catalog.contractDigests).reverse()
      ),
    })
    expect(reordered.revision).toBe(catalog.revision)
    const relabeled = await changedEntry("centered", { label: "Owner label" })
    expect(relabeled.revision).not.toBe(catalog.revision)
    expect(
      relabeled.entries.find((entry) => entry.id === "centered")?.contractSha256
    ).toBe(HERO_PRESENTATION_CONTRACT_SHA256)
    expect(
      resolveSlicePresentation(
        relabeled,
        request("new-assignment", catalog, "centered")
      )
    ).toMatchObject({
      status: "refused",
      reason: "catalog-stale",
    })
  })

  test.each(["default", "centered"])(
    "accepts an active installed compatible Hero %s at the current revision", sliceProfile(["hero-with-image"]),
    (id) => {
      for (const intent of [
        "new-assignment",
        "existing",
        "historical",
      ] as const)
        expect(
          resolveSlicePresentation(catalog, request(intent, catalog, id))
        ).toMatchObject({
          status: "resolved",
          type: hero,
          requestedId: id,
          resolvedId: id,
          legacyDefault: false,
          renderable: true,
          newAssignable: true,
        })
    }
  )

  test("RF5 repinned Hero keeps omitted identity for new, existing and historical use", sliceProfile(["hero-with-image"]), () => {
    for (const intent of ["new-assignment", "existing", "historical"] as const)
      expect(resolveSlicePresentation(catalog, request(intent))).toMatchObject({
        status: "resolved",
        requestedId: null,
        resolvedId: "default",
        legacyDefault: true,
      })
  })

  test("keeps the current default for every installed Type, including legacy absence", sliceProfile(["hero-agency"]), () => {
    for (const type of catalog.installedTypes) {
      expect(
        resolveSlicePresentation(catalog, { type, intent: "existing" })
      ).toMatchObject({
        status: "resolved",
        requestedId: null,
        resolvedId: "default",
        legacyDefault: true,
        newAssignable: true,
      })
      expect(
        resolveSlicePresentation(catalog, {
          type,
          intent: "new-assignment",
          presentationId: "default",
          expectedCatalogRevision: catalog.revision,
        })
      ).toMatchObject({ status: "resolved", newAssignable: true })
    }
    expect(
      resolveSlicePresentation(catalog, {
        type: "hero-agency",
        intent: "new-assignment",
        presentationId: "centered",
        expectedCatalogRevision: catalog.revision,
      })
    ).toMatchObject({ status: "refused", reason: "presentation-missing" })
  })

  test.each(["new-assignment", "existing", "historical"] as const)(
    "handles archived identity for %s", sliceProfile(["hero-with-image"]),
    async (intent) => {
      const archived = await changedEntry("centered", { state: "archived" })
      expect(
        resolveSlicePresentation(
          archived,
          request(intent, archived, "centered")
        )
      ).toMatchObject(
        intent === "new-assignment"
          ? {
              status: "refused",
              requestedId: "centered",
              reason: "presentation-archived",
            }
          : {
              status: "resolved",
              requestedId: "centered",
              resolvedId: "centered",
              renderable: true,
              newAssignable: false,
            }
      )
    }
  )

  test.each([
    {
      changes: { state: "unavailable" as const },
      reason: "presentation-unavailable",
    },
    { changes: { installed: false }, reason: "presentation-unavailable" },
    {
      changes: { contractSha256: "sha256:old-contract" },
      reason: "contract-incompatible",
    },
  ])(
    "refuses a new choice and discloses retained fallback for $reason/$changes", sliceProfile(["hero-with-image"]),
    async ({ changes, reason }) => {
      const unavailable = await changedEntry("centered", changes)
      expect(
        resolveSlicePresentation(
          unavailable,
          request("new-assignment", unavailable, "centered")
        )
      ).toMatchObject({
        status: "refused",
        requestedId: "centered",
        reason,
      })
      for (const intent of ["existing", "historical"] as const) {
        expect(
          resolveSlicePresentation(
            unavailable,
            request(intent, unavailable, "centered")
          )
        ).toMatchObject({
          status: "fallback",
          requestedId: "centered",
          resolvedId: "default",
          reason,
          renderable: true,
          newAssignable: false,
        })
      }
    }
  )

  test.each(["new-assignment", "existing", "historical"] as const)(
    "preserves a missing identity for %s", sliceProfile(["hero-with-image"]),
    (intent) => {
      expect(
        resolveSlicePresentation(
          catalog,
          request(intent, catalog, "retained-missing")
        )
      ).toMatchObject(
        intent === "new-assignment"
          ? {
              status: "refused",
              requestedId: "retained-missing",
              reason: "presentation-missing",
            }
          : {
              status: "fallback",
              requestedId: "retained-missing",
              resolvedId: "default",
              reason: "presentation-missing",
            }
      )
    }
  )

  test.each(["new-assignment", "existing", "historical"] as const)(
    "never conceals an absent Type for %s", sliceProfile([]),
    async (intent) => {
      const absent = await changedCatalog({
        installedTypes: catalog.installedTypes.filter((type) => type !== hero),
      })
      expect(
        resolveSlicePresentation(absent, request(intent, absent, "centered"))
      ).toMatchObject({
        status: "refused",
        type: hero,
        requestedId: "centered",
        reason: "type-unavailable",
        renderable: false,
      })
    }
  )

  test.each(["missing", "unavailable", "incompatible"])(
    "refuses the whole retained decision when its fallback is %s", sliceProfile(["hero-with-image"]),
    async (kind) => {
      const unavailable =
        kind === "missing"
          ? await changedCatalog({
              entries: catalog.entries.filter(
                (entry) => !(entry.type === hero && entry.id === "default")
              ),
            })
          : await changedEntry(
              "default",
              kind === "unavailable"
                ? { state: "unavailable" }
                : { contractSha256: "sha256:old-contract" }
            )
      expect(
        resolveSlicePresentation(
          unavailable,
          request("historical", unavailable, "retained-missing")
        )
      ).toMatchObject({
        status: "refused",
        requestedId: "retained-missing",
        reason: "fallback-unavailable",
        requestedReason: "presentation-missing",
        renderable: false,
      })
    }
  )

  test.each(["field-label", "default", "preview", "hint"])(
    "conservatively invalidates the pair after exact descriptor %s drift", sliceProfile(["hero-with-image"]),
    async (kind) => {
      const descriptors = JSON.parse(sliceAuthoringContractState().contracts)
      const descriptor = descriptors[hero]
      if (kind === "field-label")
        descriptor.primary.config.fields.title.config.label = "Changed label"
      if (kind === "default")
        descriptor.primary.default.title = "Changed default"
      if (kind === "preview")
        descriptor.preview.primary.title = "Changed preview"
      if (kind === "hint") descriptor.aiHint.purpose = "Changed purpose"
      const nextDigest = await digestLocalePublicationCandidate(
        JSON.stringify(descriptor)
      )
      expect(nextDigest).not.toBe(HERO_PRESENTATION_CONTRACT_SHA256)
      const changed = await changedCatalog({
        contractDigests: { ...catalog.contractDigests, [hero]: nextDigest },
      })
      expect(
        resolveSlicePresentation(
          changed,
          request("new-assignment", changed, "centered")
        )
      ).toMatchObject({
        status: "refused",
        reason: "contract-incompatible",
      })
      expect(
        resolveSlicePresentation(
          changed,
          request("existing", changed, "centered")
        )
      ).toMatchObject({
        status: "refused",
        reason: "fallback-unavailable",
        requestedReason: "contract-incompatible",
      })
    }
  )

  test("requires an exact current revision rather than silently upgrading a new assignment", sliceProfile(["hero-with-image"]), () => {
    expect(
      resolveSlicePresentation(catalog, {
        type: hero,
        intent: "new-assignment",
        presentationId: "centered",
        expectedCatalogRevision: "old",
      })
    ).toMatchObject({ status: "refused", reason: "catalog-stale" })
  })

  test.each(["", "../default", "Centered", "__proto__", "a".repeat(65)])(
    "refuses malformed identity %j", sliceProfile(["hero-with-image"]),
    (presentationId) => {
      expect(
        resolveSlicePresentation(
          catalog,
          request("existing", catalog, presentationId)
        )
      ).toMatchObject({
        status: "refused",
        reason: "invalid-presentation-id",
      })
    }
  )

  test("prototype names cannot resolve to a presentation entry", sliceProfile(["hero-with-image"]), () => {
    expect(
      resolveSlicePresentation(
        catalog,
        request("existing", catalog, "constructor")
      )
    ).toMatchObject({
      status: "fallback",
      requestedId: "constructor",
      reason: "presentation-missing",
      resolvedId: "default",
    })
  })

  test.each(["new-assignment", "existing", "historical"] as const)(
    "refuses a final newline in a %s identity rather than treating it as retained", sliceProfile(["hero-with-image"]),
    (intent) => {
      expect(
        resolveSlicePresentation(catalog, request(intent, catalog, "default\n"))
      ).toMatchObject({
        status: "refused",
        reason: "invalid-presentation-id",
      })
    }
  )

  test("refuses a final newline in the catalog revision", sliceProfile(["hero-with-image"]), () => {
    expect(
      resolveSlicePresentation(
        { ...catalog, revision: `${catalog.revision}\n` },
        request("existing")
      )
    ).toMatchObject({ status: "refused", reason: "catalog-unavailable" })
  })

  test.each(["new-assignment", "existing", "historical"] as const)(
    "refuses a missing catalog revision for %s", sliceProfile(["hero-with-image"]),
    (intent) => {
      const malformed = {
        ...catalog,
        revision: undefined,
      } as unknown as SlicePresentationCatalog
      expect(
        resolveSlicePresentation(malformed, request(intent, malformed))
      ).toMatchObject({ status: "refused", reason: "catalog-unavailable" })
    }
  )

  test("refuses unsupported catalog versions and undefined operation intent", sliceProfile(["hero-with-image"]), () => {
    expect(
      resolveSlicePresentation(
        { ...catalog, version: "old" } as unknown as SlicePresentationCatalog,
        request("existing")
      )
    ).toMatchObject({
      status: "refused",
      reason: "catalog-unavailable",
    })
    expect(
      resolveSlicePresentation(catalog, {
        type: hero,
      } as SlicePresentationRequest)
    ).toMatchObject({
      status: "refused",
      reason: "invalid-intent",
    })
  })
})

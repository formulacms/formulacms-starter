import { describe, expect, it } from "vitest"

import {
  adoptLocaleBase,
  buildSessionBase,
  cloneBase,
  dropLocaleBase,
  localeBaseOf,
  restoreExpectations,
  type SnapshotEditorPublication,
} from "./publication-base"

function payload(over: {
  lifecycle?: number
  shared?: number
  en?: number
  fr?: number
}): SnapshotEditorPublication {
  return {
    authority: "snapshot_active",
    lifecycleGeneration: over.lifecycle ?? 3,
    sharedDraftGeneration: over.shared ?? 4,
    locales: [
      {
        locale: "en",
        draftGeneration: over.en ?? 2,
        publicGeneration: 1,
        releaseGeneration: 1,
      },
      ...(over.fr === undefined
        ? []
        : [
            {
              locale: "fr",
              draftGeneration: over.fr,
              publicGeneration: 0,
              releaseGeneration: 0,
            },
          ]),
    ],
  }
}

describe("session generation base", () => {
  it("clones the payload it mounts with", () => {
    const server = payload({})
    const base = buildSessionBase(server, undefined)!
    base.locales[0]!.draftGeneration = 9
    base.sharedDraftGeneration = 9
    expect(server.locales[0]!.draftGeneration).toBe(2)
    expect(server.sharedDraftGeneration).toBe(4)
    expect(buildSessionBase(undefined, undefined)).toBeUndefined()
    expect(cloneBase(undefined)).toBeUndefined()
  })

  it("adopts exactly one language, cloned, and leaves shared and lifecycle alone", () => {
    const base = payload({ en: 2, fr: 5, shared: 4, lifecycle: 3 })
    const server = payload({ en: 9, fr: 6, shared: 8, lifecycle: 7 })
    adoptLocaleBase(base, server, "fr")
    expect(localeBaseOf(base, "fr").draftGeneration).toBe(6)
    expect(localeBaseOf(base, "en").draftGeneration).toBe(2)
    expect(base.sharedDraftGeneration).toBe(4)
    expect(base.lifecycleGeneration).toBe(3)
    localeBaseOf(base, "fr").draftGeneration = 11
    expect(server.locales[1]!.draftGeneration).toBe(6)
  })

  it("adds a missing language and forgets one the payload does not have", () => {
    const base = payload({})
    adoptLocaleBase(base, payload({ fr: 3 }), "fr")
    expect(localeBaseOf(base, "fr").draftGeneration).toBe(3)
    adoptLocaleBase(base, payload({}), "fr")
    expect(base.locales.map((entry) => entry.locale)).toEqual(["en"])
    expect(localeBaseOf(base, "fr")).toMatchObject({ draftGeneration: 0 })
    dropLocaleBase(base, "en")
    expect(base.locales).toEqual([])
  })

  it("keeps retained languages through a History remount and adopts only what was reloaded", () => {
    const retained = payload({ en: 2, fr: 5, shared: 4 })
    const refreshed = payload({ en: 3, fr: 6, shared: 5, lifecycle: 3 })
    const rebuilt = buildSessionBase(refreshed, {
      base: retained,
      restoredLocale: "en",
      keepRestoredLocale: false,
      keepShared: false,
    })!
    expect(rebuilt.locales.map((entry) => entry.draftGeneration)).toEqual([
      3, 5,
    ])
    expect(rebuilt.sharedDraftGeneration).toBe(5)
    // A kept unsaved buffer keeps its pre-restore language base.
    const kept = buildSessionBase(refreshed, {
      base: retained,
      restoredLocale: "en",
      keepRestoredLocale: true,
      keepShared: false,
    })!
    expect(kept.locales.map((entry) => entry.draftGeneration)).toEqual([2, 5])
    // The shared fields were reloaded, so the other languages send that base.
    expect(kept.sharedDraftGeneration).toBe(5)
    const keptShared = buildSessionBase(refreshed, {
      base: retained,
      restoredLocale: "en",
      keepRestoredLocale: false,
      keepShared: true,
    })!
    expect(keptShared.sharedDraftGeneration).toBe(4)
    expect(keptShared.locales[0]!.draftGeneration).toBe(3)
    expect(retained.locales[0]!.draftGeneration).toBe(2)
  })

  it("reads History expectations from the base, defaulting a missing language to generation 0", () => {
    const base = payload({ en: 2 })
    expect(restoreExpectations(base, "en")).toEqual({
      expectedDraftGeneration: 2,
      expectedSharedDraftGeneration: 4,
      expectedLifecycleGeneration: 3,
      expectedPublicGeneration: 1,
      expectedReleaseGeneration: 1,
    })
    expect(restoreExpectations(base, "fr")).toMatchObject({
      expectedDraftGeneration: 0,
      expectedPublicGeneration: 0,
    })
  })
})

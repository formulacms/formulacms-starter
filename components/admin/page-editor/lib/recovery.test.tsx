import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, it, expect, beforeEach, vi } from "vitest"
import {
  clearRecoveryDraft,
  isCurrentSourceRecovery,
  readRecoveryDraft,
  recoveryKey,
  writeRecoveryDraft,
} from "./recovery"
import type { Id } from "@/convex/_generated/dataModel"
import type { PageEditorRecoveryDraft } from "./types"


// Named `.test.tsx` (not `.test.ts`) so it runs under the jsdom project, where
// `window.localStorage` exists — the recovery helpers are inherently
// browser-only. No JSX; the extension is purely the environment selector.
const pageId = "page_1" as Id<"pages">
const draft = {
  base: null,
  version: 3,
  savedAt: 1720000000000,
  locale: "en",
  title: "Draft title",
  slug: "draft-title",
  pageType: "landing-page",
  parentId: "",
  authorIds: [],
  tags: [],
  metaTitle: "",
  metaDescription: "",
  slices: [],
  seoNoIndex: false,
  seoNoFollow: false,
  seoOgTitle: "",
  seoOgDescription: "",
  seoOgImage: "",
  sharedFieldValues: {},
  localizedFieldValues: {},
} satisfies PageEditorRecoveryDraft

describe("recovery draft persistence (jsdom tab storage)", () => {
  beforeEach(() => {
    window.localStorage.clear()
    window.sessionStorage.clear()
  })

  it("preserves the persisted recovery namespace", () => {
    const legacyMark = ["next", "cms"].join("")
    expect(recoveryKey(pageId, "en")).toBe(
      `${legacyMark}:page-editor:${pageId}:recovery:en`
    )
  })

  it("round-trips a written draft", () => {
    writeRecoveryDraft(pageId, draft)
    expect(readRecoveryDraft(pageId, "en")).toEqual(draft)
  })
  it("NEW R2 retains exact formatted incompatible data after reload but refuses applying it", sliceProfile([]), () => {
    const hero = createSampleSlice("hero-agency")
    const exact = JSON.stringify({
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "text",
              text: "formatted",
              marks: [
                { type: "bold" },
                { type: "link", attrs: { href: "https://example.invalid/" } },
              ],
            },
            { type: "hardBreak" },
          ],
        },
      ],
    })
    const retained = {
      ...draft,
      slices: [hero],
      inlineConflicts: [
        {
          locale: "en",
          sliceId: hero.id,
          sliceType: hero.type,
          expectedSlice: "",
          fieldPath: "retired.field",
          kind: "richText" as const,
          value: exact,
        },
      ],
    }
    writeRecoveryDraft(pageId, retained)
    const reloaded = readRecoveryDraft(pageId, "en")!
    expect(reloaded.inlineConflicts?.[0].value).toBe(exact)
    expect(isCurrentSourceRecovery(reloaded, "landing-page", "en")).toBe(false)
    expect(window.sessionStorage.getItem(recoveryKey(pageId, "en"))).toContain(
      "formatted"
    )
  })

  it("returns null when no draft is stored", () => {
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
  })

  it("returns null for malformed JSON", () => {
    window.sessionStorage.setItem(recoveryKey(pageId, "en"), "{not json")
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
  })

  it("retains but refuses an incomplete current-version payload", () => {
    const raw = JSON.stringify({ ...draft, slices: undefined })
    window.sessionStorage.setItem(recoveryKey(pageId, "en"), raw)
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
    expect(window.sessionStorage.getItem(recoveryKey(pageId, "en"))).toBe(raw)
  })

  it("restores only current descriptors, complete occurrences and the active locale/type", sliceProfile([]), () => {
    const hero = createSampleSlice("hero-with-image")
    const compatible = { ...draft, slices: [hero] }
    expect(isCurrentSourceRecovery(compatible, "landing-page", "en")).toBe(true)
    expect(isCurrentSourceRecovery(compatible, "page", "en")).toBe(false)
    expect(isCurrentSourceRecovery(compatible, "landing-page", "fr")).toBe(
      false
    )
    expect(
      isCurrentSourceRecovery(
        { ...compatible, localizedFieldValues: { retiredField: "text" } },
        "landing-page",
        "en"
      )
    ).toBe(false)
    expect(
      isCurrentSourceRecovery(
        { ...compatible, slices: [hero, hero] },
        "landing-page",
        "en"
      )
    ).toBe(false)
  })

  it("preserves recovery when current typed fields or rich-text profiles refuse it", sliceProfile([]), () => {
    const hero = createSampleSlice("hero-with-image")
    hero.primary.title = JSON.stringify({
      type: "doc",
      content: [
        { type: "codeBlock", content: [{ type: "text", text: "not inline" }] },
      ],
    })
    const incompatible = { ...draft, slices: [hero] }
    writeRecoveryDraft(pageId, incompatible)
    expect(isCurrentSourceRecovery(incompatible, "landing-page", "en")).toBe(
      false
    )
    expect(readRecoveryDraft(pageId, "en")).toEqual(incompatible)
    const badShape = {
      ...draft,
      slices: [{ ...hero, primary: { ...hero.primary, image: 42 } }],
    } as unknown as PageEditorRecoveryDraft
    expect(isCurrentSourceRecovery(badShape, "landing-page", "en")).toBe(false)
  })

  it.each(["centered\n", "centered\r", "centered\u2028", "centered\u2029"])(
    "preserves but refuses a malformed saved presentation identity %j", sliceProfile([]),
    (presentationIdV1) => {
      const pending = {
        ...draft,
        slices: [{ ...createSampleSlice("hero-with-image"), presentationIdV1 }],
      }
      writeRecoveryDraft(pageId, pending)
      expect(isCurrentSourceRecovery(pending, "landing-page", "en")).toBe(false)
      expect(readRecoveryDraft(pageId, "en")).toEqual(pending)
    }
  )

  it("preserves a well-formed retired presentation identity for backend retention checks", sliceProfile([]), () => {
    const pending = {
      ...draft,
      slices: [
        {
          ...createSampleSlice("hero-with-image"),
          presentationIdV1: "removed-choice",
        },
      ],
    }
    expect(isCurrentSourceRecovery(pending, "landing-page", "en")).toBe(true)
    expect(pending.slices[0].presentationIdV1).toBe("removed-choice")
  })

  it("returns null when the stored value lacks a numeric savedAt", () => {
    window.sessionStorage.setItem(
      recoveryKey(pageId, "en"),
      JSON.stringify({ title: "no timestamp" })
    )
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
  })

  it("clears a stored draft", () => {
    writeRecoveryDraft(pageId, draft)
    clearRecoveryDraft(pageId, "en")
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
  })

  it("scopes drafts per page id", () => {
    const otherId = "page_2" as Id<"pages">
    writeRecoveryDraft(pageId, draft)
    expect(readRecoveryDraft(otherId, "en")).toBeNull()
  })

  it("preserves another locale's draft when saving or clearing this locale", () => {
    const french = { ...draft, locale: "fr" as const, title: "Brouillon" }
    writeRecoveryDraft(pageId, french)
    writeRecoveryDraft(pageId, draft)
    clearRecoveryDraft(pageId, "en")
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
    expect(readRecoveryDraft(pageId, "fr")).toEqual(french)
  })

  it("refuses a payload stored under a different locale's key", () => {
    window.sessionStorage.setItem(
      recoveryKey(pageId, "fr"),
      JSON.stringify(draft)
    )
    expect(readRecoveryDraft(pageId, "fr")).toBeNull()
  })

  it("adopts only the matching legacy locale once without resurrecting a saved draft", () => {
    const legacyKey = `nextcms:page-editor:${pageId}:recovery`
    window.localStorage.setItem(legacyKey, JSON.stringify(draft))
    expect(readRecoveryDraft(pageId, "fr")).toBeNull()
    expect(window.localStorage.getItem(legacyKey)).not.toBeNull()
    expect(readRecoveryDraft(pageId, "en")).toEqual(draft)
    expect(window.localStorage.getItem(legacyKey)).toBeNull()
    clearRecoveryDraft(pageId, "en")
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
  })

  it("keeps a different tab's writes and clears out of this tab's recovery", () => {
    writeRecoveryDraft(pageId, draft)
    const firstTab = window.sessionStorage
    const data = new Map<string, string>()
    const secondTab: Storage = {
      get length() {
        return data.size
      },
      clear: () => data.clear(),
      getItem: (key) => data.get(key) ?? null,
      key: (index) => [...data.keys()][index] ?? null,
      removeItem: (key) => {
        data.delete(key)
      },
      setItem: (key, value) => {
        data.set(key, value)
      },
    }
    const storage = vi
      .spyOn(window, "sessionStorage", "get")
      .mockReturnValue(secondTab)
    try {
      expect(readRecoveryDraft(pageId, "en")).toBeNull()
      writeRecoveryDraft(pageId, { ...draft, title: "Other tab" })
      clearRecoveryDraft(pageId, "en")
      storage.mockReturnValue(firstTab)
      expect(readRecoveryDraft(pageId, "en")).toEqual(draft)
    } finally {
      storage.mockRestore()
    }
  })

  it("does not interrupt editing when browser storage is unavailable", () => {
    const storage = vi
      .spyOn(window, "sessionStorage", "get")
      .mockImplementation(() => {
        throw new Error("Storage disabled")
      })
    try {
      expect(() => writeRecoveryDraft(pageId, draft)).not.toThrow()
      expect(() => clearRecoveryDraft(pageId, "en")).not.toThrow()
      expect(readRecoveryDraft(pageId, "en")).toBeNull()
    } finally {
      storage.mockRestore()
    }
  })

  it("ignores a v1 (pre-C8) payload — safer than restoring incomplete state", () => {
    // A payload missing `version` (or an older `version`) is silently
    // dropped so fields introduced by a later version don't come back
    // empty/mismatched and overwrite what the editor now tracks.
    window.sessionStorage.setItem(
      recoveryKey(pageId, "en"),
      JSON.stringify({
        savedAt: 1720000000000,
        locale: "en",
        title: "old v1 draft",
      })
    )
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
  })

  it("ignores a payload with a wrong version literal", () => {
    window.sessionStorage.setItem(
      recoveryKey(pageId, "en"),
      JSON.stringify({
        version: 99,
        savedAt: 1720000000000,
        locale: "en",
        title: "wrong version",
        sharedFieldValues: {},
        localizedFieldValues: {},
      })
    )
    expect(readRecoveryDraft(pageId, "en")).toBeNull()
  })

  it("stamps the current version onto a written payload", () => {
    writeRecoveryDraft(pageId, draft)
    const raw = window.sessionStorage.getItem(recoveryKey(pageId, "en"))
    expect(raw).not.toBeNull()
    const parsed = JSON.parse(raw!)
    expect(parsed.version).toBe(3)
  })
})

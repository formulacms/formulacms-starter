import { createSampleSlice } from "@/convex/lib/slices/sample"
import { sliceProfile } from "@/test-utils/slice-profile"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { HeroAgency } from "@/components/slices/hero-agency"
import { captureSliceOccurrence } from "./page-editor/lib/slice-occurrence"
import {
  acceptPreviewCapture,
  projectPreviewSession,
  validatedPreviewCommit,
  type PreviewInlineSession,
} from "./preview-inline-session"

const pm = (text: string) =>
  JSON.stringify({
    type: "doc",
    content: [
      { type: "paragraph", content: text ? [{ type: "text", text }] : [] },
    ],
  })
function fixture() {
  const slice = { ...createSampleSlice("hero-agency"), id: "hero" }
  const session: PreviewInlineSession = {
    ...captureSliceOccurrence([slice], "en", "hero")!,
    fieldPath: "primary.description",
    kind: "richText",
    draft: slice.primary.description,
    cancellationValue: slice.primary.description,
    label: "Title",
  }
  return { slice, session }
}

describe("validated preview projection", () => {
  it.each(["centered", "retained-missing"])(
    "preserves retained presentation %s while validating real inline field edits", sliceProfile([]),
    (presentationIdV1) => {
      const base = fixture()
      const slice = { ...base.slice, presentationIdV1 }
      const session = {
        ...base.session,
        ...captureSliceOccurrence([slice], "en", "hero")!,
        draft: pm("Edited with presentation"),
      }
      const commit = validatedPreviewCommit([slice], "en", session)
      expect(commit?.value).toBe(session.draft)
      const [projected] = projectPreviewSession([slice], "en", session)
      expect(projected.presentationIdV1).toBe(presentationIdV1)
      expect(projected.id).toBe(slice.id)
      expect(projected.type).toBe(slice.type)
      const captured = acceptPreviewCapture(session, commit!)
      expect(JSON.parse(captured.expectedSlice).presentationIdV1).toBe(
        presentationIdV1
      )
      expect(projectPreviewSession([slice], "en", null)[0]).toBe(slice)
      expect(slice.primary.description).toBe(base.slice.primary.description)
    }
  )

  it.each(["", "a".repeat(65), "../default"])(
    "refuses malformed occurrence metadata %j before applying unchanged descriptor validation", sliceProfile([]),
    (presentationIdV1) => {
      const base = fixture()
      const slice = { ...base.slice, presentationIdV1 }
      const session = {
        ...base.session,
        ...captureSliceOccurrence([slice], "en", "hero")!,
        draft: pm("Rejected edit"),
      }
      expect(validatedPreviewCommit([slice], "en", session)).toBeNull()
      expect(projectPreviewSession([slice], "en", session)[0]).toBe(slice)
    }
  )

  it("still refuses malformed actual values after separating valid presentation metadata", sliceProfile([]), () => {
    const base = fixture()
    const slice = {
      ...base.slice,
      presentationIdV1: "centered",
      primary: { ...base.slice.primary, eyebrow: 42 },
    } as unknown as typeof base.slice
    const session = {
      ...base.session,
      ...captureSliceOccurrence([slice], "en", "hero")!,
      draft: pm("Rejected malformed content"),
    }
    expect(validatedPreviewCommit([slice], "en", session)).toBeNull()
  })

  it("renders consecutive buffers with the real renderer without changing the base", sliceProfile([]), () => {
    const { slice, session } = fixture()
    const base = JSON.stringify(slice)
    for (const text of ["Keystroke one", "Keystroke one two"]) {
      const [projected] = projectPreviewSession([slice], "en", {
        ...session,
        draft: pm(text),
      })
      if (projected.type !== "hero-agency") throw new Error("fixture type")
      expect(
        renderToStaticMarkup(
          <HeroAgency
            slice={projected}
            ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
          />
        )
      ).toContain(text)
      expect(JSON.stringify(slice)).toBe(base)
    }
    expect(projectPreviewSession([slice], "en", null)).toEqual([slice])
  })

  it("refuses an externally changed occurrence, descriptor mismatch, and profile widening", sliceProfile([]), () => {
    const { slice, session } = fixture()
    expect(
      validatedPreviewCommit(
        [{ ...slice, primary: { ...slice.primary, eyebrow: "external" } }],
        "en",
        session
      )
    ).toBeNull()
    expect(validatedPreviewCommit([slice], "fr", session)).toBeNull()
    expect(
      validatedPreviewCommit([slice], "en", {
        ...session,
        fieldPath: "primary.missing",
      })
    ).toBeNull()
    expect(
      validatedPreviewCommit([slice], "en", { ...session, kind: "text" })
    ).toBeNull()
    expect(
      validatedPreviewCommit([slice], "en", {
        ...session,
        draft: JSON.stringify({
          type: "doc",
          content: [{ type: "blockquote", content: [{ type: "paragraph" }] }],
        }),
      })
    ).toBeNull()
  })

  it("accepts a rebased inline value when a sibling field changed in the same occurrence", sliceProfile([]), () => {
    const { slice, session } = fixture()
    const current = {
      ...slice,
      primary: { ...slice.primary, eyebrow: "External form edit" },
    }
    const rebased = validatedPreviewCommit([current], "en", {
      ...session,
      expectedSlice: JSON.stringify(current),
      draft: pm("Inline buffer after rebase"),
    })

    expect(rebased?.value).toBe(pm("Inline buffer after rebase"))
    const [projected] = projectPreviewSession([current], "en", {
      ...session,
      expectedSlice: JSON.stringify(current),
      draft: pm("Inline buffer after rebase"),
    })
    if (projected.type !== "hero-agency")
      throw new Error("Expected projected Hero Agency slice")
    expect(projected.primary.eyebrow).toBe("External form edit")
    expect(projected.primary.description).toBe(pm("Inline buffer after rebase"))
  })

  it("rebases captured Save while preserving newer typing and cancellation baseline", sliceProfile([]), () => {
    const { slice, session } = fixture()
    const captured = validatedPreviewCommit([slice], "en", {
      ...session,
      draft: pm("captured"),
    })!
    const rebased = acceptPreviewCapture(
      { ...session, draft: pm("newer typing") },
      captured
    )
    const [savedBase] = projectPreviewSession([slice], "en", {
      ...session,
      draft: captured.value,
    })
    expect(rebased.cancellationValue).toBe(captured.value)
    expect(rebased.draft).toBe(pm("newer typing"))
    expect(validatedPreviewCommit([savedBase], "en", rebased)?.value).toBe(
      pm("newer typing")
    )
    expect(projectPreviewSession([savedBase], "en", null)).toEqual([savedBase])
  })
})

describe("repeated runtime item guards", () => {
  function repeated() {
    const slice = { ...createSampleSlice("features-icon-grid"), id: "features" }
    slice.items = [0, 1, 2].map((index) => ({
      ...slice.items[0],
      title: JSON.stringify({
        type: "doc",
        content: [
          {
            type: "heading",
            attrs: { level: 3 },
            content: [{ type: "text", text: `Card ${index}` }],
          },
        ],
      }),
      body: pm("Equal"),
    }))
    const session: PreviewInlineSession = {
      ...captureSliceOccurrence([slice], "en", slice.id, "items.1.body", 7)!,
      fieldPath: "items.1.body",
      kind: "richText",
      draft: pm("Middle edited"),
      cancellationValue: pm("Equal"),
      label: "Title",
    }
    return { slice, session }
  }
  it("patches only the selected equal body and preserves full sibling values", sliceProfile([]), () => {
    const { slice, session } = repeated()
    const [projected] = projectPreviewSession([slice], "en", session, 7)
    if (projected.type !== "features-icon-grid") throw new Error("fixture type")
    expect(projected.items).toEqual([
      slice.items[0],
      { ...slice.items[1], body: session.draft },
      slice.items[2],
    ])
    expect(slice.items[1].body).toBe(pm("Equal"))
  })
  it.each([
    "reorder",
    "remove",
    "sibling-field",
    "epoch",
    "locale",
    "wrong-path",
    "missing-binding",
  ])("refuses %s without retargeting", sliceProfile([]), (change) => {
    const { slice, session } = repeated()
    const current =
      change === "reorder"
        ? { ...slice, items: [...slice.items].reverse() }
        : change === "remove"
          ? { ...slice, items: slice.items.slice(1) }
          : change === "sibling-field"
            ? {
                ...slice,
                items: slice.items.map((item, index) =>
                  index === 1
                    ? {
                        ...item,
                        title: JSON.stringify({
                          type: "doc",
                          content: [
                            {
                              type: "heading",
                              attrs: { level: 3 },
                              content: [{ type: "text", text: "changed" }],
                            },
                          ],
                        }),
                      }
                    : item
                ),
              }
            : slice
    const pending =
      change === "wrong-path"
        ? { ...session, fieldPath: "items.0.body" }
        : change === "missing-binding"
          ? { ...session, repeatedTarget: undefined }
          : session
    expect(
      validatedPreviewCommit(
        [current],
        change === "locale" ? "fr" : "en",
        pending,
        change === "epoch" ? 8 : 7
      )
    ).toBeNull()
    expect(
      projectPreviewSession(
        [current],
        change === "locale" ? "fr" : "en",
        pending,
        change === "epoch" ? 8 : 7
      )
    ).toEqual([current])
  })
  it("deliberately rebases its own captured value while retaining newer typing", sliceProfile([]), () => {
    const { slice, session } = repeated()
    const captured = validatedPreviewCommit([slice], "en", session, 7)!
    const rebased = acceptPreviewCapture(
      { ...session, draft: pm("Later typing") },
      captured
    )
    const [saved] = projectPreviewSession([slice], "en", session, 7)
    if (saved.type !== "features-icon-grid") throw new Error("fixture type")
    expect(rebased.repeatedTarget?.itemFingerprint).toBe(
      JSON.stringify(saved.items[1])
    )
    expect(validatedPreviewCommit([saved], "en", rebased, 7)?.value).toBe(
      pm("Later typing")
    )
    expect(validatedPreviewCommit([saved], "en", rebased, 8)).toBeNull()
  })
})

describe("compiled renderer source pin", () => {
  const pin = {
    rendererSource: "components/slices/hero-agency.tsx",
    presentationId: "default",
    sourceHash: "a".repeat(64),
  }
  it("retains the exact compiled pin through a valid commit and accepted content rebase", sliceProfile([]), () => {
    const { slice, session } = fixture()
    const pinned = { ...session, rendererSource: pin, draft: pm("Saved text") }
    const commit = validatedPreviewCommit([slice], "en", pinned)!
    expect(commit.rendererSource).toEqual(pin)
    expect(acceptPreviewCapture(pinned, commit).rendererSource).toEqual(pin)
    expect(
      acceptPreviewCapture(pinned, {
        ...commit,
        rendererSource: { ...pin, sourceHash: "b".repeat(64) },
      })
    ).toBe(pinned)
  })
  it("an observed stale pin refuses both projection and exact-byte revert rebase", sliceProfile([]), () => {
    const { slice, session } = fixture()
    const pinned = {
      ...session,
      rendererSource: pin,
      sourceInvalidated: true,
      draft: pm("Keep me"),
    }
    expect(validatedPreviewCommit([slice], "en", pinned)).toBeNull()
    expect(projectPreviewSession([slice], "en", pinned)[0]).toBe(slice)
    expect(
      acceptPreviewCapture(pinned, {
        ...pinned,
        value: pinned.draft,
        sourceInvalidated: false,
      })
    ).toBe(pinned)
  })
})

describe("RF5 edited value and untouched sibling admission", () => {
  it.each(["", "<p>Legacy sibling</p>", pm("Canonical sibling")])(
    "validates title edits without changing sibling bytes %j", sliceProfile([]),
    async (description) => {
      const { adoptHeroTitles } =
        await import("@/lib/rich-text/adopt-hero-titles")
      const base = fixture()
      const slice = {
        ...base.slice,
        primary: { ...base.slice.primary, description },
      }
      const session = {
        ...base.session,
        ...captureSliceOccurrence([slice], "en", slice.id)!,
        fieldPath: "primary.title",
        draft: pm("Edited title"),
      }
      const before = JSON.stringify(slice)
      const commit = validatedPreviewCommit([slice], "en", session)
      expect(commit?.value).toContain("Edited title")
      expect(commit?.expectedSlice).toBe(before)
      const [projected] = projectPreviewSession([slice], "en", session)
      if (projected.type !== "hero-agency")
        throw new Error("Expected Hero Agency")
      expect(projected.primary.description).toBe(description)
      const prepared = adoptHeroTitles([projected], "en")
      expect(prepared.value[0].primary).toMatchObject({
        description: expect.stringContaining('"type":"doc"'),
      })
      expect(JSON.stringify(slice)).toBe(before)
      expect(projectPreviewSession([slice], "en", null)[0]).toBe(slice)
    }
  )
  it("refuses a malformed structured sibling rather than reinterpreting it", sliceProfile([]), () => {
    const base = fixture()
    const slice = {
      ...base.slice,
      primary: { ...base.slice.primary, description: '{"type":"doc"}' },
    }
    const session = {
      ...base.session,
      ...captureSliceOccurrence([slice], "en", slice.id)!,
      fieldPath: "primary.title",
      draft: pm("Edited"),
    }
    expect(validatedPreviewCommit([slice], "en", session)).toBeNull()
  })
  it.each([
    "<p>New HTML</p>",
    '"non-doc"',
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"paragraph"}]}]}',
  ])("never adopts a newly edited non-title value %j", sliceProfile([]), (draft) => {
    const { slice, session } = fixture()
    expect(
      validatedPreviewCommit([slice], "en", { ...session, draft })
    ).toBeNull()
  })
})

import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { blockProfile } from "@/test-utils/block-profile"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import { HeroAgency } from "@/components/blocks/hero-agency"
import { captureBlockOccurrence } from "./page-editor/lib/block-occurrence"
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
  const block = { ...createSampleBlock("hero-agency"), id: "hero" }
  const session: PreviewInlineSession = {
    ...captureBlockOccurrence([block], "en", "hero")!,
    fieldPath: "primary.description",
    kind: "richText",
    draft: block.primary.description,
    cancellationValue: block.primary.description,
    label: "Title",
  }
  return { block, session }
}

describe("validated preview projection", () => {
  it.each(["centered", "retained-missing"])(
    "preserves retained presentation %s while validating real inline field edits", blockProfile([]),
    (presentationIdV1) => {
      const base = fixture()
      const block = { ...base.block, presentationIdV1 }
      const session = {
        ...base.session,
        ...captureBlockOccurrence([block], "en", "hero")!,
        draft: pm("Edited with presentation"),
      }
      const commit = validatedPreviewCommit([block], "en", session)
      expect(commit?.value).toBe(session.draft)
      const [projected] = projectPreviewSession([block], "en", session)
      expect(projected.presentationIdV1).toBe(presentationIdV1)
      expect(projected.id).toBe(block.id)
      expect(projected.type).toBe(block.type)
      const captured = acceptPreviewCapture(session, commit!)
      expect(JSON.parse(captured.expectedBlock).presentationIdV1).toBe(
        presentationIdV1
      )
      expect(projectPreviewSession([block], "en", null)[0]).toBe(block)
      expect(block.primary.description).toBe(base.block.primary.description)
    }
  )

  it.each(["", "a".repeat(65), "../default"])(
    "refuses malformed occurrence metadata %j before applying unchanged descriptor validation", blockProfile([]),
    (presentationIdV1) => {
      const base = fixture()
      const block = { ...base.block, presentationIdV1 }
      const session = {
        ...base.session,
        ...captureBlockOccurrence([block], "en", "hero")!,
        draft: pm("Rejected edit"),
      }
      expect(validatedPreviewCommit([block], "en", session)).toBeNull()
      expect(projectPreviewSession([block], "en", session)[0]).toBe(block)
    }
  )

  it("still refuses malformed actual values after separating valid presentation metadata", blockProfile([]), () => {
    const base = fixture()
    const block = {
      ...base.block,
      presentationIdV1: "centered",
      primary: { ...base.block.primary, eyebrow: 42 },
    } as unknown as typeof base.block
    const session = {
      ...base.session,
      ...captureBlockOccurrence([block], "en", "hero")!,
      draft: pm("Rejected malformed content"),
    }
    expect(validatedPreviewCommit([block], "en", session)).toBeNull()
  })

  it("renders consecutive buffers with the real renderer without changing the base", blockProfile([]), () => {
    const { block, session } = fixture()
    const base = JSON.stringify(block)
    for (const text of ["Keystroke one", "Keystroke one two"]) {
      const [projected] = projectPreviewSession([block], "en", {
        ...session,
        draft: pm(text),
      })
      if (projected.type !== "hero-agency") throw new Error("fixture type")
      expect(
        renderToStaticMarkup(
          <HeroAgency
            block={projected}
            ctx={{ locale: "en", defaultLocale: "en", pagePaths: {} }}
          />
        )
      ).toContain(text)
      expect(JSON.stringify(block)).toBe(base)
    }
    expect(projectPreviewSession([block], "en", null)).toEqual([block])
  })

  it("refuses an externally changed occurrence, descriptor mismatch, and profile widening", blockProfile([]), () => {
    const { block, session } = fixture()
    expect(
      validatedPreviewCommit(
        [{ ...block, primary: { ...block.primary, eyebrow: "external" } }],
        "en",
        session
      )
    ).toBeNull()
    expect(validatedPreviewCommit([block], "fr", session)).toBeNull()
    expect(
      validatedPreviewCommit([block], "en", {
        ...session,
        fieldPath: "primary.missing",
      })
    ).toBeNull()
    expect(
      validatedPreviewCommit([block], "en", { ...session, kind: "text" })
    ).toBeNull()
    expect(
      validatedPreviewCommit([block], "en", {
        ...session,
        draft: JSON.stringify({
          type: "doc",
          content: [{ type: "blockquote", content: [{ type: "paragraph" }] }],
        }),
      })
    ).toBeNull()
  })

  it("accepts a rebased inline value when a sibling field changed in the same occurrence", blockProfile([]), () => {
    const { block, session } = fixture()
    const current = {
      ...block,
      primary: { ...block.primary, eyebrow: "External form edit" },
    }
    const rebased = validatedPreviewCommit([current], "en", {
      ...session,
      expectedBlock: JSON.stringify(current),
      draft: pm("Inline buffer after rebase"),
    })

    expect(rebased?.value).toBe(pm("Inline buffer after rebase"))
    const [projected] = projectPreviewSession([current], "en", {
      ...session,
      expectedBlock: JSON.stringify(current),
      draft: pm("Inline buffer after rebase"),
    })
    if (projected.type !== "hero-agency")
      throw new Error("Expected projected Hero Agency block")
    expect(projected.primary.eyebrow).toBe("External form edit")
    expect(projected.primary.description).toBe(pm("Inline buffer after rebase"))
  })

  it("rebases captured Save while preserving newer typing and cancellation baseline", blockProfile([]), () => {
    const { block, session } = fixture()
    const captured = validatedPreviewCommit([block], "en", {
      ...session,
      draft: pm("captured"),
    })!
    const rebased = acceptPreviewCapture(
      { ...session, draft: pm("newer typing") },
      captured
    )
    const [savedBase] = projectPreviewSession([block], "en", {
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
    const block = { ...createSampleBlock("features-icon-grid"), id: "features" }
    block.items = [0, 1, 2].map((index) => ({
      ...block.items[0],
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
      ...captureBlockOccurrence([block], "en", block.id, "items.1.body", 7)!,
      fieldPath: "items.1.body",
      kind: "richText",
      draft: pm("Middle edited"),
      cancellationValue: pm("Equal"),
      label: "Title",
    }
    return { block, session }
  }
  it("patches only the selected equal body and preserves full sibling values", blockProfile([]), () => {
    const { block, session } = repeated()
    const [projected] = projectPreviewSession([block], "en", session, 7)
    if (projected.type !== "features-icon-grid") throw new Error("fixture type")
    expect(projected.items).toEqual([
      block.items[0],
      { ...block.items[1], body: session.draft },
      block.items[2],
    ])
    expect(block.items[1].body).toBe(pm("Equal"))
  })
  it.each([
    "reorder",
    "remove",
    "sibling-field",
    "epoch",
    "locale",
    "wrong-path",
    "missing-binding",
  ])("refuses %s without retargeting", blockProfile([]), (change) => {
    const { block, session } = repeated()
    const current =
      change === "reorder"
        ? { ...block, items: [...block.items].reverse() }
        : change === "remove"
          ? { ...block, items: block.items.slice(1) }
          : change === "sibling-field"
            ? {
                ...block,
                items: block.items.map((item, index) =>
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
            : block
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
  it("deliberately rebases its own captured value while retaining newer typing", blockProfile([]), () => {
    const { block, session } = repeated()
    const captured = validatedPreviewCommit([block], "en", session, 7)!
    const rebased = acceptPreviewCapture(
      { ...session, draft: pm("Later typing") },
      captured
    )
    const [saved] = projectPreviewSession([block], "en", session, 7)
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
    rendererSource: "components/blocks/hero-agency.tsx",
    presentationId: "default",
    sourceHash: "a".repeat(64),
  }
  it("retains the exact compiled pin through a valid commit and accepted content rebase", blockProfile([]), () => {
    const { block, session } = fixture()
    const pinned = { ...session, rendererSource: pin, draft: pm("Saved text") }
    const commit = validatedPreviewCommit([block], "en", pinned)!
    expect(commit.rendererSource).toEqual(pin)
    expect(acceptPreviewCapture(pinned, commit).rendererSource).toEqual(pin)
    expect(
      acceptPreviewCapture(pinned, {
        ...commit,
        rendererSource: { ...pin, sourceHash: "b".repeat(64) },
      })
    ).toBe(pinned)
  })
  it("an observed stale pin refuses both projection and exact-byte revert rebase", blockProfile([]), () => {
    const { block, session } = fixture()
    const pinned = {
      ...session,
      rendererSource: pin,
      sourceInvalidated: true,
      draft: pm("Keep me"),
    }
    expect(validatedPreviewCommit([block], "en", pinned)).toBeNull()
    expect(projectPreviewSession([block], "en", pinned)[0]).toBe(block)
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
    "validates title edits without changing sibling bytes %j", blockProfile([]),
    async (description) => {
      const { adoptHeroTitles } =
        await import("@/lib/rich-text/adopt-hero-titles")
      const base = fixture()
      const block = {
        ...base.block,
        primary: { ...base.block.primary, description },
      }
      const session = {
        ...base.session,
        ...captureBlockOccurrence([block], "en", block.id)!,
        fieldPath: "primary.title",
        draft: pm("Edited title"),
      }
      const before = JSON.stringify(block)
      const commit = validatedPreviewCommit([block], "en", session)
      expect(commit?.value).toContain("Edited title")
      expect(commit?.expectedBlock).toBe(before)
      const [projected] = projectPreviewSession([block], "en", session)
      if (projected.type !== "hero-agency")
        throw new Error("Expected Hero Agency")
      expect(projected.primary.description).toBe(description)
      const prepared = adoptHeroTitles([projected], "en")
      expect(prepared.value[0].primary).toMatchObject({
        description: expect.stringContaining('"type":"doc"'),
      })
      expect(JSON.stringify(block)).toBe(before)
      expect(projectPreviewSession([block], "en", null)[0]).toBe(block)
    }
  )
  it("refuses a malformed structured sibling rather than reinterpreting it", blockProfile([]), () => {
    const base = fixture()
    const block = {
      ...base.block,
      primary: { ...base.block.primary, description: '{"type":"doc"}' },
    }
    const session = {
      ...base.session,
      ...captureBlockOccurrence([block], "en", block.id)!,
      fieldPath: "primary.title",
      draft: pm("Edited"),
    }
    expect(validatedPreviewCommit([block], "en", session)).toBeNull()
  })
  it.each([
    "<p>New HTML</p>",
    '"non-doc"',
    '{"type":"doc","content":[{"type":"paragraph","content":[{"type":"paragraph"}]}]}',
  ])("never adopts a newly edited non-title value %j", blockProfile([]), (draft) => {
    const { block, session } = fixture()
    expect(
      validatedPreviewCommit([block], "en", { ...session, draft })
    ).toBeNull()
  })
})

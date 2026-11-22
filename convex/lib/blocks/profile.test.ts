import { blockProfile } from "@/test-utils/block-profile"
import { describe, expect, test } from "vitest"
import { assertBlockProfileContent } from "./profile"

describe("installed block profile blockers", () => {
  test.each(["contact-form", "site-search", "cta-band"])(
    "the current profile refuses both stored and incoming %s content",
    (type) => {
      const content = {
        en: { blocks: [{ id: "parked", type, enabled: true, primary: {} }] },
      }
      const empty = { en: { blocks: [] } }
      for (const contents of [
        [content, empty],
        [empty, content],
      ]) {
        expect(() => assertBlockProfileContent("edit", contents)).toThrow(
          new RegExp(`content\\.en\\.blocks\\[0\\].*${type}`)
        )
      }
    }
  )
  test("a stored disabled block blocks an edit with its exact content path", blockProfile([]), () => {
    const existingContent = {
      en: {
        blocks: [
          {
            id: "stored-contact",
            type: "contact-form",
            enabled: true,
            primary: {},
          },
        ],
      },
    }
    const submittedContent = { en: { blocks: [] } }

    expect(() =>
      assertBlockProfileContent(
        "edit",
        [existingContent, submittedContent],
        ["hero-agency"]
      )
    ).toThrow(
      'Cannot edit content because installed block code is unavailable at content.en.blocks[0] (type "contact-form").'
    )
  })

  test("duplicate locations from stored and submitted content are reported once", blockProfile([]), () => {
    const content = {
      en: {
        blocks: [
          {
            id: "stored-contact",
            type: "contact-form",
            enabled: true,
            primary: {},
          },
        ],
      },
    }

    expect(() =>
      assertBlockProfileContent("edit", [content, content], ["hero-agency"])
    ).toThrow(/content\.en\.blocks\[0\].*contact-form.*\.$/)
  })
})

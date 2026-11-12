import { sliceProfile } from "@/test-utils/slice-profile"
import { describe, expect, test } from "vitest"
import { assertSliceProfileContent } from "./profile"

describe("installed slice profile blockers", () => {
  test.each(["contact-form", "site-search", "cta-band"])(
    "the current profile refuses both stored and incoming %s content",
    (type) => {
      const content = {
        en: { slices: [{ id: "parked", type, enabled: true, primary: {} }] },
      }
      const empty = { en: { slices: [] } }
      for (const contents of [
        [content, empty],
        [empty, content],
      ]) {
        expect(() => assertSliceProfileContent("edit", contents)).toThrow(
          new RegExp(`content\\.en\\.slices\\[0\\].*${type}`)
        )
      }
    }
  )
  test("a stored disabled slice blocks an edit with its exact content path", sliceProfile([]), () => {
    const existingContent = {
      en: {
        slices: [
          {
            id: "stored-contact",
            type: "contact-form",
            enabled: true,
            primary: {},
          },
        ],
      },
    }
    const submittedContent = { en: { slices: [] } }

    expect(() =>
      assertSliceProfileContent(
        "edit",
        [existingContent, submittedContent],
        ["hero-agency"]
      )
    ).toThrow(
      'Cannot edit content because installed block code is unavailable at content.en.slices[0] (type "contact-form").'
    )
  })

  test("duplicate locations from stored and submitted content are reported once", sliceProfile([]), () => {
    const content = {
      en: {
        slices: [
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
      assertSliceProfileContent("edit", [content, content], ["hero-agency"])
    ).toThrow(/content\.en\.slices\[0\].*contact-form.*\.$/)
  })
})

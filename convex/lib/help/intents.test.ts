// Tests for parseHelpAnswer: the pure parser that splits a model answer into
// prose + an optional validated suggestedAction. No model is involved here;
// these are the only correctness guarantees the panel relies on.
import { describe, expect, test } from "vitest"
import {
  HELP_INTENTS,
  intentEnumForPrompt,
  parseHelpAnswer,
} from "./intents"

describe("parseHelpAnswer", () => {
  test("returns trimmed answer + suggestedAction for a valid trailing block", () => {
    const raw =
      'To start a new page, go to Pages and choose New page.\n\n```json\n{"intent": "create-page"}\n```'
    const parsed = parseHelpAnswer(raw)
    expect(parsed.answer).toBe(
      "To start a new page, go to Pages and choose New page."
    )
    expect(parsed.suggestedAction).toEqual({
      id: "create-page",
      label: HELP_INTENTS["create-page"].label,
      href: HELP_INTENTS["create-page"].href,
    })
  })

  test("accepts an unlabelled trailing fence (just ```…```)", () => {
    const raw = 'Use Media.\n```\n{"intent":"open-media"}\n```'
    const parsed = parseHelpAnswer(raw)
    expect(parsed.suggestedAction?.id).toBe("open-media")
  })

  test("drops an unknown intent id but keeps the answer prose", () => {
    const raw =
      'You can find that in Settings.\n```json\n{"intent": "make-coffee"}\n```'
    const parsed = parseHelpAnswer(raw)
    expect(parsed.answer).toBe("You can find that in Settings.")
    expect(parsed.suggestedAction).toBeUndefined()
  })

  test("drops a malformed JSON block but keeps the answer prose", () => {
    const raw =
      'Open Modules.\n```json\n{intent: open-settings-modules}\n```'
    const parsed = parseHelpAnswer(raw)
    expect(parsed.answer).toBe("Open Modules.")
    expect(parsed.suggestedAction).toBeUndefined()
  })

  test("drops a JSON object that has no string intent field", () => {
    const raw = 'See Settings.\n```json\n{"href": "/admin/settings/ai"}\n```'
    const parsed = parseHelpAnswer(raw)
    expect(parsed.suggestedAction).toBeUndefined()
  })

  test("returns the whole answer when there is no trailing fence", () => {
    const raw = "Go to Settings → Languages to add a locale."
    const parsed = parseHelpAnswer(raw)
    expect(parsed.answer).toBe(raw)
    expect(parsed.suggestedAction).toBeUndefined()
  })

  test("ignores a JSON fence that is NOT at the end (mid-answer example)", () => {
    // The model may quote a JSON example mid-answer (e.g. when explaining how
    // a feature is configured). That must NOT be parsed as a suggestion.
    const raw = [
      "Configure it like this:",
      "```json",
      '{"intent": "create-page"}',
      "```",
      "and then save.",
    ].join("\n")
    const parsed = parseHelpAnswer(raw)
    expect(parsed.answer).toBe(raw)
    expect(parsed.suggestedAction).toBeUndefined()
  })

  test("tolerates extra whitespace after the trailing fence", () => {
    const raw = 'Open Pages.\n```json\n{"intent":"open-pages"}\n```\n\n  '
    const parsed = parseHelpAnswer(raw)
    expect(parsed.suggestedAction?.id).toBe("open-pages")
  })
})

describe("HELP_INTENTS", () => {
  test("offers only owner screens the starter has, and no Members screen", () => {
    expect(Object.keys(HELP_INTENTS).sort()).toEqual([
      "create-page",
      "open-media",
      "open-menus",
      "open-pages",
      "open-redirects",
      "open-settings",
      "open-settings-ai",
      "open-settings-email",
      "open-settings-languages",
      "open-settings-modules",
      "open-trash",
    ])
    expect(parseHelpAnswer('x\n```json\n{"intent":"open-settings-members"}\n```'))
      .toEqual({ answer: "x" })
  })
})

describe("intentEnumForPrompt", () => {
  test("includes every registered intent exactly once", () => {
    const text = intentEnumForPrompt()
    for (const id of Object.keys(HELP_INTENTS)) {
      // Each line is `- <id>: …` so a substring match is safe.
      expect(text).toContain(`- ${id}:`)
    }
    // No id should be duplicated.
    for (const id of Object.keys(HELP_INTENTS)) {
      const occurrences = text.split(`- ${id}:`).length - 1
      expect(occurrences).toBe(1)
    }
  })
})

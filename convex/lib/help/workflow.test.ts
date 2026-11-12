import { describe, expect, test } from "vitest"
import { HELP_CORPUS } from "./corpus"
import { intentEnumForPrompt } from "./intents"
import { installedSliceDefs, INSTALLED_SLICE_TYPES } from "../slices"
import {
  buildHelpGenerationInput,
  parseHelpGenerationOutput,
  toPlainHelpText,
} from "./workflow"

function currentContext(): string {
  const corpus = HELP_CORPUS.map(
    (entry) => `## ${entry.title}\n${entry.body}`
  ).join("\n\n")
  const slices = INSTALLED_SLICE_TYPES.map(
    (type) => `- ${type}: ${installedSliceDefs[type].aiHint.purpose}`
  ).join("\n")
  return `${corpus}\n\nBlock types currently available:\n${slices}`
}

describe("buildHelpGenerationInput", () => {
  test("grounds menu help in one shared structure with localized text", () => {
    expect(currentContext()).toContain(
      "Menus use one shared structure and destination set"
    )
    expect(currentContext()).not.toContain("Menus are managed per language")
  })

  test("renders the stored templates with deterministic grounding and route normalization", () => {
    const systemPrompt =
      "  Screen=[{route}]\nIntents:\n{intentEnum}\nKeep {unknown} intact.  "
    const userPromptTemplate =
      "  Question=[{question}]\nScreen=[{route}]\nContext:\n{context}\nKeep {unknown} intact.  "

    const withDefaultRoute = buildHelpGenerationInput({
      question: "  How do I create?  ",
      systemPrompt,
      userPromptTemplate,
    })

    expect(withDefaultRoute).toEqual({
      system: `  Screen=[admin]\nIntents:\n${intentEnumForPrompt()}\nKeep {unknown} intact.  `,
      prompt: `  Question=[How do I create?]\nScreen=[admin]\nContext:\n${currentContext()}\nKeep {unknown} intact.  `,
      sources: ["Create and edit a page"],
    })
    expect(withDefaultRoute.prompt).toContain(
      "Turn the AI module on in Settings › Modules"
    )
    expect(withDefaultRoute.prompt).not.toContain("Development route")
    expect(withDefaultRoute.prompt).not.toContain("Settings › Members")
    expect(withDefaultRoute.prompt).not.toContain(
      "AI features (translation, content writing, and the help assistant) are bring-your-own-key"
    )

    const withEmptyRoute = buildHelpGenerationInput({
      question: "  How do I create?  ",
      route: "",
      systemPrompt,
      userPromptTemplate,
    })

    expect(withEmptyRoute.system).toContain("Screen=[]")
    expect(withEmptyRoute.prompt).toContain("Screen=[]")
  })
})

describe("parseHelpGenerationOutput", () => {
  test("returns the answer as plain text and keeps the shortcut", () => {
    expect(
      parseHelpGenerationOutput(
        'Open [Trash](/admin/trash), find the page, and choose **Restore**.\n```json\n{"intent":"open-trash"}\n```'
      )
    ).toEqual({
      answer: "Open Trash, find the page, and choose Restore.",
      suggestedAction: {
        id: "open-trash",
        label: "Open Trash",
        href: "/admin/trash",
      },
    })
    // Markdown with no text left is still an empty answer.
    expect(() => parseHelpGenerationOutput("****")).toThrow(/empty/i)
  })

  test("fails closed on empty or oversized prose while preserving closed-intent parsing", () => {
    expect(() => parseHelpGenerationOutput("   ")).toThrow(/empty/i)
    expect(() => parseHelpGenerationOutput("x".repeat(8_001))).toThrow(
      /too long/i
    )

    expect(
      parseHelpGenerationOutput(
        'Open Media.\n```json\n{"intent":"open-media"}\n```'
      )
    ).toEqual({
      answer: "Open Media.",
      suggestedAction: {
        id: "open-media",
        label: "Open Media",
        href: "/admin/media",
      },
    })
  })
})

// The first five inputs are real answers from the live walk (2026-11-10).
describe("toPlainHelpText", () => {
  test.each([
    [
      "Go to **Settings → Modules** and turn on **Multilingual**. Then open **Settings → Languages** and add French. From the page editor, use the language tabs to write the French version.",
      "Go to Settings → Modules and turn on Multilingual. Then open Settings → Languages and add French. From the page editor, use the language tabs to write the French version.",
    ],
    [
      "Open [Pages](/admin/pages), select the page, then choose **Publish** in the editor or the Pages list. Fix any blockers the editor flags; review warnings and choose **Publish anyway** if you want to proceed.",
      "Open Pages, select the page, then choose Publish in the editor or the Pages list. Fix any blockers the editor flags; review warnings and choose Publish anyway if you want to proceed.",
    ],
    [
      "Open [Trash](/admin/trash), find the page, and choose **Restore**.",
      "Open Trash, find the page, and choose Restore.",
    ],
    [
      "I’m not sure from this admin help context; it covers managing pages, not geography.",
      "I’m not sure from this admin help context; it covers managing pages, not geography.",
    ],
    [
      "Ouvrez **Corbeille**, puis choisissez **Restaurer** sur la page concernée.",
      "Ouvrez Corbeille, puis choisissez Restaurer sur la page concernée.",
    ],
  ])("converts the walk answer %#", (input, expected) => {
    expect(toPlainHelpText(input)).toBe(expected)
  })

  test("keeps numbered steps one per line without asterisks", () => {
    expect(
      toPlainHelpText(
        "1. Open Content.\n2. Choose **New content**.\n3. Enter a title."
      )
    ).toBe("1. Open Content.\n2. Choose New content.\n3. Enter a title.")
  })

  test("keeps bullets as '- ' lines and a list after a sentence on the next line", () => {
    expect(toPlainHelpText("You can:\n- add a page\n- **archive** it")).toBe(
      "You can:\n- add a page\n- archive it"
    )
  })

  test("keeps two paragraphs as two paragraphs", () => {
    expect(toPlainHelpText("First **idea**.\n\nSecond idea.")).toBe(
      "First idea.\n\nSecond idea."
    )
  })

  test("keeps line breaks inside a paragraph", () => {
    expect(toPlainHelpText("line one\nline two")).toBe("line one\nline two")
  })

  test("keeps heading, inline code and code block text, drops the markers", () => {
    expect(
      toPlainHelpText(
        "## Steps\n\nRun `npx convex dev`.\n\n```\nsome code\n```"
      )
    ).toBe("Steps\n\nRun npx convex dev.\n\nsome code")
  })

  test("keeps a link's text and never its target", () => {
    const out = toPlainHelpText("See [the guide](https://example.com/x) now.")
    expect(out).toBe("See the guide now.")
    expect(out).not.toContain("example.com")
  })

  test.each([
    "Settings › Languages",
    "you & your site's <title>",
    "a_b_c",
    "2 * 3 * 4",
    "C'est l'écran « Médias ».",
  ])("lets %j through untouched, with no HTML entities", (text) => {
    expect(toPlainHelpText(text)).toBe(text)
  })

  // The conversion must never reorder text: nested lists stay where the
  // source put them, indented under their item.
  const words = (text: string) => text.match(/\p{L}+/gu) ?? []
  test.each([
    {
      name: "bullet item with a nested list, then a paragraph",
      input: "- Open Content.\n  - Choose a page.\n\n  Publish it.",
      expected: "- Open Content.\n  - Choose a page.\n\n  Publish it.",
    },
    {
      name: "numbered item with a nested list, then a paragraph",
      input: "1. Open Content.\n   1. Choose a page.\n\n   Publish it.",
      expected: "1. Open Content.\n   1. Choose a page.\n\n   Publish it.",
    },
    {
      name: "a list inside a list inside a list",
      input: "- a\n  - b\n    - c\n- d",
      expected: "- a\n  - b\n    - c\n- d",
    },
    {
      name: "an item holding a paragraph, a nested list, then a paragraph",
      input: "- Intro text.\n\n  - Nested one.\n\n  Closing text.",
      expected: "- Intro text.\n\n  - Nested one.\n\n  Closing text.",
    },
    {
      name: "a blockquote holding a list, then a paragraph",
      input: "> - one\n> - two\n>\n> After.",
      expected: "- one\n- two\n\nAfter.",
    },
    {
      name: "an item holding a code block, then a paragraph",
      input: "- Run:\n\n  ```\n  npm test\n  ```\n\n  Then stop.",
      expected: "- Run:\n\n  npm test\n\n  Then stop.",
    },
  ])("keeps source order: $name", ({ input, expected }) => {
    const out = toPlainHelpText(input)
    expect(out).toBe(expected)
    expect(words(out)).toEqual(words(input))
  })
})

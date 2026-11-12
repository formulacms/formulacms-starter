import { createTranslator } from "next-intl"
import en from "@/messages/admin/en.json"
import { expect, test } from "vitest"
import {
  languageChangeEditorNotice,
  sourcePublicationWarning,
} from "./language-notice"

const t = createTranslator({
  locale: "en",
  messages: en,
  namespace: "editor.page.languageChange",
})

// F09b: the editor says shared fields are the same in every language wherever
// they are edited during a replacement, and marks the new-language version
// private and in need of confirmation.
test("the editor notice appears only during a replacement", () => {
  expect(languageChangeEditorNotice(null, false, t)).toBeNull()
  expect(languageChangeEditorNotice(undefined, true, t)).toBeNull()
  const notice = {
    sourceLocale: "en",
    targetLocale: "fr",
    sharedChangedSinceSourcePublication: false,
  }
  const ordinary = languageChangeEditorNotice(notice, false, t)!
  expect(ordinary).toHaveLength(2)
  expect(ordinary[1]).toContain("same in every language")
  const writing = languageChangeEditorNotice(notice, true, t)!
  expect(writing.join(" ")).toContain("stays private until your site switches")
  expect(writing.join(" ")).toContain("confirm the text again")
  expect(writing.at(-1)).toContain("same in every language")
})

// F09 contract proof row 39 (editor copy): the owner is warned before a source
// publication that would publish a changed Shared Draft during a replacement.

test("no warning outside a replacement or when the Shared Draft is unchanged", () => {
  expect(sourcePublicationWarning(null, t)).toBeNull()
  expect(sourcePublicationWarning(undefined, t)).toBeNull()
  expect(
    sourcePublicationWarning(
      {
        sourceLocale: "en",
        targetLocale: "fr",
        sharedChangedSinceSourcePublication: false,
      },
      t
    )
  ).toBeNull()
})

test("a changed Shared Draft during a replacement warns before publish", () => {
  const notice = {
    sourceLocale: "en",
    targetLocale: "fr",
    sharedChangedSinceSourcePublication: true,
  }
  const publish = sourcePublicationWarning(notice, t)!
  expect(publish.title).toBe("Publish while your site changes language?")
  expect(publish.confirmText).toBe("Publish anyway")
  expect(publish.description).toContain("shared fields changed")
  expect(publish.description).toContain("goes live now")
})

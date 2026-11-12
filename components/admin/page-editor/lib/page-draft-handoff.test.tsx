import { beforeEach, describe, expect, test } from "vitest"
import {
  consumePageDraftHandoff,
  readPageDraftHandoff,
  stashPageDraftHandoff,
  type PageDraftHandoff,
} from "./page-draft-handoff"

const pageId = "page_1"
const draft = { slices: [] } as PageDraftHandoff
const storageKey = `nextcms:page-ai-draft:${pageId}`

describe("page draft handoff", () => {
  beforeEach(() => {
    window.sessionStorage.clear()
  })

  test("preserves the one-shot draft namespace across a deployment", () => {
    const legacyMark = ["next", "cms"].join("")
    expect(stashPageDraftHandoff(pageId, draft)).toBe(true)
    expect(
      window.sessionStorage.getItem(`${legacyMark}:page-ai-draft:${pageId}`)
    ).not.toBeNull()
    expect(readPageDraftHandoff(pageId)).toEqual(draft)
    expect(readPageDraftHandoff(pageId)).toEqual(draft)
    expect(consumePageDraftHandoff(pageId)).toEqual(draft)
    expect(readPageDraftHandoff(pageId)).toBeNull()
  })

  test.each(["not JSON", "null", JSON.stringify({ slices: {} })])(
    "keeps the existing parse guard for %s",
    (stored) => {
      window.sessionStorage.setItem(storageKey, stored)
      expect(readPageDraftHandoff(pageId)).toBeNull()
    }
  )
})

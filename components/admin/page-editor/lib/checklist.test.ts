import { describe, it, expect } from "vitest"
import {
  checklistItemKey,
  checklistItemsKey,
  publishChecklistCountLabel,
  translateChecklistItem,
} from "./checklist"
import { createTranslator } from "next-intl"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import type { PrePublishChecklistItem } from "./types"

function item(
  partial: Partial<PrePublishChecklistItem> & { code: string }
): PrePublishChecklistItem {
  return { severity: "warning", message: "", ...partial }
}

describe("checklistItemKey", () => {
  it("combines code with the joined locales", () => {
    expect(checklistItemKey(item({ code: "A", locales: ["en", "fr"] }))).toBe(
      "A:en,fr"
    )
  })

  it("uses an empty locale segment when locales are absent", () => {
    expect(checklistItemKey(item({ code: "A" }))).toBe("A:")
  })
})

describe("checklistItemsKey", () => {
  it("is order-independent (keys are sorted before joining)", () => {
    const a = [item({ code: "B" }), item({ code: "A" })]
    const b = [item({ code: "A" }), item({ code: "B" })]
    expect(checklistItemsKey(a)).toBe(checklistItemsKey(b))
    expect(checklistItemsKey(a)).toBe("A:|B:")
  })
})

describe("publishChecklistCountLabel", () => {
  it("prioritises blockers over warnings", () => {
    expect(publishChecklistCountLabel(2, 3)).toBe("2 blockers")
    expect(publishChecklistCountLabel(1, 0)).toBe("1 blocker")
  })

  it("shows warnings when there are no blockers", () => {
    expect(publishChecklistCountLabel(0, 1)).toBe("1 warning")
    expect(publishChecklistCountLabel(0, 4)).toBe("4 warnings")
  })

  it("reports Ready when clean", () => {
    expect(publishChecklistCountLabel(0, 0)).toBe("Ready")
  })
})


const knownCodes = [
  "missing_default_locale_title", "missing_default_locale_content", "missing_seo_title", "missing_seo_description", "missing_enabled_locale_translation",
  "missing_required_slice_field", "missing_required_field", "missing_image_alt_text", "broken_internal_link", "archived_relation_target",
] as const

describe.each([["en", en], ["fr", fr]] as const)("checklist code translation in %s", (locale, messages) => {
  const t = createTranslator({ locale, messages: messages.editor.prePublish.items })
  it.each(knownCodes)("translates legacy %s without rendering the stored English message", (code) => {
    const text = translateChecklistItem(item({ code, message: "STORED ENGLISH", locales: ["en"] }), t)
    expect(text).not.toContain("STORED ENGLISH")
    expect(text).not.toMatch(/\{\w+\}/)
    expect(text.length).toBeGreaterThan(10)
  })
  it("uses the compatibility message only for an unknown code", () => {
    expect(translateChecklistItem(item({ code: "future_code", message: "Future compatibility message" }), t)).toBe("Future compatibility message")
  })
  it("keeps distinct required image, related page, and body messages", () => {
    const base = { code: "missing_required_slice_field", locales: ["fr"], field: "content.fr.slices.hero.title", message: "ENGLISH" }
    const image = translateChecklistItem(item({ ...base, params: { variant: "image", sliceType: "hero" } }), t)
    const relation = translateChecklistItem(item({ ...base, params: { variant: "relation", sliceType: "hero" } }), t)
    const body = translateChecklistItem(item({ code: "missing_required_field", field: "body", locales: ["fr"] }), t)
    expect(image).toBe(locale === "fr" ? "FR hero : une image obligatoire est manquante." : "FR hero is missing a required image.")
    expect(relation).toBe(locale === "fr" ? "FR hero : une page liée obligatoire est manquante." : "FR hero is missing a required related page.")
    expect(body).toBe(t("missingBody", { locale: "FR" }))
  })
  it("renders link and reference variants with localized contextual labels and editorial titles", () => {
    const labels = { contentType: () => locale === "fr" ? "Article" : "Post", field: () => locale === "fr" ? "Nom" : "Name" }
    expect(translateChecklistItem(item({ code: "missing_required_field", params: { contentType: "post", fieldName: "name" } }), t, labels)).toBe(locale === "fr" ? "Article : le champ obligatoire Nom est vide." : "Post is missing required Name.")
    const wrongType = translateChecklistItem(item({ code: "broken_internal_link", params: { variant: "disallowed_type", contentType: "post", targetTitle: "Équipe" } }), t, labels)
    expect(wrongType).toBe(t("disallowedTarget", { contentType: labels.contentType(), title: "Équipe" }))
    const missingLink = translateChecklistItem(item({ code: "broken_internal_link", params: { variant: "missing_link_target", sliceType: "hero" }, locales: ["fr"] }), t)
    expect(missingLink).toBe(t("missingLinkTarget", { scope: "FR ", sliceType: "hero" }))
    for (const contentType of [undefined, "post"]) {
      for (const localeSpecific of [false, true]) {
        const text = translateChecklistItem(item({ code: "archived_relation_target", params: { contentType, targetTitle: "Équipe", localeSpecific }, locales: ["en", "fr"] }), t, labels)
        const key = contentType ? localeSpecific ? "unpublishedDescriptorTargetLocales" : "unpublishedDescriptorTarget" : localeSpecific ? "unpublishedTargetLocales" : "unpublishedTarget"
        expect(text).toBe(t(key, { title: "Équipe", locale: "EN, FR", contentType: labels.contentType() }))
      }
    }
  })
})

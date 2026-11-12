import { describe, expect, it } from "vitest"
import { gatedBinding } from "./admin-contributions"
import { ADMIN_AI_HELP_BROWSER_BINDING } from "./contributions/ai-help"
import { ADMIN_AI_TRANSLATION_BROWSER_BINDING } from "./contributions/ai-translation"
import { ADMIN_AI_WRITING_BROWSER_BINDING } from "./contributions/ai-writing"

// A host reads an `ADMIN_AI_*_BINDING` constant only through `gatedBinding`.
// The binding here is a stand-in; Settings AI, Writing, Translation and Help are the installed ones.
const binding = { render: () => "participant" }

describe("gatedBinding (the binding-seam enablement gate)", () => {
  it("returns the binding while the owning module is effective", () => {
    expect(gatedBinding(binding, "ai-writing", new Set(["ai-writing"]))).toBe(
      binding
    )
  })

  it("returns null when the module is not effective", () => {
    expect(
      gatedBinding(
        binding,
        "ai-writing",
        new Set(["redirects", "multilingual"])
      )
    ).toBeNull()
  })

  it("fails closed while the effective state is unknown", () => {
    for (const unknown of [null, undefined]) {
      expect(gatedBinding(binding, "ai-writing", unknown)).toBeNull()
    }
  })

  it("returns null for a null binding even when the module is effective", () => {
    expect(
      gatedBinding<typeof binding>(null, "ai-writing", new Set(["ai-writing"]))
    ).toBeNull()
  })

  it("returns the installed Translation binding only while the AI module is effective", () => {
    expect(ADMIN_AI_TRANSLATION_BROWSER_BINDING).not.toBeNull()
    expect(
      gatedBinding(ADMIN_AI_TRANSLATION_BROWSER_BINDING, "ai", new Set(["ai"]))
    ).toBe(ADMIN_AI_TRANSLATION_BROWSER_BINDING)
    expect(
      gatedBinding(
        ADMIN_AI_TRANSLATION_BROWSER_BINDING,
        "ai",
        new Set(["multilingual"])
      )
    ).toBeNull()
  })

  it("returns the installed Writing binding only while the AI module is effective", () => {
    expect(ADMIN_AI_WRITING_BROWSER_BINDING).not.toBeNull()
    expect(
      gatedBinding(ADMIN_AI_WRITING_BROWSER_BINDING, "ai", new Set(["ai"]))
    ).toBe(ADMIN_AI_WRITING_BROWSER_BINDING)
    expect(
      gatedBinding(
        ADMIN_AI_WRITING_BROWSER_BINDING,
        "ai",
        new Set(["multilingual"])
      )
    ).toBeNull()
  })

  it("returns the installed Help binding only while the AI module is effective", () => {
    expect(ADMIN_AI_HELP_BROWSER_BINDING).not.toBeNull()
    expect(
      gatedBinding(ADMIN_AI_HELP_BROWSER_BINDING, "ai", new Set(["ai"]))
    ).toBe(ADMIN_AI_HELP_BROWSER_BINDING)
    expect(
      gatedBinding(ADMIN_AI_HELP_BROWSER_BINDING, "ai", new Set(["multilingual"]))
    ).toBeNull()
  })
})

import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

const read = (path: string) => readFileSync(path, "utf8")

describe("caught error display consumer boundary", () => {
  it("redirect UI never extracts arbitrary Error.message for display", () => {
    const source = read(
      "app/(core)/admin/(authenticated)/redirects/redirects-manager.tsx"
    )
    expect(source).not.toContain("function extractErrorMessage")
    expect(source).toContain("useCaughtError")
  })
  it("admin and auth consumers use the shared allowlist", () => {
    for (const path of [
      "components/admin/archive-list.tsx",
      "components/admin/duplicate-page-dialog.tsx",
      "components/admin/general-settings.tsx",
      "components/admin/import-markdown-dialog.tsx",
      "components/admin/media-browser.tsx",
      "components/admin/media-library.tsx",
      "components/admin/new-page-form.tsx",
      "components/admin/page-editor.tsx",
      "components/admin/pages-list-client.tsx",
      "components/admin/rich-text-editor.tsx",
      "components/admin/trash-list.tsx",
      "components/admin/content-types/content-type-lifecycle-panel.tsx",
      "components/setup/setup-wizard.tsx",
      "app/(core)/(auth)/sign-in/page.tsx",
    ]) {
      const source = read(path)
      expect(source, path).toContain("useCaughtError")
      expect(source, path).not.toMatch(
        /(?:err|error|cause|e) instanceof Error\s*\?\s*(?:err|error|cause|e)\.message\s*:\s*t/
      )
    }
  })
  it("media import preserves guard codes and image reasons", () => {
    const source = read("convex/cms/media.ts")
    expect(source).toContain("code: error.code")
    expect(source).toContain("reason: error.code")
    expect(source).not.toContain("new ConvexError(error.message)")
  })
  it("legacy slug refusal retains diagnostic and carries a stable code", () => {
    const source = read("convex/cms/pages.ts")
    expect(source.match(/code: "SLUG_TAKEN"/g)).toHaveLength(4)
    expect(source.match(/Please choose a different slug/g)).toHaveLength(4)
  })
  it("formatting uses explicit effective admin locale", () => {
    expect(read("components/admin/pages-list-client.tsx")).not.toContain(
      'toLocaleString("en-US"'
    )
    expect(read("components/admin/page-editor.tsx")).not.toContain(
      "toLocaleTimeString()"
    )
    expect(read("components/admin/page-editor.tsx")).not.toContain(
      "toLocaleString()"
    )
    expect(read("components/admin/media-library.tsx")).toContain(
      "formatMediaBytes(media.size, adminLocale, t)"
    )
    expect(read("lib/i18n/admin-format.ts")).not.toContain(".toFixed(1)")
  })
})

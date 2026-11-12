import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

// Tailwind v4 made buttons use the default cursor. The documented restore is
// a base rule for enabled buttons (https://tailwindcss.com/docs/upgrade-guide,
// "Buttons use the default cursor"); disabled buttons keep the default cursor.
describe.each([
  "app/globals.css",
])("hand cursor in %s", (path) => {
  const css = readFileSync(path, "utf8")

  it("gives enabled buttons and [role=button] a pointer cursor", () => {
    const rule = css.match(
      /button:not\(:disabled\),\s*\[role="button"\]:not\(:disabled\)\s*\{([^}]*)\}/
    )
    expect(rule).not.toBeNull()
    expect(rule![1]).toMatch(/cursor:\s*pointer/)
  })

  it("covers menu items, options, checkboxes, switches, radios, tabs, selects, summaries and their labels", () => {
    const rule = css.match(/\/\* hand-cursor:start \*\/([\s\S]*?)\/\* hand-cursor:end \*\//)
    expect(rule).not.toBeNull()
    for (const selector of [
      '[role="menuitem"]',
      '[role="menuitemcheckbox"]',
      '[role="menuitemradio"]',
      '[role="option"]',
      '[role="checkbox"]',
      '[role="switch"]',
      '[role="radio"]',
      '[role="tab"]',
      "select",
      "summary",
      'input[type="checkbox"]',
      'input[type="radio"]',
      "label:has(",
    ]) {
      expect(rule![1]).toContain(selector)
    }
    // Disabled controls keep their cursor.
    expect(rule![1]).toContain(":not(:disabled)")
    expect(rule![1]).toContain('[aria-disabled="true"]')
    expect(rule![1]).toContain("[data-disabled]")
    expect(rule![1]).toMatch(/cursor:\s*pointer/)
  })
})

// The shadcn copies set cursor utilities that would beat the base layer, so
// they carry the pointer themselves and drop it when disabled.
describe.each(["components/ui/dropdown-menu.tsx", "components/ui/select.tsx"])(
  "hand cursor in %s",
  (path) => {
    const source = readFileSync(path, "utf8")

    it("does not force the default cursor on enabled items", () => {
      expect(source).toMatch(/cursor-pointer/)
      expect(source).not.toMatch(/relative flex (w-full )?cursor-default/)
    })
  }
)

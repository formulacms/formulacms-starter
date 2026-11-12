import { readFileSync } from "node:fs"
import { act, cleanup, render, screen } from "@testing-library/react"
import { createTranslator } from "next-intl"
import { toast } from "sonner"
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import CoreLayout from "./layout"

const getLocaleDirection = vi.hoisted(() => vi.fn(() => "ltr"))
const request = vi.hoisted(() => ({ locale: "en" as "en" | "fr" }))
const dictionaries = { en, fr }
beforeEach(() => {
  request.locale = "en"
  vi.clearAllMocks()
})
afterEach(() => {
  cleanup()
  toast.dismiss()
})

vi.mock("next-intl/server", () => ({
  getLocale: async () => request.locale,
  getMessages: async () => dictionaries[request.locale],
  getTranslations: async (namespace: "accessibility") =>
    createTranslator({
      locale: request.locale,
      messages: dictionaries[request.locale],
      namespace,
    }),
}))
vi.mock("@/lib/i18n/config", () => ({ getLocaleDirection }))
vi.mock("@/components/providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/components/theme-provider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("@/components/development-instance-badge", () => ({
  DevelopmentInstanceBadge: () => null,
}))
vi.mock("@/components/hydration-extension-attribute-cleanup", () => ({
  HydrationExtensionAttributeCleanup: () => null,
}))
vi.mock("@/lib/fonts", () => ({ fontClassName: "test-font" }))

describe("core document locale", () => {
  test("uses English language and direction for an effective English admin locale", async () => {
    const document = await CoreLayout({ children: <main>Account</main> })
    expect(document.type).toBe("html")
    expect(document.props.lang).toBe("en")
    expect(document.props.dir).toBe("ltr")
    expect(getLocaleDirection).toHaveBeenCalledWith("en")
  })
  test("French admin layout exposes localized notification and toast close names", async () => {
    request.locale = "fr"
    const document = await CoreLayout({ children: <main>Owner content</main> })
    expect(document.props.lang).toBe("fr")
    // Render the actual layout children without nesting html/body inside the
    // jsdom test container. Sonner itself remains the installed real component.
    render(document.props.children.props.children)
    expect(
      screen.getByRole("region", { name: /^Notifications/ })
    ).toBeInTheDocument()
    act(() => {
      toast("Owner notification", { duration: Infinity })
    })
    expect(
      await screen.findByRole("button", { name: "Fermer la notification" })
    ).toBeInTheDocument()
    expect(screen.getByText("Owner notification")).toBeInTheDocument()
  })
})

describe("grey disabled controls are admin-only", () => {
  test("the core shell (admin, setup, sign-in) marks its body; the public layout never does", async () => {
    const document = await CoreLayout({ children: <main>Account</main> })
    const body = document.props.children
    expect(body.type).toBe("body")
    expect(body.props["data-admin-ui"]).toBeDefined()
    // Portals (menus, dialogs) mount under the body, so they inherit the scope.
    expect(
      readFileSync("app/(public)/[locale]/layout.tsx", "utf8")
    ).not.toContain("data-admin-ui")
  })

  test("every grey-disabled rule is scoped to [data-admin-ui] and uses design tokens", () => {
    const css = readFileSync("app/globals.css", "utf8")
    const start = css.indexOf("/* admin-disabled:start */")
    const end = css.indexOf("/* admin-disabled:end */")
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const block = css.slice(start, end)
    const selectors = block
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("}")
      .filter((rule) => rule.includes("{"))
      .map((rule) => rule.slice(0, rule.indexOf("{")).trim())
    expect(selectors.length).toBeGreaterThan(2)
    for (const selector of selectors) {
      for (const part of selector.split(/,\s*/)) {
        expect(part).toMatch(/^\[data-admin-ui\]/)
      }
    }
    expect(block).toContain("var(--muted)")
    expect(block).toContain("var(--muted-foreground)")
    expect(block).toContain("cursor: not-allowed")
    expect(block).toContain("opacity: 1")
  })
})

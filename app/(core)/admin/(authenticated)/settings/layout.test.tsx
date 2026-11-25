import { cleanup, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, expect, test, vi } from "vitest"
import SettingsLayout from "./layout"

const mocks = vi.hoisted(() => ({
  pathname: "/admin/settings",
  ai: "on",
}))

vi.mock("@/components/admin/admin-module-state-provider", () => ({ useModuleGate: () => ({ state: mocks.ai }) }))

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

vi.mock("next/navigation", () => ({
  usePathname: () => mocks.pathname,
}))

// The starter ships no block library, so Settings has no Blocks item (D-6).
vi.mock("@/components/admin/contributions/authoring-tools", () => ({
  ADMIN_AUTHORING_TOOLS_BROWSER_BINDING: null,
}))

afterEach(cleanup)

beforeEach(() => {
  mocks.pathname = "/admin/settings"
  mocks.ai = "on"
})

test.each([
  ["/admin/settings", "general"],
  ["/admin/settings/account", "account"],
])("Settings at %s uses the shell main and names its navigation", (pathname, active) => {
  mocks.pathname = pathname
  const { container } = render(<SettingsLayout><p>Settings content</p></SettingsLayout>)

  expect(container.querySelector("main")).toBeNull()
  const nav = screen.getByRole("navigation", { name: "heading" })
  expect(nav).toHaveAttribute("aria-labelledby", screen.getByText("heading").id)
  expect(screen.getByRole("link", { name: active })).toHaveAttribute("aria-current", "page")
  expect(container.querySelectorAll('[aria-current="page"]')).toHaveLength(1)
})

test("omits member and role management navigation", () => {
  render(
    <SettingsLayout>
      <p>Settings content</p>
    </SettingsLayout>
  )

  expect(
    screen.queryByRole("link", { name: "members" })
  ).not.toBeInTheDocument()
  expect(screen.queryByRole("link", { name: "roles" })).not.toBeInTheDocument()
})


test("S3 AI nav follows saved on and needs_setup, and hides during off/loading/error", () => {
  mocks.ai = "on"
  const mounted = render(<SettingsLayout><p>Content</p></SettingsLayout>)
  expect(screen.getByRole("link", { name: "ai" })).toHaveAttribute("href", "/admin/settings/ai")
  for (const state of ["needs_setup", "off", "loading", "error"]) {
    mocks.ai = state
    mounted.rerender(<SettingsLayout><p>Content</p></SettingsLayout>)
    if (state === "needs_setup") expect(screen.getByRole("link", { name: "ai" })).toBeInTheDocument()
    else expect(screen.queryByRole("link", { name: "ai" })).not.toBeInTheDocument()
  }
})

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

// The starter ships no slice library, so Settings has no Slices item (D-6).
vi.mock("@/components/admin/contributions/authoring-tools", () => ({
  ADMIN_AUTHORING_TOOLS_BROWSER_BINDING: null,
}))

afterEach(cleanup)

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

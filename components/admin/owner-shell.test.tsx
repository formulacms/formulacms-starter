import {
  render as renderWithTestingLibrary,
  screen,
  waitFor,
} from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { readFileSync } from "node:fs"
import { AdminShell } from "./admin-shell"

const mocks = vi.hoisted(() => ({
  effective: undefined as unknown,
  owner: null as
    | {
        ownerId: string
        authId: string
        email: string
        role: "admin"
      }
    | null
    | undefined,
  replace: vi.fn(),
  refresh: vi.fn(),
  registerCommands: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useConvexAuth: () => ({ isAuthenticated: true, isLoading: false }),
  useQuery: mocks.useQuery,
  useQueries: () => ({ effective: mocks.effective }),
}))

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace, refresh: mocks.refresh }),
}))

vi.mock("./sidebar", () => ({
  AdminSidebar: () => <aside>Admin navigation</aside>,
}))

vi.mock("./command-palette", () => ({
  AdminCommandPaletteProvider: ({
    children,
  }: {
    children: React.ReactNode
  }) => <div data-testid="admin-command-palette">{children}</div>,
  useRegisterAdminCommands: mocks.registerCommands,
}))

// The starter ships no slice library, so the shell wraps nothing (D-6).
vi.mock("@/components/admin/contributions/authoring-tools", () => ({
  ADMIN_AUTHORING_TOOLS_BROWSER_BINDING: null,
}))

const owner = {
  ownerId: "owner-1",
  authId: "owner-auth-1",
  email: "owner@example.com",
  role: "admin" as const,
}

function renderShell(locale: "en" | "fr" = "en") {
  return renderWithTestingLibrary(
    <NextIntlClientProvider
      locale={locale}
      messages={locale === "fr" ? fr : en}
    >
      <AdminShell>
        <p>Protected owner content</p>
      </AdminShell>
    </NextIntlClientProvider>
  )
}

describe("AdminShell owner boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.effective = undefined
    mocks.owner = owner
    mocks.useQuery.mockImplementation((reference) => {
      if (getFunctionName(reference) === "cms/owner:getOwnerSession") {
        return mocks.owner
      }
      throw new Error(`Unexpected query: ${getFunctionName(reference)}`)
    })
  })

  test("renders the fixed Admin shell for the durable installation owner", () => {
    renderShell()

    // The Help button's bottom-space rule pairs this hook with the launcher
    // marker (components/admin/ai-help/help-chat.tsx).
    expect(screen.getByRole("main")).toHaveAttribute("data-admin-main")
    expect(adminBlocks(readFileSync("app/globals.css", "utf8"))).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "body:has([data-help-launcher]) main[data-admin-main]"
        ),
      ])
    )

    expect(screen.getByText("Admin navigation")).toBeInTheDocument()
    expect(screen.getByText("Protected owner content")).toBeInTheDocument()
  })

  test("redirects and renders no protected children after owner loss", async () => {
    const view = renderShell()

    mocks.owner = null
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminShell>
          <p>Protected owner content</p>
        </AdminShell>
      </NextIntlClientProvider>
    )

    expect(
      screen.queryByText("Protected owner content")
    ).not.toBeInTheDocument()
    await waitFor(() => {
      expect(mocks.replace).toHaveBeenCalledWith("/sign-in")
      expect(mocks.refresh).toHaveBeenCalled()
    })
  })

  test("renders the shell toggle in French", () => {
    renderShell("fr")

    expect(screen.getByTitle(/Masquer la barre latérale/)).toBeInTheDocument()
    expect(mocks.registerCommands).toHaveBeenCalledWith([
      expect.objectContaining({
        label: "Masquer la barre latérale",
        section: "Disposition",
        description: "Donner plus de place à l’éditeur et à l’aperçu en direct",
      }),
    ])
  })
})

test.each(["en", "fr"] as const)(
  "global module notice preserves required route content (%s)",
  (locale) => {
    mocks.effective = new Error("state unavailable")
    renderShell(locale)
    expect(screen.getByTestId("global-module-error")).toHaveTextContent(
      (locale === "en" ? en : fr).shell.modulesUnavailable
    )
    expect(screen.getByText("Protected owner content")).toBeInTheDocument()
    expect(screen.getByText("Admin navigation")).toBeInTheDocument()
  }
)

// Every marked block "admin-<name>:start" … "admin-<name>:end", markers included.
function adminBlocks(css: string): string[] {
  return [
    ...css.matchAll(/\/\* (admin-[\w-]+):start \*\/[\s\S]*?\/\* \1:end \*\//g),
  ].map((match) => match[0])
}

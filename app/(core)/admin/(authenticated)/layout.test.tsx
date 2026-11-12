// @vitest-environment node
import { beforeEach, describe, expect, test, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  fetchAuthQuery: vi.fn(),
  redirect: vi.fn(),
  safeIsAuthenticated: vi.fn(),
}))

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}))

vi.mock("@/lib/auth-server", () => ({
  fetchAuthQuery: mocks.fetchAuthQuery,
  safeIsAuthenticated: mocks.safeIsAuthenticated,
}))

vi.mock("@/components/admin/admin-shell", () => ({
  AdminShell: ({ children }: { children: React.ReactNode }) => children,
}))

import { AuthenticatedAdminShell } from "@/components/admin/authenticated-admin-shell"

const owner = {
  ownerId: "owner-1",
  authId: "owner-auth-1",
  email: "owner@example.com",
  role: "admin" as const,
}

describe("AuthenticatedAdminShell", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.safeIsAuthenticated.mockResolvedValue(true)
    mocks.fetchAuthQuery.mockResolvedValue(owner)
    mocks.redirect.mockImplementation((path: string) => {
      throw new Error(`redirect:${path}`)
    })
  })

  test("renders the owner shell after the durable owner check", async () => {
    const children = <p>Owner content</p>

    await expect(AuthenticatedAdminShell({ children })).resolves.toMatchObject({
      props: { children, aiHelpRouteData: null, moduleStateFailed: false },
    })

    // The owner check, then the one module-state read the installed Help
    // participant needs; its route data carries nothing.
    expect(mocks.fetchAuthQuery).toHaveBeenCalledTimes(2)
  })

  test("routes an unrelated signed-in identity away before rendering", async () => {
    mocks.fetchAuthQuery.mockResolvedValue(null)

    await expect(
      AuthenticatedAdminShell({ children: <p>Should stay hidden</p> })
    ).rejects.toThrow("redirect:/sign-in")
  })

  test("routes an unauthenticated request away without resolving owner state", async () => {
    mocks.safeIsAuthenticated.mockResolvedValue(false)

    await expect(
      AuthenticatedAdminShell({ children: <p>Should stay hidden</p> })
    ).rejects.toThrow("redirect:/sign-in")

    expect(mocks.fetchAuthQuery).not.toHaveBeenCalled()
  })
})

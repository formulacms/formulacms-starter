import { render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { beforeEach, expect, test, vi } from "vitest"
import { AuthenticatedAdminShell } from "./authenticated-admin-shell"
const mocks = vi.hoisted(() => ({
  binding: null as null | { loadRouteData: () => unknown },
  outcome: "on",
  sharedError: null as unknown,
  calls: [] as string[],
  rethrow: vi.fn(),
}))
vi.mock("@/lib/auth-server", () => ({
  safeIsAuthenticated: async () => true,
  fetchAuthQuery: async (query: unknown) => {
    const name = getFunctionName(query as never)
    mocks.calls.push(name)
    if (name === "cms/owner:getOwnerSession") return { role: "admin" }
    if (mocks.sharedError) throw mocks.sharedError
    return { version: 1, modules: [{ id: "fake", outcome: mocks.outcome }] }
  },
}))
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
  unstable_rethrow: mocks.rethrow,
}))
vi.mock("./admin-contributions", () => ({
  INSTALLED_ADMIN_CONTRIBUTIONS: { "admin.ai-help": { moduleId: "fake" } },
}))
vi.mock("./contributions/ai-help.server", () => ({
  get ADMIN_AI_HELP_SERVER_BINDING() {
    return mocks.binding
  },
}))
vi.mock("./admin-shell", () => ({
  AdminShell: ({
    children,
    aiHelpRouteData,
    moduleStateFailed,
  }: {
    children: React.ReactNode
    aiHelpRouteData?: unknown
    moduleStateFailed?: boolean
  }) => (
    <>
      <p>Required shell</p>
      <p>{String(moduleStateFailed)}</p>
      {aiHelpRouteData === undefined ? null : <p>Server contribution</p>}
      {children}
    </>
  ),
}))
beforeEach(() => {
  mocks.binding = null
  mocks.outcome = "on"
  mocks.sharedError = null
  mocks.calls.length = 0
  mocks.rethrow.mockReset()
})
test("no binding means no optional read or invocation", async () => {
  render(await AuthenticatedAdminShell({ children: <p>Required page</p> }))
  expect(mocks.calls).toEqual(["cms/owner:getOwnerSession"])
  expect(screen.getByText("Required page")).toBeInTheDocument()
})
// The participant gates itself in the browser: the server passes route data
// whatever the outcome, because switching a module does not re-render it.
test.each(["off", "needs_setup", "error", "on"])(
  "binding is invoked once whatever the effective outcome (%s)",
  async (outcome) => {
    const load = vi.fn(async () => ({ safe: true }))
    mocks.binding = { loadRouteData: load }
    mocks.outcome = outcome
    render(await AuthenticatedAdminShell({ children: null }))
    expect(mocks.calls).toEqual([
      "cms/owner:getOwnerSession",
      "cms/modules:effective",
    ])
    expect(load).toHaveBeenCalledTimes(1)
    expect(screen.getByText("Server contribution")).toBeInTheDocument()
    expect(screen.getByText("false")).toBeInTheDocument()
  }
)
test("shared read failure withholds binding, signals and forwards the failure flag", async () => {
  const signal = vi.spyOn(console, "error").mockImplementation(() => {})
  const load = vi.fn()
  mocks.binding = { loadRouteData: load }
  mocks.sharedError = new Error("state unavailable")
  render(await AuthenticatedAdminShell({ children: null }))
  expect(load).not.toHaveBeenCalled()
  expect(mocks.rethrow).toHaveBeenCalledWith(mocks.sharedError)
  expect(screen.getByText("Required shell")).toBeInTheDocument()
  expect(screen.getByText("true")).toBeInTheDocument()
  expect(signal).toHaveBeenCalledWith(
    expect.stringContaining("boundary=admin.shell-module-state"),
    expect.anything()
  )
  signal.mockRestore()
})
test("binding failure stays local; framework control flow is rethrown first", async () => {
  const signal = vi.spyOn(console, "error").mockImplementation(() => {})
  const failure = new Error("participant failed")
  mocks.binding = {
    loadRouteData: () => {
      throw failure
    },
  }
  render(await AuthenticatedAdminShell({ children: null }))
  expect(screen.getByText("Required shell")).toBeInTheDocument()
  expect(screen.getByText("false")).toBeInTheDocument()
  expect(signal).toHaveBeenCalledWith(
    expect.stringContaining("module=fake boundary=admin.contribution"),
    expect.anything()
  )
  mocks.rethrow.mockImplementation((error) => {
    throw error
  })
  await expect(AuthenticatedAdminShell({ children: null })).rejects.toBe(
    failure
  )
  expect(signal).toHaveBeenCalledTimes(1)
  signal.mockRestore()
})

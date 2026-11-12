import { render, screen } from "@testing-library/react"
import { afterEach, expect, test, vi } from "vitest"
import {
  AdminModuleStateProvider,
  useModuleGate,
  useModuleStateFailure,
  type ModuleGateState,
} from "./admin-module-state-provider"

const mocks = vi.hoisted(() => ({
  result: undefined as unknown,
  read: vi.fn(),
}))
vi.mock("convex/react", () => ({
  useQueries: (queries: unknown) => {
    mocks.read(queries)
    return { effective: mocks.result }
  },
}))
function Host() {
  const gate = useModuleGate("fake")
  // The public type is suitable for an exhaustive consumer switch.
  const state: ModuleGateState = gate.state
  return (
    <>
      <input aria-label="Required draft" defaultValue="unsaved" />
      <p>{state}</p>
      <p>{String(useModuleStateFailure())}</p>
      {gate.state === "needs_setup" && <p>{gate.setup.join(",")}</p>}
    </>
  )
}
afterEach(() => {
  vi.restoreAllMocks()
  mocks.read.mockClear()
})
test("all five states and global read failure remain values below the host", () => {
  vi.spyOn(console, "error").mockImplementation(() => {})
  const view = render(
    <AdminModuleStateProvider>
      <Host />
    </AdminModuleStateProvider>
  )
  expect(screen.getByText("loading")).toBeInTheDocument()
  for (const outcome of ["off", "needs_setup", "on", "error"] as const) {
    mocks.result = {
      version: 2,
      modules: [{ id: "fake", outcome, setup: ["required"] }],
    }
    view.rerender(
      <AdminModuleStateProvider>
        <Host />
      </AdminModuleStateProvider>
    )
    expect(screen.getByText(outcome)).toBeInTheDocument()
    expect(screen.getByText("false")).toBeInTheDocument()
    if (outcome === "needs_setup")
      expect(screen.getByText("required")).toBeInTheDocument()
  }
  mocks.result = new Error("shared state failed")
  view.rerender(
    <AdminModuleStateProvider>
      <Host />
    </AdminModuleStateProvider>
  )
  expect(screen.getByText("error")).toBeInTheDocument()
  expect(screen.getByText("true")).toBeInTheDocument()
  expect(screen.getByLabelText("Required draft")).toHaveValue("unsaved")
  expect(mocks.read).toHaveBeenLastCalledWith({
    effective: { query: expect.anything(), args: {} },
  })
  mocks.result = { version: 3, modules: [] }
  view.rerender(
    <AdminModuleStateProvider>
      <Host />
    </AdminModuleStateProvider>
  )
  expect(screen.getByText("off")).toBeInTheDocument()
  expect(screen.getByText("false")).toBeInTheDocument()
})
test("server shared-read failure feeds the same failure value", () => {
  mocks.result = { version: 1, modules: [{ id: "fake", outcome: "on" }] }
  render(
    <AdminModuleStateProvider serverReadFailed>
      <Host />
    </AdminModuleStateProvider>
  )
  expect(screen.getByText("error")).toBeInTheDocument()
  expect(screen.getByText("true")).toBeInTheDocument()
})

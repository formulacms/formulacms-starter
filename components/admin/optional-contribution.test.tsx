import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { ConvexError } from "convex/values"
import { beforeEach, expect, test, vi } from "vitest"
import {
  OptionalContribution,
  useOptionalContributionRun,
} from "./optional-contribution"
import type { ModuleGate } from "./module-gate"
const mocks = vi.hoisted(() => ({
  gate: { state: "on" } as ModuleGate,
  reader: vi.fn(),
}))
vi.mock("./admin-module-state-provider", () => ({
  useModuleGate: () => mocks.gate,
}))
const props = {
  moduleId: "fake",
  slot: "admin.ai-writing" as const,
  finishSetup: { label: "Finish setup", href: "/admin/settings/fake" },
  fallbackText: "Could not load this part",
}
function Content({ error }: { error?: unknown }) {
  mocks.reader()
  if (error) throw error
  return <p>Optional content</p>
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.gate = { state: "on" }
})
test("off/loading withhold children; needs_setup links to setup", () => {
  mocks.gate = { state: "off" }
  const view = render(
    <OptionalContribution {...props}>
      <Content />
    </OptionalContribution>
  )
  mocks.gate = { state: "loading" }
  view.rerender(
    <OptionalContribution {...props}>
      <Content />
    </OptionalContribution>
  )
  expect(mocks.reader).not.toHaveBeenCalled()
  mocks.gate = { state: "needs_setup", setup: ["required"] }
  view.rerender(
    <OptionalContribution {...props}>
      <Content />
    </OptionalContribution>
  )
  expect(screen.getByRole("link", { name: "Finish setup" })).toHaveAttribute(
    "href",
    "/admin/settings/fake"
  )
  expect(mocks.reader).not.toHaveBeenCalled()
})
test.each(["CMS_MODULE_DISABLED", "CMS_MODULE_NOT_READY", "unexpected"])(
  "contains render failure %s under the required host",
  (code) => {
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <>
        <input aria-label="Draft" defaultValue="unsaved" />
        <OptionalContribution {...props}>
          <Content error={new ConvexError(code)} />
        </OptionalContribution>
      </>
    )
    expect(screen.getByLabelText("Draft")).toHaveValue("unsaved")
    if (code === "CMS_MODULE_NOT_READY")
      expect(
        screen.getByRole("link", { name: "Finish setup" })
      ).toBeInTheDocument()
    else if (code === "unexpected") {
      expect(screen.getByRole("alert")).toHaveTextContent(props.fallbackText)
      expect(signal).toHaveBeenCalledWith(
        expect.stringContaining("boundary=admin.contribution"),
        expect.anything()
      )
    } else
      expect(screen.queryByText("Optional content")).not.toBeInTheDocument()
    signal.mockRestore()
  }
)
test.each(["CMS_MODULE_DISABLED", "CMS_MODULE_NOT_READY", "unexpected"])(
  "async run rejection %s feeds the same local mapping",
  async (code) => {
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    function Run() {
      const run = useOptionalContributionRun()
      return (
        <button
          onClick={() =>
            void run(async () => {
              throw new ConvexError(code)
            })
          }
        >
          Run
        </button>
      )
    }
    render(
      <>
        <input aria-label="Draft" defaultValue="unsaved" />
        <OptionalContribution {...props}>
          <Run />
        </OptionalContribution>
      </>
    )
    fireEvent.click(screen.getByText("Run"))
    await waitFor(() =>
      expect(screen.queryByText("Run")).not.toBeInTheDocument()
    )
    expect(screen.getByLabelText("Draft")).toHaveValue("unsaved")
    if (code === "CMS_MODULE_NOT_READY")
      expect(
        screen.getByRole("link", { name: "Finish setup" })
      ).toBeInTheDocument()
    if (code === "unexpected")
      expect(screen.getByRole("alert")).toHaveTextContent(props.fallbackText)
    signal.mockRestore()
  }
)
test("synchronous event failure also feeds the local fallback", async () => {
  const signal = vi.spyOn(console, "error").mockImplementation(() => {})
  function Run() {
    const run = useOptionalContributionRun()
    return (
      <button
        onClick={() =>
          void run(() => {
            throw new Error("sync failure")
          })
        }
      >
        Run
      </button>
    )
  }
  render(
    <OptionalContribution {...props}>
      <Run />
    </OptionalContribution>
  )
  fireEvent.click(screen.getByText("Run"))
  expect(await screen.findByRole("alert")).toHaveTextContent(props.fallbackText)
  signal.mockRestore()
})

test("gate error withholds participant and fallback, preserving the required draft", () => {
  mocks.gate = { state: "error", errorCode: "CMS_MODULE_READINESS_FAILED" }
  render(
    <>
      <input aria-label="Draft" defaultValue="unsaved" />
      <OptionalContribution {...props}>
        <Content />
      </OptionalContribution>
    </>
  )
  expect(mocks.reader).not.toHaveBeenCalled()
  expect(screen.queryByRole("alert")).not.toBeInTheDocument()
  expect(screen.queryByText(props.fallbackText)).not.toBeInTheDocument()
  expect(screen.getByLabelText("Draft")).toHaveValue("unsaved")
})
test.each(["gate", "participant"])(
  "%s needs_setup shows only inert static preview and an active setup link",
  (source) => {
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    if (source === "gate")
      mocks.gate = { state: "needs_setup", setup: ["required"] }
    render(
      <OptionalContribution
        {...props}
        disabledPreview={<button disabled>Static preview</button>}
      >
        <Content
          error={
            source === "participant"
              ? new ConvexError("CMS_MODULE_NOT_READY")
              : undefined
          }
        />
      </OptionalContribution>
    )
    const preview = screen.getByText("Static preview")
    expect(preview.closest("[inert]")).not.toBeNull()
    const link = screen.getByRole("link", { name: "Finish setup" })
    expect(link).toHaveAttribute("href", props.finishSetup.href)
    expect(link.closest("[inert]")).toBeNull()
    expect(screen.queryByText("Optional content")).not.toBeInTheDocument()
    if (source === "gate") expect(mocks.reader).not.toHaveBeenCalled()
    signal.mockRestore()
  }
)

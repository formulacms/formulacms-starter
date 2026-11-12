import { fireEvent, render, screen } from "@testing-library/react"
import type { ComponentProps } from "react"
import { ConvexError } from "convex/values"
import { beforeEach, expect, test, vi } from "vitest"
import { OptionalModuleRoute } from "./optional-module-route"
import type { ModuleGate } from "./module-gate"
const mocks = vi.hoisted(() => ({
  gate: { state: "on" } as ModuleGate,
  replace: vi.fn(),
  reload: vi.fn(),
  info: vi.fn(),
  dismiss: vi.fn(),
  reader: vi.fn(),
  setupLinkFailure: false,
  serial: 0,
}))
vi.mock("./admin-module-state-provider", () => ({
  useModuleGate: () => mocks.gate,
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: mocks.replace }),
}))
vi.mock("sonner", () => ({
  toast: { info: mocks.info, dismiss: mocks.dismiss },
}))
vi.mock("next/link", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/link")>()
  return {
    ...actual,
    default: function SetupLink(props: ComponentProps<typeof actual.default>) {
      if (mocks.setupLinkFailure) throw new Error("setup link failed")
      return <actual.default {...props} />
    },
  }
})
const props = {
  reloadPage: mocks.reload,
  moduleId: "fake",
  title: "Fake",
  offNotice: "Fake is not enabled. You can enable it here.",
  errorText: "Could not open Fake",
  errorDescription: "Try opening Fake again.",
  retryLabel: "Retry",
  needsSetup: {
    label: "Finish setup",
    href: "/admin/settings/fake",
    text: "Fake needs setup",
    description: "Finish setting up Fake to continue.",
  },
}
function Reader({ failure }: { failure?: unknown }) {
  mocks.reader()
  if (failure) throw failure
  return <p>Optional content</p>
}
beforeEach(() => {
  vi.clearAllMocks()
  mocks.gate = { state: "on" }
  mocks.setupLinkFailure = false
  mocks.info.mockImplementation(() => ++mocks.serial)
})
test.each(["gate error", "render error", "recovery error", "linked setup"])(
  "%s matches the complete Redirects state markup and action",
  (path) => {
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    const setup = path === "linked setup"
    let broken = path === "render error"
    if (path === "gate error") mocks.gate = { state: "error" }
    if (setup) mocks.gate = { state: "needs_setup", setup: ["required"] }
    mocks.setupLinkFailure = path === "recovery error"
    function Content() {
      mocks.reader()
      if (path === "recovery error") throw new ConvexError("CMS_MODULE_NOT_READY")
      if (broken) throw new Error("reader failed")
      return <p>Recovered content</p>
    }
    try {
      render(
        <OptionalModuleRoute {...props}>
          <Content />
        </OptionalModuleRoute>
      )
      const heading = screen.getByRole("heading", { level: 1, name: props.title })
      expect(heading).toHaveClass("text-2xl", "font-semibold")
      expect(heading.parentElement).toHaveClass("max-w-5xl", "space-y-6")
      const text = screen.getByText(setup ? props.needsSetup.text : props.errorText)
      const description = screen.getByText(
        setup ? props.needsSetup.description : props.errorDescription
      )
      expect(text).toHaveClass("font-medium")
      expect(description).toHaveClass("text-sm", "text-muted-foreground")
      const card = text.parentElement!
      expect(card).toHaveClass("max-w-xl", "space-y-3", "rounded-md", "border", "p-6")
      expect(heading.nextElementSibling).toBe(card)
      expect(text.nextElementSibling).toBe(description)
      if (setup) {
        const link = screen.getByRole("link", { name: props.needsSetup.label })
        expect(link).toHaveAttribute("href", props.needsSetup.href)
        expect(link).toHaveAttribute("data-variant", "outline")
        expect(description.nextElementSibling).toBe(link)
        expect(mocks.reader).not.toHaveBeenCalled()
      } else {
        expect(screen.getByRole("alert")).toBe(card)
        expect(card).toHaveClass("border-destructive/40", "bg-destructive/5")
        const retry = screen.getByRole("button", { name: props.retryLabel })
        expect(retry).toHaveAttribute("type", "button")
        expect(retry).toHaveAttribute("data-variant", "outline")
        expect(description.nextElementSibling).toBe(retry)
        broken = false
        mocks.setupLinkFailure = false
        fireEvent.click(retry)
        if (path === "gate error") {
          expect(mocks.reload).toHaveBeenCalledOnce()
          expect(mocks.reader).not.toHaveBeenCalled()
        } else {
          expect(mocks.reload).not.toHaveBeenCalled()
          expect(screen.queryByRole("alert")).not.toBeInTheDocument()
          if (path === "recovery error")
            expect(screen.getByRole("link", { name: props.needsSetup.label })).toHaveAttribute(
              "href", props.needsSetup.href
            )
          else expect(screen.getByText("Recovered content")).toBeInTheDocument()
        }
      }
    } finally {
      signal.mockRestore()
    }
  }
)
test("loading and linked setup mount no optional reader; setup render allows its own settings", () => {
  mocks.gate = { state: "loading" }
  const view = render(
    <OptionalModuleRoute {...props}>
      <Reader />
    </OptionalModuleRoute>
  )
  expect(mocks.reader).not.toHaveBeenCalled()
  expect(mocks.replace).not.toHaveBeenCalled()
  mocks.gate = { state: "needs_setup", setup: ["required"] }
  view.rerender(
    <OptionalModuleRoute {...props}>
      <Reader />
    </OptionalModuleRoute>
  )
  expect(screen.getByRole("link", { name: "Finish setup" })).toHaveAttribute(
    "href",
    "/admin/settings/fake"
  )
  expect(screen.getByRole("link", { name: "Finish setup" })).toHaveAttribute(
    "data-variant",
    "outline"
  )
  expect(
    screen.getByRole("link", { name: "Finish setup" }).parentElement
  ).toHaveClass("max-w-xl", "rounded-md", "border", "p-6")
  expect(mocks.reader).not.toHaveBeenCalled()
  view.rerender(
    <OptionalModuleRoute {...props} needsSetup="render">
      <Reader />
    </OptionalModuleRoute>
  )
  expect(screen.getByText("Optional content")).toBeInTheDocument()
})
test("off note survives closing and remounting within 100ms with a distinct toast id", () => {
  mocks.gate = { state: "off" }
  vi.useFakeTimers()
  const start = Date.now()
  const first = render(
    <OptionalModuleRoute {...props}>
      <Reader />
    </OptionalModuleRoute>
  )
  const firstId = mocks.info.mock.results.at(-1)?.value
  mocks.dismiss(firstId) // owner's close action, before the next direct-link visit
  first.unmount()
  vi.advanceTimersByTime(50)
  render(
    <OptionalModuleRoute {...props}>
      <Reader />
    </OptionalModuleRoute>
  )
  expect(Date.now() - start).toBeLessThan(100)
  expect(mocks.info).toHaveBeenCalledTimes(2)
  expect(mocks.info).toHaveBeenLastCalledWith(props.offNotice)
  expect(mocks.info.mock.results.at(-1)?.value).not.toBe(firstId)
  expect(mocks.dismiss).toHaveBeenCalledWith(firstId)
  expect(mocks.replace).toHaveBeenCalledWith("/admin/settings/modules")
  expect(mocks.reader).not.toHaveBeenCalled()
  vi.useRealTimers()
})
test("render failure stays local with signal and Retry; retry preserves required draft", () => {
  const signal = vi.spyOn(console, "error").mockImplementation(() => {})
  let broken = true
  function Content() {
    if (broken) throw new Error("reader failed")
    return <p>Recovered</p>
  }
  render(
    <>
      <input aria-label="Draft" defaultValue="unsaved" />
      <OptionalModuleRoute {...props}>
        <Content />
      </OptionalModuleRoute>
    </>
  )
  expect(screen.getByRole("alert")).toHaveTextContent(props.errorText)
  expect(signal).toHaveBeenCalledWith(
    expect.stringContaining("boundary=admin.route"),
    expect.anything()
  )
  broken = false
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(screen.getByText("Recovered")).toBeInTheDocument()
  expect(screen.getByLabelText("Draft")).toHaveValue("unsaved")
  signal.mockRestore()
})
test.each(["CMS_MODULE_DISABLED", "CMS_MODULE_NOT_READY"])(
  "render race %s follows the surface mapping",
  (code) => {
    const signal = vi.spyOn(console, "error").mockImplementation(() => {})
    render(
      <OptionalModuleRoute {...props}>
        <Reader failure={new ConvexError(code)} />
      </OptionalModuleRoute>
    )
    if (code === "CMS_MODULE_DISABLED")
      expect(mocks.replace).toHaveBeenCalledWith("/admin/settings/modules")
    else
      expect(
        screen.getByRole("link", { name: "Finish setup" })
      ).toBeInTheDocument()
    signal.mockRestore()
  }
)
test("shared query failure shows local Retry without mounting optional content", () => {
  const signal = vi.spyOn(console, "error").mockImplementation(() => {})
  mocks.gate = { state: "error" }
  render(
    <OptionalModuleRoute {...props}>
      <Reader />
    </OptionalModuleRoute>
  )
  expect(screen.getByRole("alert")).toHaveClass(
    "max-w-xl",
    "border-destructive/40",
    "bg-destructive/5"
  )
  expect(screen.getByRole("button", { name: "Retry" })).toHaveAttribute(
    "data-variant",
    "outline"
  )
  fireEvent.click(screen.getByRole("button", { name: "Retry" }))
  expect(mocks.reload).toHaveBeenCalledOnce()
  expect(mocks.reader).not.toHaveBeenCalled()
  signal.mockRestore()
})

import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { PublicSiteUpdatesRow } from "./public-site-updates-row"

type UpdateState =
  | "no_address"
  | "incomplete"
  | "updating"
  | "local_unreachable"
  | "failed"
  | "ok"

const mocks = vi.hoisted(() => ({
  health: undefined as undefined | { updateState: string },
  requeue: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  message: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useQuery: () => mocks.health,
  useMutation: () => mocks.requeue,
}))

vi.mock("next/link", () => ({
  default: ({ children, ...props }: React.ComponentProps<"a">) => (
    <a {...props}>{children}</a>
  ),
}))

vi.mock("sonner", () => ({
  toast: { success: mocks.success, error: mocks.error, message: mocks.message },
}))

function setState(updateState: UpdateState) {
  mocks.health = { updateState }
}

function renderRow(messages: unknown = en, locale = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages as typeof en}>
      <PublicSiteUpdatesRow />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  setState("ok")
  mocks.requeue.mockResolvedValue({ requeued: 0, moreRemain: false })
})

describe("PublicSiteUpdatesRow (Settings > General): six calm states", () => {
  test("renders nothing while the status loads", () => {
    mocks.health = undefined
    const { container } = renderRow()
    expect(container).toBeEmptyDOMElement()
  })

  test("ok: says Up to date, no button", () => {
    renderRow()
    expect(screen.getByRole("status")).toHaveTextContent("Public site updates")
    expect(screen.getByText("Up to date")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  test("no address: one neutral hint with a link to the Site address field, no count, no Retry", () => {
    setState("no_address")
    renderRow()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Add the site address so the public site updates."
    )
    expect(screen.getByRole("link", { name: "site address" })).toHaveAttribute(
      "href",
      "/admin/settings#siteUrl"
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.queryByText(/failed|retrying/i)).not.toBeInTheDocument()
    expect(screen.queryByText("Up to date")).not.toBeInTheDocument()
  })

  test("the address link focuses the field when it is on the page", () => {
    setState("no_address")
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <input id="siteUrl" aria-label="Site address" />
        <PublicSiteUpdatesRow />
      </NextIntlClientProvider>
    )
    fireEvent.click(screen.getByRole("link", { name: "site address" }))
    expect(screen.getByLabelText("Site address")).toHaveFocus()
  })

  test("incomplete: a neutral setup hint, no Retry", () => {
    setState("incomplete")
    renderRow()
    expect(screen.getByRole("status")).toHaveTextContent(
      "Finish connecting public updates: add the private code."
    )
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  test("updating: shows progress without an alarm", () => {
    setState("updating")
    renderRow()
    expect(screen.getByText("Updating…")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })

  test("local_unreachable: a quiet local note without a button", () => {
    setState("local_unreachable")
    renderRow()
    expect(screen.getByText("Local site — nothing to send")).toBeInTheDocument()
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
    expect(screen.queryByText("Up to date")).not.toBeInTheDocument()
  })

  test("failed: a warning with Retry that requeues every bounded batch", async () => {
    setState("failed")
    mocks.requeue
      .mockResolvedValueOnce({ requeued: 32, moreRemain: true })
      .mockResolvedValueOnce({ requeued: 4, moreRemain: false })
    renderRow()

    expect(
      screen.getByText("Last update didn’t reach your site · retrying")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))

    await waitFor(() => expect(mocks.requeue).toHaveBeenCalledTimes(2))
    expect(mocks.success).toHaveBeenCalledWith(
      "Public-site updates were queued again."
    )
  })

  test("failed with nothing to requeue says so", async () => {
    setState("failed")
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))
    await waitFor(() =>
      expect(mocks.message).toHaveBeenCalledWith(
        "Nothing to send again — updates are already retrying"
      )
    )
    expect(mocks.success).not.toHaveBeenCalled()
  })

  test("the retry loop stops after 20 calls", async () => {
    setState("failed")
    mocks.requeue.mockResolvedValue({ requeued: 32, moreRemain: true })
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))

    await waitFor(() => expect(mocks.success).toHaveBeenCalled())
    expect(mocks.requeue).toHaveBeenCalledTimes(20)
  })

  test("a missing address at Retry is a plain message, with no error and no console noise", async () => {
    setState("failed")
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {})
    mocks.requeue.mockResolvedValue({
      ok: false,
      code: "REVALIDATION_UNCONFIGURED",
    })
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))

    await waitFor(() => expect(mocks.message).toHaveBeenCalled())
    expect(mocks.message).toHaveBeenCalledWith(
      "Add the site address and matching private code, then select Retry now."
    )
    expect(mocks.error).not.toHaveBeenCalled()
    expect(mocks.success).not.toHaveBeenCalled()
    expect(consoleError).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  test("an unknown failure uses the generic message", async () => {
    setState("failed")
    mocks.requeue.mockRejectedValue(new Error("boom: internal detail"))
    renderRow()
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))

    await waitFor(() => expect(mocks.error).toHaveBeenCalled())
    expect(mocks.error).toHaveBeenCalledWith(
      "The updates could not be queued. Try again."
    )
  })

  test("renders in French", () => {
    renderRow(fr, "fr")
    expect(screen.getByText("À jour")).toBeInTheDocument()
  })

  test("French hint for a missing address", () => {
    setState("no_address")
    renderRow(fr, "fr")
    expect(screen.getByRole("status")).toHaveTextContent(
      "Ajoutez l’adresse du site pour mettre à jour le site public."
    )
  })
})

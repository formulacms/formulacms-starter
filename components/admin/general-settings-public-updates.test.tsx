import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import { GeneralSettings } from "./general-settings"

const mocks = vi.hoisted(() => ({
  requeue: vi.fn(),
  health: { updateState: "failed" },
}))

vi.mock("convex/react", () => ({
  useQuery: (ref: Parameters<typeof getFunctionName>[0]) => {
    switch (getFunctionName(ref)) {
      case "cms/settings:getSettings":
        return {
          siteName: "Test site",
          siteUrl: "",
          defaultLocale: "en",
          enabledLocales: ["en"],
        }
      case "cms/revalidate:getRevalidationHealth":
        return mocks.health
      default:
        return undefined
    }
  },
  useMutation: (ref: Parameters<typeof getFunctionName>[0]) =>
    getFunctionName(ref) ===
    "cms/languageLifecycle:requeueUndeliveredLifecycleIntents"
      ? mocks.requeue
      : vi.fn(),
  useAction: () => vi.fn(),
}))

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))
// Not under test here: the media picker and the self-test panel.
vi.mock("./media-picker", () => ({ MediaPicker: () => null }))
vi.mock("./revalidation-diagnostics", () => ({
  RevalidationDiagnostics: () => null,
}))

beforeEach(() => {
  vi.clearAllMocks()
  mocks.requeue.mockResolvedValue({ requeued: 1, moreRemain: false })
})

describe("GeneralSettings", () => {
  test("shows the Public site updates row and its retry", async () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <GeneralSettings />
      </NextIntlClientProvider>
    )

    expect(screen.getByText("Public site updates")).toBeInTheDocument()
    expect(
      screen.getByText("Last update didn’t reach your site · retrying")
    ).toBeInTheDocument()
    fireEvent.click(screen.getByRole("button", { name: "Retry now" }))
    await waitFor(() => expect(mocks.requeue).toHaveBeenCalledTimes(1))
  })
})

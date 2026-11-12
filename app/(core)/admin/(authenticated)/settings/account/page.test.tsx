import { fireEvent, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import en from "@/messages/admin/en.json"
import AccountSettingsPage from "./page"

const mocks = vi.hoisted(() => ({
  setAdminLocale: vi.fn(),
  refresh: vi.fn(),
}))

vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async () => (key: keyof typeof en.settings.account) =>
    en.settings.account[key],
}))
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh }),
}))
vi.mock("convex/react", () => ({ useMutation: () => mocks.setAdminLocale }))
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))
vi.mock("@/components/ui/select", async () => {
  const React = await import("react")
  return {
    Select: ({
      children,
      onValueChange,
      value,
      disabled,
    }: {
      children: React.ReactNode
      onValueChange: (value: string) => void
      value: string
      disabled?: boolean
    }) =>
      React.createElement(
        "select",
        {
          "aria-label": "Admin language",
          value,
          disabled,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) =>
            onValueChange(event.target.value),
        },
        children
      ),
    SelectTrigger: () => null,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: React.ReactNode }) => children,
    SelectItem: ({
      children,
      value,
    }: {
      children: React.ReactNode
      value: string
    }) => React.createElement("option", { value }, children),
  }
})

beforeEach(() => {
  mocks.setAdminLocale.mockReset().mockResolvedValue(null)
  mocks.refresh.mockReset()
})

describe("account admin language picker", () => {
  test("renders only shipped dictionaries and writes the selected admin locale", async () => {
    render(await AccountSettingsPage())

    expect(
      screen.getByRole("heading", { name: en.settings.account.title })
    ).toBeInTheDocument()
    expect(
      screen
        .getAllByRole("option")
        .map((option) => option.getAttribute("value"))
    ).toEqual(["en", "fr"])
    expect(
      screen.getByRole("combobox", { name: "Admin language" })
    ).toHaveValue("en")
    expect(mocks.setAdminLocale).not.toHaveBeenCalled()
    fireEvent.change(screen.getByRole("combobox", { name: "Admin language" }), {
      target: { value: "fr" },
    })
    fireEvent.click(
      screen.getByRole("button", { name: en.settings.account.ok })
    )
    await waitFor(() =>
      expect(mocks.setAdminLocale).toHaveBeenCalledWith({ locale: "fr" })
    )
    expect(mocks.refresh).toHaveBeenCalled()
  })
})

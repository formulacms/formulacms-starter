import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeAll, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import { AccountLanguagePicker } from "./account-language-picker"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() }),
}))

vi.mock("convex/react", () => ({
  useMutation: () => vi.fn(),
}))

beforeAll(() => {
  // Match the existing Languages tests: jsdom does not scroll Radix options.
  Element.prototype.scrollIntoView = () => {}
})

test("the selected account language stays neutral in the trigger and list", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AccountLanguagePicker
        currentLocale="en"
        localeOptions={[{ code: "en", label: "English" }, { code: "fr", label: "Français" }]}
      />
    </NextIntlClientProvider>
  )

  const trigger = screen.getByRole("combobox")
  expect(trigger).toHaveTextContent("English")
  expect(trigger).not.toHaveClass("bg-emerald-600")
  fireEvent.keyDown(trigger, { key: "ArrowDown" })
  expect(await screen.findByRole("option", { name: "English", selected: true })).not.toHaveClass("bg-emerald-600")
})

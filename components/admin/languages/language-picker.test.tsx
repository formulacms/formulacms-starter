import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import { LanguagePicker } from "./language-picker"

test("the selected language stays neutral and keeps its selection indicator", async () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <LanguagePicker value="fr" options={["en", "fr"]} onChange={vi.fn()} />
    </NextIntlClientProvider>
  )

  const trigger = screen.getByRole("button", { name: "Language to add" })
  expect(trigger).toHaveTextContent("Français")
  expect(trigger).not.toHaveClass("bg-emerald-600")
  fireEvent.click(trigger)
  const selected = await screen.findByRole("option", { selected: true })
  expect(selected).toHaveTextContent("Français")
  expect(selected).not.toHaveClass("bg-emerald-600")
  expect(selected.querySelector("svg")).toBeInTheDocument()
})

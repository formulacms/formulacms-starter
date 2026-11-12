import { render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { AiAddSliceEntry } from "./ai-add-slice-entry"

const mocks = vi.hoisted(() => ({ gate: "on" }))
vi.mock("./admin-module-state-provider", () => ({
  useModuleGate: () => ({ state: mocks.gate }),
}))

function renderEntry(ready: boolean, locale: "en" | "fr" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "fr" ? fr : en}>
      <AiAddSliceEntry ready={ready} />
    </NextIntlClientProvider>
  )
}

describe("Add slice on the Slices list", () => {
  beforeEach(() => {
    mocks.gate = "on"
  })

  test.each([true, false])("renders nothing while the AI module is off (ready %s)", (ready) => {
    mocks.gate = "off"
    const { container } = renderEntry(ready)
    expect(container).toBeEmptyDOMElement()
  })

  test("when the Slice creator is ready, Add slice opens Create slice", () => {
    renderEntry(true)
    expect(screen.getByRole("link", { name: "Add block" })).toHaveAttribute(
      "href",
      "/admin/slices/create"
    )
    expect(screen.queryByRole("button", { name: "Add block" })).toBeNull()
    expect(screen.queryByText("Finish setup")).toBeNull()
  })

  test("when it is not set up, Add slice is disabled and Finish setup opens Settings › AI first", () => {
    renderEntry(false)
    const button = screen.getByRole("button", { name: "Add block" })
    expect(button).toBeDisabled()
    expect(screen.queryByRole("link", { name: "Add block" })).toBeNull()
    const finish = screen.getByRole("link", { name: "Finish setup" })
    expect(finish).toHaveAttribute("href", "/admin/settings/ai")
    expect(
      finish.compareDocumentPosition(button) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
  })

  test("shows the French text", () => {
    renderEntry(false, "fr")
    expect(screen.getByRole("button", { name: "Ajouter un bloc" })).toBeDisabled()
    expect(
      screen.getByRole("link", { name: "Terminer la configuration" })
    ).toHaveAttribute("href", "/admin/settings/ai")
  })
})

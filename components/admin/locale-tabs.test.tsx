import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import { LocaleTabs } from "./locale-tabs"

function renderTabs(enabledLocales: string[], onLocaleChange = vi.fn()) {
  return {
    onLocaleChange,
    ...render(
      <NextIntlClientProvider locale="en" messages={en}>
        <LocaleTabs
          currentLocale="en"
          enabledLocales={enabledLocales}
          availableLocales={["en", "fr"]}
          onLocaleChange={onLocaleChange}
        />
      </NextIntlClientProvider>
    ),
  }
}

describe("LocaleTabs", () => {
  test("stays hidden when the editor has only one language", () => {
    renderTabs(["en"])
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument()
  })

  test("names multilingual editor tabs in plain language", () => {
    const { onLocaleChange } = renderTabs(["en", "fr"])

    expect(
      screen.getByRole("tablist", { name: "Content languages" })
    ).toBeInTheDocument()
    expect(
      screen.getByRole("tab", { name: "EN — Edit English" })
    ).toHaveAttribute("aria-selected", "true")
    for (const tab of screen.getAllByRole("tab")) {
      expect(tab.getAttribute("aria-label")).toContain(
        tab.childNodes[0].textContent
      )
    }
    fireEvent.click(screen.getByRole("tab", { name: /Edit Français/ }))
    expect(onLocaleChange).toHaveBeenCalledWith("fr")
  })

  test("shows no visual dot for languages with content, only screen-reader text", () => {
    const { container } = renderTabs(["en", "fr"])

    expect(container.querySelector(".bg-emerald-400")).toBeNull()
    expect(container.querySelector("[aria-hidden]")).toBeNull()
    const french = screen.getByRole("tab", { name: /Edit Français/ })
    expect(french).toHaveTextContent("FR")
    expect(french.querySelector(".sr-only")).toHaveTextContent(
      en.common.localeTabs.hasContent
    )
    expect(screen.getByRole("tab", { name: /Edit English/ })).toHaveClass(
      "bg-primary",
      "text-primary-foreground"
    )
  })
})

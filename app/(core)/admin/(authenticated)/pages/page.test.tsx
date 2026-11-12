import { render, screen } from "@testing-library/react"
import { createTranslator } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import fr from "@/messages/admin/fr.json"
import PagesPage from "./page"

const mocks = vi.hoisted(() => ({
  connection: vi.fn(),
  getTranslations: vi.fn(),
}))

vi.mock("next/server", () => ({
  connection: mocks.connection,
}))

vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
}))

vi.mock("@/components/admin/pages-list-client", () => ({
  PagesListClient: () => <div>Content list</div>,
}))

describe("PagesPage messages", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getTranslations.mockResolvedValue(
      createTranslator({ locale: "fr", messages: fr.pages.list })
    )
  })

  test("renders the content-list heading and creation link in French", async () => {
    render(await PagesPage())

    expect(mocks.connection).toHaveBeenCalledOnce()
    expect(mocks.getTranslations).toHaveBeenCalledWith("pages.list")
    expect(screen.getByRole("heading", { name: "Contenu" })).toBeInTheDocument()
    expect(
      screen.getByText("Gérez le contenu de votre site")
    ).toBeInTheDocument()
    expect(
      screen.getByRole("link", { name: "Nouveau contenu" })
    ).toHaveAttribute("href", "/admin/pages/new")
  })
})

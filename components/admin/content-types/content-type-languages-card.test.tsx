import { fireEvent, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { ConvexError } from "convex/values"
import { beforeEach, describe, expect, test, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { ContentTypeLanguagesCard } from "./content-type-languages-card"

type Count = { count: number; capped: boolean }

const mocks = vi.hoisted(() => ({
  gate: "on" as "on" | "off" | "loading",
  entries: [] as { pageType: string; locale: string }[],
  impact: {
    keptLocale: "en",
    hiddenVersions: { count: 12, capped: false } as Count,
    linkingPages: { count: 0, capped: false } as Count,
    childPages: { count: 25, capped: true } as Count,
  },
  confirm: vi.fn(),
  setTranslation: vi.fn(),
  error: vi.fn(),
}))

vi.mock("@/components/admin/admin-module-state-provider", () => ({
  useModuleGate: () => ({ state: mocks.gate }),
}))

vi.mock("convex/react", () => ({
  useQuery: (reference: unknown, args: unknown) => {
    if (args === "skip") return undefined
    const name = getFunctionName(reference as never)
    if (name === "cms/contentTypes:getUntranslatedContentTypes")
      return mocks.entries
    if (name === "cms/settings:getSiteConfig")
      return { enabledLocales: ["en", "fr"], defaultLocale: "en" }
    return undefined
  },
  useMutation: () => mocks.setTranslation,
  useConvex: () => ({ query: async () => mocks.impact }),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
}))

vi.mock("sonner", () => ({ toast: { error: mocks.error } }))

beforeEach(() => {
  mocks.gate = "on"
  mocks.entries = []
  mocks.confirm.mockReset().mockResolvedValue(true)
  mocks.setTranslation.mockReset().mockResolvedValue([])
  mocks.error.mockReset()
})

describe("ContentTypeLanguagesCard", () => {
  test("is shown only while the Multilingual module is on", () => {
    mocks.gate = "off"
    const { container } = render(<ContentTypeLanguagesCard type="page" />)
    expect(container).toBeEmptyDOMElement()
  })

  test("turning off asks first, leaves out a zero line and shows N+", async () => {
    render(<ContentTypeLanguagesCard type="page" />)
    expect(
      screen.getByText("Pages can have a version in each language.")
    ).toBeInTheDocument()

    fireEvent.click(screen.getByRole("checkbox", { name: "Translate Pages" }))

    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.confirm.mock.calls[0]![0]).toEqual({
      title: "Write Pages in English only?",
      description: [
        "12 versions in other languages will be hidden from the site. They are kept, and come back when you turn translation on.",
        "25+ pages under these Pages will be hidden in other languages.",
      ].join("\n"),
      confirmText: "Turn off",
    })
    await waitFor(() =>
      expect(mocks.setTranslation).toHaveBeenCalledWith({
        pageType: "page",
        translated: false,
      })
    )
  })

  test("a cancelled confirm changes nothing", async () => {
    mocks.confirm.mockResolvedValue(false)
    render(<ContentTypeLanguagesCard type="page" />)
    fireEvent.click(screen.getByRole("checkbox"))
    await waitFor(() => expect(mocks.confirm).toHaveBeenCalled())
    expect(mocks.setTranslation).not.toHaveBeenCalled()
  })

  test("turning on needs no dialog", async () => {
    mocks.entries = [{ pageType: "page", locale: "en" }]
    render(<ContentTypeLanguagesCard type="page" />, { locale: "fr" })
    expect(
      screen.getByText("Les pages sont en anglais seulement.")
    ).toBeInTheDocument()

    fireEvent.click(
      screen.getByRole("checkbox", { name: "Traduire les pages" })
    )

    await waitFor(() =>
      expect(mocks.setTranslation).toHaveBeenCalledWith({
        pageType: "page",
        translated: true,
      })
    )
    expect(mocks.confirm).not.toHaveBeenCalled()
  })

  test("an entry whose language is no longer enabled reads as translated", () => {
    mocks.entries = [{ pageType: "page", locale: "de" }]
    render(<ContentTypeLanguagesCard type="page" />)
    expect(screen.getByRole("checkbox")).toBeChecked()
  })

  test.each([
    [
      "MULTILINGUAL_MODULE_NOT_ENABLED",
      "en",
      "Turn on Multilingual in Modules first. Nothing was changed.",
    ],
    [
      "LANGUAGE_OPERATION_OPEN",
      "en",
      "Finish or stop the language change in progress first.",
    ],
    [
      "PAGE_PURGE_IN_PROGRESS",
      "en",
      "A permanent delete is still running. Try again when it is done. Nothing was changed.",
    ],
    [
      "PAGE_PURGE_IN_PROGRESS",
      "fr",
      "Une suppression définitive est en cours. Réessayez quand elle sera terminée. Rien n’a été modifié.",
    ],
  ] as const)(
    "refusal %s reads in plain words (%s)",
    async (code, locale, message) => {
      mocks.setTranslation.mockRejectedValue(new ConvexError(code))
      render(<ContentTypeLanguagesCard type="page" />, { locale })
      fireEvent.click(screen.getByRole("checkbox"))
      await waitFor(() => expect(mocks.error).toHaveBeenCalledWith(message))
    }
  )
})

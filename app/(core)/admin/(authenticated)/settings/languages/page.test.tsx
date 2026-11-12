import { render, screen } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import LanguagesSettingsPage from "./page"

// Route-level guard: the component tests import the composition directly, so
// only this test fails if the Languages route stops rendering the state-aware
// Multilingual composition (the RC01c regression restored by FR1a).
const mocks = vi.hoisted(() => ({
  queries: new Map<string, unknown>(),
}))

vi.mock("convex/react", () => ({
  useQuery: (
    reference: Parameters<typeof getFunctionName>[0],
    args: unknown
  ) =>
    args === "skip" ? undefined : mocks.queries.get(getFunctionName(reference)),
  useMutation: () => vi.fn().mockResolvedValue(null),
  usePaginatedQuery: () => ({
    results: [],
    status: "Exhausted",
    loadMore: vi.fn(),
  }),
}))

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

function multilingualState(overrides: Record<string, unknown> = {}) {
  return {
    lifecycleState: "S4",
    origin: null,
    moduleEnabled: true,
    moduleConfigurationVersion: 9,
    version: 4,
    defaultLocale: "en",
    enabledLocales: ["en", "fr"],
    openOperation: null,
    defaultMigration: null,
    latestPreviews: [],
    ...overrides,
  }
}

function renderPage() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <LanguagesSettingsPage />
    </NextIntlClientProvider>
  )
}

beforeEach(() => {
  mocks.queries.clear()
  mocks.queries.set("cms/languageLifecycle:getLanguageLifecycleStatus", {
    updating: false,
    notDelivered: false,
    oldestUndelivered: null,
    operation: null,
  })
})

describe("Languages settings route", () => {
  test("renders the one-language card while Multilingual is off", () => {
    mocks.queries.set(
      "cms/multilingual:getMultilingualState",
      multilingualState({
        lifecycleState: "S0",
        moduleEnabled: false,
        version: 1,
        enabledLocales: ["en"],
      })
    )
    mocks.queries.set("cms/language:getLanguageState", {
      kind: "current",
      version: 1,
      currentLocale: "en",
      enabledLocales: ["en"],
      transition: null,
      blockers: [],
    })
    mocks.queries.set("cms/settings:getSettings", {
      updatedAt: 42,
      defaultLocale: "en",
      enabledLocales: ["en"],
    })
    renderPage()

    expect(screen.getByRole("heading", { name: "Languages" })).toBeInTheDocument()
    expect(
      screen.queryByText(
        "Your site is in English."
      )
    ).not.toBeInTheDocument()
    expect(screen.queryByText("Site languages")).not.toBeInTheDocument()
    expect(screen.queryByText("Enabled languages")).not.toBeInTheDocument()
  })

  test("renders the same card once Multilingual is adopted", () => {
    mocks.queries.set(
      "cms/multilingual:getMultilingualState",
      multilingualState()
    )
    mocks.queries.set("cms/settings:getSettings", {
      updatedAt: 42,
      defaultLocale: "en",
      enabledLocales: ["en", "fr"],
    })
    renderPage()

    expect(screen.getByRole("heading", { name: "Languages" })).toBeInTheDocument()
    expect(screen.queryByText("Site languages")).not.toBeInTheDocument()
    expect(screen.getByText("Français")).toBeInTheDocument()
    expect(screen.queryByText("The languages your site is published in.")).not.toBeInTheDocument()
  })
})

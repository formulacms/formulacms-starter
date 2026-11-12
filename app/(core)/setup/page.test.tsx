import { render, screen } from "@testing-library/react"
import { createTranslator } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import fr from "@/messages/admin/fr.json"
import en from "@/messages/admin/en.json"
import SetupPage, { generateMetadata } from "./page"

const mocks = vi.hoisted(() => ({
  getSiteConfigState: vi.fn(),
  readSetupBootstrapHandoff: vi.fn(),
  getTranslations: vi.fn(),
  redirect: vi.fn(),
  wizardProps: vi.fn(),
}))

vi.mock("next-intl/server", () => ({
  getTranslations: mocks.getTranslations,
}))

vi.mock("@/lib/i18n/site-config", () => ({
  getSiteConfigState: mocks.getSiteConfigState,
}))

vi.mock("@/lib/setup/bootstrap-handoff", () => ({
  readSetupBootstrapHandoff: mocks.readSetupBootstrapHandoff,
}))

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}))

vi.mock("@/components/setup/setup-wizard", () => ({
  SetupWizard: (props: unknown) => {
    mocks.wizardProps(props)
    return <div>Setup wizard</div>
  },
}))

describe("setup page status gate", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getTranslations.mockImplementation(
      async (namespace: "setup.statusUnavailable" | "setup.metadata") =>
        createTranslator({ locale: "en", messages: en, namespace })
    )
    mocks.readSetupBootstrapHandoff.mockResolvedValue(null)
    mocks.getSiteConfigState.mockResolvedValue({
      status: "unavailable",
      fallback: {
        onboardingCompletedAt: null,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })
  })

  test("does not render account creation when setup status is unavailable", async () => {
    render(await SetupPage({ searchParams: Promise.resolve({}) }))

    expect(
      screen.getByRole("heading", { name: "We can’t verify setup yet" })
    ).toBeInTheDocument()
    expect(screen.queryByText("Setup wizard")).not.toBeInTheDocument()
    expect(
      screen.getByRole("button", { name: "Try again" }).closest("form")
    ).toHaveAttribute("action", "/setup")
  })

  test("redirects an initialized site away from setup", async () => {
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: {
        onboardingCompletedAt: 1_700_000_000_000,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })

    await SetupPage({ searchParams: Promise.resolve({}) })

    expect(mocks.redirect).toHaveBeenCalledWith("/admin")
  })

  test("allows the claim-gated owner recovery path after initialization", async () => {
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: {
        onboardingCompletedAt: 1_700_000_000_000,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })

    render(
      await SetupPage({
        searchParams: Promise.resolve({ "recover-owner": "1" }),
      })
    )

    expect(screen.getByText("Setup wizard")).toBeInTheDocument()
    expect(mocks.redirect).not.toHaveBeenCalled()
  })

  test("renders account creation only for a confirmed fresh deployment", async () => {
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: {
        onboardingCompletedAt: null,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })

    render(await SetupPage({ searchParams: Promise.resolve({}) }))

    expect(screen.getByText("Setup wizard")).toBeInTheDocument()
  })
  test("hands the wizard only the setup and error messages of each admin dictionary", async () => {
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: {
        onboardingCompletedAt: null,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })

    render(await SetupPage({ searchParams: Promise.resolve({}) }))

    const props = mocks.wizardProps.mock.calls[0]?.[0] as {
      messages: Record<string, Record<string, unknown>>
    }
    expect(Object.keys(props.messages).sort()).toEqual(["en", "fr"])
    expect(Object.keys(props.messages.en!).sort()).toEqual([
      "caughtErrors",
      "setup",
    ])
    expect(props.messages.fr!.setup).toBe(fr.setup)
    expect(props.messages.en!.setup).toBe(en.setup)
  })

  test("generates a French setup title while keeping setup out of search indexes", async () => {
    mocks.getTranslations.mockImplementation(
      async (namespace: "setup.statusUnavailable" | "setup.metadata") =>
        createTranslator({ locale: "fr", messages: fr, namespace })
    )
    expect(await generateMetadata()).toEqual({
      title: "Configuration",
      robots: { index: false },
    })
    expect(mocks.getTranslations).toHaveBeenCalledWith("setup.metadata")
    expect(mocks.getSiteConfigState).not.toHaveBeenCalled()
    expect(mocks.readSetupBootstrapHandoff).not.toHaveBeenCalled()
  })

  test("builds the bound owner-code command on the server in local development", async () => {
    vi.stubEnv("NODE_ENV", "development")
    vi.stubEnv("CONVEX_DEPLOYMENT", "dev:happy-animal-123")
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: {
        onboardingCompletedAt: null,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })

    render(await SetupPage({ searchParams: Promise.resolve({}) }))

    const props = mocks.wizardProps.mock.calls[0]?.[0] as {
      ownerCodeTarget: { kind: string; folder?: string; command?: string }
    }
    expect(props.ownerCodeTarget.kind).toBe("local")
    expect(props.ownerCodeTarget.folder).toBe(process.cwd())
    expect(props.ownerCodeTarget.command).toContain(
      "--deployment happy-animal-123 &&"
    )
    vi.unstubAllEnvs()
  })

  test("keeps the bound local block for a production build on this machine's backend", async () => {
    vi.stubEnv("NODE_ENV", "production")
    vi.stubEnv("CONVEX_DEPLOYMENT", "local:local-ada-formula")
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "http://127.0.0.1:3210")
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: {
        onboardingCompletedAt: null,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })

    render(await SetupPage({ searchParams: Promise.resolve({}) }))

    const props = mocks.wizardProps.mock.calls[0]?.[0] as {
      ownerCodeTarget: { kind: string; folder?: string; command?: string }
    }
    expect(props.ownerCodeTarget.kind).toBe("local")
    expect(props.ownerCodeTarget.folder).toBe(process.cwd())
    expect(props.ownerCodeTarget.command).toContain("--deployment local &&")
    vi.unstubAllEnvs()
  })

  test("binds the live block to the deployment in NEXT_PUBLIC_CONVEX_URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "https://calm-fox-9.convex.cloud")
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: {
        onboardingCompletedAt: null,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })

    render(await SetupPage({ searchParams: Promise.resolve({}) }))

    const props = mocks.wizardProps.mock.calls[0]?.[0] as {
      ownerCodeTarget: { kind: string; deployment?: string; command?: string }
    }
    expect(props.ownerCodeTarget.kind).toBe("live")
    expect(props.ownerCodeTarget.deployment).toBe("calm-fox-9")
    expect(props.ownerCodeTarget.command).toContain(
      "--deployment calm-fox-9 &&"
    )
    expect(props.ownerCodeTarget.command).not.toContain("cd ")
    vi.unstubAllEnvs()
  })

  test("shows no live command when the Convex URL is not a Convex Cloud URL", async () => {
    vi.stubEnv("NEXT_PUBLIC_CONVEX_URL", "")
    mocks.getSiteConfigState.mockResolvedValue({
      status: "ready",
      value: {
        onboardingCompletedAt: null,
        defaultLocale: "en",
        enabledLocales: ["en"],
      },
    })

    render(await SetupPage({ searchParams: Promise.resolve({}) }))

    const props = mocks.wizardProps.mock.calls[0]?.[0] as {
      ownerCodeTarget: unknown
    }
    expect(props.ownerCodeTarget).toEqual({ kind: "live-unbound" })
    vi.unstubAllEnvs()
  })
})

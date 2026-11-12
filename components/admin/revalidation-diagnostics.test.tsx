import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { getFunctionName } from "convex/server"
import { NextIntlClientProvider } from "next-intl"
import { beforeEach, describe, expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"

const mocks = vi.hoisted(() => ({
  issueProof: vi.fn(),
  runSelfTest: vi.fn(),
  verifyPairing: vi.fn(),
  useQuery: vi.fn(),
}))

vi.mock("convex/react", () => ({
  useAction: (reference: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/revalidate:runRevalidationSelfTest") {
      return mocks.runSelfTest
    }
    if (name === "cms/revalidate:verifyContactIpProofPairing") {
      return mocks.verifyPairing
    }
    throw new Error(`Unexpected action: ${name}`)
  },
  useQuery: mocks.useQuery,
}))

vi.mock("@/app/(core)/admin/(authenticated)/settings/actions", () => ({
  issueContactIpProofPairingForSettings: mocks.issueProof,
}))

import { RevalidationDiagnostics } from "./revalidation-diagnostics"

type Health = {
  recentAttempts: Array<{
    status: "ok" | "http_error" | "network_error" | "unconfigured"
    httpStatus?: number
  }>
  consecutiveFailureCount: number
  consecutiveFailureCountCapped: boolean
  unconfigured: boolean
}

let owner:
  | { ownerId: string; authId: string; email: string; role: "admin" }
  | null
  | undefined
let health: Health | undefined

function renderDiagnostics() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <RevalidationDiagnostics />
    </NextIntlClientProvider>
  )
}

function currentHealth(overrides: Partial<Health> = {}): Health {
  return {
    recentAttempts: [],
    consecutiveFailureCount: 0,
    consecutiveFailureCountCapped: false,
    unconfigured: false,
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  owner = {
    ownerId: "owner-1",
    authId: "owner-auth-1",
    email: "owner@example.com",
    role: "admin",
  }
  health = currentHealth()
  mocks.issueProof.mockResolvedValue({ status: "unconfigured" })
  mocks.runSelfTest.mockResolvedValue({ status: "ok", httpStatus: 204 })
  mocks.verifyPairing.mockResolvedValue({ status: "pass" })
  mocks.useQuery.mockImplementation((reference: unknown, args: unknown) => {
    const name = getFunctionName(reference as never)
    if (name === "cms/owner:getOwnerSession") {
      return owner
    }
    if (name === "cms/revalidate:getRevalidationHealth") {
      return args === "skip" ? undefined : health
    }
    throw new Error(`Unexpected query: ${name}`)
  })
})

describe("RevalidationDiagnostics health truth surface", () => {
  test("renders a loading state while owner or health load", () => {
    owner = undefined
    const view = renderDiagnostics()
    expect(
      screen.getByText("Checking public-site updates…")
    ).toBeInTheDocument()

    owner = {
      ownerId: "owner-1",
      authId: "owner-auth-1",
      email: "owner@example.com",
      role: "admin",
    }
    health = undefined
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <RevalidationDiagnostics />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByText("Checking public-site updates…")
    ).toBeInTheDocument()
  })

  test("renders no-attempt, healthy, unconfigured, HTTP, and network states truthfully", () => {
    const view = renderDiagnostics()
    expect(
      screen.getByText("No public-site updates have been checked yet.")
    ).toBeInTheDocument()

    health = currentHealth({ recentAttempts: [{ status: "ok" }] })
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <RevalidationDiagnostics />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByText("The latest public-site update completed.")
    ).toBeInTheDocument()

    health = currentHealth({
      recentAttempts: [{ status: "unconfigured" }],
      unconfigured: true,
    })
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <RevalidationDiagnostics />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByText("Public-site updates need setup.")
    ).toBeInTheDocument()

    health = currentHealth({
      recentAttempts: [{ status: "http_error", httpStatus: 503 }],
      consecutiveFailureCount: 50,
      consecutiveFailureCountCapped: true,
    })
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <RevalidationDiagnostics />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByText("The public site rejected the latest update (code 503).")
    ).toBeInTheDocument()
    expect(
      screen.getByText("At least 50 consecutive failures.")
    ).toBeInTheDocument()

    health = currentHealth({ recentAttempts: [{ status: "network_error" }] })
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <RevalidationDiagnostics />
      </NextIntlClientProvider>
    )
    expect(
      screen.getByText(
        "The latest update could not reach the public site. Check the site address and whether the site is available."
      )
    ).toBeInTheDocument()
    expect(screen.queryByText(/errorSnippet/i)).not.toBeInTheDocument()
  })
})

describe("RevalidationDiagnostics active checks", () => {
  test("hides active controls for an unrelated identity", () => {
    owner = null
    renderDiagnostics()

    expect(document.body).not.toHaveTextContent("Test public-site updates")
    expect(
      screen.queryByText(
        "You can view these results, but you do not have permission to run checks."
      )
    ).not.toBeInTheDocument()
  })

  test("renders self-test success and failure outcomes without duplicate invocation", async () => {
    let resolveSelfTest:
      ((value: { status: "ok"; httpStatus: number }) => void) | undefined
    mocks.runSelfTest.mockImplementation(
      () =>
        new Promise<{ status: "ok"; httpStatus: number }>((resolve) => {
          resolveSelfTest = resolve
        })
    )
    renderDiagnostics()

    const button = screen.getByRole("button", {
      name: "Test public-site updates",
    })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.runSelfTest).toHaveBeenCalledOnce()
    expect(button).toBeDisabled()

    resolveSelfTest?.({ status: "ok", httpStatus: 204 })
    await waitFor(() => {
      expect(
        screen.getByText("The public site accepted the test update (code 204).")
      ).toBeInTheDocument()
    })

    mocks.runSelfTest.mockResolvedValue({ status: "ok", httpStatus: 700 })
    fireEvent.click(
      screen.getByRole("button", { name: "Test public-site updates" })
    )
    await waitFor(() => {
      expect(
        screen.getByText("The public site accepted the test update.")
      ).toBeInTheDocument()
    })
    expect(screen.queryByText(/code 700/)).not.toBeInTheDocument()

    mocks.runSelfTest.mockResolvedValue({ status: "network_error" })
    fireEvent.click(
      screen.getByRole("button", { name: "Test public-site updates" })
    )
    await waitFor(() => {
      expect(
        screen.getByText(
          "The test could not reach the public site. Check the site address and try again."
        )
      ).toBeInTheDocument()
    })
  })

  test("renders pairing pass, fail, and unconfigured outcomes without exposing proof material", async () => {
    const proof = {
      expiresAt: 123_456,
      signature: "proof-signature-must-not-render",
    }
    mocks.issueProof.mockResolvedValue({ status: "issued", proof })
    let resolvePairing: ((value: { status: "pass" }) => void) | undefined
    mocks.verifyPairing.mockImplementation(
      () =>
        new Promise<{ status: "pass" }>((resolve) => {
          resolvePairing = resolve
        })
    )
    renderDiagnostics()

    const button = screen.getByRole("button", {
      name: "Test form request protection",
    })
    fireEvent.click(button)
    fireEvent.click(button)
    expect(mocks.issueProof).toHaveBeenCalledOnce()
    expect(button).toBeDisabled()
    await waitFor(() => expect(mocks.verifyPairing).toHaveBeenCalledWith(proof))
    resolvePairing?.({ status: "pass" })
    await waitFor(() => {
      expect(
        screen.getByText("Your forms can limit repeat requests.")
      ).toBeInTheDocument()
    })
    expect(document.body.textContent).not.toContain(proof.signature)
    expect(document.body.textContent).not.toContain(String(proof.expiresAt))

    mocks.verifyPairing.mockResolvedValue({ status: "fail" })
    fireEvent.click(
      screen.getByRole("button", { name: "Test form request protection" })
    )
    await waitFor(() => {
      expect(
        screen.getByText(
          "The form protection settings do not match. Ask your site maintainer to use the same private code everywhere."
        )
      ).toBeInTheDocument()
    })

    mocks.issueProof.mockResolvedValue({ status: "unconfigured" })
    fireEvent.click(
      screen.getByRole("button", { name: "Test form request protection" })
    )
    await waitFor(() => {
      expect(
        screen.getByText(
          "Form request protection needs setup. Ask your site maintainer to add the same private code everywhere."
        )
      ).toBeInTheDocument()
    })
  })
})

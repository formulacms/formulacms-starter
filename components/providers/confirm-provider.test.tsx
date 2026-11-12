import { fireEvent, screen } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogDescription: ({ children }: { children: React.ReactNode }) => (
    <p>{children}</p>
  ),
  DialogFooter: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogHeader: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  DialogTitle: ({ children }: { children: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
}))

vi.mock("@/components/ui/popover", () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => (
    <div>{children}</div>
  ),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}))

import { ConfirmProvider, useConfirm, usePrompt } from "./confirm-provider"

function PromptHarness({ variant }: { variant: "chips" | "dropdown" }) {
  const prompt = usePrompt()

  return (
    <button
      type="button"
      onClick={() => {
        void prompt({
          title: "Write with a preset",
          multiline: true,
          presets: [
            { label: "Tone", body: "First body" },
            { label: "Tone", body: "Second body" },
          ],
          presetsVariant: variant,
        })
      }}
    >
      Open prompt
    </button>
  )
}

describe("ConfirmProvider prompt presets", () => {
  it.each(["chips", "dropdown"] as const)(
    "keeps duplicate-label %s presets independently selectable",
    (variant) => {
      render(
        <ConfirmProvider>
          <PromptHarness variant={variant} />
        </ConfirmProvider>
      )

      fireEvent.click(screen.getByRole("button", { name: "Open prompt" }))

      const rows =
        variant === "chips"
          ? screen.getAllByRole("button", { name: "Tone" })
          : [
              screen.getByRole("button", { name: "ToneFirst body" }),
              screen.getByRole("button", { name: "ToneSecond body" }),
            ]

      fireEvent.click(rows[1])

      expect(screen.getByRole("textbox")).toHaveValue("Second body")
      expect(rows[0]).toHaveAttribute("aria-pressed", "false")
      expect(rows[1]).toHaveAttribute("aria-pressed", "true")
    }
  )
})

function ConfirmHarness() {
  const confirm = useConfirm()
  return <button onClick={() => { void confirm({ title: "Proceed?" }) }}>Open confirm</button>
}

describe("ConfirmProvider effective French defaults", () => {
  it("translates confirm and cancel without caller overrides", () => {
    render(<ConfirmProvider><ConfirmHarness /></ConfirmProvider>, { locale: "fr" })
    fireEvent.click(screen.getByRole("button", { name: "Open confirm" }))
    expect(screen.getByRole("button", { name: "Confirmer" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Annuler" })).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Confirm" })).not.toBeInTheDocument()
  })
  it.each(["chips", "dropdown"] as const)("translates %s prompt defaults", (variant) => {
    render(<ConfirmProvider><PromptHarness variant={variant} /></ConfirmProvider>, { locale: "fr" })
    fireEvent.click(screen.getByRole("button", { name: "Open prompt" }))
    expect(screen.getByText("Modèles")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Enregistrer" })).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Annuler" })).toBeInTheDocument()
    if (variant === "dropdown") expect(screen.getByRole("combobox")).toHaveTextContent("Choisir un texte de départ…")
  })
})

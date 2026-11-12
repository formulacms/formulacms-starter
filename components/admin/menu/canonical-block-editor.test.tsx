import { fireEvent, render, screen } from "@testing-library/react"
import { NextIntlClientProvider } from "next-intl"
import { expect, test, vi } from "vitest"
import en from "@/messages/admin/en.json"
import fr from "@/messages/admin/fr.json"
import { CanonicalBlockEditor } from "./canonical-block-editor"

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => async () => true,
}))

vi.mock("./menu-target-field", () => ({
  MenuTargetField: () => <div data-testid="target-field" />,
}))

vi.mock("./icon-picker", () => ({
  IconPicker: () => <div data-testid="icon-picker" />,
}))

vi.mock("@/components/admin/media-picker", () => ({
  MediaPicker: ({
    open,
    onSelect,
  }: {
    open: boolean
    onSelect: (image: { url: string; width: number; height: number }) => void
  }) =>
    open ? (
      <button
        type="button"
        onClick={() =>
          onSelect({
            url: "https://example.com/new.jpg",
            width: 1200,
            height: 800,
          })
        }
      >
        Pick fixture image
      </button>
    ) : null,
}))

test("media selection changes shared image fields without replacing localized alt", () => {
  const onChange = vi.fn()
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CanonicalBlockEditor
        block={{
          id: "feature",
          kind: "featured",
          image: { alt: "Texte alternatif" },
          heading: "Feature",
          target: { type: "external", url: "https://example.com" },
        }}
        locale="fr"
        onChange={onChange}
        onDelete={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        isFirst
        isLast
      />
    </NextIntlClientProvider>
  )

  fireEvent.click(screen.getByRole("button", { name: "Select image" }))
  fireEvent.click(screen.getByRole("button", { name: "Pick fixture image" }))
  expect(onChange).toHaveBeenLastCalledWith(
    expect.objectContaining({
      image: {
        url: "https://example.com/new.jpg",
        width: 1200,
        height: 800,
        alt: "Texte alternatif",
      },
    })
  )
})

test("secondary-locale mode exposes text but no shared image or target controls", () => {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <CanonicalBlockEditor
        block={{
          id: "feature",
          kind: "featured",
          image: { alt: "French alt" },
          heading: "French heading",
          target: { type: "external", url: "https://example.com" },
        }}
        locale="fr"
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        isFirst
        isLast
        canEditStructure={false}
      />
    </NextIntlClientProvider>
  )

  expect(screen.getByDisplayValue("French heading")).toBeEnabled()
  expect(screen.getByDisplayValue("French alt")).toBeEnabled()
  expect(screen.queryByRole("button", { name: /select image/i })).toBeNull()
  expect(screen.queryByTestId("target-field")).toBeInTheDocument()
  expect(screen.queryByLabelText("Block width")).toBeNull()
})

test("renders canonical block controls in French", () => {
  render(
    <NextIntlClientProvider locale="fr" messages={fr}>
      <CanonicalBlockEditor
        block={{
          id: "feature",
          kind: "featured",
          image: { alt: "Texte alternatif" },
          heading: "À la une",
          target: { type: "external", url: "https://example.com" },
        }}
        locale="fr"
        onChange={vi.fn()}
        onDelete={vi.fn()}
        onMoveUp={vi.fn()}
        onMoveDown={vi.fn()}
        isFirst
        isLast
      />
    </NextIntlClientProvider>
  )

  expect(screen.getByRole("button", { name: "Réduire le bloc" })).toBeTruthy()
  expect(screen.getByText("Bloc mis en avant")).toBeInTheDocument()
  expect(screen.getByLabelText("Largeur du bloc")).toBeEnabled()
  expect(screen.getByLabelText("En-tête")).toHaveValue("À la une")
})

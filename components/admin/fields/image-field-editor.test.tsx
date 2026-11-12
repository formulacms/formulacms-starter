import { useState } from "react"
import { act, fireEvent, screen } from "@testing-library/react"
import { beforeEach, expect, test, vi } from "vitest"
import type { ImageField } from "@/convex/lib/slices"
import { render } from "@/test-utils/admin-i18n"
import {
  ImageFieldEditor,
  ImageFieldLocaleProvider,
} from "./image-field-editor"

type PickerProps = {
  open: boolean
  locale?: string
  onSelect: (image: ImageField) => void
}
type TransformProps = {
  open: boolean
  image: ImageField | undefined
  onApply: (image: ImageField) => void
}
const seams = vi.hoisted(() => ({
  picker: vi.fn<(props: PickerProps) => void>(),
  transform: vi.fn<(props: TransformProps) => void>(),
}))

vi.mock("../media-picker", () => ({
  MediaPicker: (props: PickerProps) => {
    seams.picker(props)
    return null
  },
}))
vi.mock("../media-image-editor", () => ({
  ImageTransformEditorDialog: (props: TransformProps) => {
    seams.transform(props)
    return null
  },
}))

const initial: ImageField = {
  url: "/source.jpg",
  alt: "Façade",
  width: 1600,
  height: 900,
  crop: { x: 25, y: 0, width: 50, height: 100 },
  cropSize: { width: 800, height: 900 },
  focal: { x: 40, y: 60 },
}

function mount(locale?: string) {
  const onChange = vi.fn()
  function Harness() {
    const [image, setImage] = useState<ImageField | undefined>(initial)
    return (
      <ImageFieldLocaleProvider locale="fr">
        <ImageFieldEditor
          label="Cover"
          value={image}
          locale={locale}
          onChange={(next) => {
            onChange(next)
            setImage(next)
          }}
        />
        <output aria-label="Image draft">
          {JSON.stringify(image ?? null)}
        </output>
      </ImageFieldLocaleProvider>
    )
  }
  render(<Harness />)
  return onChange
}

beforeEach(() => vi.clearAllMocks())

test("alt, reset and clear callbacks preserve unrelated metadata without an implicit edit", () => {
  const changed = mount()
  expect(changed).not.toHaveBeenCalled()
  fireEvent.change(screen.getByRole("textbox", { name: "Alt text" }), {
    target: { value: "Façade <north>" },
  })
  expect(changed).toHaveBeenLastCalledWith({
    ...initial,
    alt: "Façade <north>",
  })
  fireEvent.click(screen.getByRole("button", { name: "Reset framing" }))
  expect(changed).toHaveBeenLastCalledWith({
    ...initial,
    alt: "Façade <north>",
    crop: undefined,
    cropSize: undefined,
    focal: undefined,
  })
  expect(screen.getByLabelText("Image draft")).toHaveTextContent(
    JSON.stringify({
      url: initial.url,
      alt: "Façade <north>",
      width: initial.width,
      height: initial.height,
    })
  )
  fireEvent.click(screen.getByRole("button", { name: "Remove image" }))
  expect(changed).toHaveBeenLastCalledWith(undefined)
  expect(
    screen.getByRole("button", { name: "Choose image" })
  ).toBeInTheDocument()
  expect(screen.getByLabelText("Image draft")).toHaveTextContent("null")
})

test("the existing transform callback receives and returns the complete image draft", () => {
  const changed = mount()
  fireEvent.click(screen.getByRole("button", { name: "Edit crop & focal" }))
  const transform = seams.transform.mock.lastCall![0]
  expect(transform).toMatchObject({ open: true, image: initial })
  const applied = {
    ...initial,
    crop: { x: 0, y: 0, width: 50, height: 100 },
    focal: { x: 25, y: 75 },
  }
  act(() => transform.onApply(applied))
  expect(changed).toHaveBeenCalledExactlyOnceWith(applied)
  expect(screen.getByLabelText("Image draft")).toHaveTextContent(
    JSON.stringify(applied)
  )
})

test.each([
  { locale: undefined, expected: "fr" },
  { locale: "en", expected: "en" },
])(
  "replacement routes locale $expected, retains alt and replaces old framing",
  ({ locale, expected }) => {
    const changed = mount(locale)
    fireEvent.click(screen.getByRole("button", { name: "Replace image" }))
    const picker = seams.picker.mock.lastCall![0]
    expect(picker).toMatchObject({ open: true, locale: expected })
    const picked = { url: "/replacement.jpg", width: 800, height: 600 }
    act(() => picker.onSelect(picked))
    expect(changed).toHaveBeenCalledExactlyOnceWith({
      ...picked,
      alt: initial.alt,
    })
    expect(screen.getByLabelText("Image draft")).toHaveTextContent(
      JSON.stringify({ ...picked, alt: initial.alt })
    )
    expect(screen.queryByRole("button", { name: "Reset framing" })).toBeNull()
  }
)

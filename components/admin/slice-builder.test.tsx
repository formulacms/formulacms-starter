import { sliceProfileAny, sliceProfile } from "@/test-utils/slice-profile"
import { useLayoutEffect, useState } from "react"
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  INSTALLED_SLICE_TYPES,
  REGISTERED_SLICE_TYPES,
  sliceDefs,
  type Slice,
} from "@/convex/lib/slices"
import { group, list, richText } from "@/convex/lib/slices/primitives"
import { createSampleSlice } from "@/lib/slices/sample"
import { SLICE_METADATA, type SliceMetadata } from "@/lib/slices/builder"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import type { FieldGenerate } from "./fields/field-editor"
import { SliceBuilder } from "./slice-builder"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  prompt: vi.fn(),
  error: vi.fn(),
  installedTypes: null as string[] | null,
  metadata: null as Record<string, SliceMetadata> | null,
  editorUpdates: new Map<string, (next: Slice) => void>(),
  archivedTypesQuery: {
    current: { status: "success", data: [] } as
      | { status: "pending" }
      | { status: "error"; error: Error }
      | { status: "success"; data: string[] },
  },
}))

vi.mock("@/convex/lib/slices", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/convex/lib/slices")>()
  return {
    ...actual,
    get INSTALLED_SLICE_TYPES() {
      return mocks.installedTypes ?? actual.INSTALLED_SLICE_TYPES
    },
  }
})

vi.mock("@/lib/slices/builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/slices/builder")>()
  return {
    ...actual,
    get SLICE_METADATA() {
      return mocks.metadata ?? actual.SLICE_METADATA
    },
    readSliceMetadata(type: string) {
      const metadata: Readonly<Partial<Record<string, SliceMetadata>>> =
        mocks.metadata ?? actual.SLICE_METADATA
      return metadata[type]
    },
  }
})

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
  useQuery_experimental: vi.fn(() => mocks.archivedTypesQuery.current),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => mocks.confirm,
  usePrompt: () => mocks.prompt,
}))

vi.mock("sonner", () => ({ toast: { error: mocks.error } }))

vi.mock("./slice-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./slice-editor")>()
  return {
    ...actual,
    SliceEditor: (props: Parameters<typeof actual.SliceEditor>[0]) => {
      mocks.editorUpdates.set(props.slice.id, props.onChange)
      return <actual.SliceEditor {...props} />
    },
  }
})

function sampleSlice(type: Slice["type"], id: string): Slice {
  return {
    ...createSampleSlice(type),
    id,
  }
}

function renderBuilder({
  title = "About us",
  locale = "en",
  slices = [],
  pickerOpen = false,
  onChange = vi.fn(),
  onPickerOpenChange = vi.fn(),
  selectedSliceId,
  focusedFieldTarget,
  focusedFirstControlTarget,
  onSelectedSliceIdChange = vi.fn(),
  archiveStateVerificationFailure = false,
  generate,
}: {
  title?: string
  locale?: "en" | "fr"
  slices?: Slice[]
  pickerOpen?: boolean
  onChange?: (next: Slice[]) => void
  onPickerOpenChange?: (open: boolean) => void
  selectedSliceId?: string | null
  focusedFieldTarget?: {
    sliceId: string
    fieldPath: string
    nonce: number
  } | null
  focusedFirstControlTarget?: { sliceId: string; nonce: number } | null
  onSelectedSliceIdChange?: (sliceId: string | null) => void
  archiveStateVerificationFailure?: boolean
  generate?: FieldGenerate
} = {}) {
  return {
    onChange,
    onPickerOpenChange,
    onSelectedSliceIdChange,
    ...render(
      <SliceBuilder
        title={title}
        slices={slices}
        onChange={onChange}
        currentLocale={locale}
        pickerOpen={pickerOpen}
        onPickerOpenChange={onPickerOpenChange}
        selectedSliceId={selectedSliceId}
        focusedFieldTarget={focusedFieldTarget}
        focusedFirstControlTarget={focusedFirstControlTarget}
        onSelectedSliceIdChange={onSelectedSliceIdChange}
        archiveStateVerificationFailure={archiveStateVerificationFailure}
        generate={generate}
      />,
      { locale }
    ),
  }
}

function draggableRow(label: string): HTMLElement {
  const row = screen.getByText(label).closest("[draggable='true']")
  expect(row).toBeInstanceOf(HTMLElement)
  return row as HTMLElement
}

// Reuse the existing act-wrapped real focus and explicit button-click pattern.
// Each fireEvent flushes separately, so focus can rerender before the click.
function clickSliceControl(target: HTMLElement, pointer: "mouse" | "touch") {
  fireEvent.pointerDown(target, { pointerType: pointer })
  if (pointer === "mouse") {
    fireEvent.mouseDown(target)
    act(() => target.focus())
  }
  fireEvent.pointerUp(target, { pointerType: pointer })
  if (pointer === "mouse") fireEvent.mouseUp(target)
  else act(() => target.focus())
  fireEvent.click(target)
}

function pressDisclosureKey(target: HTMLElement, key: "Enter" | " ") {
  // jsdom does not synthesize native button activation from keyboard events.
  fireEvent.keyDown(target, { key })
  if (key === "Enter") fireEvent.click(target)
  fireEvent.keyUp(target, { key })
  if (key === " ") fireEvent.click(target)
}

function renderControlledDisclosures() {
  const slices = [
    sampleSlice("hero-agency", "one"),
    sampleSlice("hero-agency", "two"),
  ]
  const onSelect = vi.fn()
  const onChange = vi.fn()
  function ControlledBuilder() {
    const [selected, setSelected] = useState<string | null>(null)
    return (
      <SliceBuilder
        slices={slices}
        currentLocale="en"
        onChange={onChange}
        pickerOpen={false}
        onPickerOpenChange={vi.fn()}
        selectedSliceId={selected}
        onSelectedSliceIdChange={(id) => {
          onSelect(id)
          setSelected(id)
        }}
      />
    )
  }
  const view = render(<ControlledBuilder />)
  const toggles = screen.getAllByRole("button", { expanded: false })
  return { ...view, toggles, onSelect, onChange }
}

describe("SliceBuilder slice list editing", () => {
  it.each(["mouse", "touch"] as const)(
    "R4 toggles a controlled disclosure once per %s gesture",
    sliceProfile([]),
    (pointer) => {
      const {
        toggles: [first, second],
      } = renderControlledDisclosures()
      const click = (target: HTMLElement) => clickSliceControl(target, pointer)
      expect(first).toHaveAttribute("aria-expanded", "false")
      click(first)
      expect(first).toHaveAttribute("aria-expanded", "true")
      click(first)
      expect(first).toHaveAttribute("aria-expanded", "false")
      click(second)
      expect(second).toHaveAttribute("aria-expanded", "true")
      click(first)
      expect(first).toHaveAttribute("aria-expanded", "true")
      expect(second).toHaveAttribute("aria-expanded", "false")
      click(first)
      expect(first).toHaveAttribute("aria-expanded", "false")
    }
  )

  it(
    "R4 keeps keyboard focus opening and Enter/Space toggling",
    sliceProfile([]),
    () => {
      const {
        toggles: [first],
        onSelect,
      } = renderControlledDisclosures()
      act(() => first.focus())
      expect(first).toHaveFocus()
      expect(onSelect).toHaveBeenLastCalledWith("one")
      expect(first).toHaveAttribute("aria-expanded", "true")
      pressDisclosureKey(first, "Enter")
      expect(first).toHaveAttribute("aria-expanded", "false")
      pressDisclosureKey(first, " ")
      expect(first).toHaveAttribute("aria-expanded", "true")
      pressDisclosureKey(first, " ")
      expect(first).toHaveAttribute("aria-expanded", "false")
    }
  )

  it(
    "R4 pointer reorder leaves collapsed selection alone",
    sliceProfile([]),
    () => {
      const { toggles, onSelect, onChange } = renderControlledDisclosures()
      clickSliceControl(
        screen.getByRole("button", { name: "Move Hero Agency 1 down" }),
        "mouse"
      )
      expect(onSelect).not.toHaveBeenCalled()
      expect(onChange).toHaveBeenCalledOnce()
      for (const toggle of toggles)
        expect(toggle).toHaveAttribute("aria-expanded", "false")
    }
  )

  it.each(["focus", "click"] as const)(
    "selects from a row control on %s without scrolling the row", sliceProfile([]),
    (event) => {
      const slice = sampleSlice("hero-agency", "row-selected")
      const onSelectedSliceIdChange = vi.fn()
      const scrollIntoView = vi.fn()
      const original = Object.getOwnPropertyDescriptor(
        Element.prototype,
        "scrollIntoView"
      )
      Object.defineProperty(Element.prototype, "scrollIntoView", {
        configurable: true,
        value: scrollIntoView,
      })
      Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
      function ControlledBuilder() {
        const [selected, setSelected] = useState<string | null>(null)
        return (
          <SliceBuilder
            slices={[slice]}
            currentLocale="en"
            onChange={vi.fn()}
            pickerOpen={false}
            onPickerOpenChange={vi.fn()}
            selectedSliceId={selected}
            onSelectedSliceIdChange={(id) => {
              onSelectedSliceIdChange(id)
              setSelected(id)
            }}
          />
        )
      }
      try {
        const view = render(<ControlledBuilder />)
        const button = screen.getByTitle("Remove block")
        if (event === "focus") act(() => button.focus())
        else fireEvent.click(button)
        expect(onSelectedSliceIdChange).toHaveBeenCalledWith(slice.id)
        const row = view.container.querySelector("[tabindex='-1']")!
        expect(row).toHaveClass("border-primary/60")
        expect(scrollIntoView).not.toHaveBeenCalled()
      } finally {
        if (original)
          Object.defineProperty(Element.prototype, "scrollIntoView", original)
        else Reflect.deleteProperty(Element.prototype, "scrollIntoView")
      }
    }
  )

  it("scrolls a new selection supplied by the parent after a row selection", sliceProfile([]), () => {
    const first = sampleSlice("hero-agency", "row-selected")
    const second = sampleSlice("faq-simple", "parent-selected")
    const view = renderBuilder({ slices: [first, second] })
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    fireEvent.focus(screen.getAllByTitle("Remove block")[0])
    function select(id: string | null) {
      view.rerender(
        <SliceBuilder
          slices={[first, second]}
          currentLocale="en"
          onChange={view.onChange}
          pickerOpen={false}
          onPickerOpenChange={view.onPickerOpenChange}
          selectedSliceId={id}
          onSelectedSliceIdChange={view.onSelectedSliceIdChange}
        />
      )
    }
    select(first.id)
    scrollIntoView.mockClear()
    select(second.id)
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" })
    expect(scrollIntoView.mock.instances[0]).toBe(
      view.container.querySelectorAll("[tabindex='-1']")[1]
    )
    scrollIntoView.mockClear()
    select(first.id)
    expect(scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: "nearest" })
  })

  it.each(["en", "fr"] as const)(
    "reports a removal refusal before confirmation in %s", sliceProfile([]),
    (locale) => {
      const first = sampleSlice("hero-agency", "duplicate")
      const second = sampleSlice("faq-simple", "duplicate")
      const onChange = vi.fn()
      renderBuilder({ slices: [first, second], locale, onChange })
      // Keep the unrepaired parent input to exercise the existing identity guard.
      onChange.mockClear()
      fireEvent.click(
        screen.getAllByTitle(locale === "fr" ? "Supprimer le bloc" : "Remove block")[0]
      )
      expect(mocks.confirm).not.toHaveBeenCalled()
      expect(onChange).not.toHaveBeenCalled()
      expect(mocks.error).toHaveBeenCalledWith(
        locale === "fr"
          ? "Ce bloc n’a pas pu être supprimé. Vérifiez-le avant de réessayer."
          : "This block couldn't be removed. Review it before trying again."
      )
    }
  )

  async function focusFirstEnabledControl(ariaDisabledCombobox = false) {
    const slice = sampleSlice("hero-with-image", "focus-target")
    const scrollIntoView = vi.fn()
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    )
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    try {
      const view = renderBuilder({
        slices: [slice],
        selectedSliceId: slice.id,
        focusedFirstControlTarget: { sliceId: slice.id, nonce: 1 },
      })
      const row = view.container.querySelector<HTMLElement>("[tabindex='-1']")!
      const disabledPresentation =
        row.querySelector<HTMLElement>("[role='combobox']")!
      expect(disabledPresentation).toBeDisabled()

      if (ariaDisabledCombobox) {
        const customCombobox = document.createElement("button")
        customCombobox.type = "button"
        customCombobox.setAttribute("role", "combobox")
        customCombobox.setAttribute("aria-disabled", "true")
        customCombobox.tabIndex = 0
        view.rerender(
          <SliceBuilder
            slices={[slice]}
            currentLocale="en"
            onChange={view.onChange}
            pickerOpen={false}
            onPickerOpenChange={view.onPickerOpenChange}
            selectedSliceId={slice.id}
            focusedFirstControlTarget={{ sliceId: slice.id, nonce: 2 }}
          />
        )
        row.prepend(customCombobox)
        expect(customCombobox).toHaveAttribute("aria-disabled", "true")
      }

      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
      })
      const enabledControl = row.querySelector<HTMLElement>(
        "input:not([type='hidden']):not(:disabled):not([disabled]):not([aria-disabled='true']), textarea:not(:disabled):not([disabled]):not([aria-disabled='true']), select:not(:disabled):not([disabled]):not([aria-disabled='true']), [contenteditable='true']:not([disabled]):not([aria-disabled='true']), [role='combobox']:not(:disabled):not([disabled]):not([aria-disabled='true'])"
      )!
      expect(enabledControl.tagName).toBe("INPUT")
      expect(enabledControl).toHaveAttribute("aria-label", "Eyebrow")
      expect(document.activeElement).toBe(enabledControl)
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" })
      expect(
        scrollIntoView.mock.calls.every(
          ([options]) =>
            !Object.prototype.hasOwnProperty.call(options, "behavior")
        )
      ).toBe(true)
    } finally {
      if (original)
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original)
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
    }
  }

  it("focuses the first enabled control after a native disabled combobox", sliceProfile([]), async () => {
    await focusFirstEnabledControl()
  })

  it("skips an aria-disabled custom combobox before the first enabled field", sliceProfile([]), async () => {
    await focusFirstEnabledControl(true)
  })

  it("focuses the exact primary-list rich-text control selected from preview", sliceProfile([]), async () => {
    const originalDef = sliceDefs["hero-with-image"]
    const syntheticPrimary = group({
      ...originalDef.primary.config.fields,
      features: list(group({ title: richText({ profile: "inline" }) })),
    })
    const slice = sampleSlice("hero-with-image", "primary-list-focus")
    Reflect.set(slice.primary, "features", [{ title: "{}" }])
    const originalElementRects = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "getClientRects"
    )
    const originalElementRect = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "getBoundingClientRect"
    )
    const originalRangeRects = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getClientRects"
    )
    const originalRangeRect = Object.getOwnPropertyDescriptor(
      Range.prototype,
      "getBoundingClientRect"
    )
    Object.defineProperty(HTMLElement.prototype, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect()],
    })
    Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    })
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect()],
    })
    Object.defineProperty(Range.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(),
    })
    Reflect.set(sliceDefs, "hero-with-image", {
      ...originalDef,
      primary: syntheticPrimary,
    })
    let view: ReturnType<typeof renderBuilder> | undefined
    try {
      view = renderBuilder({
        slices: [slice],
        selectedSliceId: slice.id,
        focusedFieldTarget: {
          sliceId: slice.id,
          fieldPath: "primary.features.0.title",
          nonce: 1,
        },
      })
      const field = view.container.querySelector<HTMLElement>(
        '[data-slice-field-path="primary.features.0.title"]'
      )
      if (!field) throw new Error("Expected the exact primary-list form field")
      // The editor loads lazily; allow for a slow load under suite load.
      await waitFor(
        () => {
          expect(document.activeElement).not.toBe(document.body)
          expect(field.contains(document.activeElement)).toBe(true)
        },
        { timeout: 5_000 }
      )
    } finally {
      view?.unmount()
      Reflect.set(sliceDefs, "hero-with-image", originalDef)
      if (originalElementRects)
        Object.defineProperty(
          HTMLElement.prototype,
          "getClientRects",
          originalElementRects
        )
      else Reflect.deleteProperty(HTMLElement.prototype, "getClientRects")
      if (originalElementRect)
        Object.defineProperty(
          HTMLElement.prototype,
          "getBoundingClientRect",
          originalElementRect
        )
      else
        Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect")
      if (originalRangeRects)
        Object.defineProperty(
          Range.prototype,
          "getClientRects",
          originalRangeRects
        )
      else Reflect.deleteProperty(Range.prototype, "getClientRects")
      if (originalRangeRect)
        Object.defineProperty(
          Range.prototype,
          "getBoundingClientRect",
          originalRangeRect
        )
      else Reflect.deleteProperty(Range.prototype, "getBoundingClientRect")
    }
  })

  it("scrolls the selected slice and focused field without forcing smooth motion", sliceProfile([]), async () => {
    const slice = sampleSlice("hero-with-image", "scroll-target")
    const scrollIntoView = vi.fn()
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView"
    )
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    try {
      const view = renderBuilder({
        slices: [slice],
        selectedSliceId: slice.id,
        focusedFieldTarget: {
          sliceId: slice.id,
          fieldPath: "primary.eyebrow",
          nonce: 1,
        },
      })
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
      })
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "nearest" })
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" })
      expect(
        scrollIntoView.mock.calls.every(
          ([options]) =>
            !Object.prototype.hasOwnProperty.call(options, "behavior")
        )
      ).toBe(true)
      expect(
        view.container.querySelector(
          '[data-slice-field-path="primary.eyebrow"]'
        )
      ).not.toBeNull()
    } finally {
      if (original)
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original)
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
    }
  })
  beforeEach(() => {
    mocks.confirm.mockReset()
    mocks.prompt.mockReset()
    mocks.error.mockReset()
    mocks.editorUpdates.clear()
    mocks.confirm.mockResolvedValue(true)
    mocks.prompt.mockResolvedValue(null)
    mocks.installedTypes = null
    mocks.metadata = null
    mocks.archivedTypesQuery.current = { status: "success", data: [] }
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn(),
    })
  })

  it.each(["en", "fr"] as const)(
    "new: appends a pending starter through current callbacks with decorative icons in %s", sliceProfile(["hero-agency"]),
    async (locale) => {
      let resolve!: (slice: Slice) => void
      const generate: FieldGenerate = {
        run: vi.fn(),
        runRefine: vi.fn(),
        runSlice: vi.fn(() => new Promise<Slice>((done) => (resolve = done))),
      }
      const first = sampleSlice("hero-agency", "slice_a")
      const other = sampleSlice("faq-simple", "slice_b")
      const view = renderBuilder({
        locale,
        slices: [first, other],
        pickerOpen: true,
        generate,
      })
      const starterName =
        locale === "fr"
          ? "Contenu initial — Bannière d’agence"
          : "Starter — Hero Agency"
      const starterButton = screen.getByRole("button", { name: starterName })
      expect(starterButton.querySelector("svg")).toHaveAttribute(
        "aria-hidden",
        "true"
      )
      fireEvent.click(starterButton)
      expect(starterButton.querySelector("svg")).toHaveAttribute(
        "aria-hidden",
        "true"
      )
      expect(starterButton).toBeDisabled()
      expect(generate.runSlice).toHaveBeenCalledTimes(1)
      const type = vi.mocked(generate.runSlice).mock.calls[0][0]
      const generated = sampleSlice(type, "generated")
      const edited = { ...first, enabled: false }
      const newSibling = sampleSlice("hero-with-image", "slice_c")
      const onChange = vi.fn()
      const onPickerOpenChange = vi.fn()
      const onSelectedSliceIdChange = vi.fn()
      view.rerender(
        <SliceBuilder
          slices={[newSibling, edited]}
          currentLocale={locale}
          generate={generate}
          onChange={onChange}
          pickerOpen
          onPickerOpenChange={onPickerOpenChange}
          onSelectedSliceIdChange={onSelectedSliceIdChange}
        />
      )
      await act(async () => resolve(generated))
      expect(onChange).toHaveBeenCalledExactlyOnceWith([
        newSibling,
        edited,
        generated,
      ])
      expect(view.onChange).not.toHaveBeenCalled()
      expect(onSelectedSliceIdChange).toHaveBeenCalledExactlyOnceWith(
        generated.id
      )
      expect(view.onSelectedSliceIdChange).not.toHaveBeenCalled()
      expect(onPickerOpenChange).toHaveBeenCalledExactlyOnceWith(false)
      expect(view.onPickerOpenChange).not.toHaveBeenCalled()
      expect(mocks.error).not.toHaveBeenCalled()
      const restoredStarter = screen.getByRole("button", { name: starterName })
      expect(restoredStarter).toBeEnabled()
      expect(restoredStarter.querySelector("svg")).toHaveAttribute(
        "aria-hidden",
        "true"
      )
    }
  )

  it.each([
    ["a refused Save stays quiet", new PageSaveRefusedError(), 0],
    ["another failure still reports", new Error("route down"), 1],
  ])(
    "new: starter generation: %s", sliceProfileAny(INSTALLED_SLICE_TYPES),
    async (_name, failure, toasts) => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const generate: FieldGenerate = {
        run: vi.fn(),
        runRefine: vi.fn(),
        runSlice: vi.fn(async () => {
          throw failure
        }),
      }
      renderBuilder({
        slices: [sampleSlice("hero-agency", "slice_a")],
        pickerOpen: true,
        generate,
      })
      fireEvent.click(screen.getAllByRole("button", { name: /^Starter/ })[0])
      await waitFor(() => expect(generate.runSlice).toHaveBeenCalledTimes(1))
      await act(async () => {})
      expect(mocks.error).toHaveBeenCalledTimes(toasts)
    }
  )

  it.each([
    ["a refused Save stays quiet", new PageSaveRefusedError(), 0],
    ["another failure still reports", new Error("route down"), 1],
  ])(
    "new: whole-slice Write: %s", sliceProfileAny(INSTALLED_SLICE_TYPES),
    async (_name, failure, toasts) => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      mocks.prompt.mockResolvedValue("a brief")
      const generate: FieldGenerate = {
        run: vi.fn(),
        runRefine: vi.fn(),
        runSlice: vi.fn(async () => {
          throw failure
        }),
      }
      const slice = sampleSlice("hero-agency", "slice_a")
      renderBuilder({ slices: [slice], selectedSliceId: slice.id, generate })
      fireEvent.click(await screen.findByTitle("Write this block with AI"))
      await waitFor(() => expect(generate.runSlice).toHaveBeenCalledTimes(1))
      await act(async () => {})
      expect(mocks.error).toHaveBeenCalledTimes(toasts)
    }
  )

  it.each([
    "locale",
    "unmounted",
    "archived",
    "pending",
    "error",
    "generation-off",
  ])(
    "new: refuses a pending starter after its %s context changes", sliceProfileAny(INSTALLED_SLICE_TYPES),
    async (change) => {
      let resolve!: (slice: Slice) => void
      const generate: FieldGenerate = {
        run: vi.fn(),
        runRefine: vi.fn(),
        runSlice: vi.fn(() => new Promise<Slice>((done) => (resolve = done))),
      }
      const first = sampleSlice("hero-agency", "slice_a")
      const view = renderBuilder({
        slices: [first],
        pickerOpen: true,
        generate,
      })
      fireEvent.click(screen.getAllByRole("button", { name: /^Starter/ })[0])
      expect(generate.runSlice).toHaveBeenCalledTimes(1)
      const type = vi.mocked(generate.runSlice).mock.calls[0][0]
      if (change === "archived")
        mocks.archivedTypesQuery.current = { status: "success", data: [type] }
      if (change === "pending")
        mocks.archivedTypesQuery.current = { status: "pending" }
      if (change === "error")
        mocks.archivedTypesQuery.current = {
          status: "error",
          error: new Error("Unavailable"),
        }
      if (change === "unmounted") view.unmount()
      else
        view.rerender(
          <SliceBuilder
            slices={[first]}
            currentLocale={change === "locale" ? "fr" : "en"}
            generate={change === "generation-off" ? undefined : generate}
            onChange={view.onChange}
            pickerOpen
            onPickerOpenChange={view.onPickerOpenChange}
            onSelectedSliceIdChange={view.onSelectedSliceIdChange}
          />
        )
      await act(async () => resolve(sampleSlice(type, "generated")))
      expect(view.onChange).not.toHaveBeenCalled()
      expect(view.onSelectedSliceIdChange).not.toHaveBeenCalled()
      expect(view.onPickerOpenChange).not.toHaveBeenCalled()
      if (change === "unmounted") expect(mocks.error).not.toHaveBeenCalled()
      else
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
          "This block changed. Review it before trying again."
        )
    }
  )

  it.each(["en", "fr"] as const)(
    "shows the current title and localized installed choices in %s", sliceProfileAny(INSTALLED_SLICE_TYPES),
    (locale) => {
      const title = locale === "fr" ? "À propos" : "About us"
      const { container, rerender, onChange, onPickerOpenChange } =
        renderBuilder({
          locale,
          title,
        })
      expect(screen.getByRole("heading", { name: title })).toBeVisible()
      expect(
        screen.getByText(
          locale === "fr"
            ? "Choisir le contenu à ajouter"
            : "Choose content to add"
        )
      ).toBeVisible()
      const actions = screen.getAllByRole("button", {
        name: locale === "fr" ? /^Ajouter l’exemple — / : /^Add example — /,
      })
      expect(actions).toHaveLength(INSTALLED_SLICE_TYPES.length)
      const decorativeIcons = container.querySelectorAll("svg")
      expect(decorativeIcons).toHaveLength(INSTALLED_SLICE_TYPES.length * 2)
      for (const icon of decorativeIcons)
        expect(icon).toHaveAttribute("aria-hidden", "true")
      for (const action of actions)
        expect(action).toHaveTextContent(
          locale === "fr" ? "Ajouter l’exemple" : "Add example"
        )
      expect(
        screen.queryByRole("button", {
          name: locale === "fr" ? "Annuler" : "Cancel",
        })
      ).toBeNull()
      expect(screen.queryByText(/CTA Band|Contact|Search/)).toBeNull()
      rerender(
        <SliceBuilder
          title={`${title} 2`}
          slices={[]}
          currentLocale={locale}
          onChange={onChange}
          pickerOpen={false}
          onPickerOpenChange={onPickerOpenChange}
        />
      )
      expect(screen.getByRole("heading", { name: `${title} 2` })).toBeVisible()
    }
  )

  it.each(["en", "fr"] as const)(
    "shows only the title and approved sentence when all installed types are archived in %s", sliceProfile([]),
    (locale) => {
      mocks.archivedTypesQuery.current = {
        status: "success",
        data: [...INSTALLED_SLICE_TYPES],
      }
      renderBuilder({ locale })
      expect(screen.getByRole("heading", { name: "About us" })).toBeVisible()
      expect(
        screen.getByText(
          locale === "fr"
            ? "Rien à ajouter pour le moment."
            : "Nothing is available to add yet."
        )
      ).toBeVisible()
      expect(screen.queryByRole("button")).toBeNull()
      expect(
        screen.queryByText(
          locale === "fr"
            ? "Choisir le contenu à ajouter"
            : "Choose content to add"
        )
      ).toBeNull()
      expect(document.querySelector("img")).toBeNull()
    }
  )

  it.each(["en", "fr"] as const)(
    "supports an empty installed profile in %s without changing registry data", sliceProfile([]),
    (locale) => {
      mocks.installedTypes = []
      renderBuilder({ locale })
      expect(
        screen.getByText(
          locale === "fr"
            ? "Rien à ajouter pour le moment."
            : "Nothing is available to add yet."
        )
      ).toBeVisible()
      expect(screen.queryByRole("button")).toBeNull()
      expect(REGISTERED_SLICE_TYPES).toHaveLength(
        // Only the source registry includes the three parked Types.
        5
      )
    }
  )

  it.each(["en", "fr"] as const)(
    "keeps pending and failed archive reads distinct from a confirmed empty profile in %s", sliceProfile([]),
    (locale) => {
      mocks.installedTypes = []
      mocks.archivedTypesQuery.current = { status: "pending" }
      const view = renderBuilder({ locale })
      expect(screen.getByRole("status")).toBeVisible()
      expect(
        screen.queryByText(
          locale === "fr"
            ? "Rien à ajouter pour le moment."
            : "Nothing is available to add yet."
        )
      ).toBeNull()
      mocks.archivedTypesQuery.current = {
        status: "error",
        error: new Error("Unavailable"),
      }
      view.rerender(
        <SliceBuilder
          title="About us"
          slices={[]}
          currentLocale={locale}
          onChange={view.onChange}
          pickerOpen={false}
          onPickerOpenChange={view.onPickerOpenChange}
        />
      )
      expect(screen.getByRole("alert")).toBeVisible()
      expect(screen.queryByRole("status")).toBeNull()
      expect(
        screen.queryByText(
          locale === "fr"
            ? "Rien à ajouter pour le moment."
            : "Nothing is available to add yet."
        )
      ).toBeNull()
    }
  )

  it.each(["en", "fr"] as const)(
    "supports the currently registered range and nonempty picker close action in %s", sliceProfile([]),
    (locale) => {
      mocks.metadata = Object.fromEntries(
        REGISTERED_SLICE_TYPES.map((type) => [
          type,
          {
            ...SLICE_METADATA["hero-agency"]!,
            label: type,
            group: "misc",
          },
        ])
      )
      mocks.installedTypes = [...REGISTERED_SLICE_TYPES]
      const view = renderBuilder({
        locale,
        slices: [sampleSlice("hero-agency", "existing")],
        pickerOpen: true,
      })
      expect(
        screen.getAllByRole("button", {
          name: locale === "fr" ? /^Ajouter l’exemple — / : /^Add example — /,
        })
      ).toHaveLength(REGISTERED_SLICE_TYPES.length)
      fireEvent.click(
        screen.getByRole("button", {
          name: locale === "fr" ? "Annuler" : "Cancel",
        })
      )
      expect(view.onPickerOpenChange).toHaveBeenCalledWith(false)
    }
  )

  it("keeps slice types unavailable while archive state is loading", sliceProfile([]), () => {
    mocks.archivedTypesQuery.current = { status: "pending" }

    renderBuilder({ pickerOpen: true })

    expect(screen.getByText("Checking available block types…")).toBeVisible()
    expect(screen.queryByRole("button", { name: /^Add example/ })).toBeNull()
  })

  it("fails closed when archive state cannot be checked", sliceProfile([]), () => {
    mocks.archivedTypesQuery.current = {
      status: "error",
      error: new Error("Unavailable"),
    }

    renderBuilder({ pickerOpen: true })

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Block types couldn't be checked. Adding is unavailable until we can confirm which types are active."
    )
    expect(screen.queryByRole("button", { name: /^Add example/ })).toBeNull()
  })

  it("renders the same closed failure state for the local browser fixture", sliceProfile([]), () => {
    renderBuilder({
      pickerOpen: true,
      archiveStateVerificationFailure: true,
    })

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Block types couldn't be checked. Adding is unavailable until we can confirm which types are active."
    )
    expect(screen.queryByRole("button", { name: /^Add example/ })).toBeNull()
  })

  it("keeps an archived instance editable and removable without offering its type", sliceProfile(["hero-agency"]), async () => {
    mocks.archivedTypesQuery.current = {
      status: "success",
      data: ["hero-agency"],
    }
    const archived = sampleSlice("hero-agency", "slice_a")
    const onChange = vi.fn()

    renderBuilder({ slices: [archived], pickerOpen: true, onChange })

    expect(screen.getAllByText("Hero Agency")).toHaveLength(1)

    fireEvent.click(screen.getByTitle("Disable block"))
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "slice_a", enabled: false }),
    ])

    fireEvent.click(screen.getByTitle("Remove block"))
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([]))
  })

  it.each(["en", "fr"] as const)(
    "offers examples immediately and ends the empty state after the first addition in %s", sliceProfileAny(INSTALLED_SLICE_TYPES),
    (locale) => {
      const onChange = vi.fn()
      const onPickerOpenChange = vi.fn()
      const onSelectedSliceIdChange = vi.fn()
      const view = renderBuilder({
        locale,
        onChange,
        onPickerOpenChange,
        onSelectedSliceIdChange,
      })

      expect(screen.getByRole("heading", { name: "About us" })).toBeVisible()
      expect(
        screen.queryByRole("button", {
          name: locale === "fr" ? "Ajouter un bloc" : "Add block",
        })
      ).toBeNull()
      expect(
        screen.queryByRole("button", {
          name: locale === "fr" ? "Annuler" : "Cancel",
        })
      ).toBeNull()
      fireEvent.click(
        screen.getAllByRole("button", {
          name: locale === "fr" ? /^Ajouter l’exemple/ : /^Add example/,
        })[0]
      )

      expect(onChange).toHaveBeenCalledWith([
        expect.objectContaining({
          id: expect.any(String),
          type: expect.any(String),
        }),
      ])
      expect(onSelectedSliceIdChange).toHaveBeenCalledWith(expect.any(String))
      expect(onPickerOpenChange).toHaveBeenLastCalledWith(false)
      const added = onChange.mock.calls[0][0] as Slice[]
      expect(added[0].primary).toEqual(createSampleSlice(added[0].type).primary)
      view.rerender(
        <SliceBuilder
          title="About us"
          slices={added}
          onChange={onChange}
          currentLocale={locale}
          pickerOpen={false}
          onPickerOpenChange={onPickerOpenChange}
        />
      )
      expect(screen.queryByRole("heading", { name: "About us" })).toBeNull()
      expect(
        screen.queryByText(
          locale === "fr"
            ? "Choisir le contenu à ajouter"
            : "Choose content to add"
        )
      ).toBeNull()
      fireEvent.click(
        screen.getByRole("button", {
          name: locale === "fr" ? "Ajouter un bloc" : "Add block",
        })
      )
      expect(onPickerOpenChange).toHaveBeenLastCalledWith(true)
    }
  )

  it("identifies the slice and locale before removing it from the draft", sliceProfile(["hero-agency"]), async () => {
    const first = sampleSlice("hero-agency", "slice_a")
    const second = sampleSlice("faq-simple", "slice_b")
    const onChange = vi.fn()

    renderBuilder({ slices: [first, second], onChange })

    fireEvent.click(screen.getAllByTitle("Remove block")[0])

    await waitFor(() => {
      expect(mocks.confirm).toHaveBeenCalledWith({
        title: "Remove Hero Agency from EN?",
        description:
          "The removal will be saved to this Page's Working Draft when you save.",
        confirmText: "Remove",
        destructive: true,
      })
      expect(onChange).toHaveBeenCalledWith([second])
    })
  })

  it("reorders slices with the drag handler", sliceProfile(["faq-simple","hero-agency"]), () => {
    const first = sampleSlice("hero-agency", "slice_a")
    const second = sampleSlice("faq-simple", "slice_b")
    const onChange = vi.fn()

    renderBuilder({ slices: [first, second], onChange })

    fireEvent.dragStart(draggableRow("Hero Agency"))
    fireEvent.dragEnter(draggableRow("FAQ Simple"))
    fireEvent.drop(draggableRow("FAQ Simple"))

    expect(onChange).toHaveBeenCalledWith([second, first])
  })

  it("removes the confirmed ID from the latest list while preserving newer siblings", sliceProfile([]), async () => {
    let resolve!: (confirmed: boolean) => void
    mocks.confirm.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        })
    )
    const first = sampleSlice("hero-agency", "slice_a")
    const second = sampleSlice("faq-simple", "slice_b")
    const third = sampleSlice("hero-with-image", "slice_c")
    const onSelectedSliceIdChange = vi.fn()
    const view = renderBuilder({
      slices: [first, second],
      selectedSliceId: "slice_a",
      onSelectedSliceIdChange,
    })
    fireEvent.click(screen.getAllByTitle("Remove block")[0])
    view.rerender(
      <SliceBuilder
        slices={[third, second, first]}
        currentLocale="en"
        onChange={view.onChange}
        pickerOpen={false}
        onPickerOpenChange={view.onPickerOpenChange}
        selectedSliceId="slice_b"
        onSelectedSliceIdChange={view.onSelectedSliceIdChange}
      />
    )
    onSelectedSliceIdChange.mockClear()
    await act(async () => resolve(true))
    expect(view.onChange).toHaveBeenCalledWith([third, second])
    expect(view.onSelectedSliceIdChange).not.toHaveBeenCalled()
  })

  for (const profileRow of ["locale", "field", "type", "removed", "unmounted"]) {
    it.each([profileRow])(
      "refuses a pending removal after its %s context changes", sliceProfile([]),
      async (change) => {
        let resolve!: (confirmed: boolean) => void
        mocks.confirm.mockImplementation(
          () =>
            new Promise<boolean>((done) => {
              resolve = done
            })
        )
        const original = sampleSlice("hero-agency", "slice_a")
        const other = sampleSlice("faq-simple", "slice_b")
        const view = renderBuilder({ slices: [original, other] })
        fireEvent.click(screen.getAllByTitle("Remove block")[0])
        const next =
          change === "field"
            ? { ...original, enabled: false }
            : change === "type"
              ? sampleSlice("hero-with-image", original.id)
              : original
        if (change === "unmounted") view.unmount()
        else
          view.rerender(
            <SliceBuilder
              slices={change === "removed" ? [other] : [next, other]}
              currentLocale={change === "locale" ? "fr" : "en"}
              onChange={view.onChange}
              pickerOpen={false}
              onPickerOpenChange={view.onPickerOpenChange}
            />
          )
        await act(async () => resolve(true))
        expect(view.onChange).not.toHaveBeenCalled()
        expect(mocks.error).toHaveBeenCalledWith(
          change === "unmounted"
            ? "This block couldn't be removed. Review it before trying again."
            : "This block changed. Review it before trying again."
        )
      }
    )
  }

  it.each(["locale", "order", "content"])(
    "refuses stale drag indices after %s changes during the drag", sliceProfile(["hero-agency"]),
    (change) => {
      const first = sampleSlice("hero-agency", "slice_a")
      const second = sampleSlice("faq-simple", "slice_b")
      const third = sampleSlice("hero-with-image", "slice_c")
      const view = renderBuilder({ slices: [first, second, third] })
      fireEvent.dragStart(draggableRow("Hero Agency"))
      const next =
        change === "order"
          ? [second, first, third]
          : change === "content"
            ? [first, { ...second, enabled: false }, third]
            : [first, second, third]
      view.rerender(
        <SliceBuilder
          slices={next}
          currentLocale={change === "locale" ? "fr" : "en"}
          onChange={view.onChange}
          pickerOpen={false}
          onPickerOpenChange={view.onPickerOpenChange}
        />
      )
      fireEvent.drop(view.container.querySelectorAll('[draggable="true"]')[2])
      expect(view.onChange).not.toHaveBeenCalled()
    }
  )

  it("applies an async form result to the same occurrence after sibling reorder", sliceProfile([]), () => {
    const first = sampleSlice("hero-agency", "slice_a")
    const second = sampleSlice("faq-simple", "slice_b")
    const view = renderBuilder({
      slices: [first, second],
      selectedSliceId: first.id,
    })
    const pending = mocks.editorUpdates.get(first.id)!
    view.rerender(
      <SliceBuilder
        slices={[second, first]}
        currentLocale="en"
        onChange={view.onChange}
        pickerOpen={false}
        selectedSliceId={first.id}
        onPickerOpenChange={view.onPickerOpenChange}
      />
    )
    act(() => pending({ ...first, enabled: false }))
    expect(view.onChange).toHaveBeenCalledWith([
      second,
      { ...first, enabled: false },
    ])
  })

  it.each(["locale", "content"])(
    "refuses an async form result after %s changes", sliceProfile([]),
    (change) => {
      const first = sampleSlice("hero-agency", "slice_a")
      const view = renderBuilder({ slices: [first], selectedSliceId: first.id })
      const pending = mocks.editorUpdates.get(first.id)!
      view.rerender(
        <SliceBuilder
          slices={[change === "content" ? { ...first, enabled: false } : first]}
          currentLocale={change === "locale" ? "fr" : "en"}
          onChange={view.onChange}
          pickerOpen={false}
          selectedSliceId={first.id}
          onPickerOpenChange={view.onPickerOpenChange}
        />
      )
      act(() => pending(first))
      expect(view.onChange).not.toHaveBeenCalled()
    }
  )

  it("NEW accepts an edit fired in the commit window, before passive effects flush (fix 2, rank 5)", sliceProfile([]), () => {
    const first = sampleSlice("hero-agency", "slice_a")
    const applied = { ...first, enabled: false }
    const onChange = vi.fn()
    let fire: (() => void) | null = null
    // Runs in the layout phase of the commit, i.e. after the new render's
    // callbacks exist but before SliceBuilder's passive effects have flushed:
    // the window in which TipTap's onUpdate can fire with options assigned
    // during render.
    function CommitWindowProbe() {
      useLayoutEffect(() => {
        const pending = fire
        fire = null
        pending?.()
      })
      return null
    }
    function Harness({ slices }: { slices: Slice[] }) {
      return (
        <>
          <SliceBuilder
            slices={slices}
            currentLocale="en"
            onChange={onChange}
            pickerOpen={false}
            selectedSliceId={first.id}
            onPickerOpenChange={vi.fn()}
          />
          <CommitWindowProbe />
        </>
      )
    }
    const view = render(<Harness slices={[first]} />, { locale: "en" })
    // The parent applied the previous keystroke; the next one fires during
    // the commit that carries it.
    fire = () => mocks.editorUpdates.get(first.id)!({ ...applied, enabled: true })
    view.rerender(<Harness slices={[applied]} />)
    expect(mocks.error).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith([{ ...applied, enabled: true }])
  })

  it("moves the selected slice by keyboard without changing IDs", sliceProfile(["faq-simple","hero-agency"]), () => {
    const first = sampleSlice("hero-agency", "slice_a")
    const second = sampleSlice("faq-simple", "slice_b")
    const onChange = vi.fn()
    const onSelectedSliceIdChange = vi.fn()

    const view = renderBuilder({
      slices: [first, second],
      selectedSliceId: "slice_b",
      onChange,
      onSelectedSliceIdChange,
    })

    expect(
      screen.getByRole("button", { name: "Move Hero Agency 1 up" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Move FAQ Simple 2 down" })
    ).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Move FAQ Simple 2 up" }))

    expect(onChange).toHaveBeenCalledWith([second, first])
    expect(onSelectedSliceIdChange).not.toHaveBeenCalled()

    const reordered = onChange.mock.calls.at(-1)?.[0] as Slice[]
    expect(reordered.map((slice) => slice.id)).toEqual(["slice_b", "slice_a"])
    view.rerender(
      <SliceBuilder
        slices={reordered}
        onChange={onChange}
        currentLocale="en"
        pickerOpen={false}
        onPickerOpenChange={view.onPickerOpenChange}
        selectedSliceId="slice_b"
        onSelectedSliceIdChange={onSelectedSliceIdChange}
      />
    )
    expect(
      screen.getByText("FAQ Simple").closest(".rounded-lg.border.bg-card")
    ).toHaveClass("ring-2")
  })

  it("moves a slice down with the keyboard action", sliceProfile(["hero-agency"]), () => {
    const first = sampleSlice("hero-agency", "slice_a")
    const second = sampleSlice("faq-simple", "slice_b")
    const onChange = vi.fn()

    renderBuilder({ slices: [first, second], onChange })

    fireEvent.click(
      screen.getByRole("button", { name: "Move Hero Agency 1 down" })
    )

    expect(onChange).toHaveBeenCalledWith([second, first])
  })

  it("repairs duplicate legacy IDs on entry and keeps rows independently selectable", sliceProfile(["hero-agency"]), async () => {
    const first = sampleSlice("hero-agency", "duplicate")
    const second = sampleSlice("hero-agency", "duplicate")
    const onChange = vi.fn()
    const onSelectedSliceIdChange = vi.fn()

    renderBuilder({
      slices: [first, second],
      onChange,
      onSelectedSliceIdChange,
    })

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const repaired = onChange.mock.calls[0][0] as Slice[]
    expect(repaired[0].id).toBe("duplicate")
    expect(repaired[1].id).not.toBe("duplicate")
    expect(new Set(repaired.map((slice) => slice.id)).size).toBe(2)

    const rows = screen.getAllByText("Hero Agency").map((label) => {
      const row = label.closest(".rounded-lg.border.bg-card")
      expect(row).toBeInstanceOf(HTMLElement)
      return row as HTMLElement
    })
    fireEvent.click(rows[0])
    const firstSelection = onSelectedSliceIdChange.mock.calls.at(-1)?.[0]
    fireEvent.click(rows[1])
    const secondSelection = onSelectedSliceIdChange.mock.calls.at(-1)?.[0]
    expect(firstSelection).toBe("duplicate")
    expect(secondSelection).not.toBe(firstSelection)
  })
})

it("joins the real selector to one occurrence draft and preserves its peer on explicit confirmation", sliceProfile(["hero-with-image"]), async () => {
  const catalog = await readSlicePresentationCatalog()
  const first = sampleSlice("hero-with-image", "hero-first")
  const second = sampleSlice("hero-with-image", "hero-second")
  const before = JSON.stringify([first, second])
  const onChange = vi.fn()
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
  render(
    <SliceBuilder
      title="Home"
      pageId="page-home"
      contentEpoch={1}
      slices={[first, second]}
      currentLocale="en"
      otherLocales={["fr"]}
      onChange={onChange}
      pickerOpen={false}
      onPickerOpenChange={vi.fn()}
      selectedSliceId={second.id}
      presentationCatalog={catalog}
    />
  )
  fireEvent.keyDown(screen.getByRole("combobox", { name: "Presentation" }), {
    key: "ArrowDown",
  })
  fireEvent.click(await screen.findByRole("option", { name: "Centered" }))
  expect(screen.getByText(/Home · .* #2/)).toBeInTheDocument()
  expect(screen.getByText("English only")).toBeInTheDocument()
  expect(
    screen.getByText(/French and the public snapshot stay/)
  ).toBeInTheDocument()
  expect(onChange).not.toHaveBeenCalled()
  fireEvent.click(
    screen.getByRole("button", {
      name: /Confirm Centered for this English draft occurrence/,
    })
  )
  expect(onChange).toHaveBeenCalledExactlyOnceWith([
    first,
    { ...second, presentationIdV1: "centered" },
  ])
  expect(onChange.mock.calls[0][0][0]).toBe(first)
  expect(JSON.stringify([first, second])).toBe(before)
})


it("F2 resets the editable subtree only on locale change, keeping data IDs", sliceProfile([]), () => {
  const slice = sampleSlice("hero-agency", "same-id")
  const props = { slices: [slice], onChange: vi.fn(), pickerOpen: false, onPickerOpenChange: vi.fn(), selectedSliceId: slice.id }
  const view = render(<SliceBuilder {...props} currentLocale="en" />)
  const before = view.container.querySelector("[tabindex='-1']")
  view.rerender(<SliceBuilder {...props} currentLocale="en" />)
  expect(view.container.querySelector("[tabindex='-1']")).toBe(before)
  view.rerender(<SliceBuilder {...props} currentLocale="fr" />)
  expect(view.container.querySelector("[tabindex='-1']")).not.toBe(before)
  expect(slice.id).toBe("same-id")
})

it("R9/R10 disclosures identify stable regions and section-specific actions", sliceProfile([]), () => {
  const view = renderBuilder({ slices: [sampleSlice("hero-agency", "one"), sampleSlice("hero-agency", "two")] })
  const remove = view.getAllByTitle("Remove block")
  expect(remove[0]).toHaveAccessibleName("Remove Hero Agency 1")
  expect(remove[1]).toHaveAccessibleName("Remove Hero Agency 2")
  expect(view.getByRole("button", { name: "Disable Hero Agency 1" })).toHaveAttribute("title", "Disable block")
  const toggle = view.getAllByRole("button", { name: /Hero Agency.*1/ }).find((button) => button.hasAttribute("aria-controls"))!
  expect(toggle).toBeDefined()
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  const id = toggle.getAttribute("aria-controls")!
  expect(document.getElementById(id)).toBeInTheDocument()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(toggle).toHaveAttribute("aria-controls", id)
})

it.each(["focus", "click"] as const)("reorder %s preserves collapsed rows, selection and scroll", sliceProfile([]), (event) => {
  const onSelect = vi.fn()
  const onChange = vi.fn()
  const view = renderBuilder({ slices: [sampleSlice("hero-agency", "one"), sampleSlice("hero-agency", "two")], onChange, onSelectedSliceIdChange: onSelect })
  const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView)
  scroll.mockClear()
  const down = view.getAllByRole("button", { name: /Move .* down/ })[0]
  if (event === "focus") act(() => down.focus())
  else fireEvent.click(down)
  expect(onSelect).not.toHaveBeenCalled()
  expect(scroll).not.toHaveBeenCalled()
  if (event === "click") expect(onChange.mock.calls[0][0].map((slice: Slice) => slice.id)).toEqual(["two", "one"])
})


it("R9 section toggle controls a stable hidden region", sliceProfile([]), () => {
  const view = renderBuilder({ slices: [sampleSlice("hero-agency", "one")] })
  const toggle = view.getByText("Hero Agency").closest("button")!
  expect(toggle).toHaveAttribute("aria-expanded", "false")
  const id = toggle.getAttribute("aria-controls")!
  expect(id).toBeTruthy()
  expect(document.getElementById(id)).toBeInTheDocument()
  fireEvent.click(toggle)
  expect(toggle).toHaveAttribute("aria-expanded", "true")
  expect(toggle.getAttribute("aria-controls")).toBe(id)
})

it(
  "ED10 identifies the sidebar focus boundary without adding focus behaviour",
  sliceProfile([]),
  () => {
    const view = renderBuilder()
    expect(view.container.firstElementChild).toHaveAttribute(
      "data-preview-sidebar"
    )
  }
)

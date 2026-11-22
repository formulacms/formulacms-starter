import { blockProfileAny, blockProfile } from "@/test-utils/block-profile"
import { useLayoutEffect, useState } from "react"
import { act, fireEvent, screen, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  INSTALLED_BLOCK_TYPES,
  REGISTERED_BLOCK_TYPES,
  blockDefs,
  type Block,
} from "@/convex/lib/blocks"
import { group, list, richText } from "@/convex/lib/blocks/primitives"
import { createSampleBlock } from "@/lib/blocks/sample"
import { BLOCK_METADATA, type BlockMetadata } from "@/lib/blocks/builder"
import { PageSaveRefusedError } from "@/components/admin/page-editor/lib/page-save-refused-error"
import type { FieldGenerate } from "./fields/field-editor"
import { BlockBuilder } from "./block-builder"
import { Transaction } from "@tiptap/pm/state"
import { readBlockPresentationCatalog } from "@/convex/lib/blocks/presentations"

const mocks = vi.hoisted(() => ({
  confirm: vi.fn(),
  prompt: vi.fn(),
  error: vi.fn(),
  installedTypes: null as string[] | null,
  metadata: null as Record<string, BlockMetadata> | null,
  editorUpdates: new Map<string, (next: Block) => void>(),
  archivedTypesQuery: {
    current: { status: "success", data: [] } as
      | { status: "pending" }
      | { status: "error"; error: Error }
      | { status: "success"; data: string[] },
  },
}))

vi.mock("@/convex/lib/blocks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/convex/lib/blocks")>()
  return {
    ...actual,
    get INSTALLED_BLOCK_TYPES() {
      return mocks.installedTypes ?? actual.INSTALLED_BLOCK_TYPES
    },
  }
})

vi.mock("@/lib/blocks/builder", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/blocks/builder")>()
  return {
    ...actual,
    get BLOCK_METADATA() {
      return mocks.metadata ?? actual.BLOCK_METADATA
    },
    readBlockMetadata(type: string) {
      const metadata: Readonly<Partial<Record<string, BlockMetadata>>> =
        mocks.metadata ?? actual.BLOCK_METADATA
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

vi.mock("./block-editor", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./block-editor")>()
  return {
    ...actual,
    BlockEditor: (props: Parameters<typeof actual.BlockEditor>[0]) => {
      mocks.editorUpdates.set(props.block.id, props.onChange)
      return <actual.BlockEditor {...props} />
    },
  }
})

function sampleBlock(type: Block["type"], id: string): Block {
  return {
    ...createSampleBlock(type),
    id,
  }
}

function renderBuilder({
  title = "About us",
  locale = "en",
  blocks = [],
  pickerOpen = false,
  onChange = vi.fn(),
  onPickerOpenChange = vi.fn(),
  selectedBlockId,
  focusedFieldTarget,
  focusedFirstControlTarget,
  onSelectedBlockIdChange = vi.fn(),
  archiveStateVerificationFailure = false,
  generate,
}: {
  title?: string
  locale?: "en" | "fr"
  blocks?: Block[]
  pickerOpen?: boolean
  onChange?: (next: Block[]) => void
  onPickerOpenChange?: (open: boolean) => void
  selectedBlockId?: string | null
  focusedFieldTarget?: {
    blockId: string
    fieldPath: string
    nonce: number
    textOffset?: number
    clickCount?: 2 | 3
  } | null
  focusedFirstControlTarget?: { blockId: string; nonce: number } | null
  onSelectedBlockIdChange?: (blockId: string | null) => void
  archiveStateVerificationFailure?: boolean
  generate?: FieldGenerate
} = {}) {
  return {
    onChange,
    onPickerOpenChange,
    onSelectedBlockIdChange,
    ...render(
      <BlockBuilder
        title={title}
        blocks={blocks}
        onChange={onChange}
        currentLocale={locale}
        pickerOpen={pickerOpen}
        onPickerOpenChange={onPickerOpenChange}
        selectedBlockId={selectedBlockId}
        focusedFieldTarget={focusedFieldTarget}
        focusedFirstControlTarget={focusedFirstControlTarget}
        onSelectedBlockIdChange={onSelectedBlockIdChange}
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
function clickBlockControl(target: HTMLElement, pointer: "mouse" | "touch") {
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
  const blocks = [
    sampleBlock("hero-agency", "one"),
    sampleBlock("hero-agency", "two"),
  ]
  const onSelect = vi.fn()
  const onChange = vi.fn()
  function ControlledBuilder() {
    const [selected, setSelected] = useState<string | null>(null)
    return (
      <BlockBuilder
        blocks={blocks}
        currentLocale="en"
        onChange={onChange}
        pickerOpen={false}
        onPickerOpenChange={vi.fn()}
        selectedBlockId={selected}
        onSelectedBlockIdChange={(id) => {
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

describe("BlockBuilder block list editing", () => {
  it.each(["mouse", "touch"] as const)(
    "R4 toggles a controlled disclosure once per %s gesture",
    blockProfile([]),
    (pointer) => {
      const {
        toggles: [first, second],
      } = renderControlledDisclosures()
      const click = (target: HTMLElement) => clickBlockControl(target, pointer)
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
    blockProfile([]),
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
    blockProfile([]),
    () => {
      const { toggles, onSelect, onChange } = renderControlledDisclosures()
      clickBlockControl(
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
    "selects from a row control on %s without scrolling the row", blockProfile([]),
    (event) => {
      const block = sampleBlock("hero-agency", "row-selected")
      const onSelectedBlockIdChange = vi.fn()
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
          <BlockBuilder
            blocks={[block]}
            currentLocale="en"
            onChange={vi.fn()}
            pickerOpen={false}
            onPickerOpenChange={vi.fn()}
            selectedBlockId={selected}
            onSelectedBlockIdChange={(id) => {
              onSelectedBlockIdChange(id)
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
        expect(onSelectedBlockIdChange).toHaveBeenCalledWith(block.id)
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

  it("scrolls a new selection supplied by the parent after a row selection", blockProfile([]), () => {
    const first = sampleBlock("hero-agency", "row-selected")
    const second = sampleBlock("faq-simple", "parent-selected")
    const view = renderBuilder({ blocks: [first, second] })
    const scrollIntoView = vi.mocked(HTMLElement.prototype.scrollIntoView)
    fireEvent.focus(screen.getAllByTitle("Remove block")[0])
    function select(id: string | null) {
      view.rerender(
        <BlockBuilder
          blocks={[first, second]}
          currentLocale="en"
          onChange={view.onChange}
          pickerOpen={false}
          onPickerOpenChange={view.onPickerOpenChange}
          selectedBlockId={id}
          onSelectedBlockIdChange={view.onSelectedBlockIdChange}
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
    "reports a removal refusal before confirmation in %s", blockProfile([]),
    (locale) => {
      const first = sampleBlock("hero-agency", "duplicate")
      const second = sampleBlock("faq-simple", "duplicate")
      const onChange = vi.fn()
      renderBuilder({ blocks: [first, second], locale, onChange })
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
    const block = sampleBlock("hero-with-image", "focus-target")
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
        blocks: [block],
        selectedBlockId: block.id,
        focusedFirstControlTarget: { blockId: block.id, nonce: 1 },
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
          <BlockBuilder
            blocks={[block]}
            currentLocale="en"
            onChange={view.onChange}
            pickerOpen={false}
            onPickerOpenChange={view.onPickerOpenChange}
            selectedBlockId={block.id}
            focusedFirstControlTarget={{ blockId: block.id, nonce: 2 }}
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
      // Focused in place: no centring scroll; one, if needed, waits for the
      // click sequence.
      expect(scrollIntoView).not.toHaveBeenCalledWith({ block: "center" })
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

  it("focuses the first enabled control after a native disabled combobox", blockProfile([]), async () => {
    await focusFirstEnabledControl()
  })

  it("skips an aria-disabled custom combobox before the first enabled field", blockProfile([]), async () => {
    await focusFirstEnabledControl(true)
  })

  it("focuses the exact primary-list rich-text control selected from preview", blockProfile([]), async () => {
    const originalDef = blockDefs["hero-with-image"]
    const syntheticPrimary = group({
      ...originalDef.primary.config.fields,
      features: list(group({ title: richText({ profile: "inline" }) })),
    })
    const block = sampleBlock("hero-with-image", "primary-list-focus")
    Reflect.set(block.primary, "features", [{ title: "{}" }])
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
    Reflect.set(blockDefs, "hero-with-image", {
      ...originalDef,
      primary: syntheticPrimary,
    })
    let view: ReturnType<typeof renderBuilder> | undefined
    try {
      view = renderBuilder({
        blocks: [block],
        selectedBlockId: block.id,
        focusedFieldTarget: {
          blockId: block.id,
          fieldPath: "primary.features.0.title",
          nonce: 1,
        },
      })
      const field = view.container.querySelector<HTMLElement>(
        '[data-block-field-path="primary.features.0.title"]'
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
      Reflect.set(blockDefs, "hero-with-image", originalDef)
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

  it("scrolls a selected block without a preview click marker, never forcing smooth motion", blockProfile([]), async () => {
    const block = sampleBlock("hero-with-image", "scroll-target")
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
        blocks: [block],
        selectedBlockId: block.id,
        focusedFieldTarget: {
          blockId: block.id,
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
      // A preview field is not centred at once; it comes into view after
      // the clicks, and only when it cannot be seen (see below).
      expect(scrollIntoView).not.toHaveBeenCalledWith({ block: "center" })
      expect(
        scrollIntoView.mock.calls.every(
          ([options]) =>
            !Object.prototype.hasOwnProperty.call(options, "behavior")
        )
      ).toBe(true)
      expect(
        view.container.querySelector(
          '[data-block-field-path="primary.eyebrow"]'
        )
      ).not.toBeNull()
    } finally {
      if (original)
        Object.defineProperty(HTMLElement.prototype, "scrollIntoView", original)
      else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
    }
  })
  it("puts a plain-text field caret on the letter clicked in the preview", async () => {
    const block = sampleBlock("hero-with-image", "caret-target")
    renderBuilder({
      blocks: [block],
      selectedBlockId: block.id,
      focusedFieldTarget: {
        blockId: block.id,
        fieldPath: "primary.eyebrow",
        nonce: 1,
        // One implicit block, then three letters.
        textOffset: 4,
      },
    })
    await act(async () => {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => resolve())
      )
    })
    const input = document.activeElement as HTMLInputElement
    expect(input.closest('[data-block-field-path="primary.eyebrow"]')).not.toBeNull()
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 3])
  })
  it.each([
    [2, "word"],
    [3, "field"],
  ] as const)(
    "selects the %s-click %s in a plain-text field, through the shared click rule",
    async (clickCount, expected) => {
      const block = sampleBlock("hero-with-image", "caret-target")
      renderBuilder({
        blocks: [block],
        selectedBlockId: block.id,
        focusedFieldTarget: {
          blockId: block.id,
          fieldPath: "primary.eyebrow",
          nonce: 1,
          textOffset: 4,
          clickCount,
        },
      })
      await act(async () => {
        await new Promise<void>((resolve) =>
          requestAnimationFrame(() => resolve())
        )
      })
      const input = document.activeElement as HTMLInputElement
      const value = input.value
      const selected = value.slice(input.selectionStart!, input.selectionEnd!)
      // Letter 3 of "We're hiring!": the apostrophe stays inside the word.
      expect(value).toBe("We're hiring!")
      expect(selected).toBe(expected === "field" ? value : "We're")
    }
  )
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
    "new: appends a pending starter through current callbacks with decorative icons in %s", blockProfile(["hero-agency"]),
    async (locale) => {
      let resolve!: (block: Block) => void
      const generate: FieldGenerate = {
        run: vi.fn(),
        runRefine: vi.fn(),
        runBlock: vi.fn(() => new Promise<Block>((done) => (resolve = done))),
      }
      const first = sampleBlock("hero-agency", "block_a")
      const other = sampleBlock("faq-simple", "block_b")
      const view = renderBuilder({
        locale,
        blocks: [first, other],
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
      expect(generate.runBlock).toHaveBeenCalledTimes(1)
      const type = vi.mocked(generate.runBlock).mock.calls[0][0]
      const generated = sampleBlock(type, "generated")
      const edited = { ...first, enabled: false }
      const newSibling = sampleBlock("hero-with-image", "block_c")
      const onChange = vi.fn()
      const onPickerOpenChange = vi.fn()
      const onSelectedBlockIdChange = vi.fn()
      view.rerender(
        <BlockBuilder
          blocks={[newSibling, edited]}
          currentLocale={locale}
          generate={generate}
          onChange={onChange}
          pickerOpen
          onPickerOpenChange={onPickerOpenChange}
          onSelectedBlockIdChange={onSelectedBlockIdChange}
        />
      )
      await act(async () => resolve(generated))
      expect(onChange).toHaveBeenCalledExactlyOnceWith([
        newSibling,
        edited,
        generated,
      ])
      expect(view.onChange).not.toHaveBeenCalled()
      expect(onSelectedBlockIdChange).toHaveBeenCalledExactlyOnceWith(
        generated.id
      )
      expect(view.onSelectedBlockIdChange).not.toHaveBeenCalled()
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
    "new: starter generation: %s", blockProfileAny(INSTALLED_BLOCK_TYPES),
    async (_name, failure, toasts) => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      const generate: FieldGenerate = {
        run: vi.fn(),
        runRefine: vi.fn(),
        runBlock: vi.fn(async () => {
          throw failure
        }),
      }
      renderBuilder({
        blocks: [sampleBlock("hero-agency", "block_a")],
        pickerOpen: true,
        generate,
      })
      fireEvent.click(screen.getAllByRole("button", { name: /^Starter/ })[0])
      await waitFor(() => expect(generate.runBlock).toHaveBeenCalledTimes(1))
      await act(async () => {})
      expect(mocks.error).toHaveBeenCalledTimes(toasts)
    }
  )

  it.each([
    ["a refused Save stays quiet", new PageSaveRefusedError(), 0],
    ["another failure still reports", new Error("route down"), 1],
  ])(
    "new: whole-block Write: %s", blockProfileAny(INSTALLED_BLOCK_TYPES),
    async (_name, failure, toasts) => {
      vi.spyOn(console, "error").mockImplementation(() => {})
      mocks.prompt.mockResolvedValue("a brief")
      const generate: FieldGenerate = {
        run: vi.fn(),
        runRefine: vi.fn(),
        runBlock: vi.fn(async () => {
          throw failure
        }),
      }
      const block = sampleBlock("hero-agency", "block_a")
      renderBuilder({ blocks: [block], selectedBlockId: block.id, generate })
      fireEvent.click(await screen.findByTitle("Write this block with AI"))
      await waitFor(() => expect(generate.runBlock).toHaveBeenCalledTimes(1))
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
    "new: refuses a pending starter after its %s context changes", blockProfileAny(INSTALLED_BLOCK_TYPES),
    async (change) => {
      let resolve!: (block: Block) => void
      const generate: FieldGenerate = {
        run: vi.fn(),
        runRefine: vi.fn(),
        runBlock: vi.fn(() => new Promise<Block>((done) => (resolve = done))),
      }
      const first = sampleBlock("hero-agency", "block_a")
      const view = renderBuilder({
        blocks: [first],
        pickerOpen: true,
        generate,
      })
      fireEvent.click(screen.getAllByRole("button", { name: /^Starter/ })[0])
      expect(generate.runBlock).toHaveBeenCalledTimes(1)
      const type = vi.mocked(generate.runBlock).mock.calls[0][0]
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
          <BlockBuilder
            blocks={[first]}
            currentLocale={change === "locale" ? "fr" : "en"}
            generate={change === "generation-off" ? undefined : generate}
            onChange={view.onChange}
            pickerOpen
            onPickerOpenChange={view.onPickerOpenChange}
            onSelectedBlockIdChange={view.onSelectedBlockIdChange}
          />
        )
      await act(async () => resolve(sampleBlock(type, "generated")))
      expect(view.onChange).not.toHaveBeenCalled()
      expect(view.onSelectedBlockIdChange).not.toHaveBeenCalled()
      expect(view.onPickerOpenChange).not.toHaveBeenCalled()
      if (change === "unmounted") expect(mocks.error).not.toHaveBeenCalled()
      else
        expect(mocks.error).toHaveBeenCalledExactlyOnceWith(
          "This block changed. Review it before trying again."
        )
    }
  )

  it.each(["en", "fr"] as const)(
    "shows the current title and localized installed choices in %s", blockProfileAny(INSTALLED_BLOCK_TYPES),
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
      expect(actions).toHaveLength(INSTALLED_BLOCK_TYPES.length)
      const decorativeIcons = container.querySelectorAll("svg")
      expect(decorativeIcons).toHaveLength(INSTALLED_BLOCK_TYPES.length * 2)
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
        <BlockBuilder
          title={`${title} 2`}
          blocks={[]}
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
    "shows only the title and approved sentence when all installed types are archived in %s", blockProfile([]),
    (locale) => {
      mocks.archivedTypesQuery.current = {
        status: "success",
        data: [...INSTALLED_BLOCK_TYPES],
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
    "supports an empty installed profile in %s without changing registry data", blockProfile([]),
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
      expect(REGISTERED_BLOCK_TYPES).toHaveLength(
        // Only the source registry includes the three parked Types.
        5
      )
    }
  )

  it.each(["en", "fr"] as const)(
    "keeps pending and failed archive reads distinct from a confirmed empty profile in %s", blockProfile([]),
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
        <BlockBuilder
          title="About us"
          blocks={[]}
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
    "supports the currently registered range and nonempty picker close action in %s", blockProfile([]),
    (locale) => {
      mocks.metadata = Object.fromEntries(
        REGISTERED_BLOCK_TYPES.map((type) => [
          type,
          {
            ...BLOCK_METADATA["hero-agency"]!,
            label: type,
            group: "misc",
          },
        ])
      )
      mocks.installedTypes = [...REGISTERED_BLOCK_TYPES]
      const view = renderBuilder({
        locale,
        blocks: [sampleBlock("hero-agency", "existing")],
        pickerOpen: true,
      })
      expect(
        screen.getAllByRole("button", {
          name: locale === "fr" ? /^Ajouter l’exemple — / : /^Add example — /,
        })
      ).toHaveLength(REGISTERED_BLOCK_TYPES.length)
      fireEvent.click(
        screen.getByRole("button", {
          name: locale === "fr" ? "Annuler" : "Cancel",
        })
      )
      expect(view.onPickerOpenChange).toHaveBeenCalledWith(false)
    }
  )

  it("keeps block types unavailable while archive state is loading", blockProfile([]), () => {
    mocks.archivedTypesQuery.current = { status: "pending" }

    renderBuilder({ pickerOpen: true })

    expect(screen.getByText("Checking available block types…")).toBeVisible()
    expect(screen.queryByRole("button", { name: /^Add example/ })).toBeNull()
  })

  it("fails closed when archive state cannot be checked", blockProfile([]), () => {
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

  it("renders the same closed failure state for the local browser fixture", blockProfile([]), () => {
    renderBuilder({
      pickerOpen: true,
      archiveStateVerificationFailure: true,
    })

    expect(screen.getByRole("alert")).toHaveTextContent(
      "Block types couldn't be checked. Adding is unavailable until we can confirm which types are active."
    )
    expect(screen.queryByRole("button", { name: /^Add example/ })).toBeNull()
  })

  it("keeps an archived instance editable and removable without offering its type", blockProfile(["hero-agency"]), async () => {
    mocks.archivedTypesQuery.current = {
      status: "success",
      data: ["hero-agency"],
    }
    const archived = sampleBlock("hero-agency", "block_a")
    const onChange = vi.fn()

    renderBuilder({ blocks: [archived], pickerOpen: true, onChange })

    expect(screen.getAllByText("Hero Agency")).toHaveLength(1)

    fireEvent.click(screen.getByTitle("Disable block"))
    expect(onChange).toHaveBeenCalledWith([
      expect.objectContaining({ id: "block_a", enabled: false }),
    ])

    fireEvent.click(screen.getByTitle("Remove block"))
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith([]))
  })

  it.each(["en", "fr"] as const)(
    "offers examples immediately and ends the empty state after the first addition in %s", blockProfileAny(INSTALLED_BLOCK_TYPES),
    (locale) => {
      const onChange = vi.fn()
      const onPickerOpenChange = vi.fn()
      const onSelectedBlockIdChange = vi.fn()
      const view = renderBuilder({
        locale,
        onChange,
        onPickerOpenChange,
        onSelectedBlockIdChange,
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
      expect(onSelectedBlockIdChange).toHaveBeenCalledWith(expect.any(String))
      expect(onPickerOpenChange).toHaveBeenLastCalledWith(false)
      const added = onChange.mock.calls[0][0] as Block[]
      expect(added[0].primary).toEqual(createSampleBlock(added[0].type).primary)
      view.rerender(
        <BlockBuilder
          title="About us"
          blocks={added}
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

  it("identifies the block and locale before removing it from the draft", blockProfile(["hero-agency"]), async () => {
    const first = sampleBlock("hero-agency", "block_a")
    const second = sampleBlock("faq-simple", "block_b")
    const onChange = vi.fn()

    renderBuilder({ blocks: [first, second], onChange })

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

  it("reorders blocks with the drag handler", blockProfile(["faq-simple","hero-agency"]), () => {
    const first = sampleBlock("hero-agency", "block_a")
    const second = sampleBlock("faq-simple", "block_b")
    const onChange = vi.fn()

    renderBuilder({ blocks: [first, second], onChange })

    fireEvent.dragStart(draggableRow("Hero Agency"))
    fireEvent.dragEnter(draggableRow("FAQ Simple"))
    fireEvent.drop(draggableRow("FAQ Simple"))

    expect(onChange).toHaveBeenCalledWith([second, first])
  })

  it("removes the confirmed ID from the latest list while preserving newer siblings", blockProfile([]), async () => {
    let resolve!: (confirmed: boolean) => void
    mocks.confirm.mockImplementation(
      () =>
        new Promise<boolean>((done) => {
          resolve = done
        })
    )
    const first = sampleBlock("hero-agency", "block_a")
    const second = sampleBlock("faq-simple", "block_b")
    const third = sampleBlock("hero-with-image", "block_c")
    const onSelectedBlockIdChange = vi.fn()
    const view = renderBuilder({
      blocks: [first, second],
      selectedBlockId: "block_a",
      onSelectedBlockIdChange,
    })
    fireEvent.click(screen.getAllByTitle("Remove block")[0])
    view.rerender(
      <BlockBuilder
        blocks={[third, second, first]}
        currentLocale="en"
        onChange={view.onChange}
        pickerOpen={false}
        onPickerOpenChange={view.onPickerOpenChange}
        selectedBlockId="block_b"
        onSelectedBlockIdChange={view.onSelectedBlockIdChange}
      />
    )
    onSelectedBlockIdChange.mockClear()
    await act(async () => resolve(true))
    expect(view.onChange).toHaveBeenCalledWith([third, second])
    expect(view.onSelectedBlockIdChange).not.toHaveBeenCalled()
  })

  for (const profileRow of ["locale", "field", "type", "removed", "unmounted"]) {
    it.each([profileRow])(
      "refuses a pending removal after its %s context changes", blockProfile([]),
      async (change) => {
        let resolve!: (confirmed: boolean) => void
        mocks.confirm.mockImplementation(
          () =>
            new Promise<boolean>((done) => {
              resolve = done
            })
        )
        const original = sampleBlock("hero-agency", "block_a")
        const other = sampleBlock("faq-simple", "block_b")
        const view = renderBuilder({ blocks: [original, other] })
        fireEvent.click(screen.getAllByTitle("Remove block")[0])
        const next =
          change === "field"
            ? { ...original, enabled: false }
            : change === "type"
              ? sampleBlock("hero-with-image", original.id)
              : original
        if (change === "unmounted") view.unmount()
        else
          view.rerender(
            <BlockBuilder
              blocks={change === "removed" ? [other] : [next, other]}
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
    "refuses stale drag indices after %s changes during the drag", blockProfile(["hero-agency"]),
    (change) => {
      const first = sampleBlock("hero-agency", "block_a")
      const second = sampleBlock("faq-simple", "block_b")
      const third = sampleBlock("hero-with-image", "block_c")
      const view = renderBuilder({ blocks: [first, second, third] })
      fireEvent.dragStart(draggableRow("Hero Agency"))
      const next =
        change === "order"
          ? [second, first, third]
          : change === "content"
            ? [first, { ...second, enabled: false }, third]
            : [first, second, third]
      view.rerender(
        <BlockBuilder
          blocks={next}
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

  it("applies an async form result to the same occurrence after sibling reorder", blockProfile([]), () => {
    const first = sampleBlock("hero-agency", "block_a")
    const second = sampleBlock("faq-simple", "block_b")
    const view = renderBuilder({
      blocks: [first, second],
      selectedBlockId: first.id,
    })
    const pending = mocks.editorUpdates.get(first.id)!
    view.rerender(
      <BlockBuilder
        blocks={[second, first]}
        currentLocale="en"
        onChange={view.onChange}
        pickerOpen={false}
        selectedBlockId={first.id}
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
    "refuses an async form result after %s changes", blockProfile([]),
    (change) => {
      const first = sampleBlock("hero-agency", "block_a")
      const view = renderBuilder({ blocks: [first], selectedBlockId: first.id })
      const pending = mocks.editorUpdates.get(first.id)!
      view.rerender(
        <BlockBuilder
          blocks={[change === "content" ? { ...first, enabled: false } : first]}
          currentLocale={change === "locale" ? "fr" : "en"}
          onChange={view.onChange}
          pickerOpen={false}
          selectedBlockId={first.id}
          onPickerOpenChange={view.onPickerOpenChange}
        />
      )
      act(() => pending(first))
      expect(view.onChange).not.toHaveBeenCalled()
    }
  )

  it("NEW accepts an edit fired in the commit window, before passive effects flush (fix 2, rank 5)", blockProfile([]), () => {
    const first = sampleBlock("hero-agency", "block_a")
    const applied = { ...first, enabled: false }
    const onChange = vi.fn()
    let fire: (() => void) | null = null
    // Runs in the layout phase of the commit, i.e. after the new render's
    // callbacks exist but before BlockBuilder's passive effects have flushed:
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
    function Harness({ blocks }: { blocks: Block[] }) {
      return (
        <>
          <BlockBuilder
            blocks={blocks}
            currentLocale="en"
            onChange={onChange}
            pickerOpen={false}
            selectedBlockId={first.id}
            onPickerOpenChange={vi.fn()}
          />
          <CommitWindowProbe />
        </>
      )
    }
    const view = render(<Harness blocks={[first]} />, { locale: "en" })
    // The parent applied the previous keystroke; the next one fires during
    // the commit that carries it.
    fire = () => mocks.editorUpdates.get(first.id)!({ ...applied, enabled: true })
    view.rerender(<Harness blocks={[applied]} />)
    expect(mocks.error).not.toHaveBeenCalled()
    expect(onChange).toHaveBeenCalledWith([{ ...applied, enabled: true }])
  })

  it("moves the selected block by keyboard without changing IDs", blockProfile(["faq-simple","hero-agency"]), () => {
    const first = sampleBlock("hero-agency", "block_a")
    const second = sampleBlock("faq-simple", "block_b")
    const onChange = vi.fn()
    const onSelectedBlockIdChange = vi.fn()

    const view = renderBuilder({
      blocks: [first, second],
      selectedBlockId: "block_b",
      onChange,
      onSelectedBlockIdChange,
    })

    expect(
      screen.getByRole("button", { name: "Move Hero Agency 1 up" })
    ).toBeDisabled()
    expect(
      screen.getByRole("button", { name: "Move FAQ Simple 2 down" })
    ).toBeDisabled()

    fireEvent.click(screen.getByRole("button", { name: "Move FAQ Simple 2 up" }))

    expect(onChange).toHaveBeenCalledWith([second, first])
    expect(onSelectedBlockIdChange).not.toHaveBeenCalled()

    const reordered = onChange.mock.calls.at(-1)?.[0] as Block[]
    expect(reordered.map((block) => block.id)).toEqual(["block_b", "block_a"])
    view.rerender(
      <BlockBuilder
        blocks={reordered}
        onChange={onChange}
        currentLocale="en"
        pickerOpen={false}
        onPickerOpenChange={view.onPickerOpenChange}
        selectedBlockId="block_b"
        onSelectedBlockIdChange={onSelectedBlockIdChange}
      />
    )
    expect(
      screen.getByText("FAQ Simple").closest(".rounded-lg.border.bg-card")
    ).toHaveClass("ring-2")
  })

  it("moves a block down with the keyboard action", blockProfile(["hero-agency"]), () => {
    const first = sampleBlock("hero-agency", "block_a")
    const second = sampleBlock("faq-simple", "block_b")
    const onChange = vi.fn()

    renderBuilder({ blocks: [first, second], onChange })

    fireEvent.click(
      screen.getByRole("button", { name: "Move Hero Agency 1 down" })
    )

    expect(onChange).toHaveBeenCalledWith([second, first])
  })

  it("repairs duplicate legacy IDs on entry and keeps rows independently selectable", blockProfile(["hero-agency"]), async () => {
    const first = sampleBlock("hero-agency", "duplicate")
    const second = sampleBlock("hero-agency", "duplicate")
    const onChange = vi.fn()
    const onSelectedBlockIdChange = vi.fn()

    renderBuilder({
      blocks: [first, second],
      onChange,
      onSelectedBlockIdChange,
    })

    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1))
    const repaired = onChange.mock.calls[0][0] as Block[]
    expect(repaired[0].id).toBe("duplicate")
    expect(repaired[1].id).not.toBe("duplicate")
    expect(new Set(repaired.map((block) => block.id)).size).toBe(2)

    const rows = screen.getAllByText("Hero Agency").map((label) => {
      const row = label.closest(".rounded-lg.border.bg-card")
      expect(row).toBeInstanceOf(HTMLElement)
      return row as HTMLElement
    })
    fireEvent.click(rows[0])
    const firstSelection = onSelectedBlockIdChange.mock.calls.at(-1)?.[0]
    fireEvent.click(rows[1])
    const secondSelection = onSelectedBlockIdChange.mock.calls.at(-1)?.[0]
    expect(firstSelection).toBe("duplicate")
    expect(secondSelection).not.toBe(firstSelection)
  })
})

it("joins the real selector to one occurrence draft and preserves its peer on explicit confirmation", blockProfile(["hero-with-image"]), async () => {
  const catalog = await readBlockPresentationCatalog()
  const first = sampleBlock("hero-with-image", "hero-first")
  const second = sampleBlock("hero-with-image", "hero-second")
  const before = JSON.stringify([first, second])
  const onChange = vi.fn()
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
    configurable: true,
    value: vi.fn(),
  })
  render(
    <BlockBuilder
      title="Home"
      pageId="page-home"
      contentEpoch={1}
      blocks={[first, second]}
      currentLocale="en"
      otherLocales={["fr"]}
      onChange={onChange}
      pickerOpen={false}
      onPickerOpenChange={vi.fn()}
      selectedBlockId={second.id}
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


it("F2 resets the editable subtree only on locale change, keeping data IDs", blockProfile([]), () => {
  const block = sampleBlock("hero-agency", "same-id")
  const props = { blocks: [block], onChange: vi.fn(), pickerOpen: false, onPickerOpenChange: vi.fn(), selectedBlockId: block.id }
  const view = render(<BlockBuilder {...props} currentLocale="en" />)
  const before = view.container.querySelector("[tabindex='-1']")
  view.rerender(<BlockBuilder {...props} currentLocale="en" />)
  expect(view.container.querySelector("[tabindex='-1']")).toBe(before)
  view.rerender(<BlockBuilder {...props} currentLocale="fr" />)
  expect(view.container.querySelector("[tabindex='-1']")).not.toBe(before)
  expect(block.id).toBe("same-id")
})

it("R9/R10 disclosures identify stable regions and section-specific actions", blockProfile([]), () => {
  const view = renderBuilder({ blocks: [sampleBlock("hero-agency", "one"), sampleBlock("hero-agency", "two")] })
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

it.each(["focus", "click"] as const)("reorder %s preserves collapsed rows, selection and scroll", blockProfile([]), (event) => {
  const onSelect = vi.fn()
  const onChange = vi.fn()
  const view = renderBuilder({ blocks: [sampleBlock("hero-agency", "one"), sampleBlock("hero-agency", "two")], onChange, onSelectedBlockIdChange: onSelect })
  const scroll = vi.mocked(HTMLElement.prototype.scrollIntoView)
  scroll.mockClear()
  const down = view.getAllByRole("button", { name: /Move .* down/ })[0]
  if (event === "focus") act(() => down.focus())
  else fireEvent.click(down)
  expect(onSelect).not.toHaveBeenCalled()
  expect(scroll).not.toHaveBeenCalled()
  if (event === "click") expect(onChange.mock.calls[0][0].map((block: Block) => block.id)).toEqual(["two", "one"])
})


it("R9 section toggle controls a stable hidden region", blockProfile([]), () => {
  const view = renderBuilder({ blocks: [sampleBlock("hero-agency", "one")] })
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
  blockProfile([]),
  () => {
    const view = renderBuilder()
    expect(view.container.firstElementChild).toHaveAttribute(
      "data-preview-sidebar"
    )
  }
)

// The form and the preview share one scroller (the split view), so any
// scroll the form makes while a preview click sequence runs moves the
// preview under the pointer: the second click of a double click lands on
// another line. A click on a preview field selects its block and focuses its
// form control without a scroll; a form field comes into view, once and
// only when it cannot be seen, after the last click.
describe("BlockBuilder: a click sequence in the preview never scrolls", () => {
  type FieldTarget = {
    blockId: string
    fieldPath: string
    nonce: number
    textOffset?: number
    clickCount?: 2 | 3
  }
  const block = sampleBlock("hero-with-image", "preview-click-scroll")
  const other = sampleBlock("faq-simple", "preview-click-other")
  const blocks = [block, other]

  function spyScrolls() {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      writable: true,
      value: scrollIntoView,
    })
    const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {})
    const proseMirrorScroll = vi.spyOn(Transaction.prototype, "scrollIntoView")
    const focus = vi.spyOn(HTMLElement.prototype, "focus")
    return {
      scrollIntoView,
      /** Every scroll request made so far, of any kind. */
      scrolls: () => [
        ...scrollIntoView.mock.calls.map((call) => ["scrollIntoView", call]),
        ...scrollTo.mock.calls.map((call) => ["window.scrollTo", call]),
        ...proseMirrorScroll.mock.calls.map(() => ["ProseMirror", []]),
        ...focus.mock.calls
          .filter(([options]) => options?.preventScroll !== true)
          .map((call) => ["focus without preventScroll", call]),
      ],
      restore() {
        scrollTo.mockRestore()
        proseMirrorScroll.mockRestore()
        focus.mockRestore()
      },
    }
  }

  function builder(
    selectedBlockId: string | null,
    previewClick: { blockId: string; nonce: number } | null,
    focusedFieldTarget: FieldTarget | null = null
  ) {
    return (
      <BlockBuilder
        blocks={blocks}
        currentLocale="en"
        onChange={vi.fn()}
        pickerOpen={false}
        onPickerOpenChange={vi.fn()}
        selectedBlockId={selectedBlockId}
        previewClickSelection={previewClick}
        focusedFieldTarget={focusedFieldTarget}
        onSelectedBlockIdChange={vi.fn()}
      />
    )
  }

  const nextFrame = () =>
    act(
      () =>
        new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    )
  const wait = (ms: number) =>
    act(() => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const row = (view: ReturnType<typeof render>) =>
    view.container.querySelectorAll<HTMLElement>("[tabindex='-1']")[0]!

  it(
    "(a) selects the block of a field opened in place without scrolling the form",
    blockProfile([]),
    async () => {
      const spy = spyScrolls()
      try {
        const view = render(builder(null, null))
        view.rerender(builder(block.id, { blockId: block.id, nonce: 1 }))
        await nextFrame()
        await wait(650)
        expect(spy.scrolls()).toEqual([])
        // The row still shows as selected.
        expect(row(view).className).toContain("border-primary/60")
      } finally {
        spy.restore()
      }
    }
  )

  it.each([
    ["(b) a form-only rich-text field", "primary.description", 6],
    ["(c) a plain-text field", "primary.eyebrow", 4],
    ["(d) a title while editing in the preview is blocked", "primary.title", 3],
  ] as const)(
    "%s: focuses at once with no scroll, then one nearest scroll after the last click",
    blockProfile([]),
    async (_name, fieldPath, textOffset) => {
      const spy = spyScrolls()
      try {
        const target = (nonce: number, clickCount?: 2 | 3): FieldTarget => ({
          blockId: block.id,
          fieldPath,
          nonce,
          textOffset,
          ...(clickCount ? { clickCount } : {}),
        })
        const view = render(builder(null, null))
        // Click 1 selects the block and focuses the field.
        view.rerender(
          builder(block.id, { blockId: block.id, nonce: 1 }, target(1))
        )
        const field = view.container.querySelector<HTMLElement>(
          `[data-block-field-path="${fieldPath}"]`
        )!
        // The field is below the visible area.
        Object.defineProperty(field, "getBoundingClientRect", {
          configurable: true,
          value: () => new DOMRect(0, 2_000, 300, 40),
        })
        await waitFor(
          () => expect(field.contains(document.activeElement)).toBe(true),
          { timeout: 5_000 }
        )
        // Clicks 2 and 3 of a triple click, 150 ms apart.
        await wait(150)
        view.rerender(
          builder(block.id, { blockId: block.id, nonce: 2 }, target(2, 2))
        )
        await nextFrame()
        await wait(150)
        view.rerender(
          builder(block.id, { blockId: block.id, nonce: 3 }, target(3, 3))
        )
        await nextFrame()
        await wait(400)
        expect(spy.scrolls()).toEqual([])
        expect(field.contains(document.activeElement)).toBe(true)
        // About 500 ms after the last click: one scroll, to the nearest edge.
        await wait(250)
        expect(spy.scrolls()).toEqual([
          ["scrollIntoView", [{ block: "nearest" }]],
        ])
        expect(spy.scrollIntoView.mock.instances[0]).toBe(field)
      } finally {
        spy.restore()
      }
    }
  )

  it(
    "does not scroll to a form field the owner can already see",
    blockProfile([]),
    async () => {
      const spy = spyScrolls()
      try {
        const view = render(builder(null, null))
        view.rerender(
          builder(
            block.id,
            { blockId: block.id, nonce: 1 },
            { blockId: block.id, fieldPath: "primary.eyebrow", nonce: 1 }
          )
        )
        await nextFrame()
        await wait(650)
        expect(spy.scrolls()).toEqual([])
      } finally {
        spy.restore()
      }
    }
  )

  it(
    "(e) an empty-spot click focuses the first control with no scroll, then one nearest scroll after the click",
    blockProfile([]),
    async () => {
      const spy = spyScrolls()
      try {
        const firstControl = (nonce: number) => (
          <BlockBuilder
            blocks={blocks}
            currentLocale="en"
            onChange={vi.fn()}
            pickerOpen={false}
            onPickerOpenChange={vi.fn()}
            selectedBlockId={block.id}
            previewClickSelection={{ blockId: block.id, nonce }}
            focusedFirstControlTarget={{ blockId: block.id, nonce }}
            onSelectedBlockIdChange={vi.fn()}
          />
        )
        const view = render(builder(null, null))
        view.rerender(firstControl(1))
        const control = view.container.querySelector<HTMLElement>(
          '[data-block-field-path="primary.eyebrow"] input'
        )!
        // The control is below the visible area.
        Object.defineProperty(control, "getBoundingClientRect", {
          configurable: true,
          value: () => new DOMRect(0, 2_000, 300, 40),
        })
        await nextFrame()
        expect(document.activeElement).toBe(control)
        await wait(400)
        expect(spy.scrolls()).toEqual([])
        await wait(150)
        expect(spy.scrolls()).toEqual([
          ["scrollIntoView", [{ block: "nearest" }]],
        ])
        expect(spy.scrollIntoView.mock.instances[0]).toBe(control)
      } finally {
        spy.restore()
      }
    }
  )

  it(
    "lets the owner's own scrolling cancel the later scroll",
    blockProfile([]),
    async () => {
      const spy = spyScrolls()
      try {
        const view = render(builder(null, null))
        view.rerender(
          builder(
            block.id,
            { blockId: block.id, nonce: 1 },
            { blockId: block.id, fieldPath: "primary.eyebrow", nonce: 1 }
          )
        )
        const field = view.container.querySelector<HTMLElement>(
          '[data-block-field-path="primary.eyebrow"]'
        )!
        Object.defineProperty(field, "getBoundingClientRect", {
          configurable: true,
          value: () => new DOMRect(0, 2_000, 300, 40),
        })
        await nextFrame()
        fireEvent.wheel(document.body)
        await wait(650)
        expect(spy.scrolls()).toEqual([])
      } finally {
        spy.restore()
      }
    }
  )

  it(
    "still scrolls to a block chosen by navigation, even one a preview click chose before",
    blockProfile([]),
    async () => {
      const spy = spyScrolls()
      try {
        const view = render(builder(null, null))
        const click = { blockId: block.id, nonce: 1 }
        view.rerender(builder(block.id, click))
        expect(spy.scrolls()).toEqual([])
        // The block button in the preview or the keyboard: no click marker.
        view.rerender(builder(other.id, click))
        expect(spy.scrolls()).toEqual([
          ["scrollIntoView", [{ block: "nearest" }]],
        ])
        spy.scrollIntoView.mockClear()
        view.rerender(builder(block.id, click))
        expect(spy.scrolls()).toEqual([
          ["scrollIntoView", [{ block: "nearest" }]],
        ])
        expect(spy.scrollIntoView.mock.instances[0]).toBe(row(view))
      } finally {
        spy.restore()
      }
    }
  )

  it(
    "does not keep a click marker across a cleared selection",
    blockProfile([]),
    async () => {
      const spy = spyScrolls()
      try {
        const view = render(builder(block.id, null))
        spy.scrollIntoView.mockClear()
        // A preview click on the block already selected: no selection change.
        view.rerender(builder(block.id, { blockId: block.id, nonce: 1 }))
        view.rerender(builder(null, { blockId: block.id, nonce: 1 }))
        // Navigation selects the block again, with no new click.
        view.rerender(builder(block.id, { blockId: block.id, nonce: 1 }))
        expect(spy.scrolls()).toEqual([
          ["scrollIntoView", [{ block: "nearest" }]],
        ])
      } finally {
        spy.restore()
      }
    }
  )
})

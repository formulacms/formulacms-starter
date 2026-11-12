import { sliceProfile } from "@/test-utils/slice-profile"
import { act, fireEvent, waitFor } from "@testing-library/react"
import { render } from "@/test-utils/admin-i18n"
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest"
import type { Slice } from "@/convex/lib/slices"
import type { FieldGenerate } from "./fields/field-editor"

// The rich-text editor is loaded lazily (`next/dynamic`), so its editable
// surface appears only once its code arrives. These tests hold that load
// behind a gate the test releases, which makes "slower than any fixed retry"
// deterministic instead of depending on machine load.
const gate = { release: () => {}, opened: Promise.resolve() }

vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
  useQuery_experimental: vi.fn(() => ({ status: "success", data: [] })),
}))

vi.mock("@/components/providers/confirm-provider", () => ({
  useConfirm: () => vi.fn(),
  usePrompt: () => vi.fn(),
}))

vi.mock("sonner", () => ({ toast: { error: vi.fn() } }))

const FIELD_PATH = "primary.features.0.title"
const scrollIntoView = vi.fn()
const stubbed = [
  [HTMLElement.prototype, "getClientRects", () => [new DOMRect()]],
  [HTMLElement.prototype, "getBoundingClientRect", () => new DOMRect()],
  [HTMLElement.prototype, "scrollIntoView", scrollIntoView],
  [Range.prototype, "getClientRects", () => [new DOMRect()]],
  [Range.prototype, "getBoundingClientRect", () => new DOMRect()],
] as const
const originals = stubbed.map(([target, key]) =>
  Object.getOwnPropertyDescriptor(target, key)
)

// Warm the editor's module transform once, so the gated load in each test
// re-runs already-compiled code instead of racing the focus wait limit.
beforeAll(async () => {
  await import("@/components/admin/rich-text-editor")
})

beforeEach(() => {
  // A fresh module graph and a fresh mock per test: `vi.mock` factories are
  // cached until unmocked, so only `vi.doMock` gates the editor every time.
  vi.resetModules()
  scrollIntoView.mockClear()
  gate.opened = new Promise<void>((resolve) => {
    gate.release = resolve
  })
  vi.doMock("@/components/admin/rich-text-editor", async (importOriginal) => {
    await gate.opened
    return importOriginal()
  })
  for (const [target, key, value] of stubbed)
    Object.defineProperty(target, key, { configurable: true, value })
})

afterEach(() => {
  gate.release()
  vi.doUnmock("@/components/admin/rich-text-editor")
  stubbed.forEach(([target, key], i) => {
    const original = originals[i]
    if (original) Object.defineProperty(target, key, original)
    else Reflect.deleteProperty(target, key)
  })
})

async function renderFocusedRichTextField(generate?: FieldGenerate) {
  // Import after the module reset so the builder, the slice definitions it
  // reads and the gated editor all come from the same fresh graph.
  const { sliceDefs } = await import("@/convex/lib/slices")
  const { group, list, richText } =
    await import("@/convex/lib/slices/primitives")
  const { createSampleSlice } = await import("@/lib/slices/sample")
  const { SliceBuilder } = await import("@/components/admin/slice-builder")
  const def = sliceDefs["hero-with-image"]
  Reflect.set(sliceDefs, "hero-with-image", {
    ...def,
    primary: group({
      ...def.primary.config.fields,
      features: list(group({ title: richText({ profile: "inline" }) })),
    }),
  })
  const slice: Slice = { ...createSampleSlice("hero-with-image"), id: "wait" }
  Reflect.set(slice.primary, "features", [{ title: "{}" }])
  const view = render(
    <SliceBuilder
      slices={[slice]}
      onChange={vi.fn()}
      currentLocale="en"
      pickerOpen={false}
      onPickerOpenChange={vi.fn()}
      selectedSliceId={slice.id}
      focusedFieldTarget={{
        sliceId: slice.id,
        fieldPath: FIELD_PATH,
        nonce: 1,
      }}
      generate={generate}
    />
  )
  const field = view.container.querySelector<HTMLElement>(
    `[data-slice-field-path="${FIELD_PATH}"]`
  )
  if (!field) throw new Error("Expected the primary-list rich-text field")
  return { view, field }
}

// Longer than the former fixed 300 ms retry, so a timed retry cannot pass.
async function waitPastFixedRetry() {
  await act(async () => {
    await new Promise<void>((resolve) => setTimeout(resolve, 400))
  })
}

describe("SliceBuilder focus for a lazily loaded editor", () => {
  it("focuses the rich-text field once its editor finishes loading", sliceProfile([]), async () => {
    const { field } = await renderFocusedRichTextField()
    await waitPastFixedRetry()
    // The field is brought into view while its editor is still loading.
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" })
    expect(field.querySelector("[contenteditable='true']")).toBeNull()
    expect(document.activeElement).toBe(document.body)

    await act(async () => gate.release())
    await waitFor(
      () => {
        expect(field.contains(document.activeElement)).toBe(true)
        expect(document.activeElement).toHaveAttribute(
          "contenteditable",
          "true"
        )
      },
      { timeout: 5_000 }
    )
  })

  it("waits for the editor instead of focusing a button beside the field", sliceProfile([]), async () => {
    const { field } = await renderFocusedRichTextField({
      run: vi.fn(),
      runRefine: vi.fn(),
      runSlice: vi.fn(),
    })
    expect(field.querySelector("button")).not.toBeNull()
    await waitPastFixedRetry()
    expect(document.activeElement).toBe(document.body)

    await act(async () => gate.release())
    await waitFor(
      () =>
        expect(document.activeElement).toHaveAttribute(
          "contenteditable",
          "true"
        ),
      { timeout: 5_000 }
    )
    expect(field.contains(document.activeElement)).toBe(true)
  })

  it("does not take focus after the user has interacted elsewhere", sliceProfile([]), async () => {
    const { field } = await renderFocusedRichTextField()
    await waitPastFixedRetry()
    expect(field.querySelector("[contenteditable='true']")).toBeNull()
    fireEvent.pointerDown(document.body)

    await act(async () => gate.release())
    await waitFor(
      () =>
        expect(field.querySelector("[contenteditable='true']")).not.toBeNull(),
      { timeout: 5_000 }
    )
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 50))
    })
    expect(document.activeElement).toBe(document.body)
  })
})

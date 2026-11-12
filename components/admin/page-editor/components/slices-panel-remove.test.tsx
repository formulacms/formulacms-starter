import { sliceProfile } from "@/test-utils/slice-profile"
import { useState } from "react"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import type { Slice } from "@/convex/lib/slices"
import { readSlicePresentationCatalog } from "@/convex/lib/slices/presentations"
import { SlicesPanel } from "./slices-panel"

const mocks = vi.hoisted(() => ({
  archived: { status: "success", data: [] as string[] },
  error: vi.fn(),
}))
vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
  useQuery_experimental: () => mocks.archived,
}))
vi.mock("sonner", () => ({ toast: { error: mocks.error } }))
// Only the backend-driven preview is replaced. Panel, builder, slice editor,
// ConfirmProvider and Radix Dialog retain their real event and state wiring.
vi.mock("@/components/admin/page-live-preview", () => ({
  PageLivePreview: () => null,
}))

// ORDER11 r8 editor-intake.json: F09 EN, one shared-draft occurrence,
// localeDrafts empty. Keep the stored shape, including its existing valid ID.
const storedSlice: Slice = {
  "enabled": true,
  "id": "f6f24163-a9f7-4f11-b865-32f9d81757b2",
  "items": [
    {
      "enabled": true,
      "id": "demo",
      "itemId": "9bd16cd8-20fd-4d1e-abd2-17263711d82f",
      "label": "Demo",
      "link": {
        "type": "external",
        "url": "https://example.com/demo"
      },
      "variant": "outline",
      "withIcon": false
    },
    {
      "enabled": true,
      "id": "sign-up",
      "itemId": "e4b874a4-18dc-4ab3-93ad-844323dc10a1",
      "label": "Sign up",
      "link": {
        "type": "external",
        "url": "https://example.com/sign-up"
      },
      "variant": "primary",
      "withIcon": false
    }
  ],
  "primary": {
    "description": "{\"type\":\"doc\",\"content\":[{\"type\":\"paragraph\",\"content\":[{\"type\":\"text\",\"text\":\"Powerful, self-serve product and growth analytics to help you convert, engage, and retain more.\"}]}]}",
    "eyebrow": "ORDER11 round7 archived occurrence",
    "eyebrowLink": {
      "type": "external",
      "url": "https://example.com/careers"
    },
    "eyebrowLinkLabel": "Join our remote team",
    "image": {
      "alt": "Person standing in a creative studio",
      "height": 1201,
      "url": "/slice-samples/hero-with-image.webp",
      "width": 1500
    },
    "title": "{\"type\":\"doc\",\"content\":[{\"type\":\"heading\",\"attrs\":{\"level\":2},\"content\":[{\"type\":\"text\",\"text\":\"People who care about your growth\"}]}]}"
  },
  "type": "hero-with-image"
}

let catalog: Awaited<ReturnType<typeof readSlicePresentationCatalog>>

function EditorSlices({ onChange }: { onChange: (slices: Slice[]) => void }) {
  const [slices, setSlices] = useState<Slice[]>([storedSlice])
  const [selectedSliceId, setSelectedSliceId] = useState<string | null>(null)
  const [slicePickerOpen, setSlicePickerOpen] = useState(false)
  return (
    <SlicesPanel
      title="Starter E2E"
      currentLocale="en"
      defaultLocale="en"
      slices={slices}
      sourceSlices={[]}
      fieldTranslate={undefined}
      fieldGenerate={undefined}
      presentationCatalog={catalog}
      slicePickerOpen={slicePickerOpen}
      selectedSliceId={selectedSliceId}
      focusedFieldTarget={null}
      focusedFirstControlTarget={null}
      previewInlineRefusal={null}
      previewInlineEditingEnabled={false}
      onSlicesChange={(next) => { onChange(next); setSlices(next) }}
      onSlicePickerOpenChange={setSlicePickerOpen}
      onSelectedSliceIdChange={setSelectedSliceId}
      onPreviewSelectSlice={setSelectedSliceId}
      onPreviewSelectSliceFallback={setSelectedSliceId}
      onPreviewSelectField={() => {}}
      onPreviewInlineEditCommit={() => {}}
      onPreviewInlineEditingEnabledChange={() => {}}
      onSave={() => {}}
      onOpenSavedPreview={() => {}}
    />
  )
}

// user-event is not in this repository. Dispatch its documented pointer/focus/
// click sequence with the existing Testing Library API, including row capture.
function clickRemove() {
  const button = screen.getByRole("button", { name: "Remove Hero with Image 1" })
  fireEvent.pointerDown(button)
  fireEvent.mouseDown(button)
  act(() => button.focus())
  fireEvent.pointerUp(button)
  fireEvent.mouseUp(button)
  fireEvent.click(button)
}

beforeEach(async () => {
  catalog = await readSlicePresentationCatalog()
  mocks.error.mockClear()
  mocks.archived.data = []
  Element.prototype.scrollIntoView = vi.fn()
})

describe("SlicesPanel removal with the real confirmation dialog", () => {
  it("opens Remove for the stored EN occurrence and confirms its removal", sliceProfile(["hero-with-image"]), async () => {
    const onChange = vi.fn()
    render(<ConfirmProvider><EditorSlices onChange={onChange} /></ConfirmProvider>)
    clickRemove()
    const dialog = await screen.findByRole("dialog", {
      name: "Remove Hero with Image from EN?",
    })
    expect(onChange).not.toHaveBeenCalled()
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }))
    await waitFor(() => expect(onChange).toHaveBeenCalledExactlyOnceWith([]))
    expect(screen.queryByTitle("Remove block")).not.toBeInTheDocument()
  })
})

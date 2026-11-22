import { blockProfile } from "@/test-utils/block-profile"
import { useState } from "react"
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { render } from "@/test-utils/admin-i18n"
import { ConfirmProvider } from "@/components/providers/confirm-provider"
import type { Block } from "@/convex/lib/blocks"
import { readBlockPresentationCatalog } from "@/convex/lib/blocks/presentations"
import { BlocksPanel } from "./blocks-panel"

const mocks = vi.hoisted(() => ({
  archived: { status: "success", data: [] as string[] },
  error: vi.fn(),
  preview: null as null | {
    onSelectField(target: unknown, result?: unknown): void
    onSelectBlockFallback(blockId: string): void
  },
}))
vi.mock("convex/react", () => ({
  useQuery: vi.fn(() => []),
  useQuery_experimental: () => mocks.archived,
}))
vi.mock("sonner", () => ({ toast: { error: mocks.error } }))
// Only the backend-driven preview is replaced. Panel, builder, block editor,
// ConfirmProvider and Radix Dialog retain their real event and state wiring.
vi.mock("@/components/admin/page-live-preview", () => ({
  PageLivePreview: (props: NonNullable<typeof mocks.preview>) => {
    mocks.preview = props
    return null
  },
}))

// ORDER11 r8 editor-intake.json: F09 EN, one shared-draft occurrence,
// localeDrafts empty. Keep the stored shape, including its existing valid ID.
const storedBlock: Block = {
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
      "url": "/block-samples/hero-with-image.webp",
      "width": 1500
    },
    "title": "{\"type\":\"doc\",\"content\":[{\"type\":\"heading\",\"attrs\":{\"level\":2},\"content\":[{\"type\":\"text\",\"text\":\"People who care about your growth\"}]}]}"
  },
  "type": "hero-with-image"
}

let catalog: Awaited<ReturnType<typeof readBlockPresentationCatalog>>

function EditorBlocks({
  onChange,
  onSelectField = () => {},
}: {
  onChange: (blocks: Block[]) => void
  onSelectField?: (target: unknown, result?: unknown) => void
}) {
  const [blocks, setBlocks] = useState<Block[]>([storedBlock])
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null)
  const [blockPickerOpen, setBlockPickerOpen] = useState(false)
  return (
    <BlocksPanel
      title="Starter E2E"
      currentLocale="en"
      defaultLocale="en"
      blocks={blocks}
      sourceBlocks={[]}
      fieldTranslate={undefined}
      fieldGenerate={undefined}
      presentationCatalog={catalog}
      blockPickerOpen={blockPickerOpen}
      selectedBlockId={selectedBlockId}
      focusedFieldTarget={null}
      focusedFirstControlTarget={null}
      previewInlineRefusal={null}
      onBlocksChange={(next) => { onChange(next); setBlocks(next) }}
      onBlockPickerOpenChange={setBlockPickerOpen}
      onSelectedBlockIdChange={setSelectedBlockId}
      onPreviewSelectBlock={setSelectedBlockId}
      onPreviewSelectBlockFallback={setSelectedBlockId}
      onPreviewSelectField={onSelectField}
      onPreviewInlineEditCommit={() => {}}
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
  catalog = await readBlockPresentationCatalog()
  mocks.error.mockClear()
  mocks.archived.data = []
  Element.prototype.scrollIntoView = vi.fn()
})

describe("BlocksPanel removal with the real confirmation dialog", () => {
  it("opens Remove for the stored EN occurrence and confirms its removal", blockProfile(["hero-with-image"]), async () => {
    const onChange = vi.fn()
    render(<ConfirmProvider><EditorBlocks onChange={onChange} /></ConfirmProvider>)
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

describe("BlocksPanel: a click in the preview", () => {
  // Editing in the preview is always on (owner, 2026-11-21): the preview
  // column scrolls with the page, so nothing holds it during a click.
  it("reaches the editor unchanged and leaves the preview column alone", blockProfile(["hero-with-image"]), () => {
    const onSelectField = vi.fn()
    const view = render(
      <ConfirmProvider>
        <EditorBlocks onChange={vi.fn()} onSelectField={onSelectField} />
      </ConfirmProvider>
    )
    const column = view.container.querySelector<HTMLElement>("aside")!
    expect(column.className).toBe("min-w-0")
    const target = { blockId: storedBlock.id, fieldPath: "primary.description" }
    const refused = { status: "refused", reason: "unsupported" }
    act(() => mocks.preview!.onSelectField(target, refused))
    expect(onSelectField).toHaveBeenCalledExactlyOnceWith(target, refused)
    expect(column.style.top).toBe("")
    expect(screen.queryByRole("status")).toBeNull()
  })
})

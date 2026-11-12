"use client"

import {
  useRef,
  useSyncExternalStore,
  type ClipboardEvent,
  type DragEvent,
} from "react"
import Image from "next/image"
import { useRouter } from "next/navigation"
import { ClipboardPaste, ImagePlus, Loader2 } from "lucide-react"
import { toast } from "sonner"
import type { SlicePreviewFrame } from "./slice-preview-frame"
import type { ThumbnailVariant } from "@/lib/slices/thumbnails"
import { useElementWidth } from "./use-element-width"
import { SOURCE_IMAGE_UPDATED_EVENT } from "@/components/admin/slices/slice-sim-events"
import { useDesignReplace } from "@/components/admin/slices/use-design-replace"
import { Button } from "@/components/ui/button"

/**
 * The existing source upload/drop/paste/replace flow, extracted intact so the
 * responsive canvas can reveal it beside the live render. Source and render
 * retain independent contain scales because Unit A does not register pixels.
 */
export function SourceReferencePane({
  type,
  view,
  url,
  frame,
  onChange,
}: {
  type: string
  view: ThumbnailVariant
  url: string | null
  frame: SlicePreviewFrame
  onChange: (variant: ThumbnailVariant, url: string) => void
}) {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const frameWrapRef = useRef<HTMLDivElement>(null)
  const label = view === "mobile" ? "mobile" : "desktop"
  const {
    acceptFile,
    isSaving: isUploading,
    prompt,
  } = useDesignReplace({
    type,
    variant: view,
    onSaved: (savedUrl) => {
      onChange(view, savedUrl)
      window.dispatchEvent(new Event(SOURCE_IMAGE_UPDATED_EVENT))
      router.refresh()
    },
  })
  const availableWidth = useElementWidth(frameWrapRef, frame.width)
  const viewportHeight = useViewportHeight()
  const maxFrameHeight = Math.max(360, viewportHeight - 220)
  const scale = Math.min(
    1,
    Math.max(1, availableWidth) / frame.width,
    maxFrameHeight / frame.height
  )
  const scaledHeight = Math.ceil(frame.height * scale)

  async function acceptClipboard() {
    try {
      if (!navigator.clipboard?.read) {
        toast.error("Clipboard image paste is not available in this browser.")
        return
      }
      const items = await navigator.clipboard.read()
      const image = firstClipboardImage(items)
      if (image) {
        const blob = await image.item.getType(image.type)
        await acceptFile(
          new File([blob], `clipboard-${label}.${extensionFor(image.type)}`, {
            type: image.type,
          })
        )
      } else {
        toast.error("Clipboard does not contain an image.")
      }
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "Could not read clipboard."
      )
    }
  }

  function handlePaste(event: ClipboardEvent<HTMLDivElement>) {
    const file = clipboardImageFile(event.clipboardData, label)
    if (!file) return
    event.preventDefault()
    void acceptFile(file)
  }

  return (
    <div className="space-y-2" onPaste={handlePaste}>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        aria-label="Upload source image"
        className="hidden"
        onChange={(event) => {
          void acceptFile(event.target.files?.[0])
          event.currentTarget.value = ""
        }}
      />
      <button
        type="button"
        aria-label={
          url ? `Replace ${label} source image` : `Upload ${label} source image`
        }
        disabled={isUploading}
        className="relative flex w-full items-center justify-center overflow-hidden rounded-md border border-dashed bg-muted/20 text-left transition-colors hover:border-foreground/30 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none disabled:pointer-events-none disabled:opacity-50"
        style={{ minHeight: scaledHeight }}
        onClick={() => inputRef.current?.click()}
        onDragOver={(event: DragEvent<HTMLButtonElement>) =>
          event.preventDefault()
        }
        onDrop={(event: DragEvent<HTMLButtonElement>) => {
          event.preventDefault()
          void acceptFile(event.dataTransfer.files?.[0])
        }}
      >
        <div ref={frameWrapRef} className="w-full overflow-hidden">
          {url ? (
            <div
              className="relative mx-auto bg-background"
              style={{
                width: frame.width * scale,
                height: scaledHeight,
              }}
            >
              <Image
                src={url}
                alt={`${type} ${label} source image`}
                fill
                unoptimized
                sizes="(min-width: 1280px) 50vw, 100vw"
                className="object-contain"
              />
            </div>
          ) : (
            /* Say what is true rather than implying a design exists to find:
               no mobile design was ever supplied for these slices, and none is
               invented by shrinking the desktop one (slice-fidelity plan §5 B5
               rules 4 and 5). The pane itself is the add action. */
            <span className="flex flex-col items-center gap-2 px-6 text-center text-sm text-muted-foreground">
              <ImagePlus className="size-8" />
              <span>
                No {label} design was supplied.
                <br />
                Click, drop, or paste one here to add it.
              </span>
            </span>
          )}
        </div>
        {isUploading && (
          <span className="absolute inset-0 flex items-center justify-center bg-background/70">
            <Loader2 className="size-5 animate-spin" />
          </span>
        )}
      </button>
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>Click, drop, or paste into this pane.</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isUploading}
          onClick={() => void acceptClipboard()}
        >
          <ClipboardPaste className="size-4" />
          Paste image
        </Button>
      </div>

      {prompt}
    </div>
  )
}

function firstClipboardImage(
  items: ClipboardItem[]
): { item: ClipboardItem; type: string } | null {
  let fallback: { item: ClipboardItem; type: string } | null = null
  for (const item of items) {
    for (const type of item.types) {
      if (type === "image/png") return { item, type }
      if (!fallback && type.startsWith("image/")) fallback = { item, type }
    }
  }
  return fallback
}

function clipboardImageFile(data: DataTransfer, label: string): File | null {
  const directFile = Array.from(data.files).find((file) =>
    file.type.startsWith("image/")
  )
  if (directFile) return directFile

  for (const item of Array.from(data.items)) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (!file) continue
    return file.name
      ? file
      : new File([file], `clipboard-${label}.${extensionFor(file.type)}`, {
          type: file.type,
        })
  }
  return null
}

function extensionFor(type: string): string {
  return type.split("/")[1] || "png"
}

function useViewportHeight() {
  return useSyncExternalStore(
    (onStoreChange) => {
      window.addEventListener("resize", onStoreChange)
      return () => window.removeEventListener("resize", onStoreChange)
    },
    () => window.innerHeight,
    () => 720
  )
}

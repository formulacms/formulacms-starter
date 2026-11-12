"use client"

import { MediaBrowser, type Media } from "./media-browser"
import { useTranslations } from "next-intl"
import type { ImageField } from "@/convex/lib/slices"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/** Map a media doc to the `imageField` shape stored on slices. */
function toImageField(m: Media): ImageField {
  return {
    url: m.url,
    storageId: m.storageId,
    width: m.width,
    height: m.height,
    focal: m.focal,
    crop: m.crop,
    cropSize: m.cropSize,
  }
}

/**
 * Modal that lets an editor browse/upload media and pick one. `onSelect`
 * receives the `imageField` shape ready to store on a slice, plus the source
 * media doc for flows that need to persist the media-library record itself.
 */
export function MediaPicker({
  open,
  onOpenChange,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onSelect: (image: ImageField, media: Media) => void
  locale?: string
}) {
  const t = useTranslations("editor.mediaPicker")

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="h-[60vh] min-h-0">
          <MediaBrowser
            onItemClick={(m) => {
              onSelect(toImageField(m), m)
              onOpenChange(false)
            }}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

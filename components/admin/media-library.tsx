"use client"

import Image from "next/image"
import { useEffect, useReducer, useState, type CSSProperties } from "react"
import { useConvex, useQuery, useMutation } from "convex/react"
import { useLocale, useTranslations } from "next-intl"
import { formatMediaBytes } from "@/lib/i18n/admin-format"
import { useCaughtError } from "@/lib/i18n/use-caught-error"
import { api } from "@/convex/_generated/api"
import { toast } from "sonner"
import { SlidersHorizontal, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { MediaBrowser, type Media } from "./media-browser"
import { ImageTransformEditorDialog } from "./media-image-editor"
import { TagField } from "./tag-field"
import { useConfirm } from "@/components/providers/confirm-provider"
import type { ImageField } from "@/convex/lib/slices"
import { destructiveRefusalMessage } from "@/lib/admin/destructive-refusal"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"


const NO_FOLDER = "__none__"

type MediaDraft = {
  loadedId: string | null
  folder: string
  tags: string[]
  focal?: ImageField["focal"]
  crop?: ImageField["crop"]
  cropSize?: ImageField["cropSize"]
}

type MediaDraftAction =
  | { type: "load"; media: Media }
  | { type: "close" }
  | { type: "setFolder"; value: string }
  | { type: "setTags"; value: string[] }
  | { type: "setImageDefaults"; value: ImageField }

const emptyDraft: MediaDraft = {
  loadedId: null,
  folder: "",
  tags: [],
}

function draftFromMedia(media: Media): MediaDraft {
  return {
    loadedId: media._id,
    folder: media.folder ?? "",
    tags: media.tags ?? [],
    focal: media.focal,
    crop: media.crop,
    cropSize: media.cropSize,
  }
}

function mediaDraftReducer(
  state: MediaDraft,
  action: MediaDraftAction
): MediaDraft {
  switch (action.type) {
    case "load":
      return state.loadedId === action.media._id
        ? state
        : draftFromMedia(action.media)
    case "close":
      return state.loadedId === null ? state : emptyDraft
    case "setFolder":
      return { ...state, folder: action.value }
    case "setTags":
      return { ...state, tags: action.value }
    case "setImageDefaults":
      return {
        ...state,
        focal: action.value.focal,
        crop: action.value.crop,
        cropSize: action.value.cropSize,
      }
  }
}

function imageFieldFromMedia(media: Media, draft: MediaDraft): ImageField {
  return {
    storageId: media.storageId,
    url: media.url,
    width: media.width,
    height: media.height,
    focal: draft.focal,
    crop: draft.crop,
    cropSize: draft.cropSize,
  }
}

function imageFramingSummary(
  image: ImageField | undefined,
  labels: { cropped: string; focal: (x: number, y: number) => string }
): string[] {
  if (!image) return []
  const details: string[] = []
  if (image.cropSize) {
    details.push(`${image.cropSize.width}x${image.cropSize.height}`)
  } else if (image.crop && image.width && image.height) {
    details.push(
      `${Math.round((image.width * image.crop.width) / 100)}x${Math.round(
        (image.height * image.crop.height) / 100
      )}`
    )
  } else if (image.crop) {
    details.push(labels.cropped)
  }
  if (image.focal) {
    details.push(
      labels.focal(Math.round(image.focal.x), Math.round(image.focal.y))
    )
  }
  return details
}

function MediaImagePreview({ image }: { image: ImageField }) {
  if (!image.url) return null

  const crop = image.crop
  const cropWidth = crop?.width ?? 100
  const cropHeight = crop?.height ?? 100
  const sourceWidth = image.width ?? image.cropSize?.width
  const sourceHeight = image.height ?? image.cropSize?.height
  const renderedWidth =
    image.cropSize?.width ??
    (sourceWidth ? Math.round((sourceWidth * cropWidth) / 100) : undefined)
  const renderedHeight =
    image.cropSize?.height ??
    (sourceHeight ? Math.round((sourceHeight * cropHeight) / 100) : undefined)
  const aspectRatio =
    renderedWidth && renderedHeight
      ? renderedWidth / renderedHeight
      : sourceWidth && sourceHeight
        ? sourceWidth / sourceHeight
        : cropWidth / cropHeight
  const focalStyle: CSSProperties | undefined = image.focal
    ? { objectPosition: `${image.focal.x}% ${image.focal.y}%` }
    : undefined

  if (crop || image.cropSize) {
    const frameStyle: CSSProperties = {
      aspectRatio,
      width: `min(100%, calc(16rem * ${aspectRatio}))`,
    }
    const imageStyle: CSSProperties = crop
      ? {
          position: "absolute",
          left: `${-(crop.x / cropWidth) * 100}%`,
          top: `${-(crop.y / cropHeight) * 100}%`,
          width: `${10000 / cropWidth}%`,
          height: `${10000 / cropHeight}%`,
          maxWidth: "none",
        }
      : {
          position: "absolute",
          inset: 0,
          width: "100%",
          height: "100%",
          objectFit: "cover",
          ...focalStyle,
        }

    return (
      <div className="flex h-64 items-center justify-center rounded-lg border bg-muted p-2">
        <span
          className="relative block max-h-full overflow-hidden"
          style={frameStyle}
        >
          <Image
            src={image.url}
            alt=""
            width={image.width ?? 1}
            height={image.height ?? 1}
            unoptimized
            className="select-none"
            style={imageStyle}
          />
        </span>
      </div>
    )
  }

  return (
    <div className="flex h-64 items-center justify-center rounded-lg border bg-muted p-2">
      <Image
        src={image.url}
        alt=""
        width={image.width ?? 1}
        height={image.height ?? 1}
        unoptimized
        className="max-h-full max-w-full object-contain select-none"
        style={focalStyle}
      />
    </div>
  )
}

export function MediaLibrary() {
  const t = useTranslations("inventory.mediaLibrary")
  const [selected, setSelected] = useState<Media | null>(null)

  return (
    <div className="flex h-[calc(100vh-8rem)] flex-col">
      <div className="mb-4 shrink-0">
        <h1 className="text-2xl font-semibold">{t("title")}</h1>
        <p className="text-sm text-muted-foreground">
          {t("subtitle")}
        </p>
      </div>
      <div className="min-h-0 flex-1">
        <MediaBrowser onItemClick={setSelected} />
      </div>
      <MediaDetailDialog
        key={selected?._id ?? "no-media-selected"}
        media={selected}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}

function MediaDetailDialog({
  media,
  onClose,
}: {
  media: Media | null
  onClose: () => void
}) {
  const displayError = useCaughtError()
  const adminLocale = useLocale()
  const t = useTranslations("inventory.mediaLibrary")
  const convex = useConvex()
  const folders = useQuery(api.cms.media.listFolders, {}) ?? []
  const update = useMutation(api.cms.media.update)
  const softDelete = useMutation(api.cms.media.softDelete)
  const confirm = useConfirm()
  const [draft, dispatchDraft] = useReducer(mediaDraftReducer, emptyDraft)
  const [editorOpen, setEditorOpen] = useState(false)

  useEffect(() => {
    if (media) {
      dispatchDraft({ type: "load", media })
    } else {
      dispatchDraft({ type: "close" })
    }
  }, [media])

  const currentDraft =
    media && draft.loadedId !== media._id ? draftFromMedia(media) : draft

  const folderOptions =
    currentDraft.folder && !folders.includes(currentDraft.folder)
      ? [currentDraft.folder, ...folders]
      : folders
  const imageDefaults = media
    ? imageFieldFromMedia(media, currentDraft)
    : undefined
  const framingSummary = imageFramingSummary(imageDefaults, {
    cropped: t("cropped"),
    focal: (x, y) => t("focal", { x, y }),
  })

  async function handleSave() {
    if (!media) return
    try {
      await update({
        id: media._id,
        folder: currentDraft.folder.trim() || undefined,
        tags: currentDraft.tags,
        focal: currentDraft.focal ?? null,
        crop: currentDraft.crop ?? null,
        cropSize: currentDraft.cropSize ?? null,
      })
      toast.success(t("saved"))
      onClose()
    } catch (err) {
      toast.error(displayError(err, t("saveFailed")))
    }
  }

  async function handleDelete() {
    if (!media) return
    let usage
    try {
      usage = await convex.query(api.cms.media.usage, { id: media._id })
    } catch (err) {
      toast.error(
        displayError(err, t("usageFailed"))
      )
      return
    }
    // The server refuses an image still in use, so say so before asking.
    if (usage.settings.length > 0 || usage.pages.length > 0) {
      toast.error(t("referencedDeleteRefusal"))
      return
    }
    const ok = await confirm({
      title: t("confirmTitle"),
      description: t("confirmUnreferenced"),
      confirmText: t("confirm"),
      destructive: true,
    })
    if (!ok) return
    try {
      await softDelete({ id: media._id })
      toast.success(t("movedToTrash"))
      onClose()
    } catch (err) {
      toast.error(
        destructiveRefusalMessage(err, t("deleteFailed"), {
          MEDIA_SOFT_DELETE_REFERENCED: t("referencedDeleteRefusal"),
        })
      )
    }
  }

  return (
    <>
      <Dialog
        open={!!media}
        onOpenChange={(open) => {
          if (!open) {
            setEditorOpen(false)
            onClose()
          }
        }}
      >
        <DialogContent className="sm:max-w-xl">
          {media && (
            <>
              <DialogHeader>
                <DialogTitle className="truncate">{media.filename}</DialogTitle>
              </DialogHeader>
              <div className="space-y-4">
                {imageDefaults ? (
                  <MediaImagePreview image={imageDefaults} />
                ) : null}
                <p className="text-xs text-muted-foreground">
                  {media.mimeType} · {formatMediaBytes(media.size, adminLocale, t)}
                  {media.width && media.height
                    ? ` · ${media.width}×${media.height}`
                    : ""}
                </p>
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap gap-1.5">
                    {framingSummary.map((item) => (
                      <span
                        key={item}
                        className="rounded border bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground"
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setEditorOpen(true)}
                  >
                    <SlidersHorizontal className="size-3.5" />
                    {t("edit")}
                  </Button>
                </div>

                <div className="space-y-1.5">
                  <label htmlFor="media-folder-select" className="block text-sm font-medium">{t("folder")}</label>
                  <Select
                    value={currentDraft.folder || NO_FOLDER}
                    onValueChange={(value) =>
                      dispatchDraft({
                        type: "setFolder",
                        value: value === NO_FOLDER ? "" : value,
                      })
                    }
                  >
                    <SelectTrigger id="media-folder-select" className="w-full">
                      <SelectValue placeholder={t("noFolder")} />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_FOLDER}>{t("noFolder")}</SelectItem>
                      {folderOptions.map((name) => (
                        <SelectItem key={name} value={name}>
                          {name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                <div className="space-y-1.5">
                  <label
                    htmlFor="media-tags"
                    className="block text-sm font-medium"
                  >
                    {t("tags")}
                  </label>
                  <TagField
                    id="media-tags"
                    value={currentDraft.tags}
                    onChange={(value) =>
                      dispatchDraft({ type: "setTags", value })
                    }
                  />
                </div>
              </div>

              <div className="flex items-center justify-between">
                <button
                  type="button"
                  onClick={handleDelete}
                  className="flex items-center gap-1.5 text-sm text-destructive hover:underline"
                >
                  <Trash2 className="size-3.5" />
                  {t("trash")}
                </button>
                <Button type="button" onClick={handleSave}>
                  {t("save")}
                </Button>
              </div>
            </>
          )}
        </DialogContent>
      </Dialog>
      <ImageTransformEditorDialog
        image={imageDefaults}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        onApply={(image) =>
          dispatchDraft({ type: "setImageDefaults", value: image })
        }
      />
    </>
  )
}

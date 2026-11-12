"use client"

import { useEffect, useReducer, type MouseEvent } from "react"
import { useTranslations } from "next-intl"
import Image from "next/image"
import ReactCrop, { type PercentCrop } from "react-image-crop"
import { Crop, Crosshair, RotateCcw, Save } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { ImageField } from "@/convex/lib/slices"
import {
  clampPercent,
  normalizeFocalPoint,
  type FocalPoint,
} from "@/lib/media/image-client"

type AspectKey =
  "original" | "square" | "landscape" | "portrait" | "wide" | "custom"

const ASPECT_KEYS: readonly AspectKey[] = [
  "original",
  "square",
  "landscape",
  "portrait",
  "wide",
  "custom",
]

const FULL_CROP: PercentCrop = {
  unit: "%",
  x: 0,
  y: 0,
  width: 100,
  height: 100,
}

type CropRect = NonNullable<ImageField["crop"]>
type CropSize = NonNullable<ImageField["cropSize"]>

type EditorState = {
  imageKey: string | null
  crop: PercentCrop
  aspect: AspectKey
  focal: FocalPoint
  customWidth: string
  customHeight: string
  autoHeight: boolean
}

type EditorAction =
  | { type: "load"; image: ImageField }
  | {
      type: "setAspect"
      value: AspectKey
      crop: PercentCrop
      customHeight?: string
    }
  | { type: "setCrop"; value: PercentCrop; customHeight?: string }
  | { type: "setFocal"; value: FocalPoint }
  | {
      type: "setCustomWidth"
      value: string
      crop: PercentCrop
      customHeight?: string
    }
  | { type: "setCustomHeight"; value: string; crop: PercentCrop }
  | {
      type: "setAutoHeight"
      value: boolean
      crop: PercentCrop
      customHeight?: string
    }
  | { type: "reset"; image: ImageField }

const emptyState: EditorState = {
  imageKey: null,
  crop: FULL_CROP,
  aspect: "original",
  focal: { x: 50, y: 50 },
  customWidth: "",
  customHeight: "",
  autoHeight: true,
}

function imageKey(image: ImageField): string {
  return `${image.storageId}:${image.url ?? ""}`
}

function derivedCropSize(image: ImageField): CropSize | undefined {
  if (image.cropSize) return image.cropSize
  if (!image.width || !image.height || !image.crop) return undefined
  return {
    width: Math.round((image.width * image.crop.width) / 100),
    height: Math.round((image.height * image.crop.height) / 100),
  }
}

function cropToPercent(crop: CropRect | undefined): PercentCrop {
  if (!crop) return FULL_CROP
  return {
    unit: "%",
    x: crop.x,
    y: crop.y,
    width: crop.width,
    height: crop.height,
  }
}

function initialState(image: ImageField): EditorState {
  const cropSize = derivedCropSize(image)
  return {
    ...emptyState,
    imageKey: imageKey(image),
    crop: cropToPercent(image.crop),
    focal: normalizeFocalPoint(image.focal),
    customWidth: cropSize?.width ? String(cropSize.width) : "",
    customHeight: cropSize?.height ? String(cropSize.height) : "",
    autoHeight: !image.cropSize,
    aspect: image.cropSize ? "custom" : "original",
  }
}

function editorReducer(state: EditorState, action: EditorAction): EditorState {
  switch (action.type) {
    case "load":
      return state.imageKey === imageKey(action.image)
        ? state
        : initialState(action.image)
    case "setAspect":
      return {
        ...state,
        aspect: action.value,
        crop: action.crop,
        ...(action.customHeight !== undefined
          ? { customHeight: action.customHeight }
          : {}),
      }
    case "setCrop":
      return {
        ...state,
        crop: action.value,
        ...(action.customHeight !== undefined
          ? { customHeight: action.customHeight }
          : {}),
      }
    case "setFocal":
      return { ...state, focal: action.value }
    case "setCustomWidth":
      return {
        ...state,
        aspect: "custom",
        customWidth: action.value,
        crop: action.crop,
        ...(action.customHeight !== undefined
          ? { customHeight: action.customHeight }
          : {}),
      }
    case "setCustomHeight":
      return {
        ...state,
        aspect: "custom",
        autoHeight: false,
        customHeight: action.value,
        crop: action.crop,
      }
    case "setAutoHeight":
      return {
        ...state,
        aspect: "custom",
        autoHeight: action.value,
        crop: action.crop,
        ...(action.customHeight !== undefined
          ? { customHeight: action.customHeight }
          : {}),
      }
    case "reset":
      return {
        ...emptyState,
        imageKey: imageKey(action.image),
        crop: FULL_CROP,
      }
  }
}

function originalAspectFor(image: ImageField): number {
  return image.width && image.height ? image.width / image.height : 1
}

function fixedAspectFor(
  image: ImageField,
  state: EditorState,
  aspect: AspectKey = state.aspect
): number | undefined {
  const customWidth = positiveInteger(state.customWidth)
  const customHeight = positiveInteger(state.customHeight)

  switch (aspect) {
    case "square":
      return 1
    case "landscape":
      return 4 / 3
    case "portrait":
      return 3 / 4
    case "wide":
      return 16 / 9
    case "original":
      return originalAspectFor(image)
    case "custom":
      return !state.autoHeight && customWidth && customHeight
        ? customWidth / customHeight
        : undefined
  }
}

function positiveInteger(value: string): number | null {
  const parsed = Number(value.trim())
  if (!Number.isFinite(parsed) || parsed < 1) return null
  return Math.round(parsed)
}

function clampValue(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, value))
}

function cleanArea(crop: PercentCrop): CropRect {
  const width = clampValue(crop.width, 0, 100)
  const height = clampValue(crop.height, 0, 100)
  const x = clampValue(crop.x, 0, 100 - width)
  const y = clampValue(crop.y, 0, 100 - height)

  return {
    x: Number(x.toFixed(3)),
    y: Number(y.toFixed(3)),
    width: Number(width.toFixed(3)),
    height: Number(height.toFixed(3)),
  }
}

function cleanPercentCrop(crop: PercentCrop): PercentCrop {
  return {
    unit: "%",
    ...cleanArea(crop),
  }
}

function isFullCrop(crop: CropRect): boolean {
  return (
    crop.x <= 0.01 &&
    crop.y <= 0.01 &&
    crop.width >= 99.99 &&
    crop.height >= 99.99
  )
}

function cropAspectFor(image: ImageField, crop: PercentCrop): number {
  const baseAspect = originalAspectFor(image)
  if (!crop.width || !crop.height) return baseAspect
  return baseAspect * (crop.width / crop.height)
}

function fitCropToAspect(
  crop: PercentCrop,
  image: ImageField,
  aspect: number | undefined
): PercentCrop {
  if (!aspect) return cleanPercentCrop(crop)

  const imageWidth = image.width ?? 1000
  const imageHeight =
    image.height ?? Math.round(imageWidth / originalAspectFor(image))
  const centerX = crop.x + crop.width / 2
  const centerY = crop.y + crop.height / 2
  let widthPx = (Math.max(1, crop.width) / 100) * imageWidth
  let heightPx = widthPx / aspect

  if (heightPx > imageHeight) {
    heightPx = imageHeight
    widthPx = heightPx * aspect
  }
  if (widthPx > imageWidth) {
    widthPx = imageWidth
    heightPx = widthPx / aspect
  }

  const width = (widthPx / imageWidth) * 100
  const height = (heightPx / imageHeight) * 100

  return cleanPercentCrop({
    unit: "%",
    x: clampValue(centerX - width / 2, 0, 100 - width),
    y: clampValue(centerY - height / 2, 0, 100 - height),
    width,
    height,
  })
}

function autoHeightForWidth(
  widthValue: string,
  image: ImageField,
  state: EditorState,
  crop: PercentCrop = state.crop
): string {
  const width = positiveInteger(widthValue)
  if (!width) return ""
  const ratio = cropAspectFor(image, crop)
  return String(Math.max(1, Math.round(width / ratio)))
}

function cropSizeFromState(
  image: ImageField,
  state: EditorState
): CropSize | undefined {
  if (state.aspect !== "custom") return undefined

  const width = positiveInteger(state.customWidth)
  const height = positiveInteger(
    state.autoHeight
      ? autoHeightForWidth(state.customWidth, image, state)
      : state.customHeight
  )
  return width && height ? { width, height } : undefined
}

function cropPixelSize(image: ImageField, crop: CropRect | undefined) {
  if (!image.width || !image.height) return undefined
  const cropWidth = crop?.width ?? 100
  const cropHeight = crop?.height ?? 100
  return {
    width: Math.round((image.width * cropWidth) / 100),
    height: Math.round((image.height * cropHeight) / 100),
  }
}

function sizeLabel(size: CropSize | undefined): string {
  return size ? `${size.width}x${size.height}` : "-"
}

function pointFromContainClick({
  event,
  mediaWidth,
  mediaHeight,
}: {
  event: MouseEvent<HTMLButtonElement>
  mediaWidth?: number
  mediaHeight?: number
}): FocalPoint {
  const rect = event.currentTarget.getBoundingClientRect()
  let imageLeft = 0
  let imageTop = 0
  let imageWidth = rect.width
  let imageHeight = rect.height

  if (mediaWidth && mediaHeight) {
    const mediaRatio = mediaWidth / mediaHeight
    const boxRatio = rect.width / rect.height
    if (mediaRatio > boxRatio) {
      imageHeight = rect.width / mediaRatio
      imageTop = (rect.height - imageHeight) / 2
    } else {
      imageWidth = rect.height * mediaRatio
      imageLeft = (rect.width - imageWidth) / 2
    }
  }

  return {
    x: clampPercent(
      ((event.clientX - rect.left - imageLeft) / imageWidth) * 100
    ),
    y: clampPercent(
      ((event.clientY - rect.top - imageTop) / imageHeight) * 100
    ),
  }
}

export function FocalPointPicker({
  imageUrl,
  focal,
  onChange,
  mediaWidth,
  mediaHeight,
}: {
  imageUrl: string
  focal: FocalPoint
  onChange: (focal: FocalPoint) => void
  mediaWidth?: number
  mediaHeight?: number
}) {
  const t = useTranslations("editor.imageTransform")
  const normalized = normalizeFocalPoint(focal)

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1.5">
        <Crosshair className="size-3.5" />
        {t("focalPoint")}
      </Label>
      <button
        type="button"
        onClick={(event) =>
          onChange(pointFromContainClick({ event, mediaWidth, mediaHeight }))
        }
        className="relative h-28 w-full overflow-hidden rounded-md border bg-muted"
        title={t("setFocalPoint")}
      >
        <Image
          src={imageUrl}
          alt=""
          fill
          sizes="(max-width: 768px) 100vw, 480px"
          className="object-contain"
          draggable={false}
        />
        <span
          className="pointer-events-none absolute size-4 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-black/50 shadow"
          style={{ left: `${normalized.x}%`, top: `${normalized.y}%` }}
        />
      </button>
      <div className="grid grid-cols-2 gap-3">
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("xAxis")}
          <input
            type="range"
            min={0}
            max={100}
            value={normalized.x}
            onChange={(event) =>
              onChange({
                ...normalized,
                x: clampPercent(Number(event.target.value)),
              })
            }
            className="w-full"
          />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          {t("yAxis")}
          <input
            type="range"
            min={0}
            max={100}
            value={normalized.y}
            onChange={(event) =>
              onChange({
                ...normalized,
                y: clampPercent(Number(event.target.value)),
              })
            }
            className="w-full"
          />
        </label>
      </div>
    </div>
  )
}

export function ImageTransformEditorDialog({
  image,
  open,
  onOpenChange,
  onApply,
}: {
  image: ImageField | undefined
  open: boolean
  onOpenChange: (open: boolean) => void
  onApply: (image: ImageField) => void
}) {
  const t = useTranslations("editor.imageTransform")
  const [state, dispatch] = useReducer(editorReducer, emptyState)
  const aspectLabels: Record<AspectKey, string> = {
    original: t("aspects.original"),
    square: t("aspects.square"),
    landscape: t("aspects.landscape"),
    portrait: t("aspects.portrait"),
    wide: t("aspects.wide"),
    custom: t("aspects.custom"),
  }

  useEffect(() => {
    if (image) dispatch({ type: "load", image })
  }, [image])

  const imageUrl = image?.url
  if (!imageUrl) return null
  const currentImage = image

  const activeCrop = cleanArea(state.crop)
  const activeAspect = fixedAspectFor(currentImage, state)
  const selectionSize = cropPixelSize(currentImage, activeCrop)
  const outputSize = cropSizeFromState(currentImage, state) ?? selectionSize
  const showCustomDimensions = state.aspect === "custom"

  function cropForAspect(aspect: AspectKey, nextState: EditorState = state) {
    return fitCropToAspect(
      nextState.crop,
      currentImage,
      fixedAspectFor(currentImage, nextState, aspect)
    )
  }

  function handleAspectChange(value: AspectKey) {
    const nextState = { ...state, aspect: value }
    const crop = cropForAspect(value, nextState)
    dispatch({
      type: "setAspect",
      value,
      crop,
      customHeight:
        value === "custom" && state.autoHeight
          ? autoHeightForWidth(state.customWidth, currentImage, nextState, crop)
          : undefined,
    })
  }

  function handleCropChange(crop: PercentCrop) {
    const nextCrop = cleanPercentCrop(crop)
    dispatch({
      type: "setCrop",
      value: nextCrop,
      customHeight:
        state.aspect === "custom" && state.autoHeight
          ? autoHeightForWidth(state.customWidth, currentImage, state, nextCrop)
          : undefined,
    })
  }

  function handleWidthChange(value: string) {
    const nextState = {
      ...state,
      customWidth: value,
      aspect: "custom" as const,
    }
    const crop = cropForAspect("custom", nextState)
    dispatch({
      type: "setCustomWidth",
      value,
      crop,
      customHeight: state.autoHeight
        ? autoHeightForWidth(value, currentImage, nextState, crop)
        : undefined,
    })
  }

  function handleHeightChange(value: string) {
    const nextState = {
      ...state,
      aspect: "custom" as const,
      autoHeight: false,
      customHeight: value,
    }
    dispatch({
      type: "setCustomHeight",
      value,
      crop: cropForAspect("custom", nextState),
    })
  }

  function handleAutoHeightChange(checked: boolean) {
    const nextState = {
      ...state,
      aspect: "custom" as const,
      autoHeight: checked,
    }
    const crop = cropForAspect("custom", nextState)
    dispatch({
      type: "setAutoHeight",
      value: checked,
      crop,
      customHeight: checked
        ? autoHeightForWidth(state.customWidth, currentImage, nextState, crop)
        : undefined,
    })
  }

  function applyChanges() {
    const crop = cleanArea(state.crop)
    const nextCrop = crop && !isFullCrop(crop) ? crop : undefined
    const cropSize = cropSizeFromState(currentImage, state)

    onApply({
      ...currentImage,
      focal: normalizeFocalPoint(state.focal),
      crop: nextCrop,
      cropSize,
    })
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-5xl data-open:zoom-in-100 data-closed:zoom-out-100">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_18rem]">
          <div className="overflow-hidden rounded-md border bg-zinc-950">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-white">
              <div className="inline-flex items-center gap-2 text-sm font-medium">
                <Crop className="size-4" />
                {t("cropTool")}
              </div>
              <div className="flex flex-wrap items-center gap-2 text-[11px] text-zinc-300">
                <span className="rounded bg-white/10 px-2 py-1">
                  {t("selection", { size: sizeLabel(selectionSize) })}
                </span>
                <span className="rounded bg-white/10 px-2 py-1">
                  {t("output", { size: sizeLabel(outputSize) })}
                </span>
              </div>
            </div>
            <div className="flex h-[420px] items-center justify-center overflow-hidden bg-black p-3">
              <ReactCrop
                crop={state.crop}
                aspect={activeAspect}
                minWidth={24}
                minHeight={24}
                keepSelection
                ruleOfThirds
                className="media-image-cropper"
                onChange={(_, percentCrop) => handleCropChange(percentCrop)}
                ariaLabels={{
                  cropArea: t("cropArea"),
                  nwDragHandle: t("handles.topLeft"),
                  nDragHandle: t("handles.top"),
                  neDragHandle: t("handles.topRight"),
                  eDragHandle: t("handles.right"),
                  seDragHandle: t("handles.bottomRight"),
                  sDragHandle: t("handles.bottom"),
                  swDragHandle: t("handles.bottomLeft"),
                  wDragHandle: t("handles.left"),
                }}
              >
                {/* react-doctor-disable-next-line react-doctor/nextjs-no-img-element */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={imageUrl}
                  alt=""
                  className="max-h-[396px] max-w-full object-contain select-none"
                  draggable={false}
                />
              </ReactCrop>
            </div>
          </div>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label>{t("aspect")}</Label>
              <Select
                value={state.aspect}
                onValueChange={(value) =>
                  handleAspectChange(value as AspectKey)
                }
              >
                <SelectTrigger className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {ASPECT_KEYS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {aspectLabels[value]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {showCustomDimensions ? (
              <div className="space-y-2">
                <Label>{t("customDimensions")}</Label>
                <div className="grid grid-cols-2 gap-2">
                  <Input
                    inputMode="numeric"
                    value={state.customWidth}
                    onChange={(event) => handleWidthChange(event.target.value)}
                    placeholder={t("width")}
                    aria-label={t("customWidth")}
                  />
                  <Input
                    inputMode="numeric"
                    value={state.customHeight}
                    onChange={(event) => handleHeightChange(event.target.value)}
                    placeholder={t("height")}
                    aria-label={t("customHeight")}
                    disabled={state.autoHeight}
                    className={
                      state.autoHeight
                        ? "bg-muted text-muted-foreground"
                        : undefined
                    }
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={state.autoHeight}
                    onChange={(event) =>
                      handleAutoHeightChange(event.target.checked)
                    }
                    className="size-3.5 rounded border"
                  />
                  {t("autoHeight")}
                </label>
              </div>
            ) : null}

            <FocalPointPicker
              imageUrl={imageUrl}
              focal={state.focal}
              onChange={(value) => dispatch({ type: "setFocal", value })}
              mediaWidth={currentImage.width}
              mediaHeight={currentImage.height}
            />

            <div className="flex items-center justify-between gap-2 pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => dispatch({ type: "reset", image: currentImage })}
              >
                <RotateCcw className="size-4" />
                {t("reset")}
              </Button>
              <Button type="button" onClick={applyChanges}>
                <Save className="size-4" />
                {t("apply")}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

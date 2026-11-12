import type { ImageField } from "@/convex/lib/slices"

/** Finite numeric media adapter, not a general CSS serializer. */
export const IMAGE_PRESENTATION_VERSION = "v2"
export const MAX_IMAGE_DIMENSION = 100_000
export const MIN_CROP_PERCENT = 0.001
export type ImageFrame = "aspect" | "cover"

export interface ImagePresentation {
  intrinsic: { width: number; height: number } | null
  wrapped: boolean
  optimizedFill: boolean
  wrapperClass: string | undefined
  imageClass: string | undefined
  cropWindowClass: string | undefined
  css: string
  /** Invalid framing is omitted; the asset and meaningful alt remain visible. */
  fallback: boolean
}

function dimension(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= MAX_IMAGE_DIMENSION
  )
}

function percent(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
  )
}

/** Number.toString is round-trippable; substitutions are distinct and lossless. */
function key(value: number): string {
  return String(Object.is(value, -0) ? 0 : value)
    .replaceAll("-", "n")
    .replaceAll("+", "p")
    .replaceAll(".", "d")
}

export function imagePresentation(
  image: ImageField,
  fill: boolean,
  frame: ImageFrame = "aspect"
): ImagePresentation {
  const intrinsic =
    dimension(image.width) && dimension(image.height)
      ? { width: image.width, height: image.height }
      : null
  const validFocal =
    image.focal && percent(image.focal.x) && percent(image.focal.y)
      ? image.focal
      : null
  const validCrop =
    image.crop &&
    percent(image.crop.x) &&
    percent(image.crop.y) &&
    percent(image.crop.width) &&
    percent(image.crop.height) &&
    image.crop.width >= MIN_CROP_PERCENT &&
    image.crop.height >= MIN_CROP_PERCENT &&
    image.crop.x + image.crop.width <= 100 + 1e-9 &&
    image.crop.y + image.crop.height <= 100 + 1e-9
      ? image.crop
      : null
  const validSize =
    image.cropSize &&
    dimension(image.cropSize.width) &&
    dimension(image.cropSize.height)
      ? image.cropSize
      : null
  let fallback = Boolean(
    (image.crop && !validCrop) ||
    (image.cropSize && !validSize) ||
    (image.focal && !validFocal) ||
    ((image.width !== undefined || image.height !== undefined) && !intrinsic)
  )
  // Never attempt a partially valid framing recipe. Focal is independent.
  const malformedFraming = Boolean(
    (image.crop && !validCrop) || (image.cropSize && !validSize)
  )
  const crop = malformedFraming ? null : validCrop
  const cropSize = malformedFraming ? null : validSize
  let wrapped = Boolean(crop || cropSize)
  let width =
    cropSize?.width ??
    (intrinsic && crop
      ? Math.round((intrinsic.width * crop.width) / 100)
      : undefined)
  let height =
    cropSize?.height ??
    (intrinsic && crop
      ? Math.round((intrinsic.height * crop.height) / 100)
      : undefined)
  if (
    wrapped &&
    ((frame === "cover" && crop && !intrinsic) ||
      (!intrinsic && !cropSize && !fill) ||
      (width !== undefined && !dimension(width)) ||
      (height !== undefined && !dimension(height)))
  ) {
    wrapped = false
    width = height = undefined
    fallback = true
  }

  const prefix = `fcm-media-${IMAGE_PRESENTATION_VERSION}`
  let wrapperClass: string | undefined
  let imageClass: string | undefined
  let cropWindowClass: string | undefined
  let css = ""
  if (wrapped) {
    wrapperClass = `${prefix}-w-${frame === "cover" ? "cover" : fill ? "fill" : "sized"}-${width ?? "auto"}-${height ?? "auto"}`
    // Unlayered, doubled selectors give content crop precedence over ordinary
    // renderer utilities. Important owner utilities keep their normal authority.
    css += `.${wrapperClass}.${wrapperClass}{${frame === "cover" ? "width:100%;height:100%;container-type:size;" : width && height ? `${fill ? "" : `width:${width}px;max-width:100%;height:auto;`}aspect-ratio:${width} / ${height};` : "position:absolute;inset:0;"}}`
    if (frame === "cover" && crop && intrinsic) {
      // Use the selected source rectangle, not rounded output dimensions.
      // A single aspect-derived scale covers the unchanged renderer frame.
      const selectedWidth = (intrinsic.width * crop.width) / 100
      const selectedHeight = (intrinsic.height * crop.height) / 100
      cropWindowClass = `${prefix}-window-${key(selectedWidth)}-${key(selectedHeight)}`
      css += `.${cropWindowClass}.${cropWindowClass}{position:absolute;left:50%;top:50%;width:max(100cqw,calc(100cqh * ${selectedWidth} / ${selectedHeight}));height:auto;aspect-ratio:${selectedWidth} / ${selectedHeight};max-width:none;transform:translate(-50%,-50%);overflow:hidden;}`
    }
    if (crop) {
      const left = -(crop.x / crop.width) * 100
      const top = -(crop.y / crop.height) * 100
      const scaleWidth = 10000 / crop.width
      const scaleHeight = 10000 / crop.height
      imageClass = `${prefix}-c-${[left, top, scaleWidth, scaleHeight].map(key).join("-")}`
      css += `.${imageClass}.${imageClass}{position:absolute;left:${left}%;top:${top}%;width:${scaleWidth}%;height:${scaleHeight}%;max-width:none;}`
    } else {
      imageClass = `${prefix}-cover`
      css += `.${imageClass}.${imageClass}{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;}`
    }
  }
  if (validFocal && !(wrapped && crop)) {
    const focalClass = `${prefix}-f-${key(validFocal.x)}-${key(validFocal.y)}`
    css += `.${focalClass}.${focalClass}{object-position:${validFocal.x}% ${validFocal.y}%;}`
    imageClass = [imageClass, focalClass].filter(Boolean).join(" ")
  }
  return {
    intrinsic,
    wrapped,
    optimizedFill: !intrinsic && !wrapped && fill,
    wrapperClass,
    imageClass,
    cropWindowClass,
    css,
    fallback,
  }
}

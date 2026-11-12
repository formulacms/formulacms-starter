export type SlicePreviewView = "desktop" | "tablet" | "mobile"

export type SlicePreviewFrame = {
  width: number
  height: number
}

export const SLICE_PREVIEW_WIDTHS: Record<SlicePreviewView, number> = {
  desktop: 1280,
  tablet: 768,
  mobile: 390,
}

export const INITIAL_SLICE_PREVIEW_HEIGHT = 600

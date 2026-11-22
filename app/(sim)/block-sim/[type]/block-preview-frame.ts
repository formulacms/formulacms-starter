export type BlockPreviewView = "desktop" | "tablet" | "mobile"

export type BlockPreviewFrame = {
  width: number
  height: number
}

export const BLOCK_PREVIEW_WIDTHS: Record<BlockPreviewView, number> = {
  desktop: 1280,
  tablet: 768,
  mobile: 390,
}

export const INITIAL_BLOCK_PREVIEW_HEIGHT = 600

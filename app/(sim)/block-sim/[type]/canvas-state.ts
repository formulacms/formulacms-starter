export type CompareMode = "side" | "overlay" | "wipe" | "flip"
export type RegisteredCompareMode = Exclude<CompareMode, "side">

export interface LayerStyles {
  source: { opacity: number; clipPath?: string }
  render: { clipPath?: string }
}

const WIPE_MIN = 3
const WIPE_MAX = 97

/** Keep the wipe split inside the frame so neither layer is fully hidden. The
 *  clip-path and the divider line both read the bound from here, so the drawn
 *  marker can't drift from the cut it marks. */
export function clampWipePct(pct: number): number {
  return Math.min(WIPE_MAX, Math.max(WIPE_MIN, pct))
}

export function isModeAvailable(
  mode: CompareMode,
  aligned: boolean
): boolean {
  return mode === "side" || aligned
}

export function resolveCompareLayout(
  mode: CompareMode
): "side-by-side" | "registered-stack" {
  return mode === "side" ? "side-by-side" : "registered-stack"
}

export function resolveLayerStyles({
  mode,
  sourceOpacity,
  wipePct,
  flipHeld,
}: {
  mode: RegisteredCompareMode
  sourceOpacity: number
  wipePct: number
  flipHeld: boolean
}): LayerStyles {
  if (mode === "overlay") {
    return { source: { opacity: sourceOpacity }, render: {} }
  }
  if (mode === "wipe") {
    const pct = clampWipePct(wipePct)
    return {
      source: { opacity: 1, clipPath: `inset(0 ${100 - pct}% 0 0)` },
      render: {},
    }
  }
  return { source: { opacity: flipHeld ? 1 : 0 }, render: {} }
}

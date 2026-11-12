export type ScaleMode = "auto" | "half" | "one-to-one" | "double"

export interface CanvasScale {
  scale: number
  effective: "1:1" | "fit" | "50%" | "200%"
  clipped: boolean
}

/**
 * Keep the render at 1:1 whenever the canvas can show the full frame. Auto fits
 * only when 1:1 would clip; the explicit 1:1 mode remains reachable and reports
 * that clip honestly. A zero width means ResizeObserver has not measured yet.
 */
export function resolveCanvasScale({
  availableWidth,
  frameWidth,
  mode,
}: {
  availableWidth: number
  frameWidth: number
  mode: ScaleMode
}): CanvasScale {
  const measured = availableWidth > 0
  const fits = !measured || availableWidth >= frameWidth

  if (mode !== "auto") {
    const scale = mode === "half" ? 0.5 : mode === "double" ? 2 : 1
    return {
      scale,
      effective: mode === "half" ? "50%" : mode === "double" ? "200%" : "1:1",
      clipped: measured && availableWidth < frameWidth * scale,
    }
  }
  if (!fits) {
    return {
      scale: availableWidth / frameWidth,
      effective: "fit",
      clipped: false,
    }
  }
  return { scale: 1, effective: "1:1", clipped: false }
}

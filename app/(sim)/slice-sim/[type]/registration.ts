export interface Registration {
  scale: number
  offsetX: number
  offsetY: number
  aligned: boolean
}

export const UNALIGNED: Registration = {
  scale: 1,
  offsetX: 0,
  offsetY: 0,
  aligned: false,
}

const SCALE_MIN = 0.1
const SCALE_MAX = 4

/** A desktop alignment says nothing about the same reference at mobile width. */
export function registrationKey(type: string, view: SlicePreviewView): string {
  return `nextcms:slice-sim:registration:${type}:${view}`
}

export function applyRegistration(registration: Registration): {
  transform: string
  transformOrigin: string
} {
  return {
    transform: `translate(${registration.offsetX}px, ${registration.offsetY}px) scale(${registration.scale})`,
    transformOrigin: "top left",
  }
}

export function nudgeRegistration(
  current: Registration,
  patch: Partial<Registration>
): Registration {
  const next = { ...current, ...patch }
  if (patch.scale !== undefined) {
    next.scale = Math.min(SCALE_MAX, Math.max(SCALE_MIN, patch.scale))
  }
  const movedGeometry =
    patch.scale !== undefined ||
    patch.offsetX !== undefined ||
    patch.offsetY !== undefined
  if (movedGeometry && patch.aligned === undefined) next.aligned = false
  return next
}
import type { SlicePreviewView } from "./slice-preview-frame"

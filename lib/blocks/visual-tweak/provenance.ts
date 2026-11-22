import {
  axisUtilityRegExp,
  hasAxisUtility,
  type SpacingAxis,
} from "./map-target"
import { roleFromClassName } from "./capabilities"

export type AnchorState = "anchored" | "no-anchor" | "unknown"

export interface SpacingProvenance {
  state: AnchorState
  utility: string | null
  note: string
}

const UTILITY_SHAPE_RE =
  /(?:^|\s)(?:-?(?:p|px|py|pt|pr|pb|pl|m|mx|my|mt|mr|mb|ml|gap|gap-x|gap-y|space-x|space-y)-[\w.[\]/-]+|flex|grid|block|inline-flex|items-\w+|justify-\w+|text-\w+|bg-\w+)(?=\s|$)/

export function describeSpacingProvenance(
  className: string | undefined,
  axis: SpacingAxis
): SpacingProvenance {
  if (!className) {
    return {
      state: "unknown",
      utility: null,
      note: "Class list unavailable — cannot tell where this value is owned.",
    }
  }

  if (!UTILITY_SHAPE_RE.test(className)) {
    return {
      state: "no-anchor",
      utility: null,
      note: `No Tailwind anchor found on this element for ${axis}. An edit here could compete with styling defined elsewhere, so this control is unavailable.`,
    }
  }

  const utility = hasAxisUtility(className, axis)
    ? (className.match(axisUtilityRegExp(axis))?.[0] ?? null)
    : null
  return {
    state: "anchored",
    utility,
    note: utility
      ? `${axis} ← Tailwind utility \`${utility}\` on this element`
      : `${axis} is unset here — an edit adds the utility to this element`,
  }
}

export function describeTypographyProvenance(className: string | undefined): {
  role: string | null
  state: AnchorState
  note: string
} {
  if (!className) {
    return {
      role: null,
      state: "unknown",
      note: "Class list unavailable — cannot resolve a typography role.",
    }
  }
  const role = roleFromClassName(className ?? "")
  if (!role) {
    return {
      role: null,
      state: "no-anchor",
      note: "No design-system role token found on this element — typography is not editable here.",
    }
  }
  return {
    role,
    state: "anchored",
    note: `role token \`--text-${role}\` — edits apply site-wide to every ${role} element`,
  }
}

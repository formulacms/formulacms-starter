import { TYPOGRAPHY_ROLES } from "@/lib/slices/visual-tweak/capabilities"
import {
  shiftTypographyValue,
  typographyTokenName,
  type TypographyPreviewEdits,
  type TypographyProperty,
} from "@/lib/slices/visual-tweak/typography"

const properties: TypographyProperty[] = [
  "font-size",
  "line-height",
  "letter-spacing",
]

/** Match Tailwind's utility fallback semantics without touching content nodes. */
export function simulatorTypographyStyles(
  edits: TypographyPreviewEdits
): string {
  const variables: string[] = []
  const rules: string[] = []
  for (const role of TYPOGRAPHY_ROLES) {
    const declarations: string[] = []
    for (const property of properties) {
      const after = edits[role]?.[property]?.after
      if (
        !after ||
        !shiftTypographyValue({
          property,
          value: after,
          delta: 0,
          rootFontSizePx: 16,
        }).ok
      )
        continue
      const name = typographyTokenName(role, property)
      variables.push(`${name}:${after};`)
      const fallback = `var(${name})`
      const value =
        property === "letter-spacing"
          ? `var(--tw-tracking,${fallback})`
          : property === "line-height"
            ? `var(--tw-leading,${fallback})`
            : fallback
      declarations.push(`${property}:${value};`)
    }
    if (declarations.length)
      rules.push(`.text-${role}{${declarations.join("")}}`)
  }
  return rules.length
    ? `@layer utilities{:root{${variables.join("")}}${rules.join("")}}`
    : ""
}

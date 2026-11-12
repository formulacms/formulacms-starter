import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { buildDesignSystemInventory } from "@/lib/design-system/inventory"
import { TYPOGRAPHY_ROLES } from "@/lib/slices/visual-tweak/capabilities"
import {
  typographyTokenName,
  type TypographyTokenValues,
  type TypographyProperty,
} from "@/lib/slices/visual-tweak/typography"

/** Fixed public CSS input for the existing dev-only simulator server component. */
export async function readSimulatorTypography(): Promise<TypographyTokenValues> {
  return simulatorTypographyFromSource(
    await readFile(join(process.cwd(), "app/globals.css"), "utf8")
  )
}

/** Inventory owns declaration identity/context; this read path never writes. */
export function simulatorTypographyFromSource(
  source: string
): TypographyTokenValues {
  const inventory = buildDesignSystemInventory([
    { path: "app/globals.css", content: source },
  ])
  const values: TypographyTokenValues = {}
  for (const role of TYPOGRAPHY_ROLES) {
    const roleValues: Partial<Record<TypographyProperty, string>> = {}
    for (const property of [
      "font-size",
      "line-height",
      "letter-spacing",
    ] as const) {
      const name = typographyTokenName(role, property)
      const declarations = inventory.declarations.filter(
        (entry) => entry.name === name
      )
      if (
        declarations.length === 1 &&
        !declarations[0].ambiguous &&
        declarations[0].atRuleContext.length === 1 &&
        declarations[0].atRuleContext[0].name.toLowerCase() === "theme" &&
        declarations[0].atRuleContext[0].params.trim() === "inline" &&
        declarations[0].layerPath.length === 0 &&
        declarations[0].selectorPath.length === 0
      )
        roleValues[property] = declarations[0].value
    }
    values[role] = roleValues
  }
  return values
}

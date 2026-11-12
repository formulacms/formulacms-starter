import fs from "node:fs/promises"
import path from "node:path"

export type SetupBootstrapHandoff = {
  adminEmail?: string
  siteName?: string
  siteUrl?: string
  siteDescription?: string
  timezone?: string
  defaultLocale?: string
  enabledLocales?: string[]
  aiMode?: "skip" | "configure-later"
}

type BootstrapMetadata = {
  setupHandoff?: SetupBootstrapHandoff
}

export async function readSetupBootstrapHandoff(
  cwd = process.cwd()
): Promise<SetupBootstrapHandoff | null> {
  try {
    const raw = await fs.readFile(
      path.join(cwd, ".nextcms", "bootstrap.json"),
      "utf8"
    )
    const parsed = JSON.parse(raw) as BootstrapMetadata
    return normalizeHandoff(parsed.setupHandoff)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
    return null
  }
}

function normalizeHandoff(
  handoff: SetupBootstrapHandoff | undefined
): SetupBootstrapHandoff | null {
  if (!handoff || typeof handoff !== "object") return null
  const enabledLocales = Array.isArray(handoff.enabledLocales)
    ? handoff.enabledLocales.filter((locale) => typeof locale === "string")
    : undefined

  return {
    adminEmail: stringOrUndefined(handoff.adminEmail),
    siteName: stringOrUndefined(handoff.siteName),
    siteUrl: stringOrUndefined(handoff.siteUrl),
    siteDescription: stringOrUndefined(handoff.siteDescription),
    timezone: stringOrUndefined(handoff.timezone),
    defaultLocale: stringOrUndefined(handoff.defaultLocale),
    enabledLocales,
    aiMode:
      handoff.aiMode === "skip" || handoff.aiMode === "configure-later"
        ? handoff.aiMode
        : undefined,
  }
}

function stringOrUndefined(value: unknown) {
  return typeof value === "string" && value.trim() ? value : undefined
}

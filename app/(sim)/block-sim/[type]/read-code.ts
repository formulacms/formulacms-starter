"use server"

import { requireInstallationOwner } from "@/lib/owner-server"
import {
  readRegisteredBlockCode,
  type CodeTarget,
  type BlockCodeResult,
} from "@/lib/blocks/visual-tweak/read-code"

/** Source owner tooling only; source inspection adds no writer capability. */
export async function readBlockCodeAction(input: {
  type: string
  target?: CodeTarget | null
}): Promise<BlockCodeResult> {
  if (process.env.NODE_ENV === "production")
    return {
      ok: false,
      code: "local-only",
      error: "Code inspection is only available in local development.",
    }
  try {
    await requireInstallationOwner(
      "Only the installation owner can inspect Block source."
    )
  } catch {
    return {
      ok: false,
      code: "owner-required",
      error: "Only the installation owner can inspect Block source.",
    }
  }
  return readRegisteredBlockCode({
    root: process.cwd(),
    type: input?.type,
    target: input?.target,
  })
}

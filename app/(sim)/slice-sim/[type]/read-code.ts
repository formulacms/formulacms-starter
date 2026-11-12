"use server"

import { requireInstallationOwner } from "@/lib/owner-server"
import {
  readRegisteredSliceCode,
  type CodeTarget,
  type SliceCodeResult,
} from "@/lib/slices/visual-tweak/read-code"

/** Source owner tooling only; source inspection adds no writer capability. */
export async function readSliceCodeAction(input: {
  type: string
  target?: CodeTarget | null
}): Promise<SliceCodeResult> {
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
  return readRegisteredSliceCode({
    root: process.cwd(),
    type: input?.type,
    target: input?.target,
  })
}

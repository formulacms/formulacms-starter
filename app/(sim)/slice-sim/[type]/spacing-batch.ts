import type { ClassTweakOperation } from "@/lib/slices/visual-tweak/class-operations"

/** One element+axis spacing edit in a Save batch. */
export type SpacingBatchEdit = ClassTweakOperation

export type SpacingBatchRowResult = {
  id: string
  status: "applied" | "skipped"
  reason?: string
}

export function spacingBatchEditId(edit: SpacingBatchEdit): string {
  return JSON.stringify([edit.target, edit.scope, edit.group])
}

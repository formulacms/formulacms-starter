"use server"

import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { revalidatePath } from "next/cache"
import { requireInstallationOwner } from "@/lib/owner-server"
import { INSTALLED_SLICE_TYPES } from "@/convex/lib/slices"
import {
  applySpacingTweak,
  isSpacingAxis,
  isSpacingSuffix,
} from "@/lib/slices/visual-tweak/write"
import type {
  SpacingAxis,
  TypographyProperty,
} from "@/lib/slices/visual-tweak/write"
import {
  spacingBatchEditId,
  type SpacingBatchEdit,
  type SpacingBatchRowResult,
} from "./spacing-batch"

import {
  describeSpacingTweak,
  type VisualTweakDiff,
} from "@/lib/slices/visual-tweak/diff"
import {
  applyClassOperationFileBatch,
  undoClassOperationCheckpoint,
} from "@/lib/slices/visual-tweak/class-operation-files"
import type { ClassTweakDiff } from "@/lib/slices/visual-tweak/class-operations"

import { tweakTargetsForSource, type TweakTargetMetadata } from "./tweak-target"

async function freshTweakTargets(
  type: string,
  expectedHash: string
): Promise<TweakTargetMetadata[]> {
  const file = `components/slices/${type}.tsx`
  const source = await readFile(path.join(process.cwd(), file), "utf8")
  const targets = tweakTargetsForSource(source, file)
  return targets.every((target) => target.sourceHash === expectedHash)
    ? targets
    : []
}

function assertLocalRendererWrite(): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Renderer edits are only available in local development.")
  }
}

/*
 * The async verify/rollback machinery that used to live here belonged to the
 * site-wide token path only: a spacing tweak is a single utility swap that
 * cannot break `tsc`, so it never ran the gate. That path was retired in Plan
 * 033 Phase 2 (ADR-0046), and with it `scheduleRendererVerify` and the status
 * poll it fed — nothing wrote a status any more, so the poll could only ever
 * answer "unknown".
 */

/** A single contextual visual tweak the editor asks the server to persist.
 *  Spacing edits patch one utility on one element in the renderer `.tsx`.
 *  The typography variant is kept so a stale client still typechecks, but it is
 *  refused here: site-wide token edits moved to `/admin/design-system` in Plan
 *  033 Phase 2 (ADR-0046). */
export type VisualTweakInput =
  | {
      type: string
      kind: "spacing"
      path: string
      axis: SpacingAxis
      suffix: string
    }
  | {
      type: string
      kind: "typography"
      role: string
      property: TypographyProperty
      value: string
    }

export type ApplyVisualTweakResult =
  | {
      ok: true
      diff: VisualTweakDiff
      /** Repo-relative files the write touched (for the operator + git-diff). */
      files: string[]
      version: number
    }
  | { ok: false; error: string }

/**
 * Apply a contextual visual tweak surgically (ADR-0030, + the 2026-07-06
 * perf addendum).
 *
 * Reads the one renderer `.tsx`, computes the before/after diff, performs the
 * byte-level string edit, and writes it. Only spacing reaches this point —
 * site-wide token edits are refused and belong to `/admin/design-system`
 * (Plan 033 Phase 2, ADR-0046).
 *
 * **Spacing skips the heavy gate by design (ADR-0030 addendum):**
 * - A spacing tweak is a single Tailwind
 *   utility swap on an existing, hand-authored `className` literal (`py-section`
 *   → `py-16`): it is not code generation, cannot change the type surface, and
 *   cannot break `tsc` or `verify-slice`. The heavy gate (~27–45s of subprocess
 *   work) exists to catch broken *AI-generated whole renderers*; running it per
 *   nudge was the interactive-latency bug. Validation reduces to "the surgical
 *   edit produced a well-formed change" — `applySpacingTweak` already returns
 *   `null`/no-op when it can't locate or the class is dynamic, so a malformed
 *   target never reaches disk. This makes the write sub-100ms, so the editor can
 *   debounce it behind an instant in-iframe optimistic preview.
 *
 * Dev-only and slice-author-gated, like the other renderer writes here.
 */
export async function applyVisualTweakAction(
  input: VisualTweakInput
): Promise<ApplyVisualTweakResult> {
  try {
    assertLocalRendererWrite()
    await requireInstallationOwner(
      "Only the installation owner can edit block styling."
    )
    if (!(INSTALLED_SLICE_TYPES as string[]).includes(input.type)) {
      return { ok: false, error: `Unknown block type: ${input.type}` }
    }

    // Site-wide token edits left this action in Plan 033 Phase 2 (ADR-0046).
    // A stale client is refused and told where the work moved, rather than
    // served by a writer that cannot name what it would change.
    if (input.kind !== "spacing") {
      return {
        ok: false,
        error:
          "Text sizes and line heights are changed on the design-system page " +
          "now, where you can see what else moves and undo it. Open " +
          "/admin/design-system.",
      }
    }
    if (!isSpacingAxis(input.axis) || !isSpacingSuffix(input.suffix)) {
      return { ok: false, error: "Invalid spacing input." }
    }

    const target = {
      file: path.join("components", "slices", `${input.type}.tsx`),
    }
    const absolute = path.join(process.cwd(), target.file)
    const source = await readFile(absolute, "utf-8")

    const diff = describeSpacingTweak(
      source,
      target.file,
      input.path,
      input.axis,
      input.suffix
    )
    if (!diff) {
      return {
        ok: false,
        error:
          "No change to apply — the target couldn't be located, its className " +
          "is dynamic, or the value already matches.",
      }
    }

    const next = applySpacingTweak(source, input.path, input.axis, input.suffix)
    if (next === null || next === source) {
      return { ok: false, error: "No change to apply." }
    }

    await writeFile(absolute, next)
    // Spacing = surgical utility swap → skip verification (see docstring). The
    // site-wide token path that used to run an async typecheck + rollback here
    // is gone; `/admin/design-system` owns that work and its own recovery.

    revalidatePath(`/slice-sim/${input.type}`)
    revalidatePath(`/admin/slices/${input.type}`)
    return {
      ok: true,
      diff,
      files: [target.file],
      version: Date.now(),
    }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Could not apply visual tweak for ${input.type}`,
    }
  }
}

export type ApplySpacingBatchResult =
  | {
      ok: true
      applied: number
      skipped: number
      results: SpacingBatchRowResult[]
      files: string[]
      version: number
      checkpointId: string
      sourceHash: string
      targets: TweakTargetMetadata[]
      diffs: ClassTweakDiff[]
    }
  | {
      ok: false
      error: string
      code?: string
      results?: SpacingBatchRowResult[]
    }

/**
 * Persist a whole batch of spacing tweaks in **one** file write (ADR-0030 +
 * 2026-07-06 perf addendum). The editor accumulates nudges in client state and
 * only calls this on an explicit Save, so a session of edits triggers exactly
 * ONE dev recompile / Fast Refresh instead of one per nudge — the fix for the
 * per-press "Compiling…" stall.
 *
 * All spacing edits in a slice-sim session target the same renderer file
 * (`components/slices/<type>.tsx`), so we read it once, chain `applySpacingTweak`
 * over the accumulating source (each call re-resolves spans on fresh text, so
 * offset shifts from earlier edits don't matter), and write once. No gate: a
 * surgical utility swap can't break `tsc` (see `applyVisualTweakAction`), and
 * `applySpacingTweak` returns the source unchanged when an edit can't be located,
 * so a bad target is skipped rather than corrupting the file. Dev-only +
 * slice-author-gated like the other renderer writes.
 */
export async function applySpacingBatchAction({
  type,
  edits,
}: {
  type: string
  edits: SpacingBatchEdit[]
}): Promise<ApplySpacingBatchResult> {
  try {
    assertLocalRendererWrite()
    await requireInstallationOwner(
      "Only the installation owner can edit block styling."
    )
    if (!(INSTALLED_SLICE_TYPES as string[]).includes(type)) {
      return { ok: false, error: `Unknown block type: ${type}` }
    }
    if (edits.length === 0) return { ok: false, error: "No changes to save." }

    const applied = await applyClassOperationFileBatch({
      root: process.cwd(),
      type,
      operations: edits,
    })
    if (!applied.ok) {
      return {
        ok: false,
        code: applied.code,
        error: applied.error,
        results: edits.map((edit) => ({
          id: spacingBatchEditId(edit),
          status: "skipped" as const,
          reason: applied.error,
        })),
      }
    }
    revalidatePath(`/slice-sim/${type}`)
    revalidatePath(`/admin/slices/${type}`)
    return {
      ok: true,
      applied: applied.applied,
      skipped: 0,
      results: edits.map((edit) => ({
        id: spacingBatchEditId(edit),
        status: "applied" as const,
      })),
      files: [applied.file],
      version: Date.now(),
      checkpointId: applied.checkpointId,
      sourceHash: applied.sourceHash,
      targets: await freshTweakTargets(type, applied.sourceHash),
      diffs: applied.diffs,
    }
  } catch (error) {
    return {
      ok: false,
      error:
        error instanceof Error
          ? error.message
          : `Could not save spacing changes for ${type}`,
    }
  }
}

export type UndoSpacingBatchResult =
  | {
      ok: true
      files: string[]
      version: number
      sourceHash: string
      targets: TweakTargetMetadata[]
    }
  | { ok: false; error: string }

export async function undoSpacingBatchAction({
  type,
  checkpointId,
}: {
  type: string
  checkpointId: string
}): Promise<UndoSpacingBatchResult> {
  try {
    assertLocalRendererWrite()
    await requireInstallationOwner(
      "Only the installation owner can undo saved block styling."
    )
    if (!(INSTALLED_SLICE_TYPES as string[]).includes(type)) {
      return { ok: false, error: `Unknown block type: ${type}` }
    }
    const result = await undoClassOperationCheckpoint({
      root: process.cwd(),
      type,
      checkpointId,
    })
    if (!result.ok) return { ok: false, error: result.error }
    revalidatePath(`/slice-sim/${type}`)
    revalidatePath(`/admin/slices/${type}`)
    return {
      ok: true,
      files: [result.file],
      version: Date.now(),
      sourceHash: result.sourceHash,
      targets: await freshTweakTargets(type, result.sourceHash),
    }
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

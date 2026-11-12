import { createHash } from "node:crypto"
import { mergeTailwindClasses } from "@/lib/design-system/tw-merge"
import { lintRendererSourceText } from "@/lib/slices/authoring/renderer-source-lint"
import { isSpacingSuffix } from "./write"
import { SPACING_AXES, type SpacingAxis } from "./map-target"
import {
  enumerateTweakLocations,
  type TweakClassLiteral,
  type TweakLocationEntry,
} from "./tweak-loc-core.cjs"

export const TWEAK_SCOPES = ["all", "below-sm", "sm-and-up"] as const
export type TweakScope = (typeof TWEAK_SCOPES)[number]

export type ClassOperationGroup = `spacing:${SpacingAxis}`

export type ClassReplaceOperation = {
  kind: "class.replace"
  target: string
  tag: string
  scope: TweakScope
  group: ClassOperationGroup
  expected: string | null
  next: string
  sourceHash: string
  postcondition: { kind: "class-token"; value: string }
}

export type ClassRemoveOperation = {
  kind: "class.remove"
  target: string
  tag: string
  scope: TweakScope
  group: ClassOperationGroup
  expected: string
  sourceHash: string
  postcondition: { kind: "class-absent" }
}
export type ClassTweakOperation = ClassReplaceOperation | ClassRemoveOperation

export type ClassTweakDiff = {
  target: string
  tag: string
  scope: TweakScope
  group: ClassOperationGroup
  before: string
  after: string
}

export type ApplyClassOperationBatchResult =
  | {
      ok: true
      source: string
      applied: number
      diffs: ClassTweakDiff[]
    }
  | {
      ok: false
      code:
        | "invalid-operation"
        | "hash-mismatch"
        | "loc-stale"
        | "tag-mismatch"
        | "expected-mismatch"
        | "operation-conflict"
        | "overlapping-spans"
        | "renderer-lint"
        | "merge-conflict"
        | "postcondition-mismatch"
      error: string
      targets?: string[]
    }

export function hashTweakSource(source: string): string {
  return createHash("sha256").update(source).digest("hex")
}

function operationAxis(group: string): SpacingAxis | null {
  const match = /^spacing:(.+)$/.exec(group)
  if (!match) return null
  return (SPACING_AXES as readonly string[]).includes(match[1])
    ? (match[1] as SpacingAxis)
    : null
}

function scopePrefix(scope: TweakScope): string {
  if (scope === "below-sm") return "max-sm:"
  if (scope === "sm-and-up") return "sm:"
  return ""
}

function scopedAxisToken(
  token: string,
  scope: TweakScope,
  axis: SpacingAxis
): boolean {
  const prefix = scopePrefix(scope)
  if (typeof token !== "string" || !token.startsWith(prefix)) return false
  const utility = token.slice(prefix.length)
  const match = new RegExp(`^-?${axis}-(.+)$`).exec(utility)
  return Boolean(match && isSpacingSuffix(match[1]))
}

function validateOperation(
  operation: ClassTweakOperation
): ApplyClassOperationBatchResult | null {
  const axis = operationAxis(operation.group)
  if (
    !["class.replace", "class.remove"].includes(operation.kind) ||
    !axis ||
    !(TWEAK_SCOPES as readonly string[]).includes(operation.scope) ||
    // Component spellings are admitted only if source enumeration later finds
    // the exact imported, allowlisted kit host at this location.
    !/^(?:[a-z][a-z0-9-]*|[A-Z_$][\w$]*)$/.test(operation.tag) ||
    (operation.kind === "class.replace" &&
      !scopedAxisToken(operation.next, operation.scope, axis)) ||
    (operation.kind === "class.remove" &&
      ("next" in operation || typeof operation.expected !== "string")) ||
    (operation.expected !== null &&
      !scopedAxisToken(operation.expected, operation.scope, axis))
  ) {
    return failure(
      "invalid-operation",
      `Invalid class operation for ${operation.target}.`
    )
  }
  if (
    operation.kind === "class.replace"
      ? operation.postcondition.kind !== "class-token" ||
        operation.postcondition.value !== operation.next
      : operation.postcondition.kind !== "class-absent"
  ) {
    return failure(
      "postcondition-mismatch",
      `The postcondition does not match ${operation.kind}.`,
      [operation.target]
    )
  }
  return null
}

function failure(
  code: Extract<ApplyClassOperationBatchResult, { ok: false }>["code"],
  error: string,
  targets?: string[]
): Extract<ApplyClassOperationBatchResult, { ok: false }> {
  return { ok: false, code, error, ...(targets ? { targets } : {}) }
}

function operationKey(operation: ClassTweakOperation): string {
  return JSON.stringify([
    operation.target,
    operation.scope,
    operation.group,
    operation.kind,
    operation.kind === "class.replace" ? operation.next : null,
    operation.expected,
  ])
}

function conflictKey(operation: ClassTweakOperation): string {
  return JSON.stringify([operation.target, operation.scope, operation.group])
}

function tokens(value: string): string[] {
  return value.trim() ? value.trim().split(/\s+/) : []
}

function quoteLiteral(value: string, quote: string): string {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll(quote, `\\${quote}`)
  return `${quote}${escaped}${quote}`
}

function mergedIsClean(value: string): boolean {
  return mergeTailwindClasses(value) === value
}

type SpanPlan = {
  start: number
  end: number
  replacement: string
  diffs: ClassTweakDiff[]
}

function planLiteralSpan(
  source: string,
  entry: TweakLocationEntry,
  literal: TweakClassLiteral,
  operations: ClassTweakOperation[]
): SpanPlan | ApplyClassOperationBatchResult {
  let classTokens = tokens(literal.value)
  const before = literal.value
  const diffs: ClassTweakDiff[] = []

  for (const operation of operations) {
    const axis = operationAxis(operation.group)!
    const matching = classTokens.filter((token) =>
      scopedAxisToken(token, operation.scope, axis)
    )
    if (
      (operation.expected === null && matching.length !== 0) ||
      (operation.expected !== null &&
        (matching.length !== 1 || matching[0] !== operation.expected))
    ) {
      return failure(
        "expected-mismatch",
        `Expected ${operation.expected ?? "no matching utility"} at ${operation.target}.`,
        [operation.target]
      )
    }
    const insertAt =
      operation.expected === null
        ? classTokens.length
        : classTokens.indexOf(operation.expected)
    classTokens = classTokens.filter(
      (token) => !scopedAxisToken(token, operation.scope, axis)
    )
    if (operation.kind === "class.replace")
      classTokens.splice(
        Math.min(insertAt, classTokens.length),
        0,
        operation.next
      )
    diffs.push({
      target: operation.target,
      tag: operation.tag,
      scope: operation.scope,
      group: operation.group,
      before,
      after: classTokens.join(" "),
    })
  }

  const after = classTokens.join(" ")
  if (!mergedIsClean(after)) {
    return failure(
      "merge-conflict",
      `The final class list at ${entry.loc} contains conflicting utilities.`,
      [entry.loc]
    )
  }
  return { start: literal.start, end: literal.end, replacement: after, diffs }
}

function planCnSpan(
  source: string,
  entry: TweakLocationEntry,
  operations: ClassTweakOperation[]
): SpanPlan | ApplyClassOperationBatchResult {
  if (entry.className.kind !== "cn") {
    return failure(
      "loc-stale",
      `The className at ${entry.loc} is not editable.`
    )
  }
  const shape = entry.className
  const values = shape.literals.map((literal) => tokens(literal.value))
  const before = shape.literals.map((literal) => literal.value).join(" | ")
  const appended: string[] = []
  const diffs: ClassTweakDiff[] = []

  for (const operation of operations) {
    const axis = operationAxis(operation.group)!
    const matches: Array<{
      literalIndex: number
      tokenIndex: number
      token: string
    }> = []
    values.forEach((literalTokens, literalIndex) => {
      literalTokens.forEach((token, tokenIndex) => {
        if (scopedAxisToken(token, operation.scope, axis)) {
          matches.push({ literalIndex, tokenIndex, token })
        }
      })
    })
    if (operation.expected === null) {
      if (matches.length !== 0) {
        return failure(
          "expected-mismatch",
          `A matching utility already exists at ${entry.loc}.`
        )
      }
      if (operation.kind !== "class.replace")
        return failure(
          "expected-mismatch",
          `Removal requires an exact existing utility at ${entry.loc}.`
        )
      appended.push(operation.next)
    } else {
      if (matches.length !== 1 || matches[0].token !== operation.expected) {
        return failure(
          "expected-mismatch",
          `Expected ${operation.expected} at ${entry.loc}.`,
          [entry.loc]
        )
      }
      if (operation.kind === "class.remove")
        values[matches[0].literalIndex].splice(matches[0].tokenIndex, 1)
      else
        values[matches[0].literalIndex][matches[0].tokenIndex] = operation.next
    }
    diffs.push({
      target: operation.target,
      tag: operation.tag,
      scope: operation.scope,
      group: operation.group,
      before,
      after: "",
    })
  }

  // Reuse only an actual final direct argument, after all operations. Moving
  // the entire append batch preserves conditional precedence and avoids empty
  // cn argument growth across multi-axis undo/redo cycles.
  const last = shape.literals.at(-1)
  if (
    appended.length &&
    last &&
    values.at(-1)?.length === 0 &&
    source.slice(last.end + 1, shape.callClose).trim() === ""
  ) {
    values[values.length - 1].push(...appended)
    appended.length = 0
  }
  const combined = values.flat().concat(appended).join(" ")
  if (!mergedIsClean(combined)) {
    return failure(
      "merge-conflict",
      `The final cn() class list at ${entry.loc} contains conflicting utilities.`
    )
  }

  let replacement = source.slice(shape.attributeStart, shape.attributeEnd)
  // Append at the original call-close offset before replacing any existing
  // literals. Literal replacements can change length, which would otherwise
  // make the parser-derived close offset stale within this local string.
  if (appended.length > 0) {
    const close = shape.callClose - shape.attributeStart
    replacement =
      replacement.slice(0, close) +
      `${shape.literals.length > 0 ? ", " : ""}${quoteLiteral(appended.join(" "), '"')}` +
      replacement.slice(close)
  }
  const edits = shape.literals
    .map((literal, index) => ({
      start: literal.start - shape.attributeStart,
      end: literal.end - shape.attributeStart,
      value: values[index].join(" "),
    }))
    .sort((a, b) => b.start - a.start)
  for (const edit of edits) {
    replacement =
      replacement.slice(0, edit.start) +
      edit.value +
      replacement.slice(edit.end)
  }
  const after = values
    .map((value) => value.join(" "))
    .concat(appended.length > 0 ? [appended.join(" ")] : [])
    .join(" | ")
  for (const diff of diffs) diff.after = after
  return {
    start: shape.attributeStart,
    end: shape.attributeEnd,
    replacement,
    diffs,
  }
}

function planEntrySpan(
  source: string,
  entry: TweakLocationEntry,
  operations: ClassTweakOperation[]
): SpanPlan | ApplyClassOperationBatchResult {
  if (entry.className.kind === "literal") {
    return planLiteralSpan(source, entry, entry.className.literal, operations)
  }
  if (entry.className.kind === "cn") {
    return planCnSpan(source, entry, operations)
  }
  if (entry.className.kind === "none") {
    if (operations.some((operation) => operation.expected !== null)) {
      return failure(
        "expected-mismatch",
        `Expected a class utility at ${entry.loc}.`
      )
    }
    const className = operations
      .filter(
        (operation): operation is ClassReplaceOperation =>
          operation.kind === "class.replace"
      )
      .map((operation) => operation.next)
      .join(" ")
    if (!mergedIsClean(className)) {
      return failure(
        "merge-conflict",
        `The inserted class list at ${entry.loc} is not merge-clean.`
      )
    }
    return {
      start: entry.insertAttributeAt,
      end: entry.insertAttributeAt,
      replacement: ` className=${quoteLiteral(className, '"')}`,
      diffs: operations.map((operation) => ({
        target: operation.target,
        tag: operation.tag,
        scope: operation.scope,
        group: operation.group,
        before: "",
        after: className,
      })),
    }
  }
  return failure(
    "loc-stale",
    `The className at ${entry.loc} is not a safe literal.`
  )
}

function entryTokens(entry: TweakLocationEntry): string[] {
  if (entry.className.kind === "literal")
    return tokens(entry.className.literal.value)
  if (entry.className.kind === "cn") {
    return entry.className.literals.flatMap((literal) => tokens(literal.value))
  }
  return []
}

export function applyClassOperationBatch({
  source,
  file,
  operations,
}: {
  source: string
  file: string
  operations: ClassTweakOperation[]
}): ApplyClassOperationBatchResult {
  if (operations.length === 0) {
    return failure("invalid-operation", "No class operations were provided.")
  }
  for (const operation of operations) {
    const invalid = validateOperation(operation)
    if (invalid) return invalid
  }
  const sourceHash = hashTweakSource(source)
  if (operations.some((operation) => operation.sourceHash !== sourceHash)) {
    return failure(
      "hash-mismatch",
      "The renderer changed after this tweak was prepared."
    )
  }

  const unique = [
    ...new Map(operations.map((op) => [operationKey(op), op])).values(),
  ]
  const conflicts = new Map<string, ClassTweakOperation>()
  for (const operation of unique) {
    const key = conflictKey(operation)
    const previous = conflicts.get(key)
    if (previous && operationKey(previous) !== operationKey(operation)) {
      return failure(
        "operation-conflict",
        `Conflicting values target ${operation.group} at ${operation.target}.`,
        [previous.target, operation.target]
      )
    }
    conflicts.set(key, operation)
  }

  const entries = new Map(
    enumerateTweakLocations(source, file).map((entry) => [entry.loc, entry])
  )
  const byEntry = new Map<TweakLocationEntry, ClassTweakOperation[]>()
  for (const operation of unique) {
    const entry = entries.get(operation.target)
    if (!entry)
      return failure(
        "loc-stale",
        `No JSX host element exists at ${operation.target}.`
      )
    if (entry.tag !== operation.tag) {
      return failure(
        "tag-mismatch",
        `Expected <${operation.tag}> at ${operation.target}, found <${entry.tag}>.`,
        [operation.target]
      )
    }
    byEntry.set(entry, [...(byEntry.get(entry) ?? []), operation])
  }

  const plans: SpanPlan[] = []
  for (const [entry, entryOperations] of byEntry) {
    const plan = planEntrySpan(source, entry, entryOperations)
    if ("ok" in plan) return plan
    plans.push(plan)
  }
  const ordered = plans.sort((a, b) => b.start - a.start)
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1].start < ordered[index].end) {
      return failure("overlapping-spans", "Two className output spans overlap.")
    }
  }
  let candidate = source
  for (const plan of ordered) {
    candidate =
      candidate.slice(0, plan.start) +
      plan.replacement +
      candidate.slice(plan.end)
  }

  // A class-only edit must not introduce a renderer-lint regression. Some
  // established renderers predate newer lint rules, so compare against the
  // source baseline instead of making an unrelated legacy issue block every
  // visual tweak forever.
  const beforeLint = lintRendererSourceText(source)
  const lint = lintRendererSourceText(candidate)
  const introducedFailures = lint.failures.filter(
    (message) => !beforeLint.failures.includes(message)
  )
  if (introducedFailures.length > 0) {
    return failure("renderer-lint", introducedFailures.join("\n"))
  }
  const originalEntries = [...entries.values()]
  const parsedEntries = enumerateTweakLocations(candidate, file)
  if (originalEntries.length !== parsedEntries.length)
    return failure(
      "postcondition-mismatch",
      "Class edits changed the JSX host inventory."
    )
  // Class edits preserve JSX traversal paths; columns do not survive a
  // same-line replacement. Bind postconditions by the unchanged host path.
  const reparsed = new Map(
    originalEntries.map((entry, index) => [entry.loc, parsedEntries[index]])
  )
  for (const [original, entryOperations] of byEntry) {
    const entry = reparsed.get(original.loc)
    if (!entry || entry.tag !== original.tag)
      return failure("postcondition-mismatch", "The target host changed.")
    const untouched = (token: string) =>
      !entryOperations.some((operation) =>
        scopedAxisToken(token, operation.scope, operationAxis(operation.group)!)
      )
    if (
      JSON.stringify(entryTokens(original).filter(untouched)) !==
      JSON.stringify(entryTokens(entry).filter(untouched))
    )
      return failure(
        "postcondition-mismatch",
        "Unrelated class tokens changed order.",
        [original.loc]
      )
    for (const operation of entryOperations) {
      const matching = entryTokens(entry).filter((token) =>
        scopedAxisToken(token, operation.scope, operationAxis(operation.group)!)
      )
      if (
        operation.kind === "class.remove"
          ? matching.length !== 0
          : matching.length !== 1 || matching[0] !== operation.next
      ) {
        return failure(
          "postcondition-mismatch",
          `The saved candidate does not satisfy ${operation.postcondition.kind}.`,
          [operation.target]
        )
      }
    }
  }
  return {
    ok: true,
    source: candidate,
    applied: unique.length,
    diffs: plans.flatMap((plan) => plan.diffs),
  }
}

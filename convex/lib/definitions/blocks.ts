import type { GenericValidator } from "convex/values"
import {
  describe,
  repeated,
  type DefinitionProblem,
  type DefinitionRule,
} from "./common"

/**
 * Block definition check. It must not import the storage-field leaf: the block
 * registry loads it, and block code stays independent of the page row.
 */

export type BlockManifestEntry = { type: string }

type BlockDefinitionInput = {
  readonly type: string
  readonly validator: {
    readonly fields: Readonly<Record<string, GenericValidator>>
  }
}

export function blockDefinitionProblems(input: {
  definitions: Readonly<Record<string, BlockDefinitionInput>>
  entries?: readonly BlockManifestEntry[]
}): DefinitionProblem[] {
  const problems: DefinitionProblem[] = []
  const add = (
    type: string,
    field: string | undefined,
    rule: DefinitionRule,
    detail: string
  ) => problems.push(describe("block", type, field, rule, detail))

  const types: string[] = []
  for (const [key, def] of Object.entries(input.definitions)) {
    types.push(def.type)
    if (def.type !== key) {
      add(
        key,
        undefined,
        "key-mismatch",
        `the registry key is "${key}" but the descriptor type is "${def.type}"; make them the same word.`
      )
    }
    const literal = def.validator.fields.type as
      | (GenericValidator & { value?: unknown })
      | undefined
    if (literal?.kind !== "literal" || literal.value !== key) {
      add(
        key,
        "type",
        "key-mismatch",
        `the validator's "type" field must be v.literal("${key}"); fix the literal.`
      )
    }
    if (Object.hasOwn(def.validator.fields, "presentationIdV1")) {
      add(
        key,
        "presentationIdV1",
        "reserved-field",
        'the block occurrence already stores "presentationIdV1" for the chosen presentation; rename the field.'
      )
    }
  }
  for (const type of repeated(types)) {
    add(
      type,
      undefined,
      "duplicate-type",
      `two descriptors use the type "${type}"; give each block its own type.`
    )
  }
  if (input.entries) {
    for (const type of repeated(input.entries.map((entry) => entry.type))) {
      add(
        type,
        undefined,
        "duplicate-type",
        `the manifest lists "${type}" more than once; remove the extra row.`
      )
    }
  }
  return problems
}


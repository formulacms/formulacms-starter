import {
  PROFILE_SPECS,
  type ProfileSpec,
  type RichTextProfile,
} from "./profiles"

export type FieldContract = "title" | RichTextProfile
export type HeadingRole = "sliceTitle" | "itemTitle"

export interface FieldAddress {
  sliceType: string
  fieldPath: string
}

export type RichTextContractConfig = {
  contract?: FieldContract
  /** Compatibility alias for the three pre-existing profiles. */
  profile?: RichTextProfile
  heading?: { role: HeadingRole; parent?: string }
  headingFloor?: { parent: string }
}

export interface ResolvedFieldContract {
  contract: FieldContract
  profile?: RichTextProfile
  headingRole: HeadingRole
  headingDefaultLevel: 2 | 3
  parent?: string
  headingFloorParent?: string
  spec: ProfileSpec
}

const TITLE_MARKS = [
  "bold",
  "italic",
  "strike",
  "underline",
  "highlight",
  "subscript",
  "superscript",
] as const

const TITLE_SPEC: ProfileSpec = {
  nodes: new Set(["doc", "heading", "text"]),
  marks: new Set(TITLE_MARKS),
  headingLevels: new Set([1, 2, 3, 4, 5, 6]),
}

export function contractSpec(contract: FieldContract): ProfileSpec {
  return contract === "title" ? TITLE_SPEC : PROFILE_SPECS[contract]
}

export function resolveFieldContract(
  value: FieldContract | RichTextContractConfig
): ResolvedFieldContract {
  const config = typeof value === "string" ? { contract: value } : value
  if (config.contract && config.profile && config.contract !== config.profile) {
    throw new Error(
      `Rich-text contract "${config.contract}" conflicts with profile "${config.profile}"`
    )
  }
  const contract = config.contract ?? config.profile
  if (!contract) {
    throw new Error("Rich-text fields require a contract or legacy profile")
  }
  if (config.heading && contract !== "title") {
    throw new Error("Heading role configuration is only valid for title fields")
  }
  const headingRole = config.heading?.role ?? "sliceTitle"
  return {
    contract,
    profile: contract === "title" ? undefined : contract,
    headingRole,
    headingDefaultLevel: headingRole === "itemTitle" ? 3 : 2,
    parent: config.heading?.parent,
    headingFloorParent: config.headingFloor?.parent,
    spec: contractSpec(contract),
  }
}

export function normalizeFieldPath(fieldPath: string): string {
  return fieldPath
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter((segment) => !/^\d+$/.test(segment))
    .join(".")
}

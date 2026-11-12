import { extractJsonObjectCandidates, extractSliceSpecJson } from "./contracts"
import {
  INSTALLED_SLICE_TYPES,
  type InstalledSliceType,
} from "@/convex/lib/slices"

const SLICE_TYPE_SET = new Set<string>(INSTALLED_SLICE_TYPES)

export type SectionTriage =
  | { decision: "reuse"; type: InstalledSliceType }
  | {
      decision: "new-presentation"
      type: InstalledSliceType
      contractSha256: string
    }
  | { decision: "new-sibling"; family: string }
  | { decision: "new-slice" }
  | { decision: "app-shell" }

export interface SectionBrief {
  slug: string
  purpose: string
  /** Position in the page from top to bottom. */
  order: number
  triage: SectionTriage
}

export type AuthorResult =
  | { kind: "single-slice"; specJson: string }
  | { kind: "decomposition"; sections: SectionBrief[] }

/** Supplied by a trusted server/CLI catalog read, never by generated output.
 * Matching a digest binds classification input; it does not prove compatible
 * presentation semantics or authorize candidate/source acceptance. */
export type PresentationTriageContext = {
  installedTypes: readonly string[]
  contractDigests: Readonly<Record<string, string>>
}

const CONTRACT_SHA256 = /^sha256:[a-f0-9]{64}$/

function isContractDigest(value: unknown): value is string {
  return typeof value === "string" && CONTRACT_SHA256.exec(value)?.[0] === value
}

export function formatPresentationTriageContext(
  context: PresentationTriageContext
): string {
  const references = context.installedTypes.map((type) => {
    const digest = context.contractDigests[type]
    if (
      !Object.hasOwn(context.contractDigests, type) ||
      !isContractDigest(digest)
    )
      throw new Error(
        "Presentation triage needs a current registered contract."
      )
    return `- ${type}: ${digest}`
  })
  return [
    "## Registered presentation contract references",
    "Copy the exact reference for a new-presentation classification. A matching reference is input identity, not compatibility approval.",
    ...references,
  ].join("\n")
}

function onlyKeys(value: object, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key))
}

function onlyClassificationTriageKeys(value: unknown): boolean {
  if (typeof value !== "object" || value === null) return false
  const decision = (value as { decision?: unknown }).decision
  const keys =
    decision === "new-presentation"
      ? ["decision", "type", "contractSha256"]
      : decision === "reuse"
        ? ["decision", "type"]
        : decision === "new-sibling"
          ? ["decision", "family"]
          : ["decision"]
  return onlyKeys(value, keys)
}

function containsPresentationDecision(value: unknown): boolean {
  const pending = [value]
  while (pending.length) {
    const current = pending.pop()
    if (typeof current !== "object" || current === null) continue
    if ((current as { decision?: unknown }).decision === "new-presentation")
      return true
    pending.push(...Object.values(current))
  }
  return false
}

function hasPresentationAttempt(text: string): boolean {
  let found = false
  for (const candidate of extractJsonObjectCandidates(text)) {
    if (!candidate.valid) {
      if (
        /^\{\s*(?:"|[\w$]+\s*:)/.test(candidate.raw) ||
        /^\[\s*(?:["{\[\d-]|true\b|false\b|null\b)/.test(candidate.raw)
      ) {
        throw new Error("Phase 1 returned a malformed JSON proposal block.")
      }
      continue
    }
    const pending = [candidate.value]
    while (pending.length) {
      const current = pending.pop()
      if (typeof current !== "object" || current === null) continue
      const record = current as {
        decision?: unknown
        triage?: unknown
        sections?: unknown
      }
      if (
        (record.decision === "new-presentation" &&
          (Object.hasOwn(current, "type") ||
            Object.hasOwn(current, "contractSha256"))) ||
        (Object.hasOwn(current, "triage") &&
          containsPresentationDecision(record.triage)) ||
        (Object.hasOwn(current, "sections") &&
          containsPresentationDecision(record.sections))
      )
        found = true
      pending.push(...Object.values(current))
    }
  }
  return found
}

function isSectionBrief(
  value: unknown
): value is Pick<SectionBrief, "slug" | "purpose"> {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { slug?: unknown; purpose?: unknown }
  return (
    typeof candidate.slug === "string" &&
    candidate.slug.trim().length > 0 &&
    typeof candidate.purpose === "string" &&
    candidate.purpose.trim().length > 0
  )
}

function parseTriage(
  value: unknown,
  slug: string,
  context?: PresentationTriageContext
): SectionTriage {
  if (typeof value !== "object" || value === null) {
    throw new Error(`Section "${slug}" is missing a triage decision.`)
  }
  const triage = value as {
    decision?: unknown
    type?: unknown
    family?: unknown
    contractSha256?: unknown
  }
  if (triage.decision === "reuse") {
    if (typeof triage.type !== "string" || !SLICE_TYPE_SET.has(triage.type)) {
      throw new Error(
        `Unknown slice type "${String(triage.type)}" in reuse verdict.`
      )
    }
    return { decision: "reuse", type: triage.type as InstalledSliceType }
  }
  if (triage.decision === "new-presentation") {
    if (
      typeof triage.type !== "string" ||
      !SLICE_TYPE_SET.has(triage.type) ||
      !context?.installedTypes.includes(triage.type)
    ) {
      throw new Error(
        `Section "${slug}" needs a current registered presentation target.`
      )
    }
    if (
      !onlyKeys(value, ["decision", "type", "contractSha256"]) ||
      !isContractDigest(triage.contractSha256) ||
      !Object.hasOwn(context.contractDigests, triage.type) ||
      context.contractDigests[triage.type] !== triage.contractSha256
    ) {
      throw new Error(
        `Section "${slug}" has a stale or invalid presentation contract reference; model changes require a new Slice Type.`
      )
    }
    return {
      decision: "new-presentation",
      type: triage.type as InstalledSliceType,
      contractSha256: triage.contractSha256,
    }
  }
  if (triage.decision === "new-sibling") {
    if (typeof triage.family !== "string" || !triage.family.trim()) {
      throw new Error(`Section "${slug}" needs a non-empty sibling family.`)
    }
    return { decision: "new-sibling", family: triage.family.trim() }
  }
  if (triage.decision === "new-slice" || triage.decision === "app-shell") {
    return { decision: triage.decision }
  }
  throw new Error(`Section "${slug}" has an invalid triage decision.`)
}

function extractSections(
  text: string,
  context?: PresentationTriageContext
): SectionBrief[] | null {
  let found: SectionBrief[] | null = null
  const fences = [...text.matchAll(/```([^\r\n]*)\r?\n([\s\S]*?)```/g)]
  for (const match of fences) {
    if (!/^(?:json|jsonc)?[ \t]*$/.test(match[1])) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(match[2].trim())
    } catch {
      if (/"sections"\s*:/.test(match[2])) {
        throw new Error("Phase 1 returned a malformed sections decomposition.")
      }
      continue
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Object.hasOwn(parsed, "sections")
    )
      continue
    const envelope = parsed as { sections: unknown }
    if (
      !Array.isArray(envelope.sections) ||
      envelope.sections.length === 0 ||
      !envelope.sections.every(isSectionBrief)
    ) {
      throw new Error("Phase 1 returned a malformed sections decomposition.")
    }
    if (found) throw new Error("Phase 1 returned more than one decomposition.")
    found = envelope.sections.map((section, order) => {
      const triage = parseTriage(
        (section as { triage?: unknown }).triage,
        section.slug.trim(),
        context
      )
      if (
        triage.decision === "new-presentation" &&
        (!onlyKeys(section, ["slug", "purpose", "triage"]) ||
          !onlyKeys(envelope, ["sections"]))
      ) {
        throw new Error(
          `Section "${section.slug}" cannot add content-model or source payloads to a presentation classification.`
        )
      }
      return {
        slug: section.slug.trim(),
        purpose: section.purpose.trim(),
        order,
        triage,
      }
    })
    if (
      found.some((section) => section.triage.decision === "new-presentation")
    ) {
      // Classification carries no generated content/source. Requiring its sole
      // envelope also refuses unlabelled code and payloads outside JSON fences.
      if (
        fences.length !== 1 ||
        text.trim() !== match[0].trim() ||
        envelope.sections.some(
          (section) =>
            !onlyKeys(section, ["slug", "purpose", "triage"]) ||
            !onlyClassificationTriageKeys(
              (section as { triage?: unknown }).triage
            )
        )
      ) {
        throw new Error(
          "Presentation classification cannot include extra generated payloads."
        )
      }
    }
  }
  return found
}

export function extractAuthorResult(
  text: string,
  context?: PresentationTriageContext
): AuthorResult | null {
  const specJson = extractSliceSpecJson(text)
  const sections = extractSections(text, context)
  if (
    hasPresentationAttempt(text) &&
    !sections?.some((section) => section.triage.decision === "new-presentation")
  ) {
    throw new Error(
      "Presentation classification needs its sole valid JSON envelope."
    )
  }
  if (specJson && sections) {
    throw new Error(
      "Phase 1 returned both supported outcomes; expected exactly one."
    )
  }
  if (specJson) return { kind: "single-slice", specJson }
  return sections ? { kind: "decomposition", sections } : null
}

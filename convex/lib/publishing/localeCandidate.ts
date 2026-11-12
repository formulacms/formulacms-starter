import { ConvexError } from "convex/values"
import type { Doc, Id } from "../../_generated/dataModel"
import { contentTypeDefs } from "../contentTypes"

export const LOCALE_PUBLICATION_CANDIDATE_FORMAT_VERSION = 1
export const MAX_LOCALE_PUBLICATION_CANDIDATE_BYTES = 512 * 1024

export type LocalePublicationAncestryItem = {
  pageId: string
  snapshotId: string
  publicGeneration: number
  title: string
  canonicalPath: string
}

export type LocalePublicationCandidatePayload = {
  page: {
    id: string
    pageType: Doc<"pages">["pageType"]
  }
  locale: string
  localized: {
    slug: string
    content: Record<string, unknown>
  }
  shared: {
    system: Record<string, unknown>
    descriptor: Record<string, unknown>
  }
  route:
    | {
        kind: "routable"
        canonicalPath: string
        ancestry: LocalePublicationAncestryItem[]
      }
    | { kind: "non_routable" }
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonicalize(child)])
  )
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value))
}

export function serializeLocalePublicationCandidate(
  payload: LocalePublicationCandidatePayload
): { payloadJson: string; payloadBytes: number } {
  const payloadJson = canonicalJson(payload)
  const payloadBytes = new TextEncoder().encode(payloadJson).byteLength
  if (payloadBytes > MAX_LOCALE_PUBLICATION_CANDIDATE_BYTES) {
    throw new ConvexError("PUBLISHED_SNAPSHOT_PAYLOAD_TOO_LARGE")
  }
  return { payloadJson, payloadBytes }
}

export async function digestLocalePublicationCandidate(
  payloadJson: string
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payloadJson)
  )
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function hasExactKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  )
}

function parsePayload(value: unknown): LocalePublicationCandidatePayload | null {
  if (!isRecord(value) || !hasExactKeys(value, ["page", "locale", "localized", "shared", "route"])) {
    return null
  }
  const { page, locale, localized, shared, route } = value
  if (
    !isRecord(page) ||
    !hasExactKeys(page, ["id", "pageType"]) ||
    typeof page.id !== "string" ||
    typeof page.pageType !== "string" ||
    !(page.pageType in contentTypeDefs) ||
    typeof locale !== "string" ||
    !isRecord(localized) ||
    !hasExactKeys(localized, ["slug", "content"]) ||
    typeof localized.slug !== "string" ||
    !isRecord(localized.content) ||
    !isRecord(shared) ||
    !hasExactKeys(shared, ["system", "descriptor"]) ||
    !isRecord(shared.system) ||
    !isRecord(shared.descriptor) ||
    !isRecord(route) ||
    typeof route.kind !== "string"
  ) {
    return null
  }
  if (route.kind === "non_routable") {
    if (!hasExactKeys(route, ["kind"])) return null
  } else if (route.kind === "routable") {
    if (
      !hasExactKeys(route, ["kind", "canonicalPath", "ancestry"]) ||
      typeof route.canonicalPath !== "string" ||
      !Array.isArray(route.ancestry)
    ) {
      return null
    }
    for (const item of route.ancestry) {
      if (
        !isRecord(item) ||
        !hasExactKeys(item, [
          "pageId",
          "snapshotId",
          "publicGeneration",
          "title",
          "canonicalPath",
        ]) ||
        typeof item.pageId !== "string" ||
        typeof item.snapshotId !== "string" ||
        typeof item.publicGeneration !== "number" ||
        !Number.isSafeInteger(item.publicGeneration) ||
        item.publicGeneration < 1 ||
        typeof item.title !== "string" ||
        typeof item.canonicalPath !== "string"
      ) {
        return null
      }
    }
  } else {
    return null
  }
  return value as LocalePublicationCandidatePayload
}

export async function reconstructLocalePublicationCandidate(
  candidate: Pick<
    Doc<"pageLocalePublicationCandidates">,
    "formatVersion" | "payloadJson" | "payloadBytes" | "digest"
  >
): Promise<LocalePublicationCandidatePayload | null> {
  if (
    candidate.formatVersion !== LOCALE_PUBLICATION_CANDIDATE_FORMAT_VERSION ||
    new TextEncoder().encode(candidate.payloadJson).byteLength !== candidate.payloadBytes ||
    candidate.payloadBytes > MAX_LOCALE_PUBLICATION_CANDIDATE_BYTES ||
    (await digestLocalePublicationCandidate(candidate.payloadJson)) !== candidate.digest
  ) {
    return null
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(candidate.payloadJson)
  } catch {
    return null
  }
  const payload = parsePayload(parsed)
  if (!payload) return null
  const canonical = serializeLocalePublicationCandidate(payload)
  return canonical.payloadJson === candidate.payloadJson &&
    canonical.payloadBytes === candidate.payloadBytes
    ? payload
    : null
}

export function payloadPageId(
  payload: LocalePublicationCandidatePayload
): Id<"pages"> {
  return payload.page.id as Id<"pages">
}

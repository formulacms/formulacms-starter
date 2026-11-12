import { v, type Infer } from "convex/values"

// M05 disclosure items and the digest seam (contract
// `siteLanguageDisclosurePages`, named residual 1). This module is the only
// owner of the digest encoding; every producer and verifier calls it.
//
// Frozen encoding, version 1:
// - `H` is SHA-256, rendered `sha256:<hex>` like publication candidates.
// - The page digest hashes the domain tag, then one list frame of
//   `[previousDigest, subjectId, generation, ordinal, section, items]`.
// - Every value is tag-framed and length-prefixed, so no two distinct inputs
//   share bytes through concatenation: string `S` + u32 byte length + UTF-8;
//   integer `N` + u32 length + decimal ASCII; absent optional `A`; `true` `T`;
//   list `L` + u32 count + elements.
// - An item encodes its arm's fields in declaration order, whatever the
//   object's property order; an absent optional field encodes as `A`.
// - The empty chain starts from `DISCLOSURE_CHAIN_EMPTY_DIGEST`.
// Changing any of these is a new version and invalidates stored receipts.

export const DISCLOSURE_DIGEST_DOMAIN = "formulacms/m05/disclosure-page/v1"

/** SHA-256 of "formulacms/m05/disclosure-chain/v1/empty"; proven in tests. */
export const DISCLOSURE_CHAIN_EMPTY_DIGEST =
  "sha256:7d659ee0ba91b96c1e10acccabc5da64fb858b168a7c71cf089e4f4bde746505"

const KIB = 1024

/** Declared per-field maxima in encoded UTF-8 bytes (Worker transaction ceilings). */
export const DISCLOSURE_FIELD_MAX_BYTES = {
  path: 2 * KIB,
  fromPath: 2 * KIB,
  newVisiblePath: 2 * KIB,
  toPath: 2 * KIB,
  url: 2 * KIB,
  title: 1 * KIB,
  menuName: 1 * KIB,
  nodePath: 1 * KIB,
} as const

export const DISCLOSURE_PAGE_MAX_ITEMS = 50
/** 64 KiB page less the 1 KiB envelope allowance. */
export const DISCLOSURE_PAGE_ITEMS_MAX_BYTES = 63 * KIB

/** Page-sized batches: ⌊63 KiB ÷ the section's largest item⌋ (R8-H1). */
export const DISCLOSURE_SECTION_BATCH = {
  selections: 15,
  historical_routes: 21,
  manual_rules: 9,
  menus: 21, // node items per page of one menu
  // Route sources use 21; its manual-rule source reuses `manual_rules` (9).
  locale_prefix_shadowing: 21,
} as const

/** Migration sections: 21 candidates per `shadowed` page, 9 rules per shift page. */
export const DEFAULT_MIGRATION_SECTION_BATCH = {
  shadowed: 21,
  manual_rule_shifts: 9,
  menus: 21, // node items per page of one menu
} as const

/**
 * Residual 2.2 (ledger C3b Decision): `siteDefaultLanguageRoutes.fromPath` and
 * `capturedPath` are at most 2 KiB. `fromPath` is a resolution key and is never
 * truncated; a longer path is a `route_path_too_long` blocker instead.
 */
export const DEFAULT_MIGRATION_ROUTE_PATH_MAX_BYTES = 2 * KIB

export function utf8ByteLength(value: string): number {
  return encoder.encode(value).byteLength
}

const truncatedField = { truncated: v.optional(v.literal(true)) }

export const disclosureItemValidator = v.union(
  v.object({
    kind: v.literal("selection"),
    pageId: v.id("pages"),
    path: v.string(),
    title: v.string(),
    ...truncatedField,
  }),
  v.object({
    kind: v.literal("selection_non_routable"),
    pageId: v.id("pages"),
    title: v.string(),
    ...truncatedField,
  }),
  v.object({
    kind: v.literal("historical_route"),
    pageId: v.id("pages"),
    fromPath: v.string(),
    ...truncatedField,
  }),
  v.object({
    kind: v.literal("locale_prefix_shadow"),
    pageId: v.id("pages"),
    fromPath: v.string(),
    origin: v.union(
      v.literal("current"),
      v.literal("historical"),
      v.literal("default_migration"),
      v.literal("language_transition")
    ),
    ...truncatedField,
  }),
  v.object({
    kind: v.literal("manual_rule"),
    ruleId: v.id("redirects"),
    fromPath: v.string(),
    destination: v.union(
      v.object({ kind: v.literal("page"), pageId: v.id("pages") }),
      v.object({ kind: v.literal("path"), toPath: v.string() }),
      v.object({ kind: v.literal("external"), url: v.string() })
    ),
    statusCode: v.union(v.literal(301), v.literal(302)),
    status: v.union(
      v.literal("active"),
      v.literal("silenced"),
      v.literal("shifted"),
      v.literal("shadowed")
    ),
    newVisiblePath: v.optional(v.string()),
    ...truncatedField,
  }),
  v.object({
    kind: v.literal("menu_node"),
    menuId: v.id("menus"),
    menuName: v.string(),
    nodePath: v.string(),
    ...truncatedField,
  }),
  v.object({
    kind: v.literal("menu_blocker"),
    menuId: v.id("menus"),
    menuName: v.string(),
    nodePath: v.string(),
    code: v.literal("DEFAULT_MIGRATION_MENU_TEXT_MISSING"),
    ...truncatedField,
  }),
  v.object({
    kind: v.literal("shadowed_row"),
    pageId: v.id("pages"),
    fromPath: v.string(),
    destinationLocale: v.string(),
    reason: v.union(v.literal("to_current"), v.literal("to_historical")),
    ...truncatedField,
  }),
  // Residual 2.2: a candidate path over the route-row maximum is a blocker.
  v.object({
    kind: v.literal("route_path_too_long"),
    pageId: v.id("pages"),
    fromPath: v.string(),
    origin: v.union(
      v.literal("old_default_current"),
      v.literal("old_default_historical"),
      v.literal("carried")
    ),
    code: v.literal("DEFAULT_MIGRATION_ROUTE_PATH_TOO_LONG"),
    ...truncatedField,
  })
)

export type DisclosureItem = Infer<typeof disclosureItemValidator>

export const disclosureSectionValidator = v.union(
  v.literal("selections"),
  v.literal("historical_routes"),
  v.literal("manual_rules"),
  v.literal("menus"),
  v.literal("locale_prefix_shadowing"),
  v.literal("shadowed"),
  v.literal("manual_rule_shifts")
)

export type DisclosureSection = Infer<typeof disclosureSectionValidator>

// ─── Truncation ─────────────────────────────────────────────────────────────

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function truncateUtf8(
  value: string,
  maxBytes: number
): { value: string; truncated: boolean } {
  const bytes = encoder.encode(value)
  if (bytes.byteLength <= maxBytes) return { value, truncated: false }
  let end = maxBytes
  // Step back over continuation bytes so no code point is split.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1
  return { value: decoder.decode(bytes.subarray(0, end)), truncated: true }
}

type TruncatableField = keyof typeof DISCLOSURE_FIELD_MAX_BYTES

/** Applies every declared field maximum; sets `truncated: true` when any cut. */
export function truncateDisclosureItem(item: DisclosureItem): DisclosureItem {
  let cut = false
  const clip = (field: TruncatableField, value: string) => {
    const result = truncateUtf8(value, DISCLOSURE_FIELD_MAX_BYTES[field])
    cut ||= result.truncated
    return result.value
  }
  let next: DisclosureItem
  switch (item.kind) {
    case "selection":
      next = {
        ...item,
        path: clip("path", item.path),
        title: clip("title", item.title),
      }
      break
    case "selection_non_routable":
      next = { ...item, title: clip("title", item.title) }
      break
    case "historical_route":
    case "locale_prefix_shadow":
    case "shadowed_row":
    case "route_path_too_long":
      next = { ...item, fromPath: clip("fromPath", item.fromPath) }
      break
    case "manual_rule": {
      const destination =
        item.destination.kind === "path"
          ? {
              kind: "path" as const,
              toPath: clip("toPath", item.destination.toPath),
            }
          : item.destination.kind === "external"
            ? {
                kind: "external" as const,
                url: clip("url", item.destination.url),
              }
            : item.destination
      next = {
        ...item,
        fromPath: clip("fromPath", item.fromPath),
        destination,
        ...(item.newVisiblePath === undefined
          ? {}
          : { newVisiblePath: clip("newVisiblePath", item.newVisiblePath) }),
      }
      break
    }
    case "menu_node":
    case "menu_blocker":
      next = {
        ...item,
        menuName: clip("menuName", item.menuName),
        nodePath: clip("nodePath", item.nodePath),
      }
      break
  }
  return cut ? { ...next, truncated: true } : next
}

// ─── Encoding ───────────────────────────────────────────────────────────────

type Encoded = string | number | true | undefined | Encoded[]

function itemFields(item: DisclosureItem): Encoded[] {
  switch (item.kind) {
    case "selection":
      return [item.kind, item.pageId, item.path, item.title, item.truncated]
    case "selection_non_routable":
      return [item.kind, item.pageId, item.title, item.truncated]
    case "historical_route":
      return [item.kind, item.pageId, item.fromPath, item.truncated]
    case "locale_prefix_shadow":
      return [
        item.kind,
        item.pageId,
        item.fromPath,
        item.origin,
        item.truncated,
      ]
    case "manual_rule": {
      const d = item.destination
      const destination: Encoded[] =
        d.kind === "page"
          ? [d.kind, d.pageId]
          : d.kind === "path"
            ? [d.kind, d.toPath]
            : [d.kind, d.url]
      return [
        item.kind,
        item.ruleId,
        item.fromPath,
        destination,
        item.statusCode,
        item.status,
        item.newVisiblePath,
        item.truncated,
      ]
    }
    case "menu_node":
      return [
        item.kind,
        item.menuId,
        item.menuName,
        item.nodePath,
        item.truncated,
      ]
    case "menu_blocker":
      return [
        item.kind,
        item.menuId,
        item.menuName,
        item.nodePath,
        item.code,
        item.truncated,
      ]
    case "shadowed_row":
      return [
        item.kind,
        item.pageId,
        item.fromPath,
        item.destinationLocale,
        item.reason,
        item.truncated,
      ]
    case "route_path_too_long":
      return [
        item.kind,
        item.pageId,
        item.fromPath,
        item.origin,
        item.code,
        item.truncated,
      ]
  }
}

function u32(n: number): number[] {
  if (!Number.isInteger(n) || n < 0 || n > 0xffffffff) {
    throw new Error("DISCLOSURE_ENCODING_LENGTH_INVALID")
  }
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
}

function encodeValue(value: Encoded, out: number[]): void {
  if (value === undefined) {
    out.push(0x41) // A
  } else if (value === true) {
    out.push(0x54) // T
  } else if (typeof value === "string") {
    const bytes = encoder.encode(value)
    out.push(0x53, ...u32(bytes.byteLength)) // S
    for (const byte of bytes) out.push(byte)
  } else if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error("DISCLOSURE_ENCODING_NUMBER_INVALID")
    }
    const bytes = encoder.encode(String(value))
    out.push(0x4e, ...u32(bytes.byteLength), ...bytes) // N
  } else {
    out.push(0x4c, ...u32(value.length)) // L
    for (const child of value) encodeValue(child, out)
  }
}

/** Canonical bytes of an item list; exported for encoding tests. */
export function encodeDisclosureItems(items: DisclosureItem[]): Uint8Array {
  const out: number[] = []
  encodeValue(items.map(itemFields), out)
  return Uint8Array.from(out)
}

export async function sha256Hex(
  bytes: Uint8Array<ArrayBuffer>
): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")
}

export async function digestDisclosurePage(input: {
  previousDigest: string
  subjectId: string
  generation: number
  ordinal: number
  section: DisclosureSection
  items: DisclosureItem[]
}): Promise<string> {
  const out: number[] = []
  encodeValue(DISCLOSURE_DIGEST_DOMAIN, out)
  encodeValue(
    [
      input.previousDigest,
      input.subjectId,
      input.generation,
      input.ordinal,
      input.section,
      input.items.map(itemFields),
    ],
    out
  )
  return `sha256:${await sha256Hex(Uint8Array.from(out))}`
}

/** Serialized size estimate of a page's items (JSON UTF-8 bytes). */
export function disclosureItemsBytes(items: DisclosureItem[]): number {
  return encoder.encode(JSON.stringify(items)).byteLength
}

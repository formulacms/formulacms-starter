/**
 * Test-only read/write-set recorder for `convex-test`.
 *
 * `convex-test` installs one permanent `globalThis.Convex` proxy that forwards
 * every database syscall to the running test's in-memory backend. This module
 * wraps that proxy once and, only while `recordSyscalls` is running, logs each
 * database read, write and schedule as a stable descriptor: table, index,
 * range fields and values (document ids reduced to their table), written field
 * names and scheduled function paths. Byte sizes, ids and creation times are
 * never recorded, so a descriptor survives unrelated id or clock shifts.
 *
 * It changes no function behaviour and is never imported by production code.
 * M05 P1 uses it to compare module-off read and write sets against a baseline
 * captured before C1.
 */

import { readFileSync, writeFileSync } from "node:fs"

/** Read a checked-in JSON fixture. */
export function readJsonFixture(url: URL): unknown {
  return JSON.parse(readFileSync(url, "utf8"))
}

/** Write a JSON fixture; callers gate this behind an explicit env flag. */
export function writeJsonFixture(url: URL, value: unknown): void {
  writeFileSync(url, `${JSON.stringify(value, null, 2)}\n`)
}

type Syscall = (op: string, jsonArgs: string) => string
type AsyncSyscall = (op: string, jsonArgs: string) => Promise<string>
type ConvexGlobal = {
  readonly syscall: Syscall
  readonly asyncSyscall: AsyncSyscall
  readonly jsSyscall: unknown
}

export type SyscallSets = {
  /** Sorted read descriptors, one entry per call. */
  reads: string[]
  /** Sorted write and schedule descriptors, one entry per call. */
  writes: string[]
}

let active: { reads: string[]; writes: string[] } | null = null
let installed = false

const ID_PATTERN = /^[0-9]{4,}([A-Za-z_][A-Za-z0-9_]*)$/

/** Replace `convex-test` document ids with `<id:table>`, recursively. */
export function normalizeIds(value: unknown): unknown {
  if (typeof value === "string") {
    const match = ID_PATTERN.exec(value)
    return match ? `<id:${match[1]}>` : value
  }
  if (Array.isArray(value)) return value.map(normalizeIds)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value).sort()) {
      if (key === "_creationTime") continue
      out[key] = normalizeIds((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}

function tableOf(id: unknown): string {
  const normalized = normalizeIds(id)
  return typeof normalized === "string" && normalized.startsWith("<id:")
    ? normalized.slice(4, -1)
    : "?"
}

type QueryJson = {
  source:
    | {
        type: "IndexRange"
        indexName: string
        range: { type: string; fieldPath: string; value?: unknown }[]
        order?: string | null
      }
    | { type: "FullTableScan"; tableName: string; order?: string | null }
    | { type: "Search"; indexName: string; filters?: unknown }
  operators?: unknown[]
}

function describeQuery(kind: string, query: QueryJson): string {
  const source = query.source
  const operators = query.operators?.length
    ? ` +operators ${JSON.stringify(normalizeIds(query.operators))}`
    : ""
  if (source.type === "IndexRange") {
    const range = source.range
      .map(
        (item) =>
          `${item.fieldPath} ${item.type} ${JSON.stringify(normalizeIds(item.value))}`
      )
      .join(", ")
    return `${kind} ${source.indexName} [${range}] ${source.order ?? "asc"}${operators}`
  }
  if (source.type === "FullTableScan") {
    return `${kind} ${source.tableName} full-scan ${source.order ?? "asc"}${operators}`
  }
  return `${kind} ${source.indexName} search ${JSON.stringify(normalizeIds(source.filters))}${operators}`
}

function fields(value: unknown): string {
  return value && typeof value === "object"
    ? `{${Object.keys(value).sort().join(",")}}`
    : "{}"
}

function record(op: string, jsonArgs: string): void {
  if (!active) return
  const args = JSON.parse(jsonArgs) as Record<string, unknown>
  switch (op) {
    case "1.0/queryStream":
      active.reads.push(describeQuery("query", args.query as QueryJson))
      return
    case "1.0/queryPage":
      active.reads.push(describeQuery("paginate", args.query as QueryJson))
      return
    case "1.0/get":
      active.reads.push(`get ${(args.table as string) ?? tableOf(args.id)}`)
      return
    case "1.0/insert":
      active.writes.push(`insert ${args.table as string} ${fields(args.value)}`)
      return
    case "1.0/shallowMerge":
      active.writes.push(
        `patch ${(args.table as string) ?? tableOf(args.id)} ${fields(args.value)}`
      )
      return
    case "1.0/replace":
      active.writes.push(
        `replace ${(args.table as string) ?? tableOf(args.id)} ${fields(args.value)}`
      )
      return
    case "1.0/remove":
      active.writes.push(`delete ${(args.table as string) ?? tableOf(args.id)}`)
      return
    case "1.0/schedule":
      active.writes.push(`schedule ${String(args.name)}`)
      return
    default:
      return
  }
}

/**
 * Wrap the `convex-test` global proxy. Call after the first `convexTest()`
 * in a file, which is what installs the proxy.
 */
export function installSyscallRecorder(): void {
  if (installed) return
  const inner = (globalThis as { Convex?: ConvexGlobal }).Convex
  if (!inner) {
    throw new Error("installSyscallRecorder: create a convexTest() first")
  }
  installed = true
  ;(globalThis as { Convex?: ConvexGlobal }).Convex = {
    get syscall(): Syscall {
      const fn = inner.syscall
      return (op, jsonArgs) => {
        record(op, jsonArgs)
        return fn(op, jsonArgs)
      }
    },
    get asyncSyscall(): AsyncSyscall {
      const fn = inner.asyncSyscall
      return (op, jsonArgs) => {
        record(op, jsonArgs)
        return fn(op, jsonArgs)
      }
    },
    get jsSyscall() {
      return inner.jsSyscall
    },
  }
}

/** Run `body` and return its result with the syscalls it issued. */
export async function recordSyscalls<T>(
  body: () => Promise<T>
): Promise<{ result: T; sets: SyscallSets }> {
  if (!installed) throw new Error("recordSyscalls: recorder not installed")
  if (active) throw new Error("recordSyscalls: recordings cannot nest")
  const current = { reads: [] as string[], writes: [] as string[] }
  active = current
  try {
    const result = await body()
    return {
      result,
      sets: {
        reads: [...current.reads].sort(),
        writes: [...current.writes].sort(),
      },
    }
  } finally {
    active = null
  }
}

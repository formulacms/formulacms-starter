import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, stat } from "node:fs/promises"
import { dirname, join, resolve } from "node:path"
import { ConvexHttpClient } from "convex/browser"
import { ConvexError } from "convex/values"
import { pathToFileURL } from "node:url"
import { register, type NamespacedUnregister } from "tsx/esm/api"
import { parseConfigFileTextToJson } from "typescript"
import { api } from "../../convex/_generated/api.js"
import { parseCreationReceipt } from "../../lib/setup/creation-receipt"

const CREATION_RECEIPT_FILE = ".formulacms/creation-receipt.json"
const POST_CREATE_BASELINE_FILE = ".formulacms/post-create-baseline.json"
const RELEASE_LOCK_FILE = "starter.release-lock.json"

const MAX_COOKIE_BYTES = 16_384
const MAX_RECORD_BYTES = 1_048_576
const REQUEST_TIMEOUT_MS = 10_000

const REFUSALS = {
  arguments:
    "Use a supported command with explicit app root, app URL, backend URL and cookie file.",
  target:
    "Both targets must be HTTP loopback origins with explicit nonprivileged local ports.",
  production: "Slice authoring is only supported in local development.",
  application:
    "Use this CLI inside a separately created application, not source or an immutable blueprint.",
  cookie:
    "Provide a protected regular cookie file owned by the current user, without symlinks or hard links.",
  authentication: "The normal local session token exchange failed.",
  owner: "The current backend did not authenticate the installation owner.",
  backend: "The current authenticated backend read failed.",
  source: "The local registered source could not be read consistently.",
  configuration:
    "Use the selected app config with only @/* mapped to ./*, no external config inheritance or tsx environment override.",
  spec: "Provide a protected regular specification file with valid model input for the selected Type.",
  operations:
    "Provide a protected regular operations file containing a finite deterministic class-operation array.",
  operation:
    "The model operation was refused or failed. Inspect current source before retrying.",
  cleanup:
    "Archive cleanup requires a locally deleted Type and a confirmed current backend result.",
  coherence:
    "The current backend contract state does not match this local catalog.",
} as const

export class SliceAuthoringCliRefusal extends Error {
  constructor(readonly code: keyof typeof REFUSALS) {
    super(REFUSALS[code])
  }
}

function refuse(code: keyof typeof REFUSALS): never {
  throw new SliceAuthoringCliRefusal(code)
}

/** Never forward provider, filesystem or argument errors that could contain credentials. */
export function sliceAuthoringFailure(error: unknown): string {
  return error instanceof SliceAuthoringCliRefusal
    ? error.message
    : "Slice authoring refused."
}

export type SliceAuthoringOptions = {
  command:
    | "list"
    | "detail"
    | "review-model"
    | "update-model"
    | "delete"
    | "retry-cleanup"
    | "archive"
    | "reactivate"
    | "review-create"
    | "create"
    | "review-renderer"
    | "update-renderer"
  specFile?: string
  operationsFile?: string
  expectedRevision?: string
  type?: string
  appRoot: string
  appUrl: string
  backendUrl: string
  cookieFile: string
}

function fullMatch(pattern: RegExp, value: string): boolean {
  return pattern.exec(value)?.[0] === value
}

function localOrigin(value: string): string {
  try {
    const url = new URL(value)
    if (
      url.protocol !== "http:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      !/^\d+$/.test(url.port) ||
      Number(url.port) < 1024 ||
      Number(url.port) > 65535 ||
      url.username ||
      url.password ||
      url.pathname !== "/" ||
      url.search ||
      url.hash ||
      (value !== url.origin && value !== `${url.origin}/`)
    )
      refuse("target")
    return url.origin
  } catch {
    return refuse("target")
  }
}

export function parseSliceAuthoringArgs(
  args: readonly string[]
): SliceAuthoringOptions {
  const command = args[0]
  if (
    command !== "list" &&
    command !== "detail" &&
    command !== "review-model" &&
    command !== "update-model" &&
    command !== "delete" &&
    command !== "retry-cleanup" &&
    command !== "archive" &&
    command !== "reactivate" &&
    command !== "review-create" &&
    command !== "create" &&
    command !== "review-renderer" &&
    command !== "update-renderer"
  )
    refuse("arguments")
  let index = 1
  let type: string | undefined
  if (command !== "list") {
    type = args[index++]
    if (!type || !fullMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, type))
      refuse("arguments")
    if (
      (command === "review-create" || command === "create") &&
      !fullMatch(/^[a-z][a-z0-9]*(?:-[a-z][a-z0-9]*)*$/, type)
    )
      refuse("arguments")
  }
  const values = new Map<string, string>()
  const required = ["--app-root", "--app-url", "--backend-url", "--cookie-file"]
  if (
    command === "review-model" ||
    command === "update-model" ||
    command === "review-create" ||
    command === "create"
  )
    required.push("--spec-file")
  if (command === "review-renderer" || command === "update-renderer")
    required.push("--operations-file")
  if (
    command === "update-model" ||
    command === "delete" ||
    command === "archive" ||
    command === "reactivate" ||
    command === "create" ||
    command === "update-renderer"
  )
    required.push("--expected-revision")
  const allowed = required
  for (; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (
      !allowed.includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith("--")
    )
      refuse("arguments")
    values.set(flag, value)
  }
  if (
    required.some((flag) => !values.has(flag)) ||
    (values.has("--expected-revision") &&
      !fullMatch(/^[a-f0-9]{64}$/, values.get("--expected-revision")!))
  )
    refuse("arguments")
  return {
    command,
    type,
    appRoot: values.get("--app-root")!,
    appUrl: localOrigin(values.get("--app-url")!),
    backendUrl: localOrigin(values.get("--backend-url")!),
    cookieFile: values.get("--cookie-file")!,
    specFile: values.get("--spec-file"),
    operationsFile: values.get("--operations-file"),
    expectedRevision: values.get("--expected-revision"),
  }
}

/** Compatibility read parser: write admission is only through the command dispatcher. */
export function parseSliceAuthoringReadArgs(args: readonly string[]) {
  const options = parseSliceAuthoringArgs(args)
  if (options.command !== "list" && options.command !== "detail")
    refuse("arguments")
  return options
}

async function boundedRegularFile(path: string): Promise<Buffer> {
  const info = await lstat(path)
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.size > MAX_RECORD_BYTES ||
    (await realpath(path)) !== resolve(path)
  )
    refuse("application")
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  )
  try {
    const opened = await file.stat()
    if (
      !opened.isFile() ||
      opened.dev !== info.dev ||
      opened.ino !== info.ino ||
      opened.size > MAX_RECORD_BYTES
    )
      refuse("application")
    const buffer = Buffer.alloc(MAX_RECORD_BYTES + 1)
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_RECORD_BYTES || bytesRead !== opened.size)
      refuse("application")
    return buffer.subarray(0, bytesRead)
  } finally {
    await file.close()
  }
}

/** entrypointPath comes from the trusted executable's import.meta.url, never an operator flag.
 * Receipt consistency proves creation records only; it does not authenticate a backend or attest provenance. */
export async function assertSliceAuthoringApplication(
  appRoot: string,
  entrypointPath: string
): Promise<string> {
  if (process.env.NODE_ENV === "production") refuse("production")
  try {
    const root = await realpath(resolve(appRoot))
    if (
      (await realpath(entrypointPath)) !==
      join(root, "scripts/author-slices.ts")
    )
      refuse("application")
    for (let ancestor = root; ; ancestor = dirname(ancestor)) {
      try {
        await stat(join(ancestor, "scripts/starter/release.manifest.json"))
        refuse("application")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
      if (ancestor === dirname(ancestor)) break
    }
    const receiptText = (
      await boundedRegularFile(join(root, CREATION_RECEIPT_FILE))
    ).toString("utf8")
    const receipt = parseCreationReceipt(receiptText)
    if (receiptText !== `${JSON.stringify(receipt, null, 2)}\n`)
      refuse("application")
    const [lock, baseline, packageBytes] = await Promise.all([
      boundedRegularFile(join(root, RELEASE_LOCK_FILE)),
      boundedRegularFile(join(root, POST_CREATE_BASELINE_FILE)),
      boundedRegularFile(join(root, "package.json")),
    ])
    const digest = (bytes: Buffer) =>
      createHash("sha256").update(bytes).digest("hex")
    const pkg = JSON.parse(packageBytes.toString("utf8")) as {
      name?: unknown
      private?: unknown
    }
    const naming = receipt.transforms[1]
    if (
      naming.id !== "package-name" ||
      digest(lock) !== receipt.blueprint.lockSha256 ||
      digest(baseline) !== receipt.postCreateBaselineDigest ||
      pkg.name !== naming.projectName ||
      pkg.private !== true
    )
      refuse("application")
    return root
  } catch (error) {
    if (error instanceof SliceAuthoringCliRefusal) throw error
    return refuse("application")
  }
}

async function readProtectedDataFile(
  path: string,
  limit: number,
  code: "cookie" | "spec" | "operations"
): Promise<string> {
  try {
    const absolute = resolve(path)
    if (
      (await realpath(absolute)) !== absolute ||
      typeof process.getuid !== "function"
    )
      refuse(code)
    const before = await lstat(absolute)
    const valid = (info: typeof before) =>
      info.isFile() &&
      info.nlink === 1 &&
      info.uid === process.getuid!() &&
      (info.mode & 0o077) === 0 &&
      info.size > 0 &&
      info.size <= limit
    if (!valid(before)) refuse(code)
    const file = await open(
      absolute,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
    )
    try {
      const opened = await file.stat()
      if (
        !valid(opened) ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      )
        refuse(code)
      const buffer = Buffer.alloc(limit + 1)
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0)
      const after = await file.stat()
      if (
        !valid(after) ||
        bytesRead !== opened.size ||
        after.size !== opened.size ||
        after.mtimeMs !== opened.mtimeMs ||
        after.mode !== opened.mode
      )
        refuse(code)
      return buffer.subarray(0, bytesRead).toString("utf8")
    } finally {
      await file.close()
    }
  } catch {
    return refuse(code)
  }
}

export async function readSliceAuthoringCookie(path: string): Promise<string> {
  const cookie = (
    await readProtectedDataFile(path, MAX_COOKIE_BYTES, "cookie")
  ).trim()
  if (
    !/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x2b\x2d-\x3a\x3c-\x7e]+(?:; ?[!#$%&'*+\-.^_`|~0-9A-Za-z]+=[\x21-\x2b\x2d-\x3a\x3c-\x7e]+)*$/.test(
      cookie
    )
  )
    refuse("cookie")
  return cookie
}

/** Narrow test transport. The real executable always constructs the normal user-token transport below. */
export type SliceAuthoringReadTransport = {
  token(appUrl: string, cookie: string): Promise<string>
  owner(backendUrl: string, token: string): Promise<unknown>
  state(backendUrl: string, token: string): Promise<unknown>
  usage?(
    backendUrl: string,
    token: string,
    type: string,
    forRetirement: boolean
  ): Promise<unknown>
  retirementAllowed?(
    backendUrl: string,
    token: string,
    type: string
  ): Promise<unknown>
  cleanupArchive?(
    backendUrl: string,
    token: string,
    type: string
  ): Promise<unknown>
  setArchived?(
    backendUrl: string,
    token: string,
    type: string,
    archived: boolean,
    expectedState: { contracts: string; archived: boolean }
  ): Promise<unknown>
}

export function createSliceAuthoringReadTransport(): SliceAuthoringReadTransport {
  const clientFor = (backendUrl: string, token: string) => {
    const client = new ConvexHttpClient(backendUrl, {
      skipConvexDeploymentUrlCheck: true,
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    })
    client.setAuth(token)
    return client
  }
  return {
    setArchived: (backendUrl, token, type, archived, expectedState) =>
      clientFor(backendUrl, token).mutation(
        api.cms.sliceLibrary.setSliceArchived,
        {
          type,
          archived,
          expectedState,
        }
      ),
    async token(appUrl, cookie) {
      const response = await fetch(`${appUrl}/api/auth/convex/token`, {
        method: "GET",
        headers: { Origin: appUrl, Cookie: cookie },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      })
      if (
        !response.ok ||
        response.redirected ||
        Number(response.headers.get("content-length")) > MAX_COOKIE_BYTES
      )
        refuse("authentication")
      // Bound the response even when Content-Length is absent or false.
      if (!response.body) refuse("authentication")
      const reader = response.body.getReader()
      let text = ""
      let bytes = 0
      const decoder = new TextDecoder()
      try {
        for (;;) {
          const part = await reader.read()
          if (part.done) break
          bytes += part.value.length
          if (bytes > MAX_COOKIE_BYTES) refuse("authentication")
          text += decoder.decode(part.value, { stream: true })
        }
        text += decoder.decode()
      } finally {
        await reader.cancel()
      }
      const value = JSON.parse(text) as { token?: unknown }
      if (typeof value?.token !== "string") refuse("authentication")
      return value.token
    },
    owner: (backendUrl, token) =>
      clientFor(backendUrl, token).query(api.cms.owner.getOwnerSession, {}),
    state: (backendUrl, token) =>
      clientFor(backendUrl, token).query(
        api.cms.slices.getSliceAuthoringState,
        {}
      ),
    usage: (backendUrl, token, type, forRetirement) =>
      clientFor(backendUrl, token).query(
        api.cms.sliceLibrary.getSliceUsageSummary,
        { type, ...(forRetirement ? { forRetirement: true as const } : {}) }
      ),
    retirementAllowed: (backendUrl, token, type) =>
      clientFor(backendUrl, token).query(
        api.cms.sliceLibrary.assertSliceTypeRetirementAllowed,
        { type }
      ),
    cleanupArchive: (backendUrl, token, type) =>
      clientFor(backendUrl, token).mutation(
        api.cms.sliceLibrary.cleanupDeletedSliceTypeArchive,
        { type }
      ),
  }
}

async function appConfig(root: string): Promise<string> {
  if (process.env.TSX_TSCONFIG_PATH) refuse("configuration")
  const configPath = join(root, "tsconfig.json")
  try {
    const text = (await boundedRegularFile(configPath)).toString("utf8")
    const parsed = parseConfigFileTextToJson(configPath, text)
    const config: unknown = parsed.config
    if (
      parsed.error ||
      !config ||
      typeof config !== "object" ||
      Array.isArray(config)
    )
      refuse("configuration")
    const value = config as Record<string, unknown>
    const options = value.compilerOptions as Record<string, unknown> | undefined
    if (
      value.extends !== undefined ||
      !options ||
      JSON.stringify(options.paths) !== JSON.stringify({ "@/*": ["./*"] }) ||
      (options.baseUrl !== undefined &&
        options.baseUrl !== "." &&
        options.baseUrl !== "./")
    )
      refuse("configuration")
    return text
  } catch {
    return refuse("configuration")
  }
}

async function appModule<T>(
  root: string,
  loader: NamespacedUnregister,
  file: string
): Promise<T> {
  const path = join(root, file)
  const info = await lstat(path)
  if (!info.isFile() || info.nlink !== 1 || (await realpath(path)) !== path)
    refuse("source")
  return loader.import(
    pathToFileURL(path).href,
    pathToFileURL(join(root, "scripts/author-slices.ts")).href
  ) as Promise<T>
}

async function localTypes(
  root: string,
  type: string | undefined,
  loader: NamespacedUnregister
) {
  try {
    const { assertAuthoringPaths } = await appModule<
      typeof import("../../lib/slices/authoring/paths")
    >(root, loader, "lib/slices/authoring/paths.ts")
    assertAuthoringPaths(root, [join(root, "lib/slices/slices.manifest.json")])
    const [{ readManifest }, { readSliceModelSourceRevision }] =
      await Promise.all([
        appModule<typeof import("../../lib/slices/authoring/registration")>(
          root,
          loader,
          "lib/slices/authoring/registration.ts"
        ),
        appModule<
          typeof import("../../lib/slices/authoring/model-source-revision")
        >(root, loader, "lib/slices/authoring/model-source-revision.ts"),
      ])
    const manifest = await readManifest(root)
    const selected = manifest.filter((entry) => !type || entry.type === type)
    // A scoped loader caches its compiled modules. Freeze the finite catalog
    // inputs independently so a changed non-selected descriptor or shared field
    // source cannot leave a stale compiled frame looking current after auth.
    const sharedPaths = [
      "convex/lib/slices/index.ts",
      "convex/lib/slices/fields.ts",
      "convex/lib/slices/primitives.ts",
      "convex/lib/slices/occurrencePresentation.ts",
      "convex/lib/slices/authoringState.ts",
      "convex/lib/richtext/build.ts",
      "convex/lib/richtext/contracts.ts",
      "convex/lib/richtext/emptiness.ts",
      "convex/lib/richtext/profiles.ts",
      "convex/lib/pages/types.ts",
      "lib/slices/authoring/registration.ts",
      "lib/slices/authoring/model-source-revision.ts",
      "lib/slices/authoring/despec.ts",
      "lib/slices/authoring/scaffold.ts",
      "lib/slices/authoring/naming.ts",
      "lib/slices/authoring/paths.ts",
      "lib/slices/icon-names.ts",
    ]
    const revisionPaths = [
      "lib/slices/builder.ts",
      "lib/slices/slices.manifest.json",
      ...manifest.flatMap(({ type: registeredType }) => [
        `convex/lib/slices/${registeredType.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())}.ts`,
        `components/slices/${registeredType}.tsx`,
      ]),
      ...sharedPaths,
    ].map((path) => join(root, path))
    const catalogRevision = async () => {
      assertAuthoringPaths(root, revisionPaths)
      const revisions = await Promise.all(
        manifest.map((entry) => readSliceModelSourceRevision(entry.type, root))
      )
      const shared = await Promise.all(
        sharedPaths.map(async (path) =>
          (await boundedRegularFile(join(root, path))).toString("hex")
        )
      )
      assertAuthoringPaths(root, revisionPaths)
      return createHash("sha256")
        .update(JSON.stringify([revisions, shared]))
        .digest("hex")
    }
    const catalogSourceRevision = await catalogRevision()
    // The executable is a fresh app-local process. Freeze source before loading
    // its typed descriptor closure, and refuse edits during that load/read.
    const [
      { REGISTERED_SLICE_TYPES, INSTALLED_SLICE_TYPES },
      { sliceTypeToSpec },
      compiledManifest,
      { sliceAuthoringContractState },
    ] = await Promise.all([
      appModule<typeof import("../../convex/lib/slices")>(
        root,
        loader,
        "convex/lib/slices/index.ts"
      ),
      appModule<typeof import("../../lib/slices/authoring/despec")>(
        root,
        loader,
        "lib/slices/authoring/despec.ts"
      ),
      appModule<{
        default: typeof import("../../lib/slices/slices.manifest.json")
      }>(root, loader, "lib/slices/slices.manifest.json"),
      appModule<typeof import("../../convex/lib/slices/authoringState")>(
        root,
        loader,
        "convex/lib/slices/authoringState.ts"
      ),
    ])
    const registeredTypes: string[] = [...REGISTERED_SLICE_TYPES]
    const installedTypes: string[] = [...INSTALLED_SLICE_TYPES]
    // JSON imports infer origin as string. Compare primitive metadata after
    // readManifest has validated the actual file, without asserting its type.
    const metadata = (
      entries: readonly (Omit<(typeof manifest)[number], "origin"> & {
        origin?: string
      })[]
    ) =>
      entries.map((entry) => [
        entry.type,
        entry.label,
        entry.description,
        entry.icon,
        entry.group,
        entry.origin ?? "system",
        entry.selected !== false,
      ])
    if (
      JSON.stringify(metadata(manifest)) !==
        JSON.stringify(metadata(compiledManifest.default)) ||
      manifest.length !== registeredTypes.length ||
      manifest.some(
        (entry) =>
          !registeredTypes.includes(entry.type) ||
          installedTypes.includes(entry.type) !== (entry.selected !== false)
      ) ||
      (type && !registeredTypes.includes(type))
    )
      refuse("source")
    const slices = await Promise.all(
      selected.map(async (entry) => ({
        manifest: entry,
        registered: true,
        installed: installedTypes.includes(entry.type),
        origin: entry.origin ?? "system",
        sourceRevision: await readSliceModelSourceRevision(entry.type, root),
        ...(type
          ? {
              spec: sliceTypeToSpec(
                entry.type as (typeof REGISTERED_SLICE_TYPES)[number]
              ),
            }
          : {}),
      }))
    )
    if ((await catalogRevision()) !== catalogSourceRevision) refuse("source")
    return {
      registeredTypes,
      installedTypes,
      slices,
      contractState: sliceAuthoringContractState(),
      catalogSourceRevision,
    }
  } catch {
    return refuse("source")
  }
}

async function creationCommand(
  options: SliceAuthoringOptions,
  root: string,
  loader: NamespacedUnregister,
  current: Awaited<ReturnType<typeof localTypes>>,
  specJson: string
) {
  const service = await appModule<
    typeof import("../../lib/slices/authoring/create-model-service")
  >(root, loader, "lib/slices/authoring/create-model-service.ts")
  const request = {
    expectedType: options.type!,
    expectedCatalogSourceRevision:
      options.command === "create"
        ? options.expectedRevision!
        : current.catalogSourceRevision,
    specJson,
  }
  const readCatalog = async (selectedRoot: string) => {
    if (selectedRoot !== root) refuse("application")
    const catalog = await localTypes(root, undefined, loader)
    return {
      sourceRevision: catalog.catalogSourceRevision,
      registeredTypes: catalog.registeredTypes,
    }
  }
  // Parse/preview failures are sanitized before apply. Review covers the real
  // deterministic scaffold, defaults, complete file footprint and conflicts.
  let review: Awaited<ReturnType<typeof service.reviewSliceModelCreation>>
  try {
    review = await service.reviewSliceModelCreation(
      request,
      { readCatalog },
      root
    )
  } catch (error) {
    if (error instanceof SliceAuthoringCliRefusal) throw error
    return refuse("spec")
  }
  const header = {
    command: options.command,
    expectedType: options.type!,
    expectedCatalogSourceRevision: request.expectedCatalogSourceRevision,
    preconditionBackendCatalogCoherence: "exact-contract-state" as const,
  }
  if (options.command === "review-create") return { ...header, result: review }
  if (review.status === "refused") return { ...header, result: review }
  const gate = await appModule<
    typeof import("../../lib/slices/authoring/gate")
  >(root, loader, "lib/slices/authoring/gate.ts")
  try {
    return {
      ...header,
      result: await service.createReviewedSliceModel(
        { ...request, specJson: review.normalizedSpecJson },
        {
          readCatalog,
          runCreationGate: (type, selectedRoot) =>
            gate.runSliceGate(type, selectedRoot),
        },
        root
      ),
    }
  } catch (error) {
    if (error instanceof SliceAuthoringCliRefusal) throw error
    return refuse("operation")
  }
}

function authoritativeUsage(
  value: unknown
): import("../../lib/slices/authoring/service").SliceRetirementUsage {
  if (!value || typeof value !== "object" || Array.isArray(value))
    refuse("backend")
  const usage = value as Record<string, unknown>
  for (const key of [
    "usageCount",
    "savedUsageCount",
    "stagedUsageCount",
    "publicationUsageCount",
    "pageCount",
    "deletedPageCount",
  ]) {
    if (!Number.isSafeInteger(usage[key]) || (usage[key] as number) < 0)
      refuse("backend")
  }
  if (
    typeof usage.archived !== "boolean" ||
    !Array.isArray(usage.pages) ||
    usage.pages.length > 100 ||
    usage.usageCount !==
      (usage.savedUsageCount as number) +
        (usage.stagedUsageCount as number) +
        (usage.publicationUsageCount as number) ||
    (usage.deletedPageCount as number) > (usage.pageCount as number)
  )
    refuse("backend")
  return usage as import("../../lib/slices/authoring/service").SliceRetirementUsage
}

async function modelCommand(
  options: SliceAuthoringOptions,
  root: string,
  loader: NamespacedUnregister,
  token: string,
  transport: SliceAuthoringReadTransport,
  current: Awaited<ReturnType<typeof localTypes>>["slices"][number],
  specJson?: string
) {
  const type = options.type!
  let normalizedSpecJson: string | undefined
  let changes:
    import("../../lib/slices/authoring/spec-diff").SpecFieldChange[] | undefined
  if (options.command !== "delete") {
    try {
      const { parseSliceSpecJson } = await appModule<
        typeof import("../../lib/slices/authoring/persist")
      >(root, loader, "lib/slices/authoring/persist.ts")
      const { diffSliceSpecs } = await appModule<
        typeof import("../../lib/slices/authoring/spec-diff")
      >(root, loader, "lib/slices/authoring/spec-diff.ts")
      const spec = parseSliceSpecJson(specJson!)
      if (spec.type !== type || !current.spec) refuse("spec")
      normalizedSpecJson = JSON.stringify(spec, null, 2)
      changes = diffSliceSpecs(current.spec, spec)
    } catch {
      return refuse("spec")
    }
    if (options.command === "review-model")
      return {
        command: options.command,
        status: "reviewed" as const,
        expectedType: type,
        expectedSourceRevision: current.sourceRevision,
        backendCatalogCoherence: "exact-contract-state" as const,
        normalizedSpecJson,
        changes,
      }
  }
  const service = await appModule<
    typeof import("../../lib/slices/authoring/service")
  >(root, loader, "lib/slices/authoring/service.ts")
  const gate = await appModule<
    typeof import("../../lib/slices/authoring/gate")
  >(root, loader, "lib/slices/authoring/gate.ts")
  const reviewed = {
    expectedType: type,
    expectedSourceRevision: options.expectedRevision!,
  }
  try {
    const result =
      options.command === "update-model"
        ? await service.updateSliceModel(
            { ...reviewed, specJson: normalizedSpecJson! },
            {
              readUsage: async (target) => {
                if (!transport.usage) refuse("backend")
                return authoritativeUsage(
                  await transport.usage(
                    options.backendUrl,
                    token,
                    target,
                    false
                  )
                )
              },
              runModelGate: (target, selectedRoot) =>
                gate.runSliceGate(target, selectedRoot),
            },
            root
          )
        : await service.deleteReviewedSliceModel(
            reviewed,
            {
              assertRetirementAllowed: async (target) => {
                if (!transport.retirementAllowed) refuse("backend")
                return transport.retirementAllowed(
                  options.backendUrl,
                  token,
                  target
                )
              },
              readRetirementUsage: async (target) => {
                if (!transport.usage) refuse("backend")
                // This endpoint itself checks the current owner, retirement permission
                // and publication references. It is the final backend read before writes.
                return authoritativeUsage(
                  await transport.usage(options.backendUrl, token, target, true)
                )
              },
              cleanupArchive: async (target) => {
                if (!transport.cleanupArchive) refuse("backend")
                return transport.cleanupArchive(
                  options.backendUrl,
                  token,
                  target
                )
              },
              runDeletionGate: (selectedRoot) =>
                gate.runTypecheckGate(undefined, selectedRoot),
            },
            root
          )
    const outcome =
      "status" in result && result.status === "blocked"
        ? {
            status: result.status,
            reason: result.reason,
            archived: result.archived,
            usageCount: result.usageCount,
            savedUsageCount: result.savedUsageCount,
            stagedUsageCount: result.stagedUsageCount,
            publicationUsageCount: result.publicationUsageCount ?? 0,
            pageCount: result.pageCount,
            deletedPageCount: result.deletedPageCount,
          }
        : "status" in result && result.status === "cleanup_pending"
          ? {
              ...result,
              nextAction: `Recompile or push the changed source to the same ordinary local backend, then run retry-cleanup ${type} with the same explicit --app-root, --app-url, --backend-url and --cookie-file options.`,
            }
          : result
    return {
      command: options.command,
      expectedType: type,
      preconditionBackendCatalogCoherence: "exact-contract-state" as const,
      result: outcome,
    }
  } catch (error) {
    if (
      options.command === "delete" &&
      error instanceof ConvexError &&
      error.data === "SLICE_TYPE_REFERENCED_BY_PUBLICATION"
    )
      return {
        command: options.command,
        expectedType: type,
        result: {
          status: "blocked" as const,
          reason: "publication_references" as const,
        },
      }
    if (error instanceof service.SliceSourceConflictError)
      return {
        command: options.command,
        expectedType: type,
        result: { status: "refused" as const, reason: "stale_source" as const },
      }
    if (error instanceof SliceAuthoringCliRefusal) throw error
    return refuse("operation")
  }
}

async function rendererCommand(
  options: SliceAuthoringOptions,
  root: string,
  entrypointPath: string,
  loader: NamespacedUnregister,
  token: string,
  transport: SliceAuthoringReadTransport,
  current: Awaited<ReturnType<typeof localTypes>>,
  owner: { ownerId: string; authId: string },
  backend: Record<string, unknown>,
  configText: string,
  operationsJson: string
) {
  const service = await appModule<
    typeof import("../../lib/slices/authoring/renderer-service")
  >(root, loader, "lib/slices/authoring/renderer-service.ts")
  const gate = await appModule<
    typeof import("../../lib/slices/authoring/gate")
  >(root, loader, "lib/slices/authoring/gate.ts")
  const request = {
    expectedType: options.type!,
    expectedSourceRevision:
      options.expectedRevision ?? current.slices[0].sourceRevision,
    operationsJson,
  }
  try {
    service.parseRendererOperationsJson(operationsJson)
  } catch {
    refuse("operations")
  }
  const adapters = {
    async revalidateCurrentState(type: string, selectedRoot: string) {
      if (
        type !== options.type ||
        selectedRoot !== root ||
        (await assertSliceAuthoringApplication(root, entrypointPath)) !== root
      )
        refuse("application")
      if (!transport.usage) refuse("backend")
      let usage: import("../../lib/slices/authoring/service").SliceRetirementUsage
      try {
        usage = authoritativeUsage(
          await transport.usage(options.backendUrl, token, type, false)
        )
      } catch (error) {
        if (error instanceof SliceAuthoringCliRefusal) throw error
        refuse("backend")
      }
      // Usage itself follows normal permissions. Bind it to a fresh ordinary
      // installation-owner identity and exact backend contract after its await.
      let nextOwner: unknown
      try {
        nextOwner = await transport.owner(options.backendUrl, token)
      } catch {
        refuse("owner")
      }
      if (
        !nextOwner ||
        typeof nextOwner !== "object" ||
        !("ownerId" in nextOwner) ||
        nextOwner.ownerId !== owner.ownerId ||
        !("authId" in nextOwner) ||
        nextOwner.authId !== owner.authId
      )
        refuse("owner")
      let nextState: unknown
      try {
        nextState = await transport.state(options.backendUrl, token)
      } catch {
        refuse("backend")
      }
      if (
        !nextState ||
        typeof nextState !== "object" ||
        Array.isArray(nextState)
      )
        refuse("coherence")
      const next = nextState as Record<string, unknown>
      for (const key of [
        "settingsId",
        "version",
        "contracts",
        "registeredTypes",
        "installedTypes",
        "archivedTypes",
      ])
        if (JSON.stringify(next[key]) !== JSON.stringify(backend[key]))
          refuse("coherence")
      if (usage.archived !== (backend.archivedTypes as string[]).includes(type))
        refuse("coherence")
      if (
        (await assertSliceAuthoringApplication(root, entrypointPath)) !== root
      )
        refuse("application")
      if ((await appConfig(root)) !== configText) refuse("configuration")
      const fresh = await localTypes(root, type, loader)
      if (JSON.stringify(fresh) !== JSON.stringify(current)) refuse("source")
      return usage
    },
    runRendererGate: (type: string, selectedRoot: string) =>
      gate.runSliceGate(type, selectedRoot),
  }
  try {
    return {
      command: options.command,
      expectedType: options.type!,
      preconditionBackendCatalogCoherence: "exact-contract-state" as const,
      sourceOwnership: {
        origin: current.slices[0].origin,
        installed: current.slices[0].installed,
        registered: current.slices[0].registered,
        sharedLocalSourceEdit: true,
      },
      result:
        options.command === "review-renderer"
          ? await service.reviewSliceRendererUpdate(request, adapters, root)
          : await service.updateReviewedSliceRenderer(request, adapters, root),
    }
  } catch (error) {
    if (error instanceof SliceAuthoringCliRefusal) throw error
    return refuse("operation")
  }
}

async function assertCleanupTargetAbsent(
  root: string,
  loader: NamespacedUnregister,
  type: string,
  registeredTypes: readonly string[]
) {
  if (registeredTypes.includes(type)) refuse("cleanup")
  try {
    const { assertAuthoringPaths } = await appModule<
      typeof import("../../lib/slices/authoring/paths")
    >(root, loader, "lib/slices/authoring/paths.ts")
    const paths = [
      join(
        root,
        `convex/lib/slices/${type.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())}.ts`
      ),
      join(root, `components/slices/${type}.tsx`),
    ]
    assertAuthoringPaths(root, paths)
    for (const path of paths) {
      try {
        await lstat(path)
        refuse("cleanup")
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
      }
    }
    assertAuthoringPaths(root, paths)
  } catch (error) {
    if (error instanceof SliceAuthoringCliRefusal) throw error
    return refuse("source")
  }
}

async function retryCleanup(
  options: SliceAuthoringOptions,
  archivedTypes: readonly string[],
  token: string,
  transport: SliceAuthoringReadTransport
) {
  const type = options.type!
  const result = {
    command: "retry-cleanup" as const,
    expectedType: type,
    backendCatalogCoherence: "exact-contract-state" as const,
  }
  if (!archivedTypes.includes(type))
    return { ...result, result: { status: "already_clean" as const } }
  if (!transport.cleanupArchive) refuse("cleanup")
  let next: unknown
  try {
    next = await transport.cleanupArchive(options.backendUrl, token, type)
  } catch {
    return refuse("cleanup")
  }
  if (
    !Array.isArray(next) ||
    next.length > 10_000 ||
    next.includes(type) ||
    next.some(
      (value) =>
        typeof value !== "string" ||
        !fullMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, value)
    )
  )
    refuse("cleanup")
  return { ...result, result: { status: "cleaned" as const } }
}

export async function runSliceAuthoringCommand(
  args: readonly string[],
  entrypointPath: string,
  transport: SliceAuthoringReadTransport
) {
  if (process.env.NODE_ENV === "production") refuse("production")
  if (process.env.TSX_TSCONFIG_PATH) refuse("configuration")
  const options = parseSliceAuthoringArgs(args)
  const root = await assertSliceAuthoringApplication(
    options.appRoot,
    entrypointPath
  )
  const cookie = await readSliceAuthoringCookie(options.cookieFile)
  const specJson = options.specFile
    ? await readProtectedDataFile(options.specFile, MAX_RECORD_BYTES, "spec")
    : undefined
  const operationsJson = options.operationsFile
    ? await readProtectedDataFile(
        options.operationsFile,
        MAX_RECORD_BYTES,
        "operations"
      )
    : undefined
  const configText = await appConfig(root)
  const loader = register({
    namespace: randomUUID(),
    tsconfig: join(root, "tsconfig.json"),
  })
  try {
    const catalogType =
      options.command === "retry-cleanup" ||
      options.command === "review-create" ||
      options.command === "create"
        ? undefined
        : options.type
    const local = await localTypes(root, catalogType, loader)
    if (options.command === "retry-cleanup")
      await assertCleanupTargetAbsent(
        root,
        loader,
        options.type!,
        local.registeredTypes
      )
    let token: string
    try {
      token = await transport.token(options.appUrl, cookie)
    } catch {
      return refuse("authentication")
    }
    if (
      typeof token !== "string" ||
      token.length > MAX_COOKIE_BYTES ||
      !fullMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, token)
    )
      refuse("authentication")
    let owner: unknown
    try {
      owner = await transport.owner(options.backendUrl, token)
    } catch {
      return refuse("owner")
    }
    if (
      !owner ||
      typeof owner !== "object" ||
      !("ownerId" in owner) ||
      typeof owner.ownerId !== "string" ||
      !owner.ownerId ||
      !("authId" in owner) ||
      typeof owner.authId !== "string" ||
      !owner.authId
    )
      refuse("owner")
    let state: unknown
    try {
      state = await transport.state(options.backendUrl, token)
    } catch {
      return refuse("backend")
    }
    if (!state || typeof state !== "object" || Array.isArray(state))
      refuse("coherence")
    const backend = state as Record<string, unknown>
    if (
      typeof backend.settingsId !== "string" ||
      !fullMatch(/^[A-Za-z0-9_-]{1,256}$/, backend.settingsId) ||
      backend.version !== local.contractState.version ||
      backend.contracts !== local.contractState.contracts ||
      JSON.stringify(backend.registeredTypes) !==
        JSON.stringify(local.contractState.registeredTypes) ||
      JSON.stringify(backend.installedTypes) !==
        JSON.stringify(local.contractState.installedTypes)
    )
      refuse("coherence")
    const archived = backend.archivedTypes
    if (
      !Array.isArray(archived) ||
      archived.length > 10_000 ||
      archived.some(
        (value) =>
          typeof value !== "string" ||
          !fullMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, value)
      )
    )
      refuse("backend")
    // Refuse config or source changes during authenticated reads.
    if ((await appConfig(root)) !== configText) refuse("configuration")
    // Re-read revisions after authentication, refusing a changed local frame.
    const current = await localTypes(root, catalogType, loader)
    if (JSON.stringify(current) !== JSON.stringify(local)) refuse("source")
    if (
      options.command === "review-renderer" ||
      options.command === "update-renderer"
    )
      return await rendererCommand(
        options,
        root,
        entrypointPath,
        loader,
        token,
        transport,
        current,
        owner as { ownerId: string; authId: string },
        backend,
        configText,
        operationsJson!
      )
    if (options.command === "review-create" || options.command === "create")
      return await creationCommand(options, root, loader, current, specJson!)
    if (options.command === "retry-cleanup") {
      await assertCleanupTargetAbsent(
        root,
        loader,
        options.type!,
        current.registeredTypes
      )
      return await retryCleanup(options, archived as string[], token, transport)
    }
    if (options.command === "archive" || options.command === "reactivate") {
      const header = {
        command: options.command,
        expectedType: options.type!,
        preconditionBackendCatalogCoherence: "exact-contract-state" as const,
      }
      if (current.slices[0]?.sourceRevision !== options.expectedRevision)
        return {
          ...header,
          result: {
            status: "refused" as const,
            reason: "stale_source" as const,
          },
        }
      if (!transport.setArchived) refuse("backend")
      const desired = options.command === "archive"
      let next: unknown
      try {
        next = await transport.setArchived(
          options.backendUrl,
          token,
          options.type!,
          desired,
          {
            contracts: current.contractState.contracts,
            archived: archived.includes(options.type!),
          }
        )
      } catch {
        return refuse("backend")
      }
      if (
        !Array.isArray(next) ||
        next.length > 10_000 ||
        next.some(
          (value) =>
            typeof value !== "string" ||
            !fullMatch(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, value)
        ) ||
        next.includes(options.type!) !== desired
      )
        refuse("backend")
      return {
        ...header,
        result: {
          status: desired ? ("archived" as const) : ("reactivated" as const),
          archivedTypes: [...new Set(next as string[])].sort(),
        },
      }
    }
    if (options.command !== "list" && options.command !== "detail")
      return await modelCommand(
        options,
        root,
        loader,
        token,
        transport,
        current.slices[0],
        specJson
      )
    return {
      command: options.command,
      application: { appUrl: options.appUrl, backendUrl: options.backendUrl },
      authentication: "installation-owner" as const,
      backendCatalogCoherence: "exact-contract-state" as const,
      backendContractStateVersion: current.contractState.version,
      catalogSourceRevision: current.catalogSourceRevision,
      settingsId: backend.settingsId,
      registeredTypes: current.registeredTypes,
      installedTypes: current.installedTypes,
      backendArchivedTypes: [...new Set(archived as string[])].sort(),
      slices: current.slices.map((slice) => ({
        ...slice,
        backendArchived: archived.includes(slice.manifest.type),
      })),
    }
  } finally {
    await loader.unregister()
  }
}

export async function runSliceAuthoringRead(
  args: readonly string[],
  entrypointPath: string,
  transport: SliceAuthoringReadTransport
) {
  parseSliceAuthoringReadArgs(args)
  const result = await runSliceAuthoringCommand(args, entrypointPath, transport)
  if (!isReadResult(result)) refuse("arguments")
  return result
}

type SliceAuthoringCommandResult = Awaited<
  ReturnType<typeof runSliceAuthoringCommand>
>
type SliceAuthoringReadResult = Extract<
  SliceAuthoringCommandResult,
  { slices: readonly unknown[] }
>

function isReadResult(
  result: SliceAuthoringCommandResult
): result is SliceAuthoringReadResult {
  return (
    (result.command === "list" || result.command === "detail") &&
    "slices" in result &&
    Array.isArray(result.slices)
  )
}

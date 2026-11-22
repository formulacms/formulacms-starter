import { createHash, randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { lstat, open, realpath, rename, rm } from "node:fs/promises"
import { join, resolve } from "node:path"
import { createInterface } from "node:readline/promises"
import { Writable } from "node:stream"
import { ConvexHttpClient } from "convex/browser"
import { ConvexError } from "convex/values"
import { pathToFileURL } from "node:url"
import { register, type NamespacedUnregister } from "tsx/esm/api"
import { parseConfigFileTextToJson } from "typescript"
import { api } from "../../convex/_generated/api.js"
import { findSourceRepositoryAtOrAbove } from "./source-repository"

// The CLI's own Convex Auth session, kept in the app root and git-ignored.
// Only the tokens are stored; the password never is.
const SESSION_FILE = ".block-authoring-session.json"
const SESSION_LOCK_FILE = ".block-authoring-session.lock"
const SESSION_FORMAT = "formulacms.block-authoring-session"
const MAX_SESSION_BYTES = 16_384
// A backend call must finish while its access token is still valid
// (tokens last 60 seconds, convex/auth.ts). Renew one with less time left.
const MIN_TOKEN_LIFETIME_MS = 20_000
const MAX_RECORD_BYTES = 1_048_576
const REQUEST_TIMEOUT_MS = 10_000

const REFUSALS = {
  arguments:
    "Use a supported command with explicit app root, app URL and backend URL.",
  target:
    "Both targets must be HTTP loopback origins with explicit nonprivileged local ports.",
  production: "Block authoring is only supported in local development.",
  application:
    "Run block authoring from your own site's folder, not from another folder or the formulacms source repository.",
  signedOut:
    "This app has no block authoring sign-in for that backend. Run the sign-in command first: pnpm blocks:author login --app-root <app> --backend-url <backend>",
  expired:
    "The block authoring sign-in has ended. Run the sign-in command again: pnpm blocks:author login --app-root <app> --backend-url <backend>",
  session: `The sign-in file ${SESSION_FILE} must be a regular file owned by you and readable only by you, without symlinks or hard links. Run the sign-in command again.`,
  busy: `Another block authoring command is running in this app (lock file ${SESSION_LOCK_FILE}). Wait for it to finish. Delete that file only when no block authoring command is running.`,
  credentials: "Wrong username or password.",
  rateLimited:
    "Too many sign-in attempts for this account. Wait a minute, then try again.",
  authentication:
    "The backend did not complete the sign-in. Check that the local backend is running, then try again.",
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

export class BlockAuthoringCliRefusal extends Error {
  constructor(readonly code: keyof typeof REFUSALS) {
    super(REFUSALS[code])
  }
}

function refuse(code: keyof typeof REFUSALS): never {
  throw new BlockAuthoringCliRefusal(code)
}

/** Never forward provider, filesystem or argument errors that could contain credentials. */
export function blockAuthoringFailure(error: unknown): string {
  return error instanceof BlockAuthoringCliRefusal
    ? error.message
    : "Block authoring refused."
}

export type BlockAuthoringOptions = {
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

export function parseBlockAuthoringArgs(
  args: readonly string[]
): BlockAuthoringOptions {
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
  const required = ["--app-root", "--app-url", "--backend-url"]
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
  const values = parseFlags(args, index, required)
  if (
    values.has("--expected-revision") &&
    !fullMatch(/^[a-f0-9]{64}$/, values.get("--expected-revision")!)
  )
    refuse("arguments")
  return {
    command,
    type,
    appRoot: values.get("--app-root")!,
    appUrl: localOrigin(values.get("--app-url")!),
    backendUrl: localOrigin(values.get("--backend-url")!),
    specFile: values.get("--spec-file"),
    operationsFile: values.get("--operations-file"),
    expectedRevision: values.get("--expected-revision"),
  }
}

/** Exactly the required flags, each once, each with a value. */
function parseFlags(
  args: readonly string[],
  start: number,
  required: readonly string[]
): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = start; index < args.length; index += 2) {
    const flag = args[index]
    const value = args[index + 1]
    if (
      !required.includes(flag) ||
      values.has(flag) ||
      !value ||
      value.startsWith("--")
    )
      refuse("arguments")
    values.set(flag, value)
  }
  if (required.some((flag) => !values.has(flag))) refuse("arguments")
  return values
}

export function parseBlockAuthoringSessionArgs(args: readonly string[]) {
  const command = args[0]
  if (command !== "login" && command !== "logout") refuse("arguments")
  const values = parseFlags(args, 1, ["--app-root", "--backend-url"])
  return {
    command,
    appRoot: values.get("--app-root")!,
    backendUrl: localOrigin(values.get("--backend-url")!),
  }
}

/** Compatibility read parser: write admission is only through the command dispatcher. */
export function parseBlockAuthoringReadArgs(args: readonly string[]) {
  const options = parseBlockAuthoringArgs(args)
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
 * The one check that a folder may run the CLI: not in production, this folder's own entry script, and
 * no formulacms source repository at or above it. Any site qualifies, cloned or created; the creation
 * receipt is not read. It does not authenticate a backend or attest provenance. */
export async function assertBlockAuthoringApplication(
  appRoot: string,
  entrypointPath: string
): Promise<string> {
  if (process.env.NODE_ENV === "production") refuse("production")
  try {
    const root = await realpath(resolve(appRoot))
    if (
      (await realpath(entrypointPath)) !==
      join(root, "scripts/author-blocks.ts")
    )
      refuse("application")
    if (findSourceRepositoryAtOrAbove(root) !== null) refuse("application")
    return root
  } catch (error) {
    if (error instanceof BlockAuthoringCliRefusal) throw error
    return refuse("application")
  }
}

async function readProtectedDataFile(
  path: string,
  limit: number,
  code: "session" | "spec" | "operations"
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

type StoredSession = {
  backendUrl: string
  accessToken: string
  refreshToken: string
  refreshTokenExpiresAt: number
}

/** Returns an access token valid for at least MIN_TOKEN_LIFETIME_MS. */
type SessionToken = () => Promise<string>

function isAccessToken(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= MAX_SESSION_BYTES &&
    fullMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/, value)
  )
}

/** Reads a Convex Auth token bundle; only its tokens and expiry are kept. */
function tokenBundle(
  value: unknown,
  backendUrl: string
): StoredSession | undefined {
  if (!value || typeof value !== "object") return undefined
  const { accessToken, refreshToken, refreshTokenExpiresAt } = value as Record<
    string,
    unknown
  >
  if (
    !isAccessToken(accessToken) ||
    typeof refreshToken !== "string" ||
    refreshToken.length > MAX_SESSION_BYTES ||
    !fullMatch(/^[\x21-\x7e]+$/, refreshToken) ||
    typeof refreshTokenExpiresAt !== "number" ||
    !Number.isFinite(refreshTokenExpiresAt)
  )
    return undefined
  return { backendUrl, accessToken, refreshToken, refreshTokenExpiresAt }
}

/** Milliseconds left before the access token's `exp`; negative when unknown. */
function accessTokenLifetimeMs(token: string): number {
  try {
    const { exp } = JSON.parse(
      Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8")
    ) as { exp?: unknown }
    return typeof exp === "number" ? exp * 1000 - Date.now() : -1
  } catch {
    return -1
  }
}

/** The saved session, or undefined when the app has none. */
async function readSession(root: string): Promise<StoredSession | undefined> {
  const path = join(root, SESSION_FILE)
  try {
    await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
    refuse("session")
  }
  let saved: Record<string, unknown> | undefined
  try {
    saved = JSON.parse(
      await readProtectedDataFile(path, MAX_SESSION_BYTES, "session")
    ) as Record<string, unknown>
  } catch {
    refuse("session")
  }
  const session =
    saved?.format === SESSION_FORMAT && typeof saved.backendUrl === "string"
      ? tokenBundle(saved, saved.backendUrl)
      : undefined
  if (!session) refuse("session")
  return session
}

/** Replaces the session file atomically: a private temp file, then rename. */
async function writeSession(root: string, session: StoredSession) {
  const temp = join(root, `${SESSION_FILE}.${randomUUID()}.tmp`)
  try {
    const file = await open(
      temp,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    )
    try {
      await file.writeFile(
        `${JSON.stringify({ format: SESSION_FORMAT, ...session }, null, 2)}\n`
      )
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, join(root, SESSION_FILE))
  } catch {
    await rm(temp, { force: true })
    refuse("session")
  }
}

async function deleteSession(root: string) {
  try {
    await rm(join(root, SESSION_FILE), { force: true })
  } catch {
    refuse("session")
  }
}

/**
 * One CLI process at a time, so two commands never spend one refresh token.
 * Any existing lock refuses: a command never removes a lock it did not
 * create. A lock left by a killed command is removed by hand (REFUSALS.busy).
 */
async function withSessionLock<T>(
  root: string,
  run: () => Promise<T>
): Promise<T> {
  const path = join(root, SESSION_LOCK_FILE)
  let file: Awaited<ReturnType<typeof open>>
  try {
    file = await open(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600
    )
  } catch (error) {
    return refuse(
      (error as NodeJS.ErrnoException).code === "EEXIST" ? "busy" : "session"
    )
  }
  // From here on this process owns the lock and must release it.
  let created: number | undefined
  try {
    try {
      created = (await file.stat()).ino
      await file.writeFile(`${process.pid}\n`)
    } finally {
      await file.close()
    }
    return await run()
  } finally {
    // Release only the lock file this process created.
    const current = await lstat(path).catch(() => undefined)
    if (current && (created === undefined || current.ino === created))
      await rm(path, { force: true })
  }
}

/**
 * Hands out the session's access token, renewing it first when it has under
 * MIN_TOKEN_LIFETIME_MS left. Convex Auth rotates the refresh token on every
 * renewal; the new bundle is saved before its token is used. The presented
 * refresh token stays valid until its successor is first used, so a failed
 * save leaves the old file usable.
 */
function sessionToken(
  root: string,
  transport: BlockAuthoringReadTransport,
  initial: StoredSession
): SessionToken {
  let session = initial
  const renew = async (): Promise<StoredSession> => {
    if (session.refreshTokenExpiresAt <= Date.now()) {
      await deleteSession(root)
      refuse("expired")
    }
    let result: unknown
    try {
      result = await transport.refresh(session.backendUrl, session.refreshToken)
    } catch {
      return refuse("authentication")
    }
    const outcome = result as { kind?: unknown; tokens?: unknown } | null
    if (outcome?.kind === "noSession") {
      await deleteSession(root)
      refuse("expired")
    }
    const next =
      outcome?.kind === "rotated"
        ? tokenBundle(outcome.tokens, session.backendUrl)
        : undefined
    if (
      !next ||
      accessTokenLifetimeMs(next.accessToken) < MIN_TOKEN_LIFETIME_MS
    )
      refuse("authentication")
    await writeSession(root, next)
    return next
  }
  let pending: Promise<StoredSession> | undefined
  return async () => {
    if (accessTokenLifetimeMs(session.accessToken) >= MIN_TOKEN_LIFETIME_MS)
      return session.accessToken
    pending ??= renew().finally(() => {
      pending = undefined
    })
    session = await pending
    return session.accessToken
  }
}

/** Narrow test transport. The real executable always constructs the normal user-token transport below. */
export type BlockAuthoringReadTransport = {
  /** `auth:refreshSession`: a Convex Auth `RefreshResult`. */
  refresh(backendUrl: string, refreshToken: string): Promise<unknown>
  /** `auth:signInWithUsernamePassword`: a sign-in result. */
  signIn?(
    backendUrl: string,
    username: string,
    password: string
  ): Promise<unknown>
  /** `auth:signOut`: ends the session the refresh token belongs to. */
  signOut?(backendUrl: string, refreshToken: string): Promise<unknown>
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

export function createBlockAuthoringReadTransport(): BlockAuthoringReadTransport {
  const clientFor = (backendUrl: string, token?: string) => {
    const client = new ConvexHttpClient(backendUrl, {
      skipConvexDeploymentUrlCheck: true,
      fetch: (input, init) =>
        fetch(input, {
          ...init,
          redirect: "error",
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        }),
    })
    if (token) client.setAuth(token)
    return client
  }
  return {
    setArchived: (backendUrl, token, type, archived, expectedState) =>
      clientFor(backendUrl, token).mutation(
        api.cms.blockLibrary.setBlockArchived,
        {
          type,
          archived,
          expectedState,
        }
      ),
    refresh: (backendUrl, refreshToken) =>
      clientFor(backendUrl).mutation(api.auth.refreshSession, { refreshToken }),
    signIn: (backendUrl, username, password) =>
      clientFor(backendUrl).mutation(api.auth.signInWithUsernamePassword, {
        username,
        password,
      }),
    signOut: (backendUrl, refreshToken) =>
      clientFor(backendUrl).mutation(api.auth.signOut, { refreshToken }),
    owner: (backendUrl, token) =>
      clientFor(backendUrl, token).query(api.cms.owner.getOwnerSession, {}),
    state: (backendUrl, token) =>
      clientFor(backendUrl, token).query(
        api.cms.blocks.getBlockAuthoringState,
        {}
      ),
    usage: (backendUrl, token, type, forRetirement) =>
      clientFor(backendUrl, token).query(
        api.cms.blockLibrary.getBlockUsageSummary,
        { type, ...(forRetirement ? { forRetirement: true as const } : {}) }
      ),
    retirementAllowed: (backendUrl, token, type) =>
      clientFor(backendUrl, token).query(
        api.cms.blockLibrary.assertBlockTypeRetirementAllowed,
        { type }
      ),
    cleanupArchive: (backendUrl, token, type) =>
      clientFor(backendUrl, token).mutation(
        api.cms.blockLibrary.cleanupDeletedBlockTypeArchive,
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
    pathToFileURL(join(root, "scripts/author-blocks.ts")).href
  ) as Promise<T>
}

async function localTypes(
  root: string,
  type: string | undefined,
  loader: NamespacedUnregister
) {
  try {
    const { assertAuthoringPaths } = await appModule<
      typeof import("../../lib/blocks/authoring/paths")
    >(root, loader, "lib/blocks/authoring/paths.ts")
    assertAuthoringPaths(root, [join(root, "lib/blocks/blocks.manifest.json")])
    const [{ readManifest }, { readBlockModelSourceRevision }] =
      await Promise.all([
        appModule<typeof import("../../lib/blocks/authoring/registration")>(
          root,
          loader,
          "lib/blocks/authoring/registration.ts"
        ),
        appModule<
          typeof import("../../lib/blocks/authoring/model-source-revision")
        >(root, loader, "lib/blocks/authoring/model-source-revision.ts"),
      ])
    const manifest = await readManifest(root)
    const selected = manifest.filter((entry) => !type || entry.type === type)
    // A scoped loader caches its compiled modules. Freeze the finite catalog
    // inputs independently so a changed non-selected descriptor or shared field
    // source cannot leave a stale compiled frame looking current after auth.
    const sharedPaths = [
      "convex/lib/blocks/index.ts",
      "convex/lib/blocks/fields.ts",
      "convex/lib/blocks/primitives.ts",
      "convex/lib/blocks/occurrencePresentation.ts",
      "convex/lib/blocks/authoringState.ts",
      "convex/lib/definitions/blocks.ts",
      "convex/lib/definitions/common.ts",
      "convex/lib/richtext/build.ts",
      "convex/lib/richtext/contracts.ts",
      "convex/lib/richtext/emptiness.ts",
      "convex/lib/richtext/profiles.ts",
      "convex/lib/pages/types.ts",
      "lib/blocks/authoring/registration.ts",
      "lib/blocks/authoring/model-source-revision.ts",
      "lib/blocks/authoring/despec.ts",
      "lib/blocks/authoring/scaffold.ts",
      "lib/blocks/authoring/naming.ts",
      "lib/blocks/authoring/paths.ts",
      "lib/blocks/icon-names.ts",
    ]
    const revisionPaths = [
      "lib/blocks/builder.ts",
      "lib/blocks/blocks.manifest.json",
      ...manifest.flatMap(({ type: registeredType }) => [
        `convex/lib/blocks/${registeredType.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())}.ts`,
        `components/blocks/${registeredType}.tsx`,
      ]),
      ...sharedPaths,
    ].map((path) => join(root, path))
    const catalogRevision = async () => {
      assertAuthoringPaths(root, revisionPaths)
      const revisions = await Promise.all(
        manifest.map((entry) => readBlockModelSourceRevision(entry.type, root))
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
      { REGISTERED_BLOCK_TYPES, INSTALLED_BLOCK_TYPES },
      { blockTypeToSpec },
      compiledManifest,
      { blockAuthoringContractState },
    ] = await Promise.all([
      appModule<typeof import("../../convex/lib/blocks")>(
        root,
        loader,
        "convex/lib/blocks/index.ts"
      ),
      appModule<typeof import("../../lib/blocks/authoring/despec")>(
        root,
        loader,
        "lib/blocks/authoring/despec.ts"
      ),
      appModule<{
        default: typeof import("../../lib/blocks/blocks.manifest.json")
      }>(root, loader, "lib/blocks/blocks.manifest.json"),
      appModule<typeof import("../../convex/lib/blocks/authoringState")>(
        root,
        loader,
        "convex/lib/blocks/authoringState.ts"
      ),
    ])
    const registeredTypes: string[] = [...REGISTERED_BLOCK_TYPES]
    const installedTypes: string[] = [...INSTALLED_BLOCK_TYPES]
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
    const blocks = await Promise.all(
      selected.map(async (entry) => ({
        manifest: entry,
        registered: true,
        installed: installedTypes.includes(entry.type),
        origin: entry.origin ?? "system",
        sourceRevision: await readBlockModelSourceRevision(entry.type, root),
        ...(type
          ? {
              spec: blockTypeToSpec(
                entry.type as (typeof REGISTERED_BLOCK_TYPES)[number]
              ),
            }
          : {}),
      }))
    )
    if ((await catalogRevision()) !== catalogSourceRevision) refuse("source")
    return {
      registeredTypes,
      installedTypes,
      blocks,
      contractState: blockAuthoringContractState(),
      catalogSourceRevision,
    }
  } catch {
    return refuse("source")
  }
}

async function creationCommand(
  options: BlockAuthoringOptions,
  root: string,
  loader: NamespacedUnregister,
  current: Awaited<ReturnType<typeof localTypes>>,
  specJson: string
) {
  const service = await appModule<
    typeof import("../../lib/blocks/authoring/create-model-service")
  >(root, loader, "lib/blocks/authoring/create-model-service.ts")
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
  let review: Awaited<ReturnType<typeof service.reviewBlockModelCreation>>
  try {
    review = await service.reviewBlockModelCreation(
      request,
      { readCatalog },
      root
    )
  } catch (error) {
    if (error instanceof BlockAuthoringCliRefusal) throw error
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
    typeof import("../../lib/blocks/authoring/gate")
  >(root, loader, "lib/blocks/authoring/gate.ts")
  try {
    return {
      ...header,
      result: await service.createReviewedBlockModel(
        { ...request, specJson: review.normalizedSpecJson },
        {
          readCatalog,
          runCreationGate: (type, selectedRoot) =>
            gate.runBlockGate(type, selectedRoot),
        },
        root
      ),
    }
  } catch (error) {
    if (error instanceof BlockAuthoringCliRefusal) throw error
    return refuse("operation")
  }
}

function authoritativeUsage(
  value: unknown
): import("../../lib/blocks/authoring/service").BlockRetirementUsage {
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
  return usage as import("../../lib/blocks/authoring/service").BlockRetirementUsage
}

async function modelCommand(
  options: BlockAuthoringOptions,
  root: string,
  loader: NamespacedUnregister,
  token: SessionToken,
  transport: BlockAuthoringReadTransport,
  current: Awaited<ReturnType<typeof localTypes>>["blocks"][number],
  specJson?: string
) {
  const type = options.type!
  let normalizedSpecJson: string | undefined
  let changes:
    import("../../lib/blocks/authoring/spec-diff").SpecFieldChange[] | undefined
  if (options.command !== "delete") {
    try {
      const { parseBlockSpecJson } = await appModule<
        typeof import("../../lib/blocks/authoring/persist")
      >(root, loader, "lib/blocks/authoring/persist.ts")
      const { diffBlockSpecs } = await appModule<
        typeof import("../../lib/blocks/authoring/spec-diff")
      >(root, loader, "lib/blocks/authoring/spec-diff.ts")
      const spec = parseBlockSpecJson(specJson!)
      if (spec.type !== type || !current.spec) refuse("spec")
      normalizedSpecJson = JSON.stringify(spec, null, 2)
      changes = diffBlockSpecs(current.spec, spec)
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
    typeof import("../../lib/blocks/authoring/service")
  >(root, loader, "lib/blocks/authoring/service.ts")
  const gate = await appModule<
    typeof import("../../lib/blocks/authoring/gate")
  >(root, loader, "lib/blocks/authoring/gate.ts")
  const reviewed = {
    expectedType: type,
    expectedSourceRevision: options.expectedRevision!,
  }
  try {
    const result =
      options.command === "update-model"
        ? await service.updateBlockModel(
            { ...reviewed, specJson: normalizedSpecJson! },
            {
              readUsage: async (target) => {
                if (!transport.usage) refuse("backend")
                return authoritativeUsage(
                  await transport.usage(
                    options.backendUrl,
                    await token(),
                    target,
                    false
                  )
                )
              },
              runModelGate: (target, selectedRoot) =>
                gate.runBlockGate(target, selectedRoot),
            },
            root
          )
        : await service.deleteReviewedBlockModel(
            reviewed,
            {
              assertRetirementAllowed: async (target) => {
                if (!transport.retirementAllowed) refuse("backend")
                return transport.retirementAllowed(
                  options.backendUrl,
                  await token(),
                  target
                )
              },
              readRetirementUsage: async (target) => {
                if (!transport.usage) refuse("backend")
                // This endpoint itself checks the current owner, retirement permission
                // and publication references. It is the final backend read before writes.
                return authoritativeUsage(
                  await transport.usage(
                    options.backendUrl,
                    await token(),
                    target,
                    true
                  )
                )
              },
              cleanupArchive: async (target) => {
                if (!transport.cleanupArchive) refuse("backend")
                return transport.cleanupArchive(
                  options.backendUrl,
                  await token(),
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
              nextAction: `Recompile or push the changed source to the same ordinary local backend, then run retry-cleanup ${type} with the same explicit --app-root, --app-url and --backend-url options.`,
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
      error.data === "BLOCK_TYPE_REFERENCED_BY_PUBLICATION"
    )
      return {
        command: options.command,
        expectedType: type,
        result: {
          status: "blocked" as const,
          reason: "publication_references" as const,
        },
      }
    if (error instanceof service.BlockSourceConflictError)
      return {
        command: options.command,
        expectedType: type,
        result: { status: "refused" as const, reason: "stale_source" as const },
      }
    if (error instanceof BlockAuthoringCliRefusal) throw error
    return refuse("operation")
  }
}

async function rendererCommand(
  options: BlockAuthoringOptions,
  root: string,
  entrypointPath: string,
  loader: NamespacedUnregister,
  token: SessionToken,
  transport: BlockAuthoringReadTransport,
  current: Awaited<ReturnType<typeof localTypes>>,
  owner: { ownerId: string; authId: string },
  backend: Record<string, unknown>,
  configText: string,
  operationsJson: string
) {
  const service = await appModule<
    typeof import("../../lib/blocks/authoring/renderer-service")
  >(root, loader, "lib/blocks/authoring/renderer-service.ts")
  const gate = await appModule<
    typeof import("../../lib/blocks/authoring/gate")
  >(root, loader, "lib/blocks/authoring/gate.ts")
  const request = {
    expectedType: options.type!,
    expectedSourceRevision:
      options.expectedRevision ?? current.blocks[0].sourceRevision,
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
        (await assertBlockAuthoringApplication(root, entrypointPath)) !== root
      )
        refuse("application")
      if (!transport.usage) refuse("backend")
      let usage: import("../../lib/blocks/authoring/service").BlockRetirementUsage
      try {
        usage = authoritativeUsage(
          await transport.usage(options.backendUrl, await token(), type, false)
        )
      } catch (error) {
        if (error instanceof BlockAuthoringCliRefusal) throw error
        refuse("backend")
      }
      // Usage itself follows normal permissions. Bind it to a fresh ordinary
      // installation-owner identity and exact backend contract after its await.
      let nextOwner: unknown
      const ownerToken = await token()
      try {
        nextOwner = await transport.owner(options.backendUrl, ownerToken)
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
      const stateToken = await token()
      try {
        nextState = await transport.state(options.backendUrl, stateToken)
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
        (await assertBlockAuthoringApplication(root, entrypointPath)) !== root
      )
        refuse("application")
      if ((await appConfig(root)) !== configText) refuse("configuration")
      const fresh = await localTypes(root, type, loader)
      if (JSON.stringify(fresh) !== JSON.stringify(current)) refuse("source")
      return usage
    },
    runRendererGate: (type: string, selectedRoot: string) =>
      gate.runBlockGate(type, selectedRoot),
  }
  try {
    return {
      command: options.command,
      expectedType: options.type!,
      preconditionBackendCatalogCoherence: "exact-contract-state" as const,
      sourceOwnership: {
        origin: current.blocks[0].origin,
        installed: current.blocks[0].installed,
        registered: current.blocks[0].registered,
        sharedLocalSourceEdit: true,
      },
      result:
        options.command === "review-renderer"
          ? await service.reviewBlockRendererUpdate(request, adapters, root)
          : await service.updateReviewedBlockRenderer(request, adapters, root),
    }
  } catch (error) {
    if (error instanceof BlockAuthoringCliRefusal) throw error
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
      typeof import("../../lib/blocks/authoring/paths")
    >(root, loader, "lib/blocks/authoring/paths.ts")
    const paths = [
      join(
        root,
        `convex/lib/blocks/${type.replace(/-([a-z])/g, (_, char: string) => char.toUpperCase())}.ts`
      ),
      join(root, `components/blocks/${type}.tsx`),
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
    if (error instanceof BlockAuthoringCliRefusal) throw error
    return refuse("source")
  }
}

async function retryCleanup(
  options: BlockAuthoringOptions,
  archivedTypes: readonly string[],
  token: SessionToken,
  transport: BlockAuthoringReadTransport
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
  const accessToken = await token()
  try {
    next = await transport.cleanupArchive(options.backendUrl, accessToken, type)
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

export async function runBlockAuthoringCommand(
  args: readonly string[],
  entrypointPath: string,
  transport: BlockAuthoringReadTransport
) {
  if (process.env.NODE_ENV === "production") refuse("production")
  if (process.env.TSX_TSCONFIG_PATH) refuse("configuration")
  const options = parseBlockAuthoringArgs(args)
  const root = await assertBlockAuthoringApplication(
    options.appRoot,
    entrypointPath
  )
  return withSessionLock(root, () =>
    lockedCommand(options, root, entrypointPath, transport)
  )
}

async function lockedCommand(
  options: BlockAuthoringOptions,
  root: string,
  entrypointPath: string,
  transport: BlockAuthoringReadTransport
) {
  const session = await readSession(root)
  if (!session || session.backendUrl !== options.backendUrl) refuse("signedOut")
  const token = sessionToken(root, transport, session)
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
    let owner: unknown
    const ownerToken = await token()
    try {
      owner = await transport.owner(options.backendUrl, ownerToken)
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
    const stateToken = await token()
    try {
      state = await transport.state(options.backendUrl, stateToken)
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
      if (current.blocks[0]?.sourceRevision !== options.expectedRevision)
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
      const accessToken = await token()
      try {
        next = await transport.setArchived(
          options.backendUrl,
          accessToken,
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
        current.blocks[0],
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
      blocks: current.blocks.map((block) => ({
        ...block,
        backendArchived: archived.includes(block.manifest.type),
      })),
    }
  } finally {
    await loader.unregister()
  }
}

export type BlockAuthoringCredentials = () => Promise<{
  username: string
  password: string
}>

/**
 * `login` signs the CLI in with its own Convex Auth session and saves only
 * the returned tokens. `logout` ends that session and deletes the file. The
 * browser session is never touched.
 */
export async function runBlockAuthoringSessionCommand(
  args: readonly string[],
  entrypointPath: string,
  transport: BlockAuthoringReadTransport,
  credentials: BlockAuthoringCredentials
) {
  if (process.env.NODE_ENV === "production") refuse("production")
  const { command, appRoot, backendUrl } = parseBlockAuthoringSessionArgs(args)
  const root = await assertBlockAuthoringApplication(appRoot, entrypointPath)
  if (command === "logout")
    return withSessionLock(root, async () => {
      let session: StoredSession | undefined
      try {
        session = await readSession(root)
      } catch {
        session = undefined
      }
      let backendSessionEnded = false
      if (session?.backendUrl === backendUrl && transport.signOut) {
        try {
          await transport.signOut(backendUrl, session.refreshToken)
          backendSessionEnded = true
        } catch {
          backendSessionEnded = false
        }
      }
      await deleteSession(root)
      return { command, status: "signed_out" as const, backendSessionEnded }
    })
  // Ask before taking the lock, so an interrupted prompt leaves none behind.
  let username: string
  let password: string
  try {
    ;({ username, password } = await credentials())
  } catch {
    return refuse("credentials")
  }
  if (!username || !password) refuse("credentials")
  return withSessionLock(root, async () => {
    let previous: StoredSession | undefined
    try {
      previous = await readSession(root)
    } catch {
      previous = undefined
    }
    if (!transport.signIn) refuse("authentication")
    let result: unknown
    try {
      result = await transport.signIn(backendUrl, username, password)
    } catch (error) {
      // `convex/users.ts` refuses a disabled account with a ConvexError.
      return refuse(
        error instanceof ConvexError ? "credentials" : "authentication"
      )
    }
    const outcome = result as {
      status?: unknown
      tokens?: unknown
      userError?: { error?: unknown }
    } | null
    if (
      outcome?.status === "error" &&
      outcome.userError?.error === "RATE_LIMITED"
    )
      refuse("rateLimited")
    if (outcome?.status !== "complete") refuse("credentials")
    const session = tokenBundle(outcome.tokens, backendUrl)
    if (!session) refuse("authentication")
    await writeSession(root, session)
    // A new sign-in replaces the old one; end the old session too.
    if (previous?.backendUrl === backendUrl && transport.signOut)
      await transport
        .signOut(backendUrl, previous.refreshToken)
        .catch(() => null)
    return { command, status: "signed_in" as const, sessionFile: SESSION_FILE }
  })
}

/**
 * Asks for the username and the password on the terminal; the password is
 * not echoed. Piped input gives the username on the first line and the
 * password on the second, so an agent never puts it in arguments.
 */
export async function readTerminalCredentials(): Promise<{
  username: string
  password: string
}> {
  const input = process.stdin
  if (!input.isTTY) {
    const lines = createInterface({ input, terminal: false })
    const reader = lines[Symbol.asyncIterator]()
    const first = await reader.next()
    const second = await reader.next()
    lines.close()
    return {
      username: first.done ? "" : String(first.value).trim(),
      password: second.done ? "" : String(second.value),
    }
  }
  const ask = async (prompt: string, echo: boolean) => {
    // Prompts go to stderr so stdout stays the JSON result.
    const output = echo
      ? process.stderr
      : new Writable({ write: (_chunk, _encoding, done) => done() })
    const prompter = createInterface({ input, output, terminal: true })
    prompter.on("SIGINT", () => {
      prompter.close()
      process.stderr.write("\n")
      process.exit(130)
    })
    try {
      if (echo) return await prompter.question(prompt)
      process.stderr.write(prompt)
      const answer = await prompter.question("")
      process.stderr.write("\n")
      return answer
    } finally {
      prompter.close()
    }
  }
  const username = (await ask("Username: ", true)).trim()
  return { username, password: await ask("Password: ", false) }
}

export async function runBlockAuthoringRead(
  args: readonly string[],
  entrypointPath: string,
  transport: BlockAuthoringReadTransport
) {
  parseBlockAuthoringReadArgs(args)
  const result = await runBlockAuthoringCommand(args, entrypointPath, transport)
  if (!isReadResult(result)) refuse("arguments")
  return result
}

type BlockAuthoringCommandResult = Awaited<
  ReturnType<typeof runBlockAuthoringCommand>
>
type BlockAuthoringReadResult = Extract<
  BlockAuthoringCommandResult,
  { blocks: readonly unknown[] }
>

function isReadResult(
  result: BlockAuthoringCommandResult
): result is BlockAuthoringReadResult {
  return (
    (result.command === "list" || result.command === "detail") &&
    "blocks" in result &&
    Array.isArray(result.blocks)
  )
}

import { createHash, randomBytes } from "node:crypto"
import { constants } from "node:fs"
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  stat,
  unlink,
} from "node:fs/promises"
import os from "node:os"
import path from "node:path"

import { validateDecision } from "./contract.mjs"

const LOCK_ROOT = path.join(os.tmpdir(), "handoff-plus-locks")
const STATE_LOCK_NAME = ".handoff-plus.lock"
const STATE_FILE_NAME = "state.json"
const STATE_KEYS = [
  "version",
  "planHash",
  "workspace",
  "status",
  "taskIndex",
  "taskTurns",
  "taskRenewals",
  "totalTurns",
  "completed",
  "memory",
  "handoff",
  "message",
  "updatedAt",
]
const STATE_STATUSES = new Set([
  "ready",
  "running",
  "paused",
  "blocked",
  "complete",
])

function fail(message, cause) {
  throw new Error(message, cause === undefined ? undefined : { cause })
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== "..")
  )
}

async function ensurePrivateDirectory(directory) {
  let created = false
  try {
    await stat(directory)
  } catch (error) {
    if (error.code !== "ENOENT") throw error
    created = true
  }
  await mkdir(directory, { recursive: true, mode: 0o700 })
  if (created) await chmod(directory, 0o700)

  const directoryStat = await stat(directory)
  if (!directoryStat.isDirectory()) fail(`${directory} must be a directory`)
  if ((directoryStat.mode & 0o777) !== 0o700) {
    fail(`${directory} must be private (mode 0700)`)
  }
}

function ownerIsAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error.code === "ESRCH") return false
    if (error.code === "EPERM") return true
    throw error
  }
}

async function readLock(filename) {
  let source
  try {
    source = await readFile(filename, "utf8")
  } catch (error) {
    fail(`cannot inspect existing lock ${filename}: ${error.message}`, error)
  }
  let metadata
  try {
    metadata = JSON.parse(source)
  } catch (error) {
    fail(
      `existing lock ${filename} has invalid metadata; refusing recovery`,
      error
    )
  }
  if (
    metadata === null ||
    typeof metadata !== "object" ||
    typeof metadata.nonce !== "string" ||
    typeof metadata.pid !== "number"
  ) {
    fail(`existing lock ${filename} has invalid metadata; refusing recovery`)
  }
  return { source, metadata }
}

async function tryCreateLock(filename, metadata) {
  const nonce = randomBytes(16).toString("hex")
  const ownedMetadata = { ...metadata, pid: process.pid, nonce }
  let handle
  try {
    handle = await open(
      filename,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    )
  } catch (error) {
    if (error.code === "EEXIST") return null
    throw error
  }

  try {
    await handle.writeFile(`${JSON.stringify(ownedMetadata)}\n`, "utf8")
    await handle.sync()
    await handle.close()
    return { filename, nonce }
  } catch (error) {
    await handle.close().catch(() => {})
    await unlink(filename).catch(() => {})
    throw error
  }
}

async function acquireLock(filename, metadata, recoverLock) {
  const recoveryFilename = `${filename}.recover`
  try {
    await stat(recoveryFilename)
    fail(
      `lock recovery is already in progress or requires manual cleanup: ${recoveryFilename}`
    )
  } catch (error) {
    if (error.code !== "ENOENT") throw error
  }

  const acquired = await tryCreateLock(filename, metadata)
  if (acquired) return acquired

  const existing = await readLock(filename)
  const alive = ownerIsAlive(existing.metadata.pid)
  if (alive !== false) {
    fail(
      `lock is held by a live or unverifiable owner (pid ${existing.metadata.pid}): ${filename}`
    )
  }
  if (!recoverLock) {
    fail(
      `lock owner is dead; pass recoverLock: true to recover explicitly: ${filename}`
    )
  }

  // Serializing recovery closes the compare/unlink race between two explicit
  // recoverers. A stale recovery guard is deliberately never auto-removed.
  const recoveryGuard = await tryCreateLock(recoveryFilename, {
    kind: "recovery",
    target: filename,
  })
  if (!recoveryGuard) {
    fail(
      `lock recovery is already in progress or requires manual cleanup: ${recoveryFilename}`
    )
  }

  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      let current
      try {
        current = await readLock(filename)
      } catch (error) {
        if (error.cause?.code !== "ENOENT") throw error
      }

      if (current) {
        const currentAlive = ownerIsAlive(current.metadata.pid)
        if (currentAlive !== false) {
          fail(
            `lock is held by a live or unverifiable owner (pid ${current.metadata.pid}): ${filename}`
          )
        }
        await unlink(filename)
      }

      const recovered = await tryCreateLock(filename, metadata)
      if (recovered) return recovered
      // A normal acquirer may safely win the create race. The next iteration
      // observes that new owner and refuses to disturb it.
    }
    fail(`could not acquire lock after recovery races: ${filename}`)
  } finally {
    await releaseOwnedLock(recoveryGuard)
  }
}

async function releaseOwnedLock(lock) {
  if (!lock) return
  try {
    const { metadata } = await readLock(lock.filename)
    if (metadata.nonce === lock.nonce && metadata.pid === process.pid) {
      await unlink(lock.filename)
    }
  } catch (error) {
    if (error.code !== "ENOENT" && error.cause?.code !== "ENOENT") throw error
  }
}

function validatePersistedState(value, workspace, expectedPlanHash) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("state corruption: root must be an object")
  }
  const unknown = Object.keys(value).filter((key) => !STATE_KEYS.includes(key))
  if (unknown.length > 0) {
    fail(`state corruption: unknown field ${unknown[0]}`)
  }
  const missing = STATE_KEYS.filter((key) => !Object.hasOwn(value, key))
  if (missing.length > 0) {
    fail(`state corruption: missing field ${missing[0]}`)
  }
  if (value.version !== 1) fail("state corruption: version must be 1")
  if (value.workspace !== workspace)
    fail("state corruption: workspace identity mismatch")
  if (value.planHash !== expectedPlanHash)
    fail("state corruption: planHash mismatch")
  if (!STATE_STATUSES.has(value.status)) {
    fail(`state corruption: invalid status ${value.status}`)
  }
  for (const key of ["taskIndex", "taskTurns", "taskRenewals", "totalTurns"]) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 0) {
      fail(`state corruption: ${key} must be a nonnegative integer`)
    }
  }
  if (!Array.isArray(value.completed)) {
    fail("state corruption: completed must be an array")
  }
  if (value.completed.length !== value.taskIndex) {
    fail("state corruption: completed length must equal taskIndex")
  }
  const completedIds = new Set()
  for (const [index, completed] of value.completed.entries()) {
    if (
      completed === null ||
      typeof completed !== "object" ||
      Array.isArray(completed) ||
      Object.keys(completed).some(
        (key) => !["id", "summary", "checks"].includes(key)
      ) ||
      !Object.hasOwn(completed, "id") ||
      !Object.hasOwn(completed, "summary") ||
      !Object.hasOwn(completed, "checks")
    ) {
      fail(`state corruption: completed[${index}] has invalid shape`)
    }
    if (
      typeof completed.id !== "string" ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(completed.id) ||
      completedIds.has(completed.id)
    ) {
      fail(`state corruption: completed[${index}].id is invalid or duplicate`)
    }
    completedIds.add(completed.id)
    if (typeof completed.summary !== "string") {
      fail(`state corruption: completed[${index}].summary must be a string`)
    }
    if (!Array.isArray(completed.checks) || completed.checks.length === 0) {
      fail(
        `state corruption: completed[${index}].checks must be a nonempty array`
      )
    }
    for (const [checkIndex, check] of completed.checks.entries()) {
      const checkLabel = `completed[${index}].checks[${checkIndex}]`
      if (
        check === null ||
        typeof check !== "object" ||
        Array.isArray(check) ||
        Object.keys(check).some(
          (key) => !["command", "exitCode", "verifiedAt"].includes(key)
        ) ||
        !Object.hasOwn(check, "command") ||
        !Object.hasOwn(check, "exitCode") ||
        !Object.hasOwn(check, "verifiedAt")
      ) {
        fail(`state corruption: ${checkLabel} has invalid shape`)
      }
      if (
        !Array.isArray(check.command) ||
        check.command.length === 0 ||
        check.command.some(
          (argument) => typeof argument !== "string" || argument.length === 0
        )
      ) {
        fail(`state corruption: ${checkLabel}.command must be nonempty argv`)
      }
      if (check.exitCode !== 0) {
        fail(`state corruption: ${checkLabel}.exitCode must be 0`)
      }
      if (
        typeof check.verifiedAt !== "string" ||
        Number.isNaN(Date.parse(check.verifiedAt))
      ) {
        fail(
          `state corruption: ${checkLabel}.verifiedAt must be an ISO timestamp`
        )
      }
    }
  }
  if (value.memory !== null) {
    try {
      validateDecision(
        {
          taskId: "state-memory",
          decision: "task-complete",
          summary: "",
          blocker: "",
          memory: value.memory,
        },
        "state-memory"
      )
    } catch (error) {
      fail(`state corruption: invalid memory: ${error.message}`, error)
    }
  }
  for (const key of ["handoff", "message"]) {
    if (value[key] !== null && typeof value[key] !== "string") {
      fail(`state corruption: ${key} must be a string or null`)
    }
  }
  if (
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    fail("state corruption: updatedAt must be an ISO timestamp")
  }
}

function serializeState(value) {
  let serialized
  try {
    serialized = `${JSON.stringify(value, null, 2)}\n`
  } catch (error) {
    fail(`state is not JSON serializable: ${error.message}`, error)
  }
  if (serialized === undefined) fail("state is not JSON serializable")
  return serialized
}

async function atomicWrite(filename, contents) {
  const temporary = path.join(
    path.dirname(filename),
    `.${path.basename(filename)}.${process.pid}.${randomBytes(12).toString("hex")}.tmp`
  )
  let handle
  try {
    handle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    )
    await handle.writeFile(contents, "utf8")
    await handle.sync()
    await handle.close()
    handle = undefined
    await rename(temporary, filename)
  } catch (error) {
    if (handle) await handle.close().catch(() => {})
    await unlink(temporary).catch(() => {})
    throw error
  }
}

async function readState(filename, workspace, expectedPlanHash) {
  const stateStat = await stat(filename)
  if (!stateStat.isFile())
    fail("state corruption: state.json must be a regular file")
  if ((stateStat.mode & 0o777) !== 0o600)
    fail("state corruption: state.json must have mode 0600")

  let value
  try {
    value = JSON.parse(await readFile(filename, "utf8"))
  } catch (error) {
    fail(
      `state corruption: state.json is not valid JSON: ${error.message}`,
      error
    )
  }
  validatePersistedState(value, workspace, expectedPlanHash)
  return value
}

export async function openStore({
  stateDir,
  workspace,
  planHash,
  initialState,
  resume = false,
  recoverLock = false,
}) {
  if (typeof stateDir !== "string" || stateDir.length === 0)
    fail("stateDir must be a path")
  if (typeof workspace !== "string" || workspace.length === 0)
    fail("workspace must be a path")
  if (typeof planHash !== "string" || !/^[a-f0-9]{64}$/.test(planHash)) {
    fail("planHash must be a lowercase SHA-256 hex digest")
  }

  const canonicalWorkspace = await realpath(workspace)
  const workspaceStat = await stat(canonicalWorkspace)
  if (!workspaceStat.isDirectory()) fail("workspace must identify a directory")

  const resolvedStateDir = path.resolve(stateDir)
  if (isInside(canonicalWorkspace, resolvedStateDir)) {
    fail("stateDir must be outside workspace")
  }
  await ensurePrivateDirectory(resolvedStateDir)
  const canonicalStateDir = await realpath(resolvedStateDir)
  if (isInside(canonicalWorkspace, canonicalStateDir)) {
    fail("stateDir must resolve outside workspace")
  }

  await ensurePrivateDirectory(LOCK_ROOT)
  const workspaceDigest = createHash("sha256")
    .update(canonicalWorkspace)
    .digest("hex")
  const globalLockFilename = path.join(LOCK_ROOT, `${workspaceDigest}.lock`)
  const stateLockFilename = path.join(canonicalStateDir, STATE_LOCK_NAME)
  let globalLock
  let stateLock

  try {
    globalLock = await acquireLock(
      globalLockFilename,
      { kind: "workspace", workspace: canonicalWorkspace },
      recoverLock
    )
    stateLock = await acquireLock(
      stateLockFilename,
      {
        kind: "state",
        stateDir: canonicalStateDir,
        workspace: canonicalWorkspace,
      },
      recoverLock
    )

    const stateFilename = path.join(canonicalStateDir, STATE_FILE_NAME)
    let currentState
    if (resume) {
      try {
        currentState = await readState(
          stateFilename,
          canonicalWorkspace,
          planHash
        )
      } catch (error) {
        if (error.code === "ENOENT" || error.cause?.code === "ENOENT") {
          fail("cannot resume: state.json does not exist", error)
        }
        throw error
      }
    } else {
      try {
        await stat(stateFilename)
        fail("state.json already exists; pass resume: true to resume it")
      } catch (error) {
        if (error.code !== "ENOENT") throw error
      }
      validatePersistedState(initialState, canonicalWorkspace, planHash)
      const serialized = serializeState(initialState)
      await atomicWrite(stateFilename, serialized)
      currentState = JSON.parse(serialized)
    }

    let closed = false
    return {
      get state() {
        return structuredClone(currentState)
      },
      async save(nextState) {
        if (closed) fail("store is closed")
        validatePersistedState(nextState, canonicalWorkspace, planHash)
        const serialized = serializeState(nextState)
        await atomicWrite(stateFilename, serialized)
        currentState = JSON.parse(serialized)
      },
      async writeHandoff(markdown) {
        if (closed) fail("store is closed")
        if (typeof markdown !== "string") fail("handoff must be a string")
        const timestamp = new Date().toISOString().replaceAll(":", "-")
        const filename = path.join(
          canonicalStateDir,
          `handoff-${timestamp}-${randomBytes(8).toString("hex")}.md`
        )
        const handle = await open(
          filename,
          constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
          0o600
        )
        try {
          await handle.writeFile(markdown, "utf8")
          await handle.sync()
        } finally {
          await handle.close()
        }
        return filename
      },
      async close() {
        if (closed) return
        closed = true
        const errors = []
        await releaseOwnedLock(stateLock).catch((error) => errors.push(error))
        await releaseOwnedLock(globalLock).catch((error) => errors.push(error))
        if (errors.length > 0)
          throw new AggregateError(errors, "failed to release store locks")
      },
    }
  } catch (error) {
    await releaseOwnedLock(stateLock).catch(() => {})
    await releaseOwnedLock(globalLock).catch(() => {})
    throw error
  }
}

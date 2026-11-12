import { createHash } from "node:crypto"
import { readFile, realpath, stat } from "node:fs/promises"
import path from "node:path"

const PLAN_KEYS = [
  "version",
  "workspace",
  "goal",
  "constraints",
  "model",
  "effort",
  "tasks",
  "limits",
]
const TASK_KEYS = ["id", "instructions", "acceptance", "verify"]
const LIMIT_KEYS = [
  "maxTurnsPerTask",
  "maxRenewalsPerTask",
  "turnTimeoutMs",
  "checkpointTimeoutMs",
  "maxRunMs",
  "verificationTimeoutMs",
]
const DECISION_KEYS = ["taskId", "decision", "summary", "blocker", "memory"]
const MEMORY_KEYS = [
  "goalUnderstanding",
  "constraints",
  "decisions",
  "verified",
  "failedApproaches",
  "openQuestions",
  "nextAction",
]

const LIMIT_DEFAULTS = Object.freeze({
  maxTurnsPerTask: 12,
  maxRenewalsPerTask: 6,
  turnTimeoutMs: 600_000,
  checkpointTimeoutMs: 60_000,
  maxRunMs: 3_600_000,
  verificationTimeoutMs: 120_000,
})

const LIMIT_RANGES = Object.freeze({
  maxTurnsPerTask: [1, 100, true],
  maxRenewalsPerTask: [1, 100, true],
  turnTimeoutMs: [1_000, 3_600_000, true],
  checkpointTimeoutMs: [1_000, 300_000, true],
  maxRunMs: [1_000, 86_400_000, true],
  verificationTimeoutMs: [1_000, 1_800_000, true],
})

const DECISIONS = ["continue", "renew-context", "task-complete", "blocked"]
const DECISION_STRING_MAX = 8_000
const MEMORY_ARRAY_MAX = 100
const MEMORY_ITEM_MAX = 4_000
const DECISION_SERIALIZED_MAX = 32_768

const memorySchema = {
  type: "object",
  additionalProperties: false,
  required: MEMORY_KEYS,
  properties: {
    goalUnderstanding: { type: "string", maxLength: DECISION_STRING_MAX },
    constraints: {
      type: "array",
      maxItems: MEMORY_ARRAY_MAX,
      items: { type: "string", maxLength: MEMORY_ITEM_MAX },
    },
    decisions: {
      type: "array",
      maxItems: MEMORY_ARRAY_MAX,
      items: { type: "string", maxLength: MEMORY_ITEM_MAX },
    },
    verified: {
      type: "array",
      maxItems: MEMORY_ARRAY_MAX,
      items: { type: "string", maxLength: MEMORY_ITEM_MAX },
    },
    failedApproaches: {
      type: "array",
      maxItems: MEMORY_ARRAY_MAX,
      items: { type: "string", maxLength: MEMORY_ITEM_MAX },
    },
    openQuestions: {
      type: "array",
      maxItems: MEMORY_ARRAY_MAX,
      items: { type: "string", maxLength: MEMORY_ITEM_MAX },
    },
    nextAction: { type: "string", maxLength: DECISION_STRING_MAX },
  },
}

export const DECISION_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: DECISION_KEYS,
  properties: {
    taskId: { type: "string", minLength: 1, maxLength: 64 },
    decision: { type: "string", enum: DECISIONS },
    summary: { type: "string", maxLength: DECISION_STRING_MAX },
    blocker: { type: "string", maxLength: DECISION_STRING_MAX },
    memory: memorySchema,
  },
})

function fail(message) {
  throw new TypeError(message)
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function assertStrictObject(value, allowedKeys, label) {
  if (!isObject(value)) fail(`${label} must be an object`)
  const unknown = Object.keys(value).filter((key) => !allowedKeys.includes(key))
  if (unknown.length > 0) fail(`${label} has unknown field: ${unknown[0]}`)
}

function assertString(value, label, { nonempty = false, maxLength } = {}) {
  if (typeof value !== "string") fail(`${label} must be a string`)
  if (nonempty && value.trim().length === 0) fail(`${label} must not be empty`)
  if (maxLength !== undefined && value.length > maxLength) {
    fail(`${label} must be at most ${maxLength} characters`)
  }
  return value
}

function assertStringArray(
  value,
  label,
  { nonempty = false, maxItems, itemMaxLength } = {}
) {
  if (!Array.isArray(value)) fail(`${label} must be an array`)
  if (nonempty && value.length === 0) fail(`${label} must not be empty`)
  if (maxItems !== undefined && value.length > maxItems) {
    fail(`${label} must have at most ${maxItems} items`)
  }
  return value.map((item, index) =>
    assertString(item, `${label}[${index}]`, {
      nonempty: true,
      maxLength: itemMaxLength,
    })
  )
}

function validateLimits(value) {
  if (value === undefined) return { ...LIMIT_DEFAULTS }
  assertStrictObject(value, LIMIT_KEYS, "plan.limits")

  const result = { ...LIMIT_DEFAULTS }
  for (const key of LIMIT_KEYS) {
    if (value[key] === undefined) continue
    const [minimum, maximum, integer] = LIMIT_RANGES[key]
    const candidate = value[key]
    if (
      typeof candidate !== "number" ||
      !Number.isFinite(candidate) ||
      (integer && !Number.isInteger(candidate)) ||
      candidate < minimum ||
      candidate > maximum
    ) {
      const kind = integer ? "an integer" : "a number"
      fail(`plan.limits.${key} must be ${kind} from ${minimum} to ${maximum}`)
    }
    result[key] = candidate
  }
  return result
}

export function validatePlan(value) {
  assertStrictObject(value, PLAN_KEYS, "plan")
  if (value.version !== 1) fail("plan.version must be 1")
  assertString(value.workspace, "plan.workspace", { nonempty: true })
  if (!path.isAbsolute(value.workspace))
    fail("plan.workspace must be an absolute path")
  const goal = assertString(value.goal, "plan.goal", {
    nonempty: true,
    maxLength: 8_000,
  })
  const constraints = assertStringArray(value.constraints, "plan.constraints", {
    nonempty: true,
  })
  const model =
    value.model === undefined
      ? undefined
      : assertString(value.model, "plan.model", { nonempty: true })
  const effort =
    value.effort === undefined
      ? undefined
      : assertString(value.effort, "plan.effort", { nonempty: true })

  if (
    !Array.isArray(value.tasks) ||
    value.tasks.length === 0 ||
    value.tasks.length > 100
  ) {
    fail("plan.tasks must contain from 1 to 100 tasks")
  }

  const ids = new Set()
  const tasks = value.tasks.map((task, taskIndex) => {
    const label = `plan.tasks[${taskIndex}]`
    assertStrictObject(task, TASK_KEYS, label)
    const id = assertString(task.id, `${label}.id`, { nonempty: true })
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) {
      fail(`${label}.id must match /^[a-z0-9][a-z0-9-]{0,63}$/`)
    }
    if (ids.has(id)) fail(`${label}.id must be unique`)
    ids.add(id)

    const instructions = assertString(
      task.instructions,
      `${label}.instructions`,
      {
        nonempty: true,
        maxLength: 16_000,
      }
    )
    const acceptance = assertStringArray(
      task.acceptance,
      `${label}.acceptance`,
      {
        nonempty: true,
      }
    )
    if (!Array.isArray(task.verify) || task.verify.length === 0) {
      fail(`${label}.verify must contain at least one argv array`)
    }
    const verify = task.verify.map((argv, commandIndex) => {
      if (!Array.isArray(argv) || argv.length === 0) {
        fail(`${label}.verify[${commandIndex}] must be a nonempty argv array`)
      }
      return argv.map((argument, argumentIndex) =>
        assertString(
          argument,
          `${label}.verify[${commandIndex}][${argumentIndex}]`,
          {
            nonempty: true,
          }
        )
      )
    })

    return { id, instructions, acceptance, verify }
  })

  const normalized = {
    version: 1,
    workspace: value.workspace,
    goal,
    constraints,
    tasks,
    limits: validateLimits(value.limits),
  }
  if (model !== undefined) normalized.model = model
  if (effort !== undefined) normalized.effort = effort
  return normalized
}

export async function loadPlan(filename) {
  const source = await readFile(filename, "utf8")
  let parsed
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new TypeError(`plan file is not valid JSON: ${error.message}`, {
      cause: error,
    })
  }

  const plan = validatePlan(parsed)
  let canonicalWorkspace
  try {
    canonicalWorkspace = await realpath(plan.workspace)
    const workspaceStat = await stat(canonicalWorkspace)
    if (!workspaceStat.isDirectory())
      fail("plan.workspace must identify a directory")
  } catch (error) {
    if (error instanceof TypeError) throw error
    throw new TypeError(
      `plan.workspace cannot be resolved as a directory: ${error.message}`,
      {
        cause: error,
      }
    )
  }

  return { ...plan, workspace: canonicalWorkspace }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize)
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonicalize(value[key])])
    )
  }
  return value
}

export function planHash(plan) {
  const normalized = validatePlan(plan)
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(normalized)))
    .digest("hex")
}

function validateMemory(value) {
  assertStrictObject(value, MEMORY_KEYS, "decision.memory")
  const result = {
    goalUnderstanding: assertString(
      value.goalUnderstanding,
      "decision.memory.goalUnderstanding",
      {
        maxLength: DECISION_STRING_MAX,
      }
    ),
    constraints: assertStringArray(
      value.constraints,
      "decision.memory.constraints",
      {
        maxItems: MEMORY_ARRAY_MAX,
        itemMaxLength: MEMORY_ITEM_MAX,
      }
    ),
    decisions: assertStringArray(value.decisions, "decision.memory.decisions", {
      maxItems: MEMORY_ARRAY_MAX,
      itemMaxLength: MEMORY_ITEM_MAX,
    }),
    verified: assertStringArray(value.verified, "decision.memory.verified", {
      maxItems: MEMORY_ARRAY_MAX,
      itemMaxLength: MEMORY_ITEM_MAX,
    }),
    failedApproaches: assertStringArray(
      value.failedApproaches,
      "decision.memory.failedApproaches",
      { maxItems: MEMORY_ARRAY_MAX, itemMaxLength: MEMORY_ITEM_MAX }
    ),
    openQuestions: assertStringArray(
      value.openQuestions,
      "decision.memory.openQuestions",
      {
        maxItems: MEMORY_ARRAY_MAX,
        itemMaxLength: MEMORY_ITEM_MAX,
      }
    ),
    nextAction: assertString(value.nextAction, "decision.memory.nextAction", {
      maxLength: DECISION_STRING_MAX,
    }),
  }
  return result
}

export function validateDecision(value, expectedTaskId) {
  assertStrictObject(value, DECISION_KEYS, "decision")
  let serialized
  try {
    serialized = JSON.stringify(value)
  } catch (error) {
    throw new TypeError(
      `decision must be JSON serializable: ${error.message}`,
      { cause: error }
    )
  }
  if (Buffer.byteLength(serialized, "utf8") > DECISION_SERIALIZED_MAX) {
    fail(`decision must serialize to at most ${DECISION_SERIALIZED_MAX} bytes`)
  }

  const taskId = assertString(value.taskId, "decision.taskId", {
    nonempty: true,
    maxLength: 64,
  })
  if (taskId !== expectedTaskId)
    fail(`decision.taskId must match expected task ${expectedTaskId}`)
  if (!DECISIONS.includes(value.decision)) {
    fail(`decision.decision must be one of ${DECISIONS.join(", ")}`)
  }
  const summary = assertString(value.summary, "decision.summary", {
    maxLength: DECISION_STRING_MAX,
  })
  const blocker = assertString(value.blocker, "decision.blocker", {
    maxLength: DECISION_STRING_MAX,
  })
  const memory = validateMemory(value.memory)

  if (value.decision !== "task-complete") {
    if (summary.trim().length === 0) fail("decision.summary must not be empty")
    if (memory.nextAction.trim().length === 0) {
      fail("decision.memory.nextAction must not be empty")
    }
  }
  if (value.decision === "blocked" && blocker.trim().length === 0) {
    fail("decision.blocker must not be empty when blocked")
  }
  if (value.decision !== "blocked" && blocker.length !== 0) {
    fail("decision.blocker must be empty unless blocked")
  }

  return { taskId, decision: value.decision, summary, blocker, memory }
}

export function initialState(plan) {
  const normalized = validatePlan(plan)
  return {
    version: 1,
    planHash: planHash(normalized),
    workspace: normalized.workspace,
    status: "ready",
    taskIndex: 0,
    taskTurns: 0,
    taskRenewals: 0,
    totalTurns: 0,
    completed: [],
    memory: null,
    handoff: null,
    message: null,
    updatedAt: new Date().toISOString(),
  }
}

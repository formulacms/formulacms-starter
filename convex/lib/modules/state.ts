import { ConvexError } from "convex/values"
import type { MutationCtx, QueryCtx } from "../../_generated/server"
import type { Doc } from "../../_generated/dataModel"
import {
  MODULE_CATALOG,
  validateModuleCatalog,
} from "../../../lib/modules/catalog"
import type { ModuleDescriptorV1 } from "../../../lib/modules/types"
import { requireOperationAccess } from "../access/policy"
import type { OwnerPrincipal } from "../access/owner"
import { resolveAiModuleReadiness } from "../ai"
import { resolveEmailModuleReadiness } from "../email/readiness"
import { resolveMultilingualModuleReadiness } from "../language/multilingual"
import { reportContainedModuleFailure } from "../../../lib/modules/containment"

type ModuleStateContext = QueryCtx | MutationCtx

export type ModuleSetupState = "not_required" | "required"
export type ModuleReadiness = "ready" | "needs_setup"

export type ModuleReadinessState = Readonly<{
  readiness: ModuleReadiness
  setup: ModuleSetupState
}>

export type EffectiveModuleState = Readonly<{
  moduleId: string
  available: true
  enabled: boolean
  effective: boolean
  readiness: ModuleReadiness
  setup: ModuleSetupState
}>

export type EffectiveModuleStateSnapshot = Readonly<{
  configurationVersion: number
  modules: readonly EffectiveModuleState[]
  readinessFailures?: readonly string[]
}>

export type ValidatedModuleState = Readonly<{
  configurationVersion: number
  enabledModuleIds: ReadonlySet<string>
}>

// Validate and index the immutable static catalog once at module load rather
// than repeating catalog work for every field in a request or transaction.
type CatalogIndex = Readonly<{
  ordered: readonly ModuleDescriptorV1[]
  byId: ReadonlyMap<string, ModuleDescriptorV1>
}>

function indexCatalog(catalog: readonly ModuleDescriptorV1[]): CatalogIndex {
  const ordered = validateModuleCatalog(catalog)
  return {
    ordered,
    byId: new Map(ordered.map((descriptor) => [descriptor.id, descriptor])),
  }
}

const DEFAULT_CATALOG_INDEX = indexCatalog(MODULE_CATALOG)
const ORDERED_CATALOG = DEFAULT_CATALOG_INDEX.ordered
const DEFAULT_READINESS: ModuleReadinessState = {
  readiness: "ready",
  setup: "not_required",
}

function failClosed(): never {
  throw new ConvexError("CMS_MODULE_STATE_INVALID")
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0
}

function validatePersistedModuleState(
  state: Doc<"cmsModuleState">,
  catalogById: ReadonlyMap<
    string,
    ModuleDescriptorV1
  > = DEFAULT_CATALOG_INDEX.byId
): ValidatedModuleState {
  if (!isNonNegativeSafeInteger(state.configurationVersion)) failClosed()

  const enabledModuleIds = new Set<string>()
  for (const entry of state.enabledModules) {
    const descriptor = catalogById.get(entry.moduleId)
    if (
      !descriptor ||
      descriptor.required ||
      !Number.isSafeInteger(entry.configVersion) ||
      entry.configVersion !== descriptor.configVersion ||
      enabledModuleIds.has(entry.moduleId)
    ) {
      failClosed()
    }
    enabledModuleIds.add(entry.moduleId)
  }

  return {
    configurationVersion: state.configurationVersion,
    enabledModuleIds,
  }
}

/**
 * Reads the one authoritative owner configuration row. Missing state is the
 * documented fresh-install default; duplicate or malformed state never picks
 * an arbitrary row or enables a module.
 */
export async function readModuleState(
  ctx: ModuleStateContext,
  catalogById?: ReadonlyMap<string, ModuleDescriptorV1>
): Promise<ValidatedModuleState> {
  const rows = await ctx.db
    .query("cmsModuleState")
    .withIndex("by_key", (q) => q.eq("key", "owner"))
    .take(2)

  return moduleStateFromRows(rows, catalogById)
}

/** `readModuleState` over rows a caller already read with `take(2)`. */
export function moduleStateFromRows(
  rows: readonly Doc<"cmsModuleState">[],
  catalogById?: ReadonlyMap<string, ModuleDescriptorV1>
): ValidatedModuleState {
  if (rows.length === 0) {
    return { configurationVersion: 0, enabledModuleIds: new Set() }
  }
  if (rows.length !== 1) failClosed()

  return validatePersistedModuleState(rows[0]!, catalogById)
}

function resolveDescriptorState(
  descriptor: ModuleDescriptorV1,
  enabledModuleIds: ReadonlySet<string>,
  effectiveById: ReadonlyMap<string, boolean>,
  readinessByModuleId: ReadonlyMap<string, ModuleReadinessState>
): EffectiveModuleState {
  const enabled = descriptor.required || enabledModuleIds.has(descriptor.id)
  const effective =
    descriptor.required ||
    (enabled &&
      descriptor.dependencies.every(
        (dependencyId) => effectiveById.get(dependencyId) === true
      ))

  const readiness = readinessByModuleId.get(descriptor.id) ?? DEFAULT_READINESS
  return {
    moduleId: descriptor.id,
    available: true,
    enabled,
    effective,
    readiness: readiness.readiness,
    setup: readiness.setup,
  }
}

/** A module's server-owned readiness fact (setup facts, never owner intent). */
export type ModuleReadinessProvider = (
  ctx: ModuleStateContext,
  enabledModuleIds: ReadonlySet<string>
) => Promise<ModuleReadinessState>

/** Email, Multilingual and AI readiness providers serve resolution and the optional-module gate. */
const READINESS_PROVIDERS: ReadonlyMap<string, ModuleReadinessProvider> =
  new Map<string, ModuleReadinessProvider>([
    ["email", resolveEmailModuleReadiness],
    ["multilingual", resolveMultilingualModuleReadiness],
    ["ai", resolveAiModuleReadiness],
  ])

/** Resolves the current installed modules' server-owned setup facts. */
export async function resolveModuleReadiness(
  ctx: ModuleStateContext,
  enabledModuleIds: ReadonlySet<string>
): Promise<ReadonlyMap<string, ModuleReadinessState>> {
  const entries = await Promise.all(
    [...READINESS_PROVIDERS].map(
      async ([moduleId, provider]) => [moduleId, await provider(ctx, enabledModuleIds)] as const
    )
  )
  return new Map<string, ModuleReadinessState>(entries)
}

/**
 * effective-readiness: visibility alone contains provider failures. Check the
 * F07 effective state before calling a provider, including dependency-off.
 * The explicit inputs also let tests exercise a future optional module without
 * installing it. This helper is not an authorization or execution gate.
 */
export async function resolveEffectiveReadiness(
  ctx: ModuleStateContext,
  snapshot: EffectiveModuleStateSnapshot,
  catalog: readonly ModuleDescriptorV1[] = ORDERED_CATALOG,
  providers: ReadonlyMap<string, ModuleReadinessProvider> = READINESS_PROVIDERS
): Promise<{
  readiness: ReadonlyMap<string, ModuleReadinessState>
  failures: readonly string[]
}> {
  const readiness = new Map<string, ModuleReadinessState>()
  const failures: string[] = []
  await Promise.all(
    catalog
      .filter((descriptor) => !descriptor.required)
      .map(async (descriptor) => {
        if (
          !snapshot.modules.some(
            (state) => state.moduleId === descriptor.id && state.effective
          )
        )
          return
        const provider = providers.get(descriptor.id)
        if (!provider) return
        try {
          readiness.set(descriptor.id, await provider(ctx, new Set(snapshot.modules.filter((module) => module.enabled).map((module) => module.moduleId))))
        } catch (error) {
          reportContainedModuleFailure(
            descriptor.id,
            "admin.effective-readiness",
            error
          )
          failures.push(descriptor.id)
        }
      })
  )
  return { readiness, failures }
}

/** Resolves a candidate enablement set without reading or writing storage. */
export function resolveEffectiveModuleStateFromEnabled(
  configurationVersion: number,
  enabledModuleIds: ReadonlySet<string>,
  readinessByModuleId: ReadonlyMap<string, ModuleReadinessState> = new Map(),
  orderedCatalog: readonly ModuleDescriptorV1[] = ORDERED_CATALOG
): EffectiveModuleStateSnapshot {
  const effectiveById = new Map<string, boolean>()
  const modules = orderedCatalog.map((descriptor) => {
    const state = resolveDescriptorState(
      descriptor,
      enabledModuleIds,
      effectiveById,
      readinessByModuleId
    )
    effectiveById.set(descriptor.id, state.effective)
    return state
  })

  return { configurationVersion, modules }
}

/** Catalog modules that declare no readiness provider. */
export type GuardedModuleId = Exclude<
  (typeof MODULE_CATALOG)[number]["id"],
  "email" | "multilingual" | "ai"
>

export type ModuleGuardState = Readonly<{
  moduleId: GuardedModuleId
  effective: boolean
  readiness: ModuleReadiness
  setup: ModuleSetupState
}>

/**
 * Narrow per-module guard (M01 recovery design RG6). One validated state read
 * projected through the single resolver without a readiness map, so no other
 * module's readiness is evaluated: a corrupt Email row cannot fail this
 * module. Invalid state throws `CMS_MODULE_STATE_INVALID`; callers must never
 * turn that into a disabled or empty result.
 */
export async function resolveModuleGuardState(
  ctx: ModuleStateContext,
  moduleId: GuardedModuleId
): Promise<ModuleGuardState> {
  const persisted = await readModuleState(ctx)
  const state = resolveEffectiveModuleStateFromEnabled(
    persisted.configurationVersion,
    persisted.enabledModuleIds
  ).modules.find((module) => module.moduleId === moduleId)
  if (!state) failClosed()
  return {
    moduleId,
    effective: state.effective,
    readiness: DEFAULT_READINESS.readiness,
    setup: DEFAULT_READINESS.setup,
  }
}

/**
 * Resolves static availability, owner enablement, effective state, readiness,
 * and setup facts from one bounded state read and the verified static catalog.
 */
export async function resolveEffectiveModuleState(
  ctx: ModuleStateContext,
  boundary?: "effective-readiness"
): Promise<EffectiveModuleStateSnapshot> {
  const persisted = await readModuleState(ctx)
  if (boundary === "effective-readiness") {
    const snapshot = resolveEffectiveModuleStateFromEnabled(
      persisted.configurationVersion,
      persisted.enabledModuleIds
    )
    const isolated = await resolveEffectiveReadiness(ctx, snapshot)
    return {
      ...resolveEffectiveModuleStateFromEnabled(
        persisted.configurationVersion,
        persisted.enabledModuleIds,
        isolated.readiness
      ),
      readinessFailures: isolated.failures,
    }
  }
  return resolveEffectiveModuleStateFromEnabled(
    persisted.configurationVersion,
    persisted.enabledModuleIds,
    await resolveModuleReadiness(ctx, persisted.enabledModuleIds)
  )
}

/** Guard facts for any optional catalog module, including readiness modules. */
export type OptionalModuleGuardState = Readonly<{
  moduleId: string
  effective: boolean
  readiness: ModuleReadiness
  setup: ModuleSetupState
}>

export type OptionalModuleGateOptions = Readonly<{
  /**
   * Require the module's own readiness to be `ready` (default `true`). Only a
   * module's setup/configuration entry (for example its Settings route) passes
   * `false`, so the owner can still reach the screen that fixes readiness.
   */
  requireReady?: boolean
}>

/** What a gate instance reads: the static catalog and the readiness providers. */
export type OptionalModuleGateDeps = Readonly<{
  catalog: readonly ModuleDescriptorV1[]
  readinessProviders: ReadonlyMap<string, ModuleReadinessProvider>
}>

export type OptionalModuleGate = Readonly<{
  resolveOptionalModuleGuardState: (
    ctx: ModuleStateContext,
    moduleId: string
  ) => Promise<OptionalModuleGuardState>
  requireOwnerAndOptionalModule: (
    ctx: ModuleStateContext,
    moduleId: string,
    options?: OptionalModuleGateOptions
  ) => Promise<OwnerPrincipal>
}>

/**
 * Builds an optional-module gate over an explicit catalog and readiness
 * provider map. This is the only injection seam: the exported production
 * functions below are the instance over `MODULE_CATALOG` and the installed
 * providers, and their options cannot replace either. Only
 * `convex/lib/modules/state.ts` and tests may call it (enforced by
 * `optionalModuleGateSeam.node.test.ts`), so no entry point can build a gate
 * that skips a dependency or a readiness check. An invalid catalog throws
 * when the instance is built, never at request time.
 */
export function createOptionalModuleGate(
  deps: OptionalModuleGateDeps
): OptionalModuleGate {
  const index = indexCatalog(deps.catalog)

  async function resolveOptionalModuleGuardState(
    ctx: ModuleStateContext,
    moduleId: string
  ): Promise<OptionalModuleGuardState> {
    const descriptor = index.byId.get(moduleId)
    if (!descriptor || descriptor.required) failClosed()

    const persisted = await readModuleState(ctx, index.byId)
    const provider = deps.readinessProviders.get(moduleId)
    const readinessByModuleId = new Map<string, ModuleReadinessState>()
    if (provider) readinessByModuleId.set(moduleId, await provider(ctx, persisted.enabledModuleIds))

    const state = resolveEffectiveModuleStateFromEnabled(
      persisted.configurationVersion,
      persisted.enabledModuleIds,
      readinessByModuleId,
      index.ordered
    ).modules.find((module) => module.moduleId === moduleId)
    if (!state) failClosed()
    return {
      moduleId,
      effective: state.effective,
      readiness: state.readiness,
      setup: state.setup,
    }
  }

  async function requireOwnerAndOptionalModule(
    ctx: ModuleStateContext,
    moduleId: string,
    options: OptionalModuleGateOptions = {}
  ): Promise<OwnerPrincipal> {
    const principal = await requireOperationAccess(ctx)
    const guard = await resolveOptionalModuleGuardState(ctx, moduleId)
    if (!guard.effective) throw new ConvexError("CMS_MODULE_DISABLED")
    if ((options.requireReady ?? true) && guard.readiness !== "ready") {
      throw new ConvexError("CMS_MODULE_NOT_READY")
    }
    return principal
  }

  return { resolveOptionalModuleGuardState, requireOwnerAndOptionalModule }
}

const installedOptionalModuleGate = createOptionalModuleGate({
  catalog: MODULE_CATALOG,
  readinessProviders: READINESS_PROVIDERS,
})

/**
 * Per-module guard for any optional module, readiness modules included
 * (extends `resolveModuleGuardState`, which excludes them). It performs one
 * validated state read and evaluates only the named module's own readiness
 * provider, so another module's corrupt readiness can never hide this one.
 *
 * The gate checks the named module's own readiness, not its dependencies':
 * a module that depends on a readiness module (for example a future
 * ai-translation on multilingual) composes the dependency's readiness inside
 * its own readiness provider.
 *
 * Fails closed with `CMS_MODULE_STATE_INVALID` for an id that is not in the
 * catalog, for a required (fixed-active) module, and for invalid persisted
 * state. Callers must never turn that into a disabled or empty result.
 */
export const resolveOptionalModuleGuardState: OptionalModuleGate["resolveOptionalModuleGuardState"] =
  installedOptionalModuleGate.resolveOptionalModuleGuardState

/**
 * The gate for every optional-module entry point. Owner first
 * (`requireOperationAccess`: unauthenticated, non-owner and malformed owner
 * state fail with their own codes), then the module: `CMS_MODULE_DISABLED`
 * unless effectively enabled and, by default, `CMS_MODULE_NOT_READY` unless
 * ready. Returns the owner principal so the caller has one authorization
 * result to carry.
 *
 * It takes a Query or Mutation ctx. An action has no `ctx.db`, so an action
 * calls the gate inside its `prepare*` internal query (via `ctx.runQuery`).
 * Convex transactions split across `runQuery`/`runMutation` calls can race: a
 * module turned off between `prepare*` and the action's work still completes.
 * Side-effect mutations the action then runs (for example `recordAudit`) must
 * re-run the gate themselves.
 *
 * Readiness is the named module's own (see `resolveOptionalModuleGuardState`).
 */
export const requireOwnerAndOptionalModule: OptionalModuleGate["requireOwnerAndOptionalModule"] =
  installedOptionalModuleGate.requireOwnerAndOptionalModule

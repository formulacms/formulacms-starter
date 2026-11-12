import { ConvexError } from "convex/values"
import { MODULE_CATALOG } from "../../../lib/modules/catalog"
import type { ModuleDescriptorV1 } from "../../../lib/modules/types"
import {
  resolveEffectiveModuleStateFromEnabled,
  type EffectiveModuleState,
  type EffectiveModuleStateSnapshot,
  type ModuleReadinessState,
} from "./state"

export type ModuleTransitionRequest = Readonly<{
  moduleId: string
  enabled: boolean
}>

export type ModuleTransitionBlocker = Readonly<{
  code: "DEPENDENCY_NOT_LISTED" | "DEPENDANT_ENABLED" | "REQUIRED_MODULE"
  moduleId: string
  relatedModuleId: string
}>

export type ModuleTransitionChange = Readonly<{
  moduleId: string
  fromEnabled: boolean
  toEnabled: boolean
}>

export type ModuleTransitionPreview = Readonly<{
  configurationVersion: number
  changes: readonly ModuleTransitionChange[]
  requiredDependencies: readonly string[]
  blockers: readonly ModuleTransitionBlocker[]
  readiness: readonly EffectiveModuleState[]
}>

const CATALOG_BY_ID = new Map<string, ModuleDescriptorV1>(
  MODULE_CATALOG.map((descriptor) => [descriptor.id, descriptor])
)

function invalidTransition(message: string): never {
  throw new ConvexError(`CMS_MODULE_TRANSITION_INVALID: ${message}`)
}

function enabledSetFromSnapshot(
  snapshot: EffectiveModuleStateSnapshot
): Set<string> {
  return new Set(
    snapshot.modules
      .filter(
        (module) =>
          !CATALOG_BY_ID.get(module.moduleId)!.required && module.enabled
      )
      .map((module) => module.moduleId)
  )
}

/**
 * Computes a deterministic, storage-free transition. It deliberately knows
 * only static dependency rules: module-owned retained-data blockers are added
 * by the concrete module that owns that data (Redirects in M01).
 */
export function previewModuleTransition(
  current: EffectiveModuleStateSnapshot,
  requests: readonly ModuleTransitionRequest[]
): ModuleTransitionPreview {
  const requestedIds = new Set<string>()
  const currentEnabled = enabledSetFromSnapshot(current)
  const targetEnabled = new Set(currentEnabled)
  const blockers: ModuleTransitionBlocker[] = []
  const requiredDependencies = new Set<string>()

  for (const request of requests) {
    const descriptor = CATALOG_BY_ID.get(request.moduleId)
    if (!descriptor) invalidTransition(`Unknown module "${request.moduleId}".`)
    if (requestedIds.has(request.moduleId)) {
      invalidTransition(`Duplicate module "${request.moduleId}".`)
    }
    requestedIds.add(request.moduleId)
    if (descriptor.required && !request.enabled) {
      blockers.push({
        code: "REQUIRED_MODULE",
        moduleId: request.moduleId,
        relatedModuleId: request.moduleId,
      })
    }
    if (!descriptor.required) {
      if (request.enabled) targetEnabled.add(request.moduleId)
      else targetEnabled.delete(request.moduleId)
    }
    if (request.enabled) {
      for (const dependencyId of descriptor.dependencies) {
        requiredDependencies.add(dependencyId)
      }
    }
  }

  for (const descriptor of MODULE_CATALOG) {
    if (!targetEnabled.has(descriptor.id)) continue
    for (const dependencyId of descriptor.dependencies) {
      const dependency = CATALOG_BY_ID.get(dependencyId)
      if (!dependency) {
        invalidTransition(
          `Module "${descriptor.id}" has an unknown dependency "${dependencyId}".`
        )
      }
      if (!dependency.required && !targetEnabled.has(dependencyId)) {
        blockers.push({
          code: "DEPENDENCY_NOT_LISTED",
          moduleId: descriptor.id,
          relatedModuleId: dependencyId,
        })
      }
    }
  }

  for (const descriptor of MODULE_CATALOG) {
    if (descriptor.required || targetEnabled.has(descriptor.id)) continue
    for (const dependant of MODULE_CATALOG) {
      if (
        targetEnabled.has(dependant.id) &&
        (dependant.dependencies as readonly string[]).includes(descriptor.id)
      ) {
        blockers.push({
          code: "DEPENDANT_ENABLED",
          moduleId: descriptor.id,
          relatedModuleId: dependant.id,
        })
      }
    }
  }

  const readiness = resolveEffectiveModuleStateFromEnabled(
    current.configurationVersion,
    targetEnabled,
    new Map<string, ModuleReadinessState>(
      current.modules.map((module) => [
        module.moduleId,
        { readiness: module.readiness, setup: module.setup },
      ])
    )
  ).modules
  const byId = new Map(
    current.modules.map((module) => [module.moduleId, module])
  )
  const changes: ModuleTransitionChange[] = []
  for (const moduleState of readiness) {
    const before = byId.get(moduleState.moduleId)!
    if (before.enabled !== moduleState.enabled) {
      changes.push({
        moduleId: moduleState.moduleId,
        fromEnabled: before.enabled,
        toEnabled: moduleState.enabled,
      })
    }
  }

  return {
    configurationVersion: current.configurationVersion,
    changes,
    requiredDependencies: [...requiredDependencies].sort(),
    blockers,
    readiness,
  }
}

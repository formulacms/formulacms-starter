import {
  CURRENT_MODULE_CONFIG_VERSION,
  CURRENT_MODULE_DESCRIPTOR_VERSION,
  MODULE_CONTRIBUTION_IDS,
  MODULE_ENVIRONMENTS,
  type ModuleConfigV1,
  type ModuleDescriptorV1,
  type ModuleEnvironment,
} from "./types"

/*
 * Catalog validators (moved from catalog.ts, unchanged). This file imports
 * only ./types, so the module factory can validate a catalog without loading
 * the generated catalog it is about to write (ADR-0059).
 */

const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const KNOWN_ENVIRONMENTS = new Set<string>(MODULE_ENVIRONMENTS)
const KNOWN_CONTRIBUTIONS = new Set<string>(MODULE_CONTRIBUTION_IDS)

function assertCurrentDescriptorVersion(descriptor: ModuleDescriptorV1): void {
  if (descriptor.descriptorVersion !== CURRENT_MODULE_DESCRIPTOR_VERSION) {
    throw new Error(
      `Module "${descriptor.id}" has unsupported descriptor version ${descriptor.descriptorVersion}.`
    )
  }

  if (descriptor.configVersion !== CURRENT_MODULE_CONFIG_VERSION) {
    throw new Error(
      `Module "${descriptor.id}" has unsupported config version ${descriptor.configVersion}.`
    )
  }
}

function assertKnownEnvironment(
  descriptor: ModuleDescriptorV1,
  environment: ModuleEnvironment
): void {
  if (!KNOWN_ENVIRONMENTS.has(environment)) {
    throw new Error(
      `Module "${descriptor.id}" declares unsupported environment "${environment}".`
    )
  }
}

function assertKnownContribution(
  descriptor: ModuleDescriptorV1,
  contribution: string
): void {
  if (!KNOWN_CONTRIBUTIONS.has(contribution)) {
    throw new Error(
      `Module "${descriptor.id}" declares unsupported contribution "${contribution}".`
    )
  }
}

function assertUniqueValues(
  descriptor: ModuleDescriptorV1,
  label: string,
  values: readonly string[]
): void {
  if (new Set(values).size !== values.length) {
    throw new Error(`Module "${descriptor.id}" declares duplicate ${label}.`)
  }
}

/**
 * Validates a static descriptor set and returns the same descriptors in a
 * deterministic dependency order. This does not resolve lifecycle state,
 * effective enablement, readiness, or caller authority; F07 owns those facts.
 */
export function validateModuleCatalog(
  descriptors: readonly ModuleDescriptorV1[]
): readonly ModuleDescriptorV1[] {
  const byId = new Map<string, ModuleDescriptorV1>()

  for (const descriptor of descriptors) {
    if (!MODULE_ID_PATTERN.test(descriptor.id)) {
      throw new Error(`Module ID "${descriptor.id}" must be lower-kebab-case.`)
    }
    if (byId.has(descriptor.id)) {
      throw new Error(
        `Module ID "${descriptor.id}" is declared more than once.`
      )
    }

    assertCurrentDescriptorVersion(descriptor)
    assertUniqueValues(descriptor, "dependencies", descriptor.dependencies)
    assertUniqueValues(descriptor, "environments", descriptor.environments)
    assertUniqueValues(descriptor, "contributions", descriptor.contributions)
    for (const environment of descriptor.environments) {
      assertKnownEnvironment(descriptor, environment)
    }
    for (const contribution of descriptor.contributions) {
      assertKnownContribution(descriptor, contribution)
    }
    byId.set(descriptor.id, descriptor)
  }

  for (const descriptor of descriptors) {
    for (const dependencyId of descriptor.dependencies) {
      const dependency = byId.get(dependencyId)
      if (!dependency) {
        throw new Error(
          `Module "${descriptor.id}" depends on unknown module "${dependencyId}".`
        )
      }
      if (descriptor.required && !dependency.required) {
        throw new Error(
          `Required module "${descriptor.id}" cannot depend on owner-configured module "${dependencyId}".`
        )
      }
    }
  }

  const visited = new Set<string>()
  const visiting = new Set<string>()
  const ordered: ModuleDescriptorV1[] = []

  function visit(descriptor: ModuleDescriptorV1): void {
    if (visited.has(descriptor.id)) return
    if (visiting.has(descriptor.id)) {
      throw new Error(
        `Module dependencies contain a cycle at "${descriptor.id}".`
      )
    }

    visiting.add(descriptor.id)
    for (const dependencyId of descriptor.dependencies) {
      visit(byId.get(dependencyId)!)
    }
    visiting.delete(descriptor.id)
    visited.add(descriptor.id)
    ordered.push(descriptor)
  }

  for (const descriptor of descriptors) visit(descriptor)
  return ordered
}

/** Validates that a server-owned typed configuration envelope matches its descriptor. */
export function validateModuleConfig<Values extends object>(
  descriptor: ModuleDescriptorV1,
  config: ModuleConfigV1<Values>
): ModuleConfigV1<Values> {
  assertCurrentDescriptorVersion(descriptor)

  if (config.moduleId !== descriptor.id) {
    throw new Error(
      `Module config for "${config.moduleId}" does not match descriptor "${descriptor.id}".`
    )
  }
  if (config.configVersion !== CURRENT_MODULE_CONFIG_VERSION) {
    throw new Error(
      `Module "${descriptor.id}" has unsupported config version ${config.configVersion}.`
    )
  }

  return config
}

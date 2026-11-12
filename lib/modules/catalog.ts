import {
  CURRENT_MODULE_CONFIG_VERSION,
  CURRENT_MODULE_DESCRIPTOR_VERSION,
  MODULE_CONTRIBUTION_IDS,
  MODULE_ENVIRONMENTS,
  type ModuleConfigV1,
  type ModuleDescriptorV1,
  type ModuleEnvironment,
} from "./types"

const MODULE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/
const KNOWN_ENVIRONMENTS = new Set<string>(MODULE_ENVIRONMENTS)
const KNOWN_CONTRIBUTIONS = new Set<string>(MODULE_CONTRIBUTION_IDS)

const descriptor = <T extends ModuleDescriptorV1>(value: T): Readonly<T> => {
  Object.freeze(value.dependencies)
  Object.freeze(value.environments)
  Object.freeze(value.contributions)
  return Object.freeze(value)
}

/** The reviewed Community launch catalog (static metadata only). */
export const MODULE_CATALOG = Object.freeze([
  descriptor({
    id: "system",
    name: "System",
    summary: "Core shell, setup, and shared technical foundations.",
    descriptorVersion: 1,
    configVersion: 1,
    required: true,
    dependencies: [],
    environments: ["browser", "server"],
    contributions: [],
  }),
  descriptor({
    id: "owner-access",
    name: "Owner access",
    summary: "Durable installation-owner identity and protected access.",
    descriptorVersion: 1,
    configVersion: 1,
    required: true,
    dependencies: ["system"],
    environments: ["browser", "server", "worker"],
    contributions: [],
  }),
  descriptor({
    id: "content-model",
    name: "Content model",
    summary: "Typed content definitions, fields, and content relationships.",
    descriptorVersion: 1,
    configVersion: 1,
    required: true,
    dependencies: ["system", "owner-access"],
    environments: ["browser", "server"],
    contributions: [],
  }),
  descriptor({
    id: "content-editor",
    name: "Content editor",
    summary: "Draft editing, page authoring, and editor-facing content tools.",
    descriptorVersion: 1,
    configVersion: 1,
    required: true,
    dependencies: ["content-model", "owner-access"],
    environments: ["browser", "server", "worker"],
    contributions: [],
  }),
  descriptor({
    id: "publication",
    name: "Publication",
    summary: "Validated publication and public content delivery foundations.",
    descriptorVersion: 1,
    configVersion: 1,
    required: true,
    dependencies: ["content-editor", "content-model", "owner-access"],
    environments: ["browser", "server", "worker"],
    contributions: [],
  }),
  descriptor({
    id: "media",
    name: "Media",
    summary: "Owned media storage, editing, and reference-safe asset access.",
    descriptorVersion: 1,
    configVersion: 1,
    required: true,
    dependencies: ["content-model", "owner-access"],
    environments: ["browser", "server"],
    contributions: [],
  }),
  descriptor({
    id: "language",
    name: "Language",
    summary:
      "The Community site-language foundation and admin language settings.",
    descriptorVersion: 1,
    configVersion: 1,
    required: true,
    dependencies: ["publication", "owner-access"],
    // F09's `stepLanguageTransition` and the M05 lifecycle drain run as workers.
    environments: ["browser", "server", "worker"],
    contributions: [],
  }),
  descriptor({
    id: "email",
    name: "Email",
    summary: "Recovery and transactional email configuration foundations.",
    descriptorVersion: 1,
    configVersion: 1,
    required: true,
    dependencies: ["system", "owner-access"],
    environments: ["browser", "server", "worker"],
    contributions: [],
  }),
  descriptor({
    id: "redirects",
    name: "Redirects",
    summary: "Owner-authored manual redirect rules for public routing.",
    descriptorVersion: 1,
    configVersion: 1,
    required: false,
    dependencies: ["system", "owner-access", "publication"],
    environments: ["browser", "server"],
    contributions: ["admin.navigation", "public.routing"],
  }),
  descriptor({
    id: "multilingual",
    name: "Multilingual",
    summary: "Publish your site in more than one language.",
    descriptorVersion: 1,
    configVersion: 1,
    required: false,
    dependencies: ["language", "publication", "owner-access"],
    environments: ["browser", "server", "worker"],
    contributions: ["admin.settings", "admin.page-editor", "public.routing"],
  }),
  descriptor({
    id: "ai",
    name: "AI",
    summary: "Writing, translation and help assistants in the admin. Providers, models and instructions are set in Settings › AI. Translation also requires Multilingual. Content sent to an assistant goes to its provider, which bills you per use.",
    descriptorVersion: 1,
    configVersion: 1,
    required: false,
    dependencies: ["system", "owner-access", "content-editor"],
    environments: ["browser", "server", "worker"],
    contributions: [
      "admin.ai-settings",
      "admin.ai-writing",
      "admin.ai-translation",
      "admin.ai-help",
    ],
  }),
] as const satisfies readonly ModuleDescriptorV1[])

/**
 * Rejects an attempt to disable a fixed-active module using the reviewed
 * catalog, rather than a caller-controlled `required` value. Persisted state,
 * authorization, and transition handling remain owned by F07.
 */
export function assertModuleCanBeDisabled(moduleId: string): void {
  const descriptor = MODULE_CATALOG.find(
    (candidate) => candidate.id === moduleId
  )

  if (!descriptor) {
    throw new Error(`Module "${moduleId}" is not in the current catalog.`)
  }
  if (descriptor.required) {
    throw new Error(`Required module "${moduleId}" is fixed active.`)
  }
}

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

/** Browser-safe static module descriptor vocabulary for the current v1 dialect. */

export const CURRENT_MODULE_DESCRIPTOR_VERSION = 1 as const
export const CURRENT_MODULE_CONFIG_VERSION = 1 as const

export const MODULE_ENVIRONMENTS = ["browser", "server", "worker"] as const

export type ModuleEnvironment = (typeof MODULE_ENVIRONMENTS)[number]

export const MODULE_CONTRIBUTION_IDS = [
  "publication.policy",
  "publication.history",
  "publication.index",
  "delivery.outbound",
  "publication.scheduling",
  "admin.navigation",
  "admin.settings",
  "admin.page-editor",
  "admin.page-history",
  "admin.ai-settings",
  "admin.ai-writing",
  "admin.ai-translation",
  "admin.ai-help",
  "admin.list-search",
  "admin.sidebar-status",
  "content.slice",
  "public.action",
  "public.routing",
] as const

export type ModuleContributionId = (typeof MODULE_CONTRIBUTION_IDS)[number]

export type ModuleDescriptorV1 = Readonly<{
  id: string
  name: string
  summary: string
  descriptorVersion: typeof CURRENT_MODULE_DESCRIPTOR_VERSION
  configVersion: typeof CURRENT_MODULE_CONFIG_VERSION
  required: boolean
  dependencies: readonly string[]
  environments: readonly ModuleEnvironment[]
  contributions: readonly ModuleContributionId[]
}>

export type ModuleConfigV1<Values extends object = Record<string, never>> =
  Readonly<{
    moduleId: string
    configVersion: typeof CURRENT_MODULE_CONFIG_VERSION
    values: Values
  }>

import { GENERATED_MODULE_CATALOG } from "./catalog.generated"
import type { ModuleDescriptorV1 } from "./types"

export {
  validateModuleCatalog,
  validateModuleConfig,
} from "./catalog-validation"

const descriptor = <T extends ModuleDescriptorV1>(value: T): Readonly<T> => {
  Object.freeze(value.dependencies)
  Object.freeze(value.environments)
  Object.freeze(value.contributions)
  return Object.freeze(value)
}

function freezeCatalog<T extends readonly ModuleDescriptorV1[]>(
  entries: T
): { readonly [K in keyof T]: Readonly<T[K]> } {
  for (const entry of entries) descriptor(entry)
  return Object.freeze(entries) as { readonly [K in keyof T]: Readonly<T[K]> }
}

/**
 * The reviewed Community launch catalog (static metadata only), generated
 * by the formulacms module factory (ADR-0059).
 */
export const MODULE_CATALOG = freezeCatalog(GENERATED_MODULE_CATALOG)

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

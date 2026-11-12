import { writePrimitive } from "../richtext/write"
import type { ContentTypeDescriptor, DescriptorFieldMap } from "./types"
import { isPrimitiveValueEmpty } from "../slices/primitives"

type InitialLocalizedInput = {
  title: string
  metaTitle?: string
  metaDescription?: string
  slices?: readonly unknown[]
}

function cloneValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** Materialize a descriptor field map using each primitive's canonical default. */
export function descriptorDefaults(
  fields: DescriptorFieldMap,
  options: { includeOptional?: boolean } = {}
): Record<string, unknown> {
  const includeOptional = options.includeOptional ?? true
  const values: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(fields)) {
    if (!includeOptional && field.validator.isOptional === "optional") continue
    if (field.default !== undefined) {
      values[key] = writePrimitive(field, cloneValue(field.default))
    }
  }
  return values
}

/**
 * Build schema-valid initial localized content for any registered descriptor.
 *
 * The create mutation's legacy input only exposes the universal title/meta
 * fields and slices. Descriptor-specific fields therefore start at their
 * primitive defaults and become editable through the generic Content panel.
 */
export function buildInitialLocalizedContent(
  descriptor: ContentTypeDescriptor,
  input: Record<string, InitialLocalizedInput> | undefined,
  defaultLocale: string,
  title: string
): Record<string, Record<string, unknown>> {
  const source =
    input ??
    ({
      [defaultLocale]: { title },
    } satisfies Record<string, InitialLocalizedInput>)

  return Object.fromEntries(
    Object.entries(source).map(([locale, block]) => {
      const localized = descriptorDefaults(descriptor.localizedFields, {
        includeOptional: false,
      })
      for (const key of ["title", "metaTitle", "metaDescription"] as const) {
        if (
          Object.prototype.hasOwnProperty.call(
            descriptor.localizedFields,
            key
          ) &&
          block[key] !== undefined
        ) {
          localized[key] = block[key]
        }
      }
      if (descriptor.capabilities.sliceBody) {
        localized.slices = cloneValue(block.slices ?? [])
      }
      return [locale, localized]
    })
  )
}

/** Copy only the row-level fields declared by the source descriptor. */
export function copyDescriptorSharedFields(
  descriptor: ContentTypeDescriptor,
  source: Record<string, unknown>
): Record<string, unknown> {
  const copied: Record<string, unknown> = {}
  for (const key of Object.keys(descriptor.sharedFields)) {
    const value = source[key]
    if (value !== undefined)
      copied[key] = writePrimitive(
        descriptor.sharedFields[key],
        cloneValue(value),
        { duplicate: true }
      )
  }
  return copied
}

/**
 * Decode the generic shared-field save envelope and reject cross-arm or
 * semantically empty required-field writes before they reach Convex storage.
 */
export function parseDescriptorSharedFieldPatch(
  descriptor: ContentTypeDescriptor,
  json: string,
  excludedKeys: ReadonlySet<string> = new Set()
): Record<string, unknown> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error("sharedFieldsJson must contain valid JSON")
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    throw new Error("sharedFieldsJson must contain an object")
  }

  const patch: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(parsed)) {
    const field = descriptor.sharedFields[key]
    if (!field) {
      throw new Error(
        `Shared field "${key}" is not declared by content type "${descriptor.type}"`
      )
    }
    if (excludedKeys.has(key)) {
      throw new Error(
        `Shared field "${key}" must use its dedicated mutation argument`
      )
    }
    const optional = field.validator.isOptional === "optional"
    if (!optional && isPrimitiveValueEmpty(field, value)) {
      throw new Error(`Required shared field "${key}" cannot be empty`)
    }
    patch[key] = value
  }
  return patch
}

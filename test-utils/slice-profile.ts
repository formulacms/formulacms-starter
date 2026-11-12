import {
  INSTALLED_SLICE_TYPES,
  REGISTERED_SLICE_TYPES,
  createDefaultSlice,
  installedSliceDefs,
  type InstalledSliceType,
  type Slice,
  type SliceType,
  sliceDefs,
} from "@/convex/lib/slices"
import { createSampleSlice } from "@/convex/lib/slices/sample"
import { hasSliceType } from "@/convex/lib/slices/identity"
import type { SliceDescriptorStructure } from "@/convex/lib/slices/identity"

declare module "vitest" {
  interface TaskMeta {
    sliceProfile?: { all: string[]; any: string[] | null }
  }
}

/** A string boundary keeps fixtures compilable even with no installed Types. */
export function isSliceTypeInstalled(type: string): boolean {
  return INSTALLED_SLICE_TYPES.some((installed: string) => installed === type)
}

export function areSliceTypesInstalled(types: readonly string[]): boolean {
  return types.every(isSliceTypeInstalled)
}

/** Collection-time options keep prerequisites on skipped tasks in Vitest JSON. */
export function sliceProfile(types: readonly string[]) {
  return {
    skip: process.env.FORMULACMS_SLICE_PROFILE_FORCE !== "1" && !areSliceTypesInstalled(types),
    meta: { sliceProfile: { all: [...new Set(types)], any: null as string[] | null } },
  }
}

/** Generic tests need one eligible installed Type, not every possible fixture. */
export function sliceProfileAny(types: readonly string[]) {
  return {
    skip: process.env.FORMULACMS_SLICE_PROFILE_FORCE !== "1" && !types.some(isSliceTypeInstalled),
    meta: { sliceProfile: { all: [] as string[], any: [...new Set(types)] } },
  }
}

export function installedSliceType(type: string): InstalledSliceType
export function installedSliceType(type: string): SliceType {
  // Force callbacks past fixture admission so only production can prove a dependency.
  if (process.env.FORMULACMS_SLICE_PROFILE_FORCE === "1") {
    const registered = REGISTERED_SLICE_TYPES.find((candidate: string) => candidate === type)
    if (registered !== undefined) return registered
  }
  const installed = INSTALLED_SLICE_TYPES.find((candidate: string) => candidate === type)
  if (installed === undefined) throw new Error(`Test fixture Type is not installed: ${type}`)
  return installed
}

export function installedSliceDefinition<T extends SliceType>(type: T): (typeof sliceDefs)[T]
export function installedSliceDefinition(type: string): SliceDescriptorStructure
export function installedSliceDefinition(type: string): SliceDescriptorStructure {
  const definitions: Readonly<Partial<Record<string, SliceDescriptorStructure>>> =
    process.env.FORMULACMS_SLICE_PROFILE_FORCE === "1" ? sliceDefs : installedSliceDefs
  const definition = definitions[installedSliceType(type)]
  if (!definition) throw new Error(`Missing installed test descriptor: ${type}`)
  return definition
}

/** Registered return shape survives an empty installed union; admission stays strict. */
export function createInstalledDefaultSlice(type: string): Slice {
  return createDefaultSlice(installedSliceType(type))
}

export function createInstalledSampleSlice<T extends SliceType>(type: T): Extract<Slice, { type: T }>
export function createInstalledSampleSlice(type: string): Slice
export function createInstalledSampleSlice(type: string): Slice {
  const sample: Slice = createSampleSlice(installedSliceType(type))
  if (!hasSliceType(sample, type)) throw new Error(`Wrong test fixture Type: ${type}`)
  return sample
}

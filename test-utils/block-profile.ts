import {
  INSTALLED_BLOCK_TYPES,
  REGISTERED_BLOCK_TYPES,
  createDefaultBlock,
  installedBlockDefs,
  type InstalledBlockType,
  type Block,
  type BlockType,
  blockDefs,
} from "@/convex/lib/blocks"
import { createSampleBlock } from "@/convex/lib/blocks/sample"
import { hasBlockType } from "@/convex/lib/blocks/identity"
import type { BlockDescriptorStructure } from "@/convex/lib/blocks/identity"

declare module "vitest" {
  interface TaskMeta {
    blockProfile?: { all: string[]; any: string[] | null }
  }
}

/** A string boundary keeps fixtures compilable even with no installed Types. */
export function isBlockTypeInstalled(type: string): boolean {
  return INSTALLED_BLOCK_TYPES.some((installed: string) => installed === type)
}

export function areBlockTypesInstalled(types: readonly string[]): boolean {
  return types.every(isBlockTypeInstalled)
}

/** Collection-time options keep prerequisites on skipped tasks in Vitest JSON. */
export function blockProfile(types: readonly string[]) {
  return {
    skip: process.env.FORMULACMS_BLOCK_PROFILE_FORCE !== "1" && !areBlockTypesInstalled(types),
    meta: { blockProfile: { all: [...new Set(types)], any: null as string[] | null } },
  }
}

/** Generic tests need one eligible installed Type, not every possible fixture. */
export function blockProfileAny(types: readonly string[]) {
  return {
    skip: process.env.FORMULACMS_BLOCK_PROFILE_FORCE !== "1" && !types.some(isBlockTypeInstalled),
    meta: { blockProfile: { all: [] as string[], any: [...new Set(types)] } },
  }
}

export function installedBlockType(type: string): InstalledBlockType
export function installedBlockType(type: string): BlockType {
  // Force callbacks past fixture admission so only production can prove a dependency.
  if (process.env.FORMULACMS_BLOCK_PROFILE_FORCE === "1") {
    const registered = REGISTERED_BLOCK_TYPES.find((candidate: string) => candidate === type)
    if (registered !== undefined) return registered
  }
  const installed = INSTALLED_BLOCK_TYPES.find((candidate: string) => candidate === type)
  if (installed === undefined) throw new Error(`Test fixture Type is not installed: ${type}`)
  return installed
}

export function installedBlockDefinition<T extends BlockType>(type: T): (typeof blockDefs)[T]
export function installedBlockDefinition(type: string): BlockDescriptorStructure
export function installedBlockDefinition(type: string): BlockDescriptorStructure {
  const definitions: Readonly<Partial<Record<string, BlockDescriptorStructure>>> =
    process.env.FORMULACMS_BLOCK_PROFILE_FORCE === "1" ? blockDefs : installedBlockDefs
  const definition = definitions[installedBlockType(type)]
  if (!definition) throw new Error(`Missing installed test descriptor: ${type}`)
  return definition
}

/** Registered return shape survives an empty installed union; admission stays strict. */
export function createInstalledDefaultBlock(type: string): Block {
  return createDefaultBlock(installedBlockType(type))
}

export function createInstalledSampleBlock<T extends BlockType>(type: T): Extract<Block, { type: T }>
export function createInstalledSampleBlock(type: string): Block
export function createInstalledSampleBlock(type: string): Block {
  const sample: Block = createSampleBlock(installedBlockType(type))
  if (!hasBlockType(sample, type)) throw new Error(`Wrong test fixture Type: ${type}`)
  return sample
}

import {
  INSTALLED_BLOCK_TYPES,
  REGISTERED_BLOCK_TYPES,
  blockDefs,
} from "./index"

export const BLOCK_AUTHORING_STATE_VERSION = "block-contract-state-v1" as const

/**
 * Exact installed contract/profile bytes for the app-local developer CLI.
 * Includes validators, primitive configuration/defaults, previews and hints.
 * This detects local/backend code drift; it is not semantic equivalence,
 * renderer identity, ownership or permission to mutate source.
 */
export function blockAuthoringContractState() {
  return {
    version: BLOCK_AUTHORING_STATE_VERSION,
    registeredTypes: [...REGISTERED_BLOCK_TYPES],
    installedTypes: [...INSTALLED_BLOCK_TYPES],
    contracts: JSON.stringify(blockDefs),
  }
}

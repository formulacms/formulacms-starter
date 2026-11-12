import {
  INSTALLED_SLICE_TYPES,
  REGISTERED_SLICE_TYPES,
  sliceDefs,
} from "./index"

export const SLICE_AUTHORING_STATE_VERSION = "slice-contract-state-v1" as const

/**
 * Exact installed contract/profile bytes for the app-local developer CLI.
 * Includes validators, primitive configuration/defaults, previews and hints.
 * This detects local/backend code drift; it is not semantic equivalence,
 * renderer identity, ownership or permission to mutate source.
 */
export function sliceAuthoringContractState() {
  return {
    version: SLICE_AUTHORING_STATE_VERSION,
    registeredTypes: [...REGISTERED_SLICE_TYPES],
    installedTypes: [...INSTALLED_SLICE_TYPES],
    contracts: JSON.stringify(sliceDefs),
  }
}

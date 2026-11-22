/** Owner applications retain the simulator only in local development. */
export type BlockSimulatorRoute = "/block-sim" | null

export const BLOCK_SIMULATOR_ROUTE: BlockSimulatorRoute =
  process.env.NODE_ENV === "production" ? null : "/block-sim"

/** Owner applications do not ship the design-system page. */
export type DesignSystemRoute = string | null

export const DESIGN_SYSTEM_ROUTE: DesignSystemRoute = null

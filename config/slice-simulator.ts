/** Owner applications retain the simulator only in local development. */
export type SliceSimulatorRoute = "/slice-sim" | null

export const SLICE_SIMULATOR_ROUTE: SliceSimulatorRoute =
  process.env.NODE_ENV === "production" ? null : "/slice-sim"

/** Owner applications do not ship the design-system page. */
export type DesignSystemRoute = string | null

export const DESIGN_SYSTEM_ROUTE: DesignSystemRoute = null

/** Owner applications retain the simulator only in local development. */
export type SliceSimulatorRoute = "/slice-sim" | null

export const SLICE_SIMULATOR_ROUTE: SliceSimulatorRoute =
  process.env.NODE_ENV === "production" ? null : "/slice-sim"

/** JSON-safe data forwarded opaquely from a server binding to its browser slot. */
export type AdminContributionRouteData =
  | null
  | boolean
  | number
  | string
  | readonly AdminContributionRouteData[]
  | Readonly<{ [key: string]: AdminContributionRouteData }>

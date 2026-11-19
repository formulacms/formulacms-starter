export type EffectiveHelpRoute =
  | { kind: "production" }
  | { kind: "selected-ready"; engine: string }
  | { kind: "selected-needs-setup"; engine?: string }
  /** Local development, a browser on another device: Help's local tool
   *  choice cannot be read or used there. */
  | { kind: "selected-other-device" }

export function canUseHelpAssistant(input: {
  productionConfigured: boolean
  effectiveRoute: EffectiveHelpRoute
  permissionsResolved: boolean
  hasContentAiPermission: boolean
}): boolean {
  const routeAvailable =
    input.effectiveRoute.kind === "production"
      ? input.productionConfigured
      : input.effectiveRoute.kind === "selected-ready"
  return (
    routeAvailable && input.permissionsResolved && input.hasContentAiPermission
  )
}

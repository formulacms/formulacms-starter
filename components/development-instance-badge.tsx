import { getTranslations } from "next-intl/server"

type DevelopmentEnvironment = {
  NODE_ENV?: string
  NEXT_PUBLIC_SITE_URL?: string
  CONVEX_DEPLOYMENT?: string
  NEXT_PUBLIC_CONVEX_URL?: string
}

function hostLabel(value: string | undefined): string {
  if (!value) return "localhost:3000"
  try {
    return new URL(value).host
  } catch {
    return value
  }
}

/** The deployment name in `CONVEX_DEPLOYMENT`, without its `kind:` prefix. */
export function configuredDeploymentName(
  environment: Pick<DevelopmentEnvironment, "CONVEX_DEPLOYMENT">
): string | null {
  const configured = environment.CONVEX_DEPLOYMENT?.trim()
  return configured ? configured.replace(/^[^:]+:/, "") : null
}

function deploymentLabel(
  environment: DevelopmentEnvironment,
  unidentified: string
): string {
  const configured = configuredDeploymentName(environment)
  if (configured) return configured

  const convexUrl = environment.NEXT_PUBLIC_CONVEX_URL?.trim()
  if (!convexUrl) return unidentified
  try {
    return new URL(convexUrl).hostname.replace(/\.convex\.cloud$/, "")
  } catch {
    return unidentified
  }
}

export function describeDevelopmentInstance(
  environment: DevelopmentEnvironment,
  labels = {
    caption: "Local development",
    unidentified: "Convex not identified",
  }
): string | null {
  if (environment.NODE_ENV !== "development") return null
  return [
    labels.caption,
    hostLabel(environment.NEXT_PUBLIC_SITE_URL),
    deploymentLabel(environment, labels.unidentified),
  ].join(" · ")
}

export async function DevelopmentInstanceBadge() {
  const t = await getTranslations("development")
  const caption = t("caption")
  const label = describeDevelopmentInstance(process.env, {
    caption,
    unidentified: t("unidentified"),
  })
  if (!label) return null

  return (
    <aside
      aria-label={t("label")}
      className="fixed top-3 right-3 z-50 max-w-[calc(100vw-1.5rem)] rounded-lg border bg-background/95 px-3 py-1.5 text-center text-xs text-muted-foreground shadow-sm backdrop-blur-sm"
    >
      {/* Phones show the caption alone; screen readers get the full text at
          every width. */}
      <span aria-hidden={true} className="md:hidden">
        {caption}
      </span>
      <span className="sr-only md:not-sr-only">{label}</span>
    </aside>
  )
}

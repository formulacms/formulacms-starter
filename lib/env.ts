type EnvSource = Record<string, string | undefined>

const PLACEHOLDER_PARTS = ["replace-with", "your-deployment"]

const REQUIRED_NEXT_RUNTIME_ENV = [
  "NEXT_PUBLIC_CONVEX_URL",
  "NEXT_PUBLIC_CONVEX_SITE_URL",
  "BETTER_AUTH_SECRET",
] as const

type RequiredNextRuntimeEnv = (typeof REQUIRED_NEXT_RUNTIME_ENV)[number]

function isPlaceholder(value: string): boolean {
  return PLACEHOLDER_PARTS.some((part) => value.includes(part))
}

function readRequiredEnv(name: RequiredNextRuntimeEnv, env: EnvSource): string {
  const value = env[name]?.trim()
  if (!value || isPlaceholder(value)) {
    throw new Error(
      `Missing required environment variable ${name}. Copy .env.example to .env.local and set a real value.`
    )
  }
  return value
}

export function getNextAuthEnv(env: EnvSource = process.env) {
  return {
    convexUrl: readRequiredEnv("NEXT_PUBLIC_CONVEX_URL", env),
    convexSiteUrl: readRequiredEnv("NEXT_PUBLIC_CONVEX_SITE_URL", env),
  }
}

export function validateNextRuntimeEnv(env: EnvSource = process.env): void {
  for (const name of REQUIRED_NEXT_RUNTIME_ENV) {
    readRequiredEnv(name, env)
  }
}

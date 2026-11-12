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
    throw new Error(missingEnvMessage(name))
  }
  return value
}

function missingEnvMessage(name: RequiredNextRuntimeEnv): string {
  if (name === "BETTER_AUTH_SECRET") {
    return `Missing required environment variable ${name}. The local setup is not finished. Do the README Quickstart steps in order before you run "pnpm dev": they create the secrets in .env.local, copy them to Convex and set the owner setup code. If .env.local already exists, keep it (it holds your Convex values) and add the missing lines from .env.local.example; do not copy the template over it. On a hosted site, set ${name} in your host's environment.`
  }
  return `Missing required environment variable ${name}. On your computer, the first backend start in the README Quickstart writes it to .env.local. On a hosted site, set it in your host's environment.`
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

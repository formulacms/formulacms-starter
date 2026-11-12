import type { NextConfig } from "next"

type RemotePattern = NonNullable<
  NonNullable<NextConfig["images"]>["remotePatterns"]
>[number]

type ImageOptimizationEnv = {
  NODE_ENV?: string
  FORMULACMS_ALLOW_LOCAL_IMAGE_IPS?: string
  NEXTCMS_ALLOW_LOCAL_IMAGE_IPS?: string
}

export function allowsLocalIpImageOptimization(
  env: ImageOptimizationEnv = process.env
): boolean {
  const configured =
    env.FORMULACMS_ALLOW_LOCAL_IMAGE_IPS ?? env.NEXTCMS_ALLOW_LOCAL_IMAGE_IPS
  return env.NODE_ENV === "development" || configured === "1"
}

// Convex storage URLs are the only remote images the public starter needs.
// Keep this list narrow: Next.js docs recommend remotePatterns over broad
// domains so arbitrary third-party images cannot be proxied through the app.
export const convexStorageRemotePatterns = [
  {
    protocol: "https",
    hostname: "storage.convex.dev",
    pathname: "/file",
  },
  {
    protocol: "https",
    hostname: "**.convex.cloud",
    pathname: "/api/storage/**",
  },
  {
    protocol: "https",
    hostname: "**.convex.site",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "127.0.0.1",
    port: "3210",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "127.0.0.1",
    port: "3211",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "127.0.0.1",
    port: "3212",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "127.0.0.1",
    port: "3213",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "localhost",
    port: "3210",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "localhost",
    port: "3211",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "localhost",
    port: "3212",
    pathname: "/api/storage/**",
  },
  {
    protocol: "http",
    hostname: "localhost",
    port: "3213",
    pathname: "/api/storage/**",
  },
] satisfies RemotePattern[]

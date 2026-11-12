import type { NextConfig } from "next"
import createNextIntlPlugin from "next-intl/plugin"
import { PHASE_DEVELOPMENT_SERVER } from "next/constants"
import { fileURLToPath } from "node:url"
import {
  allowsLocalIpImageOptimization,
  convexStorageRemotePatterns,
} from "./lib/media/next-image-config"
import {
  getPortableSecurityHeaders,
  IMAGE_CONTENT_SECURITY_POLICY,
} from "./lib/security/headers"

const withNextIntl = createNextIntlPlugin("./i18n/request.ts")

const allowLocalIpImageOptimization = allowsLocalIpImageOptimization()

const tweakLocLoader = fileURLToPath(
  new URL("./lib/slices/visual-tweak/tweak-loc-loader.cjs", import.meta.url)
)

const nextConfig: NextConfig = {
  reactCompiler: true,
  poweredByHeader: false,
  // Keep the TypeScript compiler out of the server bundle. Next already lists
  // `typescript` as a server external, but it matches the resolved path
  // (`node_modules/<name>/`), and package.json aliases `typescript` to
  // `@typescript/typescript6`. Without this entry the slice-authoring server
  // actions that the admin shell references (deletion overlay) bundle the
  // compiler (about 9 MB) into every admin route. Measured once per config on
  // an 8 GB host (2026-11-04): about 11% less total first-visit compile time
  // over five admin routes, 23% smaller server output in `pnpm dev`, and more
  // routes compiled before Next's dev memory-threshold restart.
  serverExternalPackages: ["@typescript/typescript6"],
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: getPortableSecurityHeaders(),
      },
    ]
  },
  experimental: {
    // Next only enables the webpack build worker by default when no custom
    // `webpack` callback exists (next/dist/build/index.js: `useBuildWorker =
    // experimental.webpackBuildWorker || (experimental.webpackBuildWorker ===
    // undefined && !config.webpack)`). The callback below is declared
    // unconditionally for a renderer revision loader, which silently opted the
    // production build out of the worker and ran webpack in the main process.
    //
    // That matters for the generated starter: `pnpm build:local` has to fit in
    // a 4 GB self-hosted box (and in CI's 2 CPU / 4 GB executor). Running the
    // compiler in its own process measurably lowers peak build memory, so this
    // stays explicitly true for as long as that callback exists.
    webpackBuildWorker: true,
    serverActions: {
      // Slice reference ingestion uploads the design at full resolution — the
      // comparison baseline is derived from those exact bytes, and the upload
      // itself is preserved (slice-fidelity plan §5 B2). The 1 MB default would
      // force a downscale before the file ever reached the server, which is the
      // fidelity loss that model exists to remove.
      //
      // Sized against the widest path: the simulator sends a data URL, so a
      // MAX_MEDIA_FILE_SIZE upload (10 MiB) becomes ~13.33 MiB of base64.
      // 14 MiB leaves ~680 KiB for the action envelope. Raise both together —
      // this ceiling is what actually bounds an upload, not the client check.
      bodySizeLimit: "14mb",
    },
  },
  webpack(config, { dev, buildId, webpack }) {
    // Next uses a constant buildId with deploymentId; the effective deployment
    // identity must distinguish those builds too. No deployment setting is changed.
    config.plugins.push(
      new webpack.DefinePlugin({
        __FORMULACMS_PREVIEW_BUILD_ID__: JSON.stringify(
          JSON.stringify([
            process.env.NEXT_DEPLOYMENT_ID || nextConfig.deploymentId || "",
            buildId,
          ])
        ),
      })
    )
    if (dev)
      config.module.rules.push({
        test: /components[\\/]slices[\\/](?:presentations[\\/])?[^\\/]+\.tsx$/,
        resourceQuery: /^\?tweak-loc$/,
        use: [{ loader: tweakLocLoader }],
      })
    return config
  },
  images: {
    remotePatterns: convexStorageRemotePatterns,
    dangerouslyAllowLocalIP: allowLocalIpImageOptimization,
    // react-doctor-disable-next-line react-doctor/active-static-asset
    dangerouslyAllowSVG: true,
    contentDispositionType: "attachment",
    contentSecurityPolicy: IMAGE_CONTENT_SECURITY_POLICY,
  },

  // typedRoutes is intentionally off: this CMS navigates using runtime values
  // (page slugs, menu hrefs, redirect targets) that static route typing can't
  // verify, so enabling it breaks legitimate DB-driven navigation.

  // Disabled cacheComponents - incompatible with admin pages using Convex useQuery
  // cacheComponents: true,
}

// Turbopack ignores the `webpack` callback above, so the two development-only
// pieces it carries are ported to Turbopack's own configuration. Both are
// added only for `next dev` running on Turbopack; `next build --webpack`,
// `next dev --webpack` and the callback itself stay exactly as they were.
//
// The bundler is read from `TURBOPACK`, which the Next CLI sets from the
// `--turbopack` / `--webpack` flag before it loads this file (the same signal
// next-intl uses to pick its own Turbopack branch). `pnpm dev` chooses the
// flag from FORMULACMS_DEV_BUNDLER (scripts/lib/dev-server-origin.ts).
function turbopackDevelopmentConfig(): NextConfig {
  return {
    ...nextConfig,
    compiler: {
      ...nextConfig.compiler,
      // Next serializes `compiler.define` values itself, so the value is the
      // JSON text once, which is what `JSON.stringify(JSON.stringify(...))`
      // produces for the webpack DefinePlugin above. Development servers use
      // the constant build id "development" on both bundlers.
      define: {
        ...nextConfig.compiler?.define,
        __FORMULACMS_PREVIEW_BUILD_ID__: JSON.stringify([
          process.env.NEXT_DEPLOYMENT_ID || nextConfig.deploymentId || "",
          "development",
        ]),
      },
    },
    turbopack: {
      ...nextConfig.turbopack,
      rules: {
        ...nextConfig.turbopack?.rules,
        // Same files and exact `?tweak-loc` query as the webpack rule above.
        // `path` is project-relative. No `as`: the loader returns TSX.
        "*.tsx": {
          condition: {
            all: [
              "development",
              {
                path: /^components\/slices\/(?:presentations\/)?[^/]+\.tsx$/,
                query: "?tweak-loc",
              },
            ],
          },
          loaders: [tweakLocLoader],
        },
      },
    },
  }
}

// next-intl's plugin reads `turbopack.rules` and `webpack` from a config
// object, so it wraps the object this function returns, not the function.
export default function config(phase: string): NextConfig {
  const resolved =
    phase === PHASE_DEVELOPMENT_SERVER && process.env.TURBOPACK
      ? turbopackDevelopmentConfig()
      : nextConfig
  return withNextIntl(resolved)
}

// Build the real proxy against fixed, credential-free data and exercise it
// through next start. Direct proxy unit tests cannot detect a rewrite being
// classified as an external HTTP request by Next's production router.
//
// M05 C5 (FR1c) restores this guard (contract "public-routing production
// guard") with the proxy's current Convex seams stubbed, and runs two sites:
// the default language chosen in Admin → Languages is unprefixed, every other
// enabled language is prefixed, a redundant default prefix answers 307, and a
// known but disabled language segment passes through untouched to its
// localized not-found route instead of resolving under the default language.
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { once } from "node:events"
import { createHash } from "node:crypto"
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { setTimeout as delay } from "node:timers/promises"

const root = fileURLToPath(new URL("..", import.meta.url))
const args = process.argv.slice(2)
assert(
  args.length === 0 ||
    (args.length === 2 &&
      args[0] === "--hostname" &&
      ["localhost", "127.0.0.1"].includes(args[1])),
  "Usage: node scripts/check-public-routing-production.mjs [--hostname localhost|127.0.0.1]"
)
// localhost is intentional. With Next 16.3.3, --hostname 127.0.0.1 makes
// NextURL's localhost-normalized rewrite differ from the router's origin.
// The IP option retains the original failing reproduction for diagnosis.
const hostname = args[1] ?? "localhost"
const fixture = await mkdtemp(join(tmpdir(), "formulacms-public-routing-"))
const next = join(root, "node_modules/next/dist/bin/next")
const nextVersion = JSON.parse(
  await readFile(join(root, "node_modules/next/package.json"), "utf8")
).version
const env = Object.fromEntries(
  Object.entries(process.env).filter(([key]) =>
    ["PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "SystemRoot"].includes(key)
  )
)
env.NEXT_TELEMETRY_DISABLED = "1"
let child
let completion
let output = ""

// Each site is selected at `next start` time through the fixture's stubbed
// configuration reader; one build serves both.
const SITES = [
  { defaultLocale: "en", enabledLocales: ["en", "fr"], disabled: "de" },
  { defaultLocale: "fr", enabledLocales: ["fr", "en"], disabled: "de" },
]

function start(commandArgs, extraEnv = {}) {
  output = ""
  child = spawn(process.execPath, [next, ...commandArgs], {
    cwd: fixture,
    env: { ...env, ...extraEnv },
    stdio: ["ignore", "pipe", "pipe"],
  })
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output = (output + chunk).slice(-32_000)
    })
  }
  // Install both handlers immediately; a spawn error must not go unhandled.
  completion = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }))
    child.once("exit", (code, signal) => resolve({ code, signal }))
  })
  return completion
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill("SIGTERM")
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000)
  try {
    await completion
  } finally {
    clearTimeout(timer)
  }
}

function request(url, init = {}) {
  return fetch(url, {
    redirect: "manual",
    ...init,
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]),
  })
}

async function checkSite(site) {
  const socket = createServer()
  socket.listen(0, hostname)
  await once(socket, "listening")
  const { port } = socket.address()
  await new Promise((resolve, reject) =>
    socket.close((error) => (error ? reject(error) : resolve()))
  )
  start(["start", "--hostname", hostname, "--port", String(port)], {
    ROUTING_FIXTURE_SITE: JSON.stringify(site),
  })
  const origin = `http://${hostname}:${port}`
  for (let attempt = 0; ; attempt++) {
    controller.signal.throwIfAborted()
    assert.equal(
      child.exitCode,
      null,
      `Next stopped before readiness: ${output}`
    )
    try {
      await (await request(`${origin}/`)).text()
      break
    } catch (error) {
      if (attempt >= 100) throw error
      await delay(100, undefined, { signal: controller.signal })
    }
  }

  const label = `default ${site.defaultLocale}`
  const stripComments = (body) => body.replace(/<!--[\s\S]*?-->/g, "")
  const results = []
  for (const locale of site.enabledLocales) {
    const prefix = locale === site.defaultLocale ? "" : `/${locale}`
    for (const path of ["", "/contact", "/docs"]) {
      const visible = `${prefix}${path}` || "/"
      for (const method of ["GET", "HEAD"]) {
        const response = await request(origin + visible, { method })
        const body = await response.text()
        const location = response.headers.get("location")
        assert.equal(
          response.status,
          200,
          `${label} ${method} ${visible}: ${response.status}, Location: ${location}`
        )
        assert.equal(location, null)
        if (method === "GET") {
          assert(
            body.includes(`<html lang="${locale}">`),
            `${label} ${visible}: wrong language`
          )
          const expectedContent = `${locale}:${path.slice(1) || "home"}`
          assert(
            stripComments(body).includes(`<main>${expectedContent}</main>`),
            `${label} ${visible}: wrong rendered page`
          )
        }
        results.push({ method, path: visible, status: response.status })
      }
      if (locale === site.defaultLocale) {
        // A redundant default-language prefix is removed with a 307 (next-intl strip).
        const prefixed = `/${locale}${path}?routing=check`
        const response = await request(origin + prefixed)
        await response.text()
        assert.equal(response.status, 307, `${label} ${prefixed}`)
        const target = new URL(response.headers.get("location"), origin)
        assert.equal(target.origin, origin)
        assert.equal(target.pathname, visible)
        assert.equal(target.search, "?routing=check")
        const final = await request(target)
        await final.text()
        assert.equal(
          final.status,
          200,
          `${label} ${prefixed}: redirect did not terminate`
        )
        results.push({
          path: prefixed,
          status: 307,
          target: target.pathname + target.search,
        })
      }
    }
  }
  // A known but disabled language keeps its segment: it reaches the localized
  // route (whose layout presents the default language and 404s) instead of
  // resolving the default language's page by leaf slug.
  const disabled = `/${site.disabled}/contact`
  const response = await request(origin + disabled)
  const body = stripComments(await response.text())
  assert.equal(response.headers.get("location"), null, `${label} ${disabled}`)
  assert(
    body.includes(`<main>${site.disabled}:contact</main>`),
    `${label} ${disabled}: rewritten under another language`
  )
  results.push({ path: disabled, status: response.status, passThrough: true })
  return results
}

const controller = new AbortController()
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => controller.abort(new Error(`Received ${signal}`)))
}
const deadline = setTimeout(
  () => controller.abort(new Error("Production routing check timed out")),
  180_000
)
controller.signal.addEventListener("abort", () => void stop(), { once: true })

try {
  await symlink(
    join(root, "node_modules"),
    join(fixture, "node_modules"),
    "dir"
  )
  const fixtures = {
    "package.json": JSON.stringify({ private: true, type: "module" }),
    "next.config.mjs": `import { join } from "node:path"
export default {
  webpack(config) {
    config.resolve.alias["convex/nextjs$"] = join(process.cwd(), "stubs/convex-nextjs.js")
    return config
  },
}
`,
    // Every Convex function reference is a path the stubbed fetchQuery reads.
    "convex/_generated/api.ts": `function reference(path) {
      return new Proxy({}, {
        get: (_, key) => key === "__path" ? path.join(".") : reference([...path, key]),
      })
    }
    export const api = reference([])`,
    "stubs/convex-nextjs.js": `export async function fetchQuery(reference) {
      const name = reference.__path
      if (name === "cms.pages.resolveHistoricalPublishedPath") {
        return { authority: "snapshot_active", disposition: "unclaimed" }
      }
      if (name === "cms.redirects.resolve") return null
      throw new Error("Unexpected fixture query " + name)
    }`,
    "lib/cms/cache.ts": `export function isSiteLanguageVersionChanged() { return false }`,
    "lib/modules/containment.ts": `export function reportContainedModuleFailure() {}`,
    "jsconfig.json": JSON.stringify({
      compilerOptions: { baseUrl: ".", paths: { "@/*": ["./*"] } },
    }),
    "lib/i18n/site-config.ts": `export async function getSiteConfigState() {
      const site = JSON.parse(process.env.ROUTING_FIXTURE_SITE)
      return { status: "ready", value: {
        onboardingCompletedAt: 1,
        defaultLocale: site.defaultLocale,
        enabledLocales: site.enabledLocales,
        languageVersion: 0,
      } }
    }
    export const refreshSiteConfigState = getSiteConfigState`,
    "lib/i18n/redirect-keys.ts": `export async function getCachedRedirectKeySet() { return new Set() }
      export function hasRedirectKey() { return false }`,
    "app/[locale]/layout.jsx": `export default async function Layout({children, params}) {
      const {locale} = await params
      return <html lang={locale}><body>{children}</body></html>
    }`,
    "app/[locale]/[[...path]]/page.jsx": `export function generateStaticParams() {
      return ["en", "fr"].flatMap(locale => [[], ["contact"]].map(path => ({locale, path})))
    }
    export default async function Page({params}) {
      const {locale, path = []} = await params
      return <main>{locale}:{path.join("/") || "home"}</main>
    }`,
    "app/[locale]/docs/[[...slug]]/page.jsx": `export function generateStaticParams() {
      return ["en", "fr"].map(locale => ({locale, slug: []}))
    }
    export default async function Page({params}) {
      const {locale} = await params
      return <main>{locale}:docs</main>
    }`,
  }
  for (const [name, content] of Object.entries(fixtures)) {
    const target = join(fixture, name)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content)
  }
  for (const name of [
    "proxy.ts",
    "lib/pages/home-aliases.ts",
    "lib/i18n/config.ts",
  ]) {
    await mkdir(dirname(join(fixture, name)), { recursive: true })
    await copyFile(join(root, name), join(fixture, name))
  }
  const proxySha256 = createHash("sha256")
    .update(await readFile(join(fixture, "proxy.ts")))
    .digest("hex")
  const build = await start(["build", "--webpack"])
  controller.signal.throwIfAborted()
  assert.equal(build.code, 0, `Production fixture build failed: ${output}`)

  const results = []
  for (const site of SITES) {
    results.push({ site, checks: await checkSite(site) })
    await stop()
  }
  console.log(
    JSON.stringify({ hostname, nextVersion, proxySha256, results }, null, 2)
  )
} finally {
  clearTimeout(deadline)
  await stop()
  await rm(fixture, { recursive: true, force: true })
}

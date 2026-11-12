import { spawn } from "node:child_process"
import { createConnection } from "node:net"
import { resolve } from "node:path"
import nextEnv from "@next/env"
import {
  devServerArguments,
  occupiedDevPortMessage,
  resolveDevBundler,
  resolveDevServerOrigin,
  type DevServerOrigin,
} from "./lib/dev-server-origin"
import { runLocalSetup } from "./lib/local-setup"

async function assertPortAvailable(config: DevServerOrigin): Promise<void> {
  await new Promise<void>((resolveAvailable, reject) => {
    const socket = createConnection({
      host: config.hostname,
      port: config.port,
    })
    socket.unref()
    socket.setTimeout(1_000)
    socket.once("connect", () => {
      socket.destroy()
      reject(new Error(occupiedDevPortMessage(config)))
    })
    socket.once("error", (error: NodeJS.ErrnoException) => {
      socket.destroy()
      if (error.code === "ECONNREFUSED") {
        resolveAvailable()
        return
      }
      reject(error)
    })
    socket.once("timeout", () => {
      socket.destroy()
      reject(
        new Error(
          `Could not verify whether ${config.origin} is available. Try again.`
        )
      )
    })
  })
}

async function main(): Promise<void> {
  const projectRoot = process.cwd()
  // Before loadEnvConfig: the step writes the secrets it fills into
  // process.env itself, so Next.js starts with them.
  const setup = await runLocalSetup({ projectRoot, processEnv: process.env })
  for (const line of setup.lines) console.log(line)
  if (setup.status === "failed") {
    process.exitCode = 1
    return
  }
  nextEnv.loadEnvConfig(projectRoot, true)
  const config = resolveDevServerOrigin({
    BETTER_AUTH_URL: process.env.BETTER_AUTH_URL,
  })
  const bundler = resolveDevBundler(process.env)
  await assertPortAvailable(config)

  const deployment =
    process.env.CONVEX_DEPLOYMENT?.trim() ||
    process.env.NEXT_PUBLIC_CONVEX_URL?.trim() ||
    "not configured"
  console.log(`[formulacms] Frontend: ${config.origin}`)
  console.log(`[formulacms] Convex: ${deployment}`)
  console.log(`[formulacms] Bundler: ${bundler}`)
  // Last, so the owner setup code does not scroll away in the Convex log.
  if (setup.box) console.log(setup.box)

  const nextBinary = resolve(projectRoot, "node_modules/next/dist/bin/next")
  const child = spawn(
    process.execPath,
    [nextBinary, ...devServerArguments(config, bundler)],
    { env: process.env, stdio: "inherit" }
  )

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => child.kill(signal))
  }

  const exitCode = await new Promise<number>((resolveExit, reject) => {
    child.once("error", reject)
    child.once("exit", (code) => resolveExit(code ?? 1))
  })
  process.exitCode = exitCode
}

main().catch((error) => {
  console.error(
    `[formulacms] ${error instanceof Error ? error.message : String(error)}`
  )
  process.exitCode = 1
})

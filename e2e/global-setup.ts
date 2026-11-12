import { existsSync } from "node:fs"
import { join } from "node:path"

/**
 * External-server mode only (`FR6_E2E_SERVER=external`). The caller owns Next
 * and Convex; this check starts and stops nothing. It refuses to run specs
 * unless the named local origin answers and the app has been built (D2).
 */
export default async function globalSetup() {
  const baseUrl = process.env.PUBLIC_BASE_URL
  if (!baseUrl) {
    throw new Error("FR6_E2E_SERVER=external requires PUBLIC_BASE_URL to name the running local origin")
  }
  const origin = new URL(baseUrl).origin
  let status: number
  try {
    const response = await fetch(`${origin}/`, {
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    status = response.status
  } catch (error) {
    throw new Error(
      `The external server at ${origin} did not answer within 15 s. Start it with the owning launcher first ` +
        `(${error instanceof Error ? error.message : String(error)})`
    )
  }
  if (status >= 500) {
    throw new Error(`The external server at ${origin} answered ${status}; it must answer below 500`)
  }
  if (!existsSync(join(process.cwd(), ".next", "BUILD_ID"))) {
    throw new Error(`No production build at ${join(process.cwd(), ".next", "BUILD_ID")}; build the app before running specs`)
  }
}

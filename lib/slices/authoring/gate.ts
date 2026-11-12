import { execFile } from "node:child_process"
import { promisify } from "node:util"
import { existsSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { pathToFileURL } from "node:url"
import {
  summarizeGateOutput,
  summarizeSliceGateOutput,
} from "@/lib/slices/authoring/gate-errors"

const execFileAsync = promisify(execFile)
const TYPECHECK_TIMEOUT_MS = 120_000
const VERIFY_TIMEOUT_MS = 120_000
const TYPECHECK_MAX_BUFFER = 4 * 1024 * 1024

/** Resolve the installed project's checker without invoking a package manager. */
function typecheckBinary(root: string): string {
  const require = createRequire(join(root, "package.json"))
  let packagePath: string
  try {
    // This repository/application's `tsc` command belongs to the native package.
    packagePath = require.resolve("@typescript/native/package.json")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "MODULE_NOT_FOUND")
      throw error
    packagePath = require.resolve("typescript/package.json")
  }
  const metadata = JSON.parse(readFileSync(packagePath, "utf8")) as {
    bin?: string | Record<string, string>
  }
  const binary =
    typeof metadata.bin === "string"
      ? metadata.bin
      : (metadata.bin?.tsc ?? metadata.bin?.tsc6)
  if (!binary)
    throw new Error("The installed TypeScript package has no checker.")
  return join(dirname(packagePath), binary)
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function commandOutput(error: unknown): string {
  const result = error as { stdout?: unknown; stderr?: unknown }
  const output = [result.stdout, result.stderr]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0
    )
    .join("\n")
    .trim()
  return output || message(error)
}

export async function runTypecheckGate(
  type?: string,
  root = process.cwd()
): Promise<void> {
  try {
    const tsc = typecheckBinary(root)
    const gateConfig = join(root, "tsconfig.gate.json")
    await execFileAsync(
      process.execPath,
      [
        tsc,
        "--noEmit",
        "--incremental",
        "false",
        ...(existsSync(gateConfig) ? ["--project", gateConfig] : []),
      ],
      {
        cwd: root,
        timeout: TYPECHECK_TIMEOUT_MS,
        maxBuffer: TYPECHECK_MAX_BUFFER,
      }
    )
  } catch (error) {
    const output = commandOutput(error)
    throw new Error(
      `Generated slice failed typecheck and was rolled back:\n${
        type
          ? summarizeSliceGateOutput(output, type)
          : summarizeGateOutput(output)
      }`
    )
  }
}

export async function runSliceGate(
  type: string,
  root = process.cwd()
): Promise<void> {
  await runTypecheckGate(type, root)
  try {
    const require = createRequire(join(root, "package.json"))
    await execFileAsync(
      process.execPath,
      [
        "--import",
        pathToFileURL(require.resolve("tsx")).href,
        join(root, "scripts/verify-slice.ts"),
        type,
      ],
      {
        cwd: root,
        timeout: VERIFY_TIMEOUT_MS,
        maxBuffer: TYPECHECK_MAX_BUFFER,
      }
    )
  } catch (error) {
    throw new Error(
      `Generated slice failed verification and was rolled back:\n${summarizeGateOutput(
        commandOutput(error),
        40
      )}`
    )
  }
}

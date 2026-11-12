import { execFileSync } from "node:child_process"
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"

const root = process.cwd()
const excludedTypes = process.argv.flatMap((arg, index, args) =>
  arg === "--exclude" && args[index + 1] ? [args[index + 1]] : []
)

if (excludedTypes.length === 0) {
  throw new Error("Pass at least one Slice Type with --exclude <type>.")
}

async function copyWorkspaceFile(relativePath, destinationRoot) {
  const source = join(root, relativePath)
  const destination = join(destinationRoot, relativePath)
  let info
  try {
    info = await lstat(source)
  } catch (error) {
    if (error?.code === "ENOENT") return
    throw error
  }
  await mkdir(dirname(destination), { recursive: true })
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination)
    return
  }
  if (info.isFile()) await copyFile(source, destination)
}

async function main() {
  const scratch = await mkdtemp(join(tmpdir(), "formulacms-slice-profile-"))
  try {
    const trackedAndNew = execFileSync(
      "git",
      ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd: root }
    )
      .toString("utf8")
      .split("\u0000")
      .filter(Boolean)
    for (const relativePath of trackedAndNew) {
      await copyWorkspaceFile(relativePath, scratch)
    }
    await symlink(join(root, "node_modules"), join(scratch, "node_modules"))

    const manifestPath = join(scratch, "lib", "slices", "slices.manifest.json")
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"))
    const registered = new Set(manifest.map((entry) => entry.type))
    for (const type of excludedTypes) {
      if (!registered.has(type)) {
        throw new Error(`Cannot exclude unregistered Slice Type "${type}".`)
      }
    }
    const narrowed = manifest.map((entry) =>
      excludedTypes.includes(entry.type) ? { ...entry, selected: false } : entry
    )
    await writeFile(manifestPath, `${JSON.stringify(narrowed, null, 2)}\n`)

    console.log(
      `Checking narrowed slice profile without: ${excludedTypes.join(", ")}`
    )
    execFileSync(
      join(scratch, "node_modules", ".bin", "tsx"),
      ["scripts/sync-slice-registration.ts"],
      { cwd: scratch, stdio: "inherit" }
    )
    execFileSync(
      join(scratch, "node_modules", ".bin", "tsc"),
      ["--noEmit", "--pretty", "false"],
      { cwd: scratch, stdio: "inherit" }
    )
    console.log("Narrowed slice profile typecheck passed.")
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
}

await main()

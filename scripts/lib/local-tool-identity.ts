// Which installed Claude Code or Codex a run would start, as a short key: the
// executable's real path, size and modification time. Settings › AI keeps a
// tool's model list only while this key is unchanged (`local-tool-models.ts`),
// so an upgrade shows its own list on the next page load. Synchronous file
// metadata only: no process starts and no file content is read.

import { accessSync, constants, realpathSync, statSync } from "node:fs"
import { delimiter, join } from "node:path"
import { claudeOnPath } from "./claude-cli-discovery"
import { resolveCodexCommand } from "./codex-app-server"
import { localToolEnvironment } from "./subscription-cli-process"

/** The first executable `name` on PATH, the same way `claudeOnPath` looks. */
function onPath(name: string, path: string | undefined): string {
  const names = process.platform === "win32" ? [`${name}.exe`, name] : [name]
  for (const dir of (path ?? "").split(delimiter)) {
    if (!dir) continue
    for (const candidate of names.map((entry) => join(dir, entry))) {
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Not here.
      }
    }
  }
  throw new Error(`${name} is not on the PATH.`)
}

/** The executable a run starts: Claude Code from the tool environment's PATH;
 * Codex from `FORMULACMS_CODEX_BIN` (read from the raw environment, as a run
 * does) or, for a bare name, from the tool environment's PATH, as the spawn does. */
function executable(tool: "claude" | "codex", env: Partial<NodeJS.ProcessEnv>): string {
  const toolEnv = localToolEnvironment({ env })
  if (tool === "claude") return claudeOnPath(toolEnv)
  const command = resolveCodexCommand(env)
  return /[\\/]/u.test(command) ? command : onPath(command, toolEnv.PATH)
}

/** The installed tool's key, or undefined when it cannot be found or read. */
export function localToolIdentity(
  tool: "claude" | "codex",
  env: Partial<NodeJS.ProcessEnv> = process.env
): string | undefined {
  try {
    const path = realpathSync(executable(tool, env))
    const { size, mtimeMs } = statSync(path)
    return `${path}\0${size}\0${mtimeMs}`
  } catch {
    return undefined
  }
}

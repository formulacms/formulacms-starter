import { dirname, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { markLocalStateInUse } from "../lib/local-state/directory"

const HELP = `Review and maintain registered Slice Type models and shared renderers in your own site, on a local backend.

Sign in once:
  pnpm slices:author login --app-root <app> --backend-url http://127.0.0.1:3210
  pnpm slices:author logout --app-root <app> --backend-url http://127.0.0.1:3210

Login asks for the owner's username and password; the password is not shown.
Piped input works too: the username on the first line, the password on the
second. The CLI keeps its own session in <app>/.slice-authoring-session.json
(git-ignored, readable only by you) and renews it by itself, so it never signs
the browser out. Only the tokens are saved, never the password. The session
ends after 7 days without use or 30 days after sign-in; then sign in again.
Logout ends the session and deletes the file. One command runs at a time per app.

Usage:
  pnpm slices:author list --app-root <app> --app-url http://localhost:3000 --backend-url http://127.0.0.1:3210
  pnpm slices:author detail <type> --app-root <app> --app-url http://localhost:3000 --backend-url http://127.0.0.1:3210

Also supported (same explicit target options):
  review-model <type> --spec-file <protected-spec-file>
  update-model <type> --spec-file <protected-spec-file> --expected-revision <64hex>
  review-renderer <type> --operations-file <protected-operations-file>
  update-renderer <type> --operations-file <protected-operations-file> --expected-revision <64hex>
  delete <type> --expected-revision <64hex>
  archive <type> --expected-revision <64hex>
  reactivate <type> --expected-revision <64hex>
  review-create <new-type> --spec-file <protected-spec-file>
  create <new-type> --spec-file <protected-spec-file> --expected-revision <catalog-64hex>
  retry-cleanup <deleted-type>

The spec file must be owned by you, permit no group/other access and stay
under 1 MiB. Symlinks and hard links are refused.
Review prints normalized input, changes and the current revision. Update and
delete apply through the ordinary source service and installed app checks.
Create uses the deterministic model scaffold; review-create prints its files,
conflicts, unrendered fields and current catalog revision. Create requires that
exact catalog revision and runs the installed app typecheck and SSR checks.
Renderer operations use a protected JSON array, limited to 1 MiB and 128 entries.
Each entry has exactly kind, target, tag, scope, group, expected, next, sourceHash
and postcondition. Only kind=class.replace and group=spacing:<axis> are supported.
Use the current JSX opening tag's one-based file:line:column as target, its
intrinsic tag name, and the renderer file's SHA-256 as sourceHash. Scope is all,
below-sm or sm-and-up. Expected is the current scoped spacing token or null;
next is one supported replacement token. Postcondition is
{"kind":"class-token","value":"<same next token>"}.
Review prints actual source, pending diff, current Type source revision and
authoritative retained Type references. Use that revision for update-renderer.
Update preserves hand-authored structure and runs the installed app gate with
rollback. These shared source changes affect usages resolving this renderer,
including already published Pages when the source is installed. Type-reference
counts do not establish how many renderings use it; alternative designs can
resolve another renderer. Arbitrary renderer code is outside these commands.
After a source change, recompile or push to the same local development backend
before another command. Current contract equality remains a command precondition.
If deletion reports cleanup_pending, recompile or push the changed source to the
same ordinary local backend, then retry-cleanup with the same explicit targets.
Retry requires the Type's local descriptor and renderer to be absent, exact
current backend/local contract equality, and uses only the ordinary cleanup
mutation. An absent archive marker reports already_clean without a mutation.
Every command requires exact local/backend contract-state equality; it proves no
semantic equivalence, renderer parity or authority to write source.
The app config must map only @/* to ./* without extends or an external baseUrl.
TSX_TSCONFIG_PATH overrides are refused.`

async function main() {
  const args = process.argv.slice(2)
  if (args.length === 1 && (args[0] === "--help" || args[0] === "-h")) {
    console.log(HELP)
    return
  }
  if (process.env.TSX_TSCONFIG_PATH) {
    console.error(
      "Explicit tsx environment configuration overrides are not supported."
    )
    process.exitCode = 1
    return
  }
  let cli: typeof import("./lib/slice-authoring-cli")
  try {
    cli = await import("./lib/slice-authoring-cli")
  } catch {
    console.error("Slice authoring refused.")
    process.exitCode = 1
    return
  }
  const {
    createSliceAuthoringReadTransport,
    readTerminalCredentials,
    runSliceAuthoringCommand,
    runSliceAuthoringSessionCommand,
    sliceAuthoringFailure,
  } = cli
  try {
    if (args[0] === "login" || args[0] === "logout") {
      console.log(
        JSON.stringify(
          await runSliceAuthoringSessionCommand(
            args,
            fileURLToPath(import.meta.url),
            createSliceAuthoringReadTransport(),
            readTerminalCredentials
          ),
          null,
          2
        )
      )
      return
    }
    const result = await runSliceAuthoringCommand(
      args,
      fileURLToPath(import.meta.url),
      createSliceAuthoringReadTransport()
    )
    console.log(JSON.stringify(result, null, 2))
    if (
      "result" in result &&
      result.result &&
      "status" in result.result &&
      ["refused", "blocked", "cleanup_pending"].includes(result.result.status)
    )
      process.exitCode = 1
  } catch (error) {
    console.error(sliceAuthoringFailure(error))
    process.exitCode = 1
  }
}

if (
  process.argv[1] &&
  pathToFileURL(process.argv[1]).href === import.meta.url
) {
  // First: the server-start move must not rename local state this run uses.
  // The app root is this script's own site (the CLI refuses any other).
  markLocalStateInUse(resolve(dirname(fileURLToPath(import.meta.url)), ".."))
  void main()
}

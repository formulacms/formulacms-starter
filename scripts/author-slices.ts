import { fileURLToPath, pathToFileURL } from "node:url"

const HELP = `Review and maintain registered Slice Type models and shared renderers in a separately created local application.

Usage:
  node --import tsx scripts/author-slices.ts list --app-root <app> --app-url http://localhost:3000 --backend-url http://127.0.0.1:3210 --cookie-file <protected-file>
  node --import tsx scripts/author-slices.ts detail <type> --app-root <app> --app-url http://localhost:3000 --backend-url http://127.0.0.1:3210 --cookie-file <protected-file>

Also supported (same explicit target/cookie options):
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

The spec file is protected like the cookie file and is limited to 1 MiB.
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
The cookie file contains only the normal session Cookie header value, is owned
by the current user and permits no group/other access. Symlinks are refused.
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
    runSliceAuthoringCommand,
    sliceAuthoringFailure,
  } = cli
  try {
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
  void main()
}

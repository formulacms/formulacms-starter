// Tests never start a real vendor tool (`claude`, `codex`). Every native
// launch default (the code that calls `node:child_process` when no fake is
// injected) calls this check first. Under Vitest (`VITEST` is set in every
// worker) or `node --test` it throws, so a test that forgot to inject a fake
// fails with a clear error instead of starting the tool. There is no opt-out:
// a test injects a fake at the function's own seam. Outside a test runner it
// does nothing.

export class NativeLaunchBlockedError extends Error {
  readonly command: string

  constructor(command: string) {
    super(
      `A test tried to start the real "${command}". Inject a fake instead; tests never start a vendor tool.`
    )
    this.name = "NativeLaunchBlockedError"
    this.command = command
  }
}

/** True in a Vitest worker or a `node --test` run (either isolation mode). */
export function isTestRun(): boolean {
  return (
    Boolean(process.env.VITEST) ||
    Boolean(process.env.NODE_TEST_CONTEXT) ||
    process.execArgv.includes("--test")
  )
}

/** Throws `NativeLaunchBlockedError` when a test run reaches a native launch. */
export function assertNativeLaunchAllowed(command: string): void {
  if (isTestRun()) throw new NativeLaunchBlockedError(command)
}

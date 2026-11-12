export interface CaptureFidelityCliArgs {
  /** The folder to capture into; omitted means "create one for this run". */
  runDir: string | undefined
}

const RUN_DIR_FLAG = "--run-dir"
const RUN_DIR_MISSING_VALUE = `${RUN_DIR_FLAG} needs the folder to capture into.`

export function parseCaptureFidelityArgs(
  args: string[]
): CaptureFidelityCliArgs {
  const consumed = new Set<number>()
  let runDir: string | undefined

  const inlineIndex = args.findIndex((arg) =>
    arg.startsWith(`${RUN_DIR_FLAG}=`)
  )
  if (inlineIndex !== -1) {
    runDir = args[inlineIndex].slice(RUN_DIR_FLAG.length + 1)
    if (!runDir) throw new Error(RUN_DIR_MISSING_VALUE)
    consumed.add(inlineIndex)
  } else {
    const index = args.indexOf(RUN_DIR_FLAG)
    if (index !== -1) {
      const value = args[index + 1]
      if (!value || value.startsWith("-")) {
        throw new Error(RUN_DIR_MISSING_VALUE)
      }
      runDir = value
      consumed.add(index)
      consumed.add(index + 1)
    }
  }

  // This command captures every design that has an accepted width, so it no
  // longer takes a slice name. Saying so beats quietly ignoring the argument.
  const stray = args.find(
    (arg, index) => !arg.startsWith("-") && !consumed.has(index)
  )
  if (stray) {
    throw new Error(
      `This command captures every design that has an accepted width, so it takes no slice name (got "${stray}"). Run it with no arguments.`
    )
  }

  return { runDir }
}

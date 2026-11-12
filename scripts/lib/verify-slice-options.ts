export interface VerifySliceCliArgs {
  /** Every slice that has a committed design image. */
  allReferenced: boolean
  /** Every slice whose design has an accepted width on record. */
  contracted: boolean
  requestedType: string | undefined
  /** The folder holding the pictures the current run captured. */
  candidateDir: string | undefined
  skipFidelity: boolean
}

const CANDIDATES_FLAG = "--candidates"
const CANDIDATES_MISSING_VALUE = `${CANDIDATES_FLAG} needs the folder that holds this run's captured pictures.`

export function parseVerifySliceArgs(args: string[]): VerifySliceCliArgs {
  const allReferenced = args.includes("--all-referenced")
  const contracted = args.includes("--contracted")
  const skipFidelity = args.includes("--no-fidelity")

  if (allReferenced && contracted) {
    throw new Error(
      "Use either --all-referenced or --contracted, not both: they choose different sets of slices."
    )
  }
  if ((allReferenced || contracted) && skipFidelity) {
    throw new Error(
      "--no-fidelity is only valid for single-slice generation finalization."
    )
  }

  let candidateDir: string | undefined
  // Track which positions the flag consumed, so a directory path can never be
  // mistaken for the slice name in the positional scan below.
  const consumed = new Set<number>()
  args.forEach((arg, index) => {
    if (arg.startsWith(`${CANDIDATES_FLAG}=`)) {
      candidateDir = arg.slice(CANDIDATES_FLAG.length + 1)
      if (!candidateDir) throw new Error(CANDIDATES_MISSING_VALUE)
      return
    }
    if (arg !== CANDIDATES_FLAG) return
    const value = args[index + 1]
    if (!value || value.startsWith("-")) {
      throw new Error(CANDIDATES_MISSING_VALUE)
    }
    candidateDir = value
    consumed.add(index + 1)
  })

  return {
    allReferenced,
    contracted,
    requestedType: args.find(
      (arg, index) => !arg.startsWith("-") && !consumed.has(index)
    ),
    candidateDir,
    skipFidelity,
  }
}

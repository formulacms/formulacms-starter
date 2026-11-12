// Structural list operations need an explicit signal: swapping identical
// primitive values has no observable JSON difference. Keep it off persisted data.
const structuralLists = new WeakSet<unknown[]>()
export function markStructuralListOperation<T>(list: T[]): T[] {
  structuralLists.add(list)
  return list
}
export function isStructuralListOperation(value: unknown[]): boolean {
  return structuralLists.has(value)
}

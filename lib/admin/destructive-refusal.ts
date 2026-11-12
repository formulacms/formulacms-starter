import { ConvexError } from "convex/values"

const DESTRUCTIVE_REFUSAL_CODES = {
  MEDIA_SOFT_DELETE_REFERENCED: true,
  PAGE_SOFT_DELETE_MENU_REFERENCE: true,
  PAGE_SOFT_DELETE_PUBLISHED_POST_REFERENCE: true,
  // The home page can be neither archived nor moved to trash.
  PAGE_HOME_LIFECYCLE_REFUSED: true,
} as const

export type DestructiveRefusalCode = keyof typeof DESTRUCTIVE_REFUSAL_CODES

function isDestructiveRefusalCode(
  value: string
): value is DestructiveRefusalCode {
  return Object.hasOwn(DESTRUCTIVE_REFUSAL_CODES, value)
}

function refusalCode(error: unknown): DestructiveRefusalCode | null {
  if (error instanceof ConvexError) {
    const data: unknown = error.data
    if (typeof data === "string") {
      return isDestructiveRefusalCode(data) ? data : null
    }
    if (
      data !== null &&
      typeof data === "object" &&
      "code" in data &&
      typeof data.code === "string"
    ) {
      return isDestructiveRefusalCode(data.code) ? data.code : null
    }
  }

  // A transport may preserve only the formatted Error message. Inspect it
  // solely for an allowlisted stable code; never render server text itself.
  if (error instanceof Error) {
    const code = Object.keys(DESTRUCTIVE_REFUSAL_CODES).find((candidate) =>
      error.message.includes(candidate)
    )
    return code && isDestructiveRefusalCode(code) ? code : null
  }

  return null
}

export function destructiveRefusalMessage(
  error: unknown,
  fallback: string,
  messages: Partial<Readonly<Record<DestructiveRefusalCode, string>>>
): string {
  const code = refusalCode(error)
  return (code && messages[code]) ?? fallback
}

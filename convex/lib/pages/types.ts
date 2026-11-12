import { v } from "convex/values"

// @content-type-codegen:page-types:start
export const PAGE_TYPES = [
  "landing-page",
  "page",
  "post",
  "author",
  "testimonial",
  "job",
] as const
// @content-type-codegen:page-types:end
export type PageType = (typeof PAGE_TYPES)[number]

// @content-type-codegen:page-type-validator:start
export const pageTypeValidator = v.union(
  v.literal("landing-page"),
  v.literal("page"),
  v.literal("post"),
  v.literal("author"),
  v.literal("testimonial"),
  v.literal("job")
)
// @content-type-codegen:page-type-validator:end

export function isPageType(value: string): value is PageType {
  return (PAGE_TYPES as readonly string[]).includes(value)
}

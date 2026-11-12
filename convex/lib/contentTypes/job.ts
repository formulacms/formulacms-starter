import { v } from "convex/values"
import { text, link, select, number, date } from "../slices/primitives"
import type { ContentTypeDescriptor } from "./types"

const sharedFields = {
  department: text().optional().public(),
  location: text().optional().public(),
  remoteType: select({ options: ["remote", "hybrid", "onsite"], default: "onsite", labels: { remote: "Remote", hybrid: "Hybrid", onsite: "On-site" } }).public(),
  employmentType: select({ options: ["full-time", "part-time", "contract", "internship", "temporary"], default: "full-time", labels: { "full-time": "Full-time", "part-time": "Part-time", contract: "Contract", internship: "Internship", temporary: "Temporary" } }).public(),
  salaryCurrency: select({ options: ["USD", "EUR", "GBP", "CAD", "AUD"], default: "USD", labels: { USD: "USD", EUR: "EUR", GBP: "GBP", CAD: "CAD", AUD: "AUD" } }).public(),
  // Not `.optional()`. A field that is both optional and defaulted has two
  // ways to say "no salary given" — absent, or 0 — and the two are
  // indistinguishable to every reader. One canonical empty value (0) is what
  // the public renderer already tests for, and it means the create path writes
  // the field instead of skipping it (`descriptorDefaults` omits optional
  // fields), so a job row's shape does not depend on when it was created.
  salaryMin: number({ default: 0, min: 0 }).public(),
  salaryMax: number({ default: 0, min: 0 }).public(),
  applyUrl: link().optional().public(),
  applyEmail: text({ placeholder: "careers@example.com" }).optional().public(),
  closingDate: date().optional().public(),
  jobStatus: select({ options: ["open", "closed", "filled"], default: "open", labels: { open: "Open", closed: "Closed", filled: "Filled" } }).public(),
} as const

const localizedFields = {
  title: text().public(),
  summary: text({ multiline: true }).optional().public(),
} as const

export const jobContentType: ContentTypeDescriptor<
  typeof sharedFields,
  typeof localizedFields
> = {
  type: "job",
  label: { singular: "Job", plural: "Jobs" },
  sharedFields,
  localizedFields,
  sharedValidator: v.object({
    department: sharedFields.department.validator,
    location: sharedFields.location.validator,
    remoteType: sharedFields.remoteType.validator,
    employmentType: sharedFields.employmentType.validator,
    salaryCurrency: sharedFields.salaryCurrency.validator,
    salaryMin: sharedFields.salaryMin.validator,
    salaryMax: sharedFields.salaryMax.validator,
    applyUrl: sharedFields.applyUrl.validator,
    applyEmail: sharedFields.applyEmail.validator,
    closingDate: sharedFields.closingDate.validator,
    jobStatus: sharedFields.jobStatus.validator,
  }),
  localizedValidator: v.object({
    title: localizedFields.title.validator,
    summary: localizedFields.summary.validator,
  }),
  routing: { pathPrefix: "jobs" },
  seo: { schemaOrgType: "JobPosting", ogType: "website" },
  capabilities: { sliceBody: true, revisions: true, scheduling: true, presence: true, requiresBodyContent: true },
  referenceCard: (doc, locale) => {
    const content = (doc as {
      content?: Record<string, Record<string, unknown>>
    }).content
    const localized = content?.[locale]
    const titleValue = localized?.["title"]
    const title =
      typeof titleValue === "string" && titleValue.trim().length > 0
        ? titleValue
        : "Untitled job"
    const subtitleValue = (doc as Record<string, unknown>)["department"]
    const subtitle =
      typeof subtitleValue === "string" && subtitleValue.trim().length > 0
        ? subtitleValue
        : undefined
    const slug = (doc as { slug?: string }).slug ?? ""
    const status = (doc as { status?: string }).status
    return {
      id: doc._id,
      type: "job",
      title,
      subtitle,
      href: status === "published" && slug
        ? `/${locale}/jobs/${slug}`
        : undefined,
    }
  },
  aiHint: { purpose: "A single job opening/posting on the site's careers section. Each job has its own public URL and is listed on job-board views (queried as a set, filtered by department/location/employment type/status).", fields: "department, location, remoteType, employmentType, salaryCurrency, salaryMin/salaryMax, applyUrl/applyEmail, closingDate, and jobStatus are shared (locale-agnostic) fields. title and summary are localized. The full description (responsibilities, requirements, benefits) is authored as slice body content." },
}

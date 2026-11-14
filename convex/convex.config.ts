import { defineApp } from "convex/server"
import auth from "@convex-dev/auth/convex.config.js"
import authPassword from "@convex-dev/auth/components/password/convex.config.js"
import authUsername from "@convex-dev/auth/components/username/convex.config.js"
import migrations from "@convex-dev/migrations/convex.config"
import rateLimiter from "@convex-dev/rate-limiter/convex.config"
import actionRetrier from "@convex-dev/action-retrier/convex.config"
import { v } from "convex/values"
import workpool from "@convex-dev/workpool/convex.config"

const app = defineApp({
  env: {
    OPENROUTER_API_KEY: v.optional(v.string()),
    ANTHROPIC_API_KEY: v.optional(v.string()),
    OPENAI_API_KEY: v.optional(v.string()),
    CMS_AI_MODEL: v.optional(v.string()),
    RESEND_API_KEY: v.optional(v.string()),
    CONTACT_IP_PROOF_SECRET: v.optional(v.string()),
    REVALIDATE_SECRET: v.optional(v.string()),
    SITE_URL: v.optional(v.string()),
    FORMULACMS_OWNER_CLAIM: v.optional(v.string()),
    NEXTCMS_OWNER_CLAIM: v.optional(v.string()),
  },
})
app.use(auth)
app.use(authPassword)
app.use(authUsername)
app.use(migrations)
app.use(rateLimiter)
app.use(actionRetrier)
app.use(workpool, { name: "aiPageJobs" })

export default app

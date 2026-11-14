import { httpRouter } from "convex/server"

// Convex Auth 2.0 registers no HTTP routes: the Next.js server proxies the
// sign-in functions (see the allowlist in the Next.js route).
const http = httpRouter()

export default http

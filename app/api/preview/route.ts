import { cookies, draftMode } from "next/headers";
import { redirect } from "next/navigation";
import { api } from "@/convex/_generated/api";
import type { Id } from "@/convex/_generated/dataModel";
import { fetchAuthMutation, safeIsAuthenticated } from "@/lib/auth-server";
import { PREVIEW_SESSION_COOKIE } from "@/lib/preview-session";
import { safeNextPath } from "@/app/(core)/(auth)/sign-in/safe-next-path";

// Enables Next.js Draft Mode so an authenticated editor can view a page that is
// still a draft (the public route hard-404s non-published pages otherwise).
//
// Security: draft mode bypasses the publish gate, so this MUST require auth —
// otherwise /api/preview would expose every unpublished draft to the public.
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const { searchParams } = requestUrl;
  const path = searchParams.get("path") ?? "/";
  const pageId = searchParams.get("pageId");
  const locale = searchParams.get("locale");

  // Only allow internal, relative redirects — never an open redirect.
  const safePath = safeNextPath(path, requestUrl.origin, "/");

  if (!(await safeIsAuthenticated())) {
    // Resume the server-issued session endpoint after sign-in. Sending the
    // editor straight to the public path would lose Draft Mode and the bound
    // session cookie that this handler has not created yet.
    const resumePreview = `${requestUrl.pathname}${requestUrl.search}`;
    redirect(`/sign-in?next=${encodeURIComponent(resumePreview)}`);
  }

  if (!pageId || !locale) {
    return new Response("Preview requires a Page and locale.", { status: 400 });
  }

  const session = await fetchAuthMutation(api.cms.preview.createPreviewSession, {
    pageId: pageId as Id<"pages">,
    locale,
  });

  (await draftMode()).enable();
  (await cookies()).set(PREVIEW_SESSION_COOKIE, session.sessionToken, {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    expires: new Date(session.expiresAt),
  });
  redirect(safePath);
}

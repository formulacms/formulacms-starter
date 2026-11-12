import { cookies, draftMode } from "next/headers";
import { redirect } from "next/navigation";
import { PREVIEW_SESSION_COOKIE } from "@/lib/preview-session";
import { safeNextPath } from "@/app/(core)/(auth)/sign-in/safe-next-path";

// Disables Draft Mode and returns to the given path (or home), so the editor
// stops seeing unpublished drafts on the public site after previewing.
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const { searchParams } = requestUrl;
  const path = searchParams.get("path") ?? "/";
  const safePath = safeNextPath(path, requestUrl.origin, "/");

  (await draftMode()).disable();
  (await cookies()).delete(PREVIEW_SESSION_COOKIE);
  redirect(safePath);
}

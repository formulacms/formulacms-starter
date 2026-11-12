import { Suspense } from "react"
import { AuthenticatedAdminShell } from "@/components/admin/authenticated-admin-shell"
import { Skeleton } from "@/components/ui/skeleton"

export const dynamic = "force-dynamic"

function SidebarSkeleton() {
  return (
    <div className="fixed top-0 left-0 flex h-screen w-60 flex-col gap-3 border-r bg-background p-4">
      <Skeleton className="h-5 w-24" />
      <div className="space-y-1 pt-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-8 w-full rounded-md" />
        ))}
      </div>
    </div>
  )
}

export default function AuthenticatedAdminLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <div className="flex min-h-screen">
      <Suspense fallback={<SidebarSkeleton />}>
        <AuthenticatedAdminShell>{children}</AuthenticatedAdminShell>
      </Suspense>
    </div>
  )
}

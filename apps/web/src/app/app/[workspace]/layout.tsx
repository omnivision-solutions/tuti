import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { portalUrl } from "@/lib/hosts";
import { getMembership } from "@/server/members";

export default async function WorkspaceLayout({ children, params }: LayoutProps<"/app/[workspace]">) {
  const { workspace: slug } = await params;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const { workspace, role } = membership;
  const isAdmin = role === "OWNER" || role === "ADMIN";

  return (
    <>
      <header className="flex items-center gap-4 border-b px-6 py-2">
        <Link href="/app" className="font-semibold">
          Tuti
        </Link>
        <span className="text-sm text-muted-foreground">{workspace.name}</span>
        <nav className="ml-auto flex gap-1">
          <Link href={`/app/${slug}`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Feedback
          </Link>
          {isAdmin && (
            <Link href={`/app/${slug}/settings`} className={buttonVariants({ variant: "ghost", size: "sm" })}>
              Settings
            </Link>
          )}
          <a href={portalUrl(slug)} target="_blank" rel="noreferrer" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            View portal
          </a>
        </nav>
      </header>
      <main className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 p-6">{children}</main>
    </>
  );
}

import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { BoardTabs } from "@/components/board-tabs";
import { TutiMark } from "@/components/tuti-logo";
import { buttonVariants } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";
import { appUrl } from "@/lib/hosts";
import { getSession } from "@/server/session";

/**
 * A project's public portal (served on <project>.tuti.so via proxy.ts).
 * Links here are host-relative: "/b/ideas", not "/portal/<project>/b/ideas".
 */
export default async function PortalLayout({ children, params }: LayoutProps<"/portal/[project]">) {
  const { project: slug } = await params;
  const project = await prisma.project.findUnique({
    where: { slug },
    select: { name: true, boards: { orderBy: { createdAt: "asc" }, select: { slug: true, name: true } } },
  });
  if (!project) {
    notFound();
  }
  // Portal sessions are per host: this is the user signed in on this portal.
  const session = await getSession();

  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-2">
        <Link href="/" className="font-heading text-lg font-bold tracking-tight">
          {project.name}
        </Link>
        {session ? (
          <UserMenu name={session.user.name} image={session.user.image ?? null} />
        ) : (
          <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Sign in
          </Link>
        )}
      </header>
      <BoardTabs boards={project.boards} />
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col gap-6 px-6 py-10">{children}</main>
      <footer className="flex justify-center pb-6">
        <a
          href={appUrl().origin}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground"
        >
          Powered by
          <TutiMark className="size-4" />
          <span className="font-heading font-bold text-foreground">tuti</span>
        </a>
      </footer>
    </>
  );
}

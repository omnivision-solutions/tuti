import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { buttonVariants } from "@/components/ui/button";
import { UserMenu } from "@/components/user-menu";
import { getSession } from "@/server/session";

/**
 * A workspace's public portal (served on <workspace>.tuti.so via proxy.ts).
 * Links here are host-relative: "/b/ideas", not "/portal/<workspace>/b/ideas".
 */
export default async function PortalLayout({ children, params }: LayoutProps<"/portal/[workspace]">) {
  const { workspace: slug } = await params;
  const workspace = await prisma.workspace.findUnique({ where: { slug }, select: { name: true } });
  if (!workspace) {
    notFound();
  }
  // Portal sessions are per host: this is the user signed in on this portal.
  const session = await getSession();

  return (
    <>
      <header className="flex items-center justify-between border-b px-6 py-2">
        <Link href="/" className="font-semibold">
          {workspace.name}
        </Link>
        {session ? (
          <UserMenu name={session.user.name} image={session.user.image ?? null} />
        ) : (
          <Link href="/sign-in" className={buttonVariants({ variant: "ghost", size: "sm" })}>
            Sign in
          </Link>
        )}
      </header>
      <main className="mx-auto flex w-full max-w-3xl flex-1 flex-col px-6 py-10">{children}</main>
    </>
  );
}

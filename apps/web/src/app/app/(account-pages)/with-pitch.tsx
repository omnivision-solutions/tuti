import { prisma } from "@tuti/db";
import type { ReactNode } from "react";

/**
 * The team's sign-in and sign-up forms, with what Tuti does beside them (above them on phones), level with the
 * form's middle. On the way back to a portal (`continuingTo`),
 * whose readers came for that portal, not for Tuti, the forms alone.
 */
export function WithPitch({ children, continuingTo }: { children: ReactNode; continuingTo?: object | null }) {
  if (continuingTo) {
    return <div className="mx-auto w-full max-w-sm">{children}</div>;
  }
  return (
    <div data-wide className="grid items-start gap-8 md:grid-cols-2 md:items-center md:gap-12">
      <div className="flex flex-col gap-3 max-md:items-center max-md:text-center">
        <p className="font-heading text-3xl font-bold text-balance">
          Feedback, roadmap, changelog and docs, kept up to date as you ship.
        </p>
      </div>
      {children}
    </div>
  );
}

/**
 * The project whose portal a sign-in or sign-up is on the way back to (`next` is the app's /continue for it), or null:
 * its name, and "Forgot your password?" for it, on the app (anyone can make such a `next`: nothing here leaves the app's
 * host), whose reset is asked for that portal and comes back to its card (server/password-reset.ts).
 */
export async function continuingTo(next: string): Promise<{ name: string; forgotPassword: string } | null> {
  const url = new URL(next || "/", "http://localhost");
  const slug = url.pathname === "/app/auth/continue" ? url.searchParams.get("portal") : null;
  const project = slug ? await prisma.project.findUnique({ where: { slug }, select: { slug: true, name: true } }) : null;
  // Keeping the way back (`next`), for "Back to sign in" there.
  return project && { name: project.name, forgotPassword: `/app/auth/forgot-password?${new URLSearchParams({ portal: project.slug, next })}` };
}

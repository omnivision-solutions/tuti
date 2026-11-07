import { prisma } from "@tuti/db";
import type { ReactNode } from "react";

import { TutiMark } from "@/components/tuti-logo";

/**
 * The team's sign-in and sign-up forms, with what Tuti does beside them (above them on phones), level
 * with the form's top so it stays put between the two pages. On the way back to a portal (`continuingTo`),
 * whose readers came for that portal, not for Tuti, the forms alone.
 */
export function WithPitch({ children, continuingTo }: { children: ReactNode; continuingTo?: string | null }) {
  if (continuingTo) {
    return <div className="mx-auto w-full max-w-sm">{children}</div>;
  }
  return (
    <div data-wide className="grid items-start gap-8 md:grid-cols-2 md:gap-12">
      <div className="flex flex-col gap-3 max-md:items-center max-md:text-center">
        <TutiMark className="size-10" />
        <p className="font-heading text-2xl font-bold tracking-tight text-balance">
          Feedback, roadmap, changelog and docs, kept up to date as you ship.
        </p>
      </div>
      {children}
    </div>
  );
}

/** The project whose portal a sign-in or sign-up is on the way back to (`next` is the app's /continue for it), or null. */
export async function continuingTo(next: string): Promise<string | null> {
  const url = new URL(next || "/", "http://localhost");
  const slug = url.pathname === "/continue" ? url.searchParams.get("portal") : null;
  return slug ? ((await prisma.project.findUnique({ where: { slug }, select: { name: true } }))?.name ?? null) : null;
}

import { prisma } from "@tuti/db";
import { CheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { Badge } from "@/components/ui/badge";

/**
 * The team's sign-in and sign-up forms, with what Tuti does beside them (above them on phones), level with the
 * form's middle. On the way back to a portal (`continuingTo`),
 * whose readers came for that portal, not for Tuti, the forms alone. `pitch` replaces sign-in's line (sign-up's SignUpPitch).
 */
export function WithPitch({ children, continuingTo, pitch }: { children: ReactNode; continuingTo?: object | null; pitch?: ReactNode }) {
  if (continuingTo) {
    return <div className="mx-auto w-full max-w-sm">{children}</div>;
  }
  return (
    <div data-wide className="grid items-start gap-8 md:grid-cols-2 md:items-center md:gap-12">
      <div className="flex flex-col gap-3 max-md:items-center max-md:text-center">
        {pitch ?? (
          <p className="font-heading text-3xl font-bold text-balance">
            Feedback, roadmap, changelog and docs, kept up to date as you ship.
          </p>
        )}
      </div>
      {children}
    </div>
  );
}

/**
 * Sign-up's pitch: the free trial (`trialDays`, the billing file's; none on a self-hosted server or a cloud without trials),
 * then what Tuti does. On phones the list is left out, so the form stays near the top.
 */
export function SignUpPitch({ trialDays }: { trialDays?: number }) {
  return (
    <>
      {trialDays ? (
        <Badge variant="soft" className="h-auto px-3 py-1 text-xs font-semibold">
          {trialDays}-day free trial · No card needed
        </Badge>
      ) : null}
      <h1 className="font-heading text-3xl font-bold text-balance">
        Ship code. <span className="text-primary">Your help center keeps up.</span>
      </h1>
      <ul className="mt-2 flex flex-col gap-2.5 max-md:hidden">
        {[
          "Help center and AI answers from your docs",
          "Autopilot keeps them current from your pull requests",
          "One inbox for chat and email",
          "Feedback board, roadmap and changelog",
        ].map((item) => (
          <li key={item} className="flex items-center gap-3">
            <CheckIcon aria-hidden className="size-4 shrink-0 text-primary" />
            {item}
          </li>
        ))}
      </ul>
    </>
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

import type { ReactNode } from "react";

import { TutiMark } from "@/components/tuti-logo";

/**
 * The team's sign-in and sign-up forms, with what Tuti does beside them (above them on phones), level
 * with the form's top so it stays put between the two pages.
 */
export function WithPitch({ children }: { children: ReactNode }) {
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

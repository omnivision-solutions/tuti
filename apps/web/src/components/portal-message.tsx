import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/** A page of the portal that only says one thing (an email link's page, unsubscribing, a failed sign-on): a card as the sign-in page's. */
export function PortalMessage({ children, className, icon: Icon, ...props }: React.ComponentProps<"div"> & { icon?: LucideIcon }) {
  return (
    <div
      {...props}
      className={cn("mx-auto flex w-full max-w-sm flex-col items-start gap-4 rounded-xl bg-card p-5 shadow-sm ring-1 ring-border my-auto sm:p-6 [&_form]:w-full [&_form>button]:w-full", className)}
    >
      {Icon && (
        <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-primary/10 text-primary">
          <Icon className="size-5" />
        </span>
      )}
      {children}
    </div>
  );
}

/** Its title and its text. */
export const MESSAGE_TITLE = "font-heading text-xl font-semibold tracking-tight text-balance break-words";
export const MESSAGE_TEXT = "text-[0.9375rem] leading-relaxed break-words text-muted-foreground";

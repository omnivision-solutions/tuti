import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card } from "@/components/ui/card";

/** A page of the portal that only says one thing (an email link's page, unsubscribing, a failed sign-on): a card as the sign-in page's. */
export function PortalMessage({ children, className, icon: Icon, ...props }: React.ComponentProps<"div"> & { icon?: LucideIcon }) {
  return (
    <Card {...props} className={cn("mx-auto my-auto w-full max-w-sm items-start gap-4 px-5 [&_form]:w-full [&_form>button]:w-full", className)}>
      {Icon && (
        <span aria-hidden className="flex size-10 items-center justify-center rounded-full bg-soft text-soft-foreground">
          <Icon className="size-5" />
        </span>
      )}
      {children}
    </Card>
  );
}

/** Its title and its text. */
export const MESSAGE_TITLE = "font-heading text-xl font-semibold tracking-tight text-balance break-words";
export const MESSAGE_TEXT = "text-[0.9375rem] leading-relaxed break-words text-muted-foreground";

"use client";

import { useOptimistic, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { reactToChangelogEntry } from "@/server/changelog";
import { REACTION_EMOJI, REACTIONS, type Reaction, type ReactionCounts } from "@/lib/reactions";

/**
 * A published entry's reactions on the portal: one of each per reader, toggled; signed out, just the counts.
 * A count shows once it's above zero, so entries nobody reacted to don't carry a row of zeros.
 */
export function ChangelogReactions({
  projectSlug,
  number,
  counts,
  reacted,
  signedIn,
  quiet = false,
  onReact = (reaction, reacted) => reactToChangelogEntry(projectSlug, number, reaction, reacted),
}: {
  projectSlug: string;
  number: number;
  counts: ReactionCounts;
  reacted: Reaction[];
  signedIn: boolean;
  /** Small (a list's entries, under each one). */
  quiet?: boolean;
  /** Saves one (the widget's acts for whoever the customer's page signed in); the portal's server action by default. */
  onReact?: (reaction: Reaction, reacted: boolean) => Promise<{ error?: string }>;
}) {
  const [pending, startTransition] = useTransition();
  const t = useTranslations("changelog");
  const locale = useLocale();
  const [optimistic, setOptimistic] = useOptimistic({ counts, reacted });

  return (
    <div className={cn("flex flex-wrap", quiet ? "gap-1.5" : "gap-2")}>
      {REACTIONS.map((reaction) => {
        const on = optimistic.reacted.includes(reaction);
        const count = optimistic.counts[reaction];
        return (
          <Button
            key={reaction}
            size="sm"
            variant="outline"
            // Grey fills (the portal's outline), the emoji in grey until picked. Signed out the counts still read at full
            // strength: a disabled button's fade made them look broken.
            className={cn(
              "rounded-full px-3 disabled:opacity-100",
              quiet && "h-7 gap-1.5 px-2.5 text-[0.8125rem]",
              !on && "text-muted-foreground [&>span:first-child]:opacity-70 [&>span:first-child]:grayscale",
              // On the portal a reaction of yours is like a vote cast: the accent's tint and a thin inset ring in it (not a fill alone).
              on &&
                "border-primary bg-soft hover:bg-soft/80 portal:border-transparent portal:bg-soft portal:text-soft-foreground portal:ring-1 portal:ring-primary/45 portal:ring-inset portal:hover:bg-soft/80 portal:focus-visible:ring-3 portal:focus-visible:ring-ring/50",
            )}
            disabled={!signedIn || pending}
            title={signedIn ? undefined : t("signInToReact")}
            aria-pressed={on}
            aria-label={count > 0 ? t("reactWithCount", { emoji: REACTION_EMOJI[reaction], count }) : t("reactWith", { emoji: REACTION_EMOJI[reaction] })}
            onClick={() =>
              startTransition(async () => {
                setOptimistic((s) => ({
                  counts: { ...s.counts, [reaction]: s.counts[reaction] + (on ? -1 : 1) },
                  reacted: on ? s.reacted.filter((r) => r !== reaction) : [...s.reacted, reaction],
                }));
                // The state wanted, not a toggle: a repeated request can't undo it.
                const result = await onReact(reaction, !on);
                // Refused, the page isn't refreshed, so the optimistic state falls back to what it was.
                if (result.error) {
                  toast.error(result.error);
                }
              })
            }
          >
            <span aria-hidden className={quiet ? "text-sm" : "text-base"}>{REACTION_EMOJI[reaction]}</span>
            {count > 0 && <span className="tabular-nums">{count.toLocaleString(locale)}</span>}
          </Button>
        );
      })}
    </div>
  );
}

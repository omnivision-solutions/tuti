"use client";

import { useEffect, useState } from "react";

import { ChangelogReactions } from "@/components/changelog-reactions";
import { useWidgetSignIn } from "@/components/widget-feedback";
import type { Reaction, ReactionCounts } from "@/lib/reactions";
import { widgetReact, widgetReacted } from "@/server/widget";

/**
 * An entry's reactions in the widget's panel: for the portal's signed-in reader on its own site (whose
 * reactions the page rendered), else for whoever the customer's page signs in (Tuti.identify), whose are
 * asked for once their token is in; signed out, just the counts.
 */
export function WidgetReactions({
  projectSlug,
  number,
  counts,
  reacted,
  portalSignedIn,
}: {
  projectSlug: string;
  number: number;
  counts: ReactionCounts;
  reacted: Reaction[];
  portalSignedIn: boolean;
}) {
  const { signedIn } = useWidgetSignIn(projectSlug, !portalSignedIn);
  const token = signedIn?.token ?? null;
  const [total, setTotal] = useState(counts);
  // Whose reactions these are: anyone else's (signed out, or the page switched people) are the ones the page
  // rendered (none on a customer's site) until theirs are read, never the last person's.
  const [mine, setMine] = useState<{ for: string | null; reacted: Reaction[] }>({ for: null, reacted });
  const shown = mine.for === token ? mine.reacted : token ? [] : reacted;

  useEffect(() => {
    if (!token) {
      return;
    }
    let current = true;
    widgetReacted(projectSlug, token, number).then(
      (theirs) => current && setMine({ for: token, reacted: theirs }),
      // Unread, they show none: reacting again saves the state wanted, so nothing's undone by mistake.
      () => current && setMine({ for: token, reacted: [] }),
    );
    return () => {
      current = false;
    };
  }, [projectSlug, token, number]);

  return (
    <ChangelogReactions
      // Remounted per person, so one's optimistic state never shows as another's.
      key={token ?? "portal"}
      projectSlug={projectSlug}
      number={number}
      counts={total}
      reacted={shown}
      signedIn={portalSignedIn || !!token}
      onReact={async (reaction, on) => {
        const result = await widgetReact(projectSlug, token, number, reaction, on);
        if (result.reactions) {
          setTotal(result.reactions);
          const now = on ? [...shown.filter((r) => r !== reaction), reaction] : shown.filter((r) => r !== reaction);
          setMine({ for: token, reacted: now });
        }
        return result;
      }}
    />
  );
}

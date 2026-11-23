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
  const [state, setState] = useState({ counts, reacted });

  useEffect(() => {
    if (!token) {
      return;
    }
    let current = true;
    widgetReacted(projectSlug, token, number).then((mine) => current && setState((s) => ({ ...s, reacted: mine })));
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
      counts={state.counts}
      reacted={state.reacted}
      signedIn={portalSignedIn || !!token}
      onReact={async (reaction, on) => {
        const result = await widgetReact(projectSlug, token, number, reaction, on);
        if (result.reactions) {
          setState((s) => ({ counts: result.reactions, reacted: on ? [...s.reacted, reaction] : s.reacted.filter((r) => r !== reaction) }));
        }
        return result;
      }}
    />
  );
}

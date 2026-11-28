"use client";

import { useEffect } from "react";

import { markChangelogSeen } from "@/server/changelog-seen";

/** Sent on the window once the visit is recorded: the header's "New" goes (useNewChangelog). */
export const CHANGELOG_SEEN = "tuti:changelog-seen";

/**
 * Where announcements are shown to someone signed in on the portal (its /changelog, the
 * widget's What's new on the portal's own site): they've seen them up to `at`, on every
 * device. The widget's script is told by WidgetUnread. From the page's script, so
 * prefetches and crawlers don't count.
 */
export function ChangelogSeen({ projectSlug, at, signedIn }: { projectSlug: string; at: string | null; signedIn: boolean }) {
  useEffect(() => {
    if (at && signedIn) {
      void markChangelogSeen(projectSlug, at).then((result) => {
        if (!result.error) {
          window.dispatchEvent(new Event(CHANGELOG_SEEN));
        }
      });
    }
  }, [projectSlug, at, signedIn]);
  return null;
}

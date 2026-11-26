"use client";

import { cn } from "cn";
import { HistoryIcon } from "lucide-react";
import { useEffect, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { pillClass } from "@/components/filter-pills";
import { Button } from "@/components/ui/button";
import type { Activity, ActivityFilter } from "@/server/operations/conversation-activity";
import { loadConversationActivity } from "@/server/inbox";

import { DetailSection } from "./detail-section";

type Event = Activity["events"][number];

/** Each row's dot by who did it: workflows and built-in steps, the spam filter, the AI, a teammate (or their API key). */
const DOTS: Record<Event["actor"], string> = {
  workflow: "bg-status-in-progress",
  spam_filter: "bg-status-completed",
  ai: "bg-status-planned",
  teammate: "bg-highlight-foreground",
  api_key: "bg-highlight-foreground",
  tuti: "bg-status-closed",
};

const FILTERS: { key: ActivityFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "workflows", label: "Workflows" },
  { key: "people", label: "People" },
];

const subscribe = () => () => {};

/** When, in the viewer's time zone (known only once hydrated): the time today, else the day and the time. */
function When({ at }: { at: string }) {
  const label = useSyncExternalStore(
    subscribe,
    () => {
      const date = new Date(at);
      const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
      return date.toDateString() === new Date().toDateString() ? time : `${date.toLocaleDateString("en-GB", { day: "numeric", month: "short" })}, ${time}`;
    },
    () => null,
  );
  return <time dateTime={at}>{label}</time>;
}

/**
 * The conversation's Activity (docs/plan.md, Inbox automation, W16), under the person in its details: newest first, All,
 * Workflows and People, and "Show earlier". `first`: the newest page of all of it, as the page rendered it (a live refresh
 * brings it anew). ponytail: earlier pages loaded by hand stay as loaded; more than a page of new events at once while
 * they're shown leaves a gap till the page is opened again.
 */
export function ConversationActivity({ projectSlug, number, count, first }: { projectSlug: string; number: number; count: number; first: Activity }) {
  const [filter, setFilter] = useState<ActivityFilter>("all");
  // For All: the pages after `first`. For a filter: all its pages.
  const [pages, setPages] = useState<Activity[]>([]);
  const [pending, startTransition] = useTransition();

  const load = (to: ActivityFilter, before?: string) =>
    startTransition(async () => {
      const result = await loadConversationActivity(projectSlug, number, to, before);
      if (!result.activity) {
        toast.error(result.error ?? "Couldn't load the activity");
        return;
      }
      const page = result.activity;
      setFilter(to);
      setPages((loaded) => (before ? [...loaded, page] : [page]));
    });

  // A filter's list follows what's new too (the newest event changed: a refresh).
  const newest = first.events[0]?.id;
  useEffect(() => {
    if (filter !== "all") {
      load(filter);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when something new happened
  }, [newest]);

  const all = filter === "all" ? [first, ...pages] : pages;
  const seen = new Set<string>();
  const events = all.flatMap((page) => page.events).filter((event) => !seen.has(event.id) && !!seen.add(event.id));
  const next = all.at(-1)?.next ?? null;

  return (
    <DetailSection title="Activity" count={count} icon={HistoryIcon} open>
      <section aria-label="Activity" className="inbox-activity flex min-w-0 flex-col gap-2.5">
        <div role="group" aria-label="Show" className="flex flex-wrap gap-1">
          {FILTERS.map((option) => (
            <button
              key={option.key}
              type="button"
              aria-pressed={filter === option.key}
              disabled={pending}
              onClick={() => {
                if (option.key === "all") {
                  setFilter("all");
                  setPages([]);
                } else if (option.key !== filter) {
                  load(option.key);
                }
              }}
              className={pillClass(filter === option.key, "h-7 px-2.5 text-xs")}
            >
              {option.label}
            </button>
          ))}
        </div>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">{filter === "people" ? "Nobody on the team has changed anything yet." : filter === "workflows" ? "No workflow has run yet." : "Nothing yet."}</p>
        ) : (
          <ol className="flex min-w-0 flex-col">
            {events.map((event) => (
              <li
                key={event.id}
                className="relative flex min-w-0 flex-col items-start gap-0.5 pb-3 pl-5 text-xs after:absolute after:top-4.5 after:bottom-0 after:left-[0.3125rem] after:w-px after:bg-border last:after:hidden group-[.inbox-details-sheet]/details:text-[0.8125rem]"
              >
                <span aria-hidden className={cn("absolute top-1 left-0 size-2.75 rounded-full ring-2 ring-card", DOTS[event.actor])} />
                <p className="max-w-full leading-snug wrap-anywhere">
                  {event.who && <span className="font-[550]">{event.who}</span>} {event.text}
                </p>
                <p className="max-w-full text-muted-foreground wrap-anywhere">
                  <When at={event.createdAt} />
                  {event.detail && ` · ${event.detail}`}
                </p>
                {event.workflows.length > 0 && (
                  <ul className="mt-1 flex w-full flex-col gap-0.5 rounded-md bg-muted px-2 py-1.5 text-muted-foreground">
                    {event.workflows.map((workflow, i) => (
                      <li key={i} className="wrap-anywhere">
                        <span className="text-foreground">{workflow.name}</span> · {workflow.what}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            ))}
          </ol>
        )}
        {next && (
          <Button variant="outline" size="sm" className="self-start" disabled={pending} onClick={() => load(filter, next)}>
            Show earlier
          </Button>
        )}
      </section>
    </DetailSection>
  );
}

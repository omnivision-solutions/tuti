"use client";

import { ExternalLinkIcon } from "lucide-react";
import { createContext, type ReactNode, use, useEffect, useMemo, useState } from "react";

import { STATUS_LABELS, StatusDot } from "@/components/post-status-badge";
import { useWidgetSignIn } from "@/components/widget-feedback";
import { timeAgo } from "@/lib/format";
import { widgetIdeaNews } from "@/server/widget";
import type { IdeaNews } from "@/server/widget-home";

const Visitor = createContext<{ name: string | null; news: IdeaNews[] }>({ name: null, news: [] });

/**
 * Who the customer's page signs in on the widget's Home (Tuti.identify, asked once for the greeting
 * and the news together), and the news of their ideas. Nobody, until the page says who.
 */
export function WidgetHomeVisitor({ projectSlug, enabled, children }: { projectSlug: string; enabled: boolean; children: ReactNode }) {
  const { signedIn, pending } = useWidgetSignIn(projectSlug, enabled);
  // Who was signed in as Home was left: the page may have signed them out, or someone else in, since
  // (another tab heard it), so they're nobody here until the page says who again.
  const [stale, setStale] = useState<typeof signedIn>(null);
  if (!enabled && signedIn && stale !== signedIn) {
    setStale(signedIn);
  }
  // Nobody while the page's next answer is on its way: never the person before.
  const current = enabled && !pending && signedIn !== stale ? signedIn : null;
  const token = current?.token ?? null;
  // Whose news it is: someone signed in since sees none of theirs.
  const [news, setNews] = useState<{ token: string; news: IdeaNews[] } | null>(null);
  useEffect(() => {
    if (!token) {
      return;
    }
    let current = true;
    widgetIdeaNews(projectSlug, token).then(
      (result) => current && setNews({ token, news: result }),
      // No news is fine: Home stays as it is.
      () => {},
    );
    return () => {
      current = false;
    };
  }, [projectSlug, token]);
  const value = useMemo(
    // Only a name their app gave: one made up from their email, or "Anonymous", isn't a greeting.
    () => ({ name: current?.named ? current.name.trim() || null : null, news: token && news?.token === token ? news.news : [] }),
    [current, token, news],
  );
  return <Visitor value={value}>{children}</Visitor>;
}

/** Home's greeting: "Hi Sam 👋" once the page says who's here, else "Hi there 👋". */
export function WidgetGreeting() {
  const { name } = use(Visitor);
  return <p className="text-lg opacity-90">Hi {name ? name.split(/\s+/)[0] : "there"} 👋</p>;
}

/** The news of their ideas ("Dark mode is now Planned"), each opening its post on the portal in a new tab. */
export function WidgetIdeaNews() {
  const { news } = use(Visitor);
  if (news.length === 0) {
    return null;
  }
  return (
    <section aria-labelledby="idea-news" className="flex flex-col gap-2">
      <h2 id="idea-news" className="px-1 text-sm font-medium text-muted-foreground">
        Your ideas
      </h2>
      <ul className="flex flex-col divide-y rounded-xl border bg-card">
        {news.map((item) => (
          <li key={item.href}>
            <a
              href={item.href}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 px-4 py-3 hover:bg-accent first:rounded-t-xl last:rounded-b-xl"
            >
              <StatusDot status={item.status} />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="font-medium break-words">
                  {item.title} is now {STATUS_LABELS[item.status]}
                </span>
                <span className="text-sm text-muted-foreground">{timeAgo(new Date(item.at))}</span>
              </span>
              <ExternalLinkIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}

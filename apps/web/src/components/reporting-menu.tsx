"use client";

import { BookOpenIcon, ChartLineIcon, CircleHelpIcon, InboxIcon, SearchIcon, SparklesIcon, ThumbsUpIcon } from "lucide-react";
import { useSearchParams } from "next/navigation";

import { SectionGroup, SectionLink, SectionPane } from "@/components/pane";

/** Reporting's section pane: its pages in groups, each link keeping the page's range (`?range=`). */
export function ReportingMenu({ slug }: { slug: string }) {
  const range = useSearchParams().get("range");
  const at = (path: string) => `/app/${slug}/reporting${path}${range ? `?${new URLSearchParams({ range })}` : ""}`;
  return (
    <SectionPane title="Reporting">
      <SectionGroup label="Help center">
        <SectionLink href={at("")} icon={<ChartLineIcon aria-hidden />}>
          Overview
        </SectionLink>
        <SectionLink href={at("/articles")} icon={<BookOpenIcon aria-hidden />}>
          Articles
        </SectionLink>
        <SectionLink href={at("/searches")} icon={<SearchIcon aria-hidden />}>
          Searches
        </SectionLink>
        <SectionLink href={at("/feedback")} icon={<ThumbsUpIcon aria-hidden />}>
          Feedback
        </SectionLink>
      </SectionGroup>
      <SectionGroup label="AI support">
        <SectionLink href={at("/ai-conversations")} icon={<SparklesIcon aria-hidden />}>
          AI conversations
        </SectionLink>
        <SectionLink href={at("/unanswered")} icon={<CircleHelpIcon aria-hidden />}>
          Unanswered questions
        </SectionLink>
      </SectionGroup>
      <SectionGroup label="Inbox">
        <SectionLink href={at("/inbox")} icon={<InboxIcon aria-hidden />}>
          Conversations
        </SectionLink>
      </SectionGroup>
    </SectionPane>
  );
}

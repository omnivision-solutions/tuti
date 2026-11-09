import { BookOpenIcon, ChartLineIcon, CircleHelpIcon, MessagesSquareIcon, SearchIcon, SparklesIcon, ThumbsUpIcon } from "lucide-react";
import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { SettingsMenu } from "@/components/settings-menu";
import { getMembership } from "@/server/membership";

/** Reporting: how the help center, the AI answering from it and the inbox did, a page each, in a menu on the left as Settings has. */
export default async function ReportingLayout({ children, params }: LayoutProps<"/app/[project]/reporting">) {
  const { project: slug } = await params;
  if (!(await getMembership(slug))) {
    notFound();
  }
  const at = (path: string) => `/app/${slug}/reporting${path}`;
  const groups = [
    {
      title: "Help center",
      pages: [
        { title: "Overview", href: at(""), icon: <ChartLineIcon aria-hidden /> },
        { title: "Articles", href: at("/articles"), icon: <BookOpenIcon aria-hidden /> },
        { title: "Searches", href: at("/searches"), icon: <SearchIcon aria-hidden /> },
        { title: "Feedback", href: at("/feedback"), icon: <ThumbsUpIcon aria-hidden /> },
      ],
    },
    {
      title: "AI support",
      pages: [
        { title: "AI conversations", href: at("/ai-conversations"), icon: <SparklesIcon aria-hidden /> },
        { title: "Unanswered questions", href: at("/unanswered"), icon: <CircleHelpIcon aria-hidden /> },
      ],
    },
    { title: "Inbox", pages: [{ title: "Conversations", href: at("/inbox"), icon: <MessagesSquareIcon aria-hidden /> }] },
  ];
  // As Settings' layout: the menu a column of its own the page's height, the page beside it.
  return (
    <div data-slot="pane-layout" className="-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t md:flex-row">
      <div className="px-6 pt-6 md:hidden">
        <PageHeader title="Reporting" />
      </div>
      <aside className="px-6 pt-6 md:w-60 md:shrink-0 md:border-r md:p-0">
        <SettingsMenu label="Reporting" groups={groups} carry="range" />
      </aside>
      <div className="flex w-full max-w-5xl min-w-0 flex-1 flex-col gap-6 p-6 md:px-8">
        {/* Beside the menu, the report's own heading (ReportHeading) is the page's title: this one for screen readers. */}
        <div className="max-md:hidden md:sr-only">
          <PageHeader title="Reporting" />
        </div>
        {children}
      </div>
    </div>
  );
}

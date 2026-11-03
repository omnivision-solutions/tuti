import { notFound } from "next/navigation";

import { PageHeader } from "@/components/page-header";
import { SettingsMenu } from "@/components/settings-menu";
import { getMembership } from "@/server/membership";

/** Reporting: how the docs, the AI answering from them and the inbox did, a page each, in a menu on the left as Settings has. */
export default async function ReportingLayout({ children, params }: LayoutProps<"/app/[project]/reporting">) {
  const { project: slug } = await params;
  if (!(await getMembership(slug))) {
    notFound();
  }
  const at = (path: string) => `/app/${slug}/reporting${path}`;
  const groups = [
    {
      title: "Docs",
      pages: [
        { title: "Overview", href: at("") },
        { title: "Articles", href: at("/articles") },
        { title: "Searches", href: at("/searches") },
        { title: "Feedback", href: at("/feedback") },
      ],
    },
    {
      title: "AI support",
      pages: [
        { title: "AI conversations", href: at("/ai-conversations") },
        { title: "Unanswered questions", href: at("/unanswered") },
      ],
    },
    { title: "Inbox", pages: [{ title: "Conversations", href: at("/inbox") }] },
  ];
  // As Settings' layout: the menu a column of its own the page's height, the page beside it.
  return (
    <div data-slot="pane-layout" className="-mx-6 -mb-6 flex flex-1 flex-col first:-mt-6 not-first:border-t md:flex-row">
      <div className="px-6 pt-6 md:hidden">
        <PageHeader title="Reporting" />
      </div>
      <aside className="px-6 pt-6 md:w-60 md:shrink-0 md:border-r md:p-0">
        <SettingsMenu label="Reporting" groups={groups} />
      </aside>
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-1 flex-col gap-6 p-6">
        <div className="max-md:hidden md:contents">
          <PageHeader title="Reporting" />
        </div>
        {children}
      </div>
    </div>
  );
}

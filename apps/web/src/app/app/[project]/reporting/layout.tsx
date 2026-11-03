import { planIncludes, planNeeded } from "@tuti/shared";
import { BookOpenIcon, ChartLineIcon, CircleHelpIcon, LockIcon, MessagesSquareIcon, SearchIcon, SparklesIcon, ThumbsUpIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";

import { PageHeader } from "@/components/page-header";
import { SettingsMenu } from "@/components/settings-menu";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { getMembership, isAdminRole } from "@/server/membership";

/** Reporting: how the help center, the AI answering from it and the inbox did, a page each, in a menu on the left as Settings has. */
export default async function ReportingLayout({ children, params }: LayoutProps<"/app/[project]/reporting">) {
  const { project: slug } = await params;
  const membership = await getMembership(slug);
  if (!membership) {
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
      <div className="mx-auto flex w-full max-w-5xl min-w-0 flex-1 flex-col gap-6 p-6">
        <div className="max-md:hidden md:contents">
          <PageHeader title="Reporting" />
        </div>
        {planIncludes(membership.project.plan, "reporting") ? children : (
          <Locked slug={slug} admin={isAdminRole(membership.role)}>
            {children}
          </Locked>
        )}
      </div>
    </div>
  );
}

/**
 * A plan without Reporting: the page (made-up numbers, see reportingPage) blurred and out of reach, under a card saying which plan has it,
 * with the way to Billing for owners and admins.
 */
function Locked({ slug, admin, children }: { slug: string; admin: boolean; children: ReactNode }) {
  return (
    <div className="relative flex flex-col gap-6">
      <div aria-hidden inert className="flex flex-col gap-6 blur-sm select-none">
        {children}
      </div>
      <div className="absolute inset-0 flex justify-center px-4 pt-16">
        <Card className="sticky top-1/3 h-fit w-full max-w-sm text-center shadow-lg">
          <CardHeader>
            <LockIcon aria-hidden className="mx-auto size-5 text-muted-foreground" />
            <CardTitle>
              <h3>See how your help center, AI and inbox are doing</h3>
            </CardTitle>
            <CardDescription>{planNeeded("reporting")}</CardDescription>
          </CardHeader>
          <CardContent>
            {admin ? (
              <Link href={`/app/${slug}/settings/billing`} className={buttonVariants()}>
                See plans
              </Link>
            ) : (
              <p className="text-sm text-muted-foreground">An owner or admin can upgrade.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

import { notFound } from "next/navigation";

import { PaneLayout } from "@/components/pane";
import { ReportingMenu } from "@/components/reporting-menu";
import { getMembership } from "@/server/membership";

/** Reporting: how the help center, the AI answering from it and the inbox did, a page each (`ReportPane`), beside its section pane. */
export default async function ReportingLayout({ children, params }: LayoutProps<"/app/[project]/reporting">) {
  const { project: slug } = await params;
  if (!(await getMembership(slug))) {
    notFound();
  }
  return (
    <PaneLayout>
      <ReportingMenu slug={slug} />
      {children}
    </PaneLayout>
  );
}

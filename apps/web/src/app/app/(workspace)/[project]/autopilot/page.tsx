import { prisma } from "@tuti/db";
import { aiProvider, codeChangesEnabled, codeChangesFix, decisionsMissing, planIncludes } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { SentHereNotice } from "@/components/autopilot-list";
import { EmptyState } from "@/components/empty-state";
import { PlanNotice } from "@/components/plan-notice";
import { buttonVariants } from "@/components/ui/button";
import { getMembership } from "@/server/membership";

/**
 * Autopilot's page with nothing open (and Activity's): its notices and why there's nothing yet, beside the list (whose
 * header is the page's heading), above it on phones and tablets; with none, the list's hint (AutopilotPanes).
 */
export default async function CodeChangesPage(props: PageProps<"/app/[project]/autopilot">) {
  const [{ project: slug }, searchParams] = await Promise.all([props.params, props.searchParams]);
  // Sent here from a post's or article's review with nothing from Autopilot left on it.
  const gone = searchParams.gone === "post" || searchParams.gone === "article" ? searchParams.gone : null;
  const membership = await getMembership(slug);
  if (!membership) {
    notFound();
  }
  const projectId = membership.project.id;
  const [first, connection] = await Promise.all([
    prisma.codeChange.findFirst({ where: { projectId }, select: { id: true } }),
    prisma.githubInstallation.findUnique({ where: { projectId }, select: { project: { select: { analyseCodeChanges: true } } } }),
  ]);
  const { plan } = await prisma.project.findUniqueOrThrow({ where: { id: projectId }, select: { plan: true } });
  // On a plan without Autopilot, those here are kept but can't be analysed (codeChanges.analyse refuses).
  const included = planIncludes(plan, "codeChanges");

  if (!gone && included && first) {
    return null;
  }
  return (
    <div data-autopilot-notices className="flex flex-col gap-4 overflow-y-auto p-4 @min-[48rem]/app:p-6">
      {gone && <SentHereNotice>Nothing from Autopilot is on that {gone} any more.</SentHereNotice>}
      {!included && (
        <PlanNotice feature="codeChanges" projectSlug={slug} admin={membership.role !== "MEMBER"}>
          Merged pull requests still go into the changelog&apos;s running draft, and what Autopilot found already is kept.
        </PlanNotice>
      )}
      {!first && (
        <EmptyState
          title="Nothing from Autopilot yet"
          description={
            !codeChangesEnabled()
              ? decisionsMissing()
                ? `Autopilot needs OpenRouter's Decisions API, which this server's AI provider (${aiProvider()}) doesn't have: ${codeChangesFix()} turns it on.`
                : `Autopilot isn't available on this server yet: it needs ${codeChangesFix()}.`
              : !included
                ? "On this project's plan, merged pull requests go into the changelog's running draft only."
                : !connection
                ? "Connect GitHub and add your repositories: each pull request merged there shows up here."
                : !connection.project.analyseCodeChanges
                  ? membership.role === "OWNER"
                    ? "Autopilot is off for this project. Turn it on in its settings."
                    : "Autopilot is off for this project. An owner can turn it on in Settings → Autopilot."
                  : "Each pull request merged on your repositories shows up here, with the feedback it completes and the docs it changes."
          }
          action={
            // Connecting GitHub is for owners and admins; turning Autopilot on, for owners.
            codeChangesEnabled() && included && (connection ? !connection.project.analyseCodeChanges && membership.role === "OWNER" : membership.role !== "MEMBER") ? (
              <Link href={`/app/${slug}/settings/${connection ? "autopilot" : "integrations"}`} className={buttonVariants({ variant: "outline" })}>
                {connection ? "Autopilot settings" : "Connect GitHub"}
              </Link>
            ) : undefined
          }
        />
      )}
    </div>
  );
}

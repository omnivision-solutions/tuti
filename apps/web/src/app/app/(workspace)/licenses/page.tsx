import type { Metadata } from "next";
import { prisma } from "@tuti/db";
import { planDisplay } from "@tuti/shared";
import { redirect } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { Pane, PaneBody, PaneHeader, PaneLayout } from "@/components/pane";
import { PlanLicenses } from "@/components/plan-licenses";
import { getAccountSession } from "@/server/session";

export const metadata: Metadata = { title: "Licenses" };

/** Where a license's source is named for people. */
const SOURCES: Record<string, string> = { appsumo: "AppSumo" };

/**
 * The account's plan licenses (docs/plan.md, Plan licenses): lifetime deals redeemed to it (AppSumo's redeem page comes
 * here), each assigned to one project its holder owns or administers, whose plan it gives.
 */
export default async function LicensesPage() {
  const session = await getAccountSession();
  if (!session) {
    redirect("/app/auth/sign-in?next=/app/licenses");
  }
  const [licenses, memberships] = await Promise.all([
    prisma.planLicense.findMany({
      where: { userId: session.user.id },
      orderBy: [{ claimedAt: "asc" }, { id: "asc" }],
      select: { id: true, source: true, externalKey: true, plan: true, revokedAt: true, project: { select: { slug: true, name: true } } },
    }),
    prisma.teamMember.findMany({
      where: { userId: session.user.id, role: { in: ["OWNER", "ADMIN"] } },
      orderBy: { createdAt: "asc" },
      select: { project: { select: { slug: true, name: true, planLicense: { select: { id: true } } } } },
    }),
  ]);
  return (
    <PaneLayout>
      <Pane aria-label="Licenses">
        <PaneHeader title="Licenses" />
        <PaneBody className="p-4 @min-[48rem]/app:px-6 @min-[48rem]/app:py-7">
          <div className="mx-auto flex max-w-3xl flex-col gap-4">
            <p className="text-muted-foreground">Lifetime deals on your account. Each one gives its plan to one project you own or administer.</p>
            {licenses.length === 0 ? (
              <EmptyState title="No licenses yet" description="Bought Tuti on AppSumo? Redeem your license from your AppSumo account, and it comes here." />
            ) : (
              <PlanLicenses
                licenses={licenses.map((license) => ({
                  id: license.id,
                  source: SOURCES[license.source] ?? license.source,
                  key: license.externalKey,
                  plan: planDisplay(license.plan).name,
                  revoked: license.revokedAt !== null,
                  project: license.project && { ...license.project, open: memberships.some(({ project }) => project.slug === license.project!.slug) },
                }))}
                // Those it can go on: the ones without a license.
                projects={memberships.flatMap(({ project: { planLicense, ...project } }) => (planLicense ? [] : [project]))}
              />
            )}
          </div>
        </PaneBody>
      </Pane>
    </PaneLayout>
  );
}

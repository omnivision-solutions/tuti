import { prisma } from "@tuti/db";
import { planIncludes, planNeeded } from "@tuti/shared";
import { notFound } from "next/navigation";

import { OwnAddressSettings } from "@/components/own-address";
import { PlanNotice } from "@/components/plan-notice";
import { RedirectsSettings } from "@/components/redirects-settings";
import { customDomainTarget } from "@/lib/custom-domains";
import { appUrl, portalUrl } from "@/lib/hosts";
import { MAX_REDIRECTS } from "@/lib/portal-redirects";
import { oneClickDns } from "@/server/domain-connect";
import { getAdminProject } from "@/server/membership";
import { customDomain } from "@/server/operations/domain";
import { siteMountView } from "@/server/operations/site";

/**
 * Settings → Domain: where the portal lives (its Tuti address, a domain of the team's own, or a path of
 * their site), and old addresses on it sent on to new ones. Both were in Customize before.
 */
export default async function DomainSettingsPage(props: PageProps<"/app/[project]/settings/domain">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [domain, site, { plan }, redirects] = await Promise.all([
    customDomain(project.id),
    siteMountView(project.id),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } }),
    prisma.portalRedirect.findMany({ where: { projectId: project.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true, from: true, to: true } }),
  ]);
  // Set up before the plan dropped: kept, but not served.
  const unpaid = domain && !planIncludes(plan, "customDomain") ? "customDomain" : site && !planIncludes(plan, "sitePath") ? "sitePath" : null;
  const portal = new URL(portalUrl(slug));
  // Its records added by its DNS provider in one click while it waits for them. Not awaited: the
  // button shows once its lookup is in.
  const target = domain?.records.find((record) => record.type === "CNAME")?.value;
  const token = domain?.records.find((record) => record.type === "TXT")?.value.replace(/^tuti-verify=/, "");
  const oneClick =
    domain?.status === "pending" && target && token
      ? oneClickDns(domain.hostname, "custom-domain", { target, token }, new URL(`/app/${slug}/settings/domain`, appUrl()).href)
      : null;
  return (
    <>
      {unpaid && (
        <PlanNotice feature={unpaid} projectSlug={slug} admin>
          Until it&apos;s back, that address isn&apos;t served; your portal&apos;s Tuti address,{" "}
          <a href={portal.origin} target="_blank" rel="noreferrer" className="font-medium underline underline-offset-4">
            {portal.host}
          </a>
          , keeps working. Its settings are kept.
        </PlanNotice>
      )}
      <OwnAddressSettings
        projectSlug={slug}
        domain={domain}
        site={site}
        domainsOn={Boolean(customDomainTarget())}
        notIncluded={{
          domain: planIncludes(plan, "customDomain") ? null : planNeeded("customDomain"),
          site: planIncludes(plan, "sitePath") ? null : planNeeded("sitePath"),
        }}
        portalAddress={portal.host}
        protocol={portal.protocol}
        oneClick={oneClick}
      />
      <RedirectsSettings projectSlug={slug} redirects={redirects} max={MAX_REDIRECTS} />
    </>
  );
}

import { prisma } from "@tuti/db";
import { planIncludes, planNeeded } from "@tuti/shared";
import { notFound } from "next/navigation";

import { CustomizeShell } from "@/components/customize-shell";
import { OwnAddressSettings } from "@/components/own-address";
import { PlanNotice } from "@/components/plan-notice";
import { customDomainTarget } from "@/lib/custom-domains";
import { portalUrl } from "@/lib/hosts";
import { portalPreview } from "@/server/customize";
import { getAdminProject } from "@/server/membership";
import { customDomain } from "@/server/operations/domain";
import { siteMountView } from "@/server/operations/site";

import { sectionTitle } from "../sections";

/** Customize → Address: the portal at its Tuti address, a domain of the team's own, or a path of their site. */
export default async function AddressPage(props: PageProps<"/app/[project]/customize/address">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [domain, site, { plan }] = await Promise.all([
    customDomain(project.id),
    siteMountView(project.id),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } }),
  ]);
  // Set up before the plan dropped: kept, but not served.
  const unpaid = domain && !planIncludes(plan, "customDomain") ? "customDomain" : site && !planIncludes(plan, "sitePath") ? "sitePath" : null;
  const portal = new URL(portalUrl(slug));
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("address")} preview={await portalPreview(slug, "/")}>
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
      />
    </CustomizeShell>
  );
}

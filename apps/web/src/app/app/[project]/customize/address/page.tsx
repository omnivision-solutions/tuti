import { notFound } from "next/navigation";

import { CustomizeShell } from "@/components/customize-shell";
import { OwnAddressSettings } from "@/components/own-address";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
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
  const [domain, site] = await Promise.all([customDomain(project.id), siteMountView(project.id)]);
  const portal = new URL(portalUrl(slug));
  return (
    <CustomizeShell backHref={`/app/${slug}/customize`} title={sectionTitle("address")} preview={await portalPreview(slug, "/")}>
      <Card>
        <CardHeader>
          <CardTitle>Your own address</CardTitle>
          <CardDescription>
            Your portal and docs at an address of yours: a domain of its own, like help.example.com, or a path of your site, like example.com/portal.
            One or the other.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <OwnAddressSettings
            projectSlug={slug}
            domain={domain}
            site={site}
            domainsOn={Boolean(customDomainTarget())}
            portalAddress={portal.host}
            protocol={portal.protocol}
          />
        </CardContent>
      </Card>
    </CustomizeShell>
  );
}

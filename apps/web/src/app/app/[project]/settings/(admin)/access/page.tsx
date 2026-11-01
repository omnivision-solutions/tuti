import { prisma } from "@tuti/db";
import { planIncludes } from "@tuti/shared";
import { notFound } from "next/navigation";

import { AskingPropertySelect } from "@/components/asking-property-select";
import { PlanNotice } from "@/components/plan-notice";
import { PortalAccessSelect } from "@/components/portal-access-select";
import { PortalReaders } from "@/components/portal-readers";
import { PropertyFormatsForm } from "@/components/property-formats-form";
import { ReaderGroups } from "@/components/reader-groups";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { storedPropertyFormats } from "@/lib/property-formats";
import { getAdminProject } from "@/server/membership";
import { groupsWithReaders, numberPropertyNames, propertyNames } from "@/server/operations/groups";
import { portalAccess, portalReaders } from "@/server/operations/portal";

/** Settings → Access: who can read the portal, and the groups single sign-on puts readers in. */
export default async function AccessSettingsPage(props: PageProps<"/app/[project]/settings/access">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const [{ access }, { plan }, properties, numbers] = await Promise.all([
    portalAccess(project.id),
    prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { plan: true } }),
    propertyNames(project.id),
    numberPropertyNames(project.id),
  ]);
  const formats = storedPropertyFormats(project.propertyFormats);

  return (
    <>
      {!planIncludes(plan, "privatePortal") && (
        <PlanNotice feature="privatePortal" projectSlug={project.slug} admin>
          Without it, a private portal and content for reader groups are your team&apos;s only. Your settings are kept.
        </PlanNotice>
      )}
      <Card>
        <CardHeader>
          <CardTitle>Portal access</CardTitle>
          <CardDescription>Who can see your portal, its docs and changelog, and the widget.</CardDescription>
        </CardHeader>
        <CardContent>
          <PortalAccessSelect projectSlug={project.slug} access={access} />
          {access === "private" && <PortalReaders projectSlug={project.slug} readers={await portalReaders(project.id)} />}
        </CardContent>
      </Card>

      <Card id="groups" role="region" aria-labelledby="groups-title" className="scroll-mt-18">
        <CardHeader>
          <CardTitle id="groups-title">Groups</CardTitle>
          <CardDescription>
            Your users, grouped by their properties: plan, support tier, the <code>groups</code> in your app&apos;s sign-in token… A tab, collection
            or article in your docs can be for some groups only.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReaderGroups projectSlug={project.slug} groups={await groupsWithReaders(project.id)} properties={properties} />
        </CardContent>
      </Card>

      <Card id="asking" role="region" aria-labelledby="asking-title" className="scroll-mt-18">
        <CardHeader>
          <CardTitle id="asking-title">Who&apos;s asking</CardTitle>
          <CardDescription>
            A number property of your users (MRR, seats…), totalled over each post&apos;s voters on Feedback and the post, so you can see what an
            idea is worth. Only your team sees it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <AskingPropertySelect projectSlug={project.slug} property={project.askingProperty} properties={numbers} />
        </CardContent>
      </Card>

      {/* While any user has a property, or one keeps a name or format (to clear it). */}
      {(properties.length > 0 || Object.keys(formats).length > 0) && (
        <Card id="properties" role="region" aria-labelledby="properties-title" className="scroll-mt-18">
          <CardHeader>
            <CardTitle id="properties-title">User properties</CardTitle>
            <CardDescription>
              How your users&apos; properties show on Users, beside a conversation and in Who&apos;s asking: a name of your own (MRR for{" "}
              <code>mrr</code>) and a format.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <PropertyFormatsForm
              projectSlug={project.slug}
              // Those set before too, even past the first 200 names, so saving keeps them.
              properties={[...new Set([...properties, ...Object.keys(formats)])].sort()}
              formats={formats}
            />
          </CardContent>
        </Card>
      )}
    </>
  );
}

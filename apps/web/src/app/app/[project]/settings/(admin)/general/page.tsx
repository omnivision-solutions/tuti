import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ProjectNameForm } from "@/components/project-name-form";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { portalAddress } from "@/server/custom-domains";
import { getAdminProject } from "@/server/membership";

/** Settings → General: the project's name, and where its portal is (changed in Domain). */
export default async function GeneralSettingsPage(props: PageProps<"/app/[project]/settings/general">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project) {
    notFound();
  }
  const { name } = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { name: true } });
  const portal = await portalAddress(slug);
  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>
          Your portal is at{" "}
          <a href={portal} target="_blank" rel="noreferrer" className="break-all text-foreground underline underline-offset-4">
            {new URL(portal).host}
            {new URL(portal).pathname.replace(/\/$/, "")}
          </a>
          . Change where in{" "}
          <Link href={`/app/${slug}/settings/domain`} className="text-foreground underline underline-offset-4">
            Domain
          </Link>
          .
        </CardDescription>
      </CardHeader>
      <CardContent>
        <ProjectNameForm projectSlug={slug} name={name} />
      </CardContent>
    </Card>
  );
}

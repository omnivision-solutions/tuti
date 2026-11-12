import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { ProjectNameForm } from "@/components/project-name-form";
import { SettingRow, SettingsCard, SettingsPane } from "@/components/settings-card";
import { buttonVariants } from "@/components/ui/button";
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
  const address = `${new URL(portal).host}${new URL(portal).pathname.replace(/\/$/, "")}`;
  return (
    <SettingsPane title="General" description="Your project's name and where its portal is.">
      <SettingsCard>
        <ProjectNameForm projectSlug={slug} name={name} />
        <SettingRow
          label="Portal address"
          description={
            <a href={portal} target="_blank" rel="noreferrer" className="break-all underline underline-offset-4 hover:text-foreground">
              {address}
            </a>
          }
          inline
        >
          <Link href={`/app/${slug}/settings/domain`} aria-label="Change the portal address in Domain" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Change
          </Link>
        </SettingRow>
      </SettingsCard>
    </SettingsPane>
  );
}

import type { Metadata } from "next";
import Link from "next/link";

import { ProjectNameForm } from "@/components/project-name-form";
import { SettingRow, SettingsCard, SettingsPane } from "@/components/settings-card";
import { buttonVariants } from "@/components/ui/button";
import { serverCaller } from "@/server/trpc/server";

export const metadata: Metadata = { title: "General · Settings" };

/** Settings → General: the project's name, and where its portal is (changed in Domain). */
export default async function GeneralSettingsPage(props: PageProps<"/app/[project]/settings/general">) {
  const { project: slug } = await props.params;
  // Owners and admins only: the (admin) layout's 404 for anyone else.
  const { name, portalUrl: portal } = await (await serverCaller()).project.get({ project: slug });
  const address = `${new URL(portal).host}${new URL(portal).pathname.replace(/\/$/, "")}`;
  return (
    <SettingsPane title="General">
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

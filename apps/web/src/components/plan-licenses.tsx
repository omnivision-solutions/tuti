"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { SettingRow, SettingsCard } from "@/components/settings-card";
import { Button, buttonVariants } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { assignPlanLicense, unassignPlanLicense } from "@/server/plan-licenses";

export type PlanLicenseView = {
  id: string;
  /** Where it came from, as people know it ("AppSumo"). */
  source: string;
  key: string;
  /** Its plan's name. */
  plan: string;
  revoked: boolean;
  /** `open`: its holder may open its Billing (they own or administer it still). */
  project: { slug: string; name: string; open: boolean } | null;
};

/**
 * Licenses (the account's): each license's plan, where it came from and its key (what support asks for), and the
 * project it's on, with Unassign; or a project to assign it to (those its holder owns or administers without one).
 */
export function PlanLicenses({ licenses, projects }: { licenses: PlanLicenseView[]; projects: { slug: string; name: string }[] }) {
  return (
    <SettingsCard>
      {licenses.map((license) => (
        <LicenseRow key={license.id} license={license} projects={projects} />
      ))}
    </SettingsCard>
  );
}

function LicenseRow({ license, projects }: { license: PlanLicenseView; projects: { slug: string; name: string }[] }) {
  const [picked, setPicked] = useState<string>();
  // The pick while it's still offered (assigning another license may take it), else the first project offered.
  const project = projects.some((one) => one.slug === picked) ? picked! : (projects[0]?.slug ?? "");
  // Each row's controls say which license they're for.
  const named = `${license.plan} license ${license.key}`;
  const [pending, startTransition] = useTransition();
  const act = (run: () => Promise<{ error?: string }>, done: string) =>
    startTransition(async () => {
      const { error } = await run();
      if (error) {
        toast.error(error);
      } else {
        toast.success(done);
      }
    });
  const on = license.project && (
    <>
      On{" "}
      {license.project.open ? (
        <Link href={`/app/${license.project.slug}/settings/billing`} className="font-medium text-foreground underline-offset-4 hover:underline">
          {license.project.name}
        </Link>
      ) : (
        <span className="font-medium text-foreground">{license.project.name}</span>
      )}
    </>
  );
  const status = license.revoked ? <>Deactivated{on && <> · {on}</>}</> : (on ?? "Not assigned to a project");
  return (
    <SettingRow
      label={`${license.plan} plan`}
      description={
        <>
          {license.source} · <span className="font-mono text-xs break-all">{license.key}</span>
          <br />
          {status}
        </>
      }
    >
      {license.project ? (
        <Button variant="outline" aria-label={`Unassign ${named}`} disabled={pending} focusableWhenDisabled onClick={() => act(() => unassignPlanLicense(license.id), "License unassigned")}>
          {pending ? "Unassigning…" : "Unassign"}
        </Button>
      ) : license.revoked ? null : projects.length === 0 ? (
        <Link href="/app/new" className={buttonVariants({ variant: "outline" })}>
          Create a project
        </Link>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Select items={Object.fromEntries(projects.map((one) => [one.slug, one.name]))} value={project} onValueChange={(value) => setPicked(String(value))}>
            <SelectTrigger className="w-48" aria-label={`Project for ${named}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {projects.map((one) => (
                <SelectItem key={one.slug} value={one.slug}>
                  {one.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button aria-label={`Assign ${named}`} disabled={pending || !project} focusableWhenDisabled onClick={() => act(() => assignPlanLicense(project, license.id), "License assigned")}>
            {pending ? "Assigning…" : "Assign"}
          </Button>
        </div>
      )}
    </SettingRow>
  );
}

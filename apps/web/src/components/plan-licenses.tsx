"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { SettingRow, SettingsCard } from "@/components/settings-card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
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
  /** `badge`: it has the "Powered by tuti" add-on, which ends with the license. */
  project: { slug: string; name: string; badgeAddOn: boolean } | null;
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
  const router = useRouter();
  const statusRef = useRef<HTMLSpanElement>(null);
  const assigned = license.project?.slug ?? null;
  // Done, or refused and refreshed (it changed elsewhere), the pressed button is gone (Assign swaps for Unassign and back,
  // a deactivated row has none): once the row shows the change, the keyboard's place moves to its new control, or to its
  // status where none is left. `from`: the row's state before the action.
  const state = `${assigned ?? ""}|${license.revoked}`;
  const from = useRef<string | undefined>(undefined);
  useEffect(() => {
    if (from.current !== undefined && from.current !== state) {
      from.current = undefined;
      (document.querySelector<HTMLElement>(`[data-license-control="${license.id}"]`) ?? statusRef.current)?.focus();
    }
  }, [state, license.id]);
  // The action's own update has rendered (its refresh included): a row it left as it was stops waiting, so a later
  // change from elsewhere doesn't take the keyboard. After the effect above, which moves it first where the row changed.
  useEffect(() => {
    if (!pending) {
      from.current = undefined;
    }
  }, [pending]);
  const act = (run: () => Promise<{ error?: string }>, done: string) =>
    startTransition(async () => {
      from.current = state;
      const { error } = await run();
      if (error) {
        toast.error(error);
        // Refused because the license changed elsewhere (another tab, a refund): the row shows how it is now.
        router.refresh();
      } else {
        toast.success(done);
      }
    });
  const on = license.project && (
    <>
      On <span className="font-medium text-foreground">{license.project.name}</span>
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
          <span ref={statusRef} tabIndex={-1} className="outline-none">
            {status}
          </span>
        </>
      }
    >
      {license.project?.badgeAddOn ? (
        // Its project's paid add-on stops with it, with no refund: asked first.
        <AlertDialog>
          <AlertDialogTrigger render={<Button variant="outline" data-license-control={license.id} aria-label={`${pending ? "Unassigning…" : "Unassign"} ${named}`} disabled={pending} focusableWhenDisabled />}>
            {pending ? "Unassigning…" : "Unassign"}
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Unassign this license?</AlertDialogTitle>
              <AlertDialogDescription>
                {license.project.name}&apos;s &quot;Powered by tuti&quot; add-on stops now, and what&apos;s left of the month or year isn&apos;t refunded.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction disabled={pending} focusableWhenDisabled onClick={() => act(() => unassignPlanLicense(license.id), "License unassigned")}>
                {pending ? "Unassigning…" : "Unassign"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : license.project ? (
        <Button variant="outline" data-license-control={license.id} aria-label={`${pending ? "Unassigning…" : "Unassign"} ${named}`} disabled={pending} focusableWhenDisabled onClick={() => act(() => unassignPlanLicense(license.id), "License unassigned")}>
          {pending ? "Unassigning…" : "Unassign"}
        </Button>
      ) : license.revoked ? null : projects.length === 0 ? (
        <Link href="/app/new" data-license-control={license.id} className={buttonVariants({ variant: "outline" })}>
          Create a project
        </Link>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Select items={Object.fromEntries(projects.map((one) => [one.slug, one.name]))} value={project} onValueChange={(value) => setPicked(String(value))}>
            <SelectTrigger className="w-48" data-license-control={license.id} aria-label={`Project for ${named}`}>
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
          <Button aria-label={`${pending ? "Assigning…" : "Assign"} ${named}`} disabled={pending || !project} focusableWhenDisabled onClick={() => act(() => assignPlanLicense(project, license.id), "License assigned")}>
            {pending ? "Assigning…" : "Assign"}
          </Button>
        </div>
      )}
    </SettingRow>
  );
}

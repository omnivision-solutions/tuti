import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CopyField } from "@/components/copy-button";
import { InviteForm } from "@/components/invitations";
import { PageHeader } from "@/components/page-header";
import { SetupUses } from "@/components/setup-uses";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { appUrl } from "@/lib/hosts";
import { canAssignRole } from "@/lib/roles";
import { getMembership, isAdminRole } from "@/server/membership";

const STEPS = ["use", "widget", "team"] as const;

/**
 * The first run, right after "Create project" (docs/plan.md, the redesign's step 6): what the team will use (Home's
 * "Get set up" follows it), the widget's snippet, and inviting the team. Each step can be skipped, and so can all of it.
 */
export default async function SetupPage(props: PageProps<"/app/[project]/setup">) {
  const { project: slug } = await props.params;
  const { step: asked } = await props.searchParams;
  const membership = await getMembership(slug);
  if (!membership || !isAdminRole(membership.role)) {
    notFound();
  }
  const step = STEPS.find((s) => s === asked) ?? "use";
  const next = (s: (typeof STEPS)[number]) => `/app/${slug}/setup?step=${s}`;
  const home = `/app/${slug}`;
  const skip = (href: string) => (
    <Link href={href} className={buttonVariants({ variant: "ghost" })}>
      Skip
    </Link>
  );

  return (
    <>
      <PageHeader
        title={`Set up ${membership.project.name}`}
        meta={`Step ${STEPS.indexOf(step) + 1} of ${STEPS.length}`}
        actions={
          <Link href={home} className={buttonVariants({ variant: "outline" })}>
            Skip setup
          </Link>
        }
      />
      <Card className="max-w-2xl">
        {step === "use" && (
          <>
            <CardHeader>
              <CardTitle>What will you use?</CardTitle>
              <CardDescription>Pick as many as you like. Home lists what&apos;s left to set up for them; everything stays available.</CardDescription>
            </CardHeader>
            <SetupUses
              projectSlug={slug}
              picked={(await prisma.project.findUniqueOrThrow({ where: { id: membership.project.id }, select: { uses: true } })).uses}
              next={next("widget")}
              skip={skip(next("widget"))}
            />
          </>
        )}
        {step === "widget" && (
          <>
            <CardHeader>
              <CardTitle>Add the widget to your site</CardTitle>
              <CardDescription>A button on your site that opens feedback, what&apos;s new, docs and messages in a panel. Paste this script tag into your site&apos;s pages:</CardDescription>
            </CardHeader>
            <CardContent>
              <CopyField label="Before </body>" name="the widget's script tag" value={`<script src="${appUrl().origin}/widget.js" data-project="${slug}" async></script>`} />
            </CardContent>
            <CardFooter className="justify-end gap-2">
              {skip(next("team"))}
              <Link href={next("team")} className={buttonVariants()}>
                Continue
              </Link>
            </CardFooter>
          </>
        )}
        {step === "team" && (
          <>
            <CardHeader>
              <CardTitle>Invite your team</CardTitle>
              <CardDescription>We&apos;ll email them an invite. Only that email address can accept it.</CardDescription>
            </CardHeader>
            <CardContent>
              <InviteForm projectSlug={slug} roles={(["OWNER", "ADMIN", "MEMBER"] as const).filter((r) => canAssignRole(membership.role, r))} />
            </CardContent>
            <CardFooter className="justify-end">
              <Link href={home} className={buttonVariants({ variant: "outline" })}>
                Go to Home
              </Link>
            </CardFooter>
          </>
        )}
      </Card>
    </>
  );
}

import { creditBalance } from "@tuti/jobs";
import { creditsEnabled } from "@tuti/shared";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { credits } from "@/lib/usage-format";
import { getAdminProject } from "@/server/membership";

const SOURCES = { FREE: "Free credits", TOPUP: "Top-up", PLAN: "Plan", MANUAL: "Given by Tuti" } as const;

const day = (date: Date) => date.toLocaleDateString("en", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/** Settings → Billing (only with AI credits on): the project's balance, and the credits it has left by when they expire. */
export default async function BillingSettingsPage(props: PageProps<"/app/[project]/settings/billing">) {
  const { project: slug } = await props.params;
  const project = await getAdminProject(slug);
  if (!project || !creditsEnabled()) {
    notFound();
  }
  const { balance, grants } = await creditBalance(project.id);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{credits(balance)} AI credits</CardTitle>
        <CardDescription>
          AI answers, changelog drafts and code changes spend credits as they&apos;re used; what each spent is in{" "}
          <Link href={`/app/${slug}/settings/usage`} className="underline underline-offset-4">
            Usage
          </Link>
          . Credits that expire soonest are spent first.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {grants.length === 0 ? (
          <p className="text-sm text-muted-foreground">No credits left.</p>
        ) : (
          <table className="w-full text-sm" aria-label="AI credits left">
            <thead className="text-left text-xs text-muted-foreground">
              <tr>
                <th className="pb-2 font-medium">Credits</th>
                <th className="pb-2 text-right font-medium">Left</th>
                <th className="hidden pb-2 text-right font-medium sm:table-cell">Of</th>
                <th className="pb-2 text-right font-medium">Expires</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {grants.map((grant) => (
                <tr key={grant.id}>
                  <td className="py-2">
                    {SOURCES[grant.source]} <span className="text-muted-foreground">({day(grant.createdAt)})</span>
                  </td>
                  <td className="py-2 text-right tabular-nums">{credits(grant.remaining)}</td>
                  <td className="hidden py-2 text-right tabular-nums sm:table-cell">{credits(grant.credits)}</td>
                  <td className="py-2 text-right">{grant.expiresAt ? day(grant.expiresAt) : "Never"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

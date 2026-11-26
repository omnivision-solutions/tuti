import { BellIcon, RssIcon } from "lucide-react";
import Link from "next/link";

import { changelogByEmail } from "@/components/changelog-pages";
import { SignInLink } from "@/components/sign-in-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ResendVerificationButton } from "@/components/resend-verification-button";
import { cn } from "@/lib/utils";
import { emailReach } from "@/server/post-lists";
import { portalLinks } from "@/server/portal-base";
import { portalTranslator } from "@/server/portal-language";
import type { getSession } from "@/server/session";

/**
 * Feedback's Get updates (a board, the boards' overview): a popover saying where the reader stands, the changelog by email,
 * its page and feed. Read once, drawn by the function it returns: `round`, a round bell in the header's row; else the bell
 * and its words (phones, under the list). `voter`: their id if they may vote here; `back`: where confirming their email
 * comes back to. (A function, not an async component: pages are rendered to HTML in tests, which can't await one.)
 */
export async function boardGetUpdates({
  project,
  session,
  voter,
  back,
}: {
  project: Parameters<typeof changelogByEmail>[0] & { id: string };
  session: Awaited<ReturnType<typeof getSession>>;
  voter: string | null;
  back: string;
}) {
  const at = await portalLinks();
  // Whether the shipped email would reach them, by the rule that sends it.
  const [reach, byEmail, { t }] = await Promise.all([
    voter ? emailReach(project.id, voter) : undefined,
    changelogByEmail(project, session, true),
    portalTranslator(project.id, "feedback"),
  ]);
  return function getUpdates(round: boolean) {
    return (
    <Popover>
      <PopoverTrigger
        aria-label={round ? t("getUpdates") : undefined}
        render={
          <Button
            variant="outline"
            size={round ? "icon" : "default"}
            className={cn("shrink-0 text-muted-foreground hover:text-foreground", round ? "rounded-full" : "gap-1.5 font-medium")}
          />
        }
      >
        <BellIcon aria-hidden />
        {!round && t("getUpdates")}
      </PopoverTrigger>
      <PopoverContent align="end" aria-labelledby="get-updates" className="flex w-80 flex-col gap-3 p-4 text-sm">
        <h2 id="get-updates" className="font-sans text-[0.9375rem] font-semibold">
          {t("getUpdates")}
        </h2>
        {/* Only what holds for them: the team, someone the project's sign-on gave no address, or not a reader of a private portal hears nothing. */}
        {!session ? (
          <p className="text-muted-foreground">
            {t("voteToHear")}
          </p>
        ) : !voter ? (
          // Signed in through another project's single sign-on: as the vote buttons say.
          <p className="text-muted-foreground">
            {t.rich("signInToVoteLine", { link: (chunks) => <SignInLink className="text-foreground underline underline-offset-4">{chunks}</SignInLink> })}
          </p>
        ) : reach?.status === "emailed" ? (
          <p className="text-muted-foreground">
            {t("voteToGetEmail")}
          </p>
        ) : reach?.status === "unconfirmed" ? (
          <div className="flex flex-col items-start gap-1">
            <p className="text-muted-foreground">
              {t("confirmToHear")}
            </p>
            <ResendVerificationButton email={session.user.email} callbackURL={at(back)} />
          </div>
        ) : reach?.status === "optedOut" || reach?.status === "turnedOff" ? (
          // All of the project's emails, or those about ideas they vote on: either way, their Account turns them back on.
          <p className="text-muted-foreground">
            <Link href={at("/account")} className="text-foreground underline underline-offset-4">
              {t("unsubscribed")}
            </Link>
          </p>
        ) : null}
        {byEmail}
        <div className="flex items-center justify-between gap-2">
          <Link href={at("/changelog")} className="font-medium text-foreground underline decoration-primary/55 decoration-[1.5px] underline-offset-[3px]">
            {t("readChangelog")}
          </Link>
          <a href={at("/changelog/rss.xml")} className={buttonVariants({ variant: "ghost", size: "sm", className: "text-muted-foreground" })}>
            <RssIcon aria-hidden /> {t("rss")}
          </a>
        </div>
      </PopoverContent>
    </Popover>
  );
  };
}

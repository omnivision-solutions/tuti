"use client";

import type { PostStatus } from "@tuti/db";
import { BellIcon, BellOffIcon } from "lucide-react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { useSignInHref } from "@/components/sign-in-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { setPostSubscription } from "@/server/posts";

/**
 * Whether only shipping is still to come for a post in `status`, as its emails promise (the line says "when it ships", else
 * "as it moves forward and when it ships"): the team's moves forward email (Autopilot's own don't, so no step is promised),
 * and shipping does. Completed and Closed posts offer no Subscribe.
 */
export const shipsNext = (status: PostStatus) => status === "IN_PROGRESS";

// In the phone's row of actions beside Upvote and Copy link: the words alone, so the row fits a phone.
const PHONE = "font-semibold max-lg:px-3 max-lg:[&>svg]:hidden";

/**
 * Subscribe on a portal post, for people who don't vote: they're emailed as it moves forward and when it ships, as voters are.
 * Signed out it goes to sign in and back; `following`: they already hear (they posted, voted or commented), so a line
 * instead, whether or not they subscribed too (unsubscribing would change nothing). Subscribing never changes `following`,
 * so the button isn't swapped for the line under someone using it. The page leaves it out for a post that won't ship
 * again and for people its emails can't reach.
 */
export function SubscribeButton({ postId, status, subscribed, following, signedIn }: { postId: string; status: PostStatus; subscribed: boolean; following: boolean; signedIn: boolean }) {
  // What Subscribe does, under it in the post's card; only while it offers Subscribe.
  const t = useTranslations("feedback");
  const hint = (
    <p className="-mt-2 text-[0.8125rem] text-muted-foreground max-lg:hidden">
      {shipsNext(status) ? t("emailWhenShips") : t("emailAsMoves")}
    </p>
  );
  const signInHref = useSignInHref();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(subscribed);

  if (!signedIn) {
    return (
      <>
        <Link href={signInHref} className={buttonVariants({ variant: "outline", size: "lg", className: PHONE })}>
          <BellIcon />
          {t("subscribe")}
        </Link>
        {hint}
      </>
    );
  }
  if (following) {
    // On phones a line of its own under the post's row of actions.
    return (
      <p className="text-sm text-muted-foreground max-lg:order-last max-lg:basis-full">
        {shipsNext(status) ? t("hearWhenShips") : t("hearAsMoves")}
      </p>
    );
  }
  return (
    <>
      <Button
        // Beside Upvote, the post's primary: an outline, and once subscribed, a quiet way back.
        variant={optimistic ? "ghost" : "outline"}
        size="lg"
        className={PHONE}
        disabled={pending}
        // Keeps the keyboard's focus while it saves.
        focusableWhenDisabled
        onClick={() =>
          startTransition(async () => {
            setOptimistic(!optimistic);
            const result = await setPostSubscription(postId, !optimistic);
            if (result.error) {
              toast.error(result.error);
            }
          })
        }
      >
        {optimistic ? <BellOffIcon /> : <BellIcon />}
        {optimistic ? t("unsubscribe") : t("subscribe")}
      </Button>
      {!optimistic && hint}
    </>
  );
}

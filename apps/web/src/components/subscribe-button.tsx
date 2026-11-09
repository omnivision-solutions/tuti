"use client";

import { BellIcon, BellOffIcon } from "lucide-react";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";
import { toast } from "sonner";

import { useSignInHref } from "@/components/sign-in-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { setPostSubscription } from "@/server/posts";

/**
 * Subscribe on a portal post, for people who don't vote: they're emailed when it ships, as voters are.
 * Signed out it goes to sign in and back; `following`: they already hear (they posted, voted or commented), so a line
 * instead, whether or not they subscribed too (unsubscribing would change nothing). Subscribing never changes `following`,
 * so the button isn't swapped for the line under someone using it. The page leaves it out for a post that won't ship
 * again and for people its emails can't reach.
 */
// What Subscribe does, under it in the post's card; only while it offers Subscribe.
const hint = <p className="-mt-2 text-[0.8125rem] text-muted-foreground max-lg:hidden">Get an email when it ships.</p>;

export function SubscribeButton({ postId, subscribed, following, signedIn }: { postId: string; subscribed: boolean; following: boolean; signedIn: boolean }) {
  const signInHref = useSignInHref();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(subscribed);

  if (!signedIn) {
    return (
      <>
        <Link href={signInHref} className={buttonVariants({ variant: "outline", size: "lg", className: "font-semibold" })}>
          <BellIcon />
          Subscribe
        </Link>
        {hint}
      </>
    );
  }
  if (following) {
    return <p className="text-sm text-muted-foreground">{"You'll hear when it ships."}</p>;
  }
  return (
    <>
      <Button
        // Beside Upvote, the post's primary: an outline, and once subscribed, a quiet way back.
        variant={optimistic ? "ghost" : "outline"}
        size="lg"
        className="font-semibold"
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
        {optimistic ? "Unsubscribe" : "Subscribe"}
      </Button>
      {!optimistic && hint}
    </>
  );
}

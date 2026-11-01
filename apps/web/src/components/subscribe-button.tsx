"use client";

import { BellIcon, BellOffIcon } from "lucide-react";
import Link from "next/link";
import { useOptimistic, useTransition } from "react";

import { useSignInHref } from "@/components/sign-in-link";
import { Button, buttonVariants } from "@/components/ui/button";
import { setPostSubscription } from "@/server/posts";

/**
 * Subscribe on a portal post, for people who don't vote: they're emailed when it ships, as voters are.
 * Signed out it goes to sign in and back; a voter already hears, so they get no button.
 */
export function SubscribeButton({ postId, subscribed, voted, signedIn }: { postId: string; subscribed: boolean; voted: boolean; signedIn: boolean }) {
  const signInHref = useSignInHref();
  const [pending, startTransition] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(subscribed);

  if (!signedIn) {
    return (
      <Link href={signInHref} className={buttonVariants({ variant: "outline", size: "sm" })}>
        <BellIcon />
        Subscribe
      </Link>
    );
  }
  if (voted && !subscribed) {
    return <p className="text-sm text-muted-foreground">{"You voted, so you'll hear when it ships."}</p>;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          setOptimistic(!optimistic);
          await setPostSubscription(postId, !optimistic);
        })
      }
    >
      {optimistic ? <BellOffIcon /> : <BellIcon />}
      {optimistic ? "Unsubscribe" : "Subscribe"}
    </Button>
  );
}

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
 * Signed out it goes to sign in and back; `following`: they already hear (they posted, voted or commented), so no button. The page leaves it
 * out for a post that won't ship again and for people its emails can't reach.
 */
export function SubscribeButton({ postId, subscribed, following, signedIn }: { postId: string; subscribed: boolean; following: boolean; signedIn: boolean }) {
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
  if (following && !subscribed) {
    return <p className="text-sm text-muted-foreground">{"You'll hear when it ships."}</p>;
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={pending}
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
  );
}

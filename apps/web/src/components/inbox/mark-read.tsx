"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { useTRPCClient } from "@/components/trpc";

/** Only a visible, focused conversation has been seen; prefetches and background refreshes haven't. */
export function MarkRead({ slug, number, seen, unread }: { slug: string; number: number; seen: string | null; unread: boolean }) {
  const trpc = useTRPCClient();
  const router = useRouter();
  useEffect(() => {
    if (!unread) return;
    let acknowledged = false;
    const acknowledge = () => {
      if (acknowledged || document.visibilityState !== "visible" || !document.hasFocus()) return;
      acknowledged = true;
      // Read, its row in the list isn't bold any more.
      void trpc.conversations.markRead.mutate({ project: slug, number, seen }).then(
        () => router.refresh(),
        () => { acknowledged = false; },
      );
    };
    acknowledge();
    document.addEventListener("visibilitychange", acknowledge);
    window.addEventListener("focus", acknowledge);
    return () => {
      document.removeEventListener("visibilitychange", acknowledge);
      window.removeEventListener("focus", acknowledge);
    };
  }, [slug, number, seen, unread, trpc, router]);
  return null;
}

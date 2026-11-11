"use client";

import { useEffect } from "react";

import { markConversationRead } from "@/server/inbox";

/** Mounting means the conversation was opened, unlike a server render fetched speculatively by a link. */
export function MarkRead({ slug, number, seen, unread }: { slug: string; number: number; seen: string | null; unread: boolean }) {
  useEffect(() => {
    if (unread) void markConversationRead(slug, number, seen);
  }, [slug, number, seen, unread]);
  return null;
}

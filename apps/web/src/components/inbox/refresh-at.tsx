"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Refreshes the page at `at` (an ISO time): what it shows until then, like "Online", is over. */
export function RefreshAt({ at }: { at: string }) {
  const router = useRouter();
  useEffect(() => {
    const timer = setTimeout(() => router.refresh(), Math.max(0, new Date(at).getTime() - Date.now()) + 1000);
    return () => clearTimeout(timer);
  }, [at, router]);
  return null;
}

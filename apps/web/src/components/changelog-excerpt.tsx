"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * An entry's excerpt in the changelog's list (its text from `excerpt()`), clamped to three lines; it fades out where
 * it's cut: by `excerpt()` (`cut`), or by the clamp once the window wraps it past its lines.
 */
export function ChangelogExcerpt({ text, cut }: { text: string; cut: boolean }) {
  const ref = useRef<HTMLParagraphElement>(null);
  // null until measured (on the server, and before the effect runs).
  const [clamped, setClamped] = useState<boolean | null>(null);
  useEffect(() => {
    const p = ref.current;
    if (!p) {
      return;
    }
    const check = () => setClamped(p.scrollHeight > p.clientHeight + 1);
    check();
    const observer = new ResizeObserver(check);
    observer.observe(p);
    return () => observer.disconnect();
  }, []);
  return (
    <p
      ref={ref}
      data-measured={clamped !== null || undefined}
      className={cn(
        "text-base leading-7 break-words whitespace-pre-line text-foreground/85",
        "line-clamp-3",
        (cut || clamped) && "[mask-image:linear-gradient(to_bottom,black_55%,transparent)]",
      )}
    >
      {text}
    </p>
  );
}

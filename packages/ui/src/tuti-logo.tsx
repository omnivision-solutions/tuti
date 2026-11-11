import { cn } from "cn";

/** The parrot mark (tuti is Persian for parrot). Body follows the theme's primary green. */
export function TutiMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6 shrink-0", className)}>
      <path
        d="M16 3C9 3 4 8.5 4 15.5S9 29 15 29c1.5 0 2-1 2-2v-6c4 0 9-2.5 9-9C26 7 21.5 3 16 3Z"
        className="fill-primary"
      />
      <path d="M24 10.5c3 .5 5 2.5 5 5.5-2.2-1.2-3.8-1.4-5.6-1.1Z" fill="#f26b1d" />
      <circle cx="18.5" cy="10.5" r="2.2" className="fill-background" />
      <circle cx="19" cy="10.5" r="1.1" className="fill-foreground" />
    </svg>
  );
}

export function TutiLogo({ className }: { className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-2 font-heading text-xl font-bold tracking-tight", className)}>
      <TutiMark />
      tuti
    </span>
  );
}

import { cn } from "cn";

/**
 * The parrot mark (tuti is Persian for parrot). Body follows the theme's primary green; with `mono`, the text's colour
 * (beak lighter): grey beside a team's own colours, where Tuti's green and orange would clash (a portal's "Powered by tuti").
 */
export function TutiMark({ className, mono = false }: { className?: string; mono?: boolean }) {
  return (
    <svg viewBox="0 0 32 32" aria-hidden className={cn("size-6 shrink-0", className)}>
      <path
        d="M16 3C9 3 4 8.5 4 15.5S9 29 15 29c1.5 0 2-1 2-2v-6c4 0 9-2.5 9-9C26 7 21.5 3 16 3Z"
        className={mono ? "fill-current" : "fill-primary"}
      />
      <path d="M24 10.5c3 .5 5 2.5 5 5.5-2.2-1.2-3.8-1.4-5.6-1.1Z" {...(mono ? { className: "fill-current", opacity: 0.55 } : { fill: "#f26b1d" })} />
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

/**
 * "tuti" in Tuti's heading font (Bricolage Grotesque, bold), drawn: the same on every portal, whatever fonts the team
 * picked. In the text's colour; size it by height (0.72 of the font size it stands in for).
 */
export function TutiWordmark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 12 141 73" role="img" aria-label="tuti" className={cn("h-[0.72em] w-auto shrink-0 fill-current", className)}>
      <path d="M24 84.1Q15.3 84.1 11 79.6Q6.6 75.1 6.6 65.7L6.6 41.9L0.7 41.9L0.7 32.5L1.5 32.5Q7 31.9 9.4 28.9Q11.7 26 12.2 20L12.3 18.7L20.9 18.7L20.9 30.5L33.4 30.5L33.4 42.2L20.9 42.2L20.9 64.4Q20.9 68.2 22.8 69.9Q24.6 71.6 27.4 71.6Q28.9 71.6 30.5 71.2Q32 70.7 33.4 69.9L33.4 82.7Q30.5 83.5 28.2 83.8Q25.9 84.1 24 84.1ZM54.2 84.4Q45.5 84.4 41.3 78.3Q37.1 72.1 37.1 59.3L37.1 30.5L51.6 30.5L51.6 59.1Q51.6 66 53.5 68.9Q55.3 71.7 59 71.7Q61.6 71.7 63.7 70.4Q65.7 69.1 67.3 66.5Q68.8 63.9 69.6 59.8Q70.4 55.7 70.4 50L70.4 30.5L84.8 30.5L84.8 83L72.4 83L72.7 62L72 62Q71.3 69.8 69.2 74.8Q67 79.7 63.3 82.1Q59.6 84.4 54.2 84.4ZM110.6 84.1Q101.9 84.1 97.6 79.6Q93.2 75.1 93.2 65.7L93.2 41.9L87.3 41.9L87.3 32.5L88.1 32.5Q93.6 31.9 96 28.9Q98.3 26 98.8 20L98.9 18.7L107.5 18.7L107.5 30.5L120 30.5L120 42.2L107.5 42.2L107.5 64.4Q107.5 68.2 109.4 69.9Q111.2 71.6 114 71.6Q115.5 71.6 117.1 71.2Q118.6 70.7 120 69.9L120 82.7Q117.1 83.5 114.8 83.8Q112.5 84.1 110.6 84.1ZM138.7 83L124.3 83L124.3 30.5L138.7 30.5ZM131.4 26Q127.2 26 125 24.2Q122.8 22.4 122.8 19.1Q122.8 15.7 125 13.9Q127.2 12.1 131.4 12.1Q135.6 12.1 137.9 13.9Q140.1 15.7 140.1 19.1Q140.1 22.4 137.9 24.2Q135.6 26 131.4 26Z" />
    </svg>
  );
}

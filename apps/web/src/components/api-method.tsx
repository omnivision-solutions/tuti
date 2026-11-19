import type { ApiOperation } from "@tuti/shared/api-reference";

import { cn } from "@/lib/utils";

/**
 * A method's colour, in hues the portal keeps whatever the project's accent (statuses', info blue, destructive red): the
 * accent itself isn't for labels. Reading in the Planned status's blue, adding in the Completed status's green, changing in orange, deleting in red.
 * GraphQL's likewise: a query reads, a mutation changes (the Completed status's green, as a POST), a subscription
 * listens (the Under review status's purple).
 */
const METHOD_COLOUR: Partial<Record<ApiOperation["kind"], string>> = {
  GET: "text-status-planned",
  POST: "text-status-completed",
  PUT: "text-status-in-progress",
  PATCH: "text-status-in-progress",
  DELETE: "text-destructive",
  query: "text-status-planned",
  mutation: "text-status-completed",
  subscription: "text-status-under-review",
};

/** GraphQL's kinds as the tree's narrow column fits them; read out whole. */
const SHORT: Partial<Record<ApiOperation["kind"], string>> = { mutation: "mut", subscription: "sub" };

/** An operation's method as a small coloured label (GraphQL's: "query", "mutation"; `short`: "mut"). */
export function Method({ kind, short, className }: { kind: ApiOperation["kind"]; short?: boolean; className?: string }) {
  const label = short && SHORT[kind];
  return (
    <span className={cn("shrink-0 font-mono text-xs font-semibold tracking-wide uppercase", METHOD_COLOUR[kind] ?? "text-muted-foreground", className)}>
      {label ? (
        <>
          <span aria-hidden>{label}</span>
          <span className="sr-only">{kind}</span>
        </>
      ) : (
        kind
      )}
    </span>
  );
}

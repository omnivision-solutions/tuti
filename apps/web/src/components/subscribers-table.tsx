import { SearchIcon } from "lucide-react";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { ListFilters } from "@/components/list-filters";
import { PageNav } from "@/components/page-nav";
import { RemoveSubscriberButton } from "@/components/remove-subscriber-button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { timeAgo } from "@/lib/format";
import { cn } from "@/lib/utils";
import { listChangelogSubscribers, SUBSCRIBER_STATUSES } from "@/server/operations/changelog-subscribers";
import { call } from "@/server/operations/run";

const PER_PAGE = 50;

type Status = (typeof SUBSCRIBER_STATUSES)[number];
const STATUS: Record<Status, { label: string; dot: string; tint: string }> = {
  subscribed: { label: "Subscribed", dot: "bg-primary", tint: "bg-soft" },
  // Waiting on them, not the team: no orange (docs/design.md).
  pending: { label: "Not confirmed", dot: "bg-status-under-review", tint: "bg-muted" },
  unsubscribed: { label: "Unsubscribed", dot: "bg-muted-foreground", tint: "bg-muted" },
  opted_out: { label: "All emails off", dot: "bg-muted-foreground", tint: "bg-muted" },
  removed: { label: "Removed", dot: "bg-muted-foreground", tint: "bg-muted" },
};

/**
 * Users' Subscribers (changelogSubscribers.list): every address that asked for the changelog by email or that the
 * team's app added, users or not, newest first, where each stands, and (owners and admins) Remove.
 */
export async function SubscribersTable({
  context,
  slug,
  page,
  q,
  status: asked,
  admin,
  notSending,
}: {
  context: Parameters<typeof call>[1];
  slug: string;
  page: number;
  q: string;
  /** As the address has it. */
  status: unknown;
  admin: boolean;
  /** Why nothing is emailed now, if it isn't: a private portal, or the project's email paused. */
  notSending: string | null;
}) {
  const status = SUBSCRIBER_STATUSES.find((s) => s === asked);
  const { subscribers, nextCursor, total } = await call(listChangelogSubscribers, context, { q: q || undefined, status, limit: PER_PAGE, cursor: (page - 1) * PER_PAGE });
  const href = (to: number) => `?${new URLSearchParams({ view: "subscribers", ...(q && { q }), ...(status && { status }), ...(to > 1 && { page: String(to) }) })}`;
  const count = (n: number) => n.toLocaleString("en-GB");

  return (
    <>
      <div className="flex items-center gap-2">
        <form role="search" className="relative flex min-w-0 flex-1 sm:w-64 sm:flex-none">
          <input type="hidden" name="view" value="subscribers" />
          {status && <input type="hidden" name="status" value={status} />}
          <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input id="subscribers-search" type="search" name="q" defaultValue={q} placeholder="Email" aria-label="Search subscribers" className="h-8 pl-8" />
        </form>
        <ListFilters
          filters={[
            {
              name: "status",
              label: "Status",
              value: status ?? "*",
              options: [{ value: "*", label: "Any status" }, ...SUBSCRIBER_STATUSES.map((s) => ({ value: s, label: STATUS[s].label }))],
            },
          ]}
        />
      </div>
      {notSending && <p className="text-sm text-muted-foreground">{notSending}</p>}
      {subscribers.length === 0 ? (
        q || status ? (
          <EmptyState title="No subscribers match" description="Try another search or status." />
        ) : (
          <EmptyState
            title="No subscribers yet"
            description="People subscribe on your portal's changelog, or your app adds them with the API (changelogSubscribers.add)."
          />
        )
      ) : (
        <div className="-mx-3 shrink-0 overflow-x-auto px-1 @min-[48rem]/app:-mx-4 @min-[48rem]/app:px-2">
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-muted-foreground max-md:hidden">
              <tr className="[&>th]:px-3 [&>th]:pb-2 [&>th]:font-medium">
                <th scope="col">Email</th>
                <th scope="col">Status</th>
                <th scope="col" className="text-right">
                  Added
                </th>
                {admin && (
                  <th scope="col">
                    <span className="sr-only">Actions</span>
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {subscribers.map((subscriber) => (
                <tr key={subscriber.email} className="border-t align-middle max-md:first:border-t-0 [&>td]:px-3 [&>td]:py-2">
                  <td className="max-w-0 min-w-48 md:max-w-none">
                    <div className="flex min-w-0 flex-col gap-0.5">
                      <span className="truncate font-medium" title={subscriber.email}>
                        {subscriber.email}
                      </span>
                      {subscriber.user && (
                        <Link href={`/app/${slug}/users/${encodeURIComponent(subscriber.user)}`} className="truncate text-xs text-muted-foreground hover:text-foreground hover:underline">
                          User {subscriber.user}
                        </Link>
                      )}
                    </div>
                  </td>
                  <td>
                    {/* A tint, a dot, sentence case (docs/design.md), like an article's state. */}
                    <Badge variant="outline" className={cn("border-transparent text-foreground", STATUS[subscriber.status].tint)}>
                      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", STATUS[subscriber.status].dot)} />
                      {STATUS[subscriber.status].label}
                    </Badge>
                  </td>
                  <td className="text-right whitespace-nowrap text-muted-foreground max-md:hidden">{timeAgo(new Date(subscriber.createdAt))}</td>
                  {admin && (
                    <td className="w-0 text-right">
                      {subscriber.removable && <RemoveSubscriberButton projectSlug={slug} email={subscriber.email} />}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(page > 1 || nextCursor) && (
        <PageNav back={page > 1 ? { href: href(page - 1), label: "Previous" } : null} on={nextCursor ? { href: href(page + 1), label: "Next" } : null}>
          {subscribers.length > 0 && `${count((page - 1) * PER_PAGE + 1)}–${count((page - 1) * PER_PAGE + subscribers.length)} of ${count(total)}`}
        </PageNav>
      )}
    </>
  );
}

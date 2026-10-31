import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UserColumnsMenu } from "@/components/user-columns-menu";
import { timeAgo } from "@/lib/format";
import type { PropertyValue } from "@/lib/user-properties";
import { getMembership, isAdminRole } from "@/server/membership";
import { propertiesInUse, propertyNames } from "@/server/operations/groups";
import { call } from "@/server/operations/run";
import { listUsers, USER_SORTS } from "@/server/operations/users";
import { getSession } from "@/server/session";

const PER_PAGE = 50;

const text = (value: PropertyValue) => (Array.isArray(value) ? value.join(", ") : String(value));

type Sort = (typeof USER_SORTS)[number];
/** The columns the table sorts by, and their headings. */
const COUNTS: { sort: Exclude<Sort, "name" | "lastSeen">; label: string; key: "posts" | "votes" | "conversations" }[] = [
  { sort: "posts", label: "Posts", key: "posts" },
  { sort: "votes", label: "Votes", key: "votes" },
  { sort: "conversations", label: "Conversations", key: "conversations" },
];

/**
 * The project's users (users.list) as a table: the people its app signs in or syncs, the properties the team picked
 * (Columns), and what they did here (posts, votes, conversations, last seen), sorted by any of those.
 */
export default async function UsersPage(props: PageProps<"/app/[project]/users">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  const [membership, session] = await Promise.all([getMembership(slug), getSession()]);
  if (!membership || !session) {
    notFound();
  }
  const { project } = membership;
  const q = typeof searchParams.q === "string" ? searchParams.q.trim().slice(0, 255) : "";
  const groups = await prisma.readerGroup.findMany({ where: { projectId: project.id }, orderBy: [{ name: "asc" }, { key: "asc" }], select: { key: true, name: true } });
  const group = groups.find((g) => g.key === searchParams.group)?.key;
  const page = Math.max(1, Number.parseInt(String(searchParams.page ?? "1"), 10) || 1);
  const sort: Sort = USER_SORTS.find((s) => s === searchParams.sort) ?? "name";
  const { userColumns } = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { userColumns: true } });
  const [{ users, nextCursor }, named, picked] = await Promise.all([
    call(
      listUsers,
      { actor: { kind: "user", userId: session.user.id }, projectId: project.id },
      { q: q || undefined, group, sort, limit: PER_PAGE, cursor: (page - 1) * PER_PAGE },
    ),
    propertyNames(project.id),
    propertiesInUse(project.id, userColumns),
  ]);
  // One no user has any more has nothing to show, and goes when Columns is next saved.
  const columns = picked;
  const properties = [...new Set([...named, ...columns])].sort();
  const names = new Map(groups.map((g) => [g.key, g.name]));
  const href = ({ to = page, by = sort }: { to?: number; by?: Sort }) => {
    const params = new URLSearchParams({ ...(q && { q }), ...(group && { group }), ...(by !== "name" && { sort: by }), ...(to > 1 && { page: String(to) }) });
    return params.size > 0 ? `?${params}` : `/app/${slug}/users`;
  };
  /** A column's heading: a link that sorts by it (from the first page), marked while it does. */
  const sortHeading = ({ by, label, className }: { by: Sort; label: string; className?: string }) => (
    <th key={by} scope="col" aria-sort={sort === by ? (by === "name" ? "ascending" : "descending") : undefined} className={className}>
      <Link href={href({ to: 1, by })} className={sort === by ? "text-foreground underline underline-offset-4" : "hover:text-foreground"}>
        {label}
      </Link>
    </th>
  );

  return (
    <>
      <PageHeader
        title="Users"
        // In the top bar from tablet width up, like other pages' controls.
        actions={
          <>
            <form role="search" className="flex w-full min-w-0 sm:w-56 lg:w-72">
              {group && <input type="hidden" name="group" value={group} />}
              {sort !== "name" && <input type="hidden" name="sort" value={sort} />}
              <Input type="search" name="q" defaultValue={q} placeholder="Name, email or id" aria-label="Search users" className="h-8" />
            </form>
            {isAdminRole(membership.role) && properties.length > 0 && <UserColumnsMenu projectSlug={slug} columns={columns} properties={properties} />}
            {groups.length > 0 && (
              <ListFilters
                filters={[
                  {
                    name: "group",
                    label: "Group",
                    // "*" can't be a group's key (a group named "All" has "all").
                    value: group ?? "*",
                    options: [{ value: "*", label: "All users" }, ...groups.map((g) => ({ value: g.key, label: g.name }))],
                  },
                ]}
              />
            )}
          </>
        }
      />

      {users.length === 0 ? (
        q || group ? (
          <EmptyState title="No users match" description="Try another search or group." />
        ) : (
          <EmptyState
            title="No users yet"
            description="Your app adds them when it signs people in with single sign-on, or sends them with the API (users.sync), with properties such as their plan."
            action={
              <a href="/docs/api#users.sync" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Syncing users
              </a>
            }
          />
        )
      ) : (
        <Card size="sm">
          <CardContent className="overflow-x-auto">
            {/* On phones, who they are and when they were last seen; the rest from tablet width up. */}
            <table className="w-full text-sm">
              <thead className="text-left text-xs font-medium text-muted-foreground">
                <tr className="[&>th]:px-2 [&>th]:pb-2 [&>th]:font-medium">
                  {sortHeading({ by: "name", label: "User" })}
                  {columns.map((name) => (
                    <th key={name} scope="col" className="hidden break-all md:table-cell">
                      {name}
                    </th>
                  ))}
                  {COUNTS.map((count) => sortHeading({ by: count.sort, label: count.label, className: "hidden text-right md:table-cell" }))}
                  {sortHeading({ by: "lastSeen", label: "Last seen", className: "text-right" })}
                </tr>
              </thead>
              <tbody>
                {users.map((user) => (
                  <tr key={user.id} className="border-t align-top [&>td]:px-2 [&>td]:py-2">
                    <td className="min-w-48">
                      <div className="flex items-start gap-2">
                        <Avatar className="size-8">
                          {user.avatar && <AvatarImage src={user.avatar} alt="" />}
                          <AvatarFallback>{user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                        </Avatar>
                        <div className="flex min-w-0 flex-col gap-0.5">
                          <span className="font-medium break-words">{user.name}</span>
                          <span className="text-xs break-all text-muted-foreground">{[user.email, `id ${user.id}`].filter(Boolean).join(" · ")}</span>
                          {user.groups.length > 0 && (
                            <span className="flex flex-wrap gap-1">
                              {user.groups.map((key) => (
                                <Badge key={key} variant="secondary">
                                  {names.get(key) ?? key}
                                </Badge>
                              ))}
                            </span>
                          )}
                        </div>
                      </div>
                    </td>
                    {columns.map((name) => (
                      <td key={name} className="hidden break-words md:table-cell">
                        {name in user.properties ? text(user.properties[name]!) : <span className="text-muted-foreground">–</span>}
                      </td>
                    ))}
                    {COUNTS.map((count) => (
                      <td key={count.key} className="hidden text-right tabular-nums md:table-cell">
                        {user.activity[count.key]}
                      </td>
                    ))}
                    <td className="text-right whitespace-nowrap text-muted-foreground">{user.activity.lastSeenAt ? timeAgo(user.activity.lastSeenAt) : "Never"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {(page > 1 || nextCursor) && (
        <nav aria-label="Pages" className="flex justify-between gap-2">
          {page > 1 ? (
            <Link href={href({ to: page - 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          {nextCursor && (
            <Link href={href({ to: page + 1 })} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Next
            </Link>
          )}
        </nav>
      )}
    </>
  );
}

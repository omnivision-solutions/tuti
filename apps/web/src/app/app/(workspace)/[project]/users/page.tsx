import { prisma } from "@tuti/db";
import { ArrowDownIcon, ArrowUpIcon, ArrowUpRightIcon, SearchIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";

import { CompaniesTable } from "@/components/companies-table";
import { EmptyState } from "@/components/empty-state";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { PageNav } from "@/components/page-nav";
import { SubNav } from "@/components/sub-nav";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { UserColumnsMenu } from "@/components/user-columns-menu";
import { initial, timeAgo } from "@/lib/format";
import { formatProperty, propertyHeadings, storedPropertyFormats } from "@/lib/property-formats";
import { getMembership, isAdminRole } from "@/server/membership";
import { propertiesInUse, propertyNames } from "@/server/operations/groups";
import { call } from "@/server/operations/run";
import { listUsers, USER_SORTS } from "@/server/operations/users";
import { getSession } from "@/server/session";
import { cn } from "@/lib/utils";

const PER_PAGE = 50;

type Sort = (typeof USER_SORTS)[number];
/** The columns the table sorts by, and their headings. */
const COUNTS: { sort: Exclude<Sort, "name" | "lastSeen">; label: string; key: "posts" | "votes" | "conversations" }[] = [
  { sort: "posts", label: "Posts", key: "posts" },
  { sort: "votes", label: "Votes", key: "votes" },
  { sort: "conversations", label: "Conversations", key: "conversations" },
];

/**
 * The project's users (users.list) as a table: the people its app signs in or syncs, the properties the team picked
 * (Columns), and what they did here (posts, votes, conversations, last seen), sorted by any of those; or (Companies)
 * the companies they're at, each opening its people.
 */
export default async function UsersPage(props: PageProps<"/app/[project]/users">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  const [membership, session] = await Promise.all([getMembership(slug), getSession()]);
  if (!membership || !session) {
    notFound();
  }
  const { project } = membership;
  const context = { actor: { kind: "user" as const, userId: session.user.id }, projectId: project.id };
  const formats = storedPropertyFormats(project.propertyFormats);
  const page = Math.max(1, Number.parseInt(String(searchParams.page ?? "1"), 10) || 1);
  /** People and Companies; People with how many there are once it's known (the list unfiltered). */
  const tabs = (people?: number) => (
    <SubNav
      label="Users views"
      items={[
        {
          title:
            people === undefined ? (
              "People"
            ) : (
              <>
                People <span className="text-muted-foreground tabular-nums">{people.toLocaleString("en-GB")}</span>
              </>
            ),
          href: `/app/${slug}/users`,
        },
        { title: "Companies", href: `/app/${slug}/users?view=companies` },
      ]}
      current={searchParams.view === "companies" ? `/app/${slug}/users?view=companies` : `/app/${slug}/users`}
    />
  );
  if (searchParams.view === "companies") {
    return (
      <>
        <PageHeader title="Users" description="The people who use your app, and what they asked for." />
        {tabs()}
        <CompaniesTable context={context} page={page} sort={searchParams.sort} formats={formats} />
      </>
    );
  }
  const q = typeof searchParams.q === "string" ? searchParams.q.trim().slice(0, 255) : "";
  // A company's people, from Companies (its name as it is).
  const company = typeof searchParams.company === "string" && searchParams.company ? searchParams.company.slice(0, 200) : undefined;
  const groups = await prisma.readerGroup.findMany({ where: { projectId: project.id }, orderBy: [{ name: "asc" }, { key: "asc" }], select: { key: true, name: true } });
  const group = groups.find((g) => g.key === searchParams.group)?.key;
  const sort: Sort = USER_SORTS.find((s) => s === searchParams.sort) ?? "name";
  const { userColumns } = await prisma.project.findUniqueOrThrow({ where: { id: project.id }, select: { userColumns: true } });
  const [{ users, nextCursor, total }, named, picked] = await Promise.all([
    call(listUsers, context, { q: q || undefined, group, company, sort, limit: PER_PAGE, cursor: (page - 1) * PER_PAGE }),
    // For Columns, which only owners and admins have.
    isAdminRole(membership.role) ? propertyNames(project.id) : [],
    propertiesInUse(project.id, userColumns),
  ]);
  // One no user has any more has nothing to show, and goes when Columns is next saved.
  const columns = picked;
  const properties = [...new Set([...named, ...columns])].sort();
  // The same in Columns and the table's headings, none reading as one of the table's own columns.
  const headings = propertyHeadings(formats, properties, ["User", "Groups", ...COUNTS.map((count) => count.label), "Last seen"]);
  const names = new Map(groups.map((g) => [g.key, g.name]));
  const href = ({ to = page, by = sort }: { to?: number; by?: Sort }) => {
    const params = new URLSearchParams({ ...(q && { q }), ...(group && { group }), ...(company && { company }), ...(by !== "name" && { sort: by }), ...(to > 1 && { page: String(to) }) });
    return params.size > 0 ? `?${params}` : `/app/${slug}/users`;
  };
  const count = (n: number) => n.toLocaleString("en-GB");
  /** Previous, which of them these are ("51–100 of 1,250"), and Next; below the table only. */
  const pages =
    (page > 1 || nextCursor) && (
      <PageNav back={page > 1 ? { href: href({ to: page - 1 }), label: "Previous" } : null} on={nextCursor ? { href: href({ to: page + 1 }), label: "Next" } : null}>
        {users.length > 0 && `${count((page - 1) * PER_PAGE + 1)}–${count((page - 1) * PER_PAGE + users.length)} of ${count(total)}`}
      </PageNav>
    );
  /** A column's heading: a link that sorts by it (from the first page), marked while it does. */
  const sortHeading = ({ by, label, className }: { by: Sort; label: string; className?: string }) => (
    <th key={by} scope="col" aria-sort={sort === by ? (by === "name" ? "ascending" : "descending") : undefined} className={className}>
      <Link href={href({ to: 1, by })} className={cn("inline-flex items-center gap-1", sort === by ? "text-foreground" : "hover:text-foreground")}>
        {label}
        {sort === by && (by === "name" ? <ArrowUpIcon aria-hidden className="size-3.5" /> : <ArrowDownIcon aria-hidden className="size-3.5" />)}
      </Link>
    </th>
  );

  return (
    <>
      <PageHeader
        title="Users"
        description={
          q || group || company
            ? "The people who use your app, and what they asked for."
            : `${count(total)} ${total === 1 ? "person uses" : "people use"} your app.`
        }
        // Users come from the app (single sign-on, or users.sync): how, in the docs.
        actions={
          <a href="/api/docs#users.sync" className={buttonVariants({ variant: "outline" })}>
            Sync from your app
            <ArrowUpRightIcon />
          </a>
        }
      />

      {/* The views, then (on the same line from laptop width up) finding someone, the columns and a group; above the
          table at every width, on phones too. */}
      <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:gap-6 lg:shadow-[inset_0_-1px_0_var(--color-border)]">
      <div className="min-w-0 lg:flex-1">{tabs()}</div>
      <div className="flex items-center gap-2 lg:pb-1.5">
            <form role="search" className="relative flex min-w-0 flex-1 sm:w-64 sm:flex-none">
              {group && <input type="hidden" name="group" value={group} />}
              {company && <input type="hidden" name="company" value={company} />}
              {sort !== "name" && <input type="hidden" name="sort" value={sort} />}
              <SearchIcon aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input type="search" name="q" defaultValue={q} placeholder="Name, email or id" aria-label="Search users" className="h-8 pl-8" />
            </form>
            {isAdminRole(membership.role) && properties.length > 0 && <span className="max-md:hidden"><UserColumnsMenu projectSlug={slug} columns={columns} properties={properties.map((name) => ({ name, label: headings.get(name)! }))} /></span>}
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
      </div>
      </div>
      {company && (
        <p className="text-sm break-words text-muted-foreground">
          Users at <span className="font-medium text-foreground">{company}</span> ·{" "}
          <Link href={`/app/${slug}/users`} className="underline underline-offset-4 hover:text-foreground">
            All users
          </Link>
        </p>
      )}
      {users.length === 0 ? (
        q || group || company ? (
          <EmptyState title="No users match" description="Try another search or group." />
        ) : (
          <EmptyState
            title="No users yet"
            description="Your app adds them when it signs people in with single sign-on, or sends them with the API (users.sync), with properties such as their plan."
            action={
              <a href="/api/docs#users.sync" className={buttonVariants({ variant: "outline", size: "sm" })}>
                Syncing users
              </a>
            }
          />
        )
      ) : (
        <>
          {/* The whole width (data-wide), for the team's columns. */}
          <Card size="sm" data-wide>
            <CardContent className="overflow-x-auto">
              {/* On phones, who they are (no id) and when they were last seen; the rest from tablet width up. */}
              <table className="w-full text-sm">
                {/* Phones: no header row (a row is who they are, their company and when they were seen), so no sort links in
                    the tab order that can't be seen. */}
                <thead className="text-left text-xs text-muted-foreground max-md:hidden">
                  <tr className="[&>th]:px-3 [&>th]:pb-2.5 [&>th]:text-xs [&>th]:font-semibold [&>th]:tracking-[0.04em] [&>th]:uppercase">
                    {sortHeading({ by: "name", label: "User" })}
                    {columns.map((name) => (
                      <th key={name} scope="col" className="hidden break-all md:table-cell">
                        {headings.get(name)}
                      </th>
                    ))}
                    {groups.length > 0 && (
                      <th scope="col" className="hidden md:table-cell">
                        Groups
                      </th>
                    )}
                    {COUNTS.map((count) => sortHeading({ by: count.sort, label: count.label, className: "hidden text-right md:table-cell" }))}
                    {sortHeading({ by: "lastSeen", label: "Last seen", className: "hidden text-right md:table-cell" })}
                  </tr>
                </thead>
                <tbody>
                  {users.map((user) => (
                    <tr key={user.id} className="border-t align-middle max-md:first:border-t-0 transition-colors hover:bg-muted/50 [&>td]:px-3 [&>td]:py-2">
                      <td className="max-w-0 min-w-48 md:max-w-none">
                        <div className="flex items-center gap-3">
                          <Avatar className="size-7">
                            {user.avatar && <AvatarImage src={user.avatar} alt="" />}
                            <AvatarFallback>{initial(user.name)}</AvatarFallback>
                          </Avatar>
                          <div className="flex min-w-0 flex-col gap-0.5">
                            <Link href={`/app/${slug}/users/${encodeURIComponent(user.id)}`} className="truncate font-medium hover:underline">
                              {user.name}
                            </Link>
                            {/* Cut short, in full on hover; their id is on their page (and found by the search). */}
                            <span className="truncate text-xs text-muted-foreground" title={user.email ?? undefined}>
                              {/* No address: their id instead, from tablet width up (on phones the row keeps to one line each). */}
                              {user.email ?? <span className="max-md:hidden">id {user.id}</span>}
                            </span>
                            {/* On phones, where the table is who they are, their company and when they were last seen too. */}
                            <span className="truncate text-xs text-muted-foreground md:hidden">
                              {[typeof user.properties.company === "string" ? user.properties.company : null, user.activity.lastSeenAt ? `seen ${timeAgo(user.activity.lastSeenAt)}` : "never seen"]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </div>
                        </div>
                      </td>
                      {columns.map((name) => (
                        <td key={name} className="hidden break-words md:table-cell">
                          {Object.hasOwn(user.properties, name) ? formatProperty(formats, name, user.properties[name]!) : <span className="text-muted-foreground">–</span>}
                        </td>
                      ))}
                      {groups.length > 0 && (
                        <td className="hidden md:table-cell">
                          {/* The first group, and how many more (all of them on hover, and on their page). */}
                          <span className="flex flex-wrap items-center gap-1" title={user.groups.map((key) => names.get(key) ?? key).join(", ")}>
                            {user.groups.slice(0, 1).map((key) => (
                              <Badge key={key} variant="secondary" className="h-auto max-w-full font-normal whitespace-normal break-words">
                                {names.get(key) ?? key}
                              </Badge>
                            ))}
                            {user.groups.length > 1 && (
                              // The rest on hover, and on their page (where every group is listed) for touch and the keyboard:
                              // out of the tab order, as their name's link goes there too.
                              <Link
                                href={`/app/${slug}/users/${encodeURIComponent(user.id)}`}
                                tabIndex={-1}
                                className="text-xs text-muted-foreground hover:text-foreground hover:underline"
                              >
                                +{user.groups.length - 1}
                                <span className="sr-only"> more: {user.groups.slice(1).map((key) => names.get(key) ?? key).join(", ")}</span>
                              </Link>
                            )}
                          </span>
                        </td>
                      )}
                      {COUNTS.map((count) => (
                        // None yet a muted dash, so the numbers that are there stand out.
                        <td key={count.key} className="hidden text-right tabular-nums md:table-cell">
                          {user.activity[count.key] === 0 ? (
                            // As a property they don't have.
                            <span className="text-muted-foreground">–</span>
                          ) : (
                            user.activity[count.key]
                          )}
                        </td>
                      ))}
                      <td className="hidden text-right whitespace-nowrap text-muted-foreground md:table-cell">{user.activity.lastSeenAt ? timeAgo(user.activity.lastSeenAt) : "Never"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </>
      )}

      {pages}
    </>
  );
}

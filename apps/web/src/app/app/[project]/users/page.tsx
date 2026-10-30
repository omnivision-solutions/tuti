import { prisma } from "@tuti/db";
import Link from "next/link";
import { notFound } from "next/navigation";

import { EmptyState } from "@/components/empty-state";
import { ItemList, ItemRow } from "@/components/item-list";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/page-header";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { PropertyValue } from "@/lib/user-properties";
import { getMembership } from "@/server/membership";
import { call } from "@/server/operations/run";
import { listUsers } from "@/server/operations/users";
import { getSession } from "@/server/session";

const PER_PAGE = 50;

const text = (value: PropertyValue) => (Array.isArray(value) ? value.join(", ") : String(value));

/** The project's users (users.list): the people its app signs in or syncs, with their properties and groups. */
export default async function UsersPage(props: PageProps<"/app/[project]/users">) {
  const { project: slug } = await props.params;
  const searchParams = await props.searchParams;
  const [membership, session] = await Promise.all([getMembership(slug), getSession()]);
  if (!membership || !session) {
    notFound();
  }
  const { project } = membership;
  const q = typeof searchParams.q === "string" ? searchParams.q.trim().slice(0, 200) : "";
  const groups = await prisma.readerGroup.findMany({ where: { projectId: project.id }, orderBy: [{ name: "asc" }, { key: "asc" }], select: { key: true, name: true } });
  const group = groups.find((g) => g.key === searchParams.group)?.key;
  const page = Math.max(1, Number.parseInt(String(searchParams.page ?? "1"), 10) || 1);
  const { users, nextCursor } = await call(
    listUsers,
    { actor: { kind: "user", userId: session.user.id }, projectId: project.id },
    { q: q || undefined, group, limit: PER_PAGE, cursor: (page - 1) * PER_PAGE },
  );
  const names = new Map(groups.map((g) => [g.key, g.name]));
  const pageHref = (n: number) => {
    const params = new URLSearchParams({ ...(q && { q }), ...(group && { group }), ...(n > 1 && { page: String(n) }) });
    return params.size > 0 ? `?${params}` : `/app/${slug}/users`;
  };

  return (
    <>
      <PageHeader
        title="Users"
        // In the top bar from tablet width up, like other pages' controls.
        actions={
          <>
            <form role="search" className="flex w-full min-w-0 sm:w-56 lg:w-72">
              {group && <input type="hidden" name="group" value={group} />}
              <Input type="search" name="q" defaultValue={q} placeholder="Name, email or id" aria-label="Search users" className="h-8" />
            </form>
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
          <CardContent>
            <ItemList>
              {users.map((user) => {
                const properties = Object.entries(user.properties);
                return (
                  <ItemRow
                    key={user.id}
                    leading={
                      <Avatar className="size-8">
                        {user.avatar && <AvatarImage src={user.avatar} alt="" />}
                        <AvatarFallback>{user.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                      </Avatar>
                    }
                    title={user.name}
                    badges={user.groups.map((key) => (
                      <Badge key={key} variant="secondary">
                        {names.get(key) ?? key}
                      </Badge>
                    ))}
                    meta={
                      <>
                        <span className="break-all">{[user.email, `id ${user.id}`].filter(Boolean).join(" · ")}</span>
                        {properties.length > 0 && (
                          <dl aria-label="Properties" className="mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                            {properties.map(([name, value]) => (
                              <div key={name} className="flex min-w-0 gap-1">
                                <dt className="shrink-0">{name}:</dt>
                                <dd className="min-w-0 break-words text-foreground">{text(value)}</dd>
                              </div>
                            ))}
                          </dl>
                        )}
                      </>
                    }
                  />
                );
              })}
            </ItemList>
          </CardContent>
        </Card>
      )}

      {(page > 1 || nextCursor) && (
        <nav aria-label="Pages" className="flex justify-between gap-2">
          {page > 1 ? (
            <Link href={pageHref(page - 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Previous
            </Link>
          ) : (
            <span />
          )}
          {nextCursor && (
            <Link href={pageHref(page + 1)} className={buttonVariants({ variant: "outline", size: "sm" })}>
              Next
            </Link>
          )}
        </nav>
      )}
    </>
  );
}

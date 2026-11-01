import { cn } from "cn";
import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { askingTotal } from "@/lib/format";
import { propertyLabel, type PropertyFormats } from "@/lib/property-formats";
import { call } from "@/server/operations/run";
import { COMPANY_SORTS, listCompanies } from "@/server/operations/users";

const PER_PAGE = 50;

type Sort = (typeof COMPANY_SORTS)[number];

/**
 * Users' Companies (companies.list): each company its users are at, how many, their votes and Who's asking's total over
 * them, the most first of the heading picked (users to start with); a company opens its users.
 */
export async function CompaniesTable({
  context,
  page,
  sort: asked,
  formats,
}: {
  context: Parameters<typeof call>[1];
  page: number;
  /** As the address has it: one companies.list doesn't know is by users. */
  sort: unknown;
  formats: PropertyFormats;
}) {
  const sort: Sort = COMPANY_SORTS.find((s) => s === asked) ?? "users";
  const { companies, property, nextCursor } = await call(listCompanies, context, { sort, limit: PER_PAGE, cursor: (page - 1) * PER_PAGE });
  if (companies.length === 0 && page === 1) {
    return (
      <EmptyState
        title="No companies yet"
        description="Your users' company property puts them here, from your app's sign-in token or the API (users.sync)."
        action={
          <a href="/docs/api#users.sync" className={buttonVariants({ variant: "outline", size: "sm" })}>
            Syncing users
          </a>
        }
      />
    );
  }
  // On phones, the company and one number (Who's asking's total when there is one, else its users); the rest from tablet width up.
  const wide = (column: Sort) => (column === "votes" || (column === "users" && property) ? "hidden md:table-cell" : undefined);
  const href = ({ to = page, by = sort }: { to?: number; by?: Sort }) =>
    `?${new URLSearchParams({ view: "companies", ...(by !== "users" && { sort: by }), ...(to > 1 && { page: String(to) }) })}`;
  /** A column's heading: a link that sorts by it, the most first (from the first page), marked while it does. */
  const sortHeading = (by: Sort, label: string) => (
    <th scope="col" aria-sort={sort === by ? "descending" : undefined} className={cn("text-right break-all", wide(by))}>
      <Link href={href({ to: 1, by })} className={sort === by ? "text-foreground underline underline-offset-4" : "hover:text-foreground"}>
        {label}
      </Link>
    </th>
  );

  return (
    <>
      <Card size="sm">
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:pb-2 [&>th]:font-medium">
                <th scope="col">Company</th>
                {sortHeading("users", "Users")}
                {sortHeading("votes", "Votes")}
                {property && sortHeading("total", propertyLabel(formats, property))}
              </tr>
            </thead>
            <tbody>
              {companies.map((company) => (
                <tr key={company.name} className="border-t [&>td]:px-2 [&>td]:py-2">
                  <td className="min-w-40">
                    <Link href={`?${new URLSearchParams({ company: company.name })}`} className="font-medium break-words hover:underline">
                      {company.name}
                    </Link>
                  </td>
                  <td className={cn("text-right tabular-nums", wide("users"))}>{company.users}</td>
                  <td className={cn("text-right tabular-nums", wide("votes"))}>{company.votes}</td>
                  {property && <td className="text-right tabular-nums">{company.total === null ? <span className="text-muted-foreground">–</span> : askingTotal(company.total, property, formats)}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
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

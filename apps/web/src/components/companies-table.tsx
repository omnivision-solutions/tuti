import Link from "next/link";

import { EmptyState } from "@/components/empty-state";
import { buttonVariants } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { askingTotal } from "@/lib/format";
import { propertyLabel, type PropertyFormats } from "@/lib/property-formats";
import { call } from "@/server/operations/run";
import { listCompanies } from "@/server/operations/users";

const PER_PAGE = 50;

/**
 * Users' Companies (companies.list): each company its users are at, how many, their votes and Who's asking's total over
 * them, the most users first; a company opens its users.
 */
export async function CompaniesTable({ context, page, formats }: { context: Parameters<typeof call>[1]; page: number; formats: PropertyFormats }) {
  const { companies, property, nextCursor } = await call(listCompanies, context, { limit: PER_PAGE, cursor: (page - 1) * PER_PAGE });
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
  const pageHref = (n: number) => `?${new URLSearchParams({ view: "companies", ...(n > 1 && { page: String(n) }) })}`;

  return (
    <>
      <Card size="sm">
        <CardContent className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-xs font-medium text-muted-foreground">
              <tr className="[&>th]:px-2 [&>th]:pb-2 [&>th]:font-medium">
                <th scope="col">Company</th>
                <th scope="col" className="text-right">
                  Users
                </th>
                <th scope="col" className="text-right">
                  Votes
                </th>
                {property && (
                  <th scope="col" className="text-right break-all">
                    {propertyLabel(formats, property)}
                  </th>
                )}
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
                  <td className="text-right tabular-nums">{company.users}</td>
                  <td className="text-right tabular-nums">{company.votes}</td>
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

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";

import { PageHeader } from "@/components/page-header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

import { CUSTOMIZE_GROUPS } from "./sections";

/** Customize's menu: each section opens beside a preview of the portal. */
export default async function CustomizePage(props: PageProps<"/app/[project]/customize">) {
  const { project: slug } = await props.params;
  return (
    <>
      <PageHeader title="Customize" description="How your portal and docs look. Each part opens beside a preview of your portal." />
      {CUSTOMIZE_GROUPS.map((group) => (
        <Card key={group.title}>
          <CardHeader>
            <CardTitle>{group.title}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="-mx-2 flex flex-col">
              {group.sections.map(({ slug: section, title, description, icon: Icon }) => (
                <li key={section}>
                  <Link
                    href={`/app/${slug}/customize/${section}`}
                    className="flex items-center gap-3 rounded-lg px-2 py-2.5 transition-colors hover:bg-accent"
                  >
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="flex min-w-0 flex-col">
                      <span className="text-sm font-medium">{title}</span>
                      <span className="text-sm text-muted-foreground">{description}</span>
                    </span>
                    <ChevronRightIcon className="ml-auto size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>
      ))}
    </>
  );
}

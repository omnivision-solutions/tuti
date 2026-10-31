import { SubNav } from "@/components/sub-nav";

/** Docs' two tabs under its header: the content, and what readers did with it. */
export function DocsSections({ projectSlug }: { projectSlug: string }) {
  const base = `/app/${projectSlug}/docs`;
  return (
    <SubNav
      label="Docs sections"
      items={[
        { href: base, title: "Content" },
        { href: `${base}/insights`, title: "Insights" },
      ]}
    />
  );
}

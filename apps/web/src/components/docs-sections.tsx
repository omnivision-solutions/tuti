import { SubNav } from "@/components/sub-nav";

/** Docs' two tabs under its header: the content, and what readers did with it. */
export function DocsSections({ projectSlug, current }: { projectSlug: string; current: "content" | "insights" }) {
  const base = `/app/${projectSlug}/docs`;
  return (
    <SubNav
      label="Docs sections"
      current={current === "content" ? base : `${base}/insights`}
      items={[
        { href: base, title: "Content" },
        { href: `${base}/insights`, title: "Insights" },
      ]}
    />
  );
}

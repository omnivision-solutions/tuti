import { type DiffLine, diffLines } from "@/lib/line-diff";

/** Paragraphs from diffLines: removed ones struck through, added ones highlighted. */
export function DiffLines({ lines }: { lines: DiffLine[] }) {
  return lines.map((line, index) =>
    line.kind === "same" ? (
      <p key={index} className="px-2 text-muted-foreground">
        {line.text}
      </p>
    ) : line.kind === "removed" ? (
      <del key={index} className="block rounded-md bg-destructive/10 px-2 text-destructive">
        {line.text}
      </del>
    ) : (
      <ins key={index} className="block rounded-md bg-soft px-2 text-soft-foreground no-underline">
        {line.text}
      </ins>
    ),
  );
}

type ArticleVersion = { title: string; body: string; collection: { name: string } | null };

/** What changed from one version of an article to another: its title, collection and paragraphs. `same` says there's nothing. */
export function ArticleDiff({ before, after, same }: { before: ArticleVersion; after: ArticleVersion; same: string }) {
  const lines = diffLines(before.body, after.body);
  const fields = [
    { label: "Title", before: before.title, after: after.title },
    { label: "Collection", before: before.collection?.name ?? "None", after: after.collection?.name ?? "None" },
  ].filter((field) => field.before !== field.after);
  if (fields.length === 0 && lines.every((line) => line.kind === "same")) {
    return <p className="text-sm text-muted-foreground">{same}</p>;
  }
  return (
    <div className="flex flex-col gap-1 text-sm break-words">
      {fields.map((field) => (
        <p key={field.label} className="mb-2">
          {field.label}: <del className="bg-destructive/10 text-destructive">{field.before}</del>{" "}
          <ins className="bg-soft text-soft-foreground no-underline">{field.after}</ins>
        </p>
      ))}
      <DiffLines lines={lines} />
    </div>
  );
}

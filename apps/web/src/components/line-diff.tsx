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

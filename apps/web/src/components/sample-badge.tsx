import { Badge } from "@/components/ui/badge";

/** Sample content's label (server/sample-content.ts), wherever it's shown. */
export function SampleBadge() {
  return (
    <Badge variant="outline" className="border-dashed text-muted-foreground">
      Sample
    </Badge>
  );
}

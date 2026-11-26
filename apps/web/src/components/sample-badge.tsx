"use client";

import { useTranslations } from "next-intl";

import { Badge } from "@/components/ui/badge";

/** Sample content's label (server/sample-content.ts), wherever it's shown. */
export function SampleBadge() {
  return (
    <Badge variant="outline" className="border-dashed text-muted-foreground">
      {useTranslations("feedback")("sample")}
    </Badge>
  );
}

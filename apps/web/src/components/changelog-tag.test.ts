import type { ChangelogTag } from "@tuti/db";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { expect, test } from "vitest";

import { badgeVariants } from "@/components/ui/badge";

import { PICKED_CHIP, TAG_LABELS, TAG_VARIANTS, TagBadge } from "./changelog-tag";

test("Breaking is the destructive colour, the other tags neutral", () => {
  expect(TAG_VARIANTS).toEqual({ NEW: "secondary", IMPROVED: "secondary", FIXED: "secondary", BREAKING: "destructive" });
  expect(renderToString(createElement(TagBadge, { tag: "BREAKING" }))).toContain("text-destructive");
});

test("a tag picked in the editor has the colours of its badge on the portal", () => {
  for (const tag of Object.keys(TAG_LABELS) as ChangelogTag[]) {
    const badge = badgeVariants({ variant: TAG_VARIANTS[tag] }).split(" ");
    const picked = PICKED_CHIP[TAG_VARIANTS[tag]]
      .split(" ")
      .map((name) => name.replace("has-checked:", ""))
      .filter((name) => name !== "border-transparent");
    expect(badge, tag).toEqual(expect.arrayContaining(picked));
  }
});

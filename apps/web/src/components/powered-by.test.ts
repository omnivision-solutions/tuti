import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, test } from "vitest";

import { TutiMark } from "@tuti/ui/tuti-logo";

import { EmptyState } from "@/components/empty-state";
import { PoweredByTuti } from "@/components/portal-look";

describe("TutiMark", () => {
  it("is in Tuti's green and orange by default", () => {
    const svg = renderToStaticMarkup(createElement(TutiMark));
    expect(svg).toContain("fill-primary");
    expect(svg).toContain("#f26b1d");
  });

  it("is in the text's colour alone when mono, so it sits beside any team's colours", () => {
    const svg = renderToStaticMarkup(createElement(TutiMark, { mono: true }));
    expect(svg).not.toContain("fill-primary");
    expect(svg).not.toContain("#f26b1d");
    expect(svg).toContain("fill-current");
  });

  it("is mono in a portal's Powered by tuti badge", () => {
    const badge = renderToStaticMarkup(createElement(PoweredByTuti));
    expect(badge).toContain("Powered by");
    expect(badge).not.toContain("#f26b1d");
  });
});

test("an empty state's mark is grey too: portals show them, beside the team's colours", () => {
  expect(renderToStaticMarkup(createElement(EmptyState, { title: "No ideas yet" }))).not.toContain("#f26b1d");
});

test("every Tuti mark on a portal's pages is grey (sign-in's Continue with your Tuti account too)", () => {
  const portal = join(__dirname, "../app/portal");
  const files = readdirSync(portal, { recursive: true, encoding: "utf8" }).filter((file) => file.endsWith(".tsx"));
  const marks = files.flatMap((file) => readFileSync(join(portal, file), "utf8").match(/<TutiMark\b[^>]*>/g) ?? []);
  expect(marks.length).toBeGreaterThan(0);
  expect(marks.filter((mark) => !/\bmono\b/.test(mark))).toEqual([]);
});

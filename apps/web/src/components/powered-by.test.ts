import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { TutiMark } from "@tuti/ui/tuti-logo";

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

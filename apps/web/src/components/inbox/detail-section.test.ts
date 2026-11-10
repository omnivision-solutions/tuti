import { renderToStaticMarkup } from "react-dom/server";
import { UserIcon } from "lucide-react";
import { describe, expect, it } from "vitest";
import { DetailSection } from "./detail-section";

describe("inbox detail sections", () => {
  it("folds background context by default while keeping its count in the summary", () => {
    const html = renderToStaticMarkup(DetailSection({ title: "Customer details", count: 4, icon: UserIcon, children: "Customer context" }));
    expect(html).toMatch(/<details[^>]*>/);
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toMatch(/<summary[^>]*>.*Customer details.*<small[^>]*>4<\/small>.*<\/summary>/);
  });
  it("opens triage work explicitly, including empty counts", () => {
    const html = renderToStaticMarkup(DetailSection({ title: "Linked posts", count: 0, icon: UserIcon, open: true, children: "No linked posts" }));
    expect(html).toMatch(/<details[^>]* open=""/);
    expect(html).toMatch(/<small[^>]*>0<\/small>/);
  });
});

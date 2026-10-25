import { describe, expect, it } from "vitest";

import { allCollections } from "./docs-level-above";

describe("allCollections", () => {
  const guides = { slug: "guides", name: "Guides" };
  const api = { slug: "api", name: "API" };

  it("is the docs' home without tabs", () => {
    expect(allCollections({ home: null, tabs: [] }, null)).toEqual({ href: "/docs", label: "All collections" });
  });

  it("is the tab's page with two tabs or more (the first's is /docs)", () => {
    expect(allCollections({ home: "guides", tabs: [guides, api] }, api)).toEqual({ href: "/docs/api", label: "API" });
    expect(allCollections({ home: "guides", tabs: [guides, api] }, guides)).toEqual({ href: "/docs", label: "Guides" });
  });

  it("is the docs' home for a reader who sees one tab, even one that isn't the first", () => {
    expect(allCollections({ home: "guides", tabs: [api] }, api)).toEqual({ href: "/docs", label: "All collections" });
  });
});

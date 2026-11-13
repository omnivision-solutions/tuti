import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("lets a variant's border replace the base's transparent one, so link buttons show it", () => {
    expect(buttonVariants()).toContain("border-primary");
    expect(buttonVariants({ variant: "outline" })).toContain("border-input");
    expect(buttonVariants().split(" ")).not.toContain("border-transparent");
    expect(buttonVariants({ variant: "outline" }).split(" ")).not.toContain("border-transparent");
  });

  it("gives an outline button the secondary's grey fill without an edge on the portal, the admin's outline elsewhere", () => {
    const classes = buttonVariants({ variant: "outline" }).split(" ");
    expect(classes).toEqual(expect.arrayContaining(["border-input", "bg-card", "portal:border-transparent", "portal:bg-secondary", "portal:shadow-none"]));
    // A caller's own fill for the portal replaces it.
    const own = buttonVariants({ variant: "outline", className: "bg-soft portal:bg-soft" }).split(" ");
    expect(own).toContain("portal:bg-soft");
    expect(own).not.toContain("portal:bg-secondary");
  });

  it("lets a caller's classes replace the variant's", () => {
    const classes = buttonVariants({ variant: "outline", className: "border-primary/60 text-base" }).split(" ");
    expect(classes).toContain("border-primary/60");
    expect(classes).not.toContain("border-input");
    expect(classes).toContain("text-base");
    expect(classes).not.toContain("text-sm");
  });
});

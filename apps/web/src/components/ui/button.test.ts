import { describe, expect, it } from "vitest";

import { buttonVariants } from "./button";

describe("buttonVariants", () => {
  it("lets a variant's border replace the base's transparent one, so link buttons show it", () => {
    expect(buttonVariants()).toContain("border-primary");
    expect(buttonVariants({ variant: "outline" })).toContain("border-input");
    expect(buttonVariants()).not.toContain("border-transparent");
    expect(buttonVariants({ variant: "outline" })).not.toContain("border-transparent");
  });

  it("lets a caller's classes replace the variant's", () => {
    const classes = buttonVariants({ variant: "outline", className: "border-primary/60 text-base" }).split(" ");
    expect(classes).toContain("border-primary/60");
    expect(classes).not.toContain("border-input");
    expect(classes).toContain("text-base");
    expect(classes).not.toContain("text-sm");
  });
});

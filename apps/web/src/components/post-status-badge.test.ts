import { readFileSync } from "node:fs";

import type { PostStatus } from "@tuti/db";
import { expect, test } from "vitest";

import { STATUS_STYLES } from "./post-status-badge";

const css = readFileSync(new URL("../app/globals.css", import.meta.url), "utf8");
const statuses = Object.keys(STATUS_STYLES) as PostStatus[];

/** A theme's status colours, as oklch [lightness, chroma, hue], read from its block in globals.css. */
function colours(theme: ":root" | ".dark") {
  const start = css.indexOf(`\n${theme}`);
  const block = css.slice(start, css.indexOf("}", start));
  return Object.fromEntries(
    statuses.map((status) => {
      const token = STATUS_STYLES[status].dot.replace("bg-", "--");
      const match = block.match(new RegExp(`${token}: oklch\\(([\\d.]+) ([\\d.]+) ([\\d.]+)\\)`));
      expect(match, `${token} in ${theme}`).not.toBeNull();
      return [status, match!.slice(1).map(Number) as [number, number, number]];
    }),
  );
}

test.each([":root", ".dark"] as const)("every status's dot has a colour of its own (%s): a hue apart, or for the greys a shade apart", (theme) => {
  const byStatus = colours(theme);
  for (const [i, a] of statuses.entries()) {
    for (const b of statuses.slice(i + 1)) {
      const [la, ca, ha] = byStatus[a]!;
      const [lb, cb, hb] = byStatus[b]!;
      const grey = ca < 0.05 || cb < 0.05;
      const apart = grey ? Math.abs(la - lb) >= 0.1 || Math.abs(ca - cb) >= 0.05 : Math.min(Math.abs(ha - hb), 360 - Math.abs(ha - hb)) >= 25;
      expect(apart, `${a} and ${b} in ${theme}`).toBe(true);
    }
  }
});

test("only Completed's badge is green: the statuses before it are quiet", () => {
  expect(statuses.filter((status) => STATUS_STYLES[status].badge === "default" || STATUS_STYLES[status].badge === "soft")).toEqual(["COMPLETED"]);
});

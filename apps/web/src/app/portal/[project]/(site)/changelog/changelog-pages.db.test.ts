import { prisma } from "@tuti/db";
import { isValidElement, type ReactNode } from "react";
import { beforeEach, expect, test } from "vitest";

import { actAs, createProject, signUp } from "@/test/helpers";

import ChangelogPage from "./page";
import OlderChangelogPage from "./page/[page]/page";

/** The changelog a page at a time: /changelog, then /changelog/page/2 and on. */

let project: Awaited<ReturnType<typeof createProject>>;

beforeEach(async () => {
  project = await createProject(await signUp());
  actAs(null);
  // 45 entries: two full pages of 20, and 5 on the third.
  await prisma.changelogEntry.createMany({
    data: Array.from({ length: 45 }, (_, i) => ({
      projectId: project.id,
      number: i + 1,
      title: `Entry ${i + 1}`,
      publishedAt: new Date(Date.UTC(2026, 0, 1, 0, i + 1)),
    })),
  });
});

/** A page's entries (first and last number) and where "Newer entries" and "Older entries" go; or "308 <where>", "404". */
async function changelog(page?: string) {
  const params = Promise.resolve({ project: project.slug, ...(page !== undefined && { page }) });
  const rendered = await (page === undefined ? ChangelogPage({ params } as never) : OlderChangelogPage({ params } as never)).then(
    (node) => node as ReactNode,
    (error: { digest?: string }) => {
      const redirect = error.digest?.match(/^NEXT_REDIRECT;\w+;([^;]+);(\d+);/);
      return redirect ? `${redirect[2]} ${redirect[1]}` : error.digest === "NEXT_HTTP_ERROR_FALLBACK;404" ? "404" : Promise.reject(error);
    },
  );
  if (typeof rendered === "string") {
    return rendered;
  }
  const entries: number[] = [];
  const links: Record<string, string> = {};
  const walk = (node: ReactNode): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
    } else if (isValidElement<{ children?: ReactNode; entry?: { number: number }; href?: string }>(node)) {
      if (node.props.entry) {
        entries.push(node.props.entry.number);
      }
      if (node.props.href && typeof node.props.children === "string") {
        links[node.props.children] = node.props.href;
      }
      walk(node.props.children);
    }
  };
  walk(rendered);
  return { entries: `${entries[0]}–${entries.at(-1)}`, ...links };
}

test("older entries are at /changelog/page/<n>; the links between pages follow", async () => {
  expect(await changelog()).toEqual({ entries: "45–26", "Older entries": "/changelog/page/2" });
  expect(await changelog("2")).toEqual({ entries: "25–6", "Newer entries": "/changelog", "Older entries": "/changelog/page/3" });
  expect(await changelog("3")).toEqual({ entries: "5–1", "Newer entries": "/changelog/page/2" });
});

test("page 1 is /changelog; past the last page, or not a page number, it's a 404", async () => {
  expect(await changelog("1")).toBe("308 /changelog");
  for (const page of ["4", "0", "02", "-1", "2.5", "two", "99999"]) {
    expect(await changelog(page)).toBe("404");
  }
});

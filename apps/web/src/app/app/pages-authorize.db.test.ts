import { readdirSync } from "node:fs";

import { isValidElement } from "react";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";

import { actAs, addMember, createProject, signUp, type TestUser } from "@/test/helpers";

import FeedbackPage from "./[project]/feedback/page";

/**
 * Every page under /app checks who's asking itself, before it loads anything: a request can render a page without the
 * layouts above it, so a layout's check (signed in, on the team, an admin) never stands in for the page's own.
 */

type Page = (props: unknown) => unknown;

/** Under a layout for owners and admins only. */
const adminOnly = (file: string) => /^\[project\]\/(customize|settings\/\(admin\))\//.test(file);

const pages = readdirSync(import.meta.dirname, { recursive: true, encoding: "utf8" })
  .filter((file) => file.endsWith("page.tsx"))
  .sort();

let project: Awaited<ReturnType<typeof createProject>>;
let outsider: TestUser;
let member: TestUser;

beforeAll(async () => {
  project = await createProject(await signUp("Owner"));
  outsider = await signUp("Outsider");
  await createProject(outsider);
  member = await addMember(project.id, "MEMBER");
});

// AI and Autopilot on, so their pages get as far as their checks. Nothing here gets past one to call it.
beforeEach(() => vi.stubEnv("OPENAI_API_KEY", "sk-or-placeholder"));

/** Any params a page here takes; the project is a real one, so a page that doesn't check would find its data. */
const props = () => ({
  params: Promise.resolve({ project: project.slug, id: "1", number: "1", slug: "a", collection: "a", tab: "a", user: "a" }),
  searchParams: Promise.resolve({}),
});

/** The page, and a component it hands everything to (it may check there), as far as the first thing it shows. */
async function render(page: Page): Promise<unknown> {
  let node = await page(props());
  while (isValidElement(node) && typeof node.type === "function") {
    node = await (node.type as Page)(node.props);
  }
  return node;
}

/** What the page did: "refused" for not found or a redirect; anything it showed fails the test. */
async function outcome(file: string) {
  const { default: page } = (await import(`./${file}`)) as { default: Page };
  const thrown = await render(page).then(
    () => new Error(`${file} rendered`),
    (error: unknown) => error,
  );
  const digest = (thrown as { digest?: unknown }).digest;
  if (typeof digest === "string" && /^NEXT_(HTTP_ERROR_FALLBACK;404|REDIRECT;)/.test(digest)) {
    return "refused";
  }
  throw thrown;
}

describe("signed out", () => {
  test.each(pages)("%s", async (file) => {
    actAs(null);
    expect(await outcome(file)).toBe("refused");
  });
});

describe("signed in, on another team", () => {
  test.each(pages.filter((file) => file.startsWith("[project]/")))("%s", async (file) => {
    actAs(outsider);
    expect(await outcome(file)).toBe("refused");
  });
});

describe("a member, on an admins' page", () => {
  test.each(pages.filter(adminOnly))("%s", async (file) => {
    actAs(member);
    expect(await outcome(file)).toBe("refused");
  });
});

test("Feedback shows the team's posts to the team, and is not found for anyone else", async () => {
  actAs(member);
  await expect(FeedbackPage(props() as never)).resolves.toBeTruthy();
  for (const who of [null, outsider]) {
    actAs(who);
    await expect(FeedbackPage(props() as never)).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  }
});

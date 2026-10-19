import { prisma } from "@tuti/db";
import { beforeEach, expect, test } from "vitest";

import { GET as startContinue } from "@/app/portal/[project]/continue/route";
import { continueToPortal } from "@/server/portal-handoff";
import { actAs, createProject, redirectTarget, signUp, type TestUser } from "@/test/helpers";

import { auth } from "./auth";
import { HANDOFF_STATE_COOKIE, randomSecret } from "./portal-handoff";

let ada: TestUser;
let slug: string;

beforeEach(async () => {
  ada = await signUp("Ada");
  slug = (await createProject(await signUp("Owner"))).slug;
  actAs(ada);
});

const portalHost = (projectSlug = slug) => `${projectSlug}.localhost:3100`;

/** Ada confirms "Continue as Ada" on the app host; returns the portal callback URL. */
async function confirm(state: string, redirectPath = "/") {
  return new URL(await redirectTarget(continueToPortal(slug, state, redirectPath)));
}

/** The browser opens the callback on `host`, sending `state` in the portal's cookie. */
async function callback(url: URL, state: string | null, host = portalHost()) {
  const headers = new Headers({ host });
  if (state) {
    headers.set("cookie", `${HANDOFF_STATE_COOKIE}=${state}`);
  }
  const response = await auth.handler(new Request(`http://${host}${url.pathname}${url.search}`, { headers }));
  const cookie = response.headers
    .getSetCookie()
    .filter((c) => !c.startsWith(`${HANDOFF_STATE_COOKIE}=`))
    .map((c) => c.split(";")[0])
    .join("; ");
  const session = cookie ? await auth.api.getSession({ headers: new Headers({ cookie, host }) }) : null;
  return { location: response.headers.get("location"), userId: session?.user.id ?? null };
}

test("the portal sets a state cookie and sends the browser to the app host with it", async () => {
  const response = await startContinue(new Request(`http://${portalHost()}/continue?redirect=/b/ideas`), {
    params: Promise.resolve({ project: slug }),
  });
  const location = new URL(response.headers.get("location")!);
  expect(location.origin + location.pathname).toBe("http://tuti.localhost:3100/continue");
  expect(location.searchParams.get("portal")).toBe(slug);
  expect(location.searchParams.get("redirect")).toBe("/b/ideas");
  const state = location.searchParams.get("state");
  expect(response.headers.getSetCookie()).toEqual([
    expect.stringMatching(new RegExp(`^${HANDOFF_STATE_COOKIE}=${state}; .*HttpOnly.*SameSite=lax`, "i")),
  ]);
});

test("confirming signs the same account into the portal, once", async () => {
  const state = randomSecret();
  const url = await confirm(state, "/b/ideas");
  expect(url.origin).toBe(`http://${portalHost()}`);

  expect(await callback(url, state)).toEqual({ location: "/b/ideas", userId: ada.id });
  // The code is gone after its first use.
  expect(await callback(url, state)).toEqual({ location: "/sign-in?continue=failed", userId: null });
});

test("a code only works in the browser that asked for it", async () => {
  const state = randomSecret();
  const url = await confirm(state);
  // Someone sends their own code to another browser (login CSRF): no state cookie, or a different one.
  expect(await callback(url, null)).toEqual({ location: "/sign-in?continue=failed", userId: null });
  expect(await callback(url, randomSecret())).toEqual({ location: "/sign-in?continue=failed", userId: null });
  // A failed try uses the code up.
  expect(await callback(url, state)).toEqual({ location: "/sign-in?continue=failed", userId: null });
});

test("a code only works on the portal it was issued for", async () => {
  const state = randomSecret();
  const url = await confirm(state);
  const other = await createProject(ada);
  expect(await callback(url, state, portalHost(other.slug))).toEqual({
    location: "/sign-in?continue=failed",
    userId: null,
  });
});

test("an expired code doesn't work", async () => {
  const state = randomSecret();
  const url = await confirm(state);
  await prisma.portalHandoff.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await callback(url, state)).toEqual({ location: "/sign-in?continue=failed", userId: null });
});

test("only same-site paths are followed after signing in", async () => {
  const state = randomSecret();
  const url = await confirm(state, "//evil.example/");
  expect(await callback(url, state)).toEqual({ location: "/", userId: ada.id });
});

test("only hashes are stored", async () => {
  const state = randomSecret();
  const url = await confirm(state);
  const handoff = await prisma.portalHandoff.findFirstOrThrow({ where: { userId: ada.id } });
  expect(JSON.stringify(handoff)).not.toContain(url.searchParams.get("code"));
  expect(JSON.stringify(handoff)).not.toContain(state);
});

test("without a Tuti account there is nothing to continue with", async () => {
  const before = await prisma.portalHandoff.count();
  actAs(null);
  expect(await continueToPortal(slug, randomSecret(), "/")).toEqual({ error: "Sign in to continue." });
  actAs(ada);
  expect(await continueToPortal(slug, "not-a-state", "/")).toEqual({
    error: "This sign-in link isn't valid. Go back to the portal and try again.",
  });
  expect(await continueToPortal("no-such-project", randomSecret(), "/")).toEqual({ error: "Project not found." });
  expect(await prisma.portalHandoff.count()).toBe(before);
});

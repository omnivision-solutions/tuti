import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { prisma } from "@tuti/db";
import { expect, test } from "vitest";

import { signUp } from "@/test/helpers";

import { auth } from "./auth";

const script = fileURLToPath(new URL("../../../../scripts/sign-in-as.mjs", import.meta.url));

/** What the maintainers' script prints: the link. Its connection is in a zone behind UTC, which timestamps mustn't follow. */
function mintLink(email: string) {
  const database = new URL(process.env.DATABASE_URL!);
  database.searchParams.set("options", "-c TimeZone=America/New_York");
  const env = { ...process.env, DATABASE_URL: database.href };
  return new URL(execFileSync("node", [script, email], { encoding: "utf8", env }).trim().split("\n").at(-1)!);
}

/** A browser opens `link` on `host`: where it's sent, and who it's then signed in as. */
async function open(link: URL, host = link.host) {
  const response = await auth.handler(new Request(`http://${host}${link.pathname}${link.search}`, { headers: { host } }));
  const cookies = response.headers.getSetCookie();
  const cookie = cookies.map((c) => c.split(";")[0]).join("; ");
  const session = cookie ? await auth.api.getSession({ headers: new Headers({ cookie, host }) }) : null;
  return { location: response.headers.get("location"), userId: session?.user.id ?? null, cookies };
}

test("the script's link signs a browser in as the account once, until the browser closes", async () => {
  const ada = await signUp("Ada");
  const link = mintLink(ada.email.toUpperCase());
  expect(link.href).toMatch(/^http:\/\/tuti\.localhost:3100\/api\/auth\/support\/sign-in\?token=[\w-]{43}$/);
  const stored = await prisma.verification.findFirstOrThrow({ where: { identifier: { startsWith: "support-sign-in:" }, value: ada.id } });
  expect(stored.expiresAt.getTime() - stored.createdAt.getTime()).toBeCloseTo(10 * 60 * 1000, -4);

  const first = await open(link);
  expect(first).toMatchObject({ location: "/app", userId: ada.id });
  const session = await prisma.session.findFirstOrThrow({ where: { userId: ada.id }, orderBy: { createdAt: "desc" } });
  expect(session.expiresAt.getTime() - session.createdAt.getTime()).toBeCloseTo(24 * 60 * 60 * 1000, -4);
  // A browser-session cookie: no Max-Age, so closing the window ends it.
  expect(first.cookies.find((c) => c.startsWith("tuti.session_token="))).not.toMatch(/Max-Age/i);

  expect(await open(link)).toMatchObject({ location: "/app/auth/sign-in", userId: null });
});

test("the link signs no one in on a portal's host, nor once it's expired or made up", async () => {
  const ada = await signUp("Ada");
  expect(await open(mintLink(ada.email), "acme.localhost:3100")).toMatchObject({ location: "/app/auth/sign-in", userId: null });

  const expired = mintLink(ada.email);
  await prisma.verification.updateMany({ where: { identifier: { startsWith: "support-sign-in:" } }, data: { expiresAt: new Date(Date.now() - 1000) } });
  expect(await open(expired)).toMatchObject({ location: "/app/auth/sign-in", userId: null });

  const madeUp = new URL(expired);
  madeUp.searchParams.set("token", "a".repeat(43));
  expect(await open(madeUp)).toMatchObject({ location: "/app/auth/sign-in", userId: null });
});

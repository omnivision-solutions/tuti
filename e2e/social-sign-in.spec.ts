import { randomInt, randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";
import pg from "pg";

import { checkpoints } from "./checkpoint";
import { APP_URL } from "./env";
import { fillSignUp, newPerson, signUp, type TestPage } from "./helpers";
import { latestEmailTo, linkIn } from "./mail";

/** Who `page`'s browser is when it next continues with Google or GitHub (the fakes, by its X-Forwarded-For). */
async function nextSignIn(page: { ip: string }, provider: "google" | "github", person: { email: string; name: string; verified?: boolean }) {
  const [url, body] =
    provider === "google"
      ? [process.env.E2E_GOOGLE_URL, { sub: randomUUID(), ...person }]
      : [process.env.E2E_GITHUB_URL, { id: randomInt(1, 2 ** 31), login: person.name.split(" ")[0]!.toLowerCase(), ...person }];
  const response = await fetch(`${url}/_fake/next-sign-in`, { method: "POST", body: JSON.stringify({ forwardedFor: page.ip, ...body }) });
  expect(response.ok).toBe(true);
}

/** The tokens kept for `email`'s account with `provider`: none ever are. */
async function storedTokens(email: string, provider: string) {
  const client = new pg.Client({ connectionString: process.env.E2E_DATABASE_URL });
  await client.connect();
  try {
    const { rows } = await client.query(
      `SELECT "accessToken", "refreshToken", "idToken" FROM account WHERE "providerId" = $1 AND "userId" = (SELECT id FROM "user" WHERE email = $2)`,
      [provider, email],
    );
    return rows;
  } finally {
    await client.end();
  }
}

const signOut = (page: TestPage) => page.context().clearCookies({ name: /(^|__Secure-)tuti\./ });

test("someone signs up with Google, and later in with it again", async ({ browser }, testInfo) => {
  const checkpoint = checkpoints(testInfo);
  const gina = await newPerson(browser, APP_URL);
  const email = `e2e-${randomUUID()}@example.com`;
  await gina.goto("/sign-up");
  await expect(gina.getByRole("button", { name: "Continue with GitHub" })).toBeVisible();
  await checkpoint(gina, "sign-up");

  // Turned away before it starts (Better Auth's limit on sign-in tries): it says so, and the buttons work again.
  await gina.route("**/api/auth/sign-in/social", (route) => route.fulfill({ status: 429, json: { message: "Too many requests" } }), { times: 1 });
  await gina.getByRole("button", { name: "Continue with Google" }).click();
  await expect(gina.getByText("Too many tries. Wait a few seconds and try again.")).toBeVisible();

  await nextSignIn(gina, "google", { email, name: "Gina Google" });
  await gina.getByRole("button", { name: "Continue with Google" }).click();
  await gina.waitForURL(/\/app$/);
  // Signed in with it, and nothing of Google's kept: no token to read anything with.
  expect(await storedTokens(email, "google")).toEqual([{ accessToken: null, refreshToken: null, idToken: null }]);
  await expect(gina.getByText("Welcome to Tuti")).toBeVisible();
  // Google's name, and an address Google verified: no strip asking to verify it.
  await gina.goto("/app/account");
  await expect(gina.getByLabel("Name")).toHaveValue("Gina Google");
  await expect(gina.getByText("Not verified")).toHaveCount(0);
  // No password to change: one can be set by email.
  await expect(gina.getByText("You sign in with Google.")).toBeVisible();
  await expect(gina.getByRole("link", { name: "set one by email" })).toHaveAttribute("href", "/forgot-password");
  await checkpoint(gina, "account-without-password");

  // Signed out, Continue with Google on the sign-in page is the same account, and `next` is where it goes.
  await signOut(gina);
  await gina.goto("/sign-in?next=/app/account");
  await nextSignIn(gina, "google", { email, name: "Gina Google" });
  await gina.getByRole("button", { name: "Continue with Google" }).click();
  await gina.waitForURL("**/app/account");
  await expect(gina.getByRole("main").getByText(email)).toBeVisible();
});

test("someone with a verified account continues with GitHub and is signed in to it", async ({ browser }) => {
  const olive = await signUp(browser, APP_URL, "Olive Owner");
  await olive.goto(linkIn(await latestEmailTo(olive.email, { subject: /verify/i }), `${APP_URL}/api/auth/verify-email`));
  await signOut(olive);

  await olive.goto("/sign-in");
  await nextSignIn(olive, "github", { email: olive.email, name: "Olive on GitHub" });
  await olive.getByRole("button", { name: "Continue with GitHub" }).click();
  await olive.waitForURL(/\/app$/);
  expect(await storedTokens(olive.email, "github")).toEqual([{ accessToken: null, refreshToken: null, idToken: null }]);
  // Her account, as it was: its name, and still its password.
  await olive.goto("/app/account");
  await expect(olive.getByLabel("Name")).toHaveValue("Olive Owner");
  await expect(olive.getByLabel("Current password")).toBeVisible();
});

test("Continue with Google doesn't sign in to an account whose address isn't verified", async ({ browser }) => {
  // Someone signed up with this address (not verified): continuing with Google as it doesn't sign in to that account.
  const ivy = await signUp(browser, APP_URL, "Ivy");
  await signOut(ivy);
  await ivy.goto("/sign-in");
  await nextSignIn(ivy, "google", { email: ivy.email, name: "Ivy" });
  await ivy.getByRole("button", { name: "Continue with Google" }).click();
  await ivy.waitForURL("**/sign-in?**");
  await expect(ivy.getByText("This email already has a Tuti account that isn't verified yet.", { exact: false })).toBeVisible();
  await ivy.goto("/app");
  await ivy.waitForURL("**/sign-in");
});

test("an address Google hasn't verified signs nobody in", async ({ browser }) => {
  const visitor = await newPerson(browser, APP_URL);
  const email = `e2e-${randomUUID()}@example.com`;
  await visitor.goto("/sign-up");
  await nextSignIn(visitor, "google", { email, name: "Una", verified: false });
  await visitor.getByRole("button", { name: "Continue with Google" }).click();
  await visitor.waitForURL("**/sign-up?**");
  await expect(visitor.getByText("Signing in with Google needs an email address Google has verified.", { exact: false })).toBeVisible();
  // No account was made: its owner can still sign up with it.
  await visitor.goto("/sign-up");
  await fillSignUp(visitor, "Una", email);
  await visitor.waitForURL(/\/app$/);
});

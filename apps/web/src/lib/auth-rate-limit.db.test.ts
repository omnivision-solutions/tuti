import { prisma } from "@tuti/db";
import { afterEach, beforeEach, expect, test, vi } from "vitest";

import { POST as authRoute } from "@/app/api/auth/[...all]/route";
import { auth } from "@/lib/auth";
import { appUrl } from "@/lib/hosts";
import { signUp } from "@/test/helpers";

// Before lib/auth.ts reads it.
vi.hoisted(() => {
  process.env.TRUSTED_IP_HEADER = "cf-connecting-ip";
});

const signIn = (email: string, password: string, headers: Record<string, string>) =>
  authRoute(
    new Request(`${appUrl().origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: { host: appUrl().host, origin: appUrl().origin, "content-type": "application/json", ...headers },
      body: JSON.stringify({ email, password }),
    }),
  );

beforeEach(async () => {
  // Better Auth's limiter is on in production only.
  (await auth.$context).rateLimit.enabled = true;
});

afterEach(() => {
  vi.useRealTimers();
});

/** Better Auth's window (3 sign-ins per 10 seconds) runs on Date: frozen, so a slow run can't start it over. */
function freezeClock() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
}

test("password sign-in is limited per address in TRUSTED_IP_HEADER, whatever X-Forwarded-For says", async () => {
  const user = await signUp();
  freezeClock();

  const guesses: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const response = await signIn(user.email, `wrong ${i}`, { "x-forwarded-for": `198.51.100.${i}`, "cf-connecting-ip": "203.0.113.7" });
    guesses.push(response.status);
  }
  expect(guesses).toEqual([401, 401, 401, 429]);

  // Another visitor, even one whose X-Forwarded-For has several values (a proxy that appends), isn't held up.
  const other = await signIn(user.email, "correct horse battery staple", { "x-forwarded-for": "203.0.113.9, 198.51.100.250", "cf-connecting-ip": "192.0.2.55" });
  expect(other.status).toBe(200);
});

test("a proxy that appends to TRUSTED_IP_HEADER: its own value, the last, is who's asking", async () => {
  const user = await signUp();
  freezeClock();

  const guesses: number[] = [];
  for (let i = 1; i <= 4; i++) {
    // What the visitor sent comes first, under the header and under the app's own name for the address.
    const headers = { "cf-connecting-ip": `198.51.100.${i}, 203.0.113.8`, "x-tuti-client-ip": `198.51.100.${i}` };
    guesses.push((await signIn(user.email, `wrong ${i}`, headers)).status);
  }
  expect(guesses).toEqual([401, 401, 401, 429]);

  const other = await signIn(user.email, "correct horse battery staple", { "cf-connecting-ip": "203.0.113.8, 192.0.2.66" });
  expect(other.status).toBe(200);
});

test("a session made by a server-side call keeps the address in TRUSTED_IP_HEADER, never the one the visitor sent", async () => {
  const user = await signUp();
  const signInAs = async (headers: Record<string, string>) => {
    const { token } = await auth.api.signInEmail({
      body: { email: user.email, password: "correct horse battery staple" },
      headers: new Headers({ host: appUrl().host, ...headers }),
    });
    return (await prisma.session.findUniqueOrThrow({ where: { token }, select: { ipAddress: true } })).ipAddress;
  };

  expect(await signInAs({ "cf-connecting-ip": "198.51.100.1, 192.0.2.77", "x-tuti-client-ip": "198.51.100.1" })).toBe("192.0.2.77");
  // No trusted header (the request didn't come through the proxy): not what it said either.
  expect(await signInAs({ "x-tuti-client-ip": "203.0.113.99" })).not.toBe("203.0.113.99");
});

import { expect, test, vi } from "vitest";

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

test("password sign-in is limited per address in TRUSTED_IP_HEADER, whatever X-Forwarded-For says", async () => {
  // Better Auth's limiter is on in production only.
  (await auth.$context).rateLimit.enabled = true;
  const user = await signUp();
  // Its window (3 sign-ins per 10 seconds) runs on Date: frozen, so a slow run can't start it over.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));

  const guesses: number[] = [];
  for (let i = 1; i <= 4; i++) {
    const response = await signIn(user.email, `wrong ${i}`, { "x-forwarded-for": `198.51.100.${i}`, "cf-connecting-ip": "203.0.113.7" });
    guesses.push(response.status);
  }
  expect(guesses).toEqual([401, 401, 401, 429]);

  // Another visitor, even one whose X-Forwarded-For has several values (a proxy that appends), isn't held up.
  const other = await signIn(user.email, "correct horse battery staple", { "x-forwarded-for": "203.0.113.9, 198.51.100.250", "cf-connecting-ip": "192.0.2.55" });
  expect(other.status).toBe(200);
  vi.useRealTimers();
});

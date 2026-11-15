import { redirect } from "next/navigation";

import { appsumoLicenseKey, APPSUMO, claimToken } from "@/server/appsumo";

/**
 * AppSumo's OAuth redirect (server/appsumo.ts): a buyer redeeming a license comes back with a single-use `code`, which
 * gives its license key; they go on to the redeem page with a claim for it (an hour), to sign in or sign up and add it
 * to their account. Without a code (AppSumo checking the address) it answers 200.
 */
export async function GET(request: Request) {
  const code = new URL(request.url).searchParams.get("code");
  if (!code || !process.env.APPSUMO_API_KEY) {
    return new Response("Redeem your AppSumo license from your AppSumo account.", { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
  const key = await appsumoLicenseKey(code);
  // A key can't carry a dot through the claim (signValue's fields): AppSumo's are UUIDs.
  redirect(key && !key.includes(".") ? `/app/licenses/redeem?claim=${encodeURIComponent(claimToken(APPSUMO, key))}` : "/app/licenses/redeem?failed=1");
}

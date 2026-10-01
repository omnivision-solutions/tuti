import { auth } from "@/lib/auth";

// Pretty URL for customers: /<workspace>/sso?token=…&redirect=…
// (A board can't use the slug "sso"; this static segment takes precedence.)
export async function GET(request: Request, ctx: RouteContext<"/[workspace]/sso">) {
  const { workspace } = await ctx.params;
  const params = new URL(request.url).searchParams;

  return auth.api.ssoJwt({
    query: {
      workspace,
      token: params.get("token") ?? "",
      redirect: params.get("redirect") ?? undefined,
    },
    headers: request.headers,
    asResponse: true,
  });
}

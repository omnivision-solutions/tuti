import { auth } from "@/lib/auth";

// <project>.tuti.so/sso?token=…&redirect=… (the project comes from the host).
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;

  return auth.api.ssoJwt({
    query: {
      token: params.get("token") ?? "",
      redirect: params.get("redirect") ?? undefined,
    },
    headers: request.headers,
    asResponse: true,
  });
}

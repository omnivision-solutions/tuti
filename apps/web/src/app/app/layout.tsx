import { redirect } from "next/navigation";

import { getSession } from "@/server/session";

/** Everything under /app needs a signed-in user. */
export default async function AppLayout({ children }: LayoutProps<"/app">) {
  if (!(await getSession())) {
    redirect("/sign-in");
  }
  return children;
}

import Link from "next/link";

import { buttonVariants } from "@/components/ui/button";
import { getSession } from "@/server/session";

export default async function Home() {
  const session = await getSession();

  return (
    <div className="flex flex-col items-start gap-4 py-10">
      <h1 className="text-4xl font-semibold tracking-tight">Feedback your users will actually leave.</h1>
      <p className="text-lg text-muted-foreground">Collect feature requests, let users vote, and close the loop.</p>
      <Link href={session ? "/app" : "/sign-up"} className={buttonVariants({ size: "lg" })}>
        {session ? "Open app" : "Get started"}
      </Link>
    </div>
  );
}

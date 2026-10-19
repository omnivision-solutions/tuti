import { CircleAlertIcon } from "lucide-react";

import { AuthForm } from "@/components/auth-form";
import { TutiMark } from "@/components/tuti-logo";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { buttonVariants } from "@/components/ui/button";

export default async function PortalSignInPage(props: PageProps<"/portal/[project]/sign-in">) {
  const { continue: handoff } = await props.searchParams;

  return (
    <div className="mx-auto flex w-full max-w-sm flex-col gap-4">
      {handoff === "failed" && (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>That sign-in didn&apos;t work. Try again.</AlertDescription>
        </Alert>
      )}
      {/* A plain link: /continue is a route that sets a cookie and leaves for the app host. */}
      <a href="/continue" className={buttonVariants({ variant: "secondary", className: "w-full" })}>
        <TutiMark className="size-4" />
        Continue with your Tuti account
      </a>
      <AuthForm mode="sign-in" redirectTo="/" />
    </div>
  );
}

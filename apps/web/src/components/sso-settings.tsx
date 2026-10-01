"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { disableSso, rotateSsoSecret } from "@/server/sso-settings";

export function SsoSettings({
  workspaceSlug,
  enabled,
  ssoUrl,
}: {
  workspaceSlug: string;
  enabled: boolean;
  ssoUrl: string;
}) {
  const [pending, startTransition] = useTransition();
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();

  const rotate = () => {
    if (enabled && !confirm("Rotate the secret? Tokens signed with the old secret stop working immediately.")) {
      return;
    }
    startTransition(async () => {
      const result = await rotateSsoSecret(workspaceSlug);
      setError(result.error);
      setSecret(result.secret);
      if (result.secret) {
        toast.success(enabled ? "SSO secret rotated" : "SSO enabled");
      }
    });
  };

  const disable = () => {
    if (!confirm("Disable single sign-on? Your app's sign-in links stop working immediately.")) {
      return;
    }
    startTransition(async () => {
      const result = await disableSso(workspaceSlug);
      setError(result.error);
      setSecret(undefined);
      if (!result.error) {
        toast.success("SSO disabled");
      }
    });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2 text-sm">
        Status <Badge variant={enabled ? "default" : "secondary"}>{enabled ? "Enabled" : "Disabled"}</Badge>
      </div>

      {secret && (
        <Alert>
          <TriangleAlertIcon />
          <AlertTitle>Copy your SSO secret now. It won&apos;t be shown again.</AlertTitle>
          <AlertDescription className="flex flex-col gap-2">
            <code className="w-full rounded-md bg-muted px-2 py-1 font-mono text-xs break-all text-foreground">{secret}</code>
            Store it on your server only (e.g. as TUTI_SSO_SECRET). Never send it to the browser.
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex gap-2">
        <Button onClick={rotate} disabled={pending}>
          {enabled ? "Rotate secret" : "Enable SSO"}
        </Button>
        {enabled && (
          <Button variant="outline" onClick={disable} disabled={pending}>
            Disable
          </Button>
        )}
      </div>

      <div className="flex flex-col gap-2 text-sm">
        <p className="font-medium">How to sign users in from your app</p>
        <p className="text-muted-foreground">
          On your server, sign a short-lived token for the logged-in user and redirect them to{" "}
          <code>{ssoUrl}</code>. Example with Node and <code>jose</code>:
        </p>
        <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">
          {`import { SignJWT } from "jose";

const token = await new SignJWT({
  email: user.email,      // optional
  name: user.name,        // optional, shown on posts
  avatar: user.avatarUrl, // optional, https URL
})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(String(user.id)) // your user id; this is how we match users
  .setJti(crypto.randomUUID()) // each token works once
  .setIssuedAt()
  .setExpirationTime("5m")     // 10 minutes max
  .sign(new TextEncoder().encode(process.env.TUTI_SSO_SECRET));

redirect(\`${ssoUrl}?token=\${token}&redirect=/\`);`}
        </pre>
      </div>
    </div>
  );
}

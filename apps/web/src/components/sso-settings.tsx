"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { disableSso, rotateSsoSecret } from "@/server/sso-settings";

export function SsoSettings({
  projectSlug,
  enabled,
  ssoUrl,
}: {
  projectSlug: string;
  enabled: boolean;
  ssoUrl: string;
}) {
  const [pending, startTransition] = useTransition();
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();

  const rotate = () => {
    startTransition(async () => {
      const result = await rotateSsoSecret(projectSlug);
      setError(result.error);
      setSecret(result.secret);
      if (result.secret) {
        toast.success(enabled ? "SSO secret rotated" : "SSO enabled");
      }
    });
  };

  const disable = () => {
    startTransition(async () => {
      const result = await disableSso(projectSlug);
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
        {enabled ? (
          <>
            <Confirm
              trigger={<Button disabled={pending} />}
              label="Rotate secret"
              title="Rotate the SSO secret?"
              description="Tokens signed with the old secret stop working immediately. Update your server with the new secret right away."
              onConfirm={rotate}
            />
            <Confirm
              trigger={<Button variant="outline" disabled={pending} />}
              label="Disable"
              title="Disable single sign-on?"
              description="Your app's sign-in links stop working immediately. People can still sign in on the portal with email."
              confirmLabel="Disable SSO"
              destructive
              onConfirm={disable}
            />
          </>
        ) : (
          <Button onClick={rotate} disabled={pending}>
            Enable SSO
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

/** A button that asks before doing something that breaks the customer's sign-in links. */
function Confirm({
  trigger,
  label,
  title,
  description,
  confirmLabel = label,
  destructive,
  onConfirm,
}: {
  trigger: React.ReactElement;
  label: string;
  title: string;
  description: string;
  confirmLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  // AlertDialogAction is a plain button: close the dialog ourselves (the settings stay on screen).
  const [open, setOpen] = useState(false);
  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger render={trigger}>{label}</AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              setOpen(false);
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

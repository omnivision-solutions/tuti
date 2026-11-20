"use client";

import { CodeIcon, TriangleAlertIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { CopyButton } from "@/components/copy-button";
import { useCustomizeForm } from "@/components/customize-shell";
import { SettingBlock, SettingRow } from "@/components/settings-card";

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
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { disableSso, rotateSsoSecret, setSsoSignInUrl } from "@/server/sso-settings";

/**
 * Settings → Single sign-on's rows: the switch (turning it off asks first), the secret (shown once, when it's made),
 * the app's own sign-in page (saved by the page's "Save changes"), the address to send people to, and the example.
 */
export function SsoSettings({
  projectSlug,
  enabled,
  ssoUrl,
  signInUrl,
}: {
  projectSlug: string;
  enabled: boolean;
  ssoUrl: string;
  signInUrl: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [rotating, setRotating] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [example, setExample] = useState(false);

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

  const sample = `import { SignJWT } from "jose";

const token = await new SignJWT({
  email: user.email,      // optional
  name: user.name,        // optional, shown on posts
  avatar: user.avatarUrl, // optional, http(s) URL
})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(String(user.id)) // your user id; this is how we match users
  .setJti(crypto.randomUUID()) // each token works once
  .setIssuedAt()
  .setExpirationTime("5m")     // 10 minutes max
  .sign(new TextEncoder().encode(process.env.TUTI_SSO_SECRET));

redirect(\`${ssoUrl}?token=\${token}&redirect=/\`);`;

  return (
    <>
      <SettingRow label="Single sign-on" description="Your app signs its users in to the portal." htmlFor="sso-enabled" inline>
        {/* Not `disabled` while it saves: that would drop the keyboard's focus. Turning it off asks first. */}
        <Switch
          id="sso-enabled"
          checked={enabled}
          aria-disabled={pending || undefined}
          aria-describedby="sso-enabled-description"
          className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          onChange={() => {
            if (pending) {
              return;
            }
            if (enabled) {
              setDisabling(true);
            } else {
              rotate();
            }
          }}
        />
        <Confirm
          open={disabling}
          onOpenChange={setDisabling}
          title="Disable single sign-on?"
          description="Your app's sign-in links stop working immediately. People can still sign in on the portal with email."
          confirmLabel="Disable SSO"
          destructive
          onConfirm={disable}
        />
      </SettingRow>

      {(secret || error) && (
        <SettingBlock>
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
        </SettingBlock>
      )}

      {enabled && (
        <>
          <SettingRow label="Secret" description="Shown once, when it's made." inline>
            <Button variant="outline" disabled={pending} focusableWhenDisabled onClick={() => setRotating(true)}>
              Rotate secret
            </Button>
            <Confirm
              open={rotating}
              onOpenChange={setRotating}
              title="Rotate the SSO secret?"
              description="Tokens signed with the old secret stop working immediately. Update your server with the new secret right away."
              confirmLabel="Rotate secret"
              onConfirm={rotate}
            />
          </SettingRow>
          <SignInPageRow projectSlug={projectSlug} ssoUrl={ssoUrl} signInUrl={signInUrl} />
        </>
      )}

      <SettingRow label="Sign-in address">
        <div className="flex min-w-0 items-center gap-1 @min-[34rem]/settings:max-w-96">
          <code className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">{ssoUrl}</code>
          <CopyButton value={ssoUrl} label="sign-in address" />
        </div>
      </SettingRow>

      <SettingRow label="Setup guide" description="Sign a short-lived token on your server, then redirect.">
        <Button variant="outline" aria-expanded={example} aria-controls="sso-example" onClick={() => setExample(!example)}>
          <CodeIcon />
          {example ? "Hide example" : "Show example"}
        </Button>
      </SettingRow>
      {example && (
        <SettingBlock className="gap-2 text-sm">
          <div className="flex items-center justify-between gap-2">
            <p className="text-muted-foreground">
              With Node and <code>jose</code>:
            </p>
            <CopyButton value={sample} label="example" />
          </div>
          <pre id="sso-example" className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">
            {sample}
          </pre>
        </SettingBlock>
      )}
    </>
  );
}

/** The app's own sign-in page (empty removes it), saved by the page's "Save changes". */
function SignInPageRow({ projectSlug, ssoUrl, signInUrl }: { projectSlug: string; ssoUrl: string; signInUrl: string | null }) {
  const { state, form } = useCustomizeForm({
    save: async (_prev, formData) => {
      const result = await setSsoSignInUrl(projectSlug, formData);
      if (!result.error) {
        toast.success("Sign-in page saved");
      }
      return result;
    },
  });
  return (
    <SettingRow
      label="Your app's sign-in page"
      description="Signing in on the portal goes here."
      info={
        <>
          Signing in on the portal comes here, to your app&apos;s accounts instead of Tuti&apos;s, with <code>redirect</code>, the page to come back to. Sign them in, then send them to{" "}
          <code className="break-all">{ssoUrl}</code> with that <code>redirect</code>. A private portal with readers you add by email keeps its sign-in page, with your app&apos;s button first. Your team signs in
          at <code>/sign-in?with=email</code>.
        </>
      }
      htmlFor="sso-sign-in-url"
    >
      <form {...form} className="flex flex-col gap-2">
        <Input
          id="sso-sign-in-url"
          name="signInUrl"
          type="url"
          placeholder="https://app.example.com/tuti"
          defaultValue={signInUrl ?? ""}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? "sso-sign-in-url-error sso-sign-in-url-description" : "sso-sign-in-url-description"}
          className="@min-[34rem]/settings:w-72"
        />
        {state.error && <FieldError id="sso-sign-in-url-error">{state.error}</FieldError>}
      </form>
    </SettingRow>
  );
}

/** Asks before doing something that breaks the customer's sign-in links. */
function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  confirmLabel: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          {/* AlertDialogAction is a plain button: close the dialog ourselves (the settings stay on screen). */}
          <AlertDialogAction
            variant={destructive ? "destructive" : "default"}
            onClick={() => {
              onOpenChange(false);
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

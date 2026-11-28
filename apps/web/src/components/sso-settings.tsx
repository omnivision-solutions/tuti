"use client";

import { TriangleAlertIcon } from "lucide-react";
import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { AgentPrompt } from "@/components/agent-prompt";
import { CopyButton } from "@/components/copy-button";
import { useCustomizeForm } from "@/components/customize-shell";
import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";

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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { errorMessage, useTRPCClient } from "@/components/trpc";

/**
 * What a coding agent needs to add the portal's sign-in to the team's app. No secret in it: it's pasted into other
 * tools, so it names the environment variable the secret goes in.
 */
export function agentPrompt(portal: string) {
  return `Add sign-in with our app's accounts to our Tuti feedback portal at ${portal}.

1. Add a route at /tuti. If the visitor isn't signed in, send them through our normal sign-in first, then back to /tuti (keep its query string).
2. For the signed-in user, create a JWT signed with HS256 using the TUTI_SSO_SECRET environment variable. Read it on the server only; never send it to the browser.
   - sub: our user id as a string (required; Tuti matches people by it)
   - jti: a random UUID (each token works once)
   - iat: now; exp: 5 minutes from now (10 minutes at most)
   - optional: name (shown on their posts), avatar (an http(s) image URL)
   - optional: email, only if our app has verified it: Tuti links that address to this user
3. Redirect to ${portal}/sso?token=<jwt>&redirect=<r>, where <r> is the "redirect" query parameter Tuti sent to /tuti (URL-encoded; "/" if missing).
4. Use the JWT library this project already has; otherwise add the standard one for our stack (jose for Node).
5. Add TUTI_SSO_SECRET to .env.example with an empty value.
6. When it's done, tell me the full https:// address of /tuti: once it's deployed with TUTI_SSO_SECRET set, I enter it in Tuti as "Your app's sign-in page".`;
}

/**
 * Settings → Single sign-on: the switch (turning it off asks first) with how sign-in goes, the secret (shown once,
 * when it's made), a prompt for the team's coding agent (or the code), the app's own sign-in page (saved by the page's
 * "Save changes") and the address to send people back to, then replacing the secret.
 */
export function SsoSettings({
  projectSlug,
  enabled,
  portal,
  signInUrl,
}: {
  projectSlug: string;
  enabled: boolean;
  /** The portal's address, without a trailing slash. */
  portal: string;
  signInUrl: string | null;
}) {
  const [pending, startTransition] = useTransition();
  const trpc = useTRPCClient();
  const router = useRouter();
  // On or off as saved, as soon as a save is through (the page's own `enabled` comes with its refresh, a moment later,
  // and a click meanwhile would make another key); the page's again whenever it brings a new one.
  const [on, setOn] = useState(enabled);
  const [pageEnabled, setPageEnabled] = useState(enabled);
  if (enabled !== pageEnabled) {
    setPageEnabled(enabled);
    setOn(enabled);
  }
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<string>();
  const [rotating, setRotating] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const [tab, setTab] = useState<"prompt" | "code">("prompt");
  const secretRef = useRef<HTMLDivElement>(null);
  // A new key shows once, under the switch: bring it into view with focus on its Copy (Replace key is at the page's end).
  useEffect(() => {
    if (secret) {
      secretRef.current?.scrollIntoView({ block: "center" });
      secretRef.current?.querySelector("button")?.focus({ preventScroll: true });
    }
  }, [secret]);
  const ssoUrl = `${portal}/sso`;
  const prompt = agentPrompt(portal);

  const rotate = () => {
    startTransition(async () => {
      // One at a time: the switch and Replace key are off while either saves, and show what's saved once it is.
      const result: { error?: string; secret?: string } = await trpc.sso.rotate.mutate({ project: projectSlug }).catch((caught: unknown) => ({ error: errorMessage(caught) }));
      setError(result.error);
      setSecret(result.secret);
      if (result.secret) {
        setOn(true);
        toast.success(on ? "Secret key replaced" : "Single sign-on is on");
        // The switch shows what the page read.
        router.refresh();
      }
    });
  };

  const disable = () => {
    startTransition(async () => {
      const result: { error?: string } = await trpc.sso.disable.mutate({ project: projectSlug }).catch((caught: unknown) => ({ error: errorMessage(caught) }));
      setError(result.error);
      setSecret(undefined);
      if (!result.error) {
        setOn(false);
        toast.success("Single sign-on is off");
        router.refresh();
      }
    });
  };

  const sample = `// On your server, with jose (npm install jose)
import { SignJWT } from "jose";

const token = await new SignJWT({
  email: user.email,      // optional; only an address your app has verified
  name: user.name,        // optional, shown on posts
  avatar: user.avatarUrl, // optional, http(s) URL
})
  .setProtectedHeader({ alg: "HS256" })
  .setSubject(String(user.id)) // your user id; this is how we match users
  .setJti(crypto.randomUUID()) // each token works once
  .setIssuedAt()
  .setExpirationTime("5m")     // 10 minutes max
  .sign(new TextEncoder().encode(process.env.TUTI_SSO_SECRET));

// redirect: the one Tuti sent to your sign-in page
const back = encodeURIComponent(req.query.redirect ?? "/");
res.redirect(\`${ssoUrl}?token=\${token}&redirect=\${back}\`);`;

  return (
    <>
      <SettingsCard>
        <SettingRow label="Single sign-on" description="People sign in to your portal with their account in your app." htmlFor="sso-enabled" inline>
          {/* Not `disabled` while it saves: that would drop the keyboard's focus. Turning it off asks first. */}
          <Switch
            id="sso-enabled"
            checked={on}
            aria-disabled={pending || undefined}
            aria-describedby="sso-enabled-description"
            className="aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            onChange={() => {
              if (pending) {
                return;
              }
              if (on) {
                setDisabling(true);
              } else {
                rotate();
              }
            }}
          />
          <Confirm
            open={disabling}
            onOpenChange={setDisabling}
            title="Turn off single sign-on?"
            description="Your app's sign-in links stop working at once. People can still sign in to the portal with email."
            confirmLabel="Turn off"
            destructive
            onConfirm={disable}
          />
        </SettingRow>
        <SettingBlock>
          <ol aria-label="How it works" className="grid gap-2 text-sm @min-[34rem]/settings:grid-cols-3">
            {[
              ["On your portal", "Someone clicks Sign in."],
              ["In your app", "They sign in, and your server signs a token saying who they are."],
              ["Back on your portal", "They're signed in, with their own name."],
            ].map(([title, line], i) => (
              <li key={title} className="flex flex-col rounded-xl bg-muted px-3 py-2.5">
                <span className="font-medium">
                  {i + 1}. {title}
                </span>
                <span className="text-muted-foreground">{line}</span>
              </li>
            ))}
          </ol>
          {secret && (
            <Alert ref={secretRef}>
              <TriangleAlertIcon />
              <AlertTitle>Copy your secret key now. It&apos;s shown only this once.</AlertTitle>
              <AlertDescription className="flex flex-col gap-2">
                <div className="flex w-full items-center gap-1 rounded-md bg-muted py-0.5 pr-0.5 pl-2">
                  <code className="min-w-0 flex-1 font-mono text-xs break-all text-foreground">{secret}</code>
                  <CopyButton value={secret} label="secret key" />
                </div>
                Save it on your server as TUTI_SSO_SECRET, never in the browser: anyone who has it can sign in as any of your users.
              </AlertDescription>
            </Alert>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
        </SettingBlock>
      </SettingsCard>

      <SettingsCard title="Let your coding agent set it up" description="Turn on single sign-on first, for the secret key.">
        <SettingBlock>
          <Tabs value={tab} onValueChange={(value) => setTab(value as "prompt" | "code")} className="gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <TabsList>
                <TabsTrigger value="prompt">Prompt</TabsTrigger>
                <TabsTrigger value="code">Code (Node)</TabsTrigger>
              </TabsList>
              {tab === "code" && <CopyButton value={sample} label="code" wide />}
            </div>
            <TabsContent value="prompt">
              <AgentPrompt
                prompt={prompt}
                steps={[
                  <>
                    Add a <code>/tuti</code> sign-in page to your app
                  </>,
                  "Sign visitors into your portal from it",
                ]}
              />
            </TabsContent>
            <TabsContent value="code">
              <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">{sample}</pre>
            </TabsContent>
          </Tabs>
        </SettingBlock>
      </SettingsCard>

      <SettingsCard title="Or set it up yourself">
        {/* Only once SSO is on: entered before the key exists, turning SSO on would send portal sign-ins to a page that can't sign tokens yet. */}
        {on && <SignInPageRow projectSlug={projectSlug} ssoUrl={ssoUrl} signInUrl={signInUrl} />}
        <SettingRow label="Return address" description="Your app sends people back here, with a token saying who they are.">
          <div className="flex min-w-0 items-center gap-1 @min-[34rem]/settings:max-w-96">
            <code className="min-w-0 flex-1 font-mono text-xs break-all text-muted-foreground">{ssoUrl}</code>
            <CopyButton value={ssoUrl} label="return address" />
          </div>
        </SettingRow>
      </SettingsCard>

      {on && (
        <SettingsCard>
          <SettingRow label="Replace secret key" description="The current key stops working at once." inline>
            <Button variant="outline" disabled={pending} focusableWhenDisabled onClick={() => setRotating(true)}>
              Replace key
            </Button>
            <Confirm
              open={rotating}
              onOpenChange={setRotating}
              title="Replace the secret key?"
              description="Sign-ins made with the current key stop working at once, until your server has the new one."
              confirmLabel="Replace key"
              onConfirm={rotate}
            />
          </SettingRow>
        </SettingsCard>
      )}
    </>
  );
}

/** The app's own sign-in page (empty removes it), saved by the page's "Save changes". */
function SignInPageRow({ projectSlug, ssoUrl, signInUrl }: { projectSlug: string; ssoUrl: string; signInUrl: string | null }) {
  const trpc = useTRPCClient();
  const router = useRouter();
  const { state, form } = useCustomizeForm({
    save: async (_prev, formData) => {
      try {
        await trpc.sso.update.mutate({ project: projectSlug, signInUrl: String(formData.get("signInUrl") ?? "") });
      } catch (error) {
        return { error: errorMessage(error) };
      }
      toast.success("Sign-in page saved");
      router.refresh();
      return {};
    },
  });
  return (
    <SettingRow
      label="Your app's sign-in page"
      description="Sign in on the portal takes people here. Empty keeps email sign-in."
      info={
        <>
          Tuti adds <code>redirect</code>, the portal page to come back to. Sign them in, then send them to <code className="break-all">{ssoUrl}</code> with a token and that{" "}
          <code>redirect</code>. Your team still signs in at <code>/sign-in?with=email</code>, and a private portal with readers you add by email keeps its sign-in page, with your app&apos;s button first.
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

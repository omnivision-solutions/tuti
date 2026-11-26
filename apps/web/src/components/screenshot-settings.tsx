"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useState, useTransition } from "react";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import type { settingsView } from "@/server/operations/screenshots";
import { saveScreenshotSettings, testScreenshots } from "@/server/screenshots";

type Settings = Awaited<ReturnType<typeof settingsView>>;
type SignIn = Settings["signIn"];

const SIGN_INS = [
  { value: "password", label: "Password" },
  { value: "link", label: "Sign-in link" },
  { value: "none", label: "None" },
] as const;
const WINDOWS = [
  { value: "desktop", label: "Desktop" },
  { value: "phone", label: "Phone" },
] as const;

/** How often the page reads a running Test again. */
const REFRESH_MS = 5_000;

/**
 * Settings → Screenshots: the team's app (its address, how the agent signs in, what it should know, the window), saved
 * by the page's "Save changes", then a Test of the saved settings: the screen the agent lands on after signing in.
 */
export function ScreenshotSettings({ projectSlug, settings, aboutMax }: { projectSlug: string; settings: Settings; aboutMax: number }) {
  const id = useId();
  const [signIn, setSignIn] = useState<SignIn>(settings.signIn);
  const { state, pending, form } = useCustomizeForm({
    // Saved, they're never shown again, nor sent again: an address changed next to another site must get new ones.
    clearOnSave: ["password", "signInLink"],
    save: async (prev, formData) => {
      const result = await saveScreenshotSettings(projectSlug, prev, formData);
      if (!result.error) {
        toast.success("Screenshot settings saved");
      }
      return result;
    },
  });

  return (
    <>
      <SettingsCard title="Your app" description="Use a demo account: the agent is told only to look around and never to change anything.">
        {/* Locked while saving (see AssistantSettings). The sign-in's fields stay in the form when hidden, so "Save changes" compares them all. */}
        {/* noValidate: a hidden sign-in's field the browser finds invalid would block Save without a word; the server says what's wrong. */}
        <form {...form} inert={pending} noValidate className="flex flex-col divide-y">
          <SettingRow label="App address" description="Where the agent starts." htmlFor="screenshots-app-url">
            <Input
              id="screenshots-app-url"
              name="appUrl"
              type="url"
              placeholder="https://app.example.com"
              defaultValue={settings.appUrl ?? ""}
              aria-describedby="screenshots-app-url-description"
              className="@min-[34rem]/settings:w-72"
            />
          </SettingRow>
          <SettingRow label={<span id={`${id}-sign-in`}>Sign in</span>} description="How the agent signs in, when it isn't already.">
            <Segmented name="signIn" options={SIGN_INS} value={signIn} onValueChange={setSignIn} aria-labelledby={`${id}-sign-in`} />
          </SettingRow>
          <div hidden={signIn !== "password"} className="divide-y">
            <SettingRow label="Username" htmlFor="screenshots-username">
              <Input id="screenshots-username" name="username" autoComplete="off" defaultValue={settings.username} className="@min-[34rem]/settings:w-72" />
            </SettingRow>
            <SettingRow label="Password" description={settings.passwordSet ? "Saved. Enter a new one to replace it." : "Kept encrypted, and never shown again."} htmlFor="screenshots-password">
              <Input
                id="screenshots-password"
                name="password"
                type="password"
                autoComplete="new-password"
                placeholder={settings.passwordSet ? "••••••••" : ""}
                aria-describedby="screenshots-password-description"
                className="@min-[34rem]/settings:w-72"
              />
            </SettingRow>
          </div>
          <div hidden={signIn !== "link"}>
            <SettingRow
              label="Sign-in link"
              description={settings.signInLinkSet ? "Saved. Enter a new one to replace it." : "A link that signs in by itself, like a magic link."}
              info="Kept encrypted and never shown again. The agent is given it to open, so use one that only signs in to a demo account."
              htmlFor="screenshots-sign-in-link"
            >
              <Input
                id="screenshots-sign-in-link"
                name="signInLink"
                type="url"
                autoComplete="off"
                placeholder={settings.signInLinkSet ? "Saved" : "https://app.example.com/magic?token=…"}
                aria-describedby="screenshots-sign-in-link-description"
                className="@min-[34rem]/settings:w-72"
              />
            </SettingRow>
          </div>
          <SettingRow label={<span id={`${id}-window`}>Window</span>} description="Desktop is 1440×900, phone 390×844.">
            <Segmented name="window" options={WINDOWS} defaultValue={settings.window} aria-labelledby={`${id}-window`} />
          </SettingRow>
          <SettingRow
            label="Use a residential proxy"
            description="Only if your app blocks visits from cloud servers. Runs cost more."
            htmlFor="screenshots-residential-proxy"
            inline
          >
            <Switch id="screenshots-residential-proxy" name="residentialProxy" defaultChecked={settings.residentialProxy} aria-describedby="screenshots-residential-proxy-description" />
          </SettingRow>
          <SettingBlock className="gap-2">
            <label htmlFor="screenshots-about" className="font-medium">
              About your app
            </label>
            <p id="screenshots-about-description" className="-mt-1.5 text-sm text-muted-foreground">
              The agent reads this on every run.
            </p>
            <Textarea
              id="screenshots-about"
              name="about"
              defaultValue={settings.about}
              maxLength={aboutMax}
              rows={3}
              aria-describedby="screenshots-about-description"
              placeholder="After signing in, pick the Acme workspace. Close the welcome tour. Don't open Billing."
            />
          </SettingBlock>
          <SettingBlock className="gap-2">
            <label htmlFor="screenshots-other-domains" className="font-medium">
              Other domains your app loads from
            </label>
            <p id="screenshots-other-domains-description" className="-mt-1.5 text-sm text-muted-foreground">
              The browser only opens your app&apos;s own domain and its sign-in link&apos;s. Add any other your app needs, one per line: a CDN, an API, or a sign-in page on another host (login.example.com, acme.auth0.com), which must be listed here for the password to be entered on it.
            </p>
            <Textarea
              id="screenshots-other-domains"
              name="otherDomains"
              defaultValue={settings.otherDomains.join("\n")}
              rows={2}
              aria-describedby="screenshots-other-domains-description"
              placeholder="acme.auth0.com"
            />
            {state.error && <FieldError>{state.error}</FieldError>}
          </SettingBlock>
        </form>
      </SettingsCard>
      <TestCard projectSlug={projectSlug} settings={settings} />
    </>
  );
}

/** The Test: the agent signs in with the saved settings and shows where it lands; read again while it runs. */
function TestCard({ projectSlug, settings }: { projectSlug: string; settings: Settings }) {
  const router = useRouter();
  const [starting, startTransition] = useTransition();
  // Only a Test started here is announced: a refused one (no run) mustn't read out the last one's result.
  const [clicked, setClicked] = useState(false);
  const test = settings.test;
  const running = test?.state === "running";
  // Seen running here (started here, or before coming back to the page): its end is announced (set while rendering).
  if (running && !clicked) {
    setClicked(true);
  }
  useEffect(() => {
    if (!running) {
      return;
    }
    const timer = setInterval(() => router.refresh(), REFRESH_MS);
    return () => clearInterval(timer);
  }, [running, router]);
  const shot = test?.screenshots[0];
  const busy = running || starting;
  // Said to screen readers as it changes, in one region that's always there (one added with its text isn't always read).
  const status = !clicked ? "" : busy ? "Testing: signing in to your app." : !test ? "" : shot?.image ? `Test done: ${shot.description}` : `Test failed: ${test.error ?? shot?.failed ?? "it didn't finish."}`;

  return (
    <SettingsCard>
      <SettingRow label="Test" description="The agent signs in with what's saved and shows the screen it lands on. It takes a few minutes." inline>
        <Button
          variant="outline"
          disabled={!settings.appUrl || busy}
          focusableWhenDisabled
          onClick={() =>
            startTransition(async () => {
              setClicked(false);
              const result = await testScreenshots(projectSlug);
              if (result.error) {
                // Said by the toast.
                toast.error(result.error);
              } else {
                setClicked(true);
              }
            })
          }
        >
          {busy ? "Testing…" : "Test"}
        </Button>
        {/* In the row, not the card: the card's lines between its children would count it. */}
        <p role="status" className="sr-only">
          {status}
        </p>
      </SettingRow>
      {busy && (
        <SettingBlock>
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
            Signing in to your app. This takes a few minutes; you can leave this page.
          </p>
        </SettingBlock>
      )}
      {test && !busy && (
        <SettingBlock>
          {shot?.image ? (
            <figure className="flex flex-col gap-2">
              {/* eslint-disable-next-line @next/next/no-img-element -- a lasting media link, sized by the image */}
              <img src={shot.image.url} alt={shot.description} width={shot.image.width} height={shot.image.height} className="h-auto w-full rounded-lg ring-1 ring-border" />
              <figcaption className="text-sm text-muted-foreground">
                {shot.description}
                {shot.url && <span className="block break-all">{shot.url}</span>}
              </figcaption>
            </figure>
          ) : (
            <Alert variant="destructive">
              <AlertDescription>{test.error ?? shot?.failed ?? "The test didn't finish."}</AlertDescription>
            </Alert>
          )}
        </SettingBlock>
      )}
    </SettingsCard>
  );
}

"use client";

import { LoaderCircleIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
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
type Suggestion = { provider: string; hosts: string[] };

/** How a run that couldn't sign in starts its error (@tuti/jobs SCREENSHOT_ERRORS.signIn). */
const SIGN_IN_FAILED = "The agent couldn't sign in";
const list = (items: string[]) => new Intl.ListFormat("en", { type: "conjunction" }).format(items);

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
 * While the worker reads the app for its sign-in services: how often the page asks again, and for how long at most (a
 * read may wait its turn 2 minutes, then takes 15 seconds; one not done in 3 minutes is taken for lost).
 */
const CHECK_EVERY_MS = 2_000;
const CHECK_FOR_MS = 3 * 60_000;

/**
 * Settings → Screenshots: the team's app (its address, how the agent signs in, what it should know, the window), saved
 * by the page's "Save changes", then a Test of the saved settings: the screen the agent lands on after signing in.
 */
export function ScreenshotSettings({ projectSlug, settings, aboutMax }: { projectSlug: string; settings: Settings; aboutMax: number }) {
  const id = useId();
  const [signIn, setSignIn] = useState<SignIn>(settings.signIn);
  const otherDomains = useRef<HTMLTextAreaElement>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  /** Adds the service's hosts to Other domains, for "Save changes" (which asks for the password again). */
  const add = (suggestion: Suggestion) => {
    const field = otherDomains.current!;
    const listed = field.value.split(/[\s,]+/).filter(Boolean);
    field.value = [...listed, ...suggestion.hosts.filter((host) => !listed.includes(host))].join("\n");
    // As if typed: the form sees a change to save.
    field.dispatchEvent(new Event("input", { bubbles: true }));
    setSuggestions((all) => all.filter((other) => other !== suggestion));
    // Its button goes: focus where the hosts went.
    field.focus();
  };
  // Saves that went through: a new sign-in link isn't sent back to the page, so each one reads the suggestions again.
  const [saves, setSaves] = useState(0);
  const { state, pending, form } = useCustomizeForm({
    onSaved: () => setSaves((count) => count + 1),
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
  // What the suggestions shown were read for: busy until the answer for the settings as they are now.
  const [readFor, setReadFor] = useState<[string, number] | null>(null);
  // Found by the server from the app's page (once per address, kept): read again with every save, as what the browser
  // opens already (the domains, the sign-in link's host) may have changed.
  // Keyed on what decides them and the saves that went through (a refused one changes nothing), not the settings
  // object: a Test's refresh every few seconds makes a new one.
  const looked = JSON.stringify([settings.appUrl, settings.signIn, settings.otherDomains]);
  const loading = Boolean(settings.appUrl) && (readFor?.[0] !== looked || readFor[1] !== saves);
  // The server is reading the app (in the background): asked again every few seconds, for as long as a read can take.
  const [checking, setChecking] = useState(false);
  const waiting = Boolean(settings.appUrl) && checking;
  useEffect(() => {
    if (!settings.appUrl) {
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = CHECK_FOR_MS / CHECK_EVERY_MS;
    // The first look may start a read; the next ones only ask how it went.
    const ask = (start: boolean) =>
      fetch(`/app/${projectSlug}/settings/screenshots/suggestions${start ? "" : "?start=false"}`)
        .then((response) => (response.ok ? (response.json() as Promise<{ suggestions: Suggestion[]; checking: boolean }>) : { suggestions: [], checking: false }))
        .catch(() => ({ suggestions: [], checking: false }))
        .then((result) => {
          if (!current) {
            return;
          }
          // Not those already added to Other domains and not saved yet (a look again while checking would bring them back).
          const listed = new Set(otherDomains.current?.value.split(/[\s,]+/).filter(Boolean));
          setSuggestions(result.suggestions.filter((suggestion) => !suggestion.hosts.every((host) => listed.has(host))));
          // Still checking once it stops asking (the worker may be busy): said so, never shown as nothing found.
          setChecking(result.checking);
          setReadFor([looked, saves]);
          if (result.checking && polls-- > 0) {
            timer = setTimeout(() => void ask(false), CHECK_EVERY_MS);
          }
        });
    void ask(true);
    return () => {
      current = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `looked` stands for the settings it reads
  }, [projectSlug, looked, saves]);

  return (
    <>
      <SettingsCard title="Your app" description="Use a demo account.">
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
          <SettingRow label={<span id={`${id}-sign-in`}>Sign in</span>} description="How the agent signs in.">
            <Segmented name="signIn" options={SIGN_INS} value={signIn} onValueChange={setSignIn} aria-labelledby={`${id}-sign-in`} />
          </SettingRow>
          <div hidden={signIn !== "password"} className="divide-y">
            <SettingRow label="Username" htmlFor="screenshots-username">
              <Input id="screenshots-username" name="username" autoComplete="off" defaultValue={settings.username} className="@min-[34rem]/settings:w-72" />
            </SettingRow>
            <SettingRow label="Password" description={settings.passwordSet ? "Saved. Enter a new one to replace it." : "Stored encrypted."} htmlFor="screenshots-password">
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
              description={settings.signInLinkSet ? "Saved. Enter a new one to replace it." : "Like a magic link."}
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
            description="Only if your app blocks cloud servers. Costs more."
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
              Other domains
            </label>
            <p id="screenshots-other-domains-description" className="-mt-1.5 text-sm text-muted-foreground">
              One per line. The password may be typed on these.
            </p>
            <Textarea
              ref={otherDomains}
              id="screenshots-other-domains"
              name="otherDomains"
              defaultValue={settings.otherDomains.join("\n")}
              rows={2}
              aria-describedby="screenshots-other-domains-description"
              placeholder="acme.auth0.com"
            />
            <div className="contents" aria-busy={loading || waiting} data-suggestions>
              {!loading && waiting && <p className="text-sm text-muted-foreground">Checking how your app signs in…</p>}
              {/* Only the answer for the settings as they are: never another address's while it's read again. */}
              {!loading &&
                Boolean(settings.appUrl) &&
                suggestions.map((suggestion, index) => (
                  <div key={suggestion.provider} className="flex items-center gap-3 rounded-lg bg-muted px-3 py-2 text-sm">
                    <p id={`${id}-suggestion-${index}`} className="min-w-0 flex-1 break-words">
                      {suggestion.provider} sign-in needs {list(suggestion.hosts)}
                    </p>
                    <Button type="button" variant="outline" size="sm" className="shrink-0" aria-describedby={`${id}-suggestion-${index}`} onClick={() => add(suggestion)}>
                      Add
                    </Button>
                  </div>
                ))}
            </div>
            {state.error && <FieldError>{state.error}</FieldError>}
          </SettingBlock>
        </form>
      </SettingsCard>
      <TestCard projectSlug={projectSlug} settings={settings} suggested={!loading && suggestions.length > 0} />
    </>
  );
}

/** The Test: the agent signs in with the saved settings and shows where it lands; read again while it runs. */
function TestCard({ projectSlug, settings, suggested }: { projectSlug: string; settings: Settings; suggested: boolean }) {
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
      <SettingRow label="Test" description="Signs in and shows where it lands. Takes a few minutes." inline>
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
              <AlertDescription>
                {test.error ?? shot?.failed ?? "The test didn't finish."}
                {suggested && test.error?.startsWith(SIGN_IN_FAILED) && <span className="block">Try the suggested domains.</span>}
              </AlertDescription>
            </Alert>
          )}
        </SettingBlock>
      )}
    </SettingsCard>
  );
}

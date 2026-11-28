"use client";

import { InfoIcon, LoaderCircleIcon, XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { useCustomizeForm, useFieldChanged } from "@/components/customize-shell";
import { SettingBlock, SettingRow, SettingsCard } from "@/components/settings-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Segmented } from "@/components/ui/segmented";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import type { settingsView } from "@/server/operations/screenshots";
import { saveScreenshotSettings, testScreenshots } from "@/server/screenshots";

type Settings = Awaited<ReturnType<typeof settingsView>>;
type SignIn = Settings["signIn"];
/** A host found for the app's sign-in; `skipped` when removed (as saved: the field's own list says what's removed now). */
type Found = { host: string; provider: string; skipped: boolean };

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
// The server's SCAN_STALE_MS, which its POLL_GRACE_MS (how long a lost read still says checking) covers: raise them together.
const CHECK_FOR_MS = 3 * 60_000;

/**
 * Settings → Screenshots: the team's app (its address, how the agent signs in, what it should know, the window), saved
 * by the page's "Save changes", then a Test of the saved settings: the screen the agent lands on after signing in.
 */
export function ScreenshotSettings({ projectSlug, settings, aboutMax }: { projectSlug: string; settings: Settings; aboutMax: number }) {
  const id = useId();
  const [signIn, setSignIn] = useState<SignIn>(settings.signIn);
  const [found, setFound] = useState<Found[]>([]);
  // Saves that went through: each reads the sign-in domains again (the address may have changed).
  const [saves, setSaves] = useState(0);
  const { state, pending, form } = useCustomizeForm({
    onSaved: () => setSaves((count) => count + 1),
    // Saved, they're never shown again, nor sent again: an address changed next to another site must get new ones.
    clearOnSave: ["password", "signInLink", "domainPassword"],
    save: async (prev, formData) => {
      const result = await saveScreenshotSettings(projectSlug, prev, formData);
      if (!result.error) {
        toast.success("Screenshot settings saved");
      }
      return result;
    },
  });
  // What the domains shown were read for. Found by the server from the app's page (once per address, kept): read again
  // with every save that went through (a refused one changes nothing). Keyed on the address, not the settings object:
  // a Test's refresh makes a new one.
  const [readFor, setReadFor] = useState<string | null>(null);
  // Read for this address already: what's shown stays while a save reads it again (a removal, say); another address's never does.
  const known = readFor === settings.appUrl;
  // The server is reading the app (in the background): asked again every few seconds, for as long as a read can take.
  const [checking, setChecking] = useState(false);
  useEffect(() => {
    if (!settings.appUrl) {
      return;
    }
    let current = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let polls = CHECK_FOR_MS / CHECK_EVERY_MS;
    // The first look may start a read; the next ones only ask how it went.
    const ask = (start: boolean) =>
      fetch(`/app/${projectSlug}/settings/screenshots/sign-in-domains${start ? "" : "?start=false"}`)
        .then((response) => (response.ok ? (response.json() as Promise<{ domains: Found[]; checking: boolean }>) : null))
        .catch(() => null)
        .then((answer) => {
          if (!current) {
            return;
          }
          // A look again that failed (a deploy's restart, a dropped connection) changes nothing shown and asks again;
          // the first look's failure shows none.
          if (!answer && !start) {
            if (polls-- > 0) {
              timer = setTimeout(() => void ask(false), CHECK_EVERY_MS);
            }
            return;
          }
          const result = answer ?? { domains: [], checking: false };
          setFound(result.domains);
          // Still checking once it stops asking (the worker may be busy): said so, never shown as nothing found.
          setChecking(result.checking);
          setReadFor(settings.appUrl);
          if (result.checking && polls-- > 0) {
            timer = setTimeout(() => void ask(false), CHECK_EVERY_MS);
          }
        });
    void ask(true);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [projectSlug, settings.appUrl, saves]);

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
              Your app&apos;s API, sign-in page or CDN.
            </p>
            {/* Started again for another address: what was removed is per address (the server clears it too). */}
            <DomainField
              key={settings.appUrl}
              settings={settings}
              signIn={signIn}
              found={known ? found : []}
              checking={Boolean(settings.appUrl) && (!known || checking)}
              saves={saves}
            />
            {state.error && <FieldError>{state.error}</FieldError>}
          </SettingBlock>
        </form>
      </SettingsCard>
      <TestCard projectSlug={projectSlug} settings={settings} />
    </>
  );
}

/** A host as typed or pasted: lowercased, without a scheme, path or port. */
const hostOf = (text: string) =>
  text
    .trim()
    .toLowerCase()
    .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
    .replace(/[/:?#].*$/, "");

/**
 * Other domains as chips: those typed (otherDomains), then those found for the app's sign-in ("Auto", allowed without
 * adding them; removing one skips it, skippedDomains). Both saved by "Save changes" through hidden fields. Adding one
 * with a password saved asks for it again (the server's rule: it can be typed there), in a box under the chips.
 */
function DomainField({ settings, signIn, found, checking, saves }: { settings: Settings; signIn: SignIn; found: Found[]; checking: boolean; saves: number }) {
  const [typed, setTyped] = useState(settings.otherDomains);
  const [skipped, setSkipped] = useState(settings.skippedDomains);
  // Those saved: a domain not among them is new (after a save, what was sent).
  const [saved, setSaved] = useState(settings.otherDomains);
  const [seenSaves, setSeenSaves] = useState(saves);
  if (seenSaves !== saves) {
    setSeenSaves(saves);
    setSaved(typed);
  }
  const [draft, setDraft] = useState("");
  const typedField = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLInputElement>(null);
  // Its button gone with it: focus back in the field.
  // Each add and removal said to screen readers.
  const [said, setSaid] = useState("");
  // A check starting or new hosts found: what's found is said instead.
  const foundKey = `${checking} ${found.map(({ host }) => host).join(" ")}`;
  const [seenFound, setSeenFound] = useState(foundKey);
  if (seenFound !== foundKey) {
    setSeenFound(foundKey);
    setSaid("");
  }
  const remove = (host: string, change: () => void) => {
    change();
    setSaid(`Removed ${host}.`);
    input.current?.focus();
  };
  const skippedField = useRef<HTMLInputElement>(null);
  useFieldChanged(typedField, typed);
  useFieldChanged(skippedField, skipped);
  // Saved with another address, none are removed (the server clears them too): sent so, so what the form takes as
  // saved matches what the field starts again with (it's keyed on the address).
  useEffect(() => {
    const form = skippedField.current?.form;
    // Set on every submit, so one refused (another address, no password) leaves the next with the list again.
    const clear = () => {
      const address = form?.elements.namedItem("appUrl");
      if (skippedField.current) {
        skippedField.current.value = address instanceof HTMLInputElement && address.value.trim() !== (settings.appUrl ?? "") ? "" : skipped.join("\n");
      }
    };
    form?.addEventListener("submit", clear);
    return () => form?.removeEventListener("submit", clear);
  }, [settings.appUrl, skipped]);
  const auto = found.filter(({ host }) => !typed.includes(host) && !skipped.includes(host));
  const added = signIn === "password" && settings.passwordSet && typed.some((host) => !saved.includes(host) && !found.some((one) => one.host === host));

  const commit = (text: string) => {
    const hosts = text.split(/[\s,]+/).map(hostOf).filter(Boolean);
    // One found and removed comes back as found; any other is typed.
    setSkipped((all) => all.filter((host) => !hosts.includes(host)));
    setTyped((all) => [...new Set([...all, ...hosts.filter((host) => !skipped.includes(host))])]);
    setDraft("");
    setSaid(hosts.length > 0 ? `Added ${hosts.join(", ")}.` : "");
  };

  return (
    <>
      <input ref={typedField} type="hidden" name="otherDomains" value={typed.join("\n")} />
      <input ref={skippedField} type="hidden" name="skippedDomains" value={skipped.join("\n")} />
      <div
        className="flex min-h-9 flex-wrap items-center gap-1.5 rounded-lg border border-input bg-card p-1.5 transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/50 dark:bg-background"
        aria-busy={checking}
        data-domains
      >
        {typed.map((host) => (
          <Chip key={host} host={host} onRemove={() =>
              remove(host, () => {
                setTyped((all) => all.filter((one) => one !== host));
                // Found too (listed before it was found): removed from those as well, or it'd stay, as Auto.
                if (found.some((one) => one.host === host)) {
                  setSkipped((all) => [...all, host]);
                }
              })
            } />
        ))}
        {auto.map(({ host, provider }) => (
          <Chip key={host} host={host} provider={provider} onRemove={() => remove(host, () => setSkipped((all) => [...all, host]))} />
        ))}
        {checking && (
          <span className="inline-flex items-center gap-1.5 rounded-full border border-dashed px-2.5 py-0.5 text-xs text-muted-foreground">
            <LoaderCircleIcon aria-hidden className="size-3 animate-spin" />
            Checking sign-in
          </span>
        )}
        <input
          ref={input}
          id="screenshots-other-domains"
          // Typed but not a chip yet: still a change to save, and saved with them.
          name="otherDomainsDraft"
          value={draft}
          onChange={(event) => {
            const value = event.target.value;
            if (/[\s,]/.test(value)) {
              commit(value);
            } else {
              setDraft(value);
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && draft.trim()) {
              event.preventDefault();
              commit(draft);
            }
          }}
          onBlur={() => draft.trim() && commit(draft)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Add a domain"
          aria-describedby="screenshots-other-domains-description"
          className="h-6 min-w-36 flex-1 bg-transparent px-1 text-base outline-none placeholder:text-muted-foreground/75 md:text-sm"
        />
      </div>
      <div aria-live="polite" className="sr-only" data-domains-said>
        {checking ? "Checking how your app signs in." : said ? said : auto.length > 0 ? `Added for ${[...new Set(auto.map(({ provider }) => provider))].join(", ")} sign-in: ${auto.map(({ host }) => host).join(", ")}.` : ""}
      </div>
      {/* Always in the form, hidden when not needed (as the sign-in's fields are), so what "Save changes" compares stays the same. */}
      <div hidden={!added} className="flex flex-col gap-1.5">
        <label htmlFor="screenshots-domain-password" className="text-sm text-muted-foreground">
          Enter the password again to add a domain.
        </label>
        <Input id="screenshots-domain-password" name="domainPassword" type="password" autoComplete="current-password" className="@min-[34rem]/settings:w-72" />
      </div>
    </>
  );
}

/** A domain: typed, or found for the app's sign-in (`provider`), with an info popover saying why it was added. */
function Chip({ host, provider, onRemove }: { host: string; provider?: string; onRemove: () => void }) {
  return (
    <span className={cn("inline-flex max-w-full items-center gap-1.5 rounded-full border py-0.5 pr-0.5 pl-2.5 font-mono text-xs", provider ? "border-primary/30 bg-primary/8" : "bg-muted")}>
      <span className="min-w-0 truncate">{host}</span>
      {provider && (
        <Popover>
          <PopoverTrigger openOnHover aria-label={`Auto: why ${host} was added`} className="inline-flex items-center gap-0.5 rounded-full font-sans text-xs font-semibold text-primary outline-none focus-visible:ring-2 focus-visible:ring-ring">
            Auto
            <InfoIcon aria-hidden className="size-3" />
          </PopoverTrigger>
          <PopoverContent className="max-w-72 p-3 text-sm">
            <p className="font-medium">Added for {provider} sign-in</p>
            <p className="text-muted-foreground">Your app signs in through {provider}, so screenshots need this. Remove it if you don&apos;t.</p>
          </PopoverContent>
        </Popover>
      )}
      <button type="button" onClick={onRemove} aria-label={`Remove ${host}`} className="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <XIcon aria-hidden className="size-3" />
      </button>
    </span>
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
              </AlertDescription>
            </Alert>
          )}
        </SettingBlock>
      )}
    </SettingsCard>
  );
}

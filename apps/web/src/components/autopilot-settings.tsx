"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useActionState, useEffect, useId, useOptimistic, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { SettingRow } from "@/components/settings-card";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import { keepingFields } from "@/lib/forms";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";
import { saveAiModel } from "@/server/ai-models";
import type { FormState } from "@/server/form-state";
import { saveAutopilotRecipients, saveAutopilotSettings, setAutopilotEmails, setAutopilotSwitch } from "@/server/github";

export type AutopilotSwitchValues = Record<(typeof SWITCHES)[number][0], boolean>;

export type AutopilotSettingsValues = {
  minSure: number;
  maxReach: number;
  maxViews: number;
  holdHours: number;
};

/** Each switch's name and label. One has a hint: what it sends can't be taken back. */
const SWITCHES = [
  ["drafts", "Write drafts at once", undefined],
  ["articleEdits", "Publish article edits", undefined],
  ["progress", "Post progress updates", undefined],
  ["complete", "Complete posts", "Completing a post emails the people who asked for it."],
] as const;

/**
 * Settings → Autopilot → Checks (owners and admins, like the AI model above it): off saves "off" as the role's model,
 * on clears it, so the level's model (or Custom's) checks again. What's shown is what the page read once it's saved,
 * the same the AI model setting shows, so the two can't disagree.
 */
export function AutopilotChecksSwitch({ projectSlug, on }: { projectSlug: string; on: boolean }) {
  const [, startTransition] = useTransition();
  const [checked, setChecked] = useOptimistic(on);
  const ref = useRef<HTMLInputElement>(null);
  const was = useRef(on);
  // "off" typed in Custom's Checks box switches Checks off from there, and the box goes (its row says Off), taking
  // keyboard focus with it: focus comes here, to what switches Checks on again.
  useEffect(() => {
    if (was.current && !on && document.activeElement === document.body) {
      ref.current?.focus();
    }
    was.current = on;
  }, [on]);
  return (
    <SettingRow label="Checks" htmlFor="autopilot-checks" inline>
      <Switch
        ref={ref}
        id="autopilot-checks"
        checked={checked}
        // Not disabled while saving, which would drop keyboard focus: server actions run one at a time, in order.
        onChange={(event) => {
          const next = event.currentTarget.checked;
          startTransition(async () => {
            setChecked(next);
            const result = await saveAiModel(projectSlug, { code_changes_check: next ? "" : "off" }).catch(() => ({ error: "Couldn't save. Try again." }));
            if (result.error) {
              toast.error(result.error);
            } else {
              toast.success(`Checks: ${next ? "on" : "off"}`);
            }
          });
        }}
      />
    </SettingRow>
  );
}

/**
 * Settings → Autopilot's way to Advanced tuning, a row of its card. `upgrade`: the plan doesn't include tuning, so the
 * row looks the same, says which plan it needs to a screen reader, and opens the upgrade prompt instead of the page.
 */
export function AdvancedTuningLink({ href, upgrade }: { href: string; upgrade: UpgradePrompt | null }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const row = "flex w-full items-center gap-3 px-4 py-3.5 text-left font-medium outline-none last:rounded-b-xl hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset @min-[34rem]/settings:px-5";
  const content = (
    <>
      <span className="min-w-0 flex-1">Advanced tuning</span>
      <ChevronRightIcon aria-hidden className="size-4 text-muted-foreground" />
    </>
  );
  if (!upgrade) {
    return (
      <Link href={href} className={row}>
        {content}
      </Link>
    );
  }
  return (
    <>
      {/* Before the button, so the button is still the card's last row (its bottom corners rounded). */}
      <span id={id} hidden>
        {upgrade.title}
      </span>
      <button type="button" aria-describedby={id} aria-haspopup="dialog" onClick={() => setOpen(true)} className={row}>
        {content}
      </button>
      <UpgradeDialog prompt={upgrade} open={open} onOpenChange={setOpen} />
    </>
  );
}

/** Settings → Autopilot: what goes out by itself, each switch saved as it's flipped (owners; `owner` false: shown, not changed). */
export function AutopilotSwitches({ projectSlug, settings, owner }: { projectSlug: string; settings: AutopilotSwitchValues; owner: boolean }) {
  const [, startTransition] = useTransition();
  const [checked, setChecked] = useState(settings);
  // What's saved, and each switch's latest flip: a refused save shows what's saved, unless it was flipped again since.
  const saved = useRef(settings);
  const flips = useRef<Partial<Record<keyof AutopilotSwitchValues, number>>>({});
  // Not disabled while saving, which would drop keyboard focus: server actions run one at a time, in order.
  return SWITCHES.map(([name, label, hint]) => (
    <SettingRow key={name} label={label} description={hint} htmlFor={`autopilot-${name}`} inline>
      <Switch
        id={`autopilot-${name}`}
        checked={checked[name]}
        disabled={!owner}
        aria-describedby={hint && `autopilot-${name}-description`}
        onChange={(event) => {
          const on = event.currentTarget.checked;
          setChecked((current) => ({ ...current, [name]: on }));
          const flip = (flips.current[name] ?? 0) + 1;
          flips.current[name] = flip;
          startTransition(async () => {
            const result = await setAutopilotSwitch(projectSlug, name, on);
            if (result.error) {
              if (flips.current[name] === flip) {
                setChecked((current) => ({ ...current, [name]: saved.current[name] }));
              }
              toast.error(result.error);
            } else {
              saved.current = { ...saved.current, [name]: on };
              toast.success(`${label}: ${on ? "on" : "off"}`);
            }
          });
        }}
      />
    </SettingRow>
  ));
}

/**
 * Settings → Autopilot's limits (owners; `owner` false: shown, not changed): what always waits for
 * someone, and how long the rest waits first. One Save.
 */
export function AutopilotSettingsForm({ projectSlug, settings, owner }: { projectSlug: string; settings: AutopilotSettingsValues; owner: boolean }) {
  const [state, action, pending] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveAutopilotSettings(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Autopilot's settings saved");
    }
    return result;
  }, {});

  return (
    <form {...keepingFields(action)}>
      <fieldset disabled={pending || !owner} className="contents">
        <FieldGroup>
          <fieldset className="flex flex-col gap-3">
            <legend className="mb-1 text-sm font-medium">Always waits for someone</legend>
            <p className="text-sm text-muted-foreground">Whatever the switches, an update waits for your team when it&apos;s:</p>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="autopilot-min-sure" className="flex-1 font-normal">
                Less sure than (%)
              </FieldLabel>
              <Input id="autopilot-min-sure" name="minSure" type="number" min={50} max={100} required defaultValue={settings.minSure} className="w-24 shrink-0" />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="autopilot-max-reach" className="flex-1 font-normal">
                About a post with this many people or more (author, voters, commenters, subscribers)
              </FieldLabel>
              <Input id="autopilot-max-reach" name="maxReach" type="number" min={1} required defaultValue={settings.maxReach} className="w-24 shrink-0" />
            </Field>
            <Field orientation="horizontal">
              <FieldLabel htmlFor="autopilot-max-views" className="flex-1 font-normal">
                About an article read this often or more in 30 days
              </FieldLabel>
              <Input id="autopilot-max-views" name="maxViews" type="number" min={1} required defaultValue={settings.maxViews} className="w-24 shrink-0" />
            </Field>
          </fieldset>
          <Field orientation="horizontal">
            <div className="flex flex-1 flex-col gap-0.5">
              <FieldLabel htmlFor="autopilot-hold">The hold (hours)</FieldLabel>
              <FieldDescription>What goes out by itself waits this long first, so your team can stop it. Drafts don&apos;t wait.</FieldDescription>
            </div>
            <Input id="autopilot-hold" name="holdHours" type="number" min={0} max={336} required defaultValue={settings.holdHours} className="w-24 shrink-0" />
          </Field>
          {state.error && <FieldError>{state.error}</FieldError>}
          {owner && (
            <Button type="submit" disabled={pending} className="self-end">
              {pending ? "Saving…" : "Save"}
            </Button>
          )}
        </FieldGroup>
      </fieldset>
    </form>
  );
}

/** Settings → Autopilot → Who's told (owners change it, saved as each is ticked): owners always; admins too, or chosen team members. */
export function AutopilotRecipientsForm({
  projectSlug,
  owner,
  admins,
  members,
}: {
  projectSlug: string;
  owner: boolean;
  admins: boolean;
  /** The team past its owners: each one's name, role and whether they're told. */
  members: { userId: string; name: string; role: "ADMIN" | "MEMBER"; told: boolean }[];
}) {
  const [state, action] = useActionState<FormState, FormData>(async (prev, formData) => {
    const result = await saveAutopilotRecipients(projectSlug, prev, formData);
    if (!result.error) {
      toast.success("Who's told saved");
    }
    return result;
  }, {});
  return (
    // Saved as each box is ticked, as a switch is: the page's one Save is for its numbers.
    // Not disabled while saving, which would drop keyboard focus: each tick sends the boxes as they are, one save after another.
    <form {...keepingFields(action)} onChange={(event) => event.currentTarget.requestSubmit()}>
      <fieldset disabled={!owner} className="contents">
        <FieldGroup>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="admins" defaultChecked={admins} className="size-4 accent-primary" />
            Admins too
          </label>
          {members.length > 0 && (
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">And these people on the team</legend>
              {members.map((member) => (
                <label key={member.userId} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="told" value={member.userId} defaultChecked={member.told} className="size-4 accent-primary" />
                  {member.name}
                  <span className="text-muted-foreground">{member.role === "ADMIN" ? "Admin" : "Member"}</span>
                </label>
              ))}
            </fieldset>
          )}
          {state.error && <FieldError>{state.error}</FieldError>}
        </FieldGroup>
      </fieldset>
    </form>
  );
}

/** Account → Autopilot's email: as each change is analysed, a daily digest, or off. Saved as it's picked. */
/** Where the browser says they are; null on the server (it can't know). */
const browserZone = () => Intl.DateTimeFormat().resolvedOptions().timeZone;
const noSubscribe = () => () => {};

export function AutopilotEmailsChoice({ choice, timeZone }: { choice: "AS_THEY_HAPPEN" | "DIGEST" | "OFF"; timeZone: string | null }) {
  const [pending, startTransition] = useTransition();
  const here = useSyncExternalStore(noSubscribe, browserZone, () => null);
  // The digest's time zone as saved: shown, so someone who moved sees it's not where they are now.
  const [zone, setZone] = useState(timeZone);
  const [givenZone, setGivenZone] = useState(timeZone);
  // What's saved: a choice that isn't (signed out meanwhile, say) goes back to it.
  const [saved, setSaved] = useState(choice);
  const [picked, setPicked] = useState(choice);
  // Changed elsewhere (another tab) and the page refreshed: that's what's saved now, unless a save here is on its way.
  const [given, setGiven] = useState(choice);
  if (given !== choice && !pending) {
    setGiven(choice);
    setSaved(choice);
    setPicked(choice);
  }
  // Likewise its time zone, saved again elsewhere.
  if (givenZone !== timeZone && !pending) {
    setGivenZone(timeZone);
    setZone(timeZone);
  }
  const pick = (value: typeof choice) => {
    setPicked(value);
    startTransition(async () => {
      // The digest comes in the morning where they are: the time zone their browser reports.
      const result = await setAutopilotEmails(value, browserZone());
      if (result.error) {
        setPicked(saved);
        toast.error(result.error);
      } else {
        setSaved(value);
        if (value === "DIGEST") {
          setZone(browserZone());
        }
        toast.success("Saved");
      }
    });
  };
  return (
    <fieldset disabled={pending} className="flex flex-col gap-2">
      <legend className="sr-only">Autopilot&apos;s email</legend>
      {(
        [
          ["AS_THEY_HAPPEN", "As they happen", "An email when a merged pull request has updates (several merged within ten minutes in one)."],
          [
            "DIGEST",
            "A daily digest",
            `One email at 8 am${picked === "DIGEST" && zone ? ` (${zone})` : ""} with everything still waiting for you; none on a day with nothing.${picked === "DIGEST" && zone && here && here !== zone ? ` Pick it again to use ${here}.` : ""}`,
          ],
          ["OFF", "Off", "None. If you own a project, you still hear what goes out by itself."],
        ] as const
      ).map(([value, label, description]) => (
        <label key={value} className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="autopilotEmails"
            value={value}
            checked={picked === value}
            className="mt-0.5 size-4 accent-primary"
            onChange={() => pick(value)}
            // The digest picked again (moved since): saved again, with where their browser says they are now.
            onClick={() => value === "DIGEST" && picked === value && pick(value)}
          />
          <span className="flex flex-col">
            <span className="font-medium">{label}</span>
            <span className="text-muted-foreground">{description}</span>
          </span>
        </label>
      ))}
    </fieldset>
  );
}

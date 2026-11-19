"use client";

import { cn } from "cn";
import { ChevronRightIcon, PlusIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useOptimistic, useRef, useState, useSyncExternalStore, useTransition } from "react";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { SettingBlock, SettingRow } from "@/components/settings-card";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { UpgradeDialog } from "@/components/upgrade-dialog";
import type { UpgradePrompt } from "@/lib/upgrade-prompt";
import { saveAiModel } from "@/server/ai-models";
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
  ["drafts", "Write drafts", undefined],
  ["articleEdits", "Publish article edits", undefined],
  ["progress", "Post progress updates", undefined],
  ["complete", "Complete posts", "Emails the people who asked."],
] as const;

const CHECKS_DOES = "Reviews every article edit and double-checks new articles. Off, edits written from then on wait for your team.";

/**
 * Settings → Autopilot → Checks (owners and admins, like the AI model above it): off saves "off" as the role's model,
 * on clears it, so the level's model (or Custom's) checks again. What's shown is what the page read once it's saved,
 * the same the AI model setting shows, so the two can't disagree. It says what it does (docs/plan.md, E5) and what off
 * means, with a review's price when known (`price`).
 */
export function AutopilotChecksSwitch({ projectSlug, on, price }: { projectSlug: string; on: boolean; price: string | null }) {
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
    <SettingRow
      label="Check its own edits"
      htmlFor="autopilot-checks"
      inline
      info={CHECKS_DOES}
      // What it does is behind the ⓘ, and still read out with the switch; a review's price stays in sight.
      description={
        <>
          <span className="sr-only">{CHECKS_DOES} </span>
          {price}
        </>
      }
    >
      <Switch
        ref={ref}
        id="autopilot-checks"
        aria-describedby="autopilot-checks-description"
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
 * The limits: each a row that reads as a sentence, its unit in the field. `info`: what takes longer to say. `field`:
 * the field's width and the room kept for its unit, so the largest number it takes shows whole beside it.
 */
const LIMITS = [
  { name: "minSure", id: "autopilot-min-sure", label: "It's less sure than", unit: "%", min: 50, max: 100, field: "w-28 pr-8", info: undefined },
  { name: "maxReach", id: "autopilot-max-reach", label: "A post has at least", unit: "people", min: 1, max: undefined, field: "w-36 pr-16", info: "Its author, voters, commenters and subscribers." },
  { name: "maxViews", id: "autopilot-max-views", label: "An article has at least", unit: "reads / 30 days", min: 1, max: undefined, field: "w-52 pr-28", info: undefined },
  {
    name: "holdHours",
    id: "autopilot-hold",
    label: "Hold before anything goes out",
    unit: "hours",
    min: 0,
    max: 336,
    field: "w-28 pr-16",
    info: "What goes out by itself waits this long first, so your team can stop it. Drafts don't wait.",
  },
] as const;

function LimitRows({ settings, disabled, error }: { settings: AutopilotSettingsValues; disabled: boolean; error?: string }) {
  return (
    <>
      {LIMITS.map(({ name, id, label, unit, min, max, field, info }) => (
        // Beside its label on phones too: the row reads as one sentence ("A post has at least 25 people").
        <SettingRow key={name} label={label} htmlFor={id} info={info} inline>
          <span className="relative block">
            <Input
              id={id}
              name={name}
              type="number"
              inputMode="numeric"
              min={min}
              max={max}
              required
              disabled={disabled}
              defaultValue={settings[name]}
              aria-describedby={`${id}-unit`}
              aria-invalid={error ? true : undefined}
              // No arrows in the field: they'd take the room its number needs (the arrow keys still step it).
              className={cn("[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none", field)}
            />
            <span id={`${id}-unit`} className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-sm text-muted-foreground">
              {unit}
            </span>
          </span>
        </SettingRow>
      ))}
      {error && (
        <SettingBlock>
          <FieldError>{error}</FieldError>
        </SettingBlock>
      )}
    </>
  );
}

/**
 * Settings → Autopilot's limits (owners; `owner` false: shown, not changed, and no form for "Save changes" to wait
 * on): what always waits for someone, and how long the rest waits first. Saved by the page's "Save changes".
 */
export function AutopilotSettingsForm({ projectSlug, settings, owner }: { projectSlug: string; settings: AutopilotSettingsValues; owner: boolean }) {
  return owner ? <LimitsForm projectSlug={projectSlug} settings={settings} /> : <LimitRows settings={settings} disabled />;
}

function LimitsForm({ projectSlug, settings }: { projectSlug: string; settings: AutopilotSettingsValues }) {
  const { state, pending, form } = useCustomizeForm({
    save: async (prev, formData) => {
      const result = await saveAutopilotSettings(projectSlug, prev, formData);
      if (!result.error) {
        toast.success("Autopilot's settings saved");
      }
      return result;
    },
  });
  return (
    // Locked while saving. `inert`, not disabled fields: those would drop out of what the form holds, which "Save
    // changes" compares with what's saved.
    <form {...form} inert={pending} className="flex flex-col divide-y">
      <LimitRows settings={settings} disabled={false} error={state.error} />
    </form>
  );
}

/**
 * Settings → Autopilot → Emails (owners change it, saved as each changes): owners always; admins too, by their switch;
 * and the team members picked, as chips, with "Add" listing the rest.
 */
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
  const [, startTransition] = useTransition();
  const [picked, setPicked] = useState(() => ({ admins, told: members.filter((member) => member.told).map((member) => member.userId) }));
  // What's saved, and the latest change: a refused save shows what's saved, unless something changed again since.
  const saved = useRef(picked);
  const changes = useRef(0);
  const add = useRef<HTMLButtonElement>(null);
  // Not disabled while saving, which would drop keyboard focus: each change sends all of it, one save after another.
  const save = (next: typeof picked) => {
    setPicked(next);
    const change = ++changes.current;
    const formData = new FormData();
    if (next.admins) {
      formData.set("admins", "on");
    }
    for (const userId of next.told) {
      formData.append("told", userId);
    }
    startTransition(async () => {
      const result = await saveAutopilotRecipients(projectSlug, {}, formData).catch(() => ({ error: "Couldn't save. Try again." }));
      if (result.error) {
        if (changes.current === change) {
          setPicked(saved.current);
        }
        toast.error(result.error);
      } else {
        saved.current = next;
        toast.success("Emails saved");
      }
    });
  };
  const told = members.filter((member) => picked.told.includes(member.userId));
  const rest = members.filter((member) => !picked.told.includes(member.userId));
  return (
    <>
      <SettingRow label="Owners" info="Owners always hear when something customers see goes out by itself. Everyone picks how often they get these emails in their account settings." inline>
        <span className="text-sm text-muted-foreground">Always</span>
      </SettingRow>
      <SettingRow label="Admins" htmlFor="autopilot-tell-admins" inline>
        <Switch id="autopilot-tell-admins" checked={picked.admins} disabled={!owner} onChange={(event) => save({ ...picked, admins: event.currentTarget.checked })} />
      </SettingRow>
      {members.length > 0 && (
        <SettingRow label="Others">
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 @min-[34rem]/settings:max-w-[26rem] @min-[34rem]/settings:justify-end">
            <ul aria-label="Others who get Autopilot's emails" className="contents">
              {told.map((member) => (
                <li key={member.userId} className={cn("flex max-w-full items-center gap-0.5 rounded-2xl bg-muted py-0.5 pl-2.5 text-sm", owner ? "pr-0.5" : "pr-2.5")}>
                  <span className="min-w-0 break-words">{member.name}</span>
                  {owner && (
                    <button
                      type="button"
                      aria-label={`Remove ${member.name}`}
                      className="flex size-6 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      onClick={() => {
                        save({ ...picked, told: picked.told.filter((userId) => userId !== member.userId) });
                        // Its button is gone: focus goes to Add, not to the top of the page.
                        add.current?.focus();
                      }}
                    >
                      <XIcon aria-hidden className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!owner && told.length === 0 && <span className="text-sm text-muted-foreground">No one</span>}
            {owner && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  // Focusable with no one left to add (removing a chip sends focus here).
                  render={<Button ref={add} type="button" variant="outline" size="sm" className="rounded-full" disabled={rest.length === 0} focusableWhenDisabled />}
                  aria-label="Add someone to Autopilot's emails"
                >
                  <PlusIcon />
                  Add
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-max">
                  {rest.map((member) => (
                    <DropdownMenuItem key={member.userId} onClick={() => save({ ...picked, told: [...picked.told, member.userId] })}>
                      {member.name}{" "}
                      <span className="text-muted-foreground">{member.role === "ADMIN" ? "Admin" : "Member"}</span>
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </SettingRow>
      )}
    </>
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

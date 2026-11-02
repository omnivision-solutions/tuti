"use client";

import { cn } from "cn";
import { type ReactNode, useRef, useState } from "react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { setEmailPreference } from "@/server/email-preferences";

type Setting = "ownPosts" | "followedPosts" | "changelog" | "unsubscribed";

/** A portal's Account: which of the project's emails the signed-in person gets, each switch saved at once. */
export function EmailSettings({
  projectSlug,
  projectName,
  saved,
  notice,
  canStop = true,
  changelog = true,
  posts = true,
}: {
  projectSlug: string;
  projectName: string;
  saved: Record<Setting, boolean>;
  /** Above the switches: what's still needed for these emails to come (confirming the address). */
  notice?: ReactNode;
  /** Whether they may turn the project's emails off: only with an address they've proven (the opt-out counts against it). */
  canStop?: boolean;
  /** Whether the changelog is emailed here at all (a private portal's isn't): its switch only then. */
  changelog?: boolean;
  /** Whether the project emails them about posts (not its team): those switches only then. */
  posts?: boolean;
}) {
  const [settings, setSettings] = useState(saved);
  // What the switches show, what the server has, and the saves, one after another: each sends the latest choice
  // when its turn comes, so the last click is what's saved. Clicks per switch, so a failed save knows if one came since.
  const latest = useRef(saved);
  const confirmed = useRef(saved);
  const saves = useRef(Promise.resolve());
  const clicks = useRef<Record<Setting, number>>({ ownPosts: 0, followedPosts: 0, changelog: 0, unsubscribed: 0 });

  const show = (setting: Setting, on: boolean) => {
    latest.current = { ...latest.current, [setting]: on };
    setSettings(latest.current);
  };

  const change = (setting: Setting, on: boolean) => {
    show(setting, on);
    const click = ++clicks.current[setting];
    const changelogClicks = clicks.current.changelog;
    saves.current = saves.current.then(async () => {
      const wanted = latest.current[setting];
      if (wanted === confirmed.current[setting]) {
        return;
      }
      let result: Awaited<ReturnType<typeof setEmailPreference>>;
      try {
        result = await setEmailPreference(projectSlug, setting, wanted);
      } catch {
        result = { error: "Couldn't save your email settings. Try again." };
      }
      const { error } = result;
      if (!error) {
        confirmed.current = { ...confirmed.current, [setting]: wanted };
        // Stopping emails or not changes whether the changelog reaches them: what the server has now, so a click on it
        // since is saved against that next; shown as the server says unless it was clicked since this save was queued.
        if (result.changelog !== undefined) {
          confirmed.current = { ...confirmed.current, changelog: result.changelog };
          if (clicks.current.changelog === changelogClicks) {
            show("changelog", result.changelog);
          }
        }
        toast.success("Email settings saved");
        return;
      }
      toast.error(error);
      // Back to what's saved, unless they've clicked it again since (that choice is saved next).
      if (clicks.current[setting] === click) {
        show(setting, confirmed.current[setting]);
      }
    });
  };

  const row = (setting: Setting, label: string, description: string, disabled = false) => (
    <div className="flex items-start justify-between gap-4">
      <div className="flex flex-col gap-0.5">
        {/* Greyed with its switch (while "Email me nothing" is on, nothing it names is sent), still readable. */}
        <label htmlFor={`email-${setting}`} className={cn("text-sm font-medium", disabled && "text-muted-foreground")}>
          {label}
        </label>
        <p id={`email-${setting}-description`} className="text-sm text-muted-foreground">
          {description}
        </p>
      </div>
      <Switch
        id={`email-${setting}`}
        aria-describedby={`email-${setting}-description`}
        className="mt-0.5"
        checked={setting === "unsubscribed" ? settings.unsubscribed : settings[setting] && !settings.unsubscribed}
        // Not while saving: a switch disabled under the keyboard loses its focus. Each saves only itself.
        disabled={disabled}
        onChange={(event) => change(setting, event.currentTarget.checked)}
      />
    </div>
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>
          <h2>Emails</h2>
        </CardTitle>
        <CardDescription>What {projectName} emails you about.</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {notice}
        {/* Reply emails go only to a post's voters (reply-email.ts); writing a post votes for it. */}
        {posts && row("ownPosts", "Posts I wrote", "When they ship, and the team's replies emailed to voters (writing one votes for it).", settings.unsubscribed)}
        {posts &&
          row("followedPosts", "Posts I voted on or follow", "When they ship, and, for ones you voted on, the team's replies emailed to voters.", settings.unsubscribed)}
        {/* Its subscription at their address, confirmed at once: so only with an address they've proven, as stopping. */}
        {changelog && row("changelog", "The changelog", `The entries ${projectName} emails to subscribers.`, settings.unsubscribed || !canStop)}
        {/* The opt-out covers emails about posts (audienceReach) and the changelog's (changelogReach): support replies and sign-in emails don't read it. */}
        {/* The team's too: it's what stops their changelog emails (they get none about posts), and their way back from it. */}
        {row(
          "unsubscribed",
          `Email me nothing from ${projectName}`,
          posts
            ? "None of the emails above, whatever you follow. Replies to your messages, sign-in emails and notices that you've been let into its private portal still arrive."
            : "No changelog emails, whatever's subscribed at your address. Your team's emails and sign-in emails still arrive.",
          // Already stopped, it can still be turned back on.
          !canStop && !settings.unsubscribed,
        )}
      </CardContent>
    </Card>
  );
}

"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { setEmailPreference } from "@/server/email-preferences";

type Setting = "ownPosts" | "followedPosts" | "unsubscribed";

/** A portal's Account: which of the project's emails the signed-in person gets, each switch saved at once. */
export function EmailSettings({ projectSlug, projectName, saved }: { projectSlug: string; projectName: string; saved: Record<Setting, boolean> }) {
  const [settings, setSettings] = useState(saved);
  // What the switches show, what the server has, and the saves, one after another: each sends the latest choice
  // when its turn comes, so the last click is what's saved. Clicks per switch, so a failed save knows if one came since.
  const latest = useRef(saved);
  const confirmed = useRef(saved);
  const saves = useRef(Promise.resolve());
  const clicks = useRef<Record<Setting, number>>({ ownPosts: 0, followedPosts: 0, unsubscribed: 0 });

  const show = (setting: Setting, on: boolean) => {
    latest.current = { ...latest.current, [setting]: on };
    setSettings(latest.current);
  };

  const change = (setting: Setting, on: boolean) => {
    show(setting, on);
    const click = ++clicks.current[setting];
    saves.current = saves.current.then(async () => {
      const wanted = latest.current[setting];
      if (wanted === confirmed.current[setting]) {
        return;
      }
      let error: string | undefined;
      try {
        error = (await setEmailPreference(projectSlug, setting, wanted)).error;
      } catch {
        error = "Couldn't save your email settings. Try again.";
      }
      if (!error) {
        confirmed.current = { ...confirmed.current, [setting]: wanted };
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
        <label htmlFor={`email-${setting}`} className="text-sm font-medium">
          {label}
        </label>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={`email-${setting}`}
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
        {/* Reply emails go only to a post's voters (reply-email.ts); writing a post votes for it. */}
        {row("ownPosts", "Posts I wrote", "When they ship, and the team's replies emailed to voters (writing one votes for it).", settings.unsubscribed)}
        {row("followedPosts", "Posts I voted on or follow", "When they ship, and, for ones you voted on, the team's replies emailed to voters.", settings.unsubscribed)}
        {row("unsubscribed", `Stop all emails from ${projectName}`, "No emails about posts from this project, whatever you follow.")}
      </CardContent>
    </Card>
  );
}

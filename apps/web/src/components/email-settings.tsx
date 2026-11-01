"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { setEmailPreference } from "@/server/email-preferences";

type Setting = "ownPosts" | "followedPosts" | "unsubscribed";

/** A portal's Account: which of the project's emails the signed-in person gets, each switch saved at once. */
export function EmailSettings({ projectSlug, projectName, saved }: { projectSlug: string; projectName: string; saved: Record<Setting, boolean> }) {
  const [settings, setSettings] = useState(saved);
  const [pending, startTransition] = useTransition();

  const change = (setting: Setting, on: boolean) => {
    setSettings((current) => ({ ...current, [setting]: on }));
    startTransition(async () => {
      const result = await setEmailPreference(projectSlug, setting, on);
      if (result.error) {
        setSettings((current) => ({ ...current, [setting]: !on }));
        toast.error(result.error);
      } else {
        toast.success("Email settings saved");
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
        disabled={pending || disabled}
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
        {row("ownPosts", "Posts I wrote", "When they ship, or the team emails you a reply.", settings.unsubscribed)}
        {row("followedPosts", "Posts I voted on or follow", "When they ship, or the team emails you a reply.", settings.unsubscribed)}
        {row("unsubscribed", `Stop all emails from ${projectName}`, "Nothing from this project, whatever you follow.")}
      </CardContent>
    </Card>
  );
}

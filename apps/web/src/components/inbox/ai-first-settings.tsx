"use client";

import { useRouter } from "next/navigation";
import { toast } from "sonner";

import { useCustomizeForm } from "@/components/customize-shell";
import { SettingRow, SettingsCard } from "@/components/settings-card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FieldError } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { errorMessage, useTRPCClient } from "@/components/trpc";
import type { AiFirstSettings as Settings } from "@/server/operations/ai-first";

/** What keeps the AI from answering, in words. */
export const OFF_FOR: Record<Settings["offFor"][number], string> = {
  no_ai_answers: "This server has no AI answers",
  no_articles: "No published articles",
  out_of_credits: "Out of AI credits",
};

/**
 * Settings → Workflows → AI answers first (docs/plan.md, Inbox automation, W14): what keeps it off right now, then its
 * switches for the widget and email and the name its emails come from, saved with the page's "Save changes".
 */
export function AiFirstSettings({ projectSlug, projectName, settings, maxName }: { projectSlug: string; projectName: string; settings: Settings; maxName: number }) {
  const trpc = useTRPCClient();
  const router = useRouter();
  const { state, pending, form } = useCustomizeForm({
    save: async (_prev, formData) => {
      try {
        await trpc.aiFirst.update.mutate({ project: projectSlug, widget: formData.get("widget") === "on", email: formData.get("email") === "on", name: String(formData.get("name") ?? "") });
      } catch (error) {
        return { error: errorMessage(error) };
      }
      toast.success("AI answers first saved");
      router.refresh();
      return {};
    },
  });
  return (
    <>
      {settings.offFor.length > 0 && (
        <Alert role="status">
          <AlertTitle>Off for now</AlertTitle>
          <AlertDescription>{settings.offFor.map((reason) => OFF_FOR[reason]).join(" · ")}</AlertDescription>
        </Alert>
      )}
      <form {...form} inert={pending} className="flex flex-col gap-2">
        <SettingsCard>
          <SettingRow label="Widget" htmlFor="ai-first-widget" inline>
            <Switch id="ai-first-widget" name="widget" defaultChecked={settings.widget} />
          </SettingRow>
          <SettingRow label="Email" htmlFor="ai-first-email" inline>
            <Switch id="ai-first-email" name="email" defaultChecked={settings.email} />
          </SettingRow>
          <SettingRow label="Name on emails" htmlFor="ai-first-name" inline>
            <Input id="ai-first-name" name="name" defaultValue={settings.name ?? ""} maxLength={maxName} placeholder={projectName} autoComplete="off" className="w-28 @min-[20rem]/settings:w-40" />
          </SettingRow>
        </SettingsCard>
        {state.error && <FieldError>{state.error}</FieldError>}
      </form>
    </>
  );
}

"use client";

import Link from "next/link";

import { useBrandingForm } from "@/components/branding-settings";
import { SettingBlock, SettingsCard } from "@/components/settings-card";
import { FieldError } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/**
 * Customize → Custom code (see branding.update's customCss and customHtml): CSS for every portal
 * page, shown in the preview as it's typed; HTML for the end of each page, which only runs where the
 * portal is on the team's own domain or site (`ownAddress`: where that is now, or null). One card, a block each
 * (docs/design.md → Settings rows).
 */
export function CustomCodeSettings({
  projectSlug,
  css,
  html,
  max,
  ownAddress,
}: {
  projectSlug: string;
  css: string;
  html: string;
  max: number;
  ownAddress: string | null;
}) {
  const text = (data: FormData, name: string) => String(data.get(name) ?? "");
  const { state, form } = useBrandingForm(
    projectSlug,
    "Custom code saved",
    (data) => ({ customCss: text(data, "customCss") }),
    false,
    (data) => ({ customCss: text(data, "customCss"), customHtml: text(data, "customHtml") }),
  );
  const code = "font-mono text-xs";
  return (
    <form {...form} className="flex flex-col gap-4">
      <SettingsCard>
        <SettingBlock className="gap-2.5 py-3.5">
          <label htmlFor="custom-css" className="font-medium">
            <span className="sr-only">Custom </span>CSS
          </label>
          <Textarea id="custom-css" name="customCss" defaultValue={css} maxLength={max} rows={10} spellCheck={false} placeholder={".portal-header { border-bottom: 0; }"} className={code} />
        </SettingBlock>
        <SettingBlock className="gap-2.5 py-3.5">
          <div>
            <label htmlFor="custom-html" className="font-medium">
              <span className="sr-only">Custom </span>HTML
            </label>{" "}
            <span className="text-muted-foreground">
              <span aria-hidden>· </span>
              <span id="custom-html-where">end of every page</span>
            </span>
          </div>
          <Textarea
            id="custom-html"
            name="customHtml"
            defaultValue={html}
            maxLength={max}
            rows={10}
            spellCheck={false}
            placeholder={'<script async src="https://analytics.example.com/script.js"></script>'}
            aria-describedby="custom-html-where custom-html-runs"
            className={code}
          />
          <p id="custom-html-runs" className="text-sm text-muted-foreground">
            {ownAddress ? (
              <>Runs on <span className="break-all">{ownAddress.replace(/^https?:\/\//, "")}</span>, not in this preview.</>
            ) : (
              <>
                Runs only on your own domain.{" "}
                <Link href={`/app/${projectSlug}/settings/domain`} className="text-primary underline underline-offset-4">
                  Add a domain
                </Link>
              </>
            )}
          </p>
        </SettingBlock>
      </SettingsCard>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

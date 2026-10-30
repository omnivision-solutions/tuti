"use client";

import Link from "next/link";

import { useBrandingForm } from "@/components/branding-settings";
import { CustomizeSection } from "@/components/customize-shell";
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

/**
 * Customize → Custom code (see branding.update's customCss and customHtml): CSS for every portal
 * page, shown in the preview as it's typed; HTML for the end of each page, which only runs where the
 * portal is on the team's own domain or site (`ownAddress`: where that is now, or null).
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
  const { state, form } = useBrandingForm(projectSlug, "Custom code saved", (data) => ({ customCss: String(data.get("customCss") ?? "") }));
  const code = "font-mono text-xs";
  return (
    <form {...form} className="flex flex-col gap-6">
      <input type="hidden" name="part" value="code" />
      <CustomizeSection title="CSS" description="Added after Tuti's own styles on every page of your portal and docs. It shows in the preview as you type.">
        <Field>
          <FieldLabel htmlFor="custom-css" className="sr-only">
            Custom CSS
          </FieldLabel>
          <Textarea id="custom-css" name="customCss" defaultValue={css} maxLength={max} rows={10} spellCheck={false} placeholder={".portal-header { border-bottom: 0; }"} className={code} />
        </Field>
      </CustomizeSection>
      <CustomizeSection title="HTML" description="Added at the end of every page, scripts too: analytics, a chat widget.">
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="custom-html" className="sr-only">
              Custom HTML
            </FieldLabel>
            <Textarea
              id="custom-html"
              name="customHtml"
              defaultValue={html}
              maxLength={max}
              rows={10}
              spellCheck={false}
              placeholder={'<script async src="https://analytics.example.com/script.js"></script>'}
              className={code}
            />
            <FieldDescription>
              It only runs where your portal is on your own address, so it runs on your site rather than a Tuti one; not in this preview.{" "}
              {ownAddress ? (
                <>It runs on {ownAddress.replace(/^https?:\/\//, "")}.</>
              ) : (
                <>
                  Your portal isn&apos;t on one yet:{" "}
                  <Link href={`/app/${projectSlug}/settings/domain`} className="text-primary underline underline-offset-4">
                    add a domain or a sub-folder
                  </Link>
                  .
                </>
              )}
            </FieldDescription>
          </Field>
        </FieldGroup>
      </CustomizeSection>
      {state.error && <FieldError>{state.error}</FieldError>}
    </form>
  );
}

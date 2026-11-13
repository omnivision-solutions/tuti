"use client";

import type { ReactNode } from "react";

import { PortalPreview, usePreviewPage } from "@/components/customize-shell";
import { Pane, PaneHeader } from "@/components/pane";
import { Button } from "@/components/ui/button";
import { portalPage } from "@/lib/portal-pages";

/**
 * A Portal page of Settings (lib/portal-pages.ts): one pane, titled by the page with "Save changes" in its header, its
 * settings in a column and beside it the portal they change, live in a frame (PortalPreview: as a
 * desktop or a phone shows it, in light or dark mode, changes showing as they're made), or a preview of its own
 * (`custom`). From 61rem of the shell each side scrolls on its own; with less room the preview comes after the
 * settings, and on phones the page scrolls with the header held at the top. Leaving with changes not saved asks first.
 */
export function PortalSettingsPane({
  page,
  preview,
  children,
}: {
  /** The page's slug (lib/portal-pages.ts). */
  page: string;
  /** The portal page to show (`portalPreview`): `origin`, its Tuti address; `path`, the page; `address`, where readers find it, for the address bar. Or something of its own to show. */
  preview: { origin: string; path: string; address: string; token?: string } | { custom: ReactNode };
  children: ReactNode;
}) {
  const { title, description } = portalPage(page);
  const { provider, leaveDialog, version, draft, hasForms, dirty, pending, save } = usePreviewPage(title);
  return provider(
    // On phones the page scrolls, not the pane: its header (and "Save changes") sticks under the app's bar.
    <Pane aria-label={title} className="@max-[48rem]/app:overflow-visible">
      <div className="sticky top-12 z-10 rounded-t-2xl bg-card topbar:top-0">
        <PaneHeader
          title={title}
          description={description}
          actions={
            hasForms && (
              <Button type="button" disabled={!dirty || pending} focusableWhenDisabled onClick={save}>
                {pending ? "Saving…" : "Save changes"}
              </Button>
            )
          }
        />
      </div>
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto @min-[61rem]/app:flex-row @min-[61rem]/app:overflow-hidden">
        {/* Positioned: hidden file inputs (sr-only, absolute) scroll with it rather than stretching the page. */}
        <div data-slot="portal-settings" className="relative flex shrink-0 flex-col gap-6 border-b p-4 *:shrink-0 @min-[61rem]/app:w-76 @min-[61rem]/app:overflow-y-auto @min-[61rem]/app:border-r @min-[61rem]/app:border-b-0 @min-[72rem]/app:w-96 @min-[84rem]/app:w-[26rem]">
          {children}
        </div>
        {"custom" in preview ? (
          <div className="flex min-h-[32rem] min-w-0 flex-1 flex-col bg-muted/40 p-4 @min-[61rem]/app:min-h-0 @min-[61rem]/app:overflow-y-auto">{preview.custom}</div>
        ) : (
          <PortalPreview version={version} draft={draft} {...preview} />
        )}
      </div>
      {leaveDialog}
    </Pane>,
  );
}

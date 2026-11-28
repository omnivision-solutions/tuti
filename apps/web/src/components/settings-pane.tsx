"use client";

import { cn } from "cn";
import type { ReactNode } from "react";

import { usePreviewPage } from "@/components/customize-shell";
import { Pane, PaneBody, PaneHeader } from "@/components/pane";
import { InOrderProvider } from "@/components/trpc";
import { Button } from "@/components/ui/button";

/**
 * A settings page (Settings', beside its section pane): a pane titled by the page, `description` one short line beside
 * the title (above the cards where the header has no room for it, under 56rem; one with a link or more to say than a
 * line, given as elements, always above the cards), then its cards in one centred column. `back`: the page it's a
 * part of (Advanced tuning's Autopilot).
 * A page with forms (useCustomizeForm) gets "Save changes" in its header, the one Save on the page: enabled once
 * something differs from what's saved, and leaving with changes not saved asks first, as on Portal pages. Its saves
 * share one queue (InOrderProvider), the page's: they land in the order made, and a new page starts a fresh one.
 */
export function SettingsPane({
  title,
  description,
  back,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  back?: { href: string; label: ReactNode };
  actions?: ReactNode;
  children: ReactNode;
}) {
  const short = typeof description === "string";
  const { provider, leaveDialog, hasForms, dirty, pending, save } = usePreviewPage(title);
  return provider(
    <InOrderProvider>
    <Pane aria-label={title}>
      <PaneHeader
        title={title}
        description={short ? description : undefined}
        back={back}
        actions={
          (actions || hasForms) && (
            <>
              {actions}
              {hasForms && (
                <Button type="button" disabled={!dirty || pending} focusableWhenDisabled onClick={save}>
                  {pending ? "Saving…" : "Save changes"}
                </Button>
              )}
            </>
          )
        }
      />
      <PaneBody className="p-4 @min-[48rem]/app:px-6 @min-[48rem]/app:py-7">
        <div className="mx-auto flex max-w-3xl flex-col gap-7">
          {description && <p className={cn("-mb-3 text-sm text-muted-foreground", short && "@min-[56rem]/app:hidden")}>{description}</p>}
          {children}
        </div>
      </PaneBody>
      {leaveDialog}
    </Pane>
    </InOrderProvider>,
  );
}

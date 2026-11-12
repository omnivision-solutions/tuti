import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * Settings as row cards (docs/design.md → Panes): a group's title, then one card of `SettingRow`s divided by lines.
 * No cards inside it.
 */
export function SettingsCard({ title, description, children, className }: { title?: ReactNode; description?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title && (
        <div className="flex flex-col">
          <h2 className="text-base font-semibold">{title}</h2>
          {description && <p className="text-sm text-muted-foreground">{description}</p>}
        </div>
      )}
      <div className="@container/settings flex flex-col divide-y rounded-xl bg-card ring-1 ring-border">{children}</div>
    </section>
  );
}

/**
 * One setting: its label and a line on what it does on the left, its control on the right. In a card under 34rem wide
 * (phones) the control goes under them at the card's width, so the line isn't squeezed a word a row; `inline` keeps a
 * short control (a switch, a button) on the right there too. `htmlFor`: the control's id, labelled by the label; the
 * description is `<htmlFor>-description`, for the control's `aria-describedby`.
 */
export function SettingRow({ label, description, htmlFor, inline = false, children }: { label: ReactNode; description?: ReactNode; htmlFor?: string; inline?: boolean; children: ReactNode }) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div data-slot="setting-row" className={cn("flex gap-x-5 gap-y-2.5 px-4 py-3.5 @min-[34rem]/settings:flex-row @min-[34rem]/settings:items-center @min-[34rem]/settings:px-5", inline ? "items-center" : "flex-col")}>
      <div className="flex min-w-0 flex-1 flex-col">
        <Label htmlFor={htmlFor} className="font-medium">
          {label}
        </Label>
        {description && (
          <p id={htmlFor && `${htmlFor}-description`} className="text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className={cn("flex shrink-0 items-center gap-2", !inline && "@max-[34rem]/settings:*:w-full @max-[34rem]/settings:*:max-w-none")}>{children}</div>
    </div>
  );
}

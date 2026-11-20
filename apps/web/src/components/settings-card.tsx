import { cn } from "cn";
import type { ReactNode } from "react";

import { InfoIcon } from "lucide-react";

import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

/**
 * Settings as row cards (docs/design.md → Settings rows): a group's title, then one card of `SettingRow`s divided by
 * lines. No cards inside it. A list's card says how many it holds beside its title (`count`) and has its "Add" button
 * at the title's right (`action`).
 */
export function SettingsCard({
  title,
  count,
  description,
  action,
  children,
  className,
}: {
  title?: ReactNode;
  count?: number;
  description?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-2", className)}>
      {title && (
        <div className="flex items-end justify-between gap-3">
          <div className="flex min-w-0 flex-col">
            <h2 className="text-base font-semibold">
              {title}
              {count !== undefined && <> <span className="font-normal text-muted-foreground">{count}</span></>}
            </h2>
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
          </div>
          {action}
        </div>
      )}
      <div className="@container/settings flex flex-col divide-y rounded-xl bg-card ring-1 ring-border">{children}</div>
    </section>
  );
}

/**
 * One setting: its label and at most one short line on what it does on the left, its control on the right. What takes
 * longer to say goes in `info`, behind an ⓘ beside the label (on hover or a press). In a card under 34rem wide
 * (phones) the control goes under them at the card's width, so the line isn't squeezed a word a row; `inline` keeps a
 * short control (a switch, a button) on the right there too. Beside its control the label keeps 12rem, and a wide
 * control (a long address) narrows and wraps instead. `htmlFor`: the control's id, labelled by the label; the
 * description is `<htmlFor>-description`, for the control's `aria-describedby`.
 */
export function SettingRow({
  label,
  description,
  info,
  htmlFor,
  inline = false,
  children,
}: {
  label: ReactNode;
  description?: ReactNode;
  info?: ReactNode;
  htmlFor?: string;
  inline?: boolean;
  children: ReactNode;
}) {
  const Label = htmlFor ? "label" : "div";
  return (
    <div data-slot="setting-row" className={cn("flex gap-x-5 gap-y-2.5 px-4 py-3.5 @min-[34rem]/settings:flex-row @min-[34rem]/settings:items-center @min-[34rem]/settings:px-5", inline ? "items-center" : "flex-col")}>
      <div className="flex min-w-0 flex-1 flex-col @min-[34rem]/settings:min-w-48">
        <div className="flex items-center gap-1.5">
          <Label htmlFor={htmlFor} className="font-medium">
            {label}
          </Label>
          {info && (
            <Popover>
              <PopoverTrigger openOnHover aria-label="More about this setting" className="rounded-full text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
                <InfoIcon aria-hidden className="size-3.5" />
              </PopoverTrigger>
              <PopoverContent className="max-w-72 p-3 text-sm">{info}</PopoverContent>
            </Popover>
          )}
        </div>
        {description && (
          <p id={htmlFor && `${htmlFor}-description`} className="text-sm text-muted-foreground">
            {description}
          </p>
        )}
      </div>
      <div className={cn("flex items-center gap-2", !inline && "@max-[34rem]/settings:*:w-full @max-[34rem]/settings:*:max-w-none")}>{children}</div>
    </div>
  );
}

/** What a settings card holds that isn't a row (a form, a list): padded as its rows are. */
export function SettingBlock({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("flex flex-col gap-4 px-4 py-4 @min-[34rem]/settings:px-5", className)}>{children}</div>;
}

export { SettingsPane } from "@/components/settings-pane";

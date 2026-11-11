"use client";

import { cn } from "cn";

import { EllipsisIcon } from "lucide-react";
import { createContext, type ReactNode, type RefObject, useContext, useEffect, useRef, useState } from "react";
import { IconTooltip } from "@/components/icon-tooltip";
import { Button } from "@/components/ui/button";

import { BackLink } from "@/components/back-link";

const DocsMoreFocus = createContext<RefObject<HTMLButtonElement | null> | undefined>(undefined);
export const useDocsMoreFocus = () => useContext(DocsMoreFocus);

export function DocsMore({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        toggle.current?.focus();
        event.stopPropagation();
      }
    };
    document.addEventListener("pointerdown", outside);
    root.current?.addEventListener("keydown", escape);
    const element = root.current;
    return () => {
      document.removeEventListener("pointerdown", outside);
      element?.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div ref={root} className="docs-more relative text-[13px] [&_>_button]:grid [&_>_button]:place-items-center [&_>_button]:w-7 [&_>_button]:h-8 [&_>_button]:cursor-pointer [&_>_button]:rounded-[7px] [&_>_button]:text-muted-foreground [&_>_button]:list-none [&_>_button:hover]:bg-secondary">
      <IconTooltip label="More actions"><Button ref={toggle} type="button" variant="ghost" size="icon-sm" aria-label="More actions" aria-expanded={open} onClick={() => setOpen(!open)}>
        <EllipsisIcon className="size-4" />
      </Button></IconTooltip>
      <div
        hidden={!open}
        className="docs-more-menu absolute right-[0] top-[100%] z-30 flex flex-col items-stretch w-55 p-1.25 border border-border rounded-[10px] bg-popover shadow-[0_10px_32px_color-mix(in_oklch,_var(--foreground)_14%,_transparent)] [&_>_*]:justify-start"
        onClick={(event) => {
          if ((event.target as Element).closest("a, button")) {
            setOpen(false);
            toggle.current?.focus();
          }
        }}
      >
        <DocsMoreFocus.Provider value={toggle}>{children}</DocsMoreFocus.Provider>
      </div>
    </div>
  );
}

/** Each Docs surface owns its title and actions, including at phone widths. */
export function DocsPageHeader({
  title,
  description,
  back,
  actions,
  more,
  icon,
}: {
  title: ReactNode;
  description?: ReactNode;
  back?: { href: string; label: ReactNode };
  actions?: ReactNode;
  more?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <header className="docs-page-header @container/docs-heading flex flex-col gap-4.5 shrink-0 [&_>_a]:text-muted-foreground [&_>_a]:text-[13px]" data-slot="docs-page-header">
      {back && <BackLink href={back.href}>{back.label}</BackLink>}
      <div className="docs-heading-row lg:@max-[40rem]/docs-heading:flex-wrap flex items-start gap-4 justify-between max-sm:flex-wrap max-sm:gap-4">
        <div className="docs-heading-copy flex items-start gap-3.25 min-w-0 [&_h1]:font-heading [&_h1]:text-[30px] [&_h1]:font-[650] [&_h1]:leading-[1.15] [&_h1]:tracking-[-0.03em] [&_p]:text-[14px] [&_p]:text-muted-foreground [&_p]:mt-1.75 max-sm:[&_h1]:text-[25px] max-sm:[&_p]:text-[14px]">
          {icon && <span className="docs-heading-icon grid place-items-center w-11 h-11 shrink-0 rounded-[12px] bg-soft text-soft-foreground [&_svg]:w-5.5 [&_svg]:h-5.5 max-sm:w-9 max-sm:h-9 max-sm:rounded-[10px]">{icon}</span>}
          <div className="min-w-0 [&_h1]:wrap-anywhere">
            <h1>{title}</h1>
            {description && <p>{description}</p>}
          </div>
        </div>
        <div className={cn(
          "docs-heading-actions lg:@max-[40rem]/docs-heading:w-full lg:@max-[40rem]/docs-heading:justify-end flex items-center gap-1.75 sm:[&>_.docs-live-link]:mr-3.25 shrink-0 [&_[data-slot='button']]:h-8.5 [&_[data-slot='button']]:text-[13.5px]",
          "max-sm:w-full max-sm:justify-end max-sm:gap-1.5 max-sm:[&_>_.docs-live-link]:mr-auto max-sm:[&_>_.docs-live-link_span]:text-[0px]",
          "max-sm:[&_>_.docs-live-link_span::after]:[content:'Open'] max-sm:[&_>_.docs-live-link_span::after]:text-[13px]",
        )}>
          {actions}
          {more && <DocsMore>{more}</DocsMore>}
        </div>
      </div>
    </header>
  );
}

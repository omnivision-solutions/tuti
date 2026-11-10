"use client";

import { EllipsisIcon } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";

import { BackLink } from "@/components/back-link";

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
    <div ref={root} className="docs-more">
      <Button ref={toggle} type="button" variant="ghost" size="icon-sm" aria-label="More actions" aria-expanded={open} onClick={() => setOpen(!open)}>
        <EllipsisIcon className="size-4" />
      </Button>
      <div
        hidden={!open}
        className="docs-more-menu"
        onClick={(event) => {
          if ((event.target as Element).closest("a, button")) {
            setOpen(false);
            toggle.current?.focus();
          }
        }}
      >
        {children}
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
    <header className="docs-page-header" data-slot="docs-page-header">
      {back && <BackLink href={back.href}>{back.label}</BackLink>}
      <div className="docs-heading-row">
        <div className="docs-heading-copy">
          {icon && <span className="docs-heading-icon">{icon}</span>}
          <div>
            <h1>{title}</h1>
            {description && <p>{description}</p>}
          </div>
        </div>
        <div className="docs-heading-actions">
          {actions}
          {more && <DocsMore>{more}</DocsMore>}
        </div>
      </div>
    </header>
  );
}

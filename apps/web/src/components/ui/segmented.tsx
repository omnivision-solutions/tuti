"use client";

import { cn } from "cn";
import type { ReactNode } from "react";

/**
 * A choice of two to five short options, side by side (docs/design.md → Settings rows): radios, so it's a form
 * field (`name`) and the arrow keys move between its options. `defaultValue` in a form, or `value` and
 * `onValueChange`. Name the group with `aria-label` or `aria-labelledby`. More options, or long ones: a `Select`.
 */
export function Segmented<T extends string>({
  name,
  options,
  defaultValue,
  value,
  onValueChange,
  className,
  ...props
}: {
  name: string;
  options: readonly { value: T; label: ReactNode; /** An icon element (`<SunIcon aria-hidden />`), sized here. */ icon?: ReactNode }[];
  defaultValue?: T;
  value?: T;
  onValueChange?: (value: T) => void;
  className?: string;
  "aria-label"?: string;
  "aria-labelledby"?: string;
  "aria-describedby"?: string;
}) {
  return (
    <div role="radiogroup" {...props} className={cn("flex w-fit max-w-full gap-1 rounded-lg bg-muted p-1", className)}>
      {options.map(({ value: option, label, icon }) => (
        <label
          key={option}
          className="flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-md px-3 py-1 text-sm font-medium whitespace-nowrap [&>svg]:size-3.5 text-muted-foreground transition-colors hover:text-foreground has-checked:bg-background has-checked:text-foreground has-checked:shadow-sm has-focus-visible:ring-2 has-focus-visible:ring-ring"
        >
          <input
            type="radio"
            name={name}
            value={option}
            {...(value === undefined ? { defaultChecked: defaultValue === option } : { checked: value === option })}
            onChange={() => onValueChange?.(option)}
            className="sr-only"
          />
          {icon}
          {label}
        </label>
      ))}
    </div>
  );
}

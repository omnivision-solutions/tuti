import { cn } from "cn"

/**
 * How far something has got (Verify all's articles checked), as a bar. Its empty track is outlined at 3:1 or more, so
 * a bar that hasn't started yet is seen to be empty rather than missing.
 */
function Progress({ value, max, className, ...props }: { value: number; max: number } & Omit<React.ComponentProps<"div">, "children">) {
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={value}
      data-slot="progress"
      className={cn("h-2 overflow-hidden rounded-full bg-secondary ring-1 ring-muted-foreground ring-inset", className)}
      {...props}
    >
      <div className="h-full bg-primary transition-[width]" style={{ width: `${max === 0 ? 0 : (value / max) * 100}%` }} />
    </div>
  )
}

export { Progress }

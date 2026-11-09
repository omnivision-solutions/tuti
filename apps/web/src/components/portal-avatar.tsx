import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";

/**
 * Someone on the portal: their photo, or their initial in the portal's one neutral style (its `avatar-*` tokens are all
 * the same grey there, globals.css); `team`, the team's soft green. Decoration: the name is always written beside it.
 */
export function PortalAvatar({ person, team = false, className }: { person: { name: string; image: string | null }; team?: boolean; className?: string }) {
  return (
    <Avatar aria-hidden className={className}>
      {person.image && <AvatarImage src={person.image} alt="" />}
      <AvatarFallback className={cn("text-[length:inherit] font-semibold", team && "bg-soft text-soft-foreground")}>
        {person.name.slice(0, 1).toUpperCase()}
      </AvatarFallback>
    </Avatar>
  );
}

import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/components/ui/avatar";

/**
 * A post's voters on the portal: a few faces and how many voted. Faces only, no names (a vote isn't
 * signed the way a comment is). `label` says how many in other words (the team's "12 voters").
 */
export function VoterFaces({
  voters,
  count,
  label = `${count} ${count === 1 ? "person wants this" : "people want this"}`,
}: {
  voters: { id: string; name: string; image: string | null }[];
  count: number;
  label?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="group" aria-label="Voters">
      <AvatarGroup aria-hidden>
        {voters.map((voter) => (
          <Avatar key={voter.id} size="sm">
            {voter.image && <AvatarImage src={voter.image} alt="" />}
            <AvatarFallback>{voter.name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
        ))}
      </AvatarGroup>
      <span>{label}</span>
    </div>
  );
}

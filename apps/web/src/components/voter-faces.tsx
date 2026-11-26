"use client";

import { useTranslations } from "next-intl";

import { Avatar, AvatarFallback, AvatarGroup, AvatarImage } from "@/components/ui/avatar";

/**
 * A post's voters on the portal: a few faces and how many voted. Faces only, no names (a vote isn't
 * signed the way a comment is). `label` says how many in other words (the team's "12 voters").
 */
export function VoterFaces({
  voters,
  count,
  label,
}: {
  voters: { id: string; name: string; image: string | null }[];
  count: number;
  label?: React.ReactNode;
}) {
  const t = useTranslations("feedback");
  return (
    // In the page's language on the portal (its name and the default label), English in the app.
    <div className="flex items-center gap-2 text-sm text-muted-foreground" role="group" aria-label={t("voters")}>
      <AvatarGroup aria-hidden className="-space-x-0.5">
        {voters.map((voter) => (
          <Avatar key={voter.id} size="sm">
            {voter.image && <AvatarImage src={voter.image} alt="" />}
            <AvatarFallback>{voter.name.slice(0, 1).toUpperCase()}</AvatarFallback>
          </Avatar>
        ))}
      </AvatarGroup>
      <span>{label ?? t("peopleWantThis", { count })}</span>
    </div>
  );
}

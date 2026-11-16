"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { claimPlanLicense } from "@/server/plan-licenses";

/** "Add to my account" on the redeem page: claims the license, then Licenses (the action goes there), or says why not. */
export function RedeemLicense({ claim }: { claim: string }) {
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-3">
      <Button className="self-start" disabled={pending} onClick={() => startTransition(async () => setError((await claimPlanLicense(claim)).error))}>
        {pending ? "Adding…" : "Add to my account"}
      </Button>
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}

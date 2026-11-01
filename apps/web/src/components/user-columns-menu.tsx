"use client";

import { Columns3Icon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuGroup, DropdownMenuLabel, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { setUserColumns } from "@/server/groups";

/** Users' Columns (owners and admins): which of the users' properties the table shows; a new one goes last. */
export function UserColumnsMenu({
  projectSlug,
  columns,
  properties,
}: {
  projectSlug: string;
  columns: string[];
  /** Each by its name, and as the team calls it. */
  properties: { name: string; label: string }[];
}) {
  const router = useRouter();
  // Shown as picked while it saves; back to what's saved if it fails.
  const [picked, setPicked] = useState(columns);
  const [saved, setSaved] = useState(columns);
  const [pending, startTransition] = useTransition();
  if (saved !== columns) {
    setSaved(columns);
    setPicked(columns);
  }

  const toggle = (name: string, on: boolean) => {
    const next = on ? [...picked, name] : picked.filter((column) => column !== name);
    setPicked(next);
    startTransition(async () => {
      const result = await setUserColumns(projectSlug, next).catch(() => ({ error: "Couldn't reach Tuti. Try again." }));
      if (result.error) {
        toast.error(result.error);
        setPicked(columns);
        return;
      }
      router.refresh();
    });
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" size="sm" />}>
        <Columns3Icon />
        Columns
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="max-h-80 w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Properties shown</DropdownMenuLabel>
          {properties.map(({ name, label }) => (
            <DropdownMenuCheckboxItem key={name} checked={picked.includes(name)} disabled={pending} onCheckedChange={(on) => toggle(name, on)} closeOnClick={false}>
              <span className="min-w-0 break-all">{label}</span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

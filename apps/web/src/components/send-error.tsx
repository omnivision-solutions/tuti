"use client";

import { useTranslations } from "next-intl";

/** Why a message didn't go: the panel's own failure in its language; the server's words, English (L5), marked so. */
export function SendError({ error, alert = false }: { error: string; alert?: boolean }) {
  const t = useTranslations("widget");
  return (
    <p role={alert ? "alert" : undefined} lang={error === t("couldntSend") ? undefined : "en"} className="text-sm text-destructive">
      {error}
    </p>
  );
}

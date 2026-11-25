"use client";

import { type Language, LANGUAGES } from "@tuti/shared/languages";
import type { Messages } from "@tuti/shared/messages";
import { CheckIcon, ChevronDownIcon, GlobeIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { NextIntlClientProvider, useTranslations } from "next-intl";
import { useTransition } from "react";
import { toast } from "sonner";

import { usePortalSlug } from "@/components/portal-base";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { chooseLanguage } from "@/server/reader-language";

declare module "next-intl" {
  interface AppConfig {
    Locale: Language;
    Messages: Messages;
  }
}

/** The portal's own text in the reader's language (next-intl, without its routing: proxy.ts routes), for its client components. */
export function PortalIntl({ language, messages, children }: { language: Language; messages: Messages; children: React.ReactNode }) {
  return (
    // A time zone for what formats dates on the server and in the browser alike: none is shown in the reader's own yet.
    <NextIntlClientProvider locale={language} messages={messages} timeZone="UTC">
      {children}
    </NextIntlClientProvider>
  );
}

/** Reads the portal in `code`: kept by chooseLanguage, then the page again in it. Until pages have an address per language (L3), the same address. */
function useChooseLanguage() {
  const slug = usePortalSlug();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const choose = (code: string) =>
    startTransition(async () => {
      const { error } = await chooseLanguage(slug, code);
      if (error) {
        toast.error(error);
        return;
      }
      router.refresh();
    });
  return { choose, pending };
}

/**
 * The header's language switcher (docs/plan.md, Languages: "Portal header"): "🌐 Deutsch ▾", a menu of the live languages by
 * their own names (each in its own `lang`), the current one ticked. Shown with more than one language, from tablets up; on
 * phones they're in the header's menu (LanguageList).
 */
export function LanguageSwitcher({ languages, current }: { languages: Language[]; current: Language }) {
  const t = useTranslations("header");
  const { choose, pending } = useChooseLanguage();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        // In the page's language (its name is the messages'), until <html lang> follows the reader (L3). Focusable while it saves, so focus stays on it.
        render={<Button variant="ghost" size="sm" className="max-sm:hidden" lang={current} disabled={pending} focusableWhenDisabled aria-label={t("language", { language: LANGUAGES[current].native })} />}
      >
        <GlobeIcon aria-hidden="true" />
        {LANGUAGES[current].native}
        <ChevronDownIcon aria-hidden="true" className="opacity-60" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-auto min-w-40">
        <DropdownMenuRadioGroup value={current} onValueChange={(code: string) => code !== current && choose(code)}>
          {languages.map((code) => (
            <DropdownMenuRadioItem key={code} value={code} lang={code} closeOnClick>
              {LANGUAGES[code].native}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The languages in the header's menu on phones, where the header has no room for its switcher. */
export function LanguageList({ languages, current }: { languages: Language[]; current: Language }) {
  const t = useTranslations("header");
  const { choose, pending } = useChooseLanguage();
  return (
    <div role="group" lang={current} aria-label={t("languages")} className="flex flex-col gap-0.5 border-b px-4 py-4 sm:hidden">
      <p aria-hidden="true" className="flex items-center gap-2 px-2 py-1 font-heading font-semibold">
        <GlobeIcon className="size-4" />
        {t("languages")}
      </p>
      {languages.map((code) => (
        <button
          key={code}
          type="button"
          lang={code}
          aria-pressed={code === current}
          // Not disabled while it saves: the button pressed keeps focus.
          aria-disabled={pending || undefined}
          onClick={() => !pending && code !== current && choose(code)}
          className="flex items-center justify-between rounded-md px-2 py-2 text-left text-base text-muted-foreground hover:text-foreground aria-pressed:font-medium aria-pressed:text-foreground"
        >
          {LANGUAGES[code].native}
          {code === current && <CheckIcon aria-hidden="true" className="size-4" />}
        </button>
      ))}
    </div>
  );
}

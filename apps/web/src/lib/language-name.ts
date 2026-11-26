/** A language's name in itself ("Deutsch" for de, "Français" for fr), as a speaker would know it; the code where Intl doesn't know it. */
export function nativeLanguageName(code: string): string {
  try {
    const name = new Intl.DisplayNames([code], { type: "language" }).of(code) ?? code;
    return name.charAt(0).toLocaleUpperCase(code) + name.slice(1);
  } catch {
    return code;
  }
}

/**
 * The team languages Settings → Inbox offers: English, then the portal's launch languages (docs/plan.md, Languages).
 * ponytail: here until L1 puts the launch languages in @tuti/shared; then use that list.
 */
export const TEAM_LANGUAGES = ["en", "de", "fr", "es", "pt-BR", "it", "nl", "ja", "ko", "zh-CN", "pl"];

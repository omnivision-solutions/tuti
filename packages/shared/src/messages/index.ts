import type { Language } from "../languages";
import de from "./de.json";
import en from "./en.json";
import es from "./es.json";
import fr from "./fr.json";
import it from "./it.json";
import ja from "./ja.json";
import ko from "./ko.json";
import nl from "./nl.json";
import pl from "./pl.json";
import ptBR from "./pt-BR.json";
import zhCN from "./zh-CN.json";

/**
 * The portal's own text in each language it's offered in (docs/plan.md, Languages: "The portal's own text"), as next-intl
 * messages. English is what the others are written from; languages.test.ts checks each has every message English has, with
 * the same placeholders. The portal moves its screens' text here one at a time (L5).
 */
export type Messages = typeof en;

export const MESSAGES: Record<Language, Messages> = { en, de, fr, es, "pt-BR": ptBR, it, nl, ja, ko, "zh-CN": zhCN, pl };

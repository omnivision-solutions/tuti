import { z } from "zod";

/** The most text an article may have (its plain text, from its content): articles' saves are refused past it, and imports keep none longer. */
export const MAX_ARTICLE_LENGTH = 50_000;

/** A docs collection's name, as collections.create takes it: and so what a new article's place can make (see draftPlace). */
export const collectionName = z.string().trim().min(1, "Name is required").max(60);

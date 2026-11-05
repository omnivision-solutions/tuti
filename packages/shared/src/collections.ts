import { z } from "zod";

/** A docs collection's name, as collections.create takes it: and so what a new article's place can make (see draftPlace). */
export const collectionName = z.string().trim().min(1, "Name is required").max(60);

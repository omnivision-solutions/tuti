import { z } from "zod";

/**
 * What a project's app tells Tuti about one of its users (e.g. { plan: "pro", seats: 12, beta: true,
 * features: ["sso", "audit"] }), by SSO sign-ins (the token's `properties`) and the API. Kept on their
 * SSO identity, for groups' conditions to match (lib/group-conditions.ts). Each change names the
 * properties it sets and removes (null); the rest stay.
 */

export type PropertyValue = string | number | boolean | string[];
export type Properties = Record<string, PropertyValue>;
/** Properties to set, and (null) to remove. */
export type PropertyChanges = Record<string, PropertyValue | null>;

export const MAX_PROPERTIES = 50;
export const MAX_PROPERTY_NAME = 64;
export const MAX_PROPERTY_TEXT = 200;
export const MAX_PROPERTY_LIST = 50;

const text = (item: unknown): item is string => typeof item === "string" && item.length <= MAX_PROPERTY_TEXT;

function valid(item: unknown): item is PropertyValue {
  return (
    text(item) ||
    (typeof item === "number" && Number.isFinite(item)) ||
    typeof item === "boolean" ||
    (Array.isArray(item) && item.length <= MAX_PROPERTY_LIST && item.every(text))
  );
}

/**
 * A token's `properties` as changes, never failing the sign-in: names trimmed, 1–64 characters;
 * values strings (up to 200 characters), numbers, booleans, lists of up to 50 such strings, or null
 * (removes it); the first 50. Anything else (not an object, nested objects, other lists) is dropped,
 * one by one.
 */
export function propertyChanges(value: unknown): PropertyChanges {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  const kept = new Map<string, PropertyValue | null>();
  for (const [name, item] of Object.entries(value)) {
    const key = name.trim();
    if ((item === null || valid(item)) && key.length >= 1 && key.length <= MAX_PROPERTY_NAME && (kept.size < MAX_PROPERTIES || kept.has(key))) {
      kept.set(key, item);
    }
  }
  // fromEntries, so a name like "__proto__" is a property like any other.
  return Object.fromEntries(kept);
}

/** Properties as stored (see mergeProperties); anything unreadable is left out. */
export function storedProperties(json: unknown): Properties {
  const changes = propertyChanges(json);
  return Object.fromEntries(Object.entries(changes).filter((entry): entry is [string, PropertyValue] => entry[1] !== null));
}

/**
 * `current` with `changes`: a value sets one, null removes it. At most 50: new names past that are
 * `dropped` (the API refuses them; a sign-in leaves them out).
 */
export function mergeProperties(current: Properties, changes: PropertyChanges): { properties: Properties; dropped: string[] } {
  const merged = new Map(Object.entries(current));
  const dropped: string[] = [];
  for (const [name, value] of Object.entries(changes)) {
    if (value === null) {
      merged.delete(name);
    } else if (merged.has(name) || merged.size < MAX_PROPERTIES) {
      merged.set(name, value);
    } else {
      dropped.push(name);
    }
  }
  return { properties: Object.fromEntries(merged), dropped };
}

const propertyText = z.string().max(MAX_PROPERTY_TEXT, `Text properties are up to ${MAX_PROPERTY_TEXT} characters`);

/** Properties to set or remove, for the API: like propertyChanges, but refusing what it would drop. */
export const propertyChangesInput = z
  .record(
    z.string().trim().min(1, "A property needs a name").max(MAX_PROPERTY_NAME, `Property names are up to ${MAX_PROPERTY_NAME} characters`),
    z.union([
      propertyText,
      z.number(),
      z.boolean(),
      z.array(propertyText).max(MAX_PROPERTY_LIST, `Lists are up to ${MAX_PROPERTY_LIST} items`),
      z.null(),
    ]),
  )
  .refine((changes) => Object.keys(changes).length <= MAX_PROPERTIES, `Up to ${MAX_PROPERTIES} properties`);

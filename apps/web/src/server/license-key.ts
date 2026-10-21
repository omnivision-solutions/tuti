/**
 * Tuti's public key for licence keys (Ed25519, SPKI DER in base64). Only the maintainers hold
 * its private half (scripts/issue-license.mjs), so only Tuti can issue a key that verifies here.
 * Deliberately a constant, not a setting: a key of your own would be a licence of your own.
 */
export const LICENSE_PUBLIC_KEY = "MCowBQYDK2VwAyEAPlrDVy7bB9bFPkckWfB5jQMM2CZo2gbFmnJ5nKYFFPo=";

/**
 * Tuti's public keys for licence keys (Ed25519, SPKI DER in base64): a key verifies if any of
 * them signed it, so a release can add the next key before the current one is retired. Only
 * the maintainers hold the private halves, so only Tuti can issue a key that verifies here.
 * Deliberately constants, not settings: trusting a key of your own would be licensing yourself.
 */
export const LICENSE_PUBLIC_KEYS = ["MCowBQYDK2VwAyEAPlrDVy7bB9bFPkckWfB5jQMM2CZo2gbFmnJ5nKYFFPo="];

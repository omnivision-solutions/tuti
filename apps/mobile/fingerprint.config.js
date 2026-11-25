// What the runtime version (app.config.ts `runtimeVersion: fingerprint`) leaves out, so a build on Expo's builders and
// an update published elsewhere get the same one for the same native code.
/** @type {import('expo/fingerprint').Config} */
module.exports = {
  ignorePaths: [
    // The Firebase config (GOOGLE_SERVICES_JSON) is an EAS secret file there, and absent where updates are published.
    "../../../eas-environment-secrets/**",
    // Generated from app.config.ts, which is in the fingerprint, and never committed: the builders make them.
    "android",
    "android/**",
    "ios",
    "ios/**",
  ],
};

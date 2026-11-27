import { describe, expect, test } from "vitest";

import { findSignInServices } from "./sign-in-hosts";

describe("findSignInServices", () => {
  test.each([
    ["Firebase", 'const h="identitytoolkit.googleapis.com",t="securetoken.googleapis.com";', ["identitytoolkit.googleapis.com", "securetoken.googleapis.com"]],
    ["Auth0", 'createAuth0Client({domain:"acme.eu.auth0.com",clientId:"x"}); fetch("https://cdn.auth0.com/js/lock.js")', ["acme.eu.auth0.com"]],
    ["Supabase", 'createClient("https://abcdefghijklmnopqrst.supabase.co","anon")', ["abcdefghijklmnopqrst.supabase.co"]],
    ["Okta", 'new OktaAuth({issuer:"https://acme.okta.com/oauth2/default"}); "https://developer.okta.com/docs"', ["acme.okta.com"]],
    ["Amazon Cognito", 'Amplify.configure({Auth:{Cognito:{userPoolId:"us-east-1_AbC123xyz",loginWith:{oauth:{domain:"acme.auth.eu-west-1.amazoncognito.com"}}}}})', ["acme.auth.eu-west-1.amazoncognito.com", "cognito-idp.us-east-1.amazonaws.com"]],
    // A publishable key is the Clerk host in base64 (built here, as a literal reads like a secret to the scan).
    ["Clerk", `<script src="https://clerk.acme.com/npm/@clerk/clerk-js@5/dist/clerk.browser.js"></script> publishableKey:"pk_live_${btoa("clerk.acme.com$")}"`, ["clerk.acme.com"]],
    ["Clerk", 'ClerkProvider({publishableKey:"x"}); "https://acme-12.clerk.accounts.dev"', ["acme-12.clerk.accounts.dev"]],
    ["Stytch", 'fetch("https://api.stytch.com/sdk/v1/")', ["api.stytch.com"]],
    ["WorkOS", '"https://api.workos.com/user_management/authorize"', ["api.workos.com"]],
  ])("%s", (provider, code, hosts) => {
    expect(findSignInServices(["<html></html>", code])).toEqual([{ provider, hosts }]);
  });

  test("a plain page, and a sign-in by Google or Microsoft, find nothing", () => {
    const page = `<!doctype html><html><head><script src="/assets/app-3f2a.js"></script><link rel="stylesheet" href="https://cdn.example.com/x.css"></head>
      <body><a href="https://accounts.google.com/o/oauth2/v2/auth">Sign in with Google</a><a href="https://login.microsoftonline.com/common">Microsoft</a>
      <a href="https://www.okta.com">Okta</a> <a href="https://auth0.com">Auth0</a> <a href="https://supabase.com">Supabase</a> clerk.browser.js <script>window.Clerk.session.id; Clerk.user.id</script></body></html>`;
    expect(findSignInServices([page])).toEqual([]);
  });
});

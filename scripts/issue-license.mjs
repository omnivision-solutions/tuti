// Maintainers only: issues a licence key that lets one project hide "Powered by tuti"
// (see apps/web/src/server/license.ts). Needs Tuti's private key, which lives in the
// maintainers' Infisical (prod, /licensing):
//
//   infisical run --env=prod --path=/licensing -- node scripts/issue-license.mjs <project id> <days>
import { createPrivateKey, sign } from "node:crypto";

const [project, days] = process.argv.slice(2);
if (!project || !(Number(days) > 0) || !process.env.LICENSE_PRIVATE_KEY) {
  console.error("Usage: LICENSE_PRIVATE_KEY=… node scripts/issue-license.mjs <project id> <days>");
  process.exit(1);
}
const privateKey = createPrivateKey({ key: Buffer.from(process.env.LICENSE_PRIVATE_KEY, "base64"), format: "der", type: "pkcs8" });
const exp = Math.floor(Date.now() / 1000) + Math.round(Number(days) * 24 * 60 * 60);
const claims = Buffer.from(JSON.stringify({ project, exp })).toString("base64url");
console.log(`${claims}.${sign(null, Buffer.from(claims), privateKey).toString("base64url")}`);
console.error(`For project ${project}, until ${new Date(exp * 1000).toISOString()}`);

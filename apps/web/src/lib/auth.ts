import { prisma } from "@tuti/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { nextCookies } from "better-auth/next-js";

import { jwtSso } from "./sso";

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  emailAndPassword: {
    enabled: true,
  },
  // nextCookies must stay last: lets server actions set auth cookies.
  plugins: [jwtSso(), nextCookies()],
});

export type Session = typeof auth.$Infer.Session;

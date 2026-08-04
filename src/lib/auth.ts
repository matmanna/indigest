import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { genericOAuth } from "better-auth/plugins";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { eq } from "drizzle-orm";

export function getAuth(databaseUrl: string, env?: Record<string, string>) {
  const db = getDb(databaseUrl);
  return betterAuth({
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: {
        user: schema.authUser,
        session: schema.authSession,
        account: schema.authAccount,
        verification: schema.authVerification,
      },
    }),
    user: {
      additionalFields: {
        slackId: {
          type: "string",
          required: false,
        },
      },
    },
    plugins: [
      genericOAuth({
        config: [
          {
            providerId: "hackclub",
            discoveryUrl: "https://auth.hackclub.com/.well-known/openid-configuration",
            clientId: env?.HACKCLUB_CLIENT_ID || "",
            clientSecret: env?.HACKCLUB_CLIENT_SECRET || "",
            scopes: ["openid", "profile", "email", "slack_id"],
          },
        ],
      }),
    ],
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await setSlackIdFromAccount(databaseUrl, user.id);
          },
        },
        update: {
          after: async (user) => {
            await setSlackIdFromAccount(databaseUrl, user.id);
          },
        },
      },
    },
    baseURL: env?.BASE_URL || "http://localhost:8787",
    trustedOrigins: [
      "http://localhost:8787",
      "http://indigest.matmanna.dev",
      "https://indigest.matmanna.dev",
    ],
  });
}

/**
 * After user create/update, read the id_token from auth_account, decode it,
 * and set slack_id on auth_user if present.
 */
async function setSlackIdFromAccount(databaseUrl: string, userId: string): Promise<void> {
  try {
    const db = getDb(databaseUrl);
    const accounts = await db
      .select({ idToken: schema.authAccount.idToken })
      .from(schema.authAccount)
      .where(eq(schema.authAccount.userId, userId));
    const idToken = accounts[0]?.idToken;
    if (!idToken) {
      console.log(`setSlackId: no id_token for user ${userId}`);
      return;
    }

    const parts = idToken.split(".");
    if (parts.length !== 3 || !parts[1]) return;
    const payload = JSON.parse(atob(parts[1]));
    if (!payload.slack_id) {
      console.log(`setSlackId: no slack_id in token for user ${userId}`);
      return;
    }

    await db
      .update(schema.authUser)
      .set({ slackId: payload.slack_id })
      .where(eq(schema.authUser.id, userId));
    console.log(`setSlackId: set slack_id=${payload.slack_id} for user ${userId}`);
  } catch (err: any) {
    console.error("setSlackIdFromAccount failed:", err.message);
  }
}

// Default export for `npx auth generate` — uses DATABASE_URL env var
const databaseUrl = process.env.DATABASE_URL || "";
export const auth = databaseUrl ? getAuth(databaseUrl, process.env as Record<string, string>) : (null as any);
export default auth;

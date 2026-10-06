import { eq } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";
import type { Channel } from "../db/queries";
import type { ApiKeyIdentity } from "./api-keys";

export interface FeedIdentity {
  type: "session" | "apikey";
  slackId: string;
  channelIds?: string[];
}

export function canAccessFeed(
  ch: Pick<Channel, "id" | "accessPermUsers">,
  identity: FeedIdentity | null,
): boolean {
  // API keys are scoped to specific channels
  if (
    identity?.type === "apikey" &&
    identity.channelIds &&
    identity.channelIds.length > 0
  ) {
    return identity.channelIds.includes(ch.id);
  }
  if (ch.accessPermUsers.includes("*")) return true;
  if (!identity) return false;
  return ch.accessPermUsers.includes(identity.slackId);
}

/**
 * An API key acts as the Slack user who owns it (for child keys, the owner of
 * the parent key), narrowed to the key's channel scope.
 */
export async function feedIdentityForApiKey(
  db: DB,
  key: ApiKeyIdentity,
): Promise<FeedIdentity | null> {
  if (!key.owner) return null;
  const users = await db
    .select({ slackId: schema.authUser.slackId })
    .from(schema.authUser)
    .where(eq(schema.authUser.id, key.owner));
  const slackId = users[0]?.slackId;
  if (!slackId) return null;
  return { type: "apikey", slackId, channelIds: key.channelIds };
}

export async function resolveContextFeedIdentity(
  db: DB,
  session: { user: { slackId?: string | null } } | null,
  apiKey: ApiKeyIdentity | null,
): Promise<FeedIdentity | null> {
  if (session?.user.slackId) {
    return { type: "session", slackId: session.user.slackId };
  }
  if (apiKey) return feedIdentityForApiKey(db, apiKey);
  return null;
}

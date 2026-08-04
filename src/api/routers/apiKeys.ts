import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { authRequiredProcedure, isChannelManager } from "../context";
import { generateApiKey } from "../../lib/api-keys";
import { getDb } from "../../db";
import { apiKeys, apiKeyChannels } from "../../db/schema";
import { eq } from "drizzle-orm";

export const listApiKeys = authRequiredProcedure
  .route({ method: "GET", path: "/api-keys" })
  .handler(async ({ context }) => {
    const db = getDb(context.databaseUrl);
    const userId = context.session?.user?.id;
    if (!userId) return [];

    const keys = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .where(eq(apiKeys.owner, userId));

    const keysWithChannels = await Promise.all(
      keys.map(async (key) => {
        const channels = await db
          .select({ channelId: apiKeyChannels.channelId })
          .from(apiKeyChannels)
          .where(eq(apiKeyChannels.keyId, key.id));
        return { ...key, channels: channels.map((c) => c.channelId) };
      }),
    );

    return keysWithChannels;
  });

export const createApiKey = authRequiredProcedure
  .route({ method: "POST", path: "/api-keys" })
  .input(
    z.object({
      name: z.string().min(1),
      channelIds: z.array(z.string()).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const slackId = context.session?.user?.slackId;
    if (!slackId)
      throw new ORPCError("FORBIDDEN", { message: "No Slack ID on session" });

    // Validate user has access to each specified channel
    if (input.channelIds && input.channelIds.length > 0) {
      const isLockdown = context.lockdownUsers.includes(slackId);
      for (const channelId of input.channelIds) {
        const ch = await context.store.getChannel(channelId);
        if (!ch)
          throw new ORPCError("NOT_FOUND", {
            message: `Channel ${channelId} not found`,
          });
        if (!isLockdown && !ch.accessPermUsers.includes(slackId)) {
          const isManager = await isChannelManager(
            channelId,
            slackId,
            context.slackToken,
          );
          if (!isManager) {
            throw new ORPCError("FORBIDDEN", {
              message: `You don't have access to channel ${ch.name || channelId}`,
            });
          }
        }
      }
    }

    const { fullKey, keyPrefix, secretHash } = generateApiKey();
    const hash = await secretHash;

    const db = getDb(context.databaseUrl);
    const [keyRow] = await db
      .insert(apiKeys)
      .values({
        name: input.name,
        owner: context.session?.user?.id || null,
        keyPrefix,
        secretHash: hash,
      })
      .returning({ id: apiKeys.id });

    if (input.channelIds && keyRow) {
      for (const channelId of input.channelIds) {
        await db.insert(apiKeyChannels).values({
          keyId: keyRow.id,
          channelId,
        });
      }
    }

    return { fullKey, keyPrefix, name: input.name, id: keyRow?.id };
  });

export const revokeApiKey = authRequiredProcedure
  .route({ method: "DELETE", path: "/api-keys/{id}" })
  .input(z.object({ id: z.coerce.number().int() }))
  .handler(async ({ input, context }) => {
    const db = getDb(context.databaseUrl);
    await db.delete(apiKeyChannels).where(eq(apiKeyChannels.keyId, input.id));
    await db
      .update(apiKeys)
      .set({ revokedBy: context.session?.user?.id || null })
      .where(eq(apiKeys.id, input.id));
    return { ok: true };
  });

export const apiKeyRouter = {
  list: listApiKeys,
  create: createApiKey,
  revoke: revokeApiKey,
};

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  apiKeyRequiredProcedure,
  authOrApiKeyProcedure,
  authRequiredProcedure,
  isChannelManager,
} from "../context";
import {
  generateApiKey,
  lookupApiKey,
  resolveDelegatedScope,
} from "../../lib/api-keys";
import { apiKeys, apiKeyChannels, authUser, channels } from "../../db/schema";
import { and, eq, isNull } from "drizzle-orm";
import { aliasedTable } from "drizzle-orm/alias";
import { getChannel as dbGetChannel } from "../../db/queries";
import type { Channel } from "../../db/queries";
import type { DB } from "../../db";

export function canCreateApiKeyForChannel(
  channel: Pick<Channel, "accessPermUsers">,
  slackId: string,
  options: { isLockdown: boolean; isManager: boolean },
): boolean {
  return (
    options.isLockdown ||
    options.isManager ||
    channel.accessPermUsers.includes("*") ||
    channel.accessPermUsers.includes(slackId)
  );
}

export const listApiKeys = authRequiredProcedure
  .route({ method: "GET", path: "/api-keys" })
  .handler(async ({ context }) => {
    const db = context.db;
    const userId = context.session?.user?.id;
    if (!userId) return [];

    const revokedByUser = aliasedTable(authUser, "revokedByUser");
    const keys = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        revokedBy: revokedByUser.slackId,
        canDelegate: apiKeys.canDelegate,
      })
      .from(apiKeys)
      .leftJoin(revokedByUser, eq(apiKeys.revokedBy, revokedByUser.id))
      // Child keys belong to their parent's owner but are managed through the
      // parent key, so they stay out of the owner's key list.
      .where(and(eq(apiKeys.owner, userId), isNull(apiKeys.parentId)));

    const keysWithChannels = await Promise.all(
      keys.map(async (key) => {
        const keyChannels = await db
          .select({ id: apiKeyChannels.channelId, name: channels.name })
          .from(apiKeyChannels)
          .leftJoin(channels, eq(apiKeyChannels.channelId, channels.id))
          .where(eq(apiKeyChannels.keyId, key.id));
        return {
          ...key,
          channels: keyChannels.map((c) => ({
            id: c.id,
            name: c.name || c.id,
          })),
        };
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
      canDelegate: z.boolean().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const slackId = context.session?.user?.slackId;
    if (!slackId)
      throw new ORPCError("FORBIDDEN", { message: "No Slack ID on session" });

    const db = context.db;

    if (input.canDelegate) {
      if (!context.lockdownUsers.includes(slackId))
        throw new ORPCError("FORBIDDEN", {
          message: "Only admins can create delegating API keys",
        });
      if (!input.channelIds || input.channelIds.length === 0)
        throw new ORPCError("BAD_REQUEST", {
          message: "A delegating API key must be scoped to specific channels",
        });
    }

    // Validate user has access to each specified channel
    if (input.channelIds && input.channelIds.length > 0) {
      const isLockdown = context.lockdownUsers.includes(slackId);
      for (const channelId of input.channelIds) {
        const ch = await dbGetChannel(db, channelId);
        if (!ch)
          throw new ORPCError("NOT_FOUND", {
            message: `Channel ${channelId} not found`,
          });
        const isManager = isLockdown
          ? false
          : await isChannelManager(channelId, slackId, context.slackToken);
        if (
          !canCreateApiKeyForChannel(ch, slackId, { isLockdown, isManager })
        ) {
          throw new ORPCError("FORBIDDEN", {
            message: `You don't have access to channel ${ch.name || channelId}`,
          });
        }
      }
    }

    const { fullKey, keyPrefix, secretHash } = generateApiKey();
    const hash = await secretHash;

    const [keyRow] = await db
      .insert(apiKeys)
      .values({
        name: input.name,
        owner: context.session?.user?.id || null,
        keyPrefix,
        secretHash: hash,
        canDelegate: input.canDelegate ?? false,
      })
      .returning({ id: apiKeys.id });

    if (input.channelIds && keyRow) {
      await insertKeyChannels(db, keyRow.id, input.channelIds);
    }

    return { fullKey, keyPrefix, name: input.name, id: keyRow?.id };
  });

async function insertKeyChannels(db: DB, keyId: number, channelIds: string[]) {
  if (channelIds.length === 0) return;
  await db
    .insert(apiKeyChannels)
    .values(channelIds.map((channelId) => ({ keyId, channelId })));
}

// Children of one parent are namespaced under the parent's name, so a
// delegated key can never pass itself off as a first-party key.
export function childKeyName(parentName: string, subject: string): string {
  return `${parentName}/${subject}`;
}

function revokeChildrenOf(db: DB, parentId: number, subject: string) {
  return db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.parentId, parentId),
        eq(apiKeys.subject, subject),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({ id: apiKeys.id });
}

const subjectSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(
    /^[\w.@+-]+$/,
    "Subject may only contain letters, digits and . @ + - _",
  );

/**
 * Mint a child key for one end user (the subject) of a delegating key. Each
 * subject holds at most one live child per parent, so minting again rotates.
 */
export const delegateApiKey = apiKeyRequiredProcedure
  .route({ method: "POST", path: "/api-keys/delegate" })
  .input(
    z.object({
      subject: subjectSchema,
      channelIds: z.array(z.string()).optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const parent = context.apiKey;
    const channelIds = resolveDelegatedScope(parent, input.channelIds);
    const db = context.db;

    await revokeChildrenOf(db, parent.id, input.subject);

    const { fullKey, keyPrefix, secretHash } = generateApiKey();
    const name = childKeyName(parent.name, input.subject);
    const [keyRow] = await db
      .insert(apiKeys)
      .values({
        name,
        owner: parent.owner,
        keyPrefix,
        secretHash: await secretHash,
        parentId: parent.id,
        subject: input.subject,
      })
      .returning({ id: apiKeys.id });
    if (!keyRow)
      throw new ORPCError("INTERNAL_SERVER_ERROR", {
        message: "Could not create API key",
      });

    await insertKeyChannels(db, keyRow.id, channelIds);

    return { fullKey, keyPrefix, name, id: keyRow.id, channelIds };
  });

export const revokeDelegatedApiKeys = apiKeyRequiredProcedure
  .route({ method: "DELETE", path: "/api-keys/delegate/{subject}" })
  .input(z.object({ subject: subjectSchema }))
  .handler(async ({ input, context }) => {
    resolveDelegatedScope(context.apiKey, undefined);
    const revoked = await revokeChildrenOf(
      context.db,
      context.apiKey.id,
      input.subject,
    );
    return { ok: true, revoked: revoked.length };
  });

/** Describe the calling key, so services can validate keys they handed out. */
export const introspectApiKey = apiKeyRequiredProcedure
  .route({ method: "GET", path: "/api-keys/self" })
  .handler(async ({ context }) => {
    const key = context.apiKey;
    return {
      id: key.id,
      name: key.name,
      channelIds: key.channelIds,
      canDelegate: key.canDelegate,
      parentId: key.parentId,
      subject: key.subject,
    };
  });

export const revokeApiKey = authRequiredProcedure
  .route({ method: "DELETE", path: "/api-keys/{id}" })
  .input(z.object({ id: z.coerce.number().int() }))
  .handler(async ({ input, context }) => {
    const db = context.db;
    const userId = context.session.user.id;
    const slackId = context.session.user.slackId;
    const [key] = await db
      .select({ owner: apiKeys.owner })
      .from(apiKeys)
      .where(eq(apiKeys.id, input.id));
    const isLockdown = !!slackId && context.lockdownUsers.includes(slackId);
    if (!key || (key.owner !== userId && !isLockdown))
      throw new ORPCError("NOT_FOUND", { message: "API key not found" });

    // Channel rows stay: deleting them would turn a scoped key into an
    // unscoped one. Revocation alone is what stops the key authenticating.
    await db
      .update(apiKeys)
      .set({ revokedBy: userId, revokedAt: new Date() })
      .where(eq(apiKeys.id, input.id));
    return { ok: true };
  });

const fullKeySchema = z.string().min(1).max(256);

/**
 * Revoke any key by presenting it in full. Holding the key is the proof, so
 * any signed-in user or API key may do this (e.g. to kill a leaked key).
 */
export const revokeApiKeyByValue = authOrApiKeyProcedure
  .route({ method: "POST", path: "/api-keys/revoke" })
  .input(z.object({ key: fullKeySchema }))
  .handler(async ({ input, context }) => {
    const found = await lookupApiKey(input.key, context.databaseUrl);
    if (!found)
      throw new ORPCError("NOT_FOUND", { message: "API key not found" });
    if (found.revoked) return { ok: true, alreadyRevoked: true };

    await context.db
      .update(apiKeys)
      .set({
        revokedAt: new Date(),
        revokedBy: context.session?.user.id ?? null,
      })
      .where(eq(apiKeys.id, found.identity.id));
    return { ok: true, alreadyRevoked: false };
  });

/**
 * Let a delegating key check a child it handed out, including whether and
 * when it was revoked, so the service can tell the child's holder.
 */
export const delegatedKeyStatus = apiKeyRequiredProcedure
  .route({ method: "POST", path: "/api-keys/delegate/status" })
  .input(z.object({ key: fullKeySchema }))
  .handler(async ({ input, context }) => {
    resolveDelegatedScope(context.apiKey, undefined);
    const found = await lookupApiKey(input.key, context.databaseUrl);
    if (!found || found.identity.parentId !== context.apiKey.id)
      return { status: "unknown" as const };
    if (found.revoked)
      return {
        status: "revoked" as const,
        subject: found.identity.subject,
        revokedAt: found.revokedAt?.toISOString() ?? null,
      };

    await context.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(apiKeys.id, found.identity.id));
    return {
      status: "active" as const,
      subject: found.identity.subject,
      channelIds: found.identity.channelIds,
    };
  });

export const apiKeyRouter = {
  list: listApiKeys,
  create: createApiKey,
  revoke: revokeApiKey,
  delegate: delegateApiKey,
  revokeDelegated: revokeDelegatedApiKeys,
  self: introspectApiKey,
  revokeByValue: revokeApiKeyByValue,
  delegateStatus: delegatedKeyStatus,
};

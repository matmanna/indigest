import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  apiKeyRequiredProcedure,
  authOrApiKeyProcedure,
  authRequiredProcedure,
  auditAction,
  isChannelManager,
} from "../context";
import { auditActions } from "../../lib/audit";
import {
  generateApiKey,
  lookupApiKey,
  resolveDelegatedScope,
} from "../../lib/api-keys";
import { apiKeys, apiKeyChannels, authUser, channels } from "../../db/schema";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
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

/**
 * The caller's keys, each with the subkeys it has minted. Admins (lockdown
 * users) may pass `scope=all` to see every user's keys, with owners.
 */
export const listApiKeys = authRequiredProcedure
  .route({ method: "GET", path: "/api-keys" })
  .input(z.object({ scope: z.enum(["mine", "all"]).default("mine") }))
  .handler(async ({ input, context }) => {
    const db = context.db;
    const userId = context.session.user.id;
    const slackId = context.session.user.slackId;
    const all = input.scope === "all";
    if (all && !(slackId && context.lockdownUsers.includes(slackId)))
      throw new ORPCError("FORBIDDEN", { message: "Admins only" });

    const revokedByUser = aliasedTable(authUser, "revokedByUser");
    const ownerUser = aliasedTable(authUser, "ownerUser");
    // Child keys share their parent's owner, so one query covers both.
    const rows = await db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
        revokedAt: apiKeys.revokedAt,
        revokedBy: revokedByUser.slackId,
        canDelegate: apiKeys.canDelegate,
        parentId: apiKeys.parentId,
        subject: apiKeys.subject,
        ownerId: apiKeys.owner,
        ownerName: ownerUser.name,
        ownerSlackId: ownerUser.slackId,
      })
      .from(apiKeys)
      .leftJoin(revokedByUser, eq(apiKeys.revokedBy, revokedByUser.id))
      .leftJoin(ownerUser, eq(apiKeys.owner, ownerUser.id))
      .where(all ? undefined : eq(apiKeys.owner, userId))
      .orderBy(desc(apiKeys.createdAt));

    const ids = rows.map((r) => r.id);
    const channelRows = ids.length
      ? await db
          .select({
            keyId: apiKeyChannels.keyId,
            id: apiKeyChannels.channelId,
            name: channels.name,
          })
          .from(apiKeyChannels)
          .leftJoin(channels, eq(apiKeyChannels.channelId, channels.id))
          .where(inArray(apiKeyChannels.keyId, ids))
      : [];
    const channelsByKey = new Map<number, { id: string; name: string }[]>();
    for (const c of channelRows) {
      if (c.keyId == null || !c.id) continue;
      const list = channelsByKey.get(c.keyId) ?? [];
      list.push({ id: c.id, name: c.name || c.id });
      channelsByKey.set(c.keyId, list);
    }

    const byId = new Map(rows.map((r) => [r.id, r]));
    const shape = (r: (typeof rows)[number]) => ({
      id: r.id,
      name: r.name,
      keyPrefix: r.keyPrefix,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
      revokedAt: r.revokedAt,
      revokedBy: r.revokedBy,
      canDelegate: r.canDelegate,
      channels: channelsByKey.get(r.id) ?? [],
      owner: { id: r.ownerId, name: r.ownerName, slackId: r.ownerSlackId },
    });
    type Subkey = ReturnType<typeof shape> & {
      subject: string | null;
      label: string | null;
    };
    const children = new Map<number, Subkey[]>();
    for (const r of rows) {
      if (r.parentId == null) continue;
      const parent = byId.get(r.parentId);
      const list = children.get(r.parentId) ?? [];
      list.push({
        ...shape(r),
        subject: r.subject,
        label:
          parent && r.subject
            ? childKeyLabel(r.name, parent.name, r.subject)
            : null,
      });
      children.set(r.parentId, list);
    }

    return rows
      .filter((r) => r.parentId == null)
      .map((r) => ({ ...shape(r), subkeys: children.get(r.id) ?? [] }));
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
    await auditAction(context, auditActions.apiKeyCreate, {
      target: {
        id: String(keyRow?.id),
        name: input.name,
        keyPrefix,
        channelIds: input.channelIds ?? [],
        canDelegate: input.canDelegate ?? false,
      },
    });

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
export function childKeyName(
  parentName: string,
  subject: string,
  label?: string | null,
): string {
  const base = `${parentName}/${subject}`;
  return label ? `${base} - ${label}` : base;
}

// The label a subject gave a child key, read back out of its name
// ("parent/subject - Feedly" gives "Feedly"). Null when it has none.
export function childKeyLabel(
  name: string,
  parentName: string,
  subject: string,
): string | null {
  const base = childKeyName(parentName, subject);
  if (!name.startsWith(`${base} - `)) return null;
  return name.slice(base.length + 3) || null;
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
 * Mint a child key for one end user (the subject) of a delegating key. A
 * subject may hold any number of live children: minting never revokes the
 * ones they already have. Revoke them by value, or all at once by subject.
 */
const labelSchema = z.string().trim().min(1).max(60);

export const delegateApiKey = apiKeyRequiredProcedure
  .route({ method: "POST", path: "/api-keys/delegate" })
  .input(
    z.object({
      subject: subjectSchema,
      channelIds: z.array(z.string()).optional(),
      label: labelSchema.optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const parent = context.apiKey;
    const channelIds = resolveDelegatedScope(parent, input.channelIds);
    const db = context.db;

    const { fullKey, keyPrefix, secretHash } = generateApiKey();
    const name = childKeyName(parent.name, input.subject, input.label);
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
    await auditAction(context, auditActions.apiKeyDelegate, {
      target: {
        id: String(keyRow.id),
        parentId: parent.id,
        subject: input.subject,
        channelIds,
        label: input.label ?? null,
      },
    });

    return {
      fullKey,
      keyPrefix,
      name,
      id: keyRow.id,
      channelIds,
      label: input.label ?? null,
    };
  });

/** A subject's live delegated keys, newest first. Never includes secrets. */
export const listDelegatedApiKeys = apiKeyRequiredProcedure
  .route({ method: "GET", path: "/api-keys/delegate/{subject}" })
  .input(z.object({ subject: subjectSchema }))
  .handler(async ({ input, context }) => {
    resolveDelegatedScope(context.apiKey, undefined);
    const keys = await context.db
      .select({
        id: apiKeys.id,
        name: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        createdAt: apiKeys.createdAt,
        lastUsedAt: apiKeys.lastUsedAt,
      })
      .from(apiKeys)
      .where(
        and(
          eq(apiKeys.parentId, context.apiKey.id),
          eq(apiKeys.subject, input.subject),
          isNull(apiKeys.revokedAt),
          isNull(apiKeys.revokedBy),
        ),
      )
      .orderBy(desc(apiKeys.createdAt));
    return {
      keys: keys.map(({ name, ...key }) => ({
        ...key,
        label: childKeyLabel(name, context.apiKey.name, input.subject),
        createdAt: key.createdAt.toISOString(),
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      })),
    };
  });

/** Revoke one of a subject's delegated keys by id. */
export const revokeDelegatedApiKey = apiKeyRequiredProcedure
  .route({ method: "DELETE", path: "/api-keys/delegate/{subject}/{id}" })
  .input(z.object({ subject: subjectSchema, id: z.coerce.number().int() }))
  .handler(async ({ input, context }) => {
    resolveDelegatedScope(context.apiKey, undefined);
    // Scoped to this parent and subject, so a caller can only revoke keys it
    // minted for that person.
    const revoked = await context.db
      .update(apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, input.id),
          eq(apiKeys.parentId, context.apiKey.id),
          eq(apiKeys.subject, input.subject),
          isNull(apiKeys.revokedAt),
        ),
      )
      .returning({ id: apiKeys.id });
    await auditAction(context, auditActions.apiKeyRevoke, {
      target: {
        id: String(input.id),
        parentId: context.apiKey.id,
        subject: input.subject,
      },
      outcome: revoked.length ? undefined : "denied",
      reason: revoked.length
        ? "revoked one delegated key"
        : "no live key with that id for this subject",
    });
    return { ok: true, revoked: revoked.length };
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
    await auditAction(context, auditActions.apiKeyRevoke, {
      target: {
        id: revoked.map((r) => r.id).join(",") || "none",
        parentId: context.apiKey.id,
        subject: input.subject,
      },
      reason: "revoked delegated keys by subject",
    });
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
    if (!key || (key.owner !== userId && !isLockdown)) {
      if (key)
        await auditAction(context, auditActions.apiKeyRevoke, {
          target: { id: String(input.id) },
          outcome: "denied",
          reason: "not the key's owner",
        });
      throw new ORPCError("NOT_FOUND", { message: "API key not found" });
    }

    // Channel rows stay: deleting them would turn a scoped key into an
    // unscoped one. Revocation alone is what stops the key authenticating.
    await db
      .update(apiKeys)
      .set({ revokedBy: userId, revokedAt: new Date() })
      .where(eq(apiKeys.id, input.id));
    await auditAction(context, auditActions.apiKeyRevoke, {
      target: { id: String(input.id), owner: key.owner },
      reason: key.owner === userId ? undefined : "revoked by admin",
    });
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
    await auditAction(context, auditActions.apiKeyRevoke, {
      target: { id: String(found.identity.id), name: found.identity.name },
      reason: "revoked by presenting the key",
    });
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
  listDelegated: listDelegatedApiKeys,
  revokeOneDelegated: revokeDelegatedApiKey,
  self: introspectApiKey,
  revokeByValue: revokeApiKeyByValue,
  delegateStatus: delegatedKeyStatus,
};

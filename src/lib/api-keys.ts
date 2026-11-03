import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { ORPCError } from "@orpc/server";

const KEY_PREFIX = "ind_";
const KEY_PREFIX_LENGTH = 12;

export function generateApiKey(): {
  fullKey: string;
  keyPrefix: string;
  secretHash: Promise<string>;
} {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const secret = Array.from(array, (b) => b.toString(36).padStart(2, "0")).join(
    "",
  );
  const fullKey = KEY_PREFIX + secret;
  const keyPrefix = secret.slice(0, KEY_PREFIX_LENGTH);
  const secretHash = hashSecret(fullKey);
  return { fullKey, keyPrefix, secretHash };
}

export async function hashSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function verifySecret(
  secret: string,
  storedHash: string,
): Promise<boolean> {
  const computedHash = await hashSecret(secret);
  const a = Buffer.from(computedHash, "utf-8");
  const b = Buffer.from(storedHash, "utf-8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export interface ApiKeyIdentity {
  id: number;
  keyPrefix: string;
  name: string;
  owner: string | null;
  channelIds: string[];
  canDelegate: boolean;
  parentId: number | null;
  subject: string | null;
}

export function isRevoked(key: {
  revokedAt: Date | null;
  revokedBy: string | null;
}): boolean {
  return key.revokedAt !== null || key.revokedBy !== null;
}

export async function createApiKeyContext({
  req,
  databaseUrl,
  defer,
}: {
  req: Request;
  databaseUrl: string;
  defer?: (work: Promise<unknown>) => void;
}): Promise<ApiKeyIdentity> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid API key",
    });
  }

  return authenticateApiKey(authHeader.slice(7), databaseUrl, defer);
}

export interface ApiKeyLookup {
  /** When the key last authenticated a request, as far as is recorded. */
  lastUsedAt?: Date | null;
  identity: ApiKeyIdentity;
  revoked: boolean;
  // When the key (or its parent) was revoked; null if unknown, as for keys
  // revoked before revokedAt existed.
  revokedAt: Date | null;
}

/**
 * Find the key a full token belongs to, revoked or not. Returns undefined when
 * the token matches no key.
 */
export async function lookupApiKey(
  token: string,
  databaseUrl: string,
): Promise<ApiKeyLookup | undefined> {
  if (!token.startsWith(KEY_PREFIX)) return undefined;

  const rawKey = token.slice(KEY_PREFIX.length);
  if (rawKey.length < KEY_PREFIX_LENGTH) return undefined;

  const keyPrefix = rawKey.slice(0, KEY_PREFIX_LENGTH);

  const db = getDb(databaseUrl);
  const parentKey = alias(schema.apiKeys, "parent_key");

  const rows = await db
    .select({
      id: schema.apiKeys.id,
      keyPrefix: schema.apiKeys.keyPrefix,
      name: schema.apiKeys.name,
      owner: schema.apiKeys.owner,
      secretHash: schema.apiKeys.secretHash,
      revokedAt: schema.apiKeys.revokedAt,
      revokedBy: schema.apiKeys.revokedBy,
      canDelegate: schema.apiKeys.canDelegate,
      parentId: schema.apiKeys.parentId,
      subject: schema.apiKeys.subject,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      parentRevokedAt: parentKey.revokedAt,
      parentRevokedBy: parentKey.revokedBy,
      channelId: schema.apiKeyChannels.channelId,
    })
    .from(schema.apiKeys)
    .leftJoin(parentKey, eq(schema.apiKeys.parentId, parentKey.id))
    .leftJoin(
      schema.apiKeyChannels,
      eq(schema.apiKeys.id, schema.apiKeyChannels.keyId),
    )
    .where(eq(schema.apiKeys.keyPrefix, keyPrefix));

  const keyRow = rows[0];
  if (!keyRow || !(await verifySecret(token, keyRow.secretHash)))
    return undefined;

  // A child of a revoked parent counts as revoked too.
  const parentRevoked =
    keyRow.parentId !== null &&
    isRevoked({
      revokedAt: keyRow.parentRevokedAt,
      revokedBy: keyRow.parentRevokedBy,
    });
  const revoked = isRevoked(keyRow) || parentRevoked;
  const revokedAt = !revoked
    ? null
    : ([keyRow.revokedAt, parentRevoked ? keyRow.parentRevokedAt : null]
        .filter((date): date is Date => date !== null)
        .sort((x, y) => x.getTime() - y.getTime())[0] ?? null);

  return {
    lastUsedAt: keyRow.lastUsedAt,
    identity: {
      id: keyRow.id,
      keyPrefix: keyRow.keyPrefix,
      name: keyRow.name,
      owner: keyRow.owner,
      channelIds: rows.filter((r) => r.channelId).map((r) => r.channelId!),
      canDelegate: keyRow.canDelegate,
      parentId: keyRow.parentId,
      subject: keyRow.subject,
    },
    revoked,
    revokedAt,
  };
}

// "Last used" is only recorded this often, so a busy key does not add a
// database write to every request it makes.
const LAST_USED_RESOLUTION_MS = 60_000;

/**
 * Checks a key. Its "last used" time is written in the background when the
 * caller gives a `defer` (such as a Worker's waitUntil), so a request does not
 * wait for the write; without one it is written before returning.
 */
export async function authenticateApiKey(
  token: string,
  databaseUrl: string,
  defer?: (work: Promise<unknown>) => void,
): Promise<ApiKeyIdentity> {
  if (!token.startsWith(KEY_PREFIX)) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid API key format",
    });
  }

  const found = await lookupApiKey(token, databaseUrl);
  if (!found) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid API key",
    });
  }

  // A revoked key, or a child of a revoked parent, must never authenticate.
  if (found.revoked) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "API key has been revoked",
    });
  }

  const stale =
    !found.lastUsedAt ||
    Date.now() - found.lastUsedAt.getTime() >= LAST_USED_RESOLUTION_MS;
  if (stale) {
    const write = getDb(databaseUrl)
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(eq(schema.apiKeys.id, found.identity.id))
      .then(() => undefined);
    if (defer) defer(write.catch(() => undefined));
    else await write;
  }

  return found.identity;
}

/**
 * Validate a request to mint a child key. Children are one level deep, must
 * come from a delegating key with an explicit channel scope, and may only
 * narrow that scope. Returns the child's channel scope.
 */
export function resolveDelegatedScope(
  parent: Pick<ApiKeyIdentity, "canDelegate" | "parentId" | "channelIds">,
  requested: string[] | undefined,
): string[] {
  if (!parent.canDelegate || parent.parentId !== null) {
    throw new ORPCError("FORBIDDEN", {
      message: "This API key cannot mint child keys",
    });
  }
  if (parent.channelIds.length === 0) {
    throw new ORPCError("FORBIDDEN", {
      message: "A delegating API key must be scoped to specific channels",
    });
  }
  if (!requested || requested.length === 0) return [...parent.channelIds];

  const outside = requested.filter((id) => !parent.channelIds.includes(id));
  if (outside.length > 0) {
    throw new ORPCError("FORBIDDEN", {
      message: `Channels outside this key's scope: ${outside.join(", ")}`,
    });
  }
  return [...new Set(requested)];
}

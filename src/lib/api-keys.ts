import { timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { getDb } from "../db";
import * as schema from "../db/schema";
import { ORPCError } from "@orpc/server";

const KEY_PREFIX = "ind_";
const KEY_PREFIX_LENGTH = 12;

export function generateApiKey(): { fullKey: string; keyPrefix: string; secretHash: Promise<string> } {
  const array = new Uint8Array(24);
  crypto.getRandomValues(array);
  const secret = Array.from(array, (b) => b.toString(36).padStart(2, "0")).join("");
  const fullKey = KEY_PREFIX + secret;
  const keyPrefix = secret.slice(0, KEY_PREFIX_LENGTH);
  const secretHash = hashSecret(fullKey);
  return { fullKey, keyPrefix, secretHash };
}

export async function hashSecret(secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(secret);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, "0")).join("");
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
}

export async function createApiKeyContext({
  req,
  databaseUrl,
}: {
  req: Request;
  databaseUrl: string;
}): Promise<ApiKeyIdentity> {
  const authHeader = req.headers.get("Authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid API key",
    });
  }

  const token = authHeader.slice(7);
  if (!token.startsWith(KEY_PREFIX)) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid API key format",
    });
  }

  const rawKey = token.slice(KEY_PREFIX.length);
  if (rawKey.length < KEY_PREFIX_LENGTH) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid API key",
    });
  }

  const keyPrefix = rawKey.slice(0, KEY_PREFIX_LENGTH);

  const db = getDb(databaseUrl);

  const rows = await db
    .select({
      id: schema.apiKeys.id,
      keyPrefix: schema.apiKeys.keyPrefix,
      name: schema.apiKeys.name,
      owner: schema.apiKeys.owner,
      secretHash: schema.apiKeys.secretHash,
      lastUsedAt: schema.apiKeys.lastUsedAt,
      channelId: schema.apiKeyChannels.channelId,
    })
    .from(schema.apiKeys)
    .leftJoin(schema.apiKeyChannels, eq(schema.apiKeys.id, schema.apiKeyChannels.keyId))
    .where(eq(schema.apiKeys.keyPrefix, keyPrefix));

  if (rows.length === 0) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid API key",
    });
  }

  const keyRow = rows[0]!;

  const valid = await verifySecret(token, keyRow.secretHash);
  if (!valid) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Invalid API key",
    });
  }

  const channelIds = rows
    .filter((r) => r.channelId)
    .map((r) => r.channelId!);

  await db
    .update(schema.apiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(schema.apiKeys.id, keyRow.id));

  return {
    id: keyRow.id,
    keyPrefix: keyRow.keyPrefix,
    name: keyRow.name,
    owner: keyRow.owner,
    channelIds,
  };
}

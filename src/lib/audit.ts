import {
  audit as emitAudit,
  auditDiff,
  buildAuditFields,
  defineAuditAction,
  initLogger,
  type AuditActor,
  type AuditFields,
  type AuditInput,
  type AuditTarget,
} from "evlog";
import { desc, sql } from "drizzle-orm";
import type { DB } from "../db";
import * as schema from "../db/schema";

// evlog prints each audit event as a structured line, which Workers
// observability picks up. Postgres is the durable store; see recordAudit.
initLogger({
  env: { service: "indigest" },
  pretty: false,
  stringify: false,
  enabled: !(typeof process !== "undefined" && process.env?.NODE_ENV === "test"),
});

/** Every auditable action, in one place so the admin UI can describe them. */
export const auditActions = {
  channelUpdate: defineAuditAction("channel.update", {
    target: "channel",
    severity: "medium",
    description: "Changed a channel's settings from the dashboard",
    requiresChanges: true,
  }),
  channelPublish: defineAuditAction("channel.publish", {
    target: "channel",
    severity: "medium",
    description: "Pub'd a channel from the dashboard",
  }),
  channelUnpublish: defineAuditAction("channel.unpublish", {
    target: "channel",
    severity: "medium",
    description: "Unpub'd a channel from the dashboard",
  }),
  channelCommand: defineAuditAction("channel.command", {
    target: "channel",
    severity: "medium",
    description: "Ran an /in slash command that changes channel config",
  }),
  subscriptionAdd: defineAuditAction("subscription.add", {
    target: "channel",
    severity: "medium",
    description: "Subscribed a channel to another channel's feed",
  }),
  subscriptionUpdate: defineAuditAction("subscription.update", {
    target: "channel",
    severity: "low",
    description: "Changed a subscription's forwarding profile",
  }),
  subscriptionRemove: defineAuditAction("subscription.remove", {
    target: "channel",
    severity: "medium",
    description: "Removed a subscription",
  }),
  apiKeyCreate: defineAuditAction("api_key.create", {
    target: "api_key",
    severity: "high",
    description: "Created an API key",
  }),
  apiKeyUpdate: defineAuditAction("api_key.update", {
    target: "api_key",
    severity: "high",
    description: "Changed which channels an API key covers",
    requiresChanges: true,
  }),
  apiKeyRevoke: defineAuditAction("api_key.revoke", {
    target: "api_key",
    severity: "high",
    description: "Revoked an API key",
  }),
  apiKeyDelegate: defineAuditAction("api_key.delegate", {
    target: "api_key",
    severity: "medium",
    description: "Minted a delegated child key",
  }),
  authSignIn: defineAuditAction("auth.sign_in", {
    target: "user",
    severity: "low",
    description: "Signed in with Hack Club",
  }),
  authSignOut: defineAuditAction("auth.sign_out", {
    target: "user",
    severity: "low",
    description: "A session ended (sign out or revoke)",
  }),
} as const;

export type AuditSource = "web" | "api" | "slack" | "auth" | "system";

export interface AuditRecordContext {
  source: AuditSource;
  /** Slack user ID of the actor, kept apart so it can be filtered on. */
  actorSlackId?: string | null;
  targetName?: string | null;
  severity?: string;
  ip?: string | null;
  userAgent?: string | null;
  [key: string]: unknown;
}

/** Actor for a dashboard session or API key, as evlog expects it. */
export function actorFor(identity: {
  session?: { user: { id: string; name?: string | null; email?: string | null } } | null;
  apiKey?: { id: number; name: string } | null;
}): AuditActor {
  if (identity.session)
    return {
      type: "user",
      id: identity.session.user.id,
      displayName: identity.session.user.name || undefined,
    };
  if (identity.apiKey)
    return {
      type: "api",
      id: `api_key:${identity.apiKey.id}`,
      displayName: identity.apiKey.name,
    };
  return { type: "system", id: "anonymous" };
}

/** Compact before/after patch, never including secrets. */
export function diff(before: unknown, after: unknown) {
  return auditDiff(before, after, {
    redactPaths: ["secretHash", "fullKey", "token", "*.token"],
  });
}

async function sha256(text: string): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Stable JSON (sorted keys) so the hash doesn't depend on key order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

type AuditRow = typeof schema.auditLog.$inferSelect;
export type HashedFields = Omit<AuditRow, "id" | "hash" | "prevHash" | "createdAt"> & {
  createdAt: Date;
};

/** Hash of a row's content chained onto the previous row's hash. */
export function hashRow(prevHash: string | null, row: HashedFields): Promise<string> {
  const { createdAt, ...rest } = row;
  return sha256(`${prevHash ?? ""}\n${canonical({ ...rest, createdAt: createdAt.toISOString() })}`);
}

/**
 * Record one audit event: emit it through evlog and append it to the
 * audit_log table, chained to the previous row's hash. Never throws — a
 * failing audit write is logged rather than failing the user's action.
 */
export async function recordAudit(
  db: DB,
  input: AuditInput,
  ctx: AuditRecordContext,
): Promise<void> {
  const fields: AuditFields = buildAuditFields(input);
  const { source, actorSlackId, targetName, severity, ip, userAgent, ...extra } = ctx;
  const context = {
    ...(ip ? { ip } : {}),
    ...(userAgent ? { userAgent } : {}),
    ...extra,
  };
  try {
    emitAudit({ ...input, outcome: fields.outcome });
  } catch {}

  const row: HashedFields = {
    createdAt: new Date(),
    action: fields.action,
    outcome: fields.outcome,
    severity: severity ?? severityOf(fields.action),
    source,
    actorType: fields.actor.type,
    actorId: fields.actor.id,
    actorName: fields.actor.displayName ?? null,
    actorSlackId: actorSlackId ?? null,
    targetType: fields.target?.type ?? null,
    targetId: fields.target?.id ?? null,
    targetName: targetName ?? null,
    reason: fields.reason ?? null,
    changes: fields.changes ?? null,
    context: Object.keys(context).length ? context : null,
  };

  try {
    await db.transaction(async (tx) => {
      // Serialize writers so every row chains to the one before it.
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('audit_log'))`);
      const [last] = await tx
        .select({ hash: schema.auditLog.hash })
        .from(schema.auditLog)
        .orderBy(desc(schema.auditLog.id))
        .limit(1);
      const prevHash = last?.hash ?? null;
      const hash = await hashRow(prevHash, row);
      await tx.insert(schema.auditLog).values({ ...row, prevHash, hash });
    });
  } catch (err: any) {
    console.error("audit write failed:", err?.message || err, fields.action);
  }
}

/**
 * Recompute the chain over rows in id order. Returns the id of the first row
 * whose hash doesn't match, or null when the whole chain is intact.
 */
export async function verifyAuditChain(rows: AuditRow[]): Promise<number | null> {
  let prev: string | null = rows[0]?.prevHash ?? null;
  for (const r of rows) {
    const { id, hash, prevHash, ...fields } = r;
    if (prevHash !== prev) return id;
    if ((await hashRow(prevHash, fields)) !== hash) return id;
    prev = hash;
  }
  return null;
}

function severityOf(action: string): string {
  for (const def of Object.values(auditActions))
    if (def.action === action) return def.severity ?? "low";
  return "low";
}

export function channelTarget(id: string): AuditTarget {
  return { type: "channel", id };
}

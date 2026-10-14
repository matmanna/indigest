import { ORPCError } from "@orpc/server";
import { os } from "@orpc/server";
import { WebClient } from "@slack/web-api";
import type { DB } from "../db";
import type { ApiKeyIdentity } from "../lib/api-keys";
import { actorFor, recordAudit, type AuditRecordContext } from "../lib/audit";
import type { AuditInput } from "evlog";

export interface SessionIdentity {
  user: {
    id: string;
    name: string;
    email: string;
    image?: string | null;
    slackId?: string | null;
  };
}

export interface ORPCContext {
  db: DB;
  session: SessionIdentity | null;
  apiKey: ApiKeyIdentity | null;
  databaseUrl: string;
  slackToken: string;
  lockdownUsers: string[];
  request?: { ip: string | null; userAgent: string | null };
}

/** Audit an action taken by whoever this request is authenticated as. */
export function auditAction(
  context: ORPCContext,
  def: { action: string; target?: string },
  input: Omit<AuditInput, "action" | "actor" | "target"> & {
    target?: { id: string; [key: string]: unknown };
  } = {},
  extra: Partial<AuditRecordContext> = {},
): Promise<void> {
  const { target, ...rest } = input;
  return recordAudit(
    context.db,
    {
      ...rest,
      action: def.action,
      actor: actorFor(context),
      target: target && { type: def.target ?? "unknown", ...target },
    },
    {
      source: context.session ? "web" : "api",
      actorSlackId: context.session?.user.slackId ?? null,
      ip: context.request?.ip,
      userAgent: context.request?.userAgent,
      ...extra,
    },
  );
}

const base = os.$context<ORPCContext>();

export const publicProcedure = base;

export const authRequiredProcedure = base.use(async ({ context, next }) => {
  if (!context.session) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Authentication required",
    });
  }
  return next({
    context: {
      session: context.session,
    },
  });
});

export const apiKeyRequiredProcedure = base.use(async ({ context, next }) => {
  if (!context.apiKey) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "API key required",
    });
  }
  return next({
    context: {
      apiKey: context.apiKey,
    },
  });
});

export const authOrApiKeyProcedure = base.use(async ({ context, next }) => {
  if (!context.session && !context.apiKey) {
    throw new ORPCError("UNAUTHORIZED", {
      message: "Authentication or API key required",
    });
  }
  return next();
});

export async function isChannelManager(
  channelId: string,
  userId: string,
  slackToken: string,
): Promise<boolean> {
  if (!slackToken) return false;
  const slack = new WebClient(slackToken);
  try {
    const conv = await slack.conversations.info({ channel: channelId });
    if ((conv.channel as any)?.creator === userId) return true;
  } catch {}
  try {
    const user = await slack.users.info({ user: userId });
    const u = user.user as any;
    if (u?.is_admin || u?.is_owner || u?.is_primary_owner) return true;
  } catch {}
  return false;
}

/**
 * Who may change a channel's indigest config from the web. Mirrors the slash
 * commands: lockdown users always may; while lockdown mode is on (any
 * lockdown users configured) nobody else may; otherwise channel managers may.
 */
export async function canManageChannel(
  context: Pick<ORPCContext, "lockdownUsers" | "slackToken">,
  channelId: string,
  slackId: string | null | undefined,
): Promise<boolean> {
  if (!slackId) return false;
  if (context.lockdownUsers.includes(slackId)) return true;
  if (context.lockdownUsers.length > 0) return false;
  return isChannelManager(channelId, slackId, context.slackToken);
}

/** Throw FORBIDDEN (and audit the denial) unless the user may manage it. */
export async function assertCanManageChannel(
  context: ORPCContext,
  channelId: string,
  slackId: string | null | undefined,
  def: { action: string },
): Promise<void> {
  if (await canManageChannel(context, channelId, slackId)) return;
  const message =
    context.lockdownUsers.length > 0
      ? "indigest is in lockdown mode; only authorized users can change channel settings"
      : "You must be the channel creator or a workspace admin to change this channel";
  await auditAction(
    context,
    { action: def.action, target: "channel" },
    { target: { id: channelId }, outcome: "denied", reason: message },
  );
  throw new ORPCError("FORBIDDEN", { message });
}

/**
 * The subset of channelIds the user may manage, checking workspace admin
 * status once instead of once per channel.
 */
export async function manageableChannelIds(
  context: Pick<ORPCContext, "lockdownUsers" | "slackToken">,
  channelIds: string[],
  slackId: string | null | undefined,
): Promise<Set<string>> {
  if (!slackId) return new Set();
  if (context.lockdownUsers.includes(slackId)) return new Set(channelIds);
  if (context.lockdownUsers.length > 0 || !context.slackToken) return new Set();
  const slack = new WebClient(context.slackToken);
  try {
    const user = await slack.users.info({ user: slackId });
    const u = user.user as any;
    if (u?.is_admin || u?.is_owner || u?.is_primary_owner)
      return new Set(channelIds);
  } catch {}
  const created = await Promise.all(
    channelIds.map(async (id) => {
      try {
        const conv = await slack.conversations.info({ channel: id });
        return (conv.channel as any)?.creator === slackId ? id : null;
      } catch {
        return null;
      }
    }),
  );
  return new Set(created.filter((id): id is string => !!id));
}

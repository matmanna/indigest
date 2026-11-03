import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import {
  publicProcedure,
  authOrApiKeyProcedure,
  authRequiredProcedure,
  isChannelManager,
  assertCanManageChannel,
  auditAction,
  canManageChannel,
  manageableChannelIds,
} from "../context";
import {
  getChannel as dbGetChannel,
  listChannels as dbListChannels,
  listEnabledChannels as dbListEnabledChannels,
  upsertChannel as dbUpsertChannel,
} from "../../db/queries";
import type { Channel } from "../../db/queries";
import { canCreateApiKeyForChannel } from "./apiKeys";
import { invalidateGraphCache } from "../../lib/graph-cache";
import { auditActions, diff } from "../../lib/audit";

const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  enabled: z.boolean(),
  linkMode: z.boolean(),
  webhookUrl: z.string(),
  autoApproveUsers: z.array(z.string()),
  manualUsers: z.array(z.string()),
  triggerMode: z.enum(["message", "shortcut"]),
  approvedPosters: z.array(z.string()),
  accessPermUsers: z.array(z.string()),
  trackReplies: z.boolean(),
  metadataSchema: z.string(),
  metadataRequired: z.boolean(),
  properties: z.string(),
  staticMetadata: z.string(),
  createdAt: z.string(),
});

const slackUserId = z.string().regex(/^[UW][A-Z0-9]+$/, "Not a Slack user ID");

const webhookUrlSchema = z
  .string()
  .max(2048)
  .refine((v) => v === "" || /^https?:\/\//.test(v), {
    message: "Webhook URL must start with http:// or https://",
  });

const metadataSchemaSchema = z
  .string()
  .max(20_000)
  .refine(
    (v) => {
      if (v === "") return true;
      try {
        const parsed = JSON.parse(v);
        return Array.isArray(parsed?.fields);
      } catch {
        return false;
      }
    },
    { message: "Metadata schema must be JSON with a `fields` array" },
  );

const propertiesSchema = z
  .string()
  .max(20_000)
  .refine(
    (v) => {
      if (v === "") return true;
      try {
        const parsed = JSON.parse(v);
        return !!parsed && typeof parsed === "object" && !Array.isArray(parsed);
      } catch {
        return false;
      }
    },
    { message: "Properties must be a JSON object" },
  );

/** Fields a channel manager may change from the web. */
const channelPatchSchema = z.object({
  enabled: z.boolean().optional(),
  linkMode: z.boolean().optional(),
  trackReplies: z.boolean().optional(),
  triggerMode: z.enum(["message", "shortcut"]).optional(),
  webhookUrl: webhookUrlSchema.optional(),
  autoApproveUsers: z.array(z.union([slackUserId, z.literal("*")])).optional(),
  manualUsers: z.array(z.union([slackUserId, z.literal("*")])).optional(),
  approvedPosters: z
    .array(z.union([slackUserId, z.literal("poster")]))
    .optional(),
  accessPermUsers: z.array(z.union([slackUserId, z.literal("*")])).optional(),
  metadataSchema: metadataSchemaSchema.optional(),
  metadataRequired: z.boolean().optional(),
  properties: propertiesSchema.optional(),
  staticMetadata: z.string().max(2000).optional(),
});

export type ChannelPatch = z.infer<typeof channelPatchSchema>;

/** Normalize JSON text fields so the stored form matches the slash commands. */
export function applyChannelPatch(ch: Channel, patch: ChannelPatch): Channel {
  const next: Channel = { ...ch };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    (next as any)[key] = value;
  }
  if (patch.metadataSchema !== undefined)
    next.metadataSchema = patch.metadataSchema
      ? JSON.stringify(JSON.parse(patch.metadataSchema))
      : "";
  if (patch.staticMetadata !== undefined)
    next.staticMetadata = patch.staticMetadata.trim();
  if (patch.properties !== undefined)
    next.properties = patch.properties
      ? JSON.stringify(JSON.parse(patch.properties))
      : "{}";
  // "*" alongside specific users is just "*".
  for (const key of [
    "autoApproveUsers",
    "manualUsers",
    "accessPermUsers",
  ] as const) {
    const list = [...new Set(next[key])];
    next[key] = list.includes("*") ? ["*"] : list;
  }
  next.approvedPosters = [...new Set(next.approvedPosters)];
  return next;
}

export const listChannels = publicProcedure
  .route({ method: "GET", path: "/channels" })
  .input(
    z.object({
      enabled: z.coerce.boolean().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const channels = input.enabled
      ? await dbListEnabledChannels(context.db)
      : await dbListChannels(context.db);
    return channels;
  });

/** Every known channel, flagged with whether the caller may manage it. */
export const listManageable = authRequiredProcedure
  .route({ method: "GET", path: "/channels/manageable" })
  .handler(async ({ context }) => {
    const slackId = context.session.user.slackId;
    const channels = await dbListChannels(context.db);
    const manageable = await manageableChannelIds(
      context,
      channels.map((ch) => ch.id),
      slackId,
    );
    return {
      lockdown: context.lockdownUsers.length > 0,
      isAdmin: !!slackId && context.lockdownUsers.includes(slackId),
      channels: channels.map((ch) => ({
        ...ch,
        canManage: manageable.has(ch.id),
      })),
    };
  });

export const getChannel = publicProcedure
  .route({ method: "GET", path: "/channels/{id}" })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const ch = await dbGetChannel(context.db, input.id);
    if (!ch) throw new ORPCError("NOT_FOUND", { message: "Channel not found" });
    return ch;
  });

/** Whether the signed-in user may change this channel's settings. */
export const channelPermissions = authRequiredProcedure
  .route({ method: "GET", path: "/channels/{id}/permissions" })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const slackId = context.session.user.slackId;
    return {
      canManage: await canManageChannel(context, input.id, slackId),
      isAdmin: !!slackId && context.lockdownUsers.includes(slackId),
      lockdown: context.lockdownUsers.length > 0,
    };
  });

export const upsertChannel = authRequiredProcedure
  .route({ method: "PUT", path: "/channels" })
  .input(channelSchema)
  .handler(async ({ input, context }) => {
    await assertCanManageChannel(
      context,
      input.id,
      context.session.user.slackId,
      auditActions.channelUpdate,
    );
    const before = await dbGetChannel(context.db, input.id);
    await dbUpsertChannel(context.db, input);
    invalidateGraphCache();
    await auditAction(
      context,
      auditActions.channelUpdate,
      {
        target: { id: input.id },
        changes: diff(before, input),
      },
      { targetName: input.name || before?.name },
    );
  });

export const updateChannel = authRequiredProcedure
  .route({ method: "PATCH", path: "/channels/{id}" })
  .input(channelPatchSchema.extend({ id: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const { id, ...patch } = input;
    // Turning a channel off is its own, louder action.
    const def =
      patch.enabled === false
        ? auditActions.channelUnpublish
        : patch.enabled === true
          ? auditActions.channelPublish
          : auditActions.channelUpdate;
    await assertCanManageChannel(
      context,
      id,
      context.session.user.slackId,
      def,
    );
    const ch = await dbGetChannel(context.db, id);
    if (!ch) throw new ORPCError("NOT_FOUND", { message: "Channel not found" });
    const next = applyChannelPatch(ch, patch);
    await dbUpsertChannel(context.db, next);
    invalidateGraphCache();
    await auditAction(
      context,
      def,
      { target: { id }, changes: diff(ch, next) },
      { targetName: ch.name },
    );
    return next;
  });

/**
 * Pub a channel from the web, creating its record from Slack if indigest has
 * never seen it. Mirrors `/in pub`: approval lists reset to defaults.
 */
export const publishChannel = authRequiredProcedure
  .route({ method: "POST", path: "/channels/{id}/publish" })
  .input(
    z.object({
      id: z.string().regex(/^[CG][A-Z0-9]+$/, "Not a Slack channel ID"),
    }),
  )
  .handler(async ({ input, context }) => {
    await assertCanManageChannel(
      context,
      input.id,
      context.session.user.slackId,
      auditActions.channelPublish,
    );
    let ch = await dbGetChannel(context.db, input.id);
    if (!ch) {
      if (!context.slackToken)
        throw new ORPCError("PRECONDITION_FAILED", {
          message: "Slack is not configured",
        });
      const slack = new WebClient(context.slackToken);
      let name = "";
      let teamId = "";
      try {
        const conv = await slack.conversations.info({ channel: input.id });
        name = (conv.channel as any)?.name || "";
        teamId = (conv.channel as any)?.context_team_id || "";
      } catch {
        throw new ORPCError("NOT_FOUND", {
          message:
            "indigest can't see that channel. Invite the bot to it first.",
        });
      }
      ch = {
        id: input.id,
        name,
        teamId,
        enabled: false,
        linkMode: false,
        webhookUrl: "",
        autoApproveUsers: [],
        manualUsers: [],
        triggerMode: "message",
        approvedPosters: [],
        accessPermUsers: ["*"],
        trackReplies: false,
        metadataSchema: "",
        metadataRequired: false,
        properties: "",
        staticMetadata: "",
        createdAt: "",
      };
    }
    const before = ch;
    ch = { ...ch, enabled: true, autoApproveUsers: [], manualUsers: [] };
    await dbUpsertChannel(context.db, ch);
    invalidateGraphCache();
    await auditAction(
      context,
      auditActions.channelPublish,
      {
        target: { id: ch.id },
        changes: diff(before, ch),
      },
      { targetName: ch.name },
    );
    return ch;
  });

export const listByUser = authOrApiKeyProcedure
  .route({ method: "GET", path: "/channels/by-user/{userId}" })
  .input(z.object({ userId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const slackId = context.session?.user?.slackId;
    if (!slackId) return [];
    const channels = await dbListChannels(context.db);
    const isLockdown = context.lockdownUsers.includes(slackId);
    const visible = await Promise.all(
      channels.map(async (ch) => ({
        ch,
        allowed: canCreateApiKeyForChannel(ch, slackId, {
          isLockdown,
          isManager: await isChannelManager(ch.id, slackId, context.slackToken),
        }),
      })),
    );
    return visible.filter(({ allowed }) => allowed).map(({ ch }) => ch);
  });

export const channelRouter = {
  list: listChannels,
  listManageable,
  get: getChannel,
  permissions: channelPermissions,
  upsert: upsertChannel,
  update: updateChannel,
  publish: publishChannel,
  listByUser,
};

import { ORPCError } from "@orpc/server";
import { z } from "zod";
import {
  publicProcedure,
  authOrApiKeyProcedure,
  authRequiredProcedure,
} from "../context";
import {
  getChannel as dbGetChannel,
  listChannels as dbListChannels,
  listEnabledChannels as dbListEnabledChannels,
  upsertChannel as dbUpsertChannel,
} from "../../db/queries";

const channelSchema = z.object({
  id: z.string(),
  name: z.string(),
  teamId: z.string(),
  enabled: z.boolean(),
  linkMode: z.boolean(),
  webhookUrl: z.string(),
  autoApproveUsers: z.array(z.string()),
  approvedPosters: z.array(z.string()),
  accessPermUsers: z.array(z.string()),
  trackReplies: z.boolean(),
  metadataSchema: z.string(),
  createdAt: z.string(),
});

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

export const getChannel = publicProcedure
  .route({ method: "GET", path: "/channels/{id}" })
  .input(z.object({ id: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const ch = await dbGetChannel(context.db, input.id);
    if (!ch) throw new ORPCError("Channel not found");
    return ch;
  });

export const upsertChannel = authRequiredProcedure
  .route({ method: "PUT", path: "/channels" })
  .input(channelSchema)
  .handler(async ({ input, context }) => {
    await dbUpsertChannel(context.db, input);
  });

export const listByUser = authOrApiKeyProcedure
  .route({ method: "GET", path: "/channels/by-user/{userId}" })
  .input(z.object({ userId: z.string().min(1) }))
  .handler(async ({ input, context }) => {
    const slackId = context.session?.user?.slackId;
    if (!slackId) return [];
    const channels = await dbListChannels(context.db);
    return channels.filter(
      (ch) =>
        ch.accessPermUsers.includes(slackId) ||
        ch.accessPermUsers.includes("*") ||
        ch.accessPermUsers.includes(slackId),
    );
  });

export const channelRouter = {
  list: listChannels,
  get: getChannel,
  upsert: upsertChannel,
  listByUser,
};

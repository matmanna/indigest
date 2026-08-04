import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { authOrApiKeyProcedure } from "../context";

export const listMessages = authOrApiKeyProcedure
  .route({ method: "GET", path: "/messages" })
  .input(
    z.object({
      channel: z.string().min(1),
      after: z.string().optional(),
      before: z.string().optional(),
      userId: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(10000).default(50),
      page: z.coerce.number().int().min(1).default(1),
    }),
  )
  .handler(async ({ input, context }) => {
    const { channel, after, before, userId, limit, page } = input;

    const ch = await context.store.getChannel(channel);
    if (!ch || !ch.enabled) throw new ORPCError("Channel not found or not enabled");

    const all = await context.store.getMessages(channel, 100000, 0);

    let filtered = all;
    if (after) filtered = filtered.filter((m: any) => m.timestamp >= after);
    if (before) filtered = filtered.filter((m: any) => m.timestamp <= before);
    if (userId) filtered = filtered.filter((m: any) => m.userId === userId);

    const total = filtered.length;
    const offset = (page - 1) * limit;
    const items = filtered.slice(offset, offset + limit);

    return {
      data: items,
      pagination: { page, limit, total, total_pages: Math.ceil(total / limit) },
    };
  });

export const getMessage = authOrApiKeyProcedure
  .route({ method: "GET", path: "/messages/{slackTs}" })
  .input(
    z.object({
      slackTs: z.string(),
      channel: z.string().min(1),
    }),
  )
  .handler(async ({ input, context }) => {
    const all = await context.store.getMessages(input.channel, 100000, 0);
    const msg = all.find((m: any) => m.slackTs === input.slackTs);
    if (!msg) throw new ORPCError("Message not found");
    return msg;
  });

export const messageRouter = {
  list: listMessages,
  get: getMessage,
};

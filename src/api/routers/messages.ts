import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { authOrApiKeyProcedure } from "../context";
import {
  getChannel as dbGetChannel,
  getMessages as dbGetMessages,
  getMessageCount as dbGetMessageCount,
  getMessageBySlackTs as dbGetMessageBySlackTs,
} from "../../db/queries";

export const listMessages = authOrApiKeyProcedure
  .route({ method: "GET", path: "/messages" })
  .input(
    z.object({
      channel: z.string().min(1),
      after: z.string().optional(),
      before: z.string().optional(),
      userId: z.string().optional(),
      threadTs: z.string().optional(),
      limit: z.coerce.number().int().min(1).max(10000).default(50),
      page: z.coerce.number().int().min(1).default(1),
    }),
  )
  .handler(async ({ input, context }) => {
    const { channel, after, before, userId, threadTs, limit, page } = input;

    const ch = await dbGetChannel(context.db, channel);
    if (!ch || !ch.enabled)
      throw new ORPCError("Channel not found or not enabled");

    const total = await dbGetMessageCount(context.db, channel, {
      after,
      before,
      userId,
      threadTs,
    });

    const offset = (page - 1) * limit;
    const items = await dbGetMessages(context.db, channel, {
      limit,
      offset,
      after,
      before,
      userId,
      threadTs,
    });

    return {
      data: items,
      pagination: {
        page,
        limit,
        total,
        total_pages: Math.ceil(total / limit),
      },
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
    const msg = await dbGetMessageBySlackTs(
      context.db,
      input.channel,
      input.slackTs,
    );
    if (!msg) throw new ORPCError("Message not found");
    return msg;
  });

export const messageRouter = {
  list: listMessages,
  get: getMessage,
};

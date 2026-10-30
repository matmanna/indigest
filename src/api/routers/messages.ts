import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { authOrApiKeyProcedure } from "../context";
import {
  getChannel as dbGetChannel,
  getMessages as dbGetMessages,
  getMessageCount as dbGetMessageCount,
  getMessageBySlackTs as dbGetMessageBySlackTs,
  findTopLevelMessagesContaining,
  listReplyRecords,
} from "../../db/queries";
import {
  articleKeyFromCardText,
  commentUsage,
  normalizeArticleKey,
  validCommentTimestamps,
  type CommentLimits,
} from "../../lib/threads";
import type { Channel } from "../../db/queries";
import { canAccessFeed, resolveContextFeedIdentity } from "../../lib/access";
import type { ORPCContext } from "../context";

async function assertChannelAccess(context: ORPCContext, ch: Channel) {
  const identity = await resolveContextFeedIdentity(
    context.db,
    context.session,
    context.apiKey,
  );
  if (!canAccessFeed(ch, identity)) {
    throw new ORPCError("FORBIDDEN", {
      message: "You don't have access to this channel",
    });
  }
}

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
    await assertChannelAccess(context, ch);

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
    const ch = await dbGetChannel(context.db, input.channel);
    if (!ch || !ch.enabled)
      throw new ORPCError("Channel not found or not enabled");
    await assertChannelAccess(context, ch);

    const msg = await dbGetMessageBySlackTs(
      context.db,
      input.channel,
      input.slackTs,
    );
    if (!msg) throw new ORPCError("NOT_FOUND", { message: "Message not found" });
    return msg;
  });

export const getThread = authOrApiKeyProcedure
  .route({ method: "GET", path: "/threads" })
  .input(
    z.object({
      channel: z.string().min(1),
      // An article's path, such as /news/some-slug/, or a URL to it.
      key: z.string().min(1),
      // Comment limits. Without both limits no reply is held back.
      perDay: z.coerce.number().int().min(1).optional(),
      total: z.coerce.number().int().min(1).optional(),
      timeZone: z.string().default("America/New_York"),
      // A Slack user whose allowance to report.
      viewer: z.string().optional(),
    }),
  )
  .handler(async ({ input, context }) => {
    const ch = await dbGetChannel(context.db, input.channel);
    if (!ch || !ch.enabled)
      throw new ORPCError("NOT_FOUND", {
        message: "Channel not found or not enabled",
      });
    await assertChannelAccess(context, ch);

    const key = normalizeArticleKey(input.key);
    if (!key)
      throw new ORPCError("BAD_REQUEST", {
        message: "key must be an article path like /news/some-slug/",
      });

    const candidates = await findTopLevelMessagesContaining(
      context.db,
      input.channel,
      key.slice(0, -1),
    );
    const cards = candidates.filter(
      (m) => articleKeyFromCardText(m.text, m.formattedText) === key,
    );
    if (cards.length === 0) return { data: { card: null, replies: [] } };

    const replyLists = await Promise.all(
      cards.map((card) =>
        dbGetMessages(context.db, input.channel, {
          threadTs: card.slackTs,
          limit: 200,
        }),
      ),
    );

    let replies = replyLists.flat();
    let viewer: ReturnType<typeof commentUsage> | undefined;
    if (input.perDay && input.total) {
      const limits: CommentLimits = {
        perDay: input.perDay,
        total: input.total,
        timeZone: input.timeZone,
      };
      const records = await listReplyRecords(context.db, input.channel);
      const valid = validCommentTimestamps(records, limits);
      replies = replies.filter((m) => valid.has(m.slackTs));
      if (input.viewer) viewer = commentUsage(records, input.viewer, limits);
    }

    replies.sort((a, b) => Number(a.slackTs) - Number(b.slackTs));
    return {
      data: {
        // The earliest card is where replies are made.
        card: { slackTs: cards[0]!.slackTs, channelId: input.channel },
        replies: replies.map((m) => ({
          slackTs: m.slackTs,
          userId: m.userId,
          userName: m.userName,
          text: m.text,
          formattedText: m.formattedText ?? null,
          timestamp: m.timestamp,
        })),
        ...(viewer ? { viewer } : {}),
      },
    };
  });

export const messageRouter = {
  list: listMessages,
  get: getMessage,
  thread: getThread,
};
